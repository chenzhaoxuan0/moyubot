/**
 * Telegram 渠道网关 —— 升级为交互式富网关（Interactive Gateway）。
 *
 * 核心升级点：
 * 1. 长轮询（Long Polling）：getUpdates 带 timeout=25，大幅降低延迟与请求频率；
 * 2. 状态反馈：打字状态提示（sendChatAction: "typing"）；
 * 3. 常用指令：/new（重置新会话）、/status（查看状态）、/help（帮助）；
 * 4. 远程确认门（Remote Approval）：敏感工具执行时下发 Inline Keyboard 按钮，
 *    用户点击按钮通过 callback_query 实时回传裁决，杜绝盲目 yolo 执行。
 */

import type { BotRegistry, BotDefinition } from "../bots/registry.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import type { CredentialVault } from "../credentials/vault.ts";
import { resolveSecret } from "../credentials/vault.ts";
import { runBotTurn } from "./askBot.ts";
import type { RuntimeEvent } from "../../../prototype/src/core/events.ts";
import { log } from "../log.ts";

interface TgUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string };
    message?: { message_id?: number; chat?: { id?: number } };
    data?: string;
  };
}

interface TgAccountSpec {
  readonly key: string;
  readonly botId: string;
  readonly botToken: string;
  readonly chatId: string;
  readonly interactiveApproval: boolean;
}

const REPLY_CAP = 3_900; // Telegram 文本消息上限 4096，留余量

export class TelegramGateway {
  private timer: NodeJS.Timeout | null = null;
  private readonly offsets = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly opts: {
      apiBase: string;
      registry: BotRegistry;
      host: RuntimeHost;
      vault?: CredentialVault;
      pollMs?: number;
      /** 入站拦截器（docs/33 §3.4）：daemon 级指令（确认/拒绝待办）直接消化（true），未消费进 bot 轮次 */
      inboundHook?: (text: string) => Promise<boolean>;
    },
  ) {}

  start(): void {
    if (this.timer !== null) return;
    const pollMs = this.opts.pollMs ?? 2000;
    this.timer = setInterval(() => void this.tick(), pollMs);
    this.timer.unref();
    log.info("telegram gateway started", { apiBase: this.opts.apiBase, pollMs });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  get activeAccountCount(): number {
    return this.inFlight.size;
  }

  private async resolveAccounts(bot: BotDefinition): Promise<TgAccountSpec[]> {
    const botId = typeof bot.id === "string" ? bot.id : "";
    if (botId === "" || !Array.isArray(bot.channels)) return [];

    const out: TgAccountSpec[] = [];
    for (const ch of bot.channels as Array<Record<string, unknown> | undefined>) {
      if (ch?.["kind"] !== "telegram" || ch["enabled"] !== true) continue;
      const raw: Array<Record<string, unknown>> =
        Array.isArray(ch["accounts"]) && ch["accounts"].length > 0
          ? (ch["accounts"] as Array<Record<string, unknown>>)
          : [
              {
                id: "default",
                botToken: (ch["config"] as Record<string, unknown> | undefined)?.["botToken"],
                botTokenEnv: (ch["config"] as Record<string, unknown> | undefined)?.["botTokenEnv"],
                chatId: (ch["config"] as Record<string, unknown> | undefined)?.["chatId"],
              },
            ];
      for (const acc of raw) {
        let token = "";
        if (this.opts.vault) {
          token = await resolveSecret(
            (acc["secretRef"] as never) ?? acc["botToken"] ?? (acc["botTokenEnv"] ? { source: "env", id: String(acc["botTokenEnv"]) } : undefined),
            this.opts.vault,
            bot.rootPath,
          );
        } else {
          const envName = acc["botTokenEnv"];
          token = typeof acc["botToken"] === "string" && acc["botToken"] !== ""
            ? acc["botToken"]
            : typeof envName === "string" && envName !== ""
              ? process.env[envName] ?? ""
              : "";
        }
        const chatId = typeof acc["chatId"] === "string" ? acc["chatId"] : "";
        const id = typeof acc["id"] === "string" && acc["id"] !== "" ? acc["id"] : "default";
        if (token === "" || chatId === "") {
          log.warn("telegram account skipped: incomplete credentials", { bot: botId, account: id });
          continue;
        }
        out.push({
          key: `${botId}::${id}`,
          botId,
          botToken: token,
          chatId,
          interactiveApproval: acc["interactiveApproval"] !== false,
        });
      }
    }
    return out;
  }

  private async tick(): Promise<void> {
    let bots: BotDefinition[];
    try {
      bots = await this.opts.registry.listBots();
    } catch {
      return;
    }
    for (const bot of bots) {
      try {
        const accounts = await this.resolveAccounts(bot);
        for (const acc of accounts) {
          if (this.inFlight.has(acc.botToken)) continue;
          this.inFlight.add(acc.botToken);
          void this.pollBot(bot, acc).finally(() => this.inFlight.delete(acc.botToken));
        }
      } catch (err: unknown) {
        log.warn("telegram channel skipped", { bot: bot.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async pollBot(bot: BotDefinition, acc: TgAccountSpec): Promise<void> {
    const { botToken: token, chatId } = acc;
    if (token === "" || chatId === "") return;
    const offset = this.offsets.get(token) ?? 0;
    let updates: TgUpdate[];
    try {
      const r = await fetch(`${this.opts.apiBase}/bot${token}/getUpdates?timeout=25&offset=${offset}`, {
        signal: AbortSignal.timeout(35_000),
      });
      const j = (await r.json()) as { ok?: boolean; result?: TgUpdate[] };
      if (j.ok !== true || !Array.isArray(j.result)) return;
      updates = j.result;
    } catch (err: unknown) {
      log.debug("telegram getUpdates failed", { bot: bot.id, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    for (const u of updates) {
      if (typeof u.update_id === "number") this.offsets.set(token, u.update_id + 1);

      // 处理按钮回调 (Inline Keyboard 回调)
      if (u.callback_query) {
        void this.handleCallbackQuery(acc, u.callback_query);
        continue;
      }

      const msg = u.message;
      if (msg?.text === undefined || msg.chat?.id === undefined) continue;
      if (String(msg.chat.id) !== chatId) continue;
      this.enqueue(bot, acc, msg.text);
    }
  }

  /** 处理内联按钮点击 */
  private async handleCallbackQuery(
    acc: TgAccountSpec,
    query: NonNullable<TgUpdate["callback_query"]>,
  ): Promise<void> {
    const data = query.data ?? "";
    const callbackId = query.id;
    // 权限裁决回调格式：perm:<sessionId>:<requestId>:<decision>
    if (data.startsWith("perm:")) {
      const parts = data.split(":");
      const sessionId = parts[1];
      const requestId = parts[2];
      const decision = parts[3] as "allow" | "deny" | "always";
      if (sessionId && requestId && (decision === "allow" || decision === "deny" || decision === "always")) {
        try {
          await this.opts.host.resolvePermission(sessionId as never, requestId, decision);
          await this.answerCallbackQuery(acc.botToken, callbackId, `已裁决: ${decision}`);
          // 更新消息去掉按钮，展示裁决结果
          if (query.message?.chat?.id && query.message?.message_id) {
            await this.editMessageText(
              acc.botToken,
              query.message.chat.id,
              query.message.message_id,
              `✅ 审批已完成：[${decision === "allow" ? "允许本次" : decision === "deny" ? "拒绝本次" : "永久允许"}]`,
            );
          }
        } catch (err: unknown) {
          await this.answerCallbackQuery(acc.botToken, callbackId, `处理失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  private enqueue(bot: BotDefinition, acc: TgAccountSpec, text: string): void {
    const key = bot.id ?? "";
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.handleText(bot, acc, text));
    this.chains.set(key, next);
  }

  private async handleText(bot: BotDefinition, acc: TgAccountSpec, text: string): Promise<void> {
    const { botToken: token, chatId } = acc;
    const trimmed = text.trim();

    // 指令快速处理
    if (trimmed === "/help") {
      await this.sendTelegram(this.opts.apiBase, token, chatId, "🤖 可用指令：\n/new - 开始全新会话\n/status - 查看当前 Bot 状态\n/help - 显示此帮助");
      return;
    }
    if (trimmed === "/status") {
      await this.sendTelegram(this.opts.apiBase, token, chatId, `🤖 Bot 状态: ${bot.name || bot.id}\n📁 根目录: ${bot.rootPath}\n⚡ 审批模式: ${acc.interactiveApproval ? "交互式按钮审批" : "yolo 自动放行"}`);
      return;
    }

    // 入站拦截器（docs/33 §3.4 IM 确认门）：「确认/拒绝 N」这类 daemon 级指令
    // 直接消化，不进 bot 轮次 —— 挂钩故障按未消费放行（与飞书同款铁律）
    if (this.opts.inboundHook !== undefined) {
      try {
        if (await this.opts.inboundHook(trimmed)) return;
      } catch {
        /* 拦截器故障不拦消息 */
      }
    }

    // 发送打字状态
    void this.sendChatAction(token, chatId, "typing");

    // 回收本轮挂的 permission 监听：runBotTurn 每轮都续同一个会话，退订函数
    // 丢掉不调的话监听会一轮叠一个 —— N 轮后一次审批请求发出 N 份按钮
    const unsubs: Array<() => void> = [];
    try {
      const { reply } = await runBotTurn(this.opts.host, bot, text, {
        source: "telegram",
        mode: acc.interactiveApproval ? "build" : "yolo",
        // 交互审批位：不开它，host 对非 workbench 来源一律自动放行，
        // 下面的审批按钮就只是装饰品（复审 P0）
        interactive: acc.interactiveApproval,
        onTurnStart: (sessionId) => {
          if (acc.interactiveApproval) {
            unsubs.push(
              this.opts.host.onSessionEvent(sessionId, "permission.requested", (ev) => {
                const event = ev as Extract<RuntimeEvent, { type: "permission.requested" }>;
                const inlineKeyboard = {
                  inline_keyboard: [
                    [
                      { text: "✅ 允许 (Allow)", callback_data: `perm:${sessionId}:${event.requestId}:allow` },
                      { text: "❌ 拒绝 (Deny)", callback_data: `perm:${sessionId}:${event.requestId}:deny` },
                    ],
                    [
                      { text: "🛡️ 永久允许 (Always)", callback_data: `perm:${sessionId}:${event.requestId}:always` },
                    ],
                  ],
                };
                void this.sendTelegramWithKeyboard(
                  this.opts.apiBase,
                  token,
                  chatId,
                  `⚠️ 【操作审批】\n任务需要执行以下敏感操作：\n类别: ${event.kind}\n详情: ${event.detail}`,
                  inlineKeyboard,
                );
              }),
            );
          }
        },
      });

      await this.sendTelegram(this.opts.apiBase, token, chatId, reply);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("telegram turn failed", { bot: bot.id, error: message });
      await this.sendTelegram(this.opts.apiBase, token, chatId, `出错了：${message}`).catch(() => {});
    } finally {
      for (const unsub of unsubs) unsub();
    }
  }

  private async sendChatAction(token: string, chatId: string, action: string): Promise<void> {
    try {
      await fetch(`${this.opts.apiBase}/bot${token}/sendChatAction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // 忽略打字状态失败
    }
  }

  private async answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void> {
    try {
      await fetch(`${this.opts.apiBase}/bot${token}/answerCallbackQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // 忽略回调确认异常
    }
  }

  private async editMessageText(token: string, chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await fetch(`${this.opts.apiBase}/bot${token}/editMessageText`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // 忽略编辑失败
    }
  }

  private async sendTelegramWithKeyboard(
    apiBase: string,
    token: string,
    chatId: string,
    text: string,
    replyMarkup: unknown,
  ): Promise<void> {
    try {
      await fetch(`${apiBase}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      log.warn("telegram sendTelegramWithKeyboard failed", { error: String(err) });
    }
  }

  private async sendTelegram(apiBase: string, token: string, chatId: string, text: string): Promise<void> {
    if (token === "" || chatId === "") return;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += REPLY_CAP) chunks.push(text.slice(i, i + REPLY_CAP));
    if (chunks.length === 0) chunks.push("(空回复)");
    for (const chunk of chunks) {
      const r = await fetch(`${apiBase}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) log.warn("telegram sendMessage failed", { status: r.status });
    }
  }
}
