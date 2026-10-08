/**
 * Nexora Telegram Bot Adapter
 * 
 * Reuses Perry's outbound polling model (repos/perry/server/telegram.ts).
 * Allows task submission via `/task <prompt>`, approval resolution via `/approve <id>`,
 * and status queries via `/status`.
 */

import type { TaskService } from "../../runtime/src/index.ts";
import type { TelegramUpdate } from "./types.ts";

export interface TelegramBotConfig {
  botToken?: string;
  chatId?: string | number;
  taskService: TaskService;
  transport?: typeof fetch;
}

export class TelegramBotAdapter {
  readonly botToken?: string;
  readonly defaultChatId?: string | number;
  readonly taskService: TaskService;
  private readonly transport: typeof fetch;
  readonly outboundLog: Array<{ method: string; body: any }> = [];

  constructor(config: TelegramBotConfig) {
    this.botToken = config.botToken;
    this.defaultChatId = config.chatId;
    this.taskService = config.taskService;
    this.transport = config.transport ?? fetch;
  }

  /**
   * Sends text message to Telegram chat.
   */
  async sendMessage(chatId: string | number, text: string): Promise<boolean> {
    this.outboundLog.push({ method: "sendMessage", body: { chat_id: chatId, text } });

    if (!this.botToken) {
      return true; // Mock mode when no token is configured
    }

    try {
      const res = await this.transport(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Posts status update and artifact link to Telegram chat.
   */
  async postTaskCompletion(
    chatId: string | number,
    taskId: string,
    artifact?: { name: string; sha256: string; filePath: string }
  ): Promise<boolean> {
    const task = this.taskService.db.getTask(taskId);
    if (!task) return false;

    let text = `✅ *Task Completed*\n*Title:* ${task.title}\n*Status:* ${task.status}`;
    if (artifact) {
      text += `\n\n📄 *Artifact:* ${artifact.name}\n*SHA-256:* \`${artifact.sha256.slice(0, 16)}...\`\n*Path:* \`${artifact.filePath}\``;
    }

    return this.sendMessage(chatId, text);
  }

  /**
   * Ingests and processes an incoming Telegram update.
   */
  async handleUpdate(update: TelegramUpdate): Promise<string | null> {
    const msg = update.message;
    if (!msg || !msg.text) return null;

    const text = msg.text.trim();
    const chatId = msg.chat.id;

    if (text.startsWith("/task ")) {
      const prompt = text.slice(6).trim();
      const submission = this.taskService.submitTask({
        title: prompt.slice(0, 40),
        description: prompt,
        ownerId: `telegram:${msg.from?.id ?? chatId}`,
        projectId: "telegram-channel",
        idempotencyKey: `tg_${msg.message_id}`,
      });

      const reply = `🚀 Task submitted: "${submission.task.title}" (ID: \`${submission.task.id}\`)`;
      await this.sendMessage(chatId, reply);
      return reply;
    }

    if (text.startsWith("/approve ")) {
      const approvalId = text.slice(9).trim();
      try {
        const res = this.taskService.resolveApproval(
          approvalId,
          true,
          `telegram:${msg.from?.id ?? chatId}`
        );
        const reply = `✅ Approval granted for ID \`${approvalId}\`. Run resumed.`;
        await this.sendMessage(chatId, reply);
        return reply;
      } catch (err: any) {
        const reply = `❌ Approval failed: ${err.message ?? err}`;
        await this.sendMessage(chatId, reply);
        return reply;
      }
    }

    if (text === "/status") {
      const queued = this.taskService.db.listQueuedTasks().length;
      const active = this.taskService.db.listActiveRuns().length;
      const reply = `📊 *Nexora Status*\n- Queued Tasks: ${queued}\n- Active Runs: ${active}`;
      await this.sendMessage(chatId, reply);
      return reply;
    }

    return null;
  }
}
