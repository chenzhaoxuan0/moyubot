/**
 * daemon 入口 —— bootstrap、方法注册、优雅退出。
 *
 * Phase 0 只证明一件事：daemon 能起、日志清、WS/REST 可达（验收在 scripts/smoke-health.ts）。
 * Phase 1 在这里注册 session.* 方法并把 RuntimeEvent 接进 broadcastEvent。
 */

import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { join } from "node:path";
import { exec, spawn } from "node:child_process";
import { loadConfig } from "./config.ts";
import { healthPayload, isLocalOrigin, isLoopbackAddr, startHttp, type HttpRoute } from "./httpd.ts";
import { ImageProfileStore, type ImageProfileRow } from "./image/profiles.ts";
import { handleImageCall } from "./image/proxy.ts";
import { log, setLogLevel } from "./log.ts";
import { setSecretsHome } from "./secrets.ts";
import { applyMethodMeta, attachWs, broadcastBacklog, broadcastEvent, broadcastNotification, broadcastTerminal, dispatchRpc, registerMethod, WIRE_VERSION } from "./wsd.ts";
import { METHOD_META } from "./methods.meta.ts";
import { composePrompt, inlineAttachments, runChatTurn } from "./chat.ts";
import { NotificationsService } from "./notifications.ts";
import { generateImage, ImageTasks, type GenerateParams } from "./image/generate.ts";
import { PermissionGate } from "./permissions/gate.ts";
import { MockPermAdapter } from "./runtime/adapters/mockperm.ts";
import { ClaudeAdapter } from "./runtime/adapters/claude.ts";
import { RuntimeHost } from "./runtime/host.ts";
import { TraceSink } from "./runtime/trace.ts";
import { ZcodeAdapter } from "./runtime/adapters/zcode.ts";
import { CodexAdapter } from "./runtime/adapters/codex.ts";
import { PiAdapter } from "./runtime/adapters/pi.ts";
import { McodeAdapter } from "./runtime/adapters/mcode.ts";
import { DshAdapter } from "./runtime/adapters/dsh.ts";
import { OpencodeAdapter } from "./runtime/adapters/opencode.ts";
import { HermesAdapter } from "./runtime/adapters/hermes.ts";
import { KimiAdapter } from "./runtime/adapters/kimi.ts";
import { AgyAdapter } from "./runtime/adapters/agy.ts";
import { GrokAdapter } from "./runtime/adapters/grok.ts";
import { CursorAdapter } from "./runtime/adapters/cursor.ts";
import { OpenclawAdapter } from "./runtime/adapters/openclaw.ts";
import { buildSkillsInventory, copySkill, setSkillDisabled } from "./skills/inventory.ts";
import { syncWorkbenchSkill, workbenchSkillPath } from "./skills/workbenchSkill.ts";
import { syncContextSkill } from "./skills/contextSkill.ts";
import * as gitRepo from "./git/repo.ts";
import { GIT_ERROR_CODES } from "./contract.ts";
import { GitWatcher } from "./git/watch.ts";
import { listWorkspacePaths } from "./workspacePaths.ts";
import { listInstalledEditors, openInEditorApp } from "./workspaceEditors.ts";
import {
  mcpCopy,
  mcpInventory,
  mcpReadFile,
  mcpRemove,
  mcpSave,
  mcpSetEnabled,
  sanitizeEntry,
  type McpServiceDeps,
} from "./mcpadmin/service.ts";
import { createBrowserControlService } from "./browserctl/service.ts";
import { createComputerControl } from "./computerctl/server.ts";
import { createSearchService } from "./searchctl/service.ts";
import { SEARCH_PROVIDER_INFOS } from "./searchctl/providers.ts";
import { COMPUTER_MCP_PATH, controlActions, registerAcpEntriesProvider, setControlContext } from "./ctrl/store.ts";
import { TerminalManager } from "./terminal/terminals.ts";
import { Store } from "./store/db.ts";
import { listNativeSessions, readNativeSession, readerOf, readerIds, type NativeSessionSummary } from "./history/index.ts";
import { syncNativeSession, forgetNativeSyncState, NativeSessionWatcher } from "./history/sync.ts";
import {
  knownNativeRefs,
  materializeImportedSession,
  startNativeAutoCollect,
  TERMINAL_BACKFILL_MAX_AGE_MS,
} from "./history/autocollect.ts";
import { samePath } from "./history/util.ts";
import {
  buildSharedBundle,
  importSharedSession,
  parseSharedBundle,
  parseTraceNdjson,
} from "./history/shareImport.ts";
import { ExecutorUpdatesChecker } from "./runtime/updates.ts";
import { AutomationScheduler } from "./automation/scheduler.ts";
import { QuotaResumeWatcher } from "./automation/quotaResume.ts";
import { getAutomationCreateLimit, setAutomationCreateLimit } from "./automation/limits.ts";
import { QuotaProbe } from "./backlog/probe.ts";
import { cronNextAt, parseCron } from "./automation/cron.ts";
import {
  buildAbsoluteSchedule,
  buildRelativeDelaySchedule,
  computeScheduleNextRunAt,
  scheduleRuleToCron,
  type LaunchMode,
  type ScheduleRule,
} from "../../prototype/src/core/automation.ts";
import { MemoryService } from "./memory/memory.ts";
import { FileMemoryInjector } from "./memory/injection.ts";
import { readLongTerm, writeLongTerm, readDaily, listDaily, readUser, writeUser, readStanding, writeStanding } from "./memory/projectMemory.ts";
import {
  readAppearance,
  writeAppearance,
  readWallpaperDataUrl,
  saveWallpaper,
  deleteWallpaper,
  readLogoDataUrl,
  saveLogo,
  deleteLogo,
  listThemes,
  saveTheme,
  deleteTheme,
} from "./appearance/store.ts";
import { DailyDigest } from "./memory/dailyDigest.ts";
import { stewardSearch, stewardRecent, ensureSteward, stewardRoot, stewardDefinition, STEWARD_ID } from "./memory/steward.ts";
import { runCurator, renderReport, DEFAULT_CURATOR, DbMetaStore, type CuratorConfig } from "./memory/curator.ts";
import { MemoryScheduler } from "./memory/scheduler.ts";
import { getGuardianConfig, setGuardianConfig, type MemoryGuardianConfig } from "./memory/guardianConfig.ts";
import { maybeConsolidate } from "./memory/consolidator.ts";

/** 记忆系统的后台调度（每日总结 + curator）。启动时挂上，停止时摘掉。 */
let memoryScheduler: MemoryScheduler | undefined;
/** 待办（GTD）引擎：在 wss 就绪后构造（广播要用），这里先声明给 host 回调引用。 */
let backlogEngine: BacklogEngine | undefined;
import { BacklogEngine } from "./backlog/heartbeat.ts";
import { getBacklogConfig, setBacklogConfig } from "./backlog/config.ts";
import {
  ensureHeartbeatBot,
  heartbeatBotDefinition,
  heartbeatBotShape,
  HEARTBEAT_BOT_ID,
  HEARTBEAT_DEFAULT_RUNTIME_ID,
} from "./backlog/heartbeatBot.ts";
import { draftPromptOf, type BacklogConfig, type BacklogSignal } from "../../prototype/src/core/backlog.ts";
import { BotRegistry } from "./bots/registry.ts";
import { TelegramGateway } from "./channels/telegram.ts";
import { FeishuGateway, diagnoseLarkAccount, larkIdentities, larkProfileList, addLarkProfile } from "./channels/feishu.ts";
import { WeixinGateway, beginWeixinLogin, pollWeixinLogin } from "./channels/weixin.ts";
import { DiscordGateway } from "./channels/discord.ts";
import { CredentialVault } from "./credentials/vault.ts";
import { getNetworkInterfaces } from "./network.ts";
import { TunnelManager } from "./tunnel/manager.ts";
import { askBot } from "./channels/askBot.ts";
import { asModelId, asSessionId, asUnitId, normalizeContextManifest, normalizeSkillBinding, type ContextManifest } from "../../prototype/src/core/units.ts";

const startedAt = Date.now();
const config = loadConfig();
// 密钥的 env: 引用可落到 <homeDir>/.env（README「密钥放在哪」）—— 家目录定下来就接上
setSecretsHome(config.homeDir);
setLogLevel(config.logLevel);

mkdirSync(config.homeDir, { recursive: true });

// ---- 端口预检（必须排在一切副作用之前）-------------------------------------
//
// 踩过的坑：Windows 的 Hyper-V / WSL 会保留一整段动态端口（本机实测
// 5141–5240 被占，5181 正在其中），撞上时 `listen` 报 EACCES。
// 而在这**之后**代码还会去起 telegram / feishu 网关、automation 调度器、
// 记忆调度器 —— 侧效应全发生了才崩，留下半启动状态。
//
// 所以：先探端口，探不通立刻带着**可执行的**提示退出，一个副作用都不留。

async function attemptFreePort(port: number): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    if (process.platform === "win32") {
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
      let freed = false;
      for (const line of out.split(/\r?\n/)) {
        if (line.includes(`:${port}`) && line.includes("LISTENING")) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== "0" && Number(pid) !== process.pid) {
            execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore" });
            freed = true;
          }
        }
      }
      return freed;
    } else {
      // -sTCP:LISTEN：只回收监听进程。不带过滤时 lsof 会把连到该端口的客户端
      // 连接（浏览器标签页 / WS 客户端）一并 SIGKILL，与 win32 分支口径对齐。
      const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: "utf8" });
      const pids = out.trim().split(/\s+/).filter(Boolean);
      let freed = false;
      for (const pid of pids) {
        if (Number(pid) !== process.pid) {
          process.kill(Number(pid), "SIGKILL");
          freed = true;
        }
      }
      return freed;
    }
  } catch {
    return false;
  }
}

async function preflightPort(port: number, host: string): Promise<void> {
  const { createServer } = await import("node:net");
  return new Promise<void>((resolve, reject) => {
    const tryListen = (isRetry = false) => {
      const srv = createServer();
      srv.once("error", async (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && !isRetry && process.env.NODE_ENV !== "production") {
          const freed = await attemptFreePort(port);
          if (freed) {
            console.log(`[daemon] 检测到端口 ${port} 被残留孤儿进程占用，已自动回收并重新接管...`);
            await new Promise((r) => setTimeout(r, 200));
            return tryListen(true);
          }
        }
        const hint =
          err.code === "EACCES"
            ? "端口被系统保留了。Windows 的 Hyper-V / WSL 会留一整段动态端口，" +
              "用 `netsh interface ipv4 show excludedportrange protocol=tcp` 就能看到。\n" +
              `换一个不在保留段里的端口：后端 AGENT_WORKBENCH_PORT=<新端口>，前端 VITE_AGENT_WORKBENCH_PORT=<同一个>。`
            : err.code === "EADDRINUSE"
              ? "端口已被占用（可能已经有一个 daemon 在跑）。换个端口，或先停掉那个。"
              : "换个端口试试。";
        reject(Object.assign(new Error(`daemon 端口 ${host}:${port} 不可用 —— ${err.message}\n${hint}`), { code: "port_unavailable" }));
      });
      srv.once("listening", () => srv.close(() => resolve()));
      srv.listen(port, host);
    };
    tryListen();
  });
}

// top-level await：**await 真的挡住了后续初始化**。写成 `void preflightPort(...)`
// 的话预检和后面的同步代码是并发的，侧效应照样会发生，等于没加。
try {
  await preflightPort(config.port, "127.0.0.1");
} catch (err: unknown) {
  console.error(`\n启动中止：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// ---- 事件循环阻塞监视器（Worker 版）------------------------------------------
//
// 为什么必须是 worker：2026-10-15 实测 daemon 两次整体冻结（/healthz 无响应，
// CPU 静止 = 主线程卡在同步调用里，minidump 栈回溯定位到 conpty.node）。旧版
// 监视器是主线程 setInterval —— 主线程永久卡死时定时器根本不会触发，一行
// 证据都留不下。worker 有独立事件循环：主线程停止心跳后它照样跑，把停摆
// 的时间点/时长写进 <homeDir>/loop-stall.log（恢复时再补一行）。
// 正常情况零输出、零开销（主线程 1s 一次 unref 心跳）。

{
  const STALL_THRESHOLD_MS = 5_000;
  const stallLogPath = join(config.homeDir, "loop-stall.log");
  const watchdogSrc = `
    const { parentPort } = require("node:worker_threads");
    const { appendFileSync } = require("node:fs");
    const THRESHOLD = ${STALL_THRESHOLD_MS};
    const LOG = ${JSON.stringify(stallLogPath)};
    let lastBeat = Date.now();
    let stalledSince = 0;
    parentPort.on("message", () => { lastBeat = Date.now(); });
    setInterval(() => {
      const silent = Date.now() - lastBeat;
      if (silent > THRESHOLD && stalledSince === 0) {
        stalledSince = Date.now();
        const line = new Date().toISOString() + " main-loop stalled (> " + Math.round(silent / 100) / 10 + "s and counting)\\n";
        try { appendFileSync(LOG, line); } catch {}
        console.error("[loop-stall] " + line.trim());
      } else if (silent <= THRESHOLD && stalledSince !== 0) {
        const dur = Date.now() - stalledSince;
        stalledSince = 0;
        const line = new Date().toISOString() + " main-loop recovered, stalled " + Math.round(dur / 100) / 10 + "s\\n";
        try { appendFileSync(LOG, line); } catch {}
        console.error("[loop-stall] " + line.trim());
      }
    }, 1000).unref();
  `;
  try {
    const { Worker } = await import("node:worker_threads");
    const watchdog = new Worker(watchdogSrc, { eval: true });
    watchdog.unref();
    const beat = setInterval(() => watchdog.postMessage(1), 1000);
    beat.unref?.();
  } catch (err: unknown) {
    console.error("loop-stall watchdog 起不来（继续跑，只是没证据兜底）", err instanceof Error ? err.message : String(err));
  }
}

// ---- 服务与执行器（先建好，REST 路由要引用）---------------------------------

const store = new Store(config.homeDir);
const gate = new PermissionGate(store);
const traceSink = new TraceSink(config.homeDir);
const botRegistry = new BotRegistry(store);
// 执行器新版本检测（docs/27）：daemon 只拥有网络面（npm/PyPI 查 latest + 缓存），
// 当前版本由前端传入（探测状态活在前端注册表，daemon 不做启动探测）
const executorUpdates = new ExecutorUpdatesChecker(config.homeDir);
// 通知事实源（docs/21 P4b）：挂在 host 事件汇点上聚合，「你不在它面前」与已读留在客户端。
// metaOf 的 host 引用是闭包惰性求值（构造时 host 还不存在，事件到达时早已就绪）。
const notifications = new NotificationsService(config.homeDir, (sid) => {
  const s = host.listSessions().find((x) => String(x.id) === sid);
  return s === undefined ? undefined : { source: s.source, title: s.title };
});
const host = new RuntimeHost((event, seq) => {
  broadcastEvent(wss, event, seq);
  // 通知是遥测不是功能路径：聚合异常绝不能炸断事件管线（review 保护——
  // record 会查台账取会话元数据，任何抖动只降级为丢一条通知）
  try {
    notifications.record(event);
  } catch (err: unknown) {
    log.warn("notifications record failed", { error: err instanceof Error ? err.message : String(err) });
  }
  // 自动化运行记录的终态回灌（Phase 5）
  if (event.type === "session.ended") {
    const hit = automationRunBySession.get(event.sessionId);
    if (hit !== undefined) {
      automationRunBySession.delete(event.sessionId);
      const failed = event.reason === "error" || event.reason === "executor_exited";
      store.finishAutomationRun(hit.runId, failed ? "failed" : "done", `ended: ${event.reason}`);
      // 会话本身跑挂了也要挂失败徽章 —— 不然调度层看不到，卡片一直显示「已完成」
      if (failed) store.setAutomationError(hit.automationId, `ended: ${event.reason}`, Date.now());
      // 通知取台账任务名直取（docs/21 P4b，取代前端补偿解析）；与上面 record() 的
      // end:{sid} 同键原位刷新成「任务名 + 摘要」——同一条遥测保护
      try {
        const autoName = store.listAutomations().find((a) => a.id === hit.automationId)?.name;
        notifications.notifyAutomationEnd(String(event.sessionId), event.reason, autoName);
      } catch (err: unknown) {
        log.warn("automation end notification failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // 待办（GTD）执行的终态回灌 —— 引擎内部按 sessionId 映射判归属，与自动化互不干扰
    backlogEngine?.onSessionEnded(event.sessionId, event.reason);
  }
}, traceSink, config.homeDir, store, gate, new FileMemoryInjector(config.homeDir));
memoryScheduler = new MemoryScheduler({
  homeDir: config.homeDir,
  store,
  knownProjects: () => botRegistry.roots(),
  // 设置页「每日总结」开关的权威值在 kv（memory.guardian.set 写入）。
  // 每 tick 动态读，改开关不用重启 daemon —— 关掉只停定时跑，设置页的试跑按钮不受影响。
  digestEnabled: () => getGuardianConfig(store).digestEnabled,
  // 「用户最近一次有对话活动」：取会话行的 started_at / ended_at 与最后一条消息
  // 时间里的最大值。**不能只看 startedAt** —— 会话的开始时间在整个会话期间不变，
  // 早上开的会话到晚上仍报「早间空闲」，curator 的 idle 闸就会在用户正聊着的时候
  // 放行 600s 的后台记忆整理。
  lastActivityAt: () => {
    const rows = store.listSessions();
    let max = 0;
    for (const r of rows) {
      max = Math.max(max, r.startedAt, r.endedAt ?? 0);
    }
    return Math.max(max, store.latestMessageAt());
  },
});
host.register(new ZcodeAdapter());
host.register(new CodexAdapter());
host.register(new ClaudeAdapter());
host.register(new PiAdapter());
host.register(new McodeAdapter());
host.register(new DshAdapter());
host.register(new OpencodeAdapter());
host.register(new HermesAdapter());
host.register(new KimiAdapter());
host.register(new AgyAdapter());
host.register(new GrokAdapter());
host.register(new CursorAdapter());
host.register(new OpenclawAdapter());
host.register(new MockPermAdapter());
// 一次性迁移（kv 防重）：导入会话的旧投影缺首条 prompt（<system-reminder> 包裹块
// 连同正文一起被丢）与 compaction/thinking 条目——剔除旧 ext 投影记录 + 清消息，
// 各会话下次打开时按新 reader 全量重投影。真实 host 事件（曾点击 reattach 的续聊
// 轮次）保留不动。必须在 loadPersisted 之前跑，装载的 seq 才基于修剪后的账本
try {
  if (store.kvGet("imp-reproj-v2") !== "1") {
    const rows = store.listSessions().filter((s) => s.source === "imported");
    if (rows.length > 0) {
      const removed = await traceSink.pruneExtRecords(rows.map((r) => r.id));
      // 只清消息行，不动 last_seq/turn_count：setSessionProgress 是 MAX 钳制的
      // 只增接口，传 0 是 no-op；同步游标不来自台账行，来自 sync.ts 对账本的
      // msg_ext_/tc_ext_ 扫描（prune 已把旧投影记录剔除，扫描自然从 0 起步）
      for (const r of rows) {
        store.clearSessionMessages(r.id);
      }
      log.info("imported sessions re-projection migration", { sessions: rows.length, removedRecords: removed });
    }
    store.kvSet("imp-reproj-v2", "1");
  }
} catch (err) {
  // 失败下次启动重试（kv 未置位）
  log.warn("re-projection migration failed", { err: String(err) });
}
host.loadPersisted();
memoryScheduler?.start();
// ⚠ 这里**刻意不做**启动预热探测。
//
// 早先这里是 `void host.syncAllModels()`：每次启动都要并发拉起十来个 CLI 子进程
// 去列模型清单（实测总耗时 28s，openclaw 一家就 28.5s），换来的是「用户没要求的
// 一次后台开销」。而它其实换不来正确性 —— fire-and-forget 的探测和界面的
// adapter.list 赛跑，谁先谁后全看时序。
//
// 现在启动只读盘上的兜底缓存（RuntimeHost 构造函数同步做，几 KB），
// 于是冷启动**立刻**给得出上一次的真实探测结果；要最新的由用户点
// 「探测模型」或「重新探测执行器」，两条路都汇到 host.syncModels()。
//
// 代价说清楚：首次安装（盘上还没有缓存）时，启动看到的是各适配器的内置种子清单，
// 界面上如实标「· 未刷新」—— 要真实清单得点一下刷新。这是「按需付费」换来的，
// 不是把问题藏起来。
// 想恢复启动预热，把下面这行加回来即可（宿主已从盘上载好缓存，不会再退回种子清单）：
// void host.syncAllModels();

/** 启动引导绝不覆盖的用户数据键 —— steward / heartbeat 同一套口径，加新键只改这里（tags 仅 heartbeat 拥有，调用处单独附加） */
const USER_OWNED_BOT_KEYS = ["name", "bindings", "avatar", "themeAccent", "channels", "memory"] as const;

// 总管 bot：初始化即就位（docs/10 §4.6）。失败不阻断启动 ——
// 记忆是增强，不是前置条件。
void ensureSteward(config.homeDir)
  .then(({ rootPath }) => {
    botRegistry.addRoot(rootPath);
    // 幂等：已经在盘上且定义没变就别重写。
    // 每次启动都 putBot 会把 revision 一路顶高（实测重启 5 次就 revision=5），
    // 白写盘，还会和别处的乐观锁打架。
    return botRegistry.getBot(STEWARD_ID).then(async (existing) => {
      const want = stewardDefinition(rootPath);
      // 用户在设置页能改的都属于**用户数据**（执行器/模型/头像/对话主题色/渠道/
      // 记忆策略/名称/角色人设），启动引导只补结构，绝不覆盖 —— 否则每次重启都会把
      // 用户配置打回硬编码初始值（实测复现：改成非 mcode 的执行器后重启必被
      // 回写）。比对与写盘都用 merged。
      const prev = (existing ?? {}) as Record<string, unknown>;
      const userOwned: Record<string, unknown> = {};
      for (const k of USER_OWNED_BOT_KEYS) {
        if (prev[k] !== undefined) userOwned[k] = prev[k];
      }
      // identity 里 sourcePath 是结构指针（跟 want），role/persona 是用户数据
      const prevIdentity = (prev.identity ?? {}) as Record<string, unknown>;
      const wantIdentity = (want.identity ?? {}) as Record<string, unknown>;
      userOwned.identity = {
        ...wantIdentity,
        ...(prevIdentity.role !== undefined ? { role: prevIdentity.role } : {}),
        ...(prevIdentity.persona !== undefined ? { persona: prevIdentity.persona } : {}),
      };
      const merged = { ...want, ...userOwned };
      if (existing !== undefined && stewardShape(existing) === stewardShape(merged)) {
        return { id: STEWARD_ID, revision: undefined, unchanged: true as const };
      }
      const r = await botRegistry.putBot(merged);
      return { id: STEWARD_ID, revision: r.revision, unchanged: false as const };
    });
  })
  .then((r) => log.info("steward bot ready", { id: r.id, revision: r.revision, unchanged: r.unchanged }))
  .catch((err: unknown) => log.warn("steward bot init failed", { error: err instanceof Error ? err.message : String(err) }));

// 心跳 bot（常驻合成 bot，对齐 steward 模式）：待办心跳会话的宿主身份。
// AGENTS.md 岗位说明书（决策依据/输出契约/红线）随目录播种 —— zcode 等执行器
// 在 cwd 原生读它，心跳 agent 的角色设定不靠 prompt 拼接。失败不阻断启动。
void ensureHeartbeatBot(config.homeDir)
  .then(({ rootPath }) => {
    botRegistry.addRoot(rootPath);
    // 幂等 + 用户数据不覆盖：与 steward 同一套口径（结构补齐，name/bindings/
    // avatar/themeAccent/channels/memory/identity.role/persona 归用户）
    return botRegistry.getBot(HEARTBEAT_BOT_ID).then(async (existing) => {
      const want = heartbeatBotDefinition(rootPath, HEARTBEAT_DEFAULT_RUNTIME_ID);
      const prev = (existing ?? {}) as Record<string, unknown>;
      const userOwned: Record<string, unknown> = {};
      for (const k of [...USER_OWNED_BOT_KEYS, "tags"]) {
        if (prev[k] !== undefined) userOwned[k] = prev[k];
      }
      const prevIdentity = (prev.identity ?? {}) as Record<string, unknown>;
      const wantIdentity = (want.identity ?? {}) as Record<string, unknown>;
      userOwned.identity = {
        ...wantIdentity,
        ...(prevIdentity.role !== undefined ? { role: prevIdentity.role } : {}),
        ...(prevIdentity.persona !== undefined ? { persona: prevIdentity.persona } : {}),
      };
      const merged = { ...want, ...userOwned };
      if (existing !== undefined && heartbeatBotShape(existing) === heartbeatBotShape(merged)) {
        return { unchanged: true as const };
      }
      await botRegistry.putBot(merged);
      return { unchanged: false as const };
    });
  })
  .then((r) => log.info("heartbeat bot ready", { id: HEARTBEAT_BOT_ID, unchanged: r.unchanged }))
  .catch((err: unknown) => log.warn("heartbeat bot init failed", { error: err instanceof Error ? err.message : String(err) }));

/**
 * 管家定义的**规范形状**，用于幂等比较。
 *
 * 刻意**不手列字段**。前两版都手列过，两次都栽在同一处：
 * 加了新字段（`kind`、又 `tags`）却忘了加进这个列表 → 比较永远说「没变化」
 * → 新字段永远写不进盘，而且**没有任何报错**。
 *
 * 改成从定义本身派生：排除「hydrate 产物 + 每次都变的」那几个键，
 * 其余全参与比较。这样新增字段自动被覆盖，这类 bug 结构上不再可能发生。
 */
// hydrate 产物 + 每次都变的键。注意 `$meta` 带美元号 —— bot.list 里实际是这个键名。
//
// `identity` 也在排除之列：它带 sourcePath 指针，而 **AGENTS.md 是用户的** ——
// 用户手改岗位说明书时，identity 里的 loadedAt 等会变。把整块排除掉，
// 启动流程才不会把手改内容当成「配置漂移」再覆盖回去。
const STEWARD_VOLATILE = new Set([
  "updatedAt", "meta", "$meta", "agentsMd", "agentsMdMeta", "revision", "sourcePath", "identity",
]);

function stewardShape(def: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(def).sort()) {
    if (STEWARD_VOLATILE.has(k)) continue;
    out[k] = def[k];
  }
  return JSON.stringify(out);
}

// ---- T3 式执行器目录（按需开启的可见性面）-----------------------------------
// 已注册的执行器出现在 adapter.list；未注册的已知驱动在这里以真实状态列出
//（not_installed / not_configured），前端可据此渲染灰色项与配置指引。
// 某家补齐安装/凭据后，probe 通过即可升级为注册执行器（新增 = adapter 文件 + 注册一行）。
registerMethod("driver.catalog", () => [
  { id: "zcode", installed: true, registered: true, hint: "" },
  { id: "codex", installed: true, registered: true, hint: "" },
  { id: "claude", installed: true, registered: true, hint: "网关偶发过载时 turn 失败，恢复即用" },
  { id: "pi", installed: true, registered: true, hint: "" },
  { id: "mcode", installed: true, registered: true, hint: "ACP 接入（mcode acp），权限审批走反向请求流" },
  { id: "dsh", installed: true, registered: true, hint: "ACP 接入（dsh acp），npm 全局 shim 指向源码 checkout 已失效，走桌面版 CLI" },
  { id: "mockperm", installed: true, registered: true, hint: "权限闸试金石" },
  {
    id: "opencode",
    installed: true,
    registered: true,
    hint:
      "ACP 接入（opencode acp），与 mcode/dsh 同构；不选模型即跟随 opencode 默认（实测 opencode/big-pickle），完整模型清单随 session/new 下发",
  },
  { id: "hermes", installed: true, registered: true, hint: "ACP 接入（hermes acp），模型/模式走 session/set_model、session/set_mode；终端裸命令 hermes 即全屏 TUI" },
  { id: "kimi", installed: true, registered: true, hint: "ACP 接入（kimi acp），模型走 session/set_config_option（无 set_model）；凭据过期时报 kimi login 指引，终端裸命令 kimi 即全屏 TUI" },
  { id: "cursor-agent", installed: false, registered: false, hint: "未安装（cursor-agent install）" },
  { id: "grok", installed: false, registered: false, hint: "未安装" },
  { id: "antigravity", installed: false, registered: false, hint: "未安装" },
]);

// ---- 自动化调度（Phase 5 v2）-------------------------------------------------

/** sessionId → { runId, automationId }：会话结束态回灌运行记录与失败徽章 */
const automationRunBySession = new Map<string, { runId: number; automationId: number }>();
/** terminalId → { runId, automationId }：TUI 模式（无 host 会话）的运行记录靠 exit 帧结算 */
const automationRunByTerminal = new Map<string, { runId: number; automationId: number }>();

// 终端必须在 runAutomation 之前构造（TUI 派发要用）。exit 帧在这里顺带结算
// TUI 模式的运行记录 —— 放进 TerminalManager 的 emit 回调，是唯一的全局出口。
const terminals = new TerminalManager((frame) => {
  if (frame.kind === "exit") {
    const hit = automationRunByTerminal.get(frame.terminalId);
    if (hit !== undefined) {
      automationRunByTerminal.delete(frame.terminalId);
      const ok = (frame.exitCode ?? 0) === 0;
      store.finishAutomationRun(hit.runId, ok ? "done" : "failed", `terminal exit ${frame.exitCode ?? "?"}`);
      if (!ok) store.setAutomationError(hit.automationId, `terminal exit ${frame.exitCode ?? "?"}`, Date.now());
      else store.setAutomationError(hit.automationId, null, null);
      log.info("automation terminal run settled", { runId: hit.runId, exitCode: frame.exitCode ?? "?" });
    }
    // 待办 TUI 模式的运行记录与状态机收口（engine 内部按 terminalId 判归属）
    backlogEngine?.onTerminalExited(frame.terminalId, frame.exitCode ?? 0);
    // 手动派发终端（terminal.dispatch）的运行记录收口（无行的 id 静默无操作）
    const isUserInterrupt =
      frame.exitCode === 130 ||
      frame.exitCode === 143 ||
      frame.exitCode === 3221225786 ||
      frame.exitCode === -1073741510;
    const manualDone = frame.killed || (frame.exitCode ?? 0) === 0 || isUserInterrupt;
    const transcript = frame.transcript ?? null;
    if (transcript) {
      store.saveTerminalTranscript(frame.terminalId, transcript);
    }
    if (manualDone) store.finishTerminalRun(frame.terminalId, "done", null, transcript);
    else store.finishTerminalRun(frame.terminalId, "failed", `terminal exit ${frame.exitCode ?? "?"}`, transcript);
  }
  if (frame.kind === "title") {
    if (typeof frame.title === "string") {
      store.setTerminalRunTitle(frame.terminalId, frame.title);
      log.info("terminal title captured from input", { terminalId: frame.terminalId, title: frame.title });
    }
    return;
  }
  broadcastTerminal(wss, { v: WIRE_VERSION, type: "terminal", ...frame });
});

/**
 * TUI 模式的 prompt 注入形态：括号粘贴序列包住全文再回车。
 * raw 写入的多行文本会被 ink 系 TUI 逐行当提交，括号粘贴让整块按一次粘贴
 * 处理（换行保留、不提前发车），随后的 \r 才是真正的提交键。
 */
function bracketedPaste(prompt: string): string {
  return `\x1b[200~${prompt}\x1b[201~`;
}

/**
 * 共享的 TUI 派发（automations / backlog / 手动派发终端都走这里）：在 PTY 里以
 * yolo 免审批拉起执行器 TUI，prompt 非空时注入（手动派发不带 prompt，人自己敲），
 * args 透传给 CLI（历史会话恢复用，如 zcode 的 --resume <sessionId>），
 * 返回 autoterm_ 前缀的终端 id。终态不经 host —— 派发方各自挂 terminalId 映射，
 * 由上面的 exit 帧回调结算。
 */
async function launchExecutorTerminal(opts: {
  runtimeId: string;
  unitId: string;
  rootPath: string;
  prompt?: string;
  args?: readonly string[];
}): Promise<string> {
  const terminalId = `autoterm_${randomUUID()}`;
  terminals.create({
    terminalId,
    cwd: opts.rootPath,
    // :yolo 后缀 → TerminalManager 按执行器补免审批 flag（实测口径见其注释）
    executorId: tuiCommandFor(`${opts.runtimeId}:yolo`),
    unitId: opts.unitId,
    autoExit: true,
    ...(opts.args !== undefined && opts.args.length > 0 ? { args: opts.args } : {}),
  });
  if (opts.prompt !== undefined && opts.prompt !== "") {
    // TUI 起稳后把提示词「敲」进去 —— 失败不回滚派发（终端已开，人可以自己输入）
    void terminals.writeWhenQuiet(terminalId, bracketedPaste(opts.prompt) + "\r").then(() => {
      log.info("prompt injected to terminal", { terminalId, runtimeId: opts.runtimeId });
    });
  }
  return terminalId;
}

/**
 * 定时发送的收件对话（dispatch_target = existing_session）。
 *
 * 三级回退，宁可往前退也不能空发：
 *  1. 规则上钉死的 targetSessionId（用户手动指定的那一个）
 *  2. 该执行器最近一个还能 resume 的会话 ——「刚撞到用量墙的那个对话」就是它：
 *     cliRef 非空才接得回来（首轮没结束过的会话拿不到 cliRef，接不了）
 *  3. 全都接不回来 → 返回 null，调用方退回「新开会话」，绝不静默丢弃这条自动化
 */
function resolveSendTarget(
  automation: { runtimeId: string; targetSessionId?: string | null },
  fallbackSessionId?: string | null,
): string | null {
  /**
   * 这个会话能不能接住这条定时消息，判据是「发得出去」，不是「库里有引用」：
   *  - 活着（impl 还在 daemon 进程里）→ 直接 sendMessage 就行，压根不需要 cli_ref
   *  - 不活着但有 cli_ref → reattach 接回来再发
   *  - 两者皆无 → 接不住
   *
   * ⚠ 这里曾经只认 cli_ref，于是「第一轮还没跑完」的对话被判成接不住 ——
   * 而 cli_ref 要等首轮的 message.completed 才落盘（host.ts 的 syncCliRef），
   * 恰好把最常见的一种用法挡在外面：刚开一个新对话就安排定时消息。
   * 后果是 UI 说「能安排」（ScheduleSendMenu 判 live || resumable），
   * 到点却静默另开一个对话把消息投过去 —— 用户在原对话里永远看不到那条消息，
   * 只在自动化卡片上留一行红字。探针实证：会话数 1 → 3，消息没进目标对话。
   */
  const pick = (id: string): string | null => {
    const row = store.getSession(id);
    if (row === undefined) return null;
    // runtimeId 必须一致：会话是执行器私有的，跨执行器的 cli_ref 根本接不回来，
    // 钉了别家执行器的会话还投出去 = 把提示词发进一个必然失败（或错误家）的对话
    if (row.runtimeId !== automation.runtimeId) return null;
    // 活着就能直接发 —— 不看 cli_ref
    if (host.isLive(asSessionId(id))) return id;
    // 不活着：得有执行器引用才接得回来
    return row.cliRef !== null ? id : null;
  };
  // 1. 如果用户显式钉死了目标会话，只认该会话；接不回则直接返回 null，由外层回退到新开会话，绝不乱投到其它无关会话
  if (automation.targetSessionId !== null && automation.targetSessionId !== undefined && automation.targetSessionId !== "") {
    return pick(automation.targetSessionId);
  }
  // 2. 自动续接模式：优先用显式传入的候选，否则挑该执行器最近一个可接回的会话
  if (fallbackSessionId !== undefined && fallbackSessionId !== null) {
    const hit = pick(fallbackSessionId);
    if (hit !== null) return hit;
  }
  // 3. 自动挑选（用户没钉死目标）：口径**比显式指定更严**，只认 cli_ref 非空的。
  //    显式指定是「用户当下正看着这个对话」，它能不能收消息由 live 说了算；
  //    自动挑选是「随便找个能接回来的」——「接回来」本义就是要 reattach，
  //    所以必须有 cli_ref。判据不同不是遗漏，是两条路径的语义本就不同。
  for (const s of store.listSessions()) {
    // 导入的外部会话是档案不是可续发的对话 —— 自动续接不往里投
    if (s.runtimeId !== automation.runtimeId || s.cliRef === null || s.source === "imported") continue;
    return s.id;
  }
  return null;
}

/**
 * 「对话页」形态（launchMode=chat）的前台拉起广播：会话已由 daemon 开好（或
 * 接回），请前端把它打开到聊天时间线前台。与 git.changed 同款 broadcast-only
 * 口径（独立 seq、不落账本）—— 漏发的代价只是不自动跳前台，会话仍在历史
 * 列表/底栏任务条里可点开，不构成功能缺失。
 */
let foregroundSeq = 0;

function broadcastForeground(
  sessionId: string,
  unitId: string,
  runtimeId: string,
  cause: "automation" | "backlog",
  title?: string,
): void {
  broadcastEvent(
    wss,
    {
      type: "session.foreground",
      sessionId: asSessionId(sessionId),
      unitId: asUnitId(unitId),
      runtimeId,
      cause,
      ...(title !== undefined ? { title } : {}),
    },
    ++foregroundSeq,
  );
}

async function runAutomation(
  a: {
    id: number;
    unitId: string;
    unitName: string;
    /** 卡片名 —— chat 派发的前台广播带它做提示标题 */
    name: string;
    runtimeId: string;
    rootPath: string;
    prompt: string;
    model: string | null;
    mode: string | null;
    launchMode: LaunchMode;
    dispatchTarget?: "new_session" | "existing_session";
    targetSessionId?: string | null;
  },
  opts: { trigger: "schedule" | "manual" },
): Promise<{ runId: number; sessionId: string }> {
  // 派发过程中要留在徽章上的说明（如「回退成新开会话了」）。
  // 成功路径默认把 last_error 清空，会把同一次调用里刚写下的说明一起抹掉 ——
  // 所以统一走这个变量，成功时写它而不是 null。
  let dispatchNote: string | null = null;

  // 定时发送到已有对话：不新开会话，把 prompt 当一条消息投进那个对话。
  // 会话多半已经因为用量耗尽而结束 —— resumeSession 把盘里的会话接回执行器
  // （cli_ref 续命），接回来后再发，agent 在原上下文里接着干。
  if (a.dispatchTarget === "existing_session") {
    const targetId = resolveSendTarget(a);
    if (targetId !== null) {
      const runId = store.startAutomationRun(a.id, targetId, opts.trigger);
      try {
        host.resumeSession(asSessionId(targetId));
        // origin="automation"：这条用户消息是定时任务代发的 —— 时间线气泡上的
        // 「定时」徽标与账本回放都凭这个字段点亮（docs/23）
        host.sendMessage(asSessionId(targetId), a.prompt, undefined, undefined, "automation");
        // 投递成功只回填 sessionId，status 留在 running —— 终态由 session.ended 回灌
        const ended = store.getSession(targetId);
        const endedFailed = ended !== undefined && ended.endedAt !== null && ended.status === "failed";
        if (ended !== undefined && ended.endedAt !== null) {
          store.finishAutomationRun(runId, endedFailed ? "failed" : "done", `ended: ${ended.status}`);
        } else {
          automationRunBySession.set(targetId, { runId, automationId: a.id });
        }
        if (endedFailed) store.setAutomationError(a.id, `ended: ${ended!.status}`, Date.now());
        else store.setAutomationError(a.id, null, null);
        // 对话页形态：把收件对话拉到聊天页前台（launchMode=chat 才拉，headless 只投不打扰）
        if (a.launchMode === "chat") broadcastForeground(targetId, a.unitId, a.runtimeId, "automation", a.name);
        log.info("automation message sent to existing session", { automationId: a.id, runId, sessionId: targetId, trigger: opts.trigger });
        return { runId, sessionId: targetId };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        store.finishAutomationRun(runId, "failed", message);
        store.setAutomationError(a.id, message, Date.now());
        throw err;
      }
    }
    // 接不回任何老会话：记一笔再退回新开会话，别让这条续跑静默消失
    log.warn("existing-session automation found no resumable target, falling back to new session", { automationId: a.id });
    dispatchNote = "找不到可续接的对话，已改为新开会话";
  }

  // TUI 模式：到点在前端 PTY 里拉起执行器本尊的终端界面（yolo 免审批），
  // 人可看、可插手、可补充信息。不走 host —— 没有会话台账与事件流，
  // 运行记录的终态由终端 exit 帧回灌（autoExit：CLI 退 → shell 退 → exit 帧）。
  if (a.launchMode === "terminal") {
    const runId = store.startAutomationRun(a.id, null, opts.trigger);
    try {
      const terminalId = await launchExecutorTerminal({
        runtimeId: a.runtimeId,
        unitId: a.unitId,
        rootPath: a.rootPath,
        prompt: a.prompt,
      });
      store.setAutomationRunSession(runId, terminalId);
      automationRunByTerminal.set(terminalId, { runId, automationId: a.id });
      store.setAutomationError(a.id, dispatchNote, dispatchNote === null ? null : Date.now());
      log.info("automation terminal launched", { automationId: a.id, runId, terminalId, trigger: opts.trigger });
      return { runId, sessionId: terminalId };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      store.finishAutomationRun(runId, "failed", message);
      store.setAutomationError(a.id, message, Date.now());
      throw err;
    }
  }

  const runId = store.startAutomationRun(a.id, null, opts.trigger);
  try {
    const session = await host.startSession({
      runtimeId: a.runtimeId,
      unitId: asUnitId(a.unitId),
      unitName: a.unitName,
      rootPath: a.rootPath,
      prompt: a.prompt,
      model: a.model === null ? null : asModelId(a.model),
      mode: (a.mode as "plan" | "build" | "edit" | "yolo" | undefined) ?? undefined,
      // 标明 headless 来源：权限闸据此【完全放行】，否则遇审批请求永远挂起
      source: "automation",
    });
    // 派发成功只回填 sessionId，status 留在 running —— 终态由 session.ended 回灌；
    // 旧写法 start 后立刻写 done，会话真失败前界面上一直显示「已完成」。
    store.setAutomationRunSession(runId, session.id);
    // mockperm 这类快执行器，会话可能在 startSession 的 promise 落定**之前**就已 ended
    // （几十毫秒答完是常态）：终态广播跑在登记前面，回灌永远等不到。已终态就当场收口。
    // 判据用 endedAt 而不是 status —— status="failed" 也可能是轮次失败而会话仍开着。
    const ended = store.getSession(session.id);
    const endedFailed = ended !== undefined && ended.endedAt !== null && ended.status === "failed";
    if (ended !== undefined && ended.endedAt !== null) {
      store.finishAutomationRun(runId, endedFailed ? "failed" : "done", `ended: ${ended.status}`);
    } else {
      automationRunBySession.set(session.id, { runId, automationId: a.id });
    }
    // 失败徽章：这次派发以失败告终就挂上；否则清掉（上一次的失败由这次成功翻篇）
    // —— 但 dispatchNote（回退说明）要留下，它不是失败徽章，别被当成旧账清掉
    if (endedFailed) store.setAutomationError(a.id, `ended: ${ended!.status}`, Date.now());
    else store.setAutomationError(a.id, dispatchNote, dispatchNote === null ? null : Date.now());
    // 对话页形态：会话已开好，把前端拉到它的聊天时间线（已秒完的会话也拉——
    // 打开即回看结果，同样是前台语义）
    if (a.launchMode === "chat") broadcastForeground(String(session.id), a.unitId, a.runtimeId, "automation", a.name);
    log.info("automation session launched", { automationId: a.id, runId, sessionId: session.id, trigger: opts.trigger });
    return { runId, sessionId: session.id };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    store.finishAutomationRun(runId, "failed", message);
    store.setAutomationError(a.id, message, Date.now());
    throw err;
  }
}

const scheduler = new AutomationScheduler(store, runAutomation);

/**
 * 重启自愈 —— 「sessionId → 运行记录」的回灌映射在内存里，daemon 重启即丢。
 * 不做这一遍：上一次运行周期里 status=running 的运行记录永远停在 running
 * （卡片假「运行中」），还活着的会话结束时也等不到结算。
 * 按会话台账逐条收口：已结束 → 按其状态落终态；记录缺失 → failed；仍活着 → 重新挂回。
 */
function healAutomationRuns(): void {
  let settled = 0;
  let reattached = 0;
  for (const a of store.listAutomations()) {
    for (const r of store.listAutomationRuns(a.id, 200)) {
      if (r.status !== "running") continue;
      if (r.sessionId === null) {
        // 派发在 startSession 完成前中断：会话从未存在
        store.finishAutomationRun(r.id, "failed", "daemon 重启前未完成派发");
        settled++;
        continue;
      }
      // TUI 模式：sessionId 列存的是 autoterm_ 前缀的终端 id。PTY 随 daemon 进程
      // 一起死了（ConPTY 是子进程），重启后不可能还活着 —— 直接按中断收口。
      if (r.sessionId.startsWith("autoterm_")) {
        store.finishAutomationRun(r.id, "failed", "daemon 重启，终端已随进程关闭");
        settled++;
        continue;
      }
      const s = store.getSession(r.sessionId);
      if (s === undefined) {
        store.finishAutomationRun(r.id, "failed", "daemon 重启后会话记录缺失");
        settled++;
        continue;
      }
      if (s.endedAt !== null) {
        const failed = s.status === "failed";
        store.finishAutomationRun(r.id, failed ? "failed" : "done", `ended: ${s.status}`);
        if (failed) store.setAutomationError(a.id, `ended: ${s.status}`, s.endedAt);
        settled++;
        continue;
      }
      // 会话还活着（loadPersisted 已把它装回台账）：重新挂回终态回灌
      automationRunBySession.set(r.sessionId, { runId: r.id, automationId: a.id });
      reattached++;
    }
  }
  if (settled > 0 || reattached > 0) log.info("automation runs healed after restart", { settled, reattached });
}

healAutomationRuns();
// 手动派发终端的自愈：PTY 随 daemon 一起死，running 行全部按中断收口
{
  let n = 0;
  for (const r of store.listRunningTerminalRuns()) {
    store.finishTerminalRun(r.terminalId, "failed", "daemon 重启，终端已随进程关闭");
    n++;
  }
  if (n > 0) log.info("terminal runs healed after restart", { settled: n });
}
scheduler.start();

// 用量耗尽自动续跑：订阅执行器的窗口打满时自动排一条一次性自动化，
// 到点往撞墙的那个对话里发一句「继续」。排出来的东西就是普通 automation，
// 所以卡片、停用、手动触发全都是现成的。
// 探针自带 5 分钟 TTL 缓存，这里只消费缓存读数，不额外起子进程。
const quotaResumeWatcher = new QuotaResumeWatcher({
  store,
  probe: new QuotaProbe(config.homeDir),
  getConfig: () => getBacklogConfig(store),
});
quotaResumeWatcher.start();

// 凭证保险库（Credential Vault）：管理微信等扫码产生的动态敏感令牌
const credentialVault = new CredentialVault(config.homeDir);

// 渠道网关（docs/08 WP-8）：bot 的 IM 入站通道。
//
// ⚠ 2026-10-02：Telegram 从「启动时无条件 start 的全局单例」改成 reconciler。
// 旧写法的问题是渠道状态与 bot.json 无关——用户在设置页改完渠道保存，daemon 里的
// 连接纹丝不动，必须重启才生效。现在各网关都定期比对盘上定义与在跑实例。
// apiBase 可指向 mock（冒烟）。
const telegramGateway = new TelegramGateway({
  apiBase: process.env["AGENT_WORKBENCH_TELEGRAM_API"] ?? "https://api.telegram.org",
  registry: botRegistry,
  host,
  vault: credentialVault,
  pollMs: 2000,
});
telegramGateway.start();

// 微信：腾讯官方 iLink Bot 协议长连接
const weixinGateway = new WeixinGateway({
  registry: botRegistry,
  host,
  vault: credentialVault,
  pollMs: 3000,
});
weixinGateway.start();

// Discord：官方 WebSocket Gateway v10 + REST 原生轻量接入
const discordGateway = new DiscordGateway({
  registry: botRegistry,
  host,
  vault: credentialVault,
  pollMs: 5000,
});
discordGateway.start();

// 飞书：每 bot 一个飞书机器人（一个飞书应用 = 一个账号 = 一个 bot 身份）。
// 入站拦截器：配置的确认会话里发「确认/拒绝 <待办id>」直接落到待办引擎（v1 关键词口径），
// 其余消息照常进 bot 轮次；引擎不在（启动早期）按未消费放行。
const feishuGateway = new FeishuGateway({
  registry: botRegistry,
  host,
  reconcileMs: 15_000,
  inboundHook: async (text, chatId) => {
    const cfg = getBacklogConfig(store);
    if (!cfg.feishu.enabled || cfg.feishu.receiveId === "" || chatId !== cfg.feishu.receiveId) return false;
    try {
      return await (backlogEngine?.handleInboundText(text) ?? false);
    } catch {
      return false;
    }
  },
});
feishuGateway.start();

// ---- 记忆编排（Phase 7）-----------------------------------------------------

const memory = new MemoryService(store, config.homeDir);

// ---- 公网穿透管理器 ---------------------------------------------------------
let tunnelManager: TunnelManager;

// ---- REST 管理面（权限闸的决策入口，docs/07 §六）----------------------------

const httpRoutes: HttpRoute[] = [
  // HTTP-RPC 桥（docs/21 D2）：WS 注册表的第二扇门——同信封、同鉴权、同错误语义，
  // curl / shell / 任意执行器直达全部方法。传输层错误（401 鉴权 / 404 路由 / 413 超限 /
  // 400 坏信封）用状态码；RPC 层错误一律 200 + ok:false（JSON-RPC over HTTP 惯例）。
  {
    method: "POST",
    path: "/rpc",
    handle: async ({ body }) => {
      const f = body as { v?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
      if (f === null || typeof f !== "object" || f.v !== WIRE_VERSION || typeof f.method !== "string") {
        throw Object.assign(new Error(`expected { v:${WIRE_VERSION}, method:string, params? }`), { code: "bad_request" });
      }
      const outcome = await dispatchRpc(f.method, f.params);
      return typeof f.id === "string" ? { ...outcome, id: f.id } : outcome;
    },
  },
  // 回环自动取 token（WP-7）：本机前端免配置；非回环走不到路由层（authorize 401）
  {
    method: "GET",
    path: "/bootstrap",
    handle: ({ remoteAddress }) => {
      if (!isLoopbackAddr(remoteAddress)) {
        throw Object.assign(new Error("bootstrap only from loopback"), { code: "forbidden" });
      }
      return { token: config.token, home: config.homeDir };
    },
  },
  // per-bot 入站 webhook（WP-9）：鉴权走 bot 自己的 secret（全局 token 豁免此路径）
  {
    method: "POST",
    path: "/webhook/bot",
    handle: async ({ body }) => {
      const p = (body ?? {}) as { botId?: string; secret?: string; text?: string; waitMs?: number };
      if (typeof p.botId !== "string" || typeof p.text !== "string") {
        throw Object.assign(new Error("botId and text are required"), { code: "bad_params" });
      }
      const bot = await botRegistry.getBot(p.botId);
      if (bot === undefined) throw Object.assign(new Error(`no such bot: ${p.botId}`), { code: "unknown_bot" });
      const hook = (bot.channels as Array<{ kind?: string; enabled?: boolean; config?: Record<string, string> } | undefined>)
        ?.find((c) => c?.kind === "webhook");
      if (hook === undefined || hook.enabled !== true) {
        throw Object.assign(new Error(`bot ${p.botId} has no webhook channel`), { code: "no_channel" });
      }
      const secret = hook.config?.["secret"] ?? "";
      // 评审 P3：常量时间比较（hash 后等长比较），防 LAN 侧信道；secret 是唯一门槛
      // （通过即等同在 bot 工作目录 yolo 执行）
      const provided = createHash("sha256").update(p.secret ?? "").digest();
      const expected = createHash("sha256").update(secret).digest();
      if (secret === "" || !timingSafeEqual(provided, expected)) {
        throw Object.assign(new Error("bad secret"), { code: "forbidden" });
      }
      // 评审 P3：waitMs 默认 60s、上限 120s——慢轮次不该无限占住 HTTP 连接
      const rawWait = typeof p.waitMs === "number" ? p.waitMs : 60_000;
      const waitMs = Math.min(Math.max(rawWait, 1_000), 120_000);
      const { sessionId, reply } = await askBot(botRegistry, host, p.botId, p.text, { waitMs, source: "webhook" });
      return { sessionId, reply };
    },
  },
  {
    method: "GET",
    path: "/api/permissions/rules",
    handle: () => ({ rules: gate.listRules() }),
  },
  {
    method: "POST",
    path: "/api/permissions/rules",
    handle: ({ body }) => {
      const p = (body ?? {}) as { runtimeId?: string; kind?: string; pattern?: string; decision?: string };
      if (typeof p.pattern !== "string" || (p.decision !== "allow" && p.decision !== "deny")) {
        throw Object.assign(new Error("pattern and decision(allow|deny) are required"), { code: "bad_params" });
      }
      return { id: gate.addRule({ runtimeId: p.runtimeId ?? null, kind: p.kind ?? null, pattern: p.pattern, decision: p.decision }) };
    },
  },
  {
    method: "DELETE",
    path: "/api/permissions/rules",
    handle: ({ url }) => {
      const id = Number.parseInt(url.searchParams.get("id") ?? "", 10);
      if (!Number.isFinite(id)) throw Object.assign(new Error("id query param is required"), { code: "bad_params" });
      return { deleted: gate.deleteRule(id) };
    },
  },
  {
    method: "POST",
    path: "/api/permissions/resolve",
    handle: ({ body }) => {
      const p = (body ?? {}) as { sessionId?: string; requestId?: string; decision?: string };
      if (typeof p.sessionId !== "string" || typeof p.requestId !== "string" ||
          (p.decision !== "allow" && p.decision !== "deny" && p.decision !== "always")) {
        throw Object.assign(new Error("sessionId, requestId, decision(allow|deny|always) are required"), { code: "bad_params" });
      }
      return host.resolvePermission(asSessionId(p.sessionId), p.requestId, p.decision).then(() => ({ resolved: true }));
    },
  },
  {
    method: "POST",
    path: "/api/workspaces/open-folder",
    handle: async ({ body }) => {
      const p = (body ?? {}) as { path?: string; botId?: string };
      let targetPath = p.path;
      if (!targetPath && p.botId) {
        const b = await botRegistry.getBot(p.botId);
        if (b) targetPath = b.rootPath;
      }
      if (!targetPath || typeof targetPath !== "string") {
        throw Object.assign(new Error("path or botId is required"), { code: "bad_params" });
      }
      return launchFileManager(targetPath);
    },
  },
  {
    method: "GET",
    path: "/api/network/interfaces",
    handle: () => ({ ok: true, interfaces: getNetworkInterfaces() }),
  },
  {
    method: "POST",
    path: "/api/channels/weixin/qr/begin",
    handle: () => beginWeixinLogin(),
  },
  {
    method: "POST",
    path: "/api/channels/weixin/qr/poll",
    handle: async ({ body }) => {
      const p = (body ?? {}) as { qrCode?: string; botId?: string };
      if (!p.qrCode) throw Object.assign(new Error("qrCode is required"), { code: "bad_params" });
      const result = await pollWeixinLogin(p.qrCode);
      if (result.status === "success" && p.botId) {
        await credentialVault.save(`weixin:${p.botId}`, result.botToken, {
          botId: p.botId,
          ilinkBotId: result.botId,
        });
      }
      return result;
    },
  },
  {
    method: "GET",
    path: "/api/tunnel/status",
    handle: () => tunnelManager.getState(),
  },
  {
    method: "POST",
    path: "/api/tunnel/start",
    handle: async ({ body }) => tunnelManager.start(body as never),
  },
  {
    method: "POST",
    path: "/api/tunnel/stop",
    handle: () => tunnelManager.stop(),
  },
];

function launchFileManager(targetPath: string): { ok: boolean; path: string } {
  const cleanPath = path.resolve(targetPath);
  try {
    if (!existsSync(cleanPath)) {
      mkdirSync(cleanPath, { recursive: true });
    }
  } catch (err) {
    log.warn("mkdir before launch file manager failed", { err, path: cleanPath });
  }

  const platform = process.platform;
  const winPath = cleanPath.replace(/\//g, "\\");

  /**
   * 起一个脱离父进程的 GUI 启动器。
   * ⚠ 'error' 必须有人接：ChildProcess 上没有 error 监听时，EventEmitter 会把
   * spawn 失败（ENOENT / 权限）抛成**未捕获异常**，直接把 daemon 带下去 ——
   * 用户点一下「在资源管理器中打开」就可能弄死整个后台。
   */
  const launchDetached = (file: string, args: string[], label: string): void => {
    try {
      const p = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        ...(platform === "win32" ? { windowsHide: true } : {}),
      });
      p.on("error", (err) => log.warn(`${label} spawn failed`, { err: err.message, path: cleanPath }));
      p.unref();
    } catch (err) {
      log.warn(`${label} spawn threw`, { err, path: cleanPath });
    }
  };

  if (platform === "win32") {
    // 关键修复：Windows 下不能用 exec('explorer.exe ...')！
    // exec 会捕获并重定向 stdio，explorer.exe 检测到 stdio 被管道捕获时会被 Windows 拒绝创建 GUI 窗口并退出码为 1。
    // 必须用 spawn + detached: true + stdio: "ignore" 并 unref()，脱离父进程管道，
    // 才能让 Windows 桌面 Shell 正确创建并弹出资源管理器窗口。
    try {
      const p = spawn("explorer.exe", [winPath], {
        detached: true,
        stdio: "ignore",
      });
      p.unref();
      p.on("error", (err) => {
        log.warn("explorer.exe direct spawn failed, trying cmd start fallback", { err: err.message, path: winPath });
        launchDetached("cmd.exe", ["/c", "start", "", winPath], "cmd.exe start");
      });
    } catch (err) {
      log.warn("spawn explorer failed, fallback to cmd start", { err, path: winPath });
      launchDetached("cmd.exe", ["/c", "start", "", winPath], "cmd.exe start");
    }
  } else if (platform === "darwin") {
    launchDetached("open", [cleanPath], "open");
  } else {
    launchDetached("xdg-open", [cleanPath], "xdg-open");
  }
  return { ok: true, path: cleanPath };
}

/** 鉴权判定（docs/08 WP-7）：token 开启时全查，豁免 = 回环取 /bootstrap、回环打开文件夹、回环电脑控制 MCP 端点 */
const authorize = (req: IncomingMessage, url: URL): boolean => {
  if (config.token === null) return true;
  if (url.pathname === "/bootstrap") {
    // 评审 P0：跨源网页 fetch 自带 Origin 头且对端是回环——必须连 Origin 一起验
    const origin = req.headers.origin;
    if (origin !== undefined && !isLocalOrigin(origin)) return false;
    return isLoopbackAddr(req.socket.remoteAddress);
  }
  // 本地桌面打开工作区文件夹：仅限回环本地源
  if (url.pathname === "/api/workspaces/open-folder") {
    const origin = req.headers.origin;
    if (origin !== undefined && !isLocalOrigin(origin)) return false;
    if (isLoopbackAddr(req.socket.remoteAddress)) return true;
  }
  // 电脑控制 MCP 端点（docs/14 §3.1）：执行器的 MCP 客户端带不了 x-awb-token，
  // 与 stdio MCP 桥（src/mcp.ts）同级信任——只认回环来源，且 Origin 若存在必须
  // 是本地源（跨源网页的 simple request 不带预检就能打到回环端口；工具层
  // handleHttp 里还有同款检查 + content-type 闸，这里是网络层第一道）
  if (url.pathname === COMPUTER_MCP_PATH) {
    const origin = req.headers.origin;
    if (origin !== undefined && !isLocalOrigin(origin)) return false;
    return isLoopbackAddr(req.socket.remoteAddress);
  }
  if (url.pathname === "/webhook/bot") return true; // per-bot secret 在路由内自验
  const provided = req.headers["x-awb-token"] ?? url.searchParams.get("token");
  return typeof provided === "string" && provided === config.token;
};

// 出图代理（docs 决策：密钥挪进 daemon）：浏览器把请求体交给 daemon，daemon 注入
// Authorization 后转发并透传响应流。这条路由是流式大载荷，走 httpd 的裸路由通道。
const imageProfiles = new ImageProfileStore(config.homeDir);
// 出图任务历史（docs/21 P4c）：daemon 事实源，GUI 经 image.tasks.list 消费
const imageTasks = new ImageTasks(config.homeDir);
await imageTasks.load();

// ---- 浏览器 / 电脑控制（docs/14）------------------------------------------------
// 两个服务都持有 mcpadmin 的写通道（扇出 playwright / workbench-computer 条目）；
// ctrl/store 的上下文要在 startHttp 之后注入（电脑控制条目 url 需要 daemon 实际端口）。
const controlDeps: McpServiceDeps = { configHome: os.homedir(), stateHome: config.homeDir };
setControlContext(config.homeDir, config.port);
const browserControl = createBrowserControlService(controlDeps);
const computerControl = createComputerControl(controlDeps);
// 搜索（bot 级）：密钥与配置在 daemon 侧按 botId 分槽，条目扇出由存活配置驱动
const searchControl = createSearchService({
  ...controlDeps,
  store,
  listBots: () => botRegistry.listBots(),
});
registerAcpEntriesProvider((rootPath) => [
  ...browserControl.acpEntries(),
  ...computerControl.acpEntries(),
  // 搜索按会话工作区给条目（--root 锁定到这个 bot）
  ...searchControl.acpEntries(rootPath),
]);
void browserControl.boot(); // 接管模式已启用 → 自动拉起共享 Chrome（内部自带 catch，不掀翻启动）

const { server, port } = await startHttp(config, startedAt, httpRoutes, authorize, [
  { method: "POST", path: "/api/image/call", handle: handleImageCall(imageProfiles) },
  // 电脑控制的 MCP 端点（Streamable HTTP）：CLI 客户端不会带 x-awb-token，
  // authorize 里按「回环 + 该路径」豁免（与 /bootstrap 同级信任）
  { method: "POST", path: COMPUTER_MCP_PATH, handle: computerControl.handleHttp },
  // 生成图文件的服务面（docs/21 P4c）：只允许 <homeDir>/images 子树（路径穿越闸）；
  // GET 可带 ?token=（<img> 标签设不了头，与 WS 鉴权同款豁口）
  {
    method: "GET",
    path: "/api/image/file",
    handle: async (_req, res, ctx) => {
      const json = (status: number, body: unknown): void => {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload),
          ...(ctx.allowOrigin !== undefined ? { "access-control-allow-origin": ctx.allowOrigin } : {}),
        });
        res.end(payload);
      };
      const raw = ctx.url.searchParams.get("path") ?? "";
      const abs = path.resolve(raw);
      const root = path.resolve(join(config.homeDir, "images"));
      if (raw === "" || (!abs.startsWith(root + path.sep) && abs !== root)) {
        json(403, { ok: false, error: { code: "forbidden", message: "path 不在 images 目录下" } });
        return;
      }
      try {
        const data = await readFile(abs);
        const ext = path.extname(abs).toLowerCase();
        const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
        res.writeHead(200, {
          "content-type": mime,
          "content-length": data.byteLength,
          "cache-control": "no-store",
          ...(ctx.allowOrigin !== undefined ? { "access-control-allow-origin": ctx.allowOrigin } : {}),
        });
        res.end(data);
      } catch {
        json(404, { ok: false, error: { code: "not_found", message: "no such image file" } });
      }
    },
  },
]);
// 实际绑定端口（传 0 时由系统分配）同步给控制层——条目 url / dsh 注入都用它
setControlContext(config.homeDir, port);
// 端口落定后对齐：电脑控制若已启用，重写 12 家条目里的 url（端口变了旧条目就是死链）
void computerControl.boot().catch((e: unknown) => {
  log.error("computer control boot reconcile failed", { error: e instanceof Error ? e.message : String(e) });
});
// 搜索同理对齐：桥脚本把端口烘进内容（hash 变了自动重装），条目按存活配置装/收
void searchControl.boot().catch((e: unknown) => {
  log.error("search service boot reconcile failed", { error: e instanceof Error ? e.message : String(e) });
});
tunnelManager = new TunnelManager(config.homeDir, port);
const wss = attachWs(server, { config, startedAt, authorize });
// 通知推送通道挂进 WS（在此之前到达的事件只记录不推送，历史以 notifications.list 为准）
notifications.setPush((row) => broadcastNotification(wss, row));

// 原生会话源文件监视器：检测外部终端写入并实时推送到工作台对话时间线与侧栏
const nativeWatcher = new NativeSessionWatcher(store, traceSink, () => wss);
nativeWatcher.start();

// 外部会话自动收录：周期扫描各 bot 目录匹配的原生存储，把外部终端跑过、尚未
// 认识的会话自动落为导入行（docs/13 发现层）——「在 bot 目录下任意终端跑 CLI，
// 会话自己出现在侧栏」就是这条链路；bot.json 的 autoCollect=false 可按 bot 关闭
const autoCollector = startNativeAutoCollect({
  store,
  listBots: () => botRegistry.listBots(),
  // 候选列表走 TTL 缓存通道（与 unit.history 行级回溯共享同一次扫描）——
  // 自动收录绝不每轮裸跑 14 家 reader 的同步 fs（loop-stall 实测教训）
  listUnitCandidates: cachedNativeListAll,
  readNativeSession,
  backfillTerminalRefs: backfillUnitTerminalRefs,
  // 运行期落库的导入行必须收编进 host 台账，否则 session.list 缺行、前端打不开
  adoptSession: (sessionId) => {
    host.adoptPersisted(sessionId);
  },
  dropSession: (sessionId) => {
    // 影子行删除：store 行已删，这里摘 host 内存台账（forgetSession 对 store 的
    // 二次删除是幂等空操作；live 行本来就不在清扫范围）
    try {
      host.forgetSession(asSessionId(sessionId));
    } catch {
      /* live/未知都跳过——清扫侧已保证只删 done 行 */
    }
  },
  getWss: () => wss,
});

// ---- 待办 / GTD（backlog）—— 引擎需要 wss 广播，必须在 attachWs 之后构造 ----------

backlogEngine = new BacklogEngine({
  store,
  host,
  homeDir: config.homeDir,
  getConfig: () => getBacklogConfig(store),
  broadcast: (signal: BacklogSignal) => {
    notifications.recordBacklogSignal(signal);
    broadcastBacklog(wss, signal);
  },
  // 待办 launchMode=terminal 的 TUI 派发（与自动化共用 launchExecutorTerminal）
  launchTerminal: (o) => launchExecutorTerminal(o),
  // 待办 launchMode=chat 的前台拉起（与自动化共用 broadcastForeground）
  foreground: (sessionId, unitId, runtimeId, cause, title) => broadcastForeground(sessionId, unitId, runtimeId, cause, title),
  notify: async (text) => {
    const cfg = getBacklogConfig(store);
    if (!cfg.feishu.enabled || cfg.feishu.receiveId === "") return;
    try {
      const r = await feishuGateway.sendTo(cfg.feishu.botId, cfg.feishu.accountId, cfg.feishu.receiveId, text);
      if (!r.ok) log.warn("backlog feishu notify failed", { detail: r.detail });
    } catch (err: unknown) {
      log.warn("backlog feishu notify failed", { error: err instanceof Error ? err.message : String(err) });
    }
  },
  rootsWithUnits: async () => {
    const bots = await botRegistry.listBots();
    return bots
      .filter((b) => typeof b.rootPath === "string" && b.rootPath !== "")
      .map((b) => ({ rootPath: String(b.rootPath), unitId: String(b.id ?? ""), unitName: String(b.name ?? "") }));
  },
  // 心跳 bot 的主绑定（bot 设置页改执行器/模型即生效；backlog 配置显式指定时优先）
  heartbeatBinding: async () => {
    const bot = await botRegistry.getBot(HEARTBEAT_BOT_ID);
    if (bot === undefined) return null;
    const bindings = Array.isArray(bot.bindings) ? (bot.bindings as Array<Record<string, unknown>>) : [];
    const primary = bindings.find((b) => b["primary"] === true) ?? bindings[0];
    if (primary === undefined) return null;
    const runtimeId = String(primary["runtimeId"] ?? "").replace(/^daemon:/, "");
    const modelHint = typeof primary["modelHint"] === "string" ? String(primary["modelHint"]) : null;
    return runtimeId === "" ? null : { runtimeId, model: modelHint };
  },
});
backlogEngine.start();
// dst 启动器已并入 dsh（tuiCommand）：dsh 的 TUI 用 dst shim 拉起
function tuiCommandFor(executorId: string | undefined): string | undefined {
  if (!executorId) return executorId;
  const isYolo = executorId.endsWith(":yolo");
  const baseId = isYolo ? executorId.slice(0, -5) : executorId;
  try {
    const tui = host.getAdapter(baseId).tuiCommand ?? baseId;
    return isYolo ? `${tui}:yolo` : tui;
  } catch {
    return executorId; // 未注册的 executorId 原样传，由 terminals 兜底
  }
}

registerMethod("terminal.create", (params) => {
  const p = (params ?? {}) as {
    terminalId?: string;
    cwd?: string;
    shell?: string;
    command?: string;
    args?: readonly string[];
    executorId?: string;
    unitId?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  };
  return terminals.create({
    terminalId: p.terminalId,
    cwd: p.cwd,
    shell: p.shell,
    command: p.command,
    args: p.args,
    executorId: tuiCommandFor(p.executorId),
    unitId: typeof p.unitId === "string" && p.unitId !== "" ? p.unitId : undefined,
    cols: p.cols,
    rows: p.rows,
    env: p.env,
  });
});
/**
 * 手动派发终端 —— 经派发系统打开前台 TUI（与终端面板手动开的区别：
 * 登记 terminal_runs 运行记录，进该 bot 的 unit.history 时间轴，
 * 标签带「派发」徽章）。不带 prompt，人在 TUI 里自己敲。
 */
registerMethod("terminal.dispatch", (params) => {
  const p = (params ?? {}) as { unitId?: string; unitName?: string; rootPath?: string; runtimeId?: string; args?: unknown; resumeRef?: unknown };
  if (typeof p.unitId !== "string" || p.unitId === "" || typeof p.rootPath !== "string" || p.rootPath === "" ||
      typeof p.runtimeId !== "string" || p.runtimeId === "") {
    throw Object.assign(new Error("unitId, rootPath, runtimeId are required"), { code: "bad_params" });
  }
  if (p.args !== undefined && (!Array.isArray(p.args) || p.args.some((a) => typeof a !== "string"))) {
    throw Object.assign(new Error("args must be string[]"), { code: "bad_params" });
  }
  // 属性收窄进不了异步闭包，先落局部常量
  const unitId = p.unitId;
  const unitName = p.unitName ?? unitId;
  const rootPath = p.rootPath;
  const runtimeId = p.runtimeId.replace(/^daemon:/, "");
  const args = Array.isArray(p.args) ? (p.args as string[]) : undefined;
  // 带 --resume/--session 派发时把原生会话引用一并落库：重启后这条运行仍可
  // 「回到它」——否则每次重启后的重开都产生一条没有 ref 的新行，链就断了
  const resumeRef = typeof p.resumeRef === "string" && p.resumeRef !== "" ? p.resumeRef : null;
  return (async () => {
    const terminalId = await launchExecutorTerminal({ runtimeId, unitId, rootPath, args });
    // 同一场原生会话的再次打开是「继续」不是「新记录」：重挂既有行（点同一行
    // N 次不该多出 N 条手动会话）；全新会话才 INSERT
    const existing = resumeRef !== null ? store.latestTerminalRunByResume(runtimeId, resumeRef) : undefined;
    const runId =
      existing !== undefined
        ? (store.reattachTerminalRun(existing.id, terminalId), existing.id)
        : store.startTerminalRun({ terminalId, unitId, unitName, runtimeId, resumeRef });
    log.info("terminal dispatched manually", { terminalId, runId, unitId, runtimeId, args, reattached: existing !== undefined });
    return { terminalId, runId };
  })();
});
registerMethod("terminal.input", (params) => {
  const p = (params ?? {}) as { terminalId?: string; data?: string };
  if (typeof p.terminalId !== "string" || typeof p.data !== "string") {
    throw Object.assign(new Error("terminalId and data are required"), { code: "bad_params" });
  }
  terminals.write(p.terminalId, p.data);
  return { written: true };
});
registerMethod("terminal.resize", (params) => {
  const p = (params ?? {}) as { terminalId?: string; cols?: number; rows?: number };
  if (typeof p.terminalId !== "string" || typeof p.cols !== "number" || typeof p.rows !== "number") {
    throw Object.assign(new Error("terminalId, cols, rows are required"), { code: "bad_params" });
  }
  terminals.resize(p.terminalId, p.cols, p.rows);
  return { resized: true };
});
registerMethod("terminal.kill", (params) => {
  const p = (params ?? {}) as { terminalId?: string };
  if (typeof p.terminalId !== "string") throw Object.assign(new Error("terminalId is required"), { code: "bad_params" });
  terminals.kill(p.terminalId);
  return { killed: true };
});
registerMethod("terminal.list", () => terminals.list());
registerMethod("terminal.transcript", (params) => {
  const p = (params ?? {}) as { terminalId?: string };
  if (typeof p.terminalId !== "string" || p.terminalId === "") {
    throw Object.assign(new Error("terminalId is required"), { code: "bad_params" });
  }
  const text = store.getTerminalTranscript(p.terminalId);
  return { terminalId: p.terminalId, text };
});

// ---- 自动化方法（Phase 5 v2）-------------------------------------------------

const badAutomation = (message: string): Error => Object.assign(new Error(message), { code: "bad_params" });

/** scheduleRule 入参校验：共享引擎的规则对象落库前把范围钉死 */
function parseScheduleRule(raw: unknown): ScheduleRule {
  if (raw === null || typeof raw !== "object") throw badAutomation("scheduleRule must be an object");
  const r = raw as Record<string, unknown>;
  const frequency = r["frequency"];
  if (frequency !== "hourly" && frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly" && frequency !== "custom") {
    throw badAutomation(`bad scheduleRule.frequency: ${String(frequency)}`);
  }
  const int = (key: string, min: number, max: number, fallback?: number): number => {
    const v = r[key];
    if (v === undefined || v === null) {
      if (fallback !== undefined) return fallback;
      throw badAutomation(`scheduleRule.${key} is required`);
    }
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) throw badAutomation(`scheduleRule.${key} out of range (${min}..${max})`);
    return n;
  };
  const weekdays = (
    Array.isArray(r["weekdays"])
      ? (r["weekdays"] as unknown[]).map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : []
  ) as ScheduleRule["weekdays"];
  const unit = r["unit"];
  const unitOk =
    frequency === "custom" &&
    (unit === "minutes" || unit === "hours" || unit === "days" || unit === "weeks" || unit === "months");
  const rule: ScheduleRule = {
    frequency,
    hour: int("hour", 0, 23, 0),
    minute: int("minute", 0, 59, 0),
    weekdays,
    dayOfMonth: int("dayOfMonth", 1, 31, 1),
    // 上限与 delayMinutes 对齐（525600 分钟 = 1 年）：delayMinutes 路径产出的规则
    // 会被原样回传校验，上限不一致时「编辑一个大间隔一次性任务」会莫名保存失败
    ...(frequency === "custom" ? { interval: int("interval", 1, 525_600, 1) } : {}),
    ...(unitOk ? { unit: unit as "minutes" | "hours" | "days" | "weeks" | "months" } : {}),
    ...(typeof r["anchorAt"] === "number" && Number.isFinite(r["anchorAt"]) ? { anchorAt: r["anchorAt"] as number } : {}),
    // 绝对时刻必须原样透传：编辑时表单会把整条规则回传，漏掉这个字段
    // 等于把「10-20 15:09 只跑一次」悄悄降级成「每天 15:09」
    ...(typeof r["runAt"] === "number" && Number.isFinite(r["runAt"]) ? { runAt: r["runAt"] as number } : {}),
  };
  return rule;
}

/**
 * 创建/更新共用的调度入参归一，**四选一**（对齐 ZCode 的 contract）：
 *   delayMinutes ——「N 分钟后」一次性（相对表达以 daemon 时钟为锚，不信客户端换算）
 *   runAt        ——「2026-10-20 15:09 只跑一次」绝对时刻（同样以 daemon 时钟判定过期）
 *   scheduleRule —— 权威规则（anchorAt 缺省 = 现在，即「改频率即重新锚定」）
 *   cron         —— 纯 cron 兼容（调度走 cronNextAt；cron 的整点语义只有它自己算得准）
 */
function resolveSchedule(p: {
  cron?: unknown;
  scheduleRule?: unknown;
  delayMinutes?: unknown;
  runAt?: unknown;
}): { cron: string; rule: ScheduleRule | null; nextRunAt: number | null } {
  if (typeof p.delayMinutes === "number") {
    if (!Number.isFinite(p.delayMinutes) || p.delayMinutes < 1 || p.delayMinutes > 525_600) {
      throw badAutomation("delayMinutes must be 1..525600");
    }
    const rule = buildRelativeDelaySchedule(p.delayMinutes);
    return { cron: scheduleRuleToCron(rule), rule, nextRunAt: computeScheduleNextRunAt(rule) };
  }
  // 绝对时刻：过期/不合法直接拒，不静默顺延 —— 「静默改成明天同一时刻」
  // 是最坏的失败形态（用户以为今天会跑，结果明天才跑）
  if (p.runAt !== undefined && p.runAt !== null) {
    if (typeof p.runAt !== "number" || !Number.isFinite(p.runAt)) {
      throw badAutomation("runAt must be a number (epoch ms)");
    }
    // 与 delayMinutes 的互斥同理：runAt 与 scheduleRule/cron 同给时谁优先都是猜，
    // 静默取 runAt 会把另一半参数丢得无声无息 —— 直接拒
    if ((p.scheduleRule !== undefined && p.scheduleRule !== null) || (typeof p.cron === "string" && p.cron.trim() !== "")) {
      throw badAutomation("runAt 与 scheduleRule/cron 只能给一个");
    }
    const now = Date.now();
    if (p.runAt <= now) throw badAutomation("runAt 已经是过去时间了");
    if (p.runAt > now + 365 * 86_400_000) throw badAutomation("runAt 超过一年后，自动化不支持");
    const rule = buildAbsoluteSchedule(p.runAt);
    return { cron: scheduleRuleToCron(rule), rule, nextRunAt: p.runAt };
  }
  if (p.scheduleRule !== undefined && p.scheduleRule !== null) {
    const parsed = parseScheduleRule(p.scheduleRule);
    // 带 runAt 的规则不再补 anchorAt：那会把「确切落点」和「从某刻起推」
    // 两套语义混在一条规则里，之后谁读谁懵
    const rule: ScheduleRule =
      parsed.runAt !== undefined ? parsed : parsed.anchorAt === undefined ? { ...parsed, anchorAt: Date.now() } : parsed;
    return { cron: scheduleRuleToCron(rule), rule, nextRunAt: computeScheduleNextRunAt(rule) };
  }
  if (typeof p.cron === "string" && p.cron.trim() !== "") {
    parseCron(p.cron); // 坏表达式在创建时就拒，不等 tick 才发现
    return { cron: p.cron, rule: null, nextRunAt: cronNextAt(p.cron) };
  }
  throw badAutomation("需要 cron / scheduleRule / delayMinutes 之一");
}

registerMethod("automation.create", (params) => {
  const p = (params ?? {}) as {
    unitId?: string; unitName?: string; name?: string; runtimeId?: string; rootPath?: string;
    prompt?: string; model?: string; mode?: string;
    cron?: string; scheduleRule?: unknown; delayMinutes?: number; runAt?: number | null;
    recurring?: boolean; maxRuns?: number;
    launchMode?: string;
    dispatchTarget?: string;
    targetSessionId?: string | null;
  };
  if (typeof p.unitId !== "string" || typeof p.runtimeId !== "string" ||
      typeof p.rootPath !== "string" || typeof p.prompt !== "string") {
    throw badAutomation("unitId, runtimeId, rootPath, prompt are required");
  }
  // 创建上限（默认 20，用户可在自动化页改）：agent 能经 aw CLI 自建定时任务，
  // 没有上限就是递归滥建的下限 —— 到上限就让人工清理再建，或调高上限。
  // 只数用户自建任务：quota_resume 自动排的一次性续跑不占额度（它们有独立的
  // 保留策略 —— QuotaResumeWatcher 每跳清理已完结行，每执行器只留最近 5 条）。
  // 不拆开的话，频繁撞用量墙的执行器每个窗口都永久占一行，额度很快耗尽
  const createLimit = getAutomationCreateLimit(store);
  if (store.listAutomations().filter((a) => a.origin !== "quota_resume").length >= createLimit) {
    throw Object.assign(
      new Error(`定时任务已达上限（${createLimit} 条，不含自动排的用量续跑）—— 删掉不需要的再建，或在自动化页调高上限`),
      { code: "automation_limit_reached" },
    );
  }
  if (p.dispatchTarget !== undefined && p.dispatchTarget !== "new_session" && p.dispatchTarget !== "existing_session") {
    throw badAutomation("dispatchTarget 只能是 new_session 或 existing_session");
  }
  // runAt 与 delayMinutes 同为一次性表达，不能同时给（谁优先都是猜）
  if (typeof p.runAt === "number" && typeof p.delayMinutes === "number") {
    throw badAutomation("runAt 与 delayMinutes 只能给一个");
  }
  if (p.launchMode !== undefined && p.launchMode !== "terminal" && p.launchMode !== "chat" && p.launchMode !== "headless") {
    throw badAutomation("launchMode 只能是 terminal、chat 或 headless");
  }
  // 绝对时刻与相对延迟同属「一次性」表达：调度/次数口径必须一致，
  // 否则 runAt 建出来的任务会被当成循环任务，一到点就永远跑下去
  const oneShot = typeof p.delayMinutes === "number" || typeof p.runAt === "number";
  if (oneShot && p.recurring === true) {
    throw badAutomation("一次性任务（delayMinutes / runAt）不能配 recurring=true");
  }
  if (typeof p.delayMinutes === "number" && typeof p.maxRuns === "number") {
    throw badAutomation("delayMinutes 是一次性任务，不能配 maxRuns（跑一次即停）");
  }
  if (typeof p.runAt === "number" && typeof p.maxRuns === "number") {
    throw badAutomation("runAt 是一次性任务，不能配 maxRuns（跑一次即停）");
  }
  if (typeof p.maxRuns === "number" && (!Number.isFinite(p.maxRuns) || p.maxRuns < 1 || p.maxRuns > 10_000)) {
    throw badAutomation("maxRuns 必须是 1..10000");
  }
  const { cron, rule, nextRunAt } = resolveSchedule(p);
  if (nextRunAt === null) throw badAutomation("当前规则推不出任何未来的触发时间");
  // recurring 缺省 = 循环；显式 false 且未给 maxRuns = 一次性（跑一次收口，ZCode 同口径）。
  // delayMinutes 本质是一次性的相对表达，强制 recurring=false —— 否则它会按间隔永远跑下去。
  const recurring = oneShot ? false : p.recurring !== false;
  const maxRuns = typeof p.maxRuns === "number" ? p.maxRuns : (recurring ? null : 1);
  const unitName = p.unitName ?? p.unitId;
  const id = store.createAutomation({
    unitId: p.unitId,
    unitName,
    name: p.name ?? unitName,
    runtimeId: p.runtimeId,
    rootPath: p.rootPath,
    prompt: p.prompt,
    model: typeof p.model === "string" ? p.model : null,
    mode: typeof p.mode === "string" ? p.mode : null,
    cron,
    scheduleRule: rule,
    recurring,
    maxRuns,
    nextRunAt,
    launchMode: p.launchMode === "headless" || p.launchMode === "chat" ? p.launchMode : "terminal",
    // 定时发送到已有对话：目标会话可以留空 —— 发火时按执行器最近一个可 resume 的会话回退
    dispatchTarget: p.dispatchTarget === "existing_session" ? "existing_session" : "new_session",
    targetSessionId: typeof p.targetSessionId === "string" && p.targetSessionId !== "" ? p.targetSessionId : null,
  });
  return { id, nextRunAt };
});

registerMethod("automation.update", (params) => {
  const p = (params ?? {}) as {
    id?: number; name?: string; prompt?: string; model?: string | null; mode?: string | null;
    unitId?: string; unitName?: string; runtimeId?: string; rootPath?: string;
    cron?: string; scheduleRule?: unknown; delayMinutes?: number;
    recurring?: boolean; maxRuns?: number | null;
    launchMode?: string;
    dispatchTarget?: string;
    targetSessionId?: string | null;
    runAt?: number | null;
  };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  if (p.launchMode !== undefined && p.launchMode !== "terminal" && p.launchMode !== "chat" && p.launchMode !== "headless") {
    throw badAutomation("launchMode 只能是 terminal、chat 或 headless");
  }
  if (p.dispatchTarget !== undefined && p.dispatchTarget !== "new_session" && p.dispatchTarget !== "existing_session") {
    throw badAutomation("dispatchTarget 只能是 new_session 或 existing_session");
  }
  const hit = store.getAutomation(p.id);
  if (hit === undefined) throw Object.assign(new Error(`no such automation: ${p.id}`), { code: "unknown_automation" });
  const prev = hit.automation;

  const patch: Partial<Parameters<Store["updateAutomation"]>[1]> = {};
  if (typeof p.name === "string") patch.name = p.name;
  if (p.launchMode === "terminal" || p.launchMode === "chat" || p.launchMode === "headless") patch.launchMode = p.launchMode;
  if (typeof p.prompt === "string") patch.prompt = p.prompt;
  if (p.model !== undefined) patch.model = typeof p.model === "string" ? p.model : null;
  if (p.mode !== undefined) patch.mode = typeof p.mode === "string" ? p.mode : null;
  if (typeof p.unitId === "string") patch.unitId = p.unitId;
  if (typeof p.unitName === "string") patch.unitName = p.unitName;
  if (typeof p.runtimeId === "string") patch.runtimeId = p.runtimeId;
  if (typeof p.rootPath === "string") patch.rootPath = p.rootPath;
  if (p.dispatchTarget === "new_session" || p.dispatchTarget === "existing_session") patch.dispatchTarget = p.dispatchTarget;
  if (p.targetSessionId !== undefined) {
    patch.targetSessionId = typeof p.targetSessionId === "string" && p.targetSessionId !== "" ? p.targetSessionId : null;
  }

  if (typeof p.delayMinutes === "number" && p.recurring === true) {
    throw badAutomation("delayMinutes 是一次性任务，不能配 recurring=true");
  }
  if (typeof p.runAt === "number" && p.recurring === true) {
    throw badAutomation("runAt 是一次性任务，不能配 recurring=true");
  }
  if (typeof p.runAt === "number" && typeof p.delayMinutes === "number") {
    throw badAutomation("runAt 与 delayMinutes 只能给一个");
  }
  if (typeof p.runAt === "number" && typeof p.maxRuns === "number") {
    throw badAutomation("runAt 是一次性任务，不能配 maxRuns（跑一次即停）");
  }
  if (p.maxRuns !== undefined && p.maxRuns !== null &&
      (!Number.isFinite(p.maxRuns) || p.maxRuns < 1 || p.maxRuns > 10_000)) {
    throw badAutomation("maxRuns 必须是 1..10000（null = 不限次数）");
  }
  // 次数口径：recurring=false 而 maxRuns 未给 → 补成 1（一次性）。
  // delayMinutes 本质是一次性的相对表达 —— 必须连 recurring 一起强制收口，
  // 否则「只改提示词」的一次性任务保存完就悄悄变成永久循环。
  const delay = typeof p.delayMinutes === "number";
  const absolute = typeof p.runAt === "number";
  const wantsRuns = p.recurring !== undefined || p.maxRuns !== undefined || delay || absolute;
  const recurring = delay || absolute ? false : (p.recurring ?? prev.recurring);
  // 切到一次性表达（delay/runAt）时 maxRuns 强制 1：留着 prev 的 >1 会让一次性
  // 任务跑完后既不到终态也推不出下一次，调度器只能亮「无法推算」的错误徽章
  const maxRuns = p.maxRuns !== undefined
    ? (p.maxRuns === null ? (recurring ? null : 1) : p.maxRuns)
    : delay || absolute
      ? 1
      : ((p.recurring !== undefined && !recurring) && prev.maxRuns === null ? 1 : prev.maxRuns);

  const scheduleChanged = p.cron !== undefined || p.scheduleRule !== undefined || delay || absolute;
  if (scheduleChanged) {
    const resolved = resolveSchedule(p);
    // create 拒「推不出未来」，update 大多数情况同拒 —— 例外：编辑一个已经
    // 发火过的一次性任务（runAt 已成过去）时表单会把原样规则回传，那不是在
    // 改调度，拒掉等于「改个名字都存不了」。识别之：盘上调度原样不动。
    const pastOneShotResubmit =
      resolved.nextRunAt === null && resolved.rule !== null && resolved.rule.runAt !== undefined &&
      resolved.rule.runAt <= Date.now() && p.runAt === undefined && p.delayMinutes === undefined && p.cron === undefined;
    if (resolved.nextRunAt === null && !pastOneShotResubmit) {
      // 否则写下去就是 enabled + next_run_at=null 的无声卡死行
      throw badAutomation("当前规则推不出任何未来的触发时间");
    }
    if (!pastOneShotResubmit) {
      patch.cron = resolved.cron;
      patch.scheduleRule = resolved.rule;
      patch.nextRunAt = resolved.nextRunAt;
      // 重排已发火的一次性任务：terminal 认领时被置 enabled=0，给了新的未来
      // 落点就是明确要再跑，保持停用会无声地永远不跑。只重挂一次性行 ——
      // 手动停用的循环任务改调度，不该被自作主张拉起。
      if (!prev.enabled && prev.recurring === false) patch.enabled = true;
    }
  } else if (wantsRuns) {
    // 只动次数口径：下一个触发点从现有规则重算。
    // 盘上的行可能被手改坏（weekly 缺 weekdays / 坏 cron）——这里抛不得，
    // 落 null 让调度器在下一 tick 把它停用 + 亮徽章。
    try {
      patch.nextRunAt = prev.scheduleRule !== null
        ? computeScheduleNextRunAt(prev.scheduleRule)
        : cronNextAt(prev.cron);
    } catch {
      patch.nextRunAt = null;
    }
  }
  if (wantsRuns) {
    patch.recurring = recurring;
    patch.maxRuns = maxRuns;
  }
  if (scheduleChanged || wantsRuns) scheduler.invalidate(p.id);

  store.updateAutomation(p.id, patch);
  const after = store.getAutomation(p.id);
  return { automation: after?.automation ?? null };
});

registerMethod("automation.list", () => {
  // 卡片需要运行记录（最近运行 / 状态徽章），每条带上最近 10 条
  return store.listAutomations().map((a) => ({ ...a, runs: store.listAutomationRuns(a.id, 10) }));
});
// 创建上限是用户设置（kv 持久化，默认 20）：自动化页头那个 n / N 就地可改
registerMethod("automation.limit.get", () => ({ limit: getAutomationCreateLimit(store) }));
registerMethod("automation.limit.set", (params) => {
  const p = (params ?? {}) as { limit?: unknown };
  if (typeof p.limit !== "number" || !Number.isFinite(p.limit)) {
    throw badAutomation("limit must be a number");
  }
  return { limit: setAutomationCreateLimit(store, p.limit) };
});
registerMethod("automation.setEnabled", (params) => {
  const p = (params ?? {}) as { id?: number; enabled?: boolean };
  if (typeof p.id !== "number" || typeof p.enabled !== "boolean") {
    throw badAutomation("id and enabled are required");
  }
  const hit = store.getAutomation(p.id);
  if (hit === undefined) throw Object.assign(new Error(`no such automation: ${p.id}`), { code: "unknown_automation" });
  scheduler.invalidate(p.id);
  const changed = store.setAutomationEnabled(p.id, p.enabled);
  // 重新启用一个 next_run_at 为空的行（终态任务被手动拉起）：从现在重算一次，
  // 否则永远没人认领。停用期间「错过」的旧时刻交给 misfire 宽限跳过。
  let nextRunAt = hit.automation.nextRunAt;
  if (p.enabled && nextRunAt === null) {
    const a = hit.automation;
    // 坏 cron / 半损坏的规则在这里会抛 —— 不能让 500 留下 enabled+null 的卡死行。
    // 落 null 交给调度器：下一 tick 会把它停用 + 亮徽章（可见的失败，不是无声的消失）。
    try {
      nextRunAt = a.scheduleRule !== null ? computeScheduleNextRunAt(a.scheduleRule) : cronNextAt(a.cron);
    } catch {
      nextRunAt = null;
    }
    store.updateAutomation(p.id, { nextRunAt });
  }
  return { changed, nextRunAt };
});
registerMethod("automation.delete", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  scheduler.invalidate(p.id);
  return { deleted: store.deleteAutomation(p.id) };
});
// 批量删除 / 批量启停：列表页多选管理用。逐条循环而不是一条多行 SQL ——
// 每条各走一遍与单条完全相同的收口（scheduler.invalidate / 终态重启用重算），
// 语义永远不会和单条版本漂移。不存在/已删的行静默跳过，返回实际生效数。
const parseIdList = (raw: unknown): number[] => {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100 || !raw.every((v) => typeof v === "number")) {
    throw badAutomation("ids 必须是 1-100 个数字");
  }
  return raw;
};
registerMethod("automation.deleteMany", (params) => {
  const p = (params ?? {}) as { ids?: unknown };
  const ids = parseIdList(p.ids);
  let deleted = 0;
  for (const id of ids) {
    scheduler.invalidate(id);
    if (store.deleteAutomation(id)) deleted += 1;
  }
  return { deleted };
});
registerMethod("automation.setEnabledMany", (params) => {
  const p = (params ?? {}) as { ids?: unknown; enabled?: unknown };
  const ids = parseIdList(p.ids);
  if (typeof p.enabled !== "boolean") throw badAutomation("enabled is required");
  let changed = 0;
  for (const id of ids) {
    const hit = store.getAutomation(id);
    if (hit === undefined) continue;
    scheduler.invalidate(id);
    const changedOne = store.setAutomationEnabled(id, p.enabled);
    // 与单条 setEnabled 同口径：重新启用一个 next_run_at 为空的终态行，
    // 从现在重算一次触发点，否则那行永远没人认领
    if (p.enabled && hit.automation.nextRunAt === null) {
      const a = hit.automation;
      let nextRunAt: number | null;
      try {
        nextRunAt = a.scheduleRule !== null ? computeScheduleNextRunAt(a.scheduleRule) : cronNextAt(a.cron);
      } catch {
        nextRunAt = null;
      }
      store.updateAutomation(id, { nextRunAt });
    }
    if (changedOne) changed += 1;
  }
  return { changed };
});
registerMethod("automation.runs", (params) => {
  const p = (params ?? {}) as { id?: number; limit?: number };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  const limit = typeof p.limit === "number" ? Math.min(Math.max(p.limit, 1), 200) : 20;
  return store.listAutomationRuns(p.id, limit);
});
registerMethod("automation.runNow", async (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badAutomation("id is required");
  const hit = store.getAutomation(p.id);
  if (hit === undefined) throw Object.assign(new Error(`no such automation: ${p.id}`), { code: "unknown_automation" });
  const out = await runAutomation(hit.automation, { trigger: "manual" });
  // 手动触发不消耗 run_count（那是 scheduled 跑的账，一次性任务的终态判断只看它）。
  // 例外：**待发火的一次性任务**手动跑 = 用户明确「现在就跑这次」，排定的那次
  // 必须一并收口 —— 否则到点还会再跑一次，违背「跑一次，跑完即停」的承诺。
  const a = hit.automation;
  if (!a.recurring && (a.maxRuns ?? 1) <= 1 && a.enabled && a.nextRunAt !== null) {
    scheduler.invalidate(a.id);
    // 与调度器认领同款原子收口：next_run_at=null + run_count+1 + enabled=0
    store.markAutomationFired(a.id, null, Date.now(), true);
  }
  return out;
});

// ---- 单元历史（unit.history）---------------------------------------------------
//
// 每个 bot 一条统一时间轴：自动化任务、待办任务、心跳会话、手动/IM 会话。
// 视角是「跑过什么任务」而不是裸会话表：已被运行记录引用的会话归入对应任务
// 条目（不再重复出现），没被引用的会话才按会话条目列出（headless 才有 sessionId，
// 可下钻 session.messages 看对话；TUI 条目只有运行结果摘要）。

interface UnitHistoryEntry {
  key: string;
  kind: "automation" | "backlog" | "session" | "manual";
  unitId?: string;
  unitName?: string;
  title: string;
  subtitle: string | null;
  runtimeId: string;
  launchMode: LaunchMode;
  status: string;
  trigger: string | null;
  startedAt: number;
  endedAt: number | null;
  detail: string | null;
  /** headless 会话的 id（可查 session.messages 下钻）；TUI 运行为 null */
  sessionId: string | null;
  /**
   * 执行器原生会话引用（sessions.cli_ref：claude=cliSessionId、codex=threadId、
   * zcode=原生 id、ACP 系=ref）。TUI 恢复按各家 resume 口径用它，不用我们的内部 id。
   */
  resumeRef: string | null;
  /** 终端运行 id（用于检索终端纯文本日志/transcript） */
  terminalId?: string | null;
  /**
   * 对话分叉血缘（ADR 0013）：侧栏/历史弹窗的分支徽标与版本家族折叠
   * （P2 按 forkOf+forkAtSeq 分组）靠这三列。
   */
  forkOf?: string | null;
  forkAtSeq?: number | null;
  forkKind?: "branch" | "revision" | null;
  /** 会话来源（workbench/feishu/mobile/automation…，仅 session 类行带）：来源标签用 */
  source?: string | null;
}

/**
 * 尝试从各 CLI 原生存储中回溯历史交互式会话的标题与恢复引用（mcode、zcode、claude 等）
 */
/**
 * unit.history 里 terminal 行 resume 回溯的节流台账：
 * - 已结算行每进程只试一次（结算后原生存储不再变化，重试无意义）；
 * - running 行原生 id 可能还没刷出来，允许重试但**全局节流**（≥10s/行）——
 *   此前 running 行每次调用都重扫原生存储，侧栏子列表 30s × 历史面板 20s 的
 *   多路轮询会把它放大成事件循环上的同步读风暴（reader 内部是同步 fs），
 *   unit.history 15s 超时的偶发红字就是这么来的。
 */
const terminalResumeAttempted = new Set<string>();
const terminalResumeRunningAt = new Map<number, number>();
const TERMINAL_RESUME_RETRY_MS = 10_000;

/**
 * 原生会话列表的短 TTL 缓存（执行器|工作区 → 列表）：同一 bot 的多行回溯、
 * 多路轮询、terminal/automation/backlog 三类终端行共享一次扫描。
 */
const nativeListCache = new Map<string, { at: number; rows: readonly NativeSessionSummary[] }>();
const nativeListInFlight = new Map<string, Promise<readonly NativeSessionSummary[]>>();
const NATIVE_LIST_TTL_MS = 30_000;

function cachedNativeList(executorId: string, rootPath: string | null): Promise<readonly NativeSessionSummary[]> {
  const key = `${executorId}|${rootPath ?? ""}`;
  const hit = nativeListCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < NATIVE_LIST_TTL_MS) return Promise.resolve(hit.rows);
  const flying = nativeListInFlight.get(key);
  if (flying !== undefined) return flying;
  const reader = readerOf(executorId);
  const p = (reader !== null ? reader.list(rootPath, 50) : Promise.resolve([]))
    .catch(() => [] as readonly NativeSessionSummary[])
    .then((rows) => {
      nativeListCache.set(key, { at: Date.now(), rows });
      nativeListInFlight.delete(key);
      return rows;
    });
  nativeListInFlight.set(key, p);
  return p;
}

/** 全家聚合的缓存通道（自动收录专用）：逐家走 cachedNativeList（30s TTL +
 * 单飞，与 unit.history 的行级回溯共享同一次扫描），绝不裸跑 14 家 reader。
 * rootPath 先 resolve 归一：bot.json 手可编辑，正斜杠写法会让朴素比较的
 * reader 过滤（如 mcode 的 cwd 匹配）静默全空。 */
async function cachedNativeListAll(rootPath: string): Promise<readonly NativeSessionSummary[]> {
  const root = path.resolve(rootPath);
  const rows = await Promise.all(readerIds().map((id) => cachedNativeList(id, root)));
  return rows.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * TUI 运行的原生会话回溯：按「时间窗 ±30s + 工作目录吻合优先」在原生存储里找
 * 这场运行对应的 CLI 会话，取其 id 当 resumeRef。
 * 复用 history/ 的 9 家 reader（pi/claude/codex/grok/mcode/kimi/dsh/zcode/hermes）
 * —— 此前手写的同步版只盖 3 家，且 claude 整份 readFileSync history.jsonl、
 * mcode 前置通配 LIKE 全表扫。注意 reader 内部仍是同步 fs：靠上面的 TTL 缓存 +
 * 行级节流钉住扫描频率，本函数自身只做内存匹配。
 * title 为空也返回 ref（旧版「title 空就连 session_id 一起丢」是个洞）。
 */
async function resolveNativeTerminalSession(
  runtimeId: string,
  rootPath: string,
  startedAt: number,
  endedAt: number | null,
): Promise<{ title: string; resumeRef: string | null } | null> {
  const bareRuntime = runtimeId.replace(/^daemon:/, "").replace(/:yolo$/, "");
  if (readerOf(bareRuntime) === null) return null;
  const minTime = startedAt - 30_000;
  const maxTime = (endedAt ?? Date.now()) + 30_000;
  const rows = await cachedNativeList(bareRuntime, rootPath !== "" ? rootPath : null);
  let best: NativeSessionSummary | null = null;
  let bestPathMatch = false;
  for (const s of rows) {
    if (s.sessionId === "" || s.startedAt < minTime || s.startedAt > maxTime) continue;
    const pathMatch = rootPath !== "" && s.rootPath !== null && samePath(s.rootPath, rootPath);
    // 会话带明确工作目录且与运行目录不符 → 同窗内别的项目会话，排除；
    // 目录未知（null）的保留为弱候选，靠时间窗与优先级兜底
    if (!pathMatch && s.rootPath !== null && rootPath !== "") continue;
    if (
      best === null ||
      (pathMatch && !bestPathMatch) ||
      (pathMatch === bestPathMatch && Math.abs(s.startedAt - startedAt) < Math.abs(best.startedAt - startedAt))
    ) {
      best = s;
      bestPathMatch = pathMatch;
    }
  }
  if (best === null) return null;
  return { title: best.title.trim(), resumeRef: best.sessionId };
}

/**
 * 回填一个单元 terminal_runs 里缺失的 resumeRef（unit.history 手动终端行回溯的
 * 单元化版本，自动收录在差集前调用）：工作台自己派发的 TUI 会话先进 known 集，
 * 不会被自动收录重复落成 imp_ 行。回溯走 TTL 缓存，每轮开销可忽略。
 */
async function backfillUnitTerminalRefs(unitId: string, rootPath: string): Promise<void> {
  for (const r of store.listTerminalRuns(unitId, 20)) {
    if (r.resumeRef !== null && r.resumeRef !== "") continue;
    // 古老的死运行没有原生 id 可回溯，每轮重试无意义
    if (Date.now() - r.startedAt > TERMINAL_BACKFILL_MAX_AGE_MS) continue;
    const resolved = await resolveNativeTerminalSession(r.runtimeId, rootPath, r.startedAt, r.finishedAt);
    if (resolved !== null && resolved.resumeRef !== null) {
      store.updateTerminalRunResume(
        r.id,
        resolved.title !== "" ? resolved.title : (r.title ?? "交互式会话"),
        resolved.resumeRef,
      );
    }
  }
}

registerMethod("unit.history", async (params) => {
  const p = (params ?? {}) as { unitId?: string; limit?: number };
  const targetUnitId = typeof p.unitId === "string" && p.unitId.trim() !== "" ? p.unitId.trim() : null;
  const limit = Math.min(Math.max(typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.round(p.limit) : 100, 1), 500);

  const entries: UnitHistoryEntry[] = [];
  /** 已被运行记录认领的会话 id（全量，不受单次 limit 影响）：会话条目去重用 */
  const claimedSessionIds = store.getClaimedSessionIds();

  // 预载全部 bot 映射，支持单 bot 历史或跨 bot 全局历史
  const allBots = await botRegistry.listBots().catch(() => []);
  // BotDefinition 的键字段是 id（bot.json 形态），不是 unitId —— 此前按 b.unitId
  // 建键全部落 undefined，unitName/rootPath 解析从未生效（历史行一直显示裸
  // unitId、terminal 回溯拿不到 bot 目录），这是顺带修掉的存量 bug
  const botMap = new Map(allBots.map((b) => [String(b.id ?? ""), b]));
  const defaultBotRootPath = targetUnitId ? (botMap.get(targetUnitId)?.rootPath ? String(botMap.get(targetUnitId)?.rootPath) : "") : "";

  // 进程内已解析会话标题缓存（避免每次 unit.history 对几十个会话同步查 SQLite 首条消息）
  const sessionTitleCache = new Map<string, string>();

  // 单词请求时间预算保护：若原生扫描累计耗时过长，熔断后续扫描，保障 RPC 毫秒级返回
  const reqStart = Date.now();
  const canAttemptMore = () => Date.now() - reqStart < 400;

  for (const a of store.listAutomations()) {
    if (targetUnitId !== null && a.unitId !== targetUnitId) continue;
    const uName = botMap.get(a.unitId)?.name ?? a.unitId;
    const autoRootPath = (botMap.get(a.unitId)?.rootPath ? String(botMap.get(a.unitId)?.rootPath) : "") || defaultBotRootPath;
    const subLimit = Math.min(limit, 20);
    for (const r of store.listAutomationRuns(a.id, subLimit)) {
      const isTerminal = r.sessionId !== null && r.sessionId.startsWith("autoterm_");
      // host 会话运行按定义行的 launchMode 展示（chat = 对话页前台拉起过）；
      // sessionId 为 null 的失败行只能信定义行本身
      const launchMode: LaunchMode = isTerminal ? "terminal" : (r.sessionId !== null && a.launchMode !== "chat" ? "headless" : a.launchMode);
      // terminal 模式的自动化行同样回溯原生 ref（automation_runs 没有 resume_ref
      // 列，不落库 —— 每调用按 TTL 缓存现匹配，命中的成本只是内存过滤）
      let terminalResumeRef: string | null = null;
      if (isTerminal && r.sessionId !== null) {
        const attemptKey = `auto-${r.id}`;
        if ((!terminalResumeAttempted.has(attemptKey) || r.status === "running") && canAttemptMore()) {
          terminalResumeAttempted.add(attemptKey);
          const resolved = await resolveNativeTerminalSession(a.runtimeId, autoRootPath, r.startedAt, r.finishedAt);
          terminalResumeRef = resolved?.resumeRef ?? null;
        }
      }
      entries.push({
        key: `automation-${r.id}`,
        kind: "automation",
        unitId: a.unitId,
        unitName: uName,
        title: a.name,
        subtitle: a.prompt.length > 80 ? `${a.prompt.slice(0, 80)}…` : a.prompt,
        runtimeId: a.runtimeId,
        launchMode,
        status: r.status,
        trigger: r.trigger,
        startedAt: r.startedAt,
        endedAt: r.finishedAt,
        detail: r.detail,
        sessionId: !isTerminal ? r.sessionId : null,
        resumeRef: !isTerminal && r.sessionId !== null
          ? (store.getSession(r.sessionId)?.cliRef ?? null)
          : terminalResumeRef,
        terminalId: isTerminal ? r.sessionId : null,
      });
    }
  }

  for (const item of store.listBacklogItems()) {
    if (targetUnitId !== null && item.unitId !== targetUnitId) continue;
    const uName = botMap.get(item.unitId)?.name ?? item.unitName ?? item.unitId;
    const blRootPath = (botMap.get(item.unitId)?.rootPath ? String(botMap.get(item.unitId)?.rootPath) : "") || defaultBotRootPath;
    const subLimit = Math.min(limit, 20);
    for (const r of store.listBacklogRuns(item.id, subLimit)) {
      const isTerminal = r.sessionId !== null && r.sessionId.startsWith("autoterm_");
      if (r.sessionId !== null && !isTerminal) claimedSessionIds.add(r.sessionId);
      // terminal 模式的待办行同 automation：TTL 缓存现匹配原生 ref（不落库）
      let terminalResumeRef: string | null = null;
      if (isTerminal && r.sessionId !== null) {
        const attemptKey = `bl-${r.id}`;
        if ((!terminalResumeAttempted.has(attemptKey) || r.status === "running") && canAttemptMore()) {
          terminalResumeAttempted.add(attemptKey);
          const resolved = await resolveNativeTerminalSession(r.runtimeId, blRootPath, r.startedAt, r.finishedAt);
          terminalResumeRef = resolved?.resumeRef ?? null;
        }
      }
      entries.push({
        key: `backlog-${r.id}`,
        kind: "backlog",
        unitId: item.unitId,
        unitName: uName,
        title: item.title,
        subtitle: item.goal.length > 80 ? `${item.goal.slice(0, 80)}…` : item.goal,
        runtimeId: r.runtimeId,
        launchMode: isTerminal ? "terminal" : (item.launchMode === "chat" ? "chat" : "headless"),
        status: r.status,
        trigger: r.trigger,
        startedAt: r.startedAt,
        endedAt: r.finishedAt,
        detail: r.detail,
        sessionId: r.sessionId !== null && !isTerminal ? r.sessionId : null,
        resumeRef: r.sessionId !== null && !isTerminal ? (store.getSession(r.sessionId)?.cliRef ?? null) : terminalResumeRef,
        terminalId: isTerminal ? r.sessionId : null,
      });
    }
  }

  if (terminalResumeRunningAt.size > 500) terminalResumeRunningAt.clear();

  for (const r of store.listTerminalRuns(targetUnitId ?? undefined, limit)) {
    let title = r.title;
    let resumeRef = r.resumeRef;
    const botRootPath = (botMap.get(r.unitId)?.rootPath ? String(botMap.get(r.unitId)?.rootPath) : "") || defaultBotRootPath;
    // resume_ref 缺失就从原生存储回溯 —— 实时捕获（dispatch 带 ref 落库）是
    // 第一顺位，这里是兜底。结算行每进程只试一次；running 行全局节流 ≥10s/行
    // （原生 id 可能还没刷出来，允许重试，但不能让多路轮询变成同步读风暴）。
    // 回溯本身走 history reader + TTL 缓存，见 resolveNativeTerminalSession 注释。
    if (!resumeRef && canAttemptMore()) {
      const now = Date.now();
      const mayAttempt =
        r.status === "running"
          ? now - (terminalResumeRunningAt.get(r.id) ?? 0) >= TERMINAL_RESUME_RETRY_MS
          : !terminalResumeAttempted.has(`manual-${r.id}`);
      if (mayAttempt) {
        if (r.status === "running") terminalResumeRunningAt.set(r.id, now);
        else terminalResumeAttempted.add(`manual-${r.id}`);
        const resolved = await resolveNativeTerminalSession(r.runtimeId, botRootPath, r.startedAt, r.finishedAt);
        if (resolved !== null) {
          if ((!title || title === "" || title === "交互式会话") && resolved.title !== "") title = resolved.title;
          if (resolved.resumeRef !== null) {
            resumeRef = resolved.resumeRef;
            store.updateTerminalRunResume(r.id, title ?? "交互式会话", resumeRef);
          }
        }
      }
    }
    entries.push({
      key: `manual-${r.id}`,
      kind: "manual",
      unitId: r.unitId,
      unitName: botMap.get(r.unitId)?.name ?? r.unitName,
      title: title && title !== "" ? title : "交互式会话",
      subtitle: null,
      runtimeId: r.runtimeId,
      launchMode: "terminal",
      status: r.status,
      trigger: "manual",
      startedAt: r.startedAt,
      endedAt: r.finishedAt,
      detail: r.detail,
      sessionId: null,
      resumeRef: resumeRef ?? null,
      terminalId: r.terminalId,
    });
  }

  // 影子行判定集：非导入台账行与终端运行认领的 (执行器|原生会话 id)
  const shadowedNativeRefs = new Set<string>();
  for (const s of store.listSessions()) {
    if (s.source !== "imported" && s.cliRef !== null && s.cliRef !== "") {
      shadowedNativeRefs.add(`${s.runtimeId.replace(/^daemon:/, "")}|${s.cliRef}`);
    }
  }
  for (const r of store.listTerminalRuns(targetUnitId ?? undefined, 200)) {
    if (r.resumeRef !== null && r.resumeRef !== "") shadowedNativeRefs.add(`${r.runtimeId.replace(/^daemon:/, "")}|${r.resumeRef}`);
  }

  for (const s of store.listSessions()) {
    if ((targetUnitId !== null && s.unitId !== targetUnitId) || claimedSessionIds.has(s.id)) continue;
    // 导入的外部会话：session 形态呈现（launchMode=chat）——点击进聊天页
    // （events.since 触发原生转录投影）、右键可 TUI resume（cliRef=原生 id）
    const imported = s.source === "imported";
    // 影子行过滤（展示层兜底；自动收录每轮的清扫通常会先删掉它们）：真会话或
    // 终端运行已认领同一原生会话时，imp_ 行是冗余投影，不再各自成行——
    // 否则「聊天页新建对话 → 侧栏多出一行相同内容」的竞态残留会一直双显
    if (imported && s.cliRef !== null && s.cliRef !== "" && shadowedNativeRefs.has(`${s.runtimeId.replace(/^daemon:/, "")}|${s.cliRef}`)) {
      continue;
    }
    let title = s.title.trim();
    if (title === "" || title === "（无标题会话）") {
      const cached = sessionTitleCache.get(s.id);
      if (cached) {
        title = cached;
      } else {
        const firstMsg = store.listMessages(s.id, 1)[0];
        if (firstMsg?.text) {
          const line = firstMsg.text.trim().split(/\r?\n/)[0]?.trim() ?? "";
          if (line !== "") {
            title = line.length > 60 ? `${line.slice(0, 60)}…` : line;
          }
        }
        if (title !== "" && title !== "（无标题会话）") {
          sessionTitleCache.set(s.id, title);
        }
      }
    }
    let sessionStatus = s.status;
    let endedAt = s.endedAt;
    // 运行时一致性对账（防孤儿呼吸灯）：
    // 若数据库标记为 running 或 awaiting_*，但 host 内存中根本没有 live 实例在跑（impl === null）：
    if (sessionStatus === "running" || sessionStatus.startsWith("awaiting_")) {
      const isLive = host.isLive(asSessionId(s.id));
      if (!isLive) {
        if (!s.cliRef) {
          // 根本没有执行器引用可接回：这是异常中断的死会话，收口为 failed
          sessionStatus = "failed";
          endedAt = endedAt ?? s.startedAt;
          store.setSessionStatus(s.id, "failed", endedAt, s.stats);
        } else {
          // 有 cliRef 但当前未在运行，置为可接回等待态 idle，不向前端冒充 running 呼吸灯
          sessionStatus = "idle";
          store.setSessionStatus(s.id, "idle", endedAt ?? null, s.stats);
        }
      }
    }

    if (s.cliRef) {
      const nativeList = await cachedNativeList(s.runtimeId, s.rootPath ?? defaultBotRootPath);
      const hit = nativeList.find((x) => x.sessionId === s.cliRef);
      if (hit) {
        if (!title || title === "（无标题会话）") title = hit.title;
        endedAt = Math.max(endedAt ?? 0, hit.updatedAt);
      }
    }

    // 导入行没有本进程的活实现：idle 是旧版「点击即 reattach」的残留，收口 done
    //（与 host 侧 adoptRow 的同款自愈，双保险：不重启 daemon 也能消掉常亮蓝灯）
    if (sessionStatus === "idle" && s.source === "imported" && !host.isLive(asSessionId(s.id))) {
      sessionStatus = "done";
      endedAt = endedAt ?? s.endedAt;
      store.setSessionStatus(s.id, "done", endedAt, s.stats);
    }

    entries.push({
      key: `session-${s.id}`,
      kind: "session",
      unitId: s.unitId,
      unitName: botMap.get(s.unitId)?.name ?? s.unitId,
      title: title === "" ? "（无标题会话）" : title,
      subtitle: null,
      runtimeId: s.runtimeId,
      launchMode: imported ? "chat" : "headless",
      status: sessionStatus,
      trigger: null,
      startedAt: s.startedAt,
      endedAt,
      detail: null,
      sessionId: s.id,
      resumeRef: s.cliRef,
      terminalId: null,
      // 来源标签（workbench 缺省不显，渠道/自动化/导入来源让用户知道「这条怎么来的」）
      source: s.source,
      forkOf: s.forkOfSession,
      forkAtSeq: s.forkAtSeq,
      forkKind: s.forkKind,
    });
  }

  entries.sort((a, b) => b.startedAt - a.startedAt);
  // 导入行是用户亲手收进来的（数量少、有明确关注）：不受 limit 截断 —— 否则导入
  // 一条久远的会话，它按 startedAt 排到百名开外，侧栏永远看不到，「导入成功」
  // 在用户眼里就是假的。其余行照常按 limit 截，合并后维持时间序（前端依赖
  // daemon 的排序，置顶由前端 pinnedKeys 负责）
  const importedRows = entries.filter((e) => e.source === "imported");
  const merged = [...entries.filter((e) => e.source !== "imported").slice(0, Math.max(0, limit - importedRows.length)), ...importedRows];
  merged.sort((a, b) => b.startedAt - a.startedAt);
  // 显示名覆盖层（history.rename 写 kv）：不碰源数据 —— 台账标题继续由 daemon
  // 同步，用户给的「备注名」只盖显示。空串 = 恢复原名。任何 kind 的行都可改
  //（自动化/待办行改的是这份列表里的显示，不动任务定义本身）
  const renames = store.kvByPrefix("hist-rename:");
  if (renames.size > 0) {
    for (let i = 0; i < merged.length; i++) {
      const override = renames.get(`hist-rename:${merged[i]!.key}`);
      if (override !== undefined && override !== "") merged[i] = { ...merged[i]!, title: override.slice(0, 120) };
    }
  }
  return { entries: merged };
});

// ---- 历史行重命名（显示名覆盖层，kv 落盘跨设备一致）---------------------------

registerMethod("history.rename", (params) => {
  const p = (params ?? {}) as { key?: string; title?: string };
  if (typeof p.key !== "string" || p.key === "") {
    throw Object.assign(new Error("key 必填"), { code: "bad_params" });
  }
  const title = typeof p.title === "string" ? p.title.trim().slice(0, 120) : "";
  // 空标题 = 撤销改名，恢复源数据标题（存空串而非删行：kv 没有删除面，空串同义）
  store.kvSet(`hist-rename:${p.key}`, title);
  return { key: p.key, title };
});

// ---- 原生会话历史（history.native.*，docs/13 Phase 1）-------------------------
//
// 会话事实源层：直接读各 CLI 自己的会话存储（~/.pi / ~/.claude / ~/.codex / ~/.grok /
// ~/.minimax / ~/.kimi-code / $DSH_HOME / ~/.zcode / ~/.hermes），只读浏览零进程成本。
// TUI 里聊的、任何入口产生的会话都可见——这是「聊天视图不再形同虚设」的事实源。
// 协议型来源（opencode/openclaw）随 Phase 4 对应 tier 的适配器升级接入。

registerMethod("history.native.list", async (params) => {
  const p = (params ?? {}) as { unitId?: string; executorIds?: unknown; limit?: number };
  const limit = Math.min(Math.max(typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.round(p.limit) : 50, 1), 200);
  const executorIds = Array.isArray(p.executorIds) ? p.executorIds.filter((x): x is string => typeof x === "string") : [];
  // unitId → rootPath 过滤（不传 = 全量跨 bot）
  let rootPath: string | null = null;
  if (typeof p.unitId === "string" && p.unitId.trim() !== "") {
    const bots = await botRegistry.listBots().catch(() => [] as { id?: string; rootPath?: unknown }[]);
    const bot = bots.find((b) => String(b.id ?? "") === p.unitId);
    rootPath = bot !== undefined && typeof bot.rootPath === "string" && bot.rootPath !== "" ? bot.rootPath : null;
  }
  const sessions = await listNativeSessions(rootPath, executorIds, limit);
  return { sessions };
});

registerMethod("history.native.detail", async (params) => {
  const p = (params ?? {}) as { executorId?: string; sessionId?: string; tail?: number };
  if (typeof p.executorId !== "string" || typeof p.sessionId !== "string" || p.executorId === "" || p.sessionId === "") {
    throw Object.assign(new Error("executorId 与 sessionId 必填"), { code: "bad_params" });
  }
  const detail = await readNativeSession(p.executorId, p.sessionId);
  if (detail === null) throw Object.assign(new Error("会话不存在或读取失败"), { code: "not_found" });
  // tail：只带最近 N 条（历史详情展开的默认口径）。长会话全量转录动辄 10MB 级——
  // 传输 + 前端 JSON.parse + 逐条渲染（assistant 还走 markdown）会把点开详情
  // 卡成秒级冻结；截尾后 messageCount 仍是全量数，前端据此显示「共 X 条」
  // 并提供「加载全部」显式兜底。tail 模式下单条文本同时截到 6KB——大工具
  // 输出一条就能占几 MB，只按条数截砍不干净
  if (typeof p.tail === "number" && Number.isFinite(p.tail) && p.tail > 0 && detail.transcript.length > p.tail) {
    const tail = Math.min(Math.round(p.tail), 2000);
    const TAIL_ENTRY_TEXT_MAX = 6000;
    return {
      detail: {
        ...detail,
        transcript: detail.transcript.slice(-tail).map((e) =>
          e.text.length > TAIL_ENTRY_TEXT_MAX ? { ...e, text: `${e.text.slice(0, TAIL_ENTRY_TEXT_MAX)}\n…（单条已截断，加载全部可见完整内容）` } : e,
        ),
      },
    };
  }
  return { detail };
});

// ---- 外部会话导入（history.import.*）-------------------------------------------
//
// 面向「工作台外、直接在外部终端里跑的 CLI 会话」：按 bot 工作区 + 执行器列出
// 原生会话（cc-switch 式的查询面），勾选后落进 sessions 表（source = "imported"，
// id 用 imp_ 前缀与真实会话隔离，cli_ref 存原生 id）。导入后的行在 unit.history
// 里以 session 形态出现（launchMode=chat）——点击进聊天页（events.since 触发原生
// 转录投影）、右键可 TUI resume（原生 id）。自动收录（autocollect.ts）与之共用
// 落库与去重口径；手动面是自动收录关闭或漏收时的显式兜底。

registerMethod("history.import.list", async (params) => {
  const p = (params ?? {}) as { unitId?: string; runtimeId?: string; limit?: number };
  if (typeof p.unitId !== "string" || p.unitId === "") {
    throw Object.assign(new Error("unitId 必填"), { code: "bad_params" });
  }
  const bots = await botRegistry.listBots().catch(() => [] as { id?: string; rootPath?: unknown }[]);
  const bot = bots.find((b) => String(b.id ?? "") === p.unitId);
  const rootPath = bot !== undefined && typeof bot.rootPath === "string" && bot.rootPath !== "" ? bot.rootPath : null;
  if (rootPath === null) {
    throw Object.assign(new Error("该单元没有工作目录，无从匹配外部会话"), { code: "bad_params" });
  }
  const executorIds = typeof p.runtimeId === "string" && p.runtimeId !== "" ? [p.runtimeId.replace(/^daemon:/, "")] : [];
  const limit = Math.min(Math.max(typeof p.limit === "number" ? Math.round(p.limit) : 60, 1), 200);
  // resolve 归一：手改 bot.json 可能写正斜杠路径，朴素比较的 reader 会静默全空
  const rows = await listNativeSessions(path.resolve(rootPath), executorIds, limit);
  const known = knownNativeRefs(store);
  return {
    rootPath,
    sessions: rows.map((r) => ({ ...r, known: known.has(`${r.executorId}|${r.sessionId}`) })),
  };
});

registerMethod("history.import.apply", async (params) => {
  const p = (params ?? {}) as {
    unitId?: string;
    unitName?: string;
    runtimeId?: string;
    sessions?: Array<{ sessionId?: unknown; title?: unknown; startedAt?: unknown; updatedAt?: unknown }>;
  };
  if (typeof p.unitId !== "string" || p.unitId === "" || typeof p.runtimeId !== "string" || p.runtimeId === "" ||
      !Array.isArray(p.sessions)) {
    throw Object.assign(new Error("unitId, runtimeId, sessions 必填"), { code: "bad_params" });
  }
  const bare = p.runtimeId.replace(/^daemon:/, "");
  const bots = await botRegistry.listBots().catch(() => [] as { id?: string; rootPath?: unknown; name?: unknown }[]);
  const bot = bots.find((b) => String(b.id ?? "") === p.unitId);
  const rootPath = bot !== undefined && typeof bot.rootPath === "string" && bot.rootPath !== "" ? bot.rootPath : null;
  const known = knownNativeRefs(store);
  let imported = 0;
  let skipped = 0;
  const keys: string[] = [];
  for (const s of p.sessions) {
    const nativeId = typeof s?.sessionId === "string" ? s.sessionId : "";
    if (nativeId === "") continue;
    if (known.has(`${bare}|${nativeId}`)) {
      skipped++;
      continue;
    }
    const rowId = materializeImportedSession(store, {
      unitId: p.unitId,
      rootPath,
      executorId: bare,
      native: {
        sessionId: nativeId,
        title: typeof s?.title === "string" ? s.title : "",
        startedAt: typeof s?.startedAt === "number" && Number.isFinite(s.startedAt) ? s.startedAt : 0,
        updatedAt: typeof s?.updatedAt === "number" && Number.isFinite(s.updatedAt) ? s.updatedAt : 0,
      },
      known,
    });
    if (rowId === null) {
      skipped++;
      continue;
    }
    // 导入是显式关注动作：落库即开始实时同步外部续写（不用等打开一次），
    // 25 个的 watch 上限正是给「正在看 / 刚导入」的会话留的
    nativeWatcher.watchSession(rowId);
    // 手动导入同样要收编进 host 台账：否则 daemon 存活期内 session.list 缺这行，
    // 前端点开 historyOnly 回落会「打不开这个会话」（与自动收录同口径）
    host.adoptPersisted(rowId);
    keys.push(`session-${rowId}`);
    imported++;
  }
  if (imported > 0) log.info("native sessions imported", { unitId: p.unitId, runtimeId: bare, imported, skipped });
  // keys = 这些行在 unit.history 里的 entry key，前端拿去自动置顶（导入即想在
  // 侧栏最顶上看到，这是用户选择导入的那一刻的期待）
  return { imported, skipped, keys };
});


// ---- 待办 / GTD 方法（backlog.*）----------------------------------------------
//
// 确认门语义：backlog.proposal.confirm / backlog.runNow 都是**用户动作**（弹窗按钮、
// 清单按钮）——引擎自身的心跳只会产生提议，永远到不了 dispatch。权限面零新代码：
// 执行走 source:"automation" 的 headless 链路（权限闸完全放行，deny 规则仍优先）。

const badBacklog = (message: string): Error => Object.assign(new Error(message), { code: "bad_params" });

function requireEngine(): BacklogEngine {
  if (backlogEngine === undefined) throw Object.assign(new Error("backlog engine 未就绪"), { code: "engine_not_ready" });
  return backlogEngine;
}

registerMethod("backlog.list", async () => {
  const engine = requireEngine();
  const [quotas] = await Promise.all([engine.quotas(false)]);
  return {
    items: engine.listItems(),
    proposal: engine.proposal(),
    state: engine.snapshot(),
    config: getBacklogConfig(store),
    quotas,
  };
});

registerMethod("backlog.create", (params) => {
  const p = (params ?? {}) as {
    title?: string; goal?: string; prompt?: string;
    unitId?: string; unitName?: string; rootPath?: string;
    runtimeId?: string; model?: string | null; mode?: string | null; size?: string | null;
    launchMode?: string;
  };
  if (typeof p.goal !== "string" || p.goal.trim() === "") throw badBacklog("goal is required");
  if (typeof p.unitId !== "string" || typeof p.rootPath !== "string" || p.rootPath === "") {
    throw badBacklog("unitId and rootPath are required");
  }
  if (p.launchMode !== undefined && p.launchMode !== "terminal" && p.launchMode !== "chat" && p.launchMode !== "headless") {
    throw badBacklog("launchMode 只能是 terminal、chat 或 headless");
  }
  const goal = p.goal.trim();
  const title = typeof p.title === "string" && p.title.trim() !== "" ? p.title.trim() : goal.split(/\r?\n/)[0]!.slice(0, 40);
  const id = store.createBacklogItem({
    title,
    goal,
    prompt: typeof p.prompt === "string" && p.prompt.trim() !== "" ? p.prompt.trim() : draftPromptOf(goal),
    unitId: p.unitId,
    unitName: typeof p.unitName === "string" ? p.unitName : p.unitId,
    rootPath: p.rootPath,
    runtimeId: typeof p.runtimeId === "string" ? p.runtimeId : "",
    model: typeof p.model === "string" && p.model !== "" ? p.model : null,
    mode: typeof p.mode === "string" && p.mode !== "" ? p.mode : null,
    size: p.size === "big" || p.size === "small" ? p.size : null,
    launchMode: p.launchMode === "headless" || p.launchMode === "chat" ? p.launchMode : "terminal",
    source: "manual",
  });
  const item = store.getBacklogItem(id);
  return { id, item: item === undefined ? null : requireEngine().toItem(item) };
});

registerMethod("backlog.update", (params) => {
  const p = (params ?? {}) as {
    id?: number; title?: string; goal?: string; prompt?: string;
    unitId?: string; unitName?: string; rootPath?: string;
    runtimeId?: string; model?: string | null; mode?: string | null; size?: string | null;
    launchMode?: string;
  };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  if (p.launchMode !== undefined && p.launchMode !== "terminal" && p.launchMode !== "chat" && p.launchMode !== "headless") {
    throw badBacklog("launchMode 只能是 terminal、chat 或 headless");
  }
  const hit = store.getBacklogItem(p.id);
  if (hit === undefined) throw Object.assign(new Error(`没有这个待办：${p.id}`), { code: "unknown_item" });
  if (hit.status === "executing") throw badBacklog("执行中的待办不能编辑 —— 等它跑完或打回后再改");
  store.updateBacklogItem(p.id, {
    ...(typeof p.title === "string" && p.title.trim() !== "" ? { title: p.title.trim() } : {}),
    ...(typeof p.goal === "string" && p.goal.trim() !== "" ? { goal: p.goal.trim() } : {}),
    ...(typeof p.prompt === "string" && p.prompt.trim() !== "" ? { prompt: p.prompt.trim() } : {}),
    ...(typeof p.unitId === "string" ? { unitId: p.unitId } : {}),
    ...(typeof p.unitName === "string" ? { unitName: p.unitName } : {}),
    ...(typeof p.rootPath === "string" && p.rootPath !== "" ? { rootPath: p.rootPath } : {}),
    ...(typeof p.runtimeId === "string" ? { runtimeId: p.runtimeId } : {}),
    ...(p.model !== undefined ? { model: typeof p.model === "string" && p.model !== "" ? p.model : null } : {}),
    ...(p.mode !== undefined ? { mode: typeof p.mode === "string" && p.mode !== "" ? p.mode : null } : {}),
    ...(p.size !== undefined ? { size: p.size === "big" || p.size === "small" ? p.size : null } : {}),
    ...(p.launchMode === "terminal" || p.launchMode === "chat" || p.launchMode === "headless" ? { launchMode: p.launchMode } : {}),
  });
  const item = store.getBacklogItem(p.id);
  return { item: item === undefined ? null : requireEngine().toItem(item) };
});

registerMethod("backlog.delete", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  const hit = store.getBacklogItem(p.id);
  if (hit !== undefined && hit.status === "executing") throw badBacklog("执行中的待办不能删除 —— 先等它跑完");
  return { deleted: store.deleteBacklogItem(p.id) };
});

/** 手动排序：传全量 id 顺序（顺序即优先级） */
registerMethod("backlog.reorder", (params) => {
  const p = (params ?? {}) as { ids?: unknown };
  if (!Array.isArray(p.ids)) throw badBacklog("ids (number[]) is required");
  const ids = p.ids.map(Number).filter((n) => Number.isInteger(n));
  ids.forEach((id, i) => store.updateBacklogItem(id, { sortPos: (i + 1) * 1000 }));
  return { reordered: ids.length };
});

registerMethod("backlog.wake", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  requireEngine().wake(p.id);
  return { ok: true };
});

registerMethod("backlog.sleep", (params) => {
  const p = (params ?? {}) as { id?: number };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  requireEngine().sleep(p.id);
  return { ok: true };
});

/** 确认门 —— 确认当前提议（执行器可在此时改选，选择记忆回待办） */
registerMethod("backlog.proposal.confirm", (params) => {
  const p = (params ?? {}) as { runtimeId?: string; model?: string | null };
  return requireEngine().confirm({
    ...(typeof p.runtimeId === "string" && p.runtimeId !== "" ? { runtimeId: p.runtimeId } : {}),
    ...(p.model !== undefined ? { model: typeof p.model === "string" && p.model !== "" ? p.model : null } : {}),
  });
});

registerMethod("backlog.proposal.reject", () => {
  requireEngine().reject();
  return { ok: true };
});

/** 验收：pass=true 关闭；打回 = 回就绪重新排队（可附一句话备注） */
registerMethod("backlog.review", (params) => {
  const p = (params ?? {}) as { id?: number; pass?: boolean; note?: string };
  if (typeof p.id !== "number" || typeof p.pass !== "boolean") throw badBacklog("id and pass are required");
  requireEngine().review(p.id, p.pass, typeof p.note === "string" && p.note.trim() !== "" ? p.note.trim() : null);
  return { ok: true };
});

/** 用户在清单上点「立即执行」——按钮本身即确认动作（与 automation.runNow 同口径） */
registerMethod("backlog.runNow", (params) => {
  const p = (params ?? {}) as { id?: number; runtimeId?: string; model?: string | null };
  if (typeof p.id !== "number") throw badBacklog("id is required");
  const hit = store.getBacklogItem(p.id);
  if (hit === undefined) throw Object.assign(new Error(`没有这个待办：${p.id}`), { code: "unknown_item" });
  if (hit.status === "executing") throw badBacklog("这条待办已在执行中");
  const runtimeId = typeof p.runtimeId === "string" && p.runtimeId !== "" ? p.runtimeId : hit.runtimeId;
  if (runtimeId === undefined || runtimeId === "") throw badBacklog("没有配置执行器 —— 先编辑待办选一个，或在弹窗里选");
  const model = p.model !== undefined ? (typeof p.model === "string" && p.model !== "" ? p.model : null) : hit.model;
  return requireEngine().dispatch(hit, runtimeId, model, "manual");
});

registerMethod("backlog.config.get", () => getBacklogConfig(store));
registerMethod("backlog.config.set", (params) => {
  const p = (params ?? {}) as { patch?: unknown };
  const next = setBacklogConfig(store, p.patch);
  return { config: next };
});

registerMethod("backlog.quotas", async (params) => {
  const p = (params ?? {}) as { refresh?: boolean };
  return { quotas: await requireEngine().quotas(p.refresh === true) };
});

// 续跑判定快照：给前端解释「为什么现在有 / 没有那条续跑任务」。
// 只读，不触发探测 —— 想强制刷新走 backlog.quotas 的 refresh。
registerMethod("quotaResume.state", () => {
  const cfg = getBacklogConfig(store);
  return { enabled: cfg.quotaResume.enabled, config: cfg.quotaResume, states: quotaResumeWatcher.snapshot() };
});

registerMethod("backlog.state.forceBusy", (params) => {
  const p = (params ?? {}) as { on?: boolean };
  if (typeof p.on !== "boolean") throw badBacklog("on is required");
  requireEngine().setForceBusy(p.on);
  return { ok: true, snapshot: requireEngine().snapshot() };
});

/** 手动触发一跳（测试/演示）：跳过周期与空闲判定，其余护栏（单飞/强制忙碌）照旧。
 * 受理即返 —— 跳动本身要跑一个心跳会话（几十秒），结果从 state/items 信号帧观察。 */
registerMethod("backlog.heartbeat.force", () => {
  void requireEngine().forceBeat();
  return { started: true };
});

registerMethod("backlog.consolidate.run", (params) => {
  const p = (params ?? {}) as { force?: boolean };
  return requireEngine().consolidate(p.force !== false);
});



// ---- 记忆方法（docs/10）-----------------------------------------------------
//
// 旧的 memory.save/search/list（Phase 7 三柱 + sqlite 路由）保留在下面继续可用，
// 但**新记忆系统不走它**：项目记忆是文件（memory.project.*），跨会话检索是
// 现场扫源目录（memory.searchAll / steward.search）。保留旧方法是刻意的 ——
// 前端还在用，且 `memory.weknora` 配置 v2 要接着用。

registerMethod("memory.project.read", (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath !== "string" || p.rootPath === "") throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  return readLongTerm(p.rootPath);
});
registerMethod("memory.project.write", (params) => {
  const p = (params ?? {}) as { rootPath?: string; content?: string };
  if (typeof p.rootPath !== "string" || typeof p.content !== "string") {
    throw Object.assign(new Error("rootPath and content are required"), { code: "bad_params" });
  }
  return writeLongTerm(p.rootPath, p.content, { homeDir: config.homeDir });
});
registerMethod("memory.project.daily", (params) => {
  const p = (params ?? {}) as { rootPath?: string; date?: string; limit?: number };
  if (typeof p.rootPath !== "string") throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  if (typeof p.date === "string" && p.date !== "") return readDaily(p.rootPath, p.date);
  return listDaily(p.rootPath);
});

// ---- USER.md 全局层（ADR 0014 D5）：关于「人」的 evergreen 文件，逐 bot 开关注入 ----

registerMethod("context.user.read", () => readUser(config.homeDir));
registerMethod("context.user.write", (params) => {
  const p = (params ?? {}) as { content?: string };
  if (typeof p.content !== "string") {
    throw Object.assign(new Error("content is required"), { code: "bad_params" });
  }
  return writeUser(config.homeDir, p.content);
});

// ---- STANDING.md（上下文编辑器的写路径；备份 + 1000 上限硬校验，与 MEMORY 同纪律）----

registerMethod("memory.standing.read", (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath !== "string" || p.rootPath === "") throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  return readStanding(p.rootPath);
});
registerMethod("memory.standing.write", (params) => {
  const p = (params ?? {}) as { rootPath?: string; content?: string };
  if (typeof p.rootPath !== "string" || typeof p.content !== "string") {
    throw Object.assign(new Error("rootPath and content are required"), { code: "bad_params" });
  }
  return writeStanding(p.rootPath, p.content, { homeDir: config.homeDir });
});

/** 后台守护引擎配置获取与更新 */
registerMethod("memory.guardian.get", () => {
  return getGuardianConfig(store);
});
registerMethod("memory.guardian.set", (params) => {
  const patch = (params ?? {}) as Partial<MemoryGuardianConfig>;
  return setGuardianConfig(store, patch);
});

/** 记忆超限自愈合并执行 */
registerMethod("memory.consolidate", async (params) => {
  const p = (params ?? {}) as { rootPath?: string; force?: boolean };
  if (typeof p.rootPath !== "string" || p.rootPath === "") {
    throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  }
  const guardianCfg = getGuardianConfig(store);
  return maybeConsolidate(p.rootPath, guardianCfg, { homeDir: config.homeDir, force: p.force === true });
});

/** 分发日志：这一轮注入了什么（docs/10 §5 UI 要的那一屏） */
registerMethod("memory.dispatches", (params) => {
  const p = (params ?? {}) as { sessionId?: string };
  if (typeof p.sessionId !== "string" || p.sessionId === "") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  return store.listDispatches(p.sessionId);
});

/** 跨会话追溯搜索。权限在这一层钉死（docs/10 红线 6）。 */
registerMethod("steward.search", async (params) => {
  const p = (params ?? {}) as {
    botId?: string; query?: string; limit?: number; pathHint?: string; withContext?: boolean; halfLifeDays?: number;
    sinceDays?: number; maxBytesPerCli?: number;
  };
  if (typeof p.query !== "string" || p.query.trim() === "") throw Object.assign(new Error("query is required"), { code: "bad_params" });

  // 身份解析有三种情况，**不能混**：
  // - 不给 botId            → 这是工作台自身的调用（设置页试跑等），按管家算
  // - 给了 botId 且查得到   → 按该 bot 定义判权限
  // - 给了 botId 但查不到   → **拒绝**。曾在这里回落成管家，等于「报个不存在的
  //                           bot 名就能拿到跨项目检索权」——冒烟抓出来的真漏洞。
  let requester: Record<string, unknown>;
  if (typeof p.botId !== "string" || p.botId === "") {
    requester = { id: STEWARD_ID, role: STEWARD_ID, crossSearch: true };
  } else {
    const def = await botRegistry.getBot(p.botId);
    if (def === undefined) {
      throw Object.assign(new Error(`没有这个 bot：${p.botId}`), { code: "unknown_bot" });
    }
    requester = def;
  }

  // 交互式搜索**必须有时间窗和字节上限**。
  //
  // 实测代价（2026-10-04，本机 1.6 GB 语料）：无索引的全量扫描是真花钱的 ——
  // JSON.parse + 切块 + bigram，单次全量能吃掉几分钟 CPU。所以默认值取
  // 「够快」而不是「够全」：
  //   - since 默认 365 天前（mtime 预筛直接跳过老文件，比全量快两个数量级）
  //   - 每家 128 MB 上限（4 家合计 512 MB 是解析成本的红线）
  // 想要更多就把 sinceDays / maxBytesPerCli 显式调大 —— 那是用户的选择，
  // 不该由默认值替他承担。
  const sinceDays = p.sinceDays ?? 365;
  const maxBytesPerCli = p.maxBytesPerCli ?? 128 * 1024 * 1024;

  return stewardSearch(requester, {
    query: p.query,
    since: Date.now() - sinceDays * 86_400_000,
    limitBytesPerCli: maxBytesPerCli,
    ...(p.limit === undefined ? {} : { limit: p.limit }),
    ...(p.pathHint === undefined ? {} : { pathHint: p.pathHint }),
    withContext: p.withContext === true,
    ...(p.halfLifeDays === undefined ? {} : { halfLifeDays: p.halfLifeDays }),
  });
});
registerMethod("steward.recent", () => stewardRecent(config.homeDir));

// ---- curator（docs/10 §4.7）------------------------------------------------

/** 记忆条目的遥测视图（curator 的判断依据，也是 UI 要显示的「多久没用了」）。 */
registerMethod("memory.telemetry", (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath === "string" && p.rootPath !== "") return store.listMemoryMeta(p.rootPath);
  return store.listMemoryMeta();
});

registerMethod("curator.run", async (params) => {
  const p = (params ?? {}) as {
    rootPath?: string; dryRun?: boolean; now?: number;
    intervalHours?: number; minIdleHours?: number; staleAfterDays?: number; archiveAfterDays?: number;
  };
  const rootPath = typeof p.rootPath === "string" && p.rootPath !== "" ? p.rootPath : stewardRoot(config.homeDir);
  const cfg: CuratorConfig = {
    ...DEFAULT_CURATOR,
    ...(p.dryRun === undefined ? {} : { dryRun: p.dryRun }),
    ...(p.intervalHours === undefined ? {} : { intervalHours: p.intervalHours }),
    ...(p.minIdleHours === undefined ? {} : { minIdleHours: p.minIdleHours }),
    ...(p.staleAfterDays === undefined ? {} : { staleAfterDays: p.staleAfterDays }),
    ...(p.archiveAfterDays === undefined ? {} : { archiveAfterDays: p.archiveAfterDays }),
  };
  const r = await runCurator(
    rootPath,
    { meta: new DbMetaStore(store), homeDir: config.homeDir },
    cfg,
    p.now === undefined ? {} : { now: p.now },
  );
  // 报告落盘（hermes 做法）：run.json 机器可读 + REPORT.md 人读
  try {
    const dir = path.join(config.homeDir, "logs", "curator", new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "run.json"), JSON.stringify(r, null, 2), "utf8");
    await writeFile(path.join(dir, "REPORT.md"), renderReport(r, cfg), "utf8");
    return { ...r, reportDir: dir };
  } catch (err: unknown) {
    log.warn("curator report write failed", { error: err instanceof Error ? err.message : String(err) });
    return r;
  }
});

/** 每日总结任务（docs/10 §4.5）。dryRun=true 时只报不写。 */
registerMethod("memory.digest.run", async (params) => {
  const p = (params ?? {}) as { date?: string; dryRun?: boolean; force?: boolean };
  const digest = new DailyDigest(config.homeDir, { knownProjects: botRegistry.roots() });
  return digest.run({
    ...(p.date === undefined ? {} : { date: p.date }),
    ...(p.dryRun === undefined ? {} : { dryRun: p.dryRun }),
    ...(p.force === undefined ? {} : { force: p.force }),
  });
});

registerMethod("memory.save", (params) => {
  const p = (params ?? {}) as { pillar?: string; content?: string; source?: string; backends?: string[] };
  if (typeof p.pillar !== "string" || typeof p.content !== "string") {
    throw Object.assign(new Error("pillar and content are required"), { code: "bad_params" });
  }
  return memory.save({ pillar: p.pillar as never, content: p.content, source: p.source, backends: p.backends as never });
});
registerMethod("memory.search", (params) => {
  const p = (params ?? {}) as { query?: string; pillars?: string[]; backends?: string[]; topK?: number };
  if (typeof p.query !== "string") throw Object.assign(new Error("query is required"), { code: "bad_params" });
  return memory.search({ query: p.query, pillars: p.pillars as never, backends: p.backends as never, topK: p.topK });
});
registerMethod("memory.list", (params) => {
  const p = (params ?? {}) as { pillar?: string };
  if (typeof p.pillar !== "string") throw Object.assign(new Error("pillar is required"), { code: "bad_params" });
  return memory.list(p.pillar as never);
});
// ---- Bot 注册表（docs/08 WP-5）：bot 定义的落盘面 <rootPath>/.agent-workbench/bot.json ----
registerMethod("bot.put", (params) => {
  const p = (params ?? {}) as {
    unit?: Record<string, unknown>;
    ifRevision?: number;
    ifAgentsMdHash?: string;
    /** SOUL.md 内容 hash 乐观锁（ADR 0014 D5，与 ifAgentsMdHash 同构） */
    ifSoulMdHash?: string;
    /** 自动安置（ADR 0011）：rootPath 不存在时幂等创建。只给新建流用。 */
    createRoot?: boolean;
  };
  if (p.unit === undefined || typeof p.unit !== "object") {
    throw Object.assign(new Error("unit is required"), { code: "bad_params" });
  }
  const opts: { ifRevision?: number; ifAgentsMdHash?: string; ifSoulMdHash?: string; createRoot?: boolean } = {};
  if (typeof p.ifRevision === "number") opts.ifRevision = p.ifRevision;
  if (typeof p.ifAgentsMdHash === "string") opts.ifAgentsMdHash = p.ifAgentsMdHash;
  if (typeof p.ifSoulMdHash === "string") opts.ifSoulMdHash = p.ifSoulMdHash;
  if (p.createRoot === true) opts.createRoot = true;
  return botRegistry.putBot(p.unit, opts);
});
// 自动安置默认位置（ADR 0011 第 4 条）：新建对话框打开时要的预填值。
// 默认根 <homeDir>/bots 幂等创建并登记扫描根（新 bot 天然可被 bot.list 扫出）；
// browseRoots 是目录浏览器的起始根候选（homeDir + 盘符根），浏览本身复用
// workspace.paths.list 的防逃逸约束（rootPath 参数本身可为任意存在的目录）。
registerMethod("bot.defaultRoot", async () => {
  const placement = await botRegistry.defaultPlacement(config.homeDir);
  return { ...placement, browseRoots: browseRootCandidates(config.homeDir) };
});
/** 目录浏览器的起始根候选：homeDir + 各盘符根（win32 探测存在性；其他平台给 /） */
function browseRootCandidates(homeDir: string): string[] {
  const roots = [homeDir];
  if (process.platform === "win32") {
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (existsSync(drive)) roots.push(drive);
    }
  } else {
    roots.push("/");
  }
  return [...new Set(roots)];
}
// 渠道连通性诊断（向导第三步 / docs/09 §五）。配错了以前只有一行 warn，
// 界面上表现为「绑了没反应」，两边对不上。
registerMethod("channel.diagnose", async (params) => {
  const p = (params ?? {}) as { botId?: string; accountId?: string };
  if (typeof p.botId !== "string" || p.botId === "") {
    throw Object.assign(new Error("botId is required"), { code: "bad_params" });
  }
  const specs = feishuGateway.specsOf(p.botId);
  const one = p.accountId === undefined ? (specs[0] ?? null) : feishuGateway.specOf(p.botId, p.accountId);
  if (one === null) {
    throw Object.assign(
      new Error(`bot ${p.botId} 没有可诊断的飞书账号（没配 profile / 已停用）`),
      { code: "no_channel" },
    );
  }
  return diagnoseLarkAccount(one);
});
// 主动出站：让 bot 主动开口（日报、告警、自动化结果）。之前只有回程。
registerMethod("channel.send", async (params) => {
  const p = (params ?? {}) as { botId?: string; accountId?: string; receiveId?: string; text?: string };
  if (typeof p.botId !== "string" || p.botId === "") throw Object.assign(new Error("botId is required"), { code: "bad_params" });
  if (typeof p.receiveId !== "string" || p.receiveId === "") throw Object.assign(new Error("receiveId (chat_id) is required"), { code: "bad_params" });
  if (typeof p.text !== "string" || p.text === "") throw Object.assign(new Error("text is required"), { code: "bad_params" });
  return feishuGateway.sendTo(p.botId, p.accountId ?? "main", p.receiveId, p.text);
});
registerMethod("bot.list", (params) => {
  const p = (params ?? {}) as { includeUnregistered?: boolean };
  return botRegistry.listBots(p);
});
registerMethod("bot.unregister", async (params) => {
  const p = (params ?? {}) as { id?: string };
  if (typeof p.id !== "string" || p.id === "") throw Object.assign(new Error("id is required"), { code: "bad_params" });
  return botRegistry.unregisterBot(p.id);
});
registerMethod("bot.initWorkspace", async (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath !== "string" || p.rootPath === "") throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  return botRegistry.initWorkspace(p.rootPath);
});
// ---- 外观（appearance）—— <homeDir>/appearance.json，用户可让 agent 直接改这个文件 ----
registerMethod("appearance.read", async () => {
  const meta = await readAppearance(config.homeDir);
  // 壁纸 / logo / 自定义预设主题 单独带回来：图不进 JSON，主题独立存储在 themes/ 目录
  const [wallpaperDataUrl, logoDataUrl, themes] = meta.exists
    ? await Promise.all([
        readWallpaperDataUrl(config.homeDir, meta.wallpaperRel),
        readLogoDataUrl(config.homeDir, meta.logoRel),
        listThemes(config.homeDir),
      ])
    : [null, null, await listThemes(config.homeDir)];
  return { ...meta, wallpaperDataUrl, logoDataUrl, themes };
});
registerMethod("appearance.write", async (params) => {
  const p = (params ?? {}) as { content?: string; expectedHash?: string | null };
  if (typeof p.content !== "string") {
    throw Object.assign(new Error("content is required"), { code: "bad_params" });
  }
  return writeAppearance(config.homeDir, p.content, { expectedHash: p.expectedHash ?? null });
});
// 落一张壁纸到 <homeDir>/wallpapers/，返回该写进 appearance.json 的 wallpaper.path
registerMethod("appearance.wallpaper.save", async (params) => {
  const p = (params ?? {}) as { name?: string; base64?: string };
  if (typeof p.name !== "string" || typeof p.base64 !== "string") {
    throw Object.assign(new Error("name and base64 are required"), { code: "bad_params" });
  }
  return saveWallpaper(config.homeDir, p.name, Buffer.from(p.base64, "base64"));
});
registerMethod("appearance.wallpaper.delete", async (params) => {
  const p = (params ?? {}) as { path?: string };
  return { deleted: await deleteWallpaper(config.homeDir, p.path ?? null) };
});
// 自定义 logo 同一套口径：<homeDir>/logos/，appearance.json 里只记 logo.path
registerMethod("appearance.logo.save", async (params) => {
  const p = (params ?? {}) as { name?: string; base64?: string };
  if (typeof p.name !== "string" || typeof p.base64 !== "string") {
    throw Object.assign(new Error("name and base64 are required"), { code: "bad_params" });
  }
  return saveLogo(config.homeDir, p.name, Buffer.from(p.base64, "base64"));
});
registerMethod("appearance.logo.delete", async (params) => {
  const p = (params ?? {}) as { path?: string };
  return { deleted: await deleteLogo(config.homeDir, p.path ?? null) };
});
// 预设主题列表与新建保存：文件落到 <homeDir>/themes/*.json，agent 可直接改
registerMethod("appearance.theme.list", async () => {
  return listThemes(config.homeDir);
});
registerMethod("appearance.theme.save", async (params) => {
  const p = (params ?? {}) as { preset?: any };
  const preset = p.preset ?? p;
  return saveTheme(config.homeDir, preset);
});
registerMethod("appearance.theme.delete", async (params) => {
  const p = (params ?? {}) as { id?: string };
  if (typeof p.id !== "string" || !p.id) {
    throw Object.assign(new Error("id is required"), { code: "bad_params" });
  }
  return { deleted: await deleteTheme(config.homeDir, p.id) };
});
// ---- 出图供应商 profile —— <homeDir>/image-profiles.json，密钥永不下发浏览器 ----
registerMethod("image.profiles.list", () => {
  return imageProfiles.listMasked();
});
registerMethod("image.profiles.put", (params) => {
  const p = (params ?? {}) as Partial<ImageProfileRow> & { id?: string };
  if (typeof p.id !== "string" || p.id === "") {
    throw Object.assign(new Error("id is required"), { code: "bad_params" });
  }
  return imageProfiles.put(p as Partial<ImageProfileRow> & { id: string });
});
registerMethod("image.profiles.delete", (params) => {
  const p = (params ?? {}) as { id?: string };
  if (typeof p.id !== "string" || p.id === "") {
    throw Object.assign(new Error("id is required"), { code: "bad_params" });
  }
  return { deleted: imageProfiles.delete(p.id) };
});
// 目录探测（docs/09 §七 P0-B）：纯读，导入对话框三分支全靠它决定
registerMethod("bot.inspect", (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath !== "string" || p.rootPath === "") {
    throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  }
  return botRegistry.inspect(p.rootPath);
});
// bot.json 里有渠道密钥时，导入一个 git 仓库前必须能一键补 .gitignore
registerMethod("bot.gitignore.ensure", (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath !== "string" || p.rootPath === "") {
    throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  }
  return botRegistry.ensureGitignore(p.rootPath);
});

// ---- git.* —— 源代码管理面板（分支 / 工作树），见 backend/src/git/repo.ts ----
// 分支面对齐 ZCode 窄模型（ADR 0009）：只做列出 / 新建即切换 / 切换；合并、
// 改名、删除留给终端。危险操作的错误码约定（UI 据此走确认流）：
// worktree_dirty → 确认后 force=true 重试；branch_checked_out_elsewhere 带
// data.path → 引导打开那个工作树。全表见 docs/07-wire-protocol.md。

function gitRoot(params: unknown): string {
  const p = (params ?? {}) as { rootPath?: string };
  if (typeof p.rootPath !== "string" || p.rootPath === "") {
    throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  }
  return p.rootPath;
}

/** 必填字符串参数的统一校验：四个 git.* 方法共用，别再复制粘贴四行块 */
function reqStr(params: unknown, key: string): string {
  const p = (params ?? {}) as Record<string, unknown>;
  const v = p[key];
  if (typeof v !== "string" || v === "") {
    throw Object.assign(new Error(`${key} is required`), { code: "bad_params" });
  }
  return v;
}

/** 可选字符串参数：给了就必须是 string（数字混进来会在 spawn 里炸成误导性的 git_unavailable） */
function optStr(params: unknown, key: string): string | undefined {
  const p = (params ?? {}) as Record<string, unknown>;
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw Object.assign(new Error(`${key} must be a string`), { code: "bad_params" });
  }
  return v.trim() === "" ? undefined : v;
}

/** 必填字符串数组参数：提交面（stage / unstage / commit）按路径操作，成批传 */
function reqStrArray(params: unknown, key: string): string[] {
  const p = (params ?? {}) as Record<string, unknown>;
  const v = p[key];
  if (!Array.isArray(v) || v.length === 0 || v.some((e) => typeof e !== "string" || e === "")) {
    throw Object.assign(new Error(`${key} must be a non-empty string array`), { code: "bad_params" });
  }
  return v as string[];
}

// git 状态自动刷新（docs/16）：status 心跳到达过的仓库自动挂文件监听，
// 变化经节流广播 git.changed（无 sessionId 的 RuntimeEvent，仓库级）。
// seq 用独立计数器 —— git 事件不参与会话内 seq 判重补拉，消费方直取。
let gitWatcherSeq = 0;
const gitWatcher = new GitWatcher((rootPath) => {
  broadcastEvent(wss, { type: "git.changed", rootPath }, ++gitWatcherSeq);
  notifications.recordGitChanged(rootPath);
});

registerMethod("git.status", async (params) => {
  const result = await gitRepo.status(gitRoot(params));
  // isRepo 才监听：非仓库目录没有状态可刷新（诚实缺席，见 repo.ts status 注释）
  if (result.isRepo) void gitWatcher.ensure(gitRoot(params));
  return result;
});
registerMethod("git.branches.list", (params) => gitRepo.listBranches(gitRoot(params)));
registerMethod("git.branch.create", (params) =>
  gitRepo.createBranch(gitRoot(params), reqStr(params, "name"), { ref: optStr(params, "ref") }),
);
registerMethod("git.branch.checkout", (params) => gitRepo.checkoutBranch(gitRoot(params), reqStr(params, "name")));
registerMethod("git.worktrees.list", async (params) => ({ worktrees: await gitRepo.listWorktrees(gitRoot(params)) }));
registerMethod("git.worktree.create", (params) => {
  const spec = {
    path: optStr(params, "path"),
    branch: optStr(params, "branch"),
    commitish: optStr(params, "commitish"),
  };
  if (spec.branch === undefined && spec.commitish === undefined) {
    throw Object.assign(new Error("branch or commitish is required"), { code: "bad_params" });
  }
  return gitRepo.createWorktree(gitRoot(params), spec);
});
registerMethod("git.worktree.remove", (params) => {
  const force = (params as { force?: unknown } | null)?.force;
  if (force !== undefined && typeof force !== "boolean") {
    throw Object.assign(new Error("force must be a boolean"), { code: "bad_params" });
  }
  const root = gitRoot(params);
  const target = reqStr(params, "path");
  // 活跃会话防拆在 RPC 侧兜底：UI 用自己的会话表拦的只是第一道闸，自动化 /
  // IM 渠道开的会话不在 UI 台账里。Session.rootPath 是会话实际 cwd（契约字段），
  // 路径比对归一分隔符与大小写（Windows 路径大小写不敏感）。
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const targetNorm = norm(target);
  const live = host
    .listSessions()
    .find(
      (s) =>
        s.status !== "done" &&
        s.status !== "failed" &&
        s.rootPath !== undefined &&
        s.rootPath.length > 0 &&
        norm(s.rootPath) === targetNorm,
    );
  if (live) {
    throw Object.assign(
      new Error(`会话「${live.title}」正在此工作树中运行，先停止或等它结束再删除（强删会直接拔掉执行器的工作目录）`),
      { code: GIT_ERROR_CODES.worktreeInUse, data: { sessionId: live.id, rootPath: live.rootPath } },
    );
  }
  return gitRepo.removeWorktree(root, target, force === true);
});
// 在系统文件管理器里显示目录（资源管理器 / Finder / xdg-open）
registerMethod("git.worktree.reveal", (params) => gitRepo.revealPath(reqStr(params, "path")));

// 提交面（ADR 0010，从 ADR 0008 的「v1 不做清单」转正）：
// 改了什么 = changes / diff，要不要落库 = stage / unstage / commit / push / identity。
// discard（丢改动）不做 —— 不可逆且无安全网，等 checkpoint 路线。错误码约定
// （UI 据此走确认流与警告条）：nothing_to_commit / identity_missing /
// push_rejected（data.detail 带远端原话）/ no_remote。全表见 docs/07-wire-protocol.md。
registerMethod("git.changes", (params) => gitRepo.changes(gitRoot(params)));
registerMethod("git.diff", (params) =>
  gitRepo.diff(gitRoot(params), reqStr(params, "path"), reqStr(params, "sourceId") as "staged" | "unstaged"),
);
registerMethod("git.stage", (params) => gitRepo.stagePaths(gitRoot(params), reqStrArray(params, "paths")));
registerMethod("git.unstage", (params) => gitRepo.unstagePaths(gitRoot(params), reqStrArray(params, "paths")));
registerMethod("git.commit", (params) => {
  const p = (params ?? {}) as { message?: unknown; paths?: unknown; stagedOnly?: unknown };
  if (typeof p.message !== "string") throw Object.assign(new Error("message must be a string"), { code: "bad_params" });
  if (p.stagedOnly !== undefined && typeof p.stagedOnly !== "boolean") {
    throw Object.assign(new Error("stagedOnly must be a boolean"), { code: "bad_params" });
  }
  return gitRepo.commitChanges(gitRoot(params), {
    message: p.message,
    paths: Array.isArray(p.paths) ? p.paths.filter((v): v is string => typeof v === "string") : [],
    ...(p.stagedOnly !== undefined ? { stagedOnly: p.stagedOnly } : {}),
  });
});
registerMethod("git.push", (params) => gitRepo.push(gitRoot(params), optStr(params, "remote")));
registerMethod("git.identity", (params) => gitRepo.identity(gitRoot(params)));

// 提交图（docs/16，ZCode GitGraph 同款数据面）：可见历史分页 + 每条提交的
// parents / refs（%D 解析），前端据此画泳道。unborn 仓库返回空列表。
registerMethod("git.graph", (params) => {
  const p = (params ?? {}) as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const v = p[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw Object.assign(new Error(`${key} must be a finite number`), { code: "bad_params" });
    }
    return v;
  };
  return gitRepo.graph(gitRoot(params), { skip: num("skip"), maxCount: num("maxCount") });
});

// ---- workspace.paths.list —— 对话输入 @ 提及的工作区路径建议 ----------------
// 移植 ZCode 的 file-mention provider：一次列一层目录，token 带 `/` 时前半段
// 定位目录。安全闸（绝对路径 / .. / 越出 rootPath 一律空清单）在
// workspacePaths.ts 内实现；目录读不到返回空清单而非报错，菜单不该空转报错。
registerMethod("workspace.paths.list", (params) => {
  const p = (params ?? {}) as { rootPath?: unknown; token?: unknown; limit?: unknown };
  if (typeof p.rootPath !== "string" || p.rootPath === "") {
    throw Object.assign(new Error("rootPath is required"), { code: "bad_params" });
  }
  if (typeof p.token !== "string") {
    throw Object.assign(new Error("token is required"), { code: "bad_params" });
  }
  const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : undefined;
  return listWorkspacePaths(p.rootPath, p.token, limit);
});

// 渠道运行态：bot.json 声明了什么 vs 网关实际起没起。docs/09 §五的状态徽标要靠它
registerMethod("channel.status", async () => {
  const bots = await botRegistry.listBots();
  return {
    // 各网关当前真正持有的账号数
    gateways: {
      feishu: feishuGateway.activeAccounts,
      telegram: telegramGateway.activeAccountCount,
      weixin: weixinGateway.activeAccountCount,
      discord: discordGateway.activeAccountCount,
    },
    bots: bots.map((b) => {
      const declared = Array.isArray(b.channels) ? (b.channels as Array<Record<string, unknown>>) : [];
      return {
        id: String(b.id ?? ""),
        channels: declared.map((c) => ({
          kind: String(c["kind"] ?? ""),
          enabled: c["enabled"] === true,
          accounts: Array.isArray(c["accounts"]) ? (c["accounts"] as unknown[]).length : 0,
        })),
      };
    }),
  };
});

// 网卡拓扑探测（配对码与远程控制用）
registerMethod("network.interfaces", () => ({ interfaces: getNetworkInterfaces() }));

// 微信 iLink 扫码登录流程
registerMethod("channel.weixin.qr.begin", () => beginWeixinLogin());
registerMethod("channel.weixin.qr.poll", async (params) => {
  const p = (params ?? {}) as { qrCode?: string; botId?: string };
  if (!p.qrCode) throw Object.assign(new Error("qrCode is required"), { code: "bad_params" });
  const result = await pollWeixinLogin(p.qrCode);
  if (result.status === "success" && p.botId) {
    await credentialVault.save(`weixin:${p.botId}`, result.botToken, {
      botId: p.botId,
      ilinkBotId: result.botId,
    });
  }
  return result;
});
// 「这个 bot 接的是哪个飞书机器人」——名字 + 头像，不是 profile 字符串。
// profile 形如 cli_a94d…，界面上没人认得出那是哪个机器人。
registerMethod("channel.identity", async (params) => {
  const p = (params ?? {}) as { profiles?: unknown };
  // 设置页正在配、还没保存的草稿 profile 也要能认：显式传 profiles 走这条
  if (Array.isArray(p.profiles)) {
    return larkIdentities(p.profiles.filter((x): x is string => typeof x === "string"));
  }
  // 不传参数 = 盘上所有启用的飞书账号。走网关的规格表而不是 raw bot.json：
  // 那张表已经滤掉了没 profile 的旧格式账号，认它们只会得到一片报错
  const bots = await botRegistry.listBots();
  const profiles: string[] = [];
  for (const b of bots) {
    for (const s of feishuGateway.specsOf(String(b.id ?? ""))) profiles.push(s.profile);
  }
  return larkIdentities(profiles);
});
// 绑定向导的「本机有哪些飞书机器人」。profile list 的字段用户没法用来指认，
// 所以逐个认过脸再回——界面上才是能点的「飞书 CLI」「日报助手」而不是一串 ID。
registerMethod("channel.profiles", () => larkProfileList());
// 建一个新机器人（= 加一个 lark-cli profile）。
// ⚠ appSecret 走 stdin 交给 lark-cli，不进 argv、不落盘到本仓库、不回传、
// 不写日志。lark-cli 自己把它存进系统钥匙串，config.json 里只留一个句柄。
// 一次调用就把「写盘结果 + 认脸结果」一起返回：CLI 写盘成功**不代表**机器人能用，
// 界面没有机会只显示「创建成功」就骗过去。
registerMethod("channel.profile.add", (params) => {
  const p = (params ?? {}) as { name?: unknown; appId?: unknown; appSecret?: unknown };
  if (typeof p.name !== "string" || typeof p.appId !== "string" || typeof p.appSecret !== "string") {
    throw Object.assign(new Error("name / appId / appSecret are required"), { code: "bad_params" });
  }
  return addLarkProfile({ name: p.name, appId: p.appId, appSecret: p.appSecret });
});
registerMethod("bot.roots.add", (params) => {
  const p = (params ?? {}) as { dir?: string };
  if (typeof p.dir !== "string" || p.dir === "") throw Object.assign(new Error("dir is required"), { code: "bad_params" });
  botRegistry.addRoot(p.dir);
  return { roots: botRegistry.roots() };
});
// 把一条文本交给 bot 并等轮落定拿回全文（WP-9：MCP ask_bot / webhook 的内核入口）
registerMethod("bot.ask", (params) => {
  const p = (params ?? {}) as {
    botId?: string;
    text?: string;
    waitMs?: number;
    memoryOptions?: {
      scopes?: readonly ("semantic" | "daily" | "procedural")[];
      dailyDate?: string;
      dailyLimit?: number;
    };
  };
  if (typeof p.botId !== "string" || typeof p.text !== "string") {
    throw Object.assign(new Error("botId and text are required"), { code: "bad_params" });
  }
  // 评审 P3：waitMs 设上限，防误设大值无限占住 WS RPC
  const waitMs = typeof p.waitMs === "number" ? Math.min(Math.max(p.waitMs, 1_000), 600_000) : undefined;
  return askBot(botRegistry, host, p.botId, p.text, { waitMs, source: "webhook", memoryOptions: p.memoryOptions });
});

registerMethod("memory.routing.get", () => memory.getRouting());
registerMethod("memory.routing.set", (params) => {
  const p = (params ?? {}) as { routing?: Record<string, string[]> };
  if (p.routing === undefined || typeof p.routing !== "object") {
    throw Object.assign(new Error("routing is required"), { code: "bad_params" });
  }
  return memory.setRouting(p.routing as never);
});
registerMethod("memory.weknora.config.get", () => memory.weknoraGetConfig());
registerMethod("memory.weknora.config.set", (params) => {
  const p = (params ?? {}) as { baseUrl?: string; apiKey?: string; kbIds?: string[] };
  if (typeof p.baseUrl !== "string") throw Object.assign(new Error("baseUrl is required"), { code: "bad_params" });
  memory.weknoraSetConfig({ baseUrl: p.baseUrl, apiKey: p.apiKey, kbIds: p.kbIds });
  return memory.weknoraGetConfig();
});
registerMethod("memory.mirror", () => memory.readMirror());

registerMethod("adapter.list", (params) => {
  const p = params as { sync?: boolean } | null;
  return host.listAdapters(p?.sync ?? false);
});
registerMethod("adapter.probe", (params) => {
  const { runtimeId } = (params ?? {}) as { runtimeId?: string };
  if (typeof runtimeId !== "string") throw Object.assign(new Error("runtimeId is required"), { code: "bad_params" });
  return host.probe(runtimeId);
});
/**
 * 模型清单刷新 —— 「重新探测模型」按钮的落点，与 adapter.probe **互不相干**。
 *
 * 返回值同时给两份：刷新报告（谁是真探到的、谁退回了兜底）+ 刷新后的完整适配器清单。
 * 一次往返就能把界面更新到位，不必让前端再补一次 adapter.list（那个接口的 models
 * 是注册时的快照，正是「后端刷了、界面不更新」这个老 bug 的根源）。
 *
 * 零用量：这条路径只跑各 CLI 的只读列清单命令或读本地目录文件，不发 prompt、不起 turn。
 */
registerMethod("adapter.models", async (params) => {
  const { runtimeId } = (params ?? {}) as { runtimeId?: string };
  if (runtimeId !== undefined && typeof runtimeId !== "string") {
    throw Object.assign(new Error("runtimeId must be a string when provided"), { code: "bad_params" });
  }
  const report = await host.syncModels(runtimeId);
  return { report, adapters: await host.listAdapters(false) };
});
/**
 * 执行器新版本检测（docs/27）：current 由前端传入（裸执行器 id → 版本串，只放
 * ready 的——探测状态活在前端注册表，daemon 不做启动探测）。daemon 查 npm/PyPI
 * latest（缓存 1h，force 直查）做启发式 semver 比对。升级动作不在这里——
 * 设置页「升级」按钮仍派发终端命令（PROVIDER_INSTALL_GUIDES 是命令事实源）。
 */
registerMethod("adapter.updates", async (params) => {
  const p = (params ?? {}) as { force?: boolean; current?: Record<string, unknown> | null };
  const current: Record<string, string> = {};
  if (p.current !== null && typeof p.current === "object") {
    for (const [k, v] of Object.entries(p.current)) {
      if (typeof v === "string" && v !== "") current[k.replace(/^daemon:/, "").toLowerCase()] = v;
    }
  }
  return executorUpdates.check(current, p.force === true);
});

/**
 * 执行器原生模型默认值（设置页「写入 CLI 自己的配置」分区）—— cc-switch 同思路：
 * 字段级补丁进 CLI 的配置文件（claude settings.json / codex config.toml），
 * 其余用户配置一律不动。get 不抛 unsupported —— 「没有可写面」是正常态。
 */
registerMethod("adapter.modeldefaults.get", (params) => {
  const { runtimeId } = (params ?? {}) as { runtimeId?: string };
  if (typeof runtimeId !== "string") throw Object.assign(new Error("runtimeId is required"), { code: "bad_params" });
  return host.readModelDefaults(runtimeId);
});

/**
 * 写模型默认值并**顺带刷一次该执行器的模型清单**：claude 的清单就住在
 * settings.json 里（syncModels 读同一份文件），写完不刷的话界面还是旧世界，
 * 「保存了却没生效」的观感正是这次要消灭的。codex 刷的是 debug models，
 * 与配置无关，刷一下也无害（只读命令）。
 */
registerMethod("adapter.modeldefaults.set", async (params) => {
  const p = (params ?? {}) as { runtimeId?: string; values?: Record<string, string> };
  if (typeof p.runtimeId !== "string") throw Object.assign(new Error("runtimeId is required"), { code: "bad_params" });
  if (typeof p.values !== "object" || p.values === null) {
    throw Object.assign(new Error("values is required"), { code: "bad_params" });
  }
  const config = host.writeModelDefaults(p.runtimeId, p.values);
  const report = await host.syncModels(p.runtimeId);
  return { config, report: [...report], adapters: await host.listAdapters(false) };
});

/**
 * 执行器模型目录 —— 清单级编辑面（cc-switch 的模型目录编辑同款）：增删模型、
 * 改显示名/窗口/推理档位/可见性，写进 CLI 自己的目录文件（codex model-catalogs）。
 * set 写完顺带刷该执行器模型清单：codex debug models 起的是新进程，读的就是刚写的目录。
 */
registerMethod("adapter.modelcatalog.get", (params) => {
  const { runtimeId } = (params ?? {}) as { runtimeId?: string };
  if (typeof runtimeId !== "string") throw Object.assign(new Error("runtimeId is required"), { code: "bad_params" });
  return host.readModelCatalog(runtimeId);
});

registerMethod("adapter.modelcatalog.set", async (params) => {
  const p = (params ?? {}) as {
    runtimeId?: string;
    rows?: Array<Record<string, unknown>>;
  };
  if (typeof p.runtimeId !== "string") throw Object.assign(new Error("runtimeId is required"), { code: "bad_params" });
  if (!Array.isArray(p.rows)) throw Object.assign(new Error("rows is required"), { code: "bad_params" });
  const catalog = await host.writeModelCatalog(p.runtimeId, p.rows as never);
  const report = await host.syncModels(p.runtimeId);
  return { catalog, report: [...report], adapters: await host.listAdapters(false) };
});

/**
 * 供应商级配置（pi / opencode 的累加式面）：get 不抛 unsupported（正常态）；
 * set 写完顺带刷该执行器模型清单 —— pi --list-models / opencode serve /model
 * 读的都是刚写的文件，界面立刻反映。
 */
registerMethod("adapter.providers.get", (params) => {
  const { runtimeId } = (params ?? {}) as { runtimeId?: string };
  if (typeof runtimeId !== "string") throw Object.assign(new Error("runtimeId is required"), { code: "bad_params" });
  return host.readModelProviders(runtimeId);
});

registerMethod("adapter.providers.set", async (params) => {
  const p = (params ?? {}) as { runtimeId?: string; rows?: Array<Record<string, unknown>> };
  if (typeof p.runtimeId !== "string") throw Object.assign(new Error("runtimeId is required"), { code: "bad_params" });
  if (!Array.isArray(p.rows)) throw Object.assign(new Error("rows is required"), { code: "bad_params" });
  const providers = host.writeModelProviders(p.runtimeId, p.rows as never);
  const report = await host.syncModels(p.runtimeId);
  return { providers, report: [...report], adapters: await host.listAdapters(false) };
});
registerMethod("adapter.commands", (params) => {
  const p = (params ?? {}) as { runtimeId?: string; rootPath?: string };
  if (typeof p.runtimeId !== "string" || typeof p.rootPath !== "string") {
    throw Object.assign(new Error("runtimeId and rootPath are required"), { code: "bad_params" });
  }
  // 空清单 = 该执行器没有原生命令面（UI 菜单回落工作台本地命令），不是错误
  return host.listCommands(p.runtimeId, p.rootPath);
});

/**
 * 技能清单（设置页「技能」分区）—— 按技能源分组返回全部技能（含已停用），
 * 每组带「读取该源的执行器」作影响范围提示。rootPath 可选：给了才纳入项目级源。
 */
registerMethod("skills.inventory", async (params) => {
  const p = (params ?? {}) as { rootPath?: string };
  const rootPath = typeof p.rootPath === "string" && p.rootPath.trim() !== "" ? p.rootPath : undefined;
  const adapters = await host.listAdapters(false);
  const names = new Map(adapters.map((a) => [a.id, a.displayName]));
  return buildSkillsInventory(rootPath, (id) => names.get(id) ?? id);
});

/**
 * 技能停用/恢复 —— 在已知技能源内把文件夹搬进/搬出 `.disabled/`。
 * 原生配置文件是唯一真相源：搬完即生效（发现层与 ZCode 原生都不扫点目录），
 * 这里只补一件事——立刻失效受影响执行器的命令缓存，别让斜杠菜单显示旧世界。
 */
registerMethod("skills.copy", (params) => {
  const p = (params ?? {}) as { fromSourceDir?: string; dirName?: string; toSourceDir?: string; rootPath?: string };
  if (typeof p.fromSourceDir !== "string" || typeof p.dirName !== "string" || typeof p.toSourceDir !== "string") {
    throw Object.assign(new Error("fromSourceDir, dirName and toSourceDir are required"), { code: "bad_params" });
  }
  const rootPath = typeof p.rootPath === "string" && p.rootPath.trim() !== "" ? p.rootPath : undefined;
  const result = copySkill(p.fromSourceDir, p.dirName, p.toSourceDir, rootPath);
  host.invalidateCommandsFor(result.readers);
  return { ok: true, readers: result.readers };
});

registerMethod("skills.setDisabled", (params) => {
  const p = (params ?? {}) as { sourceDir?: string; dirName?: string; disabled?: boolean; rootPath?: string };
  if (typeof p.sourceDir !== "string" || typeof p.dirName !== "string" || typeof p.disabled !== "boolean") {
    throw Object.assign(new Error("sourceDir, dirName and disabled are required"), { code: "bad_params" });
  }
  const rootPath = typeof p.rootPath === "string" && p.rootPath.trim() !== "" ? p.rootPath : undefined;
  const result = setSkillDisabled(p.sourceDir, p.dirName, p.disabled, rootPath);
  host.invalidateCommandsFor(result.readers);
  return { ok: true, readers: result.readers };
});

// ---- MCP 管理（ADR 0004：原生配置文件是唯一真相源，这里只做外科手术式读写） ----

const mcpDeps: McpServiceDeps = { configHome: os.homedir(), stateHome: config.homeDir };

registerMethod("mcp.inventory", () => mcpInventory(mcpDeps));

registerMethod("mcp.save", (params) => {
  const p = (params ?? {}) as { executorId?: string; entry?: unknown; expectedSha?: string };
  if (typeof p.executorId !== "string") throw Object.assign(new Error("executorId is required"), { code: "bad_params" });
  const entry = sanitizeEntry(p.entry);
  const expectedSha = typeof p.expectedSha === "string" && p.expectedSha !== "" ? p.expectedSha : undefined;
  return mcpSave(mcpDeps, p.executorId, entry, expectedSha);
});

registerMethod("mcp.remove", (params) => {
  const p = (params ?? {}) as { executorId?: string; name?: string; toVault?: boolean; expectedSha?: string };
  if (typeof p.executorId !== "string" || typeof p.name !== "string") {
    throw Object.assign(new Error("executorId and name are required"), { code: "bad_params" });
  }
  const expectedSha = typeof p.expectedSha === "string" && p.expectedSha !== "" ? p.expectedSha : undefined;
  // toVault 严格布尔：字符串 "false" 这类 truthy 会静默当 true（与 setEnabled 的口径对齐）
  return mcpRemove(mcpDeps, p.executorId, p.name, { toVault: typeof p.toVault === "boolean" ? p.toVault : true, expectedSha });
});

registerMethod("mcp.setEnabled", (params) => {
  const p = (params ?? {}) as { executorId?: string; name?: string; enabled?: boolean; expectedSha?: string };
  if (typeof p.executorId !== "string" || typeof p.name !== "string" || typeof p.enabled !== "boolean") {
    throw Object.assign(new Error("executorId, name and enabled are required"), { code: "bad_params" });
  }
  const expectedSha = typeof p.expectedSha === "string" && p.expectedSha !== "" ? p.expectedSha : undefined;
  return mcpSetEnabled(mcpDeps, p.executorId, p.name, p.enabled, expectedSha);
});

registerMethod("mcp.copy", (params) => {
  const p = (params ?? {}) as {
    fromExecutorId?: string; name?: string; toExecutorIds?: unknown; expectedShas?: Record<string, string>;
  };
  if (typeof p.fromExecutorId !== "string" || typeof p.name !== "string" || !Array.isArray(p.toExecutorIds)) {
    throw Object.assign(new Error("fromExecutorId, name and toExecutorIds are required"), { code: "bad_params" });
  }
  const targets = p.toExecutorIds.filter((x): x is string => typeof x === "string");
  // 指纹只收字符串值：非字符串（空串/数字）会被 assertSha 当成有效指纹比对而必判 conflict
  const expectedShas =
    p.expectedShas !== null && typeof p.expectedShas === "object"
      ? Object.fromEntries(Object.entries(p.expectedShas).filter((kv): kv is [string, string] => typeof kv[1] === "string" && kv[1] !== ""))
      : {};
  return mcpCopy(mcpDeps, p.fromExecutorId, p.name, targets, expectedShas);
});

registerMethod("mcp.read", (params) => {
  const p = (params ?? {}) as { executorId?: string };
  if (typeof p.executorId !== "string") throw Object.assign(new Error("executorId is required"), { code: "bad_params" });
  return mcpReadFile(mcpDeps, p.executorId);
});

// ---- 浏览器 / 电脑控制（docs/14；服务实例在 startHttp 前后那段创建） ----------------

registerMethod("browserControl.get", () => browserControl.getState());

registerMethod("browserControl.setEnabled", (params) => {
  const p = (params ?? {}) as { enabled?: boolean };
  if (typeof p.enabled !== "boolean") throw Object.assign(new Error("enabled is required"), { code: "bad_params" });
  return browserControl.setEnabled(p.enabled);
});

registerMethod("browserControl.setMode", (params) => {
  const p = (params ?? {}) as { mode?: string };
  if (p.mode !== "isolated" && p.mode !== "takeover") {
    throw Object.assign(new Error("mode must be isolated|takeover"), { code: "bad_params" });
  }
  return browserControl.setMode(p.mode);
});

registerMethod("browserControl.setBrowser", (params) => {
  const p = (params ?? {}) as { browser?: string };
  if (p.browser !== "msedge" && p.browser !== "chrome") {
    throw Object.assign(new Error("browser must be msedge|chrome"), { code: "bad_params" });
  }
  return browserControl.setBrowser(p.browser);
});

registerMethod("browserControl.sharedChrome.start", () => browserControl.startSharedChrome());
registerMethod("browserControl.sharedChrome.stop", () => browserControl.stopSharedChrome());

registerMethod("computerControl.get", () => computerControl.getState());

registerMethod("computerControl.setEnabled", (params) => {
  const p = (params ?? {}) as { enabled?: boolean };
  if (typeof p.enabled !== "boolean") throw Object.assign(new Error("enabled is required"), { code: "bad_params" });
  return computerControl.setEnabled(p.enabled);
});

registerMethod("computerControl.panic", () => computerControl.panic());

registerMethod("computerControl.actions", (params) => {
  const p = (params ?? {}) as { afterSeq?: number };
  const afterSeq = typeof p.afterSeq === "number" && Number.isFinite(p.afterSeq) ? p.afterSeq : 0;
  return { actions: controlActions(afterSeq).filter((a) => a.domain === "computer") };
});

// ---- 搜索（bot 级；服务实例在 startHttp 前那段创建） --------------------------------

registerMethod("search.providers", () => SEARCH_PROVIDER_INFOS);

registerMethod("search.overview", () => searchControl.overview());

registerMethod("search.status", (params) => {
  const p = (params ?? {}) as { botId?: string };
  return searchControl.status(p);
});

// 配置写入（密钥语义：apiKey 缺省=不动，""=清除，非空=替换；换家未给 key 自动清旧 key）
registerMethod("search.configure", (params) => {
  const p = (params ?? {}) as { botId?: string; provider?: string; apiKey?: string };
  return searchControl.configure(p);
});

// 余量/余额快照：{botId}（已存密钥，60s 缓存，force=true 绕过）或 {provider, apiKey}（草稿预检）
registerMethod("search.quota", (params) => {
  const p = (params ?? {}) as { botId?: string; provider?: string; apiKey?: string; force?: boolean };
  return searchControl.quota(p);
});

// 桥的 tools/list 收口：这个工作区（cwd/--root）配了搜索才暴露 web_search
registerMethod("search.sessionTools", (params) => {
  const p = (params ?? {}) as { cwd?: string; root?: string };
  return searchControl.sessionTools(p);
});

// 桥的 web_search 执行：daemon 侧解析 bot → 取该 bot 的提供商与密钥
registerMethod("search.query", (params) => {
  const p = (params ?? {}) as { cwd?: string; root?: string; query?: string; maxResults?: number };
  return searchControl.query(p);
});

registerMethod("session.start", async (params) => {
  // params 在协议里是可选的（wsd 的信封声明 params?: unknown）——
  // 缺了要当 bad_params 报，不能 `params as {...}` 后直接读属性（TypeError → internal）
  const p = (params ?? {}) as {
    runtimeId?: string; unitId?: string; unitName?: string; rootPath?: string;
    prompt?: string; model?: string; mode?: "plan" | "build" | "edit" | "yolo";
    reasoningLevel?: string;
    contextLength?: string;
    conversationId?: string;
    handoff?: { fromSessionId?: string };
    fork?: { ofSessionId?: string; anchorMessageId?: string; kind?: string };
    worktree?: { path?: string; branch?: string };
    memoryOptions?: {
      scopes?: readonly ("semantic" | "daily" | "procedural")[];
      dailyDate?: string;
      dailyLimit?: number;
    };
    contextManifestOverride?: unknown;
    customPromptOverride?: string;
    attachments?: string[];
  };
  if (typeof p.runtimeId !== "string" || typeof p.unitId !== "string" ||
      typeof p.rootPath !== "string" || typeof p.prompt !== "string") {
    throw Object.assign(new Error("runtimeId, unitId, rootPath, prompt are required"), { code: "bad_params" });
  }
  // 会话工作树：两个字段要么都在要么都不在，半个 spec 没有语义
  // （null / 缺字段的形态也要落 bad_params，不能 TypeError → internal）
  const wtRaw: unknown = p.worktree;
  const wtOk =
    wtRaw !== null && typeof wtRaw === "object" &&
    typeof (wtRaw as { path?: unknown }).path === "string" && (wtRaw as { path: string }).path !== "" &&
    typeof (wtRaw as { branch?: unknown }).branch === "string" && (wtRaw as { branch: string }).branch !== "";
  const worktree =
    wtRaw === undefined
      ? undefined
      : wtOk
        ? { path: (wtRaw as { path: string }).path, branch: (wtRaw as { branch: string }).branch }
        : (() => {
            throw Object.assign(new Error("worktree requires both path and branch"), { code: "bad_params" });
          })();
  // ADR 0012：谱系/交接参数。给了但不合法 = bad_params（与 worktree 同口径，
  // 不静默吞 —— 前端勾了交接却因字段畸形静默失效，用户无从得知，review P2）
  if (p.conversationId !== undefined && (typeof p.conversationId !== "string" || p.conversationId === "")) {
    throw Object.assign(new Error("conversationId must be a non-empty string"), { code: "bad_params" });
  }
  if (
    p.handoff !== undefined &&
    (p.handoff === null || typeof p.handoff !== "object" || Array.isArray(p.handoff) ||
      typeof p.handoff.fromSessionId !== "string" || p.handoff.fromSessionId === "")
  ) {
    throw Object.assign(new Error("handoff requires fromSessionId (non-empty string)"), { code: "bad_params" });
  }
  // ADR 0013 分叉参数：给了但不合法 = bad_params（同口径）。
  // 锚点是否真在父段账本里由 host 解析时校验（unknown_anchor）——这里只查形状。
  if (
    p.fork !== undefined &&
    (p.fork === null || typeof p.fork !== "object" || Array.isArray(p.fork) ||
      typeof p.fork.ofSessionId !== "string" || p.fork.ofSessionId === "" ||
      typeof p.fork.anchorMessageId !== "string" || p.fork.anchorMessageId === "" ||
      (p.fork.kind !== "branch" && p.fork.kind !== "revision"))
  ) {
    throw Object.assign(new Error("fork requires ofSessionId, anchorMessageId and kind=branch|revision"), { code: "bad_params" });
  }
  // 附件路径内联（docs/21 P4a）：给了路径就由 daemon 组装 prompt——GUI 与 CLI 同一条路
  if (p.attachments !== undefined && (!Array.isArray(p.attachments) || p.attachments.some((x) => typeof x !== "string" || x === ""))) {
    throw Object.assign(new Error("attachments must be string[] of file paths"), { code: "bad_params" });
  }
  const prompt =
    p.attachments !== undefined && p.attachments.length > 0
      ? composePrompt(p.prompt, await inlineAttachments(p.attachments))
      : p.prompt;
  // 回显契约（评审 P1）：附件全文内联只进执行器 prompt；原始文本 + 附件路径交
  // host 透传进 message.delta(user)——用户气泡显示干净文本 + chips，不泄全文。
  const display =
    p.attachments !== undefined && p.attachments.length > 0
      ? { prompt: p.prompt, attachmentPaths: p.attachments }
      : undefined;
  // ADR 0014：注入清单的权威在 bot.json——这里从注册表带出归一后的 manifest 给
  // host（host 不认识注册表）。扫不到定义（外部根/测试路径）= 不带，注入器退回
  // legacy 行为。前端**不再**传全局 scopes 作为真相源；memoryOptions 只做 /mem 覆盖。
  const botDef = await botRegistry.getBot(p.unitId);
  const session = await host.startSession({
    runtimeId: p.runtimeId,
    unitId: asUnitId(p.unitId),
    unitName: p.unitName ?? p.unitId,
    rootPath: p.rootPath,
    prompt,
    display,
    model: typeof p.model === "string" ? asModelId(p.model) : null,
    mode: p.mode,
    reasoningLevel: p.reasoningLevel,
    contextLength: typeof p.contextLength === "string" && p.contextLength !== "" ? p.contextLength : undefined,
    conversationId: typeof p.conversationId === "string" && p.conversationId !== "" ? p.conversationId : undefined,
    handoff:
      p.handoff !== null && typeof p.handoff === "object" && typeof p.handoff.fromSessionId === "string" && p.handoff.fromSessionId !== ""
        ? { fromSessionId: asSessionId(p.handoff.fromSessionId) }
        : undefined,
    fork:
      p.fork !== null && typeof p.fork === "object" && typeof p.fork.ofSessionId === "string" && p.fork.ofSessionId !== "" &&
      typeof p.fork.anchorMessageId === "string" && p.fork.anchorMessageId !== "" &&
      (p.fork.kind === "branch" || p.fork.kind === "revision")
        ? {
            ofSessionId: asSessionId(p.fork.ofSessionId),
            anchorMessageId: p.fork.anchorMessageId,
            kind: p.fork.kind,
          }
        : undefined,
    worktree,
    memoryOptions: p.memoryOptions,
    // 若前端显式指定 contextManifestOverride（单次覆盖或首轮关闭），优先使用；否则取 bot 注册表
    contextManifest:
      p.contextManifestOverride !== undefined
        ? normalizeContextManifest(p.contextManifestOverride)
        : botDef === undefined
          ? undefined
          : normalizeContextManifest(botDef.contextManifest),
    skillsBinding: botDef === undefined ? undefined : normalizeSkillBinding(botDef.skills),
    customPrompt:
      typeof p.customPromptOverride === "string"
        ? p.customPromptOverride
        : typeof (botDef as { customPrompt?: unknown })?.customPrompt === "string"
          ? String((botDef as { customPrompt?: unknown }).customPrompt)
          : undefined,
  });
  if (session && session.id) {
    nativeWatcher.watchSession(String(session.id));
  }
  return session;
});
registerMethod("session.send", async (params) => {
  const p = (params ?? {}) as {
    sessionId?: string;
    text?: string;
    mode?: "plan" | "build" | "edit" | "yolo";
    reasoningLevel?: string;
    contextLength?: string;
    contextInject?: { manifest?: ContextManifest };
    attachments?: string[];
  };
  if (typeof p.sessionId !== "string" || typeof p.text !== "string") {
    throw Object.assign(new Error("sessionId and text are required"), { code: "bad_params" });
  }
  nativeWatcher.watchSession(p.sessionId);
  // 附件路径内联（docs/21 P4a）：给了路径就由 daemon 组装 prompt——GUI 与 CLI 同一条路
  const text =
    p.attachments !== undefined && p.attachments.length > 0
      ? composePrompt(p.text, await inlineAttachments(p.attachments))
      : p.text;
  // 同 session.start（评审 P1）：合成文本只给执行器，回显带原始文本 + chips
  const display =
    p.attachments !== undefined && p.attachments.length > 0
      ? { prompt: p.text, attachmentPaths: p.attachments }
      : undefined;
  return host.sendMessage(
    asSessionId(p.sessionId),
    text,
    {
      mode: p.mode,
      reasoningLevel: p.reasoningLevel,
      contextLength: typeof p.contextLength === "string" && p.contextLength !== "" ? p.contextLength : undefined,
    },
    p.contextInject,
    undefined,
    display,
  );
});
// headless 一轮闭环（docs/21 P4a）：附件内联 + 续聊判定 + 模型解析 + 等轮落定回全文。
// 与 GUI run() 二分：操作在这里，视图（活跃会话/fork 回放/回显）在 GUI。
registerMethod("session.chat", async (params) => {
  const p = (params ?? {}) as Parameters<typeof runChatTurn>[1];
  if (typeof p?.text !== "string" || p.text === "") {
    throw Object.assign(new Error("text is required"), { code: "bad_params" });
  }
  if (p.attachments !== undefined && (!Array.isArray(p.attachments) || p.attachments.some((x) => typeof x !== "string" || x === ""))) {
    throw Object.assign(new Error("attachments must be string[] of file paths"), { code: "bad_params" });
  }
  return runChatTurn({ host, registry: botRegistry }, p);
});
// 通知事实源（docs/21 P4b）：daemon 聚合行的查询面；已读与「你不在它面前」是客户端呈现
registerMethod("notifications.list", (params) => {
  const p = (params ?? {}) as { limit?: number };
  return { items: notifications.list(typeof p.limit === "number" ? p.limit : undefined) };
});
// 出图操作面（docs/21 P4c）：编排唯一源在 prototype/core/imageApi.ts（GUI 同份），
// 这里注入直连传输；任务历史是 daemon 事实（image-tasks.json），文件经 /api/image/file 取
registerMethod("image.generate", async (params) => {
  const p = (params ?? {}) as GenerateParams;
  if (typeof p.profileId !== "string" || p.profileId === "" || typeof p.prompt !== "string" || p.prompt === "") {
    throw Object.assign(new Error("profileId and prompt are required"), { code: "bad_params" });
  }
  return generateImage({ profiles: imageProfiles, tasks: imageTasks, homeDir: config.homeDir }, p);
});
registerMethod("image.tasks.list", () => ({ items: imageTasks.list() }));
// 官方技能同步（docs/21 P6 × docs/20 收敛）：bot init 已自动播种，这里兜底存量 bot /
// 升级 / force 重装；agent-workbench 与 workbench-context 两个基础技能一并同步
registerMethod("workbench.skill.sync", async (params) => {
  const p = (params ?? {}) as { botId?: string; rootPath?: string; force?: boolean };
  const roots: string[] = [];
  if (typeof p.rootPath === "string" && p.rootPath !== "") {
    roots.push(p.rootPath);
  } else if (typeof p.botId === "string" && p.botId !== "") {
    const bot = await botRegistry.getBot(p.botId);
    if (bot === undefined) throw Object.assign(new Error(`no such bot: ${p.botId}`), { code: "unknown_bot" });
    if (typeof bot.rootPath === "string") roots.push(bot.rootPath);
  } else {
    roots.push(...(await botRegistry.listBots()).flatMap((b) => (typeof b.rootPath === "string" && b.rootPath !== "" ? [b.rootPath] : [])));
  }
  if (roots.length === 0) throw Object.assign(new Error("no bots to sync (传 botId/rootPath，或先建一个 bot)"), { code: "bad_params" });
  const results = [];
  for (const root of roots) {
    // 官方技能 ×2（docs/20 × docs/21 P6 收敛）：agent-workbench 在前（兼容 results[0] 语义）
    results.push(await syncWorkbenchSkill(root, { force: p.force === true }));
    results.push(...(await syncContextSkill(root, { force: p.force === true })));
  }
  return { results, path: roots.length === 1 ? workbenchSkillPath(roots[0] ?? "") : undefined };
});
registerMethod("session.cancel", (params) => {
  const { sessionId } = (params ?? {}) as { sessionId?: string };
  if (typeof sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  return host.cancelSession(asSessionId(sessionId));
});
// ---- steer 待发送队列管理（ZCode queue 面板同款操作面）----
registerMethod("session.queue.remove", (params) => {
  const p = (params ?? {}) as { sessionId?: string; id?: string };
  if (typeof p.sessionId !== "string" || typeof p.id !== "string") {
    throw Object.assign(new Error("sessionId and id are required"), { code: "bad_params" });
  }
  return host.removeQueuedSend(asSessionId(p.sessionId), p.id);
});
registerMethod("session.queue.sendNow", (params) => {
  const p = (params ?? {}) as { sessionId?: string; id?: string };
  if (typeof p.sessionId !== "string" || typeof p.id !== "string") {
    throw Object.assign(new Error("sessionId and id are required"), { code: "bad_params" });
  }
  return host.sendQueuedNow(asSessionId(p.sessionId), p.id);
});
registerMethod("session.queue.resume", (params) => {
  const p = (params ?? {}) as { sessionId?: string };
  if (typeof p.sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  host.resumeQueue(asSessionId(p.sessionId));
  return { resumed: p.sessionId };
});
registerMethod("session.list", () => host.listSessions());

/**
 * 可续接的对话清单 —— 「定时发送到已有对话」的下拉数据源。
 *
 * 口径必须是 **cli_ref 非空**，不是「所有历史会话」：首轮都没跑完的会话拿不到
 * 执行器侧引用，resumeSession 会直接抛 no_cli_ref。把它们列进选择器，
 * 用户选了就是选了个必然失败的项 —— 「能选到的就一定能用」是这个列表唯一
 * 的承诺。runtimeId 可选，给了只列该执行器的。
 */
registerMethod("session.resumable", (params) => {
  const p = (params ?? {}) as { runtimeId?: string; limit?: number };
  const limit = Math.min(50, Math.max(1, Math.round(Number(p.limit)) || 20));
  const only = typeof p.runtimeId === "string" && p.runtimeId !== "" ? p.runtimeId : null;
  const out = store
    .listSessions()
    .filter((s) => s.cliRef !== null && (only === null || s.runtimeId === only))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      title: s.title,
      runtimeId: s.runtimeId,
      unitId: s.unitId,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      lastActiveAt: s.endedAt ?? s.startedAt,
      // 来源透出：定时发送的目标选择器据此标「来自自动化/飞书/工作台…」，
      // 用户不用靠标题猜这是哪个渠道的对话
      source: s.source ?? null,
    }));
  return { sessions: out };
});
registerMethod("session.resume", (params) => {
  const { sessionId } = (params ?? {}) as { sessionId?: string };
  if (typeof sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  nativeWatcher.watchSession(sessionId);
  // 旧路径落的行可能还没进 host 内存表：先收编（幂等），resume 才不会 unknown_session
  host.adoptPersisted(sessionId);
  // 查看不接回执行器（resumeSession 语义已改）：点开历史/导入行零进程开销，
  // 续聊的接回延迟到 session.send
  return host.resumeSession(asSessionId(sessionId));
});
registerMethod("session.messages", (params) => {
  const p = (params ?? {}) as { sessionId?: string };
  if (typeof p.sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  // host 只认活会话 —— 历史会话（daemon 重启后/已结束落盘）从 store 兜底读，
  // 否则单元历史里点开任何旧会话都是 unknown_session。
  try {
    return host.sessionMessages(asSessionId(p.sessionId));
  } catch {
    const rows = store.listMessages(p.sessionId);
    if (store.getSession(p.sessionId) === undefined && rows.length === 0) {
      throw Object.assign(new Error(`no such session: ${p.sessionId}`), { code: "unknown_session" });
    }
    return rows;
  }
});
// exportTrace 的线上形态（WP-3）：以落盘账本为准 —— 跨日期 TraceRecord NDJSON，
// 事件环（上限 500）只是热缓存。afterSeq 可选：断线补拉游标（WP-2 复用）。
registerMethod("session.trace", (params) => {
  const p = (params ?? {}) as { sessionId?: string; afterSeq?: number };
  if (typeof p.sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  return traceSink.readSessionNdjson(asSessionId(p.sessionId), typeof p.afterSeq === "number" ? p.afterSeq : 0);
});
// 会话分享（docs/26）：导出 = 台账行 + messages + 账本 RuntimeEvent 流打成带版本的
// bundle，前端拿到后走系统保存框/浏览器下载落 .awb.json 文件。跨机器传递即传文件。
registerMethod("session.export", async (params) => {
  const p = (params ?? {}) as { sessionId?: string };
  if (typeof p.sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  const row = store.getSession(p.sessionId);
  if (row === undefined) throw Object.assign(new Error(`no such session: ${p.sessionId}`), { code: "unknown_session" });
  // 导出必须全量：listMessages 默认 limit=500，长会话的 messages 段会被截断
  //（events 段走账本本来就是全量，两段缺一会造出「半截 bundle」）
  const messages = store.listMessages(p.sessionId, 1_000_000);
  const events = parseTraceNdjson(await traceSink.readSessionNdjson(asSessionId(p.sessionId), 0));
  return buildSharedBundle(row, messages, events);
});
// 导入侧对称：bundle 校验 → impf_ 台账行（source="shared"，cliRef 剥离）→ messages 落库
// → 事件重放进账本（导入即完整时间线）。重复导入同 originId 幂等跳过。
registerMethod("session.importFile", async (params) => {
  const p = (params ?? {}) as { bundle?: unknown; unitId?: string };
  if (typeof p.unitId !== "string" || p.unitId === "") {
    throw Object.assign(new Error("unitId 必填"), { code: "bad_params" });
  }
  let bundle;
  try {
    bundle = parseSharedBundle(p.bundle);
  } catch (err) {
    throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { code: "bad_bundle" });
  }
  const out = await importSharedSession(store, traceSink, { bundle, unitId: p.unitId });
  if (out.imported) {
    // 与 history.import.apply 同口径：收编进 host 台账（daemon 存活期内 session.list
    // 就有这行）。执行器本机未装时收编失败——侧栏历史来自 store 不受影响，点开回放
    // 走账本也不需要 host，只是 session.list 到重启前缺这行，可接受。
    host.adoptPersisted(out.sessionId ?? "");
  }
  return out;
});
// 断线补拉（WP-2）：热路径读事件环；游标滑出环外（gap）时回落落盘账本。
// ADR 0012：返回 {seq, at, event} —— at 供前端重建时间线（TimelineItem 需要）。
registerMethod("session.events.since", async (params) => {
  const p = (params ?? {}) as { sessionId?: string; afterSeq?: number };
  if (typeof p.sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  nativeWatcher.watchSession(p.sessionId);
  await syncNativeSession(p.sessionId, store, traceSink, wss);
  const afterSeq = typeof p.afterSeq === "number" ? p.afterSeq : 0;
  const hot = host.hotEventsSince(asSessionId(p.sessionId), afterSeq);
  const parseLedger = (nd: string): Array<{ seq: number; at: number; event: unknown }> => {
    const out: Array<{ seq: number; at: number; event: unknown }> = [];
    for (const l of nd.split("\n")) {
      if (l === "") continue;
      try {
        const r = JSON.parse(l) as { seq: number; at?: number; event: unknown };
        if (typeof r.seq === "number" && r.event !== undefined) {
          out.push({ seq: r.seq, at: r.at ?? 0, event: r.event });
        }
      } catch {
        // 坏行跳过：账本容错读（半刷行/截断行不崩 RPC）
      }
    }
    return out;
  };
  if (afterSeq === 0) {
    // 全量重建（openSession / 换代重拉，review P0）：以落盘账本为准 —— 热环只
    // 保留最近 500 条，直接吃环会静默截断长对话；trace append 是异步的，
    // 账本可能还没写到最后几条，用热环补尾部消除竞态。
    const records = parseLedger(await traceSink.readSessionNdjson(asSessionId(p.sessionId), 0));
    const maxLedgerSeq = records.reduce((m, r) => Math.max(m, r.seq), 0);
    const tail = hot.items.filter((e) => e.seq > maxLedgerSeq);
    return [...records, ...tail];
  }
  if (!hot.gap) return hot.items;
  return parseLedger(await traceSink.readSessionNdjson(asSessionId(p.sessionId), afterSeq));
});
registerMethod("session.syncNative", async (params) => {
  const p = (params ?? {}) as { sessionId?: string };
  if (typeof p.sessionId !== "string" || p.sessionId === "") {
    throw Object.assign(new Error("sessionId 必填"), { code: "bad_params" });
  }
  const out = await syncNativeSession(p.sessionId, store, traceSink, wss);
  // 结果落通知中心（操作面事实源）：GUI 头部按钮与 aw CLI 调同一 RPC、得同一份
  // 反馈——前端不必另行上报，铃铛/通知面板经 WS notifications 帧即时点亮
  notifications.notifySyncOutcome(p.sessionId, out.changed, out.newMessages);
  return out;
});
registerMethod("history.refreshNative", () => {
  nativeListCache.clear();
  // 手动刷新的期待是「现在就把新会话找出来」：顺带跑一轮自动收录，不等 30s 轮询
  void autoCollector.collectNow();
  return { refreshed: true };
});
// 孤儿治理面（WP-10）：列出可回收的死会话 / 回收指定会话（轨迹文件永不删）。
registerMethod("session.gc", (params) => {
  const p = (params ?? {}) as { maxAgeDays?: number };
  const maxAgeDays = typeof p.maxAgeDays === "number" ? p.maxAgeDays : 14;
  return host.gcCandidates(maxAgeDays * 86_400_000);
});
registerMethod("session.forget", (params) => {
  const { sessionId } = (params ?? {}) as { sessionId?: string };
  if (typeof sessionId !== "string") throw Object.assign(new Error("sessionId is required"), { code: "bad_params" });
  host.forgetSession(asSessionId(sessionId));
  // 连带收回原生同步的内存态（同步游标 + watcher 关注/文件签名），防只增不减
  forgetNativeSyncState(sessionId);
  nativeWatcher.unwatchSession(sessionId);
  return { forgotten: sessionId };
});
registerMethod("permission.resolve", (params) => {
  const p = (params ?? {}) as { sessionId?: string; requestId?: string; decision?: "allow" | "deny" | "always" };
  if (typeof p.sessionId !== "string" || typeof p.requestId !== "string" ||
      (p.decision !== "allow" && p.decision !== "deny" && p.decision !== "always")) {
    throw Object.assign(new Error("sessionId, requestId, decision(allow|deny|always) are required"), { code: "bad_params" });
  }
  return host.resolvePermission(asSessionId(p.sessionId), p.requestId, p.decision);
});

registerMethod("workspace.openFolder", async (params) => {
  const p = (params ?? {}) as { path?: string; botId?: string };
  let targetPath = p.path;
  if (!targetPath && p.botId) {
    const b = await botRegistry.getBot(p.botId);
    if (b) targetPath = b.rootPath;
  }
  if (!targetPath || typeof targetPath !== "string") {
    throw Object.assign(new Error("path or botId is required"), { code: "bad_params" });
  }
  return launchFileManager(targetPath);
});

// 头部「打开方式」按钮的编辑器通道（检测与打开逻辑见 workspaceEditors.ts，
// 移植自 ZCode editors.ts/openInEditor.ts）。explorer 走既有 launchFileManager。
registerMethod("workspace.listEditors", () => listInstalledEditors());

registerMethod("workspace.openInEditor", async (params) => {
  const p = (params ?? {}) as { path?: string; botId?: string; editorId?: string };
  let targetPath = p.path;
  if (!targetPath && p.botId) {
    const b = await botRegistry.getBot(p.botId);
    if (b) targetPath = b.rootPath;
  }
  if (!targetPath || typeof targetPath !== "string") {
    throw Object.assign(new Error("path or botId is required"), { code: "bad_params" });
  }
  const editorId = typeof p.editorId === "string" && p.editorId !== "" ? p.editorId : "explorer";
  if (editorId === "explorer") return launchFileManager(targetPath);
  return openInEditorApp(editorId, targetPath);
});

registerMethod("health", () => healthPayload(config, startedAt));

registerMethod("tunnel.status", () => tunnelManager.getState());
registerMethod("tunnel.start", (params) => {
  const p = (params ?? {}) as { provider?: "cloudflared" | "custom"; customUrl?: string };
  return tunnelManager.start(p);
});
registerMethod("tunnel.stop", () => tunnelManager.stop());

/**
 * 协议原生的关闭通道。Windows 上跨进程 SIGTERM 不可投递（冒烟脚本实证），
 * 程序化退出一律走这里；SIGINT/SIGTERM 处理器保留给终端 Ctrl+C 与 Unix。
 * 延迟退出是为了让响应帧先落 TCP。
 */
registerMethod("daemon.stop", () => {
  setTimeout(() => shutdown("rpc daemon.stop"), 30);
  return { stopping: true };
});

log.info("daemon listening", {
  http: `http://${config.host}:${port}`,
  ws: `ws://${config.host}:${port}/ws`,
  version: config.version,
  pid: process.pid,
  home: config.homeDir,
});

// 命令面板预热（后台，不挡 listen）：拉一遍「有命令面的执行器 × 已知 bot
// rootPath」，让用户第一次打开斜杠菜单就命中缓存 —— 对标 TUI 的秒开体验。
// 冷启动成本（opencode 起 server ~6s、zcode 问 app-server ~1s）全部藏进启动期。
void (async () => {
  try {
    const bots = await botRegistry.listBots();
    const roots = [...new Set(bots.map((b) => b.rootPath).filter((r): r is string => typeof r === "string" && r !== ""))];
    if (roots.length > 0) {
      await host.prewarmCommands(roots);
      log.info("命令面板预热完成", { roots: roots.length });
    }
  } catch {
    /* 预热是优化不是功能路径：失败留给菜单打开时的正常拉取 */
  }
})();

// 方法元数据集中表（docs/21 D6）：挂到注册表供 rpc.methods / aw methods / docs/07 生成表
// 消费。必须在全部 registerMethod 之后调用——本表出现注册表没有的键 = 漂移，启动掀桌。
applyMethodMeta(METHOD_META);

let shuttingDown = false;
// 评审 P1：host.shutdown 必须真等——undelivered 广播是异步 socket 写、adapter.disconnect
// 杀子进程、store.close 落盘，全部排在第一个 await 之后；此前同步 process.exit 抢跑全跳过
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  scheduler.stop();
  quotaResumeWatcher.stop();
  gitWatcher.stop();
  backlogEngine?.stop();
  memoryScheduler?.stop(); // 之前漏了：60s interval 会活到 process.exit，正在跑的日报/curator 被从中间砍断
  telegramGateway.stop();
  weixinGateway.stop();
  discordGateway.stop();
  // 飞书也停：它有一个 15s reconcile interval 和每账号的长连接/子进程，
  // 漏掉它就会在 host.shutdown() 关掉 store 之后还能起新活（评审 P1 同类）
  feishuGateway.stop();
  tunnelManager?.stop();
  // 共享 Chrome 与终端并行收尾（复审 P1）：Windows 上 daemon 退出不杀子进程，
  // 不带走它 = CDP 调试端口在关掉工作台后无限期暴露。收编的存量实例无句柄，跳过。
  const chromeDispose = browserControl.dispose().catch((err: unknown) =>
    log.warn("shared chrome dispose failed", { error: err instanceof Error ? err.message : String(err) }),
  );
  // 杀光终端 → ConPTY 排空窗口 → terminate pty worker（顺序敏感，见 stop 注释）
  await terminals.stop();
  const force = setTimeout(() => process.exit(0), 2000).unref(); // 挂起写兜底：2s 强制退
  try {
    await host.shutdown();
    await chromeDispose; // host 收尾（最慢的一段）之后、强杀定时器之前尽力等完
  } catch (err: unknown) {
    log.warn("host shutdown failed", { error: err instanceof Error ? err.message : String(err) });
  }
  for (const client of wss.clients) client.close(1001, "server shutting down");
  wss.close();
  server.close();
  clearTimeout(force);
  log.info("bye");
  process.exit(0);}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
});
