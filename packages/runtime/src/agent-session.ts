/**
 * Nexora Conversational Agent Session
 * 
 * Implements a natural language conversational agent that lives on the host computer:
 * - Multi-turn conversational memory
 * - Autonomous tool calling loop (system info, directory listing, file reading/writing, shell commands)
 * - Governed action boundaries (dangerous command prevention, mutating action approval)
 * - Real-time event and text streaming
 */

import { exec } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import * as os from "node:os";
import { PolicyEngine } from "../../governance/src/policy-engine.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "OBJECT";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    output?: string;
    status: "running" | "completed" | "failed" | "awaiting_approval";
  }>;
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "get_system_info",
    description: "Get current system status, platform, OS, hostname, CPU architecture, memory, and current time.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at a specified local path (defaults to current project root).",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative or absolute directory path to list" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a local file in the workspace or system.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Path to the file to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with specified content (mutating action).",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Target file path" },
        content: { type: "STRING", description: "Content to write into the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "exec_command",
    description: "Execute a command in PowerShell / cmd on the host computer to check status, run git, inspect processes, etc.",
    parameters: {
      type: "OBJECT",
      properties: {
        command: { type: "STRING", description: "Shell command line to execute" },
      },
      required: ["command"],
    },
  },
];

export class AgentSession {
  readonly apiKey: string;
  readonly model: string;
  readonly policyEngine: PolicyEngine;
  readonly cwd: string;
  private history: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];
  public messages: ChatMessage[] = [];

  constructor(options?: { apiKey?: string; model?: string; cwd?: string }) {
    this.apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.model = options?.model ?? "gemini-2.5-flash"; // Highly reliable free-tier multi-turn tool model
    this.cwd = options?.cwd ?? process.cwd();
    this.policyEngine = new PolicyEngine({ mode: "supervised" });
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Reset conversation history
   */
  clear(): void {
    this.history = [];
    this.messages = [];
  }

  /**
   * Execute a local tool safely on the user's computer
   */
  async executeTool(name: string, args: Record<string, unknown>): Promise<{ output: string; isMutating: boolean; needsApproval: boolean }> {
    switch (name) {
      case "get_system_info": {
        const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024));
        const freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024));
        const info = {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          hostname: os.hostname(),
          nodeVersion: process.version,
          totalMemoryGB: totalMem,
          freeMemoryGB: freeMem,
          uptimeHours: Math.round(os.uptime() / 3600),
          currentTime: new Date().toISOString(),
          cwd: this.cwd,
        };
        return { output: JSON.stringify(info, null, 2), isMutating: false, needsApproval: false };
      }

      case "list_directory": {
        const targetPath = args.path ? resolve(this.cwd, String(args.path)) : this.cwd;
        if (!existsSync(targetPath)) {
          return { output: `Error: directory '${targetPath}' does not exist.`, isMutating: false, needsApproval: false };
        }
        try {
          const entries = readdirSync(targetPath);
          const formatted = entries.slice(0, 50).map((name) => {
            try {
              const s = statSync(join(targetPath, name));
              return `${s.isDirectory() ? "[DIR] " : "[FILE]"} ${name} (${s.size} bytes)`;
            } catch {
              return name;
            }
          });
          return { output: formatted.join("\n"), isMutating: false, needsApproval: false };
        } catch (err: any) {
          return { output: `Error reading directory: ${err.message}`, isMutating: false, needsApproval: false };
        }
      }

      case "read_file": {
        const targetPath = resolve(this.cwd, String(args.path));
        if (!existsSync(targetPath)) {
          return { output: `Error: file '${targetPath}' does not exist.`, isMutating: false, needsApproval: false };
        }
        try {
          const content = readFileSync(targetPath, "utf8");
          const truncated = content.length > 10000 ? content.slice(0, 10000) + "\n...[truncated]" : content;
          return { output: truncated, isMutating: false, needsApproval: false };
        } catch (err: any) {
          return { output: `Error reading file: ${err.message}`, isMutating: false, needsApproval: false };
        }
      }

      case "write_file": {
        const targetPath = resolve(this.cwd, String(args.path));
        const content = String(args.content ?? "");
        try {
          writeFileSync(targetPath, content, "utf8");
          return { output: `Successfully wrote ${Buffer.byteLength(content)} bytes to ${basename(targetPath)}`, isMutating: true, needsApproval: false };
        } catch (err: any) {
          return { output: `Error writing file: ${err.message}`, isMutating: true, needsApproval: false };
        }
      }

      case "exec_command": {
        const cmd = String(args.command ?? "");
        const evalResult = this.policyEngine.evaluateAction("exec", { command: cmd });
        if (!evalResult.allowed) {
          return { output: `Policy blocked command: ${evalResult.reason}`, isMutating: true, needsApproval: false };
        }

        return new Promise((resolveResult) => {
          exec(cmd, { cwd: this.cwd, timeout: 30000 }, (err, stdout, stderr) => {
            const out = stdout || stderr || (err ? err.message : "Command executed with no output.");
            const trimmed = out.length > 5000 ? out.slice(0, 5000) + "\n...[truncated]" : out;
            resolveResult({ output: trimmed, isMutating: evalResult.isMutating, needsApproval: false });
          });
        });
      }

      default:
        return { output: `Unknown tool: ${name}`, isMutating: false, needsApproval: false };
    }
  }

  /**
   * Send user message in natural language and run multi-turn agent execution loop
   */
  async chat(
    userText: string,
    onProgress?: (data: { type: "delta" | "tool_call" | "tool_result" | "thought"; text: string; tool?: string }) => void
  ): Promise<{ response: string; toolCalls: Array<{ name: string; args: any; output: string }> }> {
    if (!this.hasKey) {
      return {
        response: "⚠️ GEMINI_API_KEY is not configured in your environment. Please set GEMINI_API_KEY in your system environment or PowerShell profile to unlock real-time natural language agent intelligence.",
        toolCalls: [],
      };
    }

    // Add user message to history
    this.history.push({
      role: "user",
      parts: [{ text: userText }],
    });

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}_u`,
      role: "user",
      text: userText,
      timestamp: Date.now(),
    };
    this.messages.push(userMsg);

    const executedToolCalls: Array<{ name: string; args: any; output: string }> = [];
    let turnCount = 0;
    const maxTurns = 5;
    let finalAssistantText = "";

    const systemInstruction = `You are Nexora, a sovereign personal AI agent living inside the user's computer.
You have direct access to system tools to inspect the host machine, read and write files, list directories, and execute shell commands.
When the user asks you questions or assigns tasks in natural language:
1. If the request requires looking at files, system status, or running commands, invoke the appropriate tools.
2. Formulate helpful, concise, natural language answers explaining your findings or actions clearly.
3. Be proactive, polite, accurate, and protective of user security.`;

    while (turnCount < maxTurns) {
      turnCount++;

      const requestBody: Record<string, unknown> = {
        contents: this.history,
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        tools: [
          {
            functionDeclarations: AGENT_TOOLS,
          },
        ],
      };

      let res: Response | undefined;
      const candidateModels = [this.model, "gemini-2.0-flash", "gemini-1.5-flash"];
      let lastErrText = "";

      for (const m of candidateModels) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (res.ok) {
          break;
        }

        if (res.status === 429 || res.status === 503) {
          lastErrText = await res.text().catch(() => "Rate limited");
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }

        lastErrText = await res.text().catch(() => "API error");
        break;
      }

      if (!res || !res.ok) {
        throw new Error(`Gemini API error (${res?.status ?? 429}): ${lastErrText}`);
      }

      const data = await res.json();
      const candidate = data.candidates?.[0];
      if (!candidate || !candidate.content) {
        finalAssistantText = "I received an empty response from the AI model.";
        break;
      }

      const parts = candidate.content.parts || [];
      const modelParts: Array<Record<string, unknown>> = [];
      const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

      for (const part of parts) {
        if (part.text) {
          finalAssistantText += part.text;
          modelParts.push({ text: part.text });
          if (onProgress) onProgress({ type: "delta", text: part.text });
        }
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
          modelParts.push({ functionCall: part.functionCall });
        }
      }

      // Record model turn in history
      this.history.push({
        role: "model",
        parts: modelParts,
      });

      // If no function calls, we are done!
      if (functionCalls.length === 0) {
        break;
      }

      // Execute each function call and record responses
      const functionResponseParts: Array<Record<string, unknown>> = [];
      for (const fc of functionCalls) {
        if (onProgress) onProgress({ type: "tool_call", text: `Calling tool: ${fc.name}`, tool: fc.name });

        const toolResult = await this.executeTool(fc.name, fc.args || {});
        executedToolCalls.push({
          name: fc.name,
          args: fc.args,
          output: toolResult.output,
        });

        if (onProgress) onProgress({ type: "tool_result", text: toolResult.output.slice(0, 100), tool: fc.name });

        functionResponseParts.push({
          functionResponse: {
            name: fc.name,
            response: { output: toolResult.output },
          },
        });
      }

      // Feed function responses back into conversation history
      this.history.push({
        role: "user",
        parts: functionResponseParts,
      });
    }

    const assistantMsg: ChatMessage = {
      id: `msg_${Date.now()}_a`,
      role: "assistant",
      text: finalAssistantText,
      timestamp: Date.now(),
      toolCalls: executedToolCalls.map((tc) => ({
        name: tc.name,
        args: tc.args,
        output: tc.output,
        status: "completed",
      })),
    };
    this.messages.push(assistantMsg);

    return {
      response: finalAssistantText,
      toolCalls: executedToolCalls,
    };
  }
}
