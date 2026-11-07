/**
 * 微信渠道网关（Tencent iLink Bot 协议接入）。
 *
 * 对齐 ZCode 微信 provider 实现：
 * 1. 桌面端扫码绑定：调腾讯官方 ilinkai.weixin.qq.com 接口获取配对码并长轮询；
 * 2. 凭证落盘：动态 bot_token 自动存入 CredentialVault，bot.json 仅落盘 SecretRef；
 * 3. 消息流转：通过 /ilink/bot/getupdates 长轮询接收消息，通过 /ilink/bot/sendmessage 发送消息；
 * 4. 远程审批：支持通过回复数字 1/2/3 进行确认门（Confirmation Gate）裁决。
 */

import { randomUUID } from "node:crypto";
import type { BotRegistry, BotDefinition } from "../bots/registry.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import type { CredentialVault } from "../credentials/vault.ts";
import { resolveSecret } from "../credentials/vault.ts";
import { runBotTurn } from "./askBot.ts";
import { asSessionId, type SessionId } from "../../../prototype/src/core/units.ts";
import type { RuntimeEvent } from "../../../prototype/src/core/events.ts";
import { log } from "../log.ts";

export const DEFAULT_WEIXIN_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_BOT_API_PREFIX = "/ilink/bot";
const WEIXIN_CHANNEL_VERSION = "2.0.0";
const WEIXIN_MESSAGE_TYPE_BOT = 2;
const WEIXIN_MESSAGE_STATE_FINISH = 2;
const WEIXIN_LOGIN_INTERVAL_SECONDS = 3;
const WEIXIN_LOGIN_EXPIRE_SECONDS = 120;
const WEIXIN_GET_UPDATES_TIMEOUT_MS = 60_000;

export interface WeixinLoginBeginResult {
  readonly qrCode: string;
  readonly qrUrl: string;
  readonly interval: number;
  readonly expiresAt: number;
}

export type WeixinLoginPollResult =
  | { readonly status: "pending" | "scanned"; readonly interval: number }
  | { readonly status: "success"; readonly botToken: string; readonly botId?: string }
  | { readonly status: "expired" | "error"; readonly message?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readNumber(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getApiBaseUrl(customBase?: string): string {
  const env = process.env.AGENT_WORKBENCH_WEIXIN_API;
  return (customBase || env || DEFAULT_WEIXIN_ILINK_BASE_URL).replace(/\/+$/u, "");
}

/** 开始微信扫码登录，获取二维码 */
export async function beginWeixinLogin(customBase?: string): Promise<WeixinLoginBeginResult> {
  const baseUrl = getApiBaseUrl(customBase);
  const resp = await fetch(`${baseUrl}${WEIXIN_BOT_API_PREFIX}/get_bot_qrcode?bot_type=3`, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`微信登录获取二维码失败: HTTP ${resp.status}`);
  }
  const payload = (await resp.json()) as Record<string, unknown>;
  const data = isRecord(payload.data) ? (payload.data as Record<string, unknown>) : payload;
  const qrCode = readString(data, "qrcode") || readString(data, "qr_code");
  const qrUrl = readString(data, "qrcode_img_content") || readString(data, "qrcode_url") || qrCode;
  if (!qrCode || !qrUrl) {
    throw new Error("微信登录接口未返回有效二维码");
  }
  const expireSec = readNumber(data, "expires_in") ?? WEIXIN_LOGIN_EXPIRE_SECONDS;
  return {
    qrCode,
    qrUrl,
    interval: WEIXIN_LOGIN_INTERVAL_SECONDS,
    expiresAt: Date.now() + expireSec * 1000,
  };
}

/** 轮询微信扫码状态 */
export async function pollWeixinLogin(qrCode: string, customBase?: string): Promise<WeixinLoginPollResult> {
  const baseUrl = getApiBaseUrl(customBase);
  let payload: Record<string, unknown>;
  try {
    const resp = await fetch(
      `${baseUrl}${WEIXIN_BOT_API_PREFIX}/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`,
      {
        method: "GET",
        headers: { "iLink-App-ClientVersion": "1" },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!resp.ok) throw new Error(`微信扫码状态查询失败: HTTP ${resp.status}`);
    payload = (await resp.json()) as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { status: "pending", interval: WEIXIN_LOGIN_INTERVAL_SECONDS };
    }
    throw err;
  }
  const data = isRecord(payload.data) ? (payload.data as Record<string, unknown>) : payload;
  const rawStatus = data["status"] ?? data["qrcode_status"] ?? data["qr_status"];

  let normalized: "pending" | "scanned" | "success" | "expired" | "error" = "pending";
  if (typeof rawStatus === "number") {
    if (rawStatus === 0) normalized = "pending";
    else if (rawStatus === 1) normalized = "scanned";
    else if (rawStatus === 2) normalized = "success";
    else if (rawStatus === 3 || rawStatus === 4) normalized = "expired";
  } else if (typeof rawStatus === "string") {
    const s = rawStatus.toLowerCase();
    if (["confirmed", "success", "ok", "authorized"].includes(s)) normalized = "success";
    else if (["scanned", "scan", "confirmed_wait"].includes(s)) normalized = "scanned";
    else if (["expired", "timeout", "cancelled"].includes(s)) normalized = "expired";
    else if (["error", "failed"].includes(s)) normalized = "error";
  }

  if (normalized === "success") {
    const botToken = readString(data, "bot_token") || readString(data, "token");
    if (!botToken) {
      return { status: "error", message: "微信扫码成功但未返回 bot_token" };
    }
    return {
      status: "success",
      botToken,
      botId: readString(data, "ilink_bot_id") || readString(data, "bot_id") || undefined,
    };
  }
  if (normalized === "expired") return { status: "expired" };
  if (normalized === "error") return { status: "error", message: readString(data, "errmsg") || "扫码失败" };
  return { status: normalized, interval: WEIXIN_LOGIN_INTERVAL_SECONDS };
}

interface WeixinAccountSpec {
  readonly key: string;
  readonly botId: string;
  readonly botToken: string;
  readonly ilinkBotId?: string;
  /**
   * 专属对话过滤（复审 P0）：只应答这个 OpenID 的私聊。微信侧任何联系人
   * 都能给 bot 发消息——没有这层过滤，等于把桌面 agent 的驾驶权交给整个通讯录。
   */
  readonly chatId?: string;
  readonly interactiveApproval: boolean;
}

export class WeixinGateway {
  private timer: NodeJS.Timeout | null = null;
  private readonly bufs = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  private readonly chains = new Map<string, Promise<void>>();
  /** 待确认审批：userId → { sessionId, requestId, detail, kind } */
  private readonly pendingApprovals = new Map<
    string,
    { sessionId: SessionId; requestId: string; detail: string; kind: string }
  >();

  constructor(
    private readonly opts: {
      apiBase?: string;
      registry: BotRegistry;
      host: RuntimeHost;
      vault: CredentialVault;
      pollMs?: number;
      /** 入站拦截器（docs/33 §3.4）：daemon 级指令（确认/拒绝待办）直接消化（true），未消费进 bot 轮次 */
      inboundHook?: (text: string) => Promise<boolean>;
    },
  ) {}

  start(): void {
    if (this.timer !== null) return;
    const pollMs = this.opts.pollMs ?? 3000;
    this.timer = setInterval(() => void this.tick(), pollMs);
    this.timer.unref();
    log.info("weixin gateway started", { pollMs });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  get activeAccountCount(): number {
    return this.inFlight.size;
  }

  private async resolveAccounts(): Promise<WeixinAccountSpec[]> {
    let bots: BotDefinition[];
    try {
      bots = await this.opts.registry.listBots();
    } catch {
      return [];
    }
    const specs: WeixinAccountSpec[] = [];
    for (const bot of bots) {
      const botId = typeof bot.id === "string" ? bot.id : "";
      if (!botId || !Array.isArray(bot.channels)) continue;
      for (const ch of bot.channels as Array<Record<string, unknown>>) {
        if (ch?.["kind"] !== "weixin" || ch["enabled"] !== true) continue;
        const accounts = Array.isArray(ch["accounts"]) && ch["accounts"].length > 0 ? ch["accounts"] : [ch["config"] ?? {}];
        for (const rawAcc of accounts as Array<Record<string, unknown>>) {
          const id = typeof rawAcc["id"] === "string" && rawAcc["id"] !== "" ? rawAcc["id"] : "main";
          const token = await resolveSecret(
            rawAcc["secretRef"] as never ?? rawAcc["botToken"] ?? (rawAcc["botTokenEnv"] ? { source: "env", id: rawAcc["botTokenEnv"] } : undefined),
            this.opts.vault,
            bot.rootPath,
          );
          if (!token) continue;
          specs.push({
            key: `${botId}::${id}`,
            botId,
            botToken: token,
            ilinkBotId: typeof rawAcc["ilinkBotId"] === "string" ? rawAcc["ilinkBotId"] : undefined,
            chatId: typeof rawAcc["chatId"] === "string" && rawAcc["chatId"] !== "" ? rawAcc["chatId"] : undefined,
            interactiveApproval: rawAcc["interactiveApproval"] !== false,
          });
        }
      }
    }
    return specs;
  }

  private async tick(): Promise<void> {
    const specs = await this.resolveAccounts();
    for (const acc of specs) {
      if (this.inFlight.has(acc.key)) continue;
      this.inFlight.add(acc.key);
      void this.pollAccount(acc).finally(() => this.inFlight.delete(acc.key));
    }
  }

  private async pollAccount(acc: WeixinAccountSpec): Promise<void> {
    const baseUrl = getApiBaseUrl(this.opts.apiBase);
    const buf = this.bufs.get(acc.key) ?? "";
    try {
      const resp = await fetch(`${baseUrl}${WEIXIN_BOT_API_PREFIX}/getupdates`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${acc.botToken}`,
        },
        body: JSON.stringify({
          base_info: { channel_version: WEIXIN_CHANNEL_VERSION },
          get_updates_buf: buf,
        }),
        signal: AbortSignal.timeout(WEIXIN_GET_UPDATES_TIMEOUT_MS),
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as Record<string, unknown>;
      const container = isRecord(data.data) ? (data.data as Record<string, unknown>) : data;
      const nextBuf = readString(container, "get_updates_buf") || readString(container, "buf");
      if (nextBuf) this.bufs.set(acc.key, nextBuf);

      const msgs = Array.isArray(container.msgs) ? container.msgs : Array.isArray(container.messages) ? container.messages : [];
      for (const m of msgs) {
        if (!isRecord(m)) continue;
        if (readNumber(m, "message_type") === WEIXIN_MESSAGE_TYPE_BOT) continue;
        const text = readString(m, "content") || readString(m, "text") || this.readItemListText(m);
        const fromUser = readString(m, "from_user_id") || readString(m, "from_user") || readString(m, "from");
        const contextToken = readString(m, "context_token");
        if (!text.trim() || !fromUser) continue;
        // 发送者闸（复审 P0）：未配置 chatId 一律不应答（默认拒绝而非默认全放），
        // 配了就只应答那一个 OpenID。落进日志是为了让「配了 bot 却没反应」可排查。
        if (acc.chatId === undefined) {
          log.warn("weixin message dropped: account has no chatId filter (set chatId to allow a single admin chat)", { account: acc.key, from: fromUser });
          continue;
        }
        if (fromUser !== acc.chatId) continue;
        this.enqueue(acc, fromUser, text.trim(), contextToken);
      }
    } catch {
      // 网络或超时重试
    }
  }

  private readItemListText(msg: Record<string, unknown>): string {
    const items = Array.isArray(msg.item_list) ? msg.item_list : [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const textItem = isRecord(item.text_item) ? item.text_item : null;
      const t = readString(textItem, "text");
      if (t) return t;
    }
    return "";
  }

  private enqueue(acc: WeixinAccountSpec, userId: string, text: string, contextToken?: string): void {
    const prev = this.chains.get(acc.key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.handleMessage(acc, userId, text, contextToken));
    this.chains.set(acc.key, next);
  }

  private async handleMessage(acc: WeixinAccountSpec, userId: string, text: string, contextToken?: string): Promise<void> {
    // 检查是否有待办审批
    const pending = this.pendingApprovals.get(userId);
    if (pending && ["1", "2", "3"].includes(text)) {
      this.pendingApprovals.delete(userId);
      const decision = text === "1" ? "allow" : text === "2" ? "deny" : "always";
      try {
        await this.opts.host.resolvePermission(pending.sessionId, pending.requestId, decision);
        await this.sendMessage(acc, userId, `✅ 已收到裁决：${decision === "allow" ? "允许本次" : decision === "deny" ? "拒绝本次" : "永久允许"}。Agent 继续执行...`, contextToken);
      } catch (err: unknown) {
        await this.sendMessage(acc, userId, `❌ 裁决提交失败: ${err instanceof Error ? err.message : String(err)}`, contextToken);
      }
      return;
    }

    // 入站拦截器（docs/33 §3.4 IM 确认门）：「确认/拒绝 N」这类 daemon 级指令
    // 直接消化，不进 bot 轮次 —— 挂钩故障按未消费放行（与飞书同款铁律）
    if (this.opts.inboundHook !== undefined) {
      try {
        if (await this.opts.inboundHook(text.trim())) return;
      } catch {
        /* 拦截器故障不拦消息 */
      }
    }

    const bot = await this.opts.registry.getBot(acc.botId);
    if (!bot) return;

    // 发送思考占位
    await this.sendMessage(acc, userId, "🤔 正在思考...", contextToken);

    // 回收本轮挂的 permission 监听：runBotTurn 每轮都续同一个会话，退订函数
    // 丢掉不调的话监听一轮叠一个 —— N 轮后一次审批请求盖写 N 次pendingApprovals
    const unsubs: Array<() => void> = [];
    try {
      const result = await runBotTurn(this.opts.host, bot, text, {
        source: "weixin",
        mode: acc.interactiveApproval ? "build" : "yolo",
        // 交互审批位：不开它，host 对非 workbench 来源一律自动放行，
        // 下面的数字审批就只是装饰品（复审 P0）
        interactive: acc.interactiveApproval,
        onTurnStart: (sessionId) => {
          unsubs.push(
            this.opts.host.onSessionEvent(sessionId, "permission.requested", (ev) => {
              const event = ev as Extract<RuntimeEvent, { type: "permission.requested" }>;
              this.pendingApprovals.set(userId, {
                sessionId,
                requestId: event.requestId,
                detail: event.detail,
                kind: event.kind,
              });
              const prompt =
                `⚠️ 【操作审批】\n` +
                `任务需要执行以下操作：\n` +
                `【类别】${event.kind}\n` +
                `【详情】${event.detail}\n\n` +
                `👉 请直接回复以下数字完成裁决：\n` +
                `1️⃣ 回复 1：允许本次执行\n` +
                `2️⃣ 回复 2：拒绝本次执行\n` +
                `3️⃣ 回复 3：永久允许同类操作`;
              void this.sendMessage(acc, userId, prompt, contextToken);
            }),
            this.opts.host.onSessionEvent(sessionId, "permission.resolved", () => {
              this.pendingApprovals.delete(userId);
            }),
          );
        },
      });

      if (result.reply) {
        await this.sendMessage(acc, userId, result.reply, contextToken);
      }
    } catch (err: unknown) {
      await this.sendMessage(acc, userId, `❌ 执行出错: ${err instanceof Error ? err.message : String(err)}`, contextToken);
    } finally {
      for (const unsub of unsubs) unsub();
      // 轮次已终局（成功或失败），再无待裁决事项；留着残条会让下一轮的「1/2/3」
      // 去解析一个已死的 requestId
      this.pendingApprovals.delete(userId);
    }
  }

  private async sendMessage(acc: WeixinAccountSpec, toUserId: string, text: string, contextToken?: string): Promise<void> {
    const baseUrl = getApiBaseUrl(this.opts.apiBase);
    try {
      await fetch(`${baseUrl}${WEIXIN_BOT_API_PREFIX}/sendmessage`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${acc.botToken}`,
        },
        body: JSON.stringify({
          base_info: { channel_version: WEIXIN_CHANNEL_VERSION },
          msg: {
            from_user_id: acc.ilinkBotId ?? "",
            to_user_id: toUserId,
            client_id: `awb-wx-${randomUUID()}`,
            message_type: WEIXIN_MESSAGE_TYPE_BOT,
            message_state: WEIXIN_MESSAGE_STATE_FINISH,
            ...(contextToken ? { context_token: contextToken } : {}),
            item_list: [
              {
                type: 1,
                text_item: { text: text.replace(/\r\n|\r|\n/g, "\r\n") },
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      log.warn("weixin sendMessage failed", { error: String(err) });
    }
  }
}
