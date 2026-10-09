/**
 * Nexora Interactive Terminal Chat
 * 
 * Talk directly with Nexora as an agent living inside your computer.
 * Ask any question or give any task in natural language.
 * 
 * Usage:
 *   npm run chat
 *   node --experimental-strip-types scripts/chat.ts
 */

import * as readline from "node:readline";
import { AgentSession } from "../packages/runtime/src/agent-session.ts";

const session = new AgentSession();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("\n============================================================");
console.log("⚡ Nexora Personal Agent CLI (Living inside your computer)");
console.log("🤖 Model: Google Gemini 2.5 Flash / 3.8 Flash (Free-Tier)");
console.log("🛠️ Tools: Shell commands, file read/write, directory listing, system status");
console.log("💡 Ask any question or task in natural language. (Type 'exit' or 'quit' to leave)");
console.log("============================================================\n");

function promptUser() {
  rl.question("\x1b[36mYou >\x1b[0m ", async (input) => {
    const text = input.trim();
    if (!text) {
      promptUser();
      return;
    }

    if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
      console.log("\n👋 Goodbye! Nexora is standing by.\n");
      rl.close();
      process.exit(0);
    }

    if (text.toLowerCase() === "clear") {
      session.clear();
      console.log("\n🧹 Conversation history cleared.\n");
      promptUser();
      return;
    }

    process.stdout.write("\n\x1b[33mNexora is thinking...\x1b[0m\n");

    try {
      const result = await session.chat(text, (event) => {
        if (event.type === "tool_call") {
          console.log(`\x1b[90m  [Executing tool: ${event.tool}...]\x1b[0m`);
        } else if (event.type === "tool_result") {
          console.log(`\x1b[90m  [Tool completed (${event.text.length} chars)]\x1b[0m`);
        }
      });

      console.log(`\n\x1b[32mNexora >\x1b[0m ${result.response}\n`);
    } catch (err: any) {
      console.error(`\n\x1b[31mError: ${err.message}\x1b[0m\n`);
    }

    promptUser();
  });
}

promptUser();
