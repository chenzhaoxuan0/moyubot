/**
 * 落盘层（docs/06 §七）—— state.db 用 Node 内置 node:sqlite（零依赖）。
 *
 * 表语义：
 * - sessions：会话台账（stats 以 JSON 存列）；cli_ref 是执行器侧的原生会话引用
 *   （zcode 的 --resume id / codex 的 thread id），resumeSession 靠它续命。
 * - messages：对话流（user prompt 与 assistant 完整消息），前端重载会话用。
 * - kv：自动化（Phase 5）/ 权限规则（Phase 4）等小状态的通用落点。
 *
 * 轨迹（traces/<date>.jsonl）与用量（usage.jsonl）是 append-only jsonl，
 * 不进 SQLite —— 追加只写语义与 SQLite 事务语义分开，各自最简单。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DispatchTarget, LaunchMode, ScheduleRule } from "../../../prototype/src/core/automation.ts";
import type { BacklogStatus } from "../../../prototype/src/core/backlog.ts";
import type { InboxEntry, InboxHints, InboxStatus } from "../../../prototype/src/core/inbox.ts";
import { normalizeInboxHints } from "../../../prototype/src/core/inbox.ts";
import { log } from "../log.ts";

export interface SessionRow {
  readonly id: string;
  readonly unitId: string;
  readonly runtimeId: string;
  readonly title: string;
  readonly status: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly cliRef: string | null;
  readonly rootPath: string | null;
  /** 会话来源（workbench/feishu/mobile/automation…）：历史列表来源标签用。旧行/测试桩缺省 */
  readonly source?: string | null;
  /**
   * 会话谱系（ADR 0012）：切换执行器开新段时指向旧段的谱系 id。NULL = 自身为根。
   * 不可变 —— 行创建后改谱系等于改写历史，账本不允许。
   */
  readonly conversationId: string | null;
  /** 账本 seq 持久化（ADR 0012 不变量 3）：quiesce 点落盘，daemon 换代续号不重置 */
  readonly lastSeq: number;
  /** 轮号持久化（ADR 0012）：turn.started/completed 凭 turn 配对，换代不得重号 */
  readonly turnCount: number;
  /**
   * 对话分叉血缘（ADR 0013）：fork 出的段指向父段 id + 父段账本 seq 上界。
   * 三列不可变（同 conversation_id）；forkKind: 'branch' = 含锚点轮整轮（through），
   * 'revision' = 锚点轮之前（before，编辑重发）。NULL = 非分叉段。
   */
  readonly forkOfSession: string | null;
  readonly forkAtSeq: number | null;
  readonly forkKind: "branch" | "revision" | null;
  readonly stats: {
    messages: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
  };
}

interface StatsJson {
  messages: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

const EMPTY_STATS: StatsJson = { messages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };

/** backlog_items 行的读取形态（心跳引擎与 RPC 层共用） */
export interface BacklogRow {
  id: number;
  title: string;
  goal: string;
  prompt: string;
  unitId: string;
  unitName: string;
  rootPath: string;
  runtimeId: string;
  model: string | null;
  mode: string | null;
  size: string | null;
  /** 执行方式：terminal = 前端 TUI（缺省）；chat = 对话页前台；headless = 纯后台 host 会话 */
  launchMode: LaunchMode;
  /** 闲时自动执行（autopilot）：true = 空闲且余量够时引擎直接派发，不进确认门 */
  auto: boolean;
  /** 指定在某个已有会话里执行；null = 新开会话 */
  targetSessionId: string | null;
  status: string;
  ignoreCount: number;
  lastProposedAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  reviewNote: string | null;
  source: string;
  sortPos: number;
  createdAt: number;
  updatedAt: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(homeDir: string) {
    mkdirSync(homeDir, { recursive: true });
    this.db = new DatabaseSync(path.join(homeDir, "state.db"));    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        unit_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        cli_ref TEXT,
        root_path TEXT,
        source TEXT,
        stats_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_sessions_unit ON sessions(unit_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_native_ref ON sessions(cli_ref) WHERE cli_ref IS NOT NULL AND cli_ref <> '';
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        runtime_id TEXT,
        kind TEXT,
        pattern TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );      CREATE TABLE IF NOT EXISTS automations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        unit_id TEXT NOT NULL,
        unit_name TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT,
        mode TEXT,
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_id INTEGER NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        detail TEXT
      );
      -- 待办 / GTD（ADR-0001：独立建表，不复用 automations —— 待办的状态机
      -- 多出确认门 / 验收 / 休眠计数，塞同一张表两边都拧巴）。
      -- 状态机全落 DB：awaiting_confirm / executing 等中间态必须跨重启。
      CREATE TABLE IF NOT EXISTS backlog_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        prompt TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        unit_name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        runtime_id TEXT NOT NULL DEFAULT '',
        model TEXT,
        mode TEXT,
        size TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        ignore_count INTEGER NOT NULL DEFAULT 0,
        last_proposed_at INTEGER,
        last_run_at INTEGER,
        last_error TEXT,
        review_note TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        sort_pos REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backlog_items_status ON backlog_items(status, sort_pos);
      -- 待办运行记录（复用执行链路、不复用 automation_runs 表：那边 automation_id
      -- NOT NULL 挂着定时任务行，硬塞会互相污染）
      CREATE TABLE IF NOT EXISTS backlog_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        session_id TEXT,
        runtime_id TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'gtd',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_backlog_runs_item ON backlog_runs(item_id, id);
      -- 清单（inbox）—— 个人 context 的唯一捕获入口：用户把任何东西写进这一个
      -- 列表，routing bot 分类后 actionable 的沉淀成 backlog_items（task_id 双向
      -- 链接），想法/资料留在本表按块归档。分类权威在 daemon（state.db 跨重启）。
      CREATE TABLE IF NOT EXISTS inbox_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        category TEXT,
        category_note TEXT,
        hints_json TEXT,
        task_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        classified_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_entries_status ON inbox_entries(status, id);
      -- 手动派发终端的运行记录（terminal.dispatch：经派发系统的前台 TUI）。
      -- 与 automation_runs / backlog_runs 并列 —— 手动打开没有任务行可挂，
      -- 单独建表，unit.history 三方合并成统一时间轴。
      CREATE TABLE IF NOT EXISTS terminal_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        terminal_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        unit_name TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        detail TEXT,
        title TEXT,
        resume_ref TEXT,
        output_text TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_terminal_runs_unit ON terminal_runs(unit_id, id);

      -- 终端文本输出快照（ANSI 过滤后的纯文本日志，用于历史会话详情查看）
      CREATE TABLE IF NOT EXISTS terminal_transcripts (
        terminal_id TEXT PRIMARY KEY,
        output_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pillar TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_pillar ON memory(pillar, id);

      -- 分发日志（docs/10 WP-3）：用户原话与注入内容分列。
      -- 只在**新会话**记一行（冻结快照：续聊不重复注入，就没有新注入可记）。
      -- 不抄会话原文 —— 原文在各自 CLI 的落盘里，这里只存「我们派了什么」。
      CREATE TABLE IF NOT EXISTS dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        user_text TEXT NOT NULL,
        injected_block TEXT NOT NULL,
        injected_chars INTEGER NOT NULL,
        parts_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatches_session ON dispatches(session_id, id);

      -- curator 遥测（docs/10 WP-9）：v1 只埋表不做状态机。
      -- 这些字段**不能后补** —— 没埋就永远算不出「14 天没用过」。
      CREATE TABLE IF NOT EXISTS memory_meta (
        path TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL DEFAULT 0,
        char_used INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at INTEGER,
        state TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    // 旧库迁移：root_path 是 Phase 3 之后补的列（resume 需要工作目录重建 workspace）
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN root_path TEXT`);
    } catch {
      // 列已存在
    }
    // ADR 0012：谱系关联 + 账本 seq/轮号持久化（conversation_id 不可变；last_seq/turn_count 只增）
    for (const stmt of [
      `ALTER TABLE sessions ADD COLUMN conversation_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0`,
    ]) {
      try {
        this.db.exec(stmt);
      } catch {
        // 列已存在
      }
    }
    // ADR 0013 对话分叉：血缘三列（fork_of_session/fork_at_seq/fork_kind），
    // 行创建后不可变、不进 upsert 的 ON CONFLICT UPDATE（与 conversation_id 同款约束）
    for (const stmt of [
      `ALTER TABLE sessions ADD COLUMN fork_of_session TEXT`,
      `ALTER TABLE sessions ADD COLUMN fork_at_seq INTEGER`,
      `ALTER TABLE sessions ADD COLUMN fork_kind TEXT`,
    ]) {
      try {
        this.db.exec(stmt);
      } catch {
        // 列已存在
      }
    }
    // 自动化 v2（对齐 ZCode 的调度状态机）：
    // 「下次何时跑」是持久化事实（next_run_at），scheduler 只认 DB 不靠内存推算，
    // daemon 重启 / 崩溃不丢拍；recurring/max_runs/run_count 收口一次性与有限次任务；
    // last_error 撑卡片的失败徽章。
    for (const stmt of [
      `ALTER TABLE automations ADD COLUMN name TEXT`,
      `ALTER TABLE automations ADD COLUMN schedule_rule TEXT`,
      `ALTER TABLE automations ADD COLUMN recurring INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE automations ADD COLUMN max_runs INTEGER`,
      `ALTER TABLE automations ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE automations ADD COLUMN next_run_at INTEGER`,
      `ALTER TABLE automations ADD COLUMN last_run_at INTEGER`,
      `ALTER TABLE automations ADD COLUMN last_error TEXT`,
      `ALTER TABLE automations ADD COLUMN last_error_at INTEGER`,
      `ALTER TABLE automation_runs ADD COLUMN trigger TEXT`,
      // 执行方式：terminal = 到点在前端 PTY 里拉起执行器 TUI（人可看可插手），
      // headless = 原有 host 会话。旧行 NULL 按 terminal 读（新默认）。
      `ALTER TABLE automations ADD COLUMN launch_mode TEXT`,
      // 待办同款：terminal = 前端 TUI（缺省）；headless = 纯后台
      `ALTER TABLE backlog_items ADD COLUMN launch_mode TEXT`,
      // 清单（inbox）升级两列：auto = 闲时自动执行（免确认门，跑完自动验收）；
      // target_session_id = 指定在已有会话里执行（接得上就 resume，接不上回落新开）
      `ALTER TABLE backlog_items ADD COLUMN auto INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE backlog_items ADD COLUMN target_session_id TEXT`,
      `ALTER TABLE terminal_runs ADD COLUMN title TEXT`,
      `ALTER TABLE terminal_runs ADD COLUMN resume_ref TEXT`,
      `ALTER TABLE terminal_runs ADD COLUMN output_text TEXT`,
      // 派发目标（v3）：new_session = 新开会话（历史行为，NULL 按它读）；
      // existing_session = 到点往 target_session_id 那个老对话里续发一条消息。
      // 「定时发送」原语就落在这两列上 —— 用量耗尽后续跑用的也是它。
      `ALTER TABLE automations ADD COLUMN dispatch_target TEXT`,
      `ALTER TABLE automations ADD COLUMN target_session_id TEXT`,
      // 来源：manual = 用户手建；quota_resume = 用量耗尽后自动排的续跑。
      // 自动排的那条要去重（同一窗口只排一条），这个标记就是去重的凭据。
      `ALTER TABLE automations ADD COLUMN origin TEXT`,
      // 会话来源（workbench/feishu/mobile/automation…）：历史列表的来源标签用。
      // 旧行 NULL 按工作台读（产品初期只有工作台一个入口）
      `ALTER TABLE sessions ADD COLUMN source TEXT`,
    ]) {
      try {
        this.db.exec(stmt);
      } catch {
        // 列已存在
      }
    }
    // 历史终端记录自愈：早期版本把用户关闭 TUI 误记为 failed（ConPTY pty.kill 退出码为 1）。
    // 若运行持续超过 3 秒且是因为 exit 码关闭的，恢复为 done。
    try {
      this.db.exec(
        `UPDATE terminal_runs SET status = 'done', detail = NULL WHERE status = 'failed' AND detail LIKE 'terminal exit %' AND finished_at IS NOT NULL AND (finished_at - started_at) > 3000`,
      );
    } catch {
      // 忽略历史自愈异常
    }
    // 历史会话自愈：没有 cli_ref（无法 resume）却处于未终态（running/awaiting_*）的残留僵尸行收口为 failed
    try {
      this.db.exec(
        `UPDATE sessions SET status = 'failed', ended_at = COALESCE(ended_at, started_at) WHERE (status = 'running' OR status LIKE 'awaiting_%') AND cli_ref IS NULL`,
      );
    } catch {
      // 忽略历史自愈异常
    }
    log.info("store opened", { db: path.join(homeDir, "state.db") });
  }

  /**
   * 同步事务包裹：多表写必须同生共死时用（node:sqlite 是同步 API，直接
   * BEGIN/COMMIT 即可，无需异步排队）。嵌套调用不支持 —— 调用方保证一层。
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err: unknown) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* BEGIN 都没成功的极端情况下无事可回滚 */
      }
      throw err;
    }
  }

  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, unit_id, runtime_id, title, status, started_at, ended_at, cli_ref, root_path, source, conversation_id, last_seq, turn_count, fork_of_session, fork_at_seq, fork_kind, stats_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status,
           ended_at=excluded.ended_at, cli_ref=excluded.cli_ref, root_path=excluded.root_path,
           last_seq=MAX(last_seq, excluded.last_seq), turn_count=MAX(turn_count, excluded.turn_count), stats_json=excluded.stats_json`,
      )
      .run(
        row.id,
        row.unitId,
        row.runtimeId,
        row.title,
        row.status,
        row.startedAt,
        row.endedAt,
        row.cliRef,
        row.rootPath,
        // 来源与血缘同属「行创建后不可变」：续跑/续聊不改写这条会话怎么来的
        row.source ?? null,
        row.conversationId,
        row.lastSeq,
        row.turnCount,
        // ADR 0013：血缘三列只在 INSERT 时写入，冲突更新不触碰（行创建后不可变）
        row.forkOfSession,
        row.forkAtSeq,
        row.forkKind,
        JSON.stringify(row.stats),
      );
  }

  /**
   * 账本进度持久化（ADR 0012）：quiesce 点（轮落定/消息完成/usage/收尾）调用。
   * daemon 换代后 loadPersisted 用它续号，afterSeq 补拉与 turn 配对跨代成立。
   * 只增不减：并发/乱序写入取大值，防倒退。
   */
  setSessionProgress(id: string, seq: number, turnCount: number): void {
    this.db
      .prepare(`UPDATE sessions SET last_seq = MAX(last_seq, ?), turn_count = MAX(turn_count, ?) WHERE id = ?`)
      .run(seq, turnCount, id);
  }

  setSessionCliRef(id: string, cliRef: string): void {
    this.db.prepare(`UPDATE sessions SET cli_ref = ? WHERE id = ?`).run(cliRef, id);
  }

  setSessionStatus(id: string, status: string, endedAt: number | null, stats: StatsJson): void {
    this.db
      .prepare(`UPDATE sessions SET status = ?, ended_at = ?, stats_json = ? WHERE id = ?`)
      .run(status, endedAt, JSON.stringify(stats), id);
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.toRow(row);
  }

  /** 删除一个会话行及其消息（WP-10 孤儿回收的 forget 面）；轨迹文件不动 */
  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
    // 分发日志同属这条会话：不删就永远留在库里，而 memory.dispatches 还能
    // 把「已经 forget 掉」的会话日志原样查回来
    this.db.prepare(`DELETE FROM dispatches WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  /** 一次性迁移用：只清消息行，保留会话行（导入会话重投影前调用） */
  clearSessionMessages(id: string): void {
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  /** unit.history 专用：按单元在 SQL 层过滤（此前全表搬进 JS 再逐行丢，行多时纯浪费） */
  listSessionsForUnit(unitId: string): SessionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE unit_id = ? ORDER BY started_at DESC`)
      .all(unitId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  /** 影子行判定集专用：非导入会话的原生引用轻量列（不搬整行做 Set）。
   *  source 可为 NULL（早期/常规会话，实测占大头）—— SQL 三值逻辑下
   *  `source <> 'imported'` 会把 NULL 行整批排除，必须显式 IS NULL 兜住 */
  listSessionNativeRefs(): Array<{ runtimeId: string; cliRef: string }> {
    const rows = this.db
      .prepare(
        `SELECT runtime_id, cli_ref FROM sessions
         WHERE (source IS NULL OR source <> 'imported') AND cli_ref IS NOT NULL AND cli_ref <> ''`,
      )
      .all() as Array<{ runtime_id: string; cli_ref: string }>;
    return rows.map((r) => ({ runtimeId: String(r.runtime_id), cliRef: String(r.cli_ref) }));
  }

  /** 最后一条消息的时间戳（0 = 一条都没有）。curator 的 idle 闸要用真实的对话活动 */
  latestMessageAt(): number {
    const row = this.db.prepare(`SELECT max(at) AS at FROM messages`).get() as { at?: number | null } | undefined;
    return Number(row?.at ?? 0);
  }

  insertMessage(sessionId: string, at: number, role: "user" | "assistant" | "system", text: string): void {
    this.db.prepare(`INSERT INTO messages (session_id, at, role, text) VALUES (?, ?, ?, ?)`).run(sessionId, at, role, text);
  }

  listMessages(sessionId: string, limit = 500): Array<{ at: number; role: string; text: string }> {
    const rows = this.db
      .prepare(`SELECT at, role, text FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => ({ at: Number(r["at"]), role: String(r["role"]), text: String(r["text"]) }));
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  kvGet(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value?: unknown } | undefined;
    return row === undefined ? undefined : String(row["value"]);
  }

  /** 前缀扫描（历史重命名覆盖层一次取全量用；kv 表本身很小） */
  kvByPrefix(prefix: string): Map<string, string> {
    const rows = this.db.prepare(`SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\'`).all(
      `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    ) as Array<Record<string, unknown>>;
    const out = new Map<string, string>();
    for (const r of rows) out.set(String(r["key"]), String(r["value"]));
    return out;
  }

  // ---- 权限规则表（Phase 4）-------------------------------------------------

  addPermissionRule(rule: { runtimeId: string | null; kind: string | null; pattern: string; decision: "allow" | "deny" }): number {
    const result = this.db
      .prepare(`INSERT INTO permissions (runtime_id, kind, pattern, decision, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(rule.runtimeId, rule.kind, rule.pattern, rule.decision, Date.now());
    return Number(result.lastInsertRowid);
  }

  listPermissionRules(): Array<{
    id: number;
    runtimeId: string | null;
    kind: string | null;
    pattern: string;
    decision: string;
    createdAt: number;
  }> {
    const rows = this.db.prepare(`SELECT * FROM permissions ORDER BY id DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      runtimeId: r["runtime_id"] === null ? null : String(r["runtime_id"]),
      kind: r["kind"] === null ? null : String(r["kind"]),
      pattern: String(r["pattern"]),
      decision: String(r["decision"]),
      createdAt: Number(r["created_at"]),
    }));
  }

  deletePermissionRule(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM permissions WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  // ---- 自动化（Phase 5，v2 调度状态机）---------------------------------------

  /** automations 行的读取形态。scheduleRule 为调度权威（共享引擎的规则对象）。 */
  automationRow(r: Record<string, unknown>): ReturnType<Store["listAutomations"]>[number] {
    let rule: ScheduleRule | null = null;
    const raw = r["schedule_rule"];
    if (typeof raw === "string" && raw !== "") {
      try {
        rule = JSON.parse(raw) as ScheduleRule;
      } catch {
        rule = null; // 坏 JSON 按纯 cron 处理，不让一行脏数据掀掉整个列表
      }
    }
    const unitName = String(r["unit_name"]);
    return {
      id: Number(r["id"]),
      unitId: String(r["unit_id"]),
      unitName,
      name: r["name"] === null || r["name"] === undefined ? unitName : String(r["name"]),
      runtimeId: String(r["runtime_id"]),
      rootPath: String(r["root_path"]),
      prompt: String(r["prompt"]),
      model: r["model"] === null ? null : String(r["model"]),
      mode: r["mode"] === null ? null : String(r["mode"]),
      cron: String(r["cron"]),
      scheduleRule: rule,
      recurring: Number(r["recurring"] ?? 1) === 1,
      maxRuns: r["max_runs"] === null || r["max_runs"] === undefined ? null : Number(r["max_runs"]),
      runCount: Number(r["run_count"] ?? 0),
      enabled: Number(r["enabled"]) === 1,
      nextRunAt: r["next_run_at"] === null || r["next_run_at"] === undefined ? null : Number(r["next_run_at"]),
      lastRunAt: r["last_run_at"] === null || r["last_run_at"] === undefined ? null : Number(r["last_run_at"]),
      lastError: r["last_error"] === null || r["last_error"] === undefined ? null : String(r["last_error"]),
      lastErrorAt: r["last_error_at"] === null || r["last_error_at"] === undefined ? null : Number(r["last_error_at"]),
      launchMode: r["launch_mode"] === "headless" || r["launch_mode"] === "chat" ? r["launch_mode"] : "terminal",
      // 旧行 dispatch_target 为 NULL —— 按 new_session 读，保持 v2 行为不变
      dispatchTarget: r["dispatch_target"] === "existing_session" ? "existing_session" : "new_session",
      targetSessionId: r["target_session_id"] === null || r["target_session_id"] === undefined ? null : String(r["target_session_id"]),
      origin: r["origin"] === "quota_resume" ? "quota_resume" : "manual",
      createdAt: Number(r["created_at"]),
    };
  }

  createAutomation(a: {
    unitId: string;
    unitName: string;
    name: string;
    runtimeId: string;
    rootPath: string;
    prompt: string;
    model: string | null;
    mode: string | null;
    cron: string;
    scheduleRule: ScheduleRule | null;
    recurring: boolean;
    maxRuns: number | null;
    nextRunAt: number | null;
    launchMode: LaunchMode;
    dispatchTarget?: DispatchTarget;
    targetSessionId?: string | null;
    origin?: "manual" | "quota_resume";
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO automations (unit_id, unit_name, name, runtime_id, root_path, prompt, model, mode, cron,
           schedule_rule, recurring, max_runs, run_count, next_run_at, enabled, created_at, launch_mode,
           dispatch_target, target_session_id, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.unitId,
        a.unitName,
        a.name,
        a.runtimeId,
        a.rootPath,
        a.prompt,
        a.model,
        a.mode,
        a.cron,
        a.scheduleRule === null ? null : JSON.stringify(a.scheduleRule),
        a.recurring ? 1 : 0,
        a.maxRuns,
        a.nextRunAt,
        Date.now(),
        a.launchMode,
        a.dispatchTarget ?? "new_session",
        a.targetSessionId ?? null,
        a.origin ?? "manual",
      );
    return Number(result.lastInsertRowid);
  }

  listAutomations(): Array<{
    id: number;
    unitId: string;
    unitName: string;
    name: string;
    runtimeId: string;
    rootPath: string;
    prompt: string;
    model: string | null;
    mode: string | null;
    cron: string;
    scheduleRule: ScheduleRule | null;
    recurring: boolean;
    maxRuns: number | null;
    runCount: number;
    enabled: boolean;
    nextRunAt: number | null;
    lastRunAt: number | null;
    lastError: string | null;
    lastErrorAt: number | null;
    launchMode: LaunchMode;
    dispatchTarget: DispatchTarget;
    targetSessionId: string | null;
    origin: "manual" | "quota_resume";
    createdAt: number;
  }> {
    const rows = this.db.prepare(`SELECT * FROM automations ORDER BY id DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.automationRow(r));
  }

  getAutomation(id: number): { automation: ReturnType<Store["listAutomations"]>[number] } | undefined {
    const hit = this.listAutomations().find((a) => a.id === id);
    return hit === undefined ? undefined : { automation: hit };
  }

  /**
   * 局部更新。只写传入的字段（undefined = 不动），调度字段变化后由调用方
   * 负责把 nextRunAt 一起算好传进来 —— store 不懂调度语义。
   */
  updateAutomation(
    id: number,
    patch: Partial<{
      name: string;
      unitId: string;
      unitName: string;
      runtimeId: string;
      rootPath: string;
      prompt: string;
      model: string | null;
      mode: string | null;
      cron: string;
      scheduleRule: ScheduleRule | null;
      recurring: boolean;
      maxRuns: number | null;
      enabled: boolean;
      nextRunAt: number | null;
      lastRunAt: number | null;
      launchMode: LaunchMode;
      dispatchTarget?: DispatchTarget;
      targetSessionId?: string | null;
    }>,
  ): boolean {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const put = (col: string, v: string | number | boolean | null): void => {
      sets.push(`${col} = ?`);
      if (typeof v === "boolean") values.push(v ? 1 : 0);
      else values.push(v);
    };
    if (patch.name !== undefined) put("name", patch.name);
    if (patch.unitId !== undefined) put("unit_id", patch.unitId);
    if (patch.unitName !== undefined) put("unit_name", patch.unitName);
    if (patch.runtimeId !== undefined) put("runtime_id", patch.runtimeId);
    if (patch.rootPath !== undefined) put("root_path", patch.rootPath);
    if (patch.prompt !== undefined) put("prompt", patch.prompt);
    if (patch.model !== undefined) put("model", patch.model);
    if (patch.mode !== undefined) put("mode", patch.mode);
    if (patch.cron !== undefined) put("cron", patch.cron);
    if (patch.scheduleRule !== undefined) put("schedule_rule", patch.scheduleRule === null ? null : JSON.stringify(patch.scheduleRule));
    if (patch.recurring !== undefined) put("recurring", patch.recurring);
    if (patch.maxRuns !== undefined) put("max_runs", patch.maxRuns);
    if (patch.enabled !== undefined) put("enabled", patch.enabled);
    if (patch.nextRunAt !== undefined) put("next_run_at", patch.nextRunAt);
    if (patch.lastRunAt !== undefined) put("last_run_at", patch.lastRunAt);
    if (patch.launchMode !== undefined) put("launch_mode", patch.launchMode);
    if (patch.dispatchTarget !== undefined) put("dispatch_target", patch.dispatchTarget);
    if (patch.targetSessionId !== undefined) put("target_session_id", patch.targetSessionId);
    if (sets.length === 0) return true;
    values.push(id);
    const result = this.db.prepare(`UPDATE automations SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return Number(result.changes) > 0;
  }

  /**
   * 发火结算（认领）：next_run_at 先行前推 + run_count+1，之后再异步派发 ——
   * 两帧 tick 之间不会对同一次触发重复发火（single-flight 靠 DB 前推，不靠内存锁）。
   * terminal=true 同时停用（一次性/有限次任务跑完，对齐 ZCode 的 completed 收口）。
   */
  markAutomationFired(id: number, nextRunAt: number | null, lastRunAt: number, terminal: boolean): boolean {
    const result = this.db
      .prepare(
        `UPDATE automations SET next_run_at = ?, last_run_at = ?, run_count = run_count + 1,
           enabled = CASE WHEN ? THEN 0 ELSE enabled END WHERE id = ?`,
      )
      .run(nextRunAt, lastRunAt, terminal ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  /** 失败徽章：message=null 表示清除（下次成功发火时调用） */
  setAutomationError(id: number, message: string | null, at: number | null): void {
    this.db.prepare(`UPDATE automations SET last_error = ?, last_error_at = ? WHERE id = ?`).run(message, at, id);
  }

  setAutomationEnabled(id: number, enabled: boolean): boolean {
    const result = this.db.prepare(`UPDATE automations SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  deleteAutomation(id: number): boolean {
    // 先清运行记录再删主行：表上没有 FK 级联，不主动清就是孤儿行永久漏库
    // （批量删除 / 续跑自动清理都会高频走这里，泄漏会被放大）
    this.db.prepare(`DELETE FROM automation_runs WHERE automation_id = ?`).run(id);
    const result = this.db.prepare(`DELETE FROM automations WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  startAutomationRun(automationId: number, sessionId: string | null, trigger: "schedule" | "manual" = "schedule"): number {
    const result = this.db
      .prepare(`INSERT INTO automation_runs (automation_id, session_id, status, trigger, started_at) VALUES (?, ?, 'running', ?, ?)`)
      .run(automationId, sessionId, trigger, Date.now());
    return Number(result.lastInsertRowid);
  }

  /** 错过窗口的记账：不派发，只留痕 + 由调用方推进 next_run_at（misfire 不补跑口径） */
  recordSkippedAutomationRun(automationId: number, scheduledAt: number, reason: string): number {
    const result = this.db
      .prepare(`INSERT INTO automation_runs (automation_id, session_id, status, trigger, started_at, finished_at, detail)
                VALUES (?, NULL, 'skipped', 'schedule', ?, ?, ?)`)
      .run(automationId, scheduledAt, Date.now(), reason);
    return Number(result.lastInsertRowid);
  }

  setAutomationRunSession(runId: number, sessionId: string): void {
    this.db.prepare(`UPDATE automation_runs SET session_id = ? WHERE id = ?`).run(sessionId, runId);
  }

  finishAutomationRun(runId: number, status: "done" | "failed", detail: string | null): void {
    this.db
      .prepare(`UPDATE automation_runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?`)
      .run(status, Date.now(), detail, runId);
  }

  listAutomationRuns(automationId: number, limit = 20): Array<{
    id: number;
    automationId: number;
    sessionId: string | null;
    status: string;
    trigger: string;
    startedAt: number;
    finishedAt: number | null;
    detail: string | null;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?`)
      .all(automationId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      automationId: Number(r["automation_id"]),
      sessionId: r["session_id"] === null ? null : String(r["session_id"]),
      status: String(r["status"]),
      trigger: r["trigger"] === null || r["trigger"] === undefined ? "schedule" : String(r["trigger"]),
      startedAt: Number(r["started_at"]),
      finishedAt: r["finished_at"] === null ? null : Number(r["finished_at"]),
      detail: r["detail"] === null ? null : String(r["detail"]),
    }));
  }

  // ---- 待办 / GTD（backlog）----------------------------------------------------

  private backlogRow(r: Record<string, unknown>): BacklogRow {
    const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      id: Number(r["id"]),
      title: String(r["title"]),
      goal: String(r["goal"]),
      prompt: String(r["prompt"]),
      unitId: String(r["unit_id"]),
      unitName: String(r["unit_name"]),
      rootPath: String(r["root_path"]),
      runtimeId: String(r["runtime_id"] ?? ""),
      model: r["model"] === null || r["model"] === undefined ? null : String(r["model"]),
      mode: r["mode"] === null || r["mode"] === undefined ? null : String(r["mode"]),
      size: r["size"] === null || r["size"] === undefined ? null : String(r["size"]),
      launchMode: r["launch_mode"] === "headless" || r["launch_mode"] === "chat" ? r["launch_mode"] : "terminal",
      auto: Number(r["auto"] ?? 0) === 1,
      targetSessionId: r["target_session_id"] === null || r["target_session_id"] === undefined ? null : String(r["target_session_id"]),
      status: String(r["status"]),
      ignoreCount: Number(r["ignore_count"] ?? 0),
      lastProposedAt: nOrNull(r["last_proposed_at"]),
      lastRunAt: nOrNull(r["last_run_at"]),
      lastError: r["last_error"] === null || r["last_error"] === undefined ? null : String(r["last_error"]),
      reviewNote: r["review_note"] === null || r["review_note"] === undefined ? null : String(r["review_note"]),
      source: String(r["source"] ?? "manual"),
      sortPos: Number(r["sort_pos"] ?? 0),
      createdAt: Number(r["created_at"]),
      updatedAt: Number(r["updated_at"]),
    };
  }

  createBacklogItem(a: {
    title: string;
    goal: string;
    prompt: string;
    unitId: string;
    unitName: string;
    rootPath: string;
    runtimeId?: string;
    model?: string | null;
    mode?: string | null;
    size?: string | null;
    launchMode?: LaunchMode;
    auto?: boolean;
    targetSessionId?: string | null;
    source?: "manual" | "inbox";
    sortPos?: number;
  }): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO backlog_items (title, goal, prompt, unit_id, unit_name, root_path, runtime_id, model, mode,
           size, launch_mode, auto, target_session_id, status, ignore_count, source, sort_pos, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?, ?, ?)`,
      )
      .run(
        a.title,
        a.goal,
        a.prompt,
        a.unitId,
        a.unitName,
        a.rootPath,
        a.runtimeId ?? "",
        a.model ?? null,
        a.mode ?? null,
        a.size ?? null,
        a.launchMode ?? "terminal",
        a.auto === true ? 1 : 0,
        a.targetSessionId ?? null,
        a.source ?? "manual",
        a.sortPos ?? now,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  listBacklogItems(): BacklogRow[] {
    // done 的沉底按时间排，活跃的按手动排序位（顺序即优先级）
    const rows = this.db
      .prepare(`SELECT * FROM backlog_items ORDER BY status = 'done', sort_pos, id DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.backlogRow(r));
  }

  getBacklogItem(id: number): BacklogRow | undefined {
    const row = this.db.prepare(`SELECT * FROM backlog_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.backlogRow(row);
  }

  /** 局部更新（undefined = 不动）。状态迁移由调用方负责合法性，store 只管落盘。 */
  updateBacklogItem(
    id: number,
    patch: Partial<{
      title: string;
      goal: string;
      prompt: string;
      unitId: string;
      unitName: string;
      rootPath: string;
      runtimeId: string;
      model: string | null;
      mode: string | null;
      size: string | null;
      launchMode: LaunchMode;
      auto: boolean;
      targetSessionId: string | null;
      status: string;
      ignoreCount: number;
      lastProposedAt: number | null;
      lastRunAt: number | null;
      lastError: string | null;
      reviewNote: string | null;
      sortPos: number;
    }>,
  ): boolean {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const put = (col: string, v: string | number | null): void => {
      sets.push(`${col} = ?`);
      values.push(v);
    };
    if (patch.title !== undefined) put("title", patch.title);
    if (patch.goal !== undefined) put("goal", patch.goal);
    if (patch.prompt !== undefined) put("prompt", patch.prompt);
    if (patch.unitId !== undefined) put("unit_id", patch.unitId);
    if (patch.unitName !== undefined) put("unit_name", patch.unitName);
    if (patch.rootPath !== undefined) put("root_path", patch.rootPath);
    if (patch.runtimeId !== undefined) put("runtime_id", patch.runtimeId);
    if (patch.model !== undefined) put("model", patch.model);
    if (patch.mode !== undefined) put("mode", patch.mode);
    if (patch.size !== undefined) put("size", patch.size);
    if (patch.launchMode !== undefined) put("launch_mode", patch.launchMode);
    if (patch.auto !== undefined) put("auto", patch.auto ? 1 : 0);
    if (patch.targetSessionId !== undefined) put("target_session_id", patch.targetSessionId);
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.ignoreCount !== undefined) put("ignore_count", patch.ignoreCount);
    if (patch.lastProposedAt !== undefined) put("last_proposed_at", patch.lastProposedAt);
    if (patch.lastRunAt !== undefined) put("last_run_at", patch.lastRunAt);
    if (patch.lastError !== undefined) put("last_error", patch.lastError);
    if (patch.reviewNote !== undefined) put("review_note", patch.reviewNote);
    if (patch.sortPos !== undefined) put("sort_pos", patch.sortPos);
    if (sets.length === 0) return true;
    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    const result = this.db.prepare(`UPDATE backlog_items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return Number(result.changes) > 0;
  }

  deleteBacklogItem(id: number): boolean {
    this.db.prepare(`DELETE FROM backlog_runs WHERE item_id = ?`).run(id);
    // 清单条目还链着这个任务的话，链接一并断掉 —— 不然 LEFT JOIN 出 NULL 快照，
    // inboxRow 会把它捏造成「任务 #N · 就绪」的幽灵链接
    this.db.prepare(`UPDATE inbox_entries SET task_id = NULL, updated_at = ? WHERE task_id = ?`).run(Date.now(), id);
    const result = this.db.prepare(`DELETE FROM backlog_items WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  startBacklogRun(itemId: number, sessionId: string | null, runtimeId: string, trigger: "gtd" | "manual" | "autopilot" = "gtd"): number {
    const result = this.db
      .prepare(`INSERT INTO backlog_runs (item_id, session_id, runtime_id, status, trigger, started_at) VALUES (?, ?, ?, 'running', ?, ?)`)
      .run(itemId, sessionId, runtimeId, trigger, Date.now());
    return Number(result.lastInsertRowid);
  }

  setBacklogRunSession(runId: number, sessionId: string): void {
    this.db.prepare(`UPDATE backlog_runs SET session_id = ? WHERE id = ?`).run(sessionId, runId);
  }

  finishBacklogRun(runId: number, status: "done" | "failed", detail: string | null): void {
    this.db.prepare(`UPDATE backlog_runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?`).run(status, Date.now(), detail, runId);
  }

  listBacklogRuns(itemId: number, limit = 10): Array<{
    id: number;
    itemId: number;
    sessionId: string | null;
    runtimeId: string;
    status: string;
    trigger: string;
    startedAt: number;
    finishedAt: number | null;
    detail: string | null;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM backlog_runs WHERE item_id = ? ORDER BY id DESC LIMIT ?`)
      .all(itemId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      itemId: Number(r["item_id"]),
      sessionId: r["session_id"] === null || r["session_id"] === undefined ? null : String(r["session_id"]),
      runtimeId: String(r["runtime_id"]),
      status: String(r["status"]),
      trigger: String(r["trigger"] ?? "gtd"),
      startedAt: Number(r["started_at"]),
      finishedAt: r["finished_at"] === null || r["finished_at"] === undefined ? null : Number(r["finished_at"]),
      detail: r["detail"] === null || r["detail"] === undefined ? null : String(r["detail"]),
    }));
  }

  /** 最近的运行引用（卡片与执行中判定共用） */
  latestBacklogRun(itemId: number): ReturnType<Store["listBacklogRuns"]>[number] | undefined {
    return this.listBacklogRuns(itemId, 1)[0];
  }

  /** 仍未收口的运行（重启自愈用）：status=running 的全量 */
  listRunningBacklogRuns(): Array<{ runId: number; itemId: number; sessionId: string | null; runtimeId: string; startedAt: number }> {
    const rows = this.db
      .prepare(`SELECT id, item_id, session_id, runtime_id, started_at FROM backlog_runs WHERE status = 'running'`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      runId: Number(r["id"]),
      itemId: Number(r["item_id"]),
      sessionId: r["session_id"] === null || r["session_id"] === undefined ? null : String(r["session_id"]),
      runtimeId: String(r["runtime_id"]),
      startedAt: Number(r["started_at"]),
    }));
  }

  // ---- 清单（inbox）-------------------------------------------------------------

  private inboxRow(r: Record<string, unknown>): InboxEntry {
    const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    let hints: InboxHints | null = null;
    try {
      hints = normalizeInboxHints(r["hints_json"] === null || r["hints_json"] === undefined ? null : JSON.parse(String(r["hints_json"])));
    } catch {
      hints = null;
    }
    const taskId = nOrNull(r["task_id"]);
    return {
      id: Number(r["id"]),
      text: String(r["text"]),
      category: r["category"] === null || r["category"] === undefined ? null : String(r["category"]),
      categoryNote: r["category_note"] === null || r["category_note"] === undefined ? null : String(r["category_note"]),
      hints,
      task:
        taskId !== null
          ? {
              id: taskId,
              // 快照字段（title/status）由 list 时的 join 补齐 —— row 本体只存 id
              title: String(r["task_title"] ?? ""),
              status: String(r["task_status"] ?? "ready") as BacklogStatus,
            }
          : null,
      status: (["pending", "classified", "failed"].includes(String(r["status"])) ? String(r["status"]) : "pending") as InboxStatus,
      createdAt: Number(r["created_at"]),
      classifiedAt: nOrNull(r["classified_at"]),
      updatedAt: Number(r["updated_at"]),
    };
  }

  createInboxEntry(a: { text: string; category?: string | null; hints?: InboxHints | null; status?: InboxStatus }): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO inbox_entries (text, category, hints_json, status, created_at, classified_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.text,
        a.category ?? null,
        a.hints === null || a.hints === undefined ? null : JSON.stringify(a.hints),
        a.status ?? (a.category !== undefined && a.category !== null ? "classified" : "pending"),
        now,
        a.category !== undefined && a.category !== null ? now : null,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  /** 清单全量（task 快照 left join backlog_items，页面不用二次拼装） */
  listInboxEntries(): InboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, b.title AS task_title, b.status AS task_status
         FROM inbox_entries e LEFT JOIN backlog_items b ON b.id = e.task_id
         ORDER BY e.id DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.inboxRow(r));
  }

  getInboxEntry(id: number): InboxEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT e.*, b.title AS task_title, b.status AS task_status
         FROM inbox_entries e LEFT JOIN backlog_items b ON b.id = e.task_id WHERE e.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.inboxRow(row);
  }

  /** 局部更新（undefined = 不动）；taskTitle 走 backlog_items，这里不管 */
  updateInboxEntry(
    id: number,
    patch: Partial<{
      text: string;
      category: string | null;
      categoryNote: string | null;
      hints: InboxHints | null;
      taskId: number | null;
      status: InboxStatus;
      classifiedAt: number | null;
    }>,
  ): boolean {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const put = (col: string, v: string | number | null): void => {
      sets.push(`${col} = ?`);
      values.push(v);
    };
    if (patch.text !== undefined) put("text", patch.text);
    if (patch.category !== undefined) put("category", patch.category);
    if (patch.categoryNote !== undefined) put("category_note", patch.categoryNote);
    if (patch.hints !== undefined) put("hints_json", patch.hints === null ? null : JSON.stringify(patch.hints));
    if (patch.taskId !== undefined) put("task_id", patch.taskId);
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.classifiedAt !== undefined) put("classified_at", patch.classifiedAt);
    if (sets.length === 0) return true;
    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    const result = this.db.prepare(`UPDATE inbox_entries SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return Number(result.changes) > 0;
  }

  deleteInboxEntry(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM inbox_entries WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  // ---- 手动派发终端（terminal.dispatch → unit.history 的 manual 条目）----------

  startTerminalRun(a: { terminalId: string; unitId: string; unitName: string; runtimeId: string; title?: string | null; resumeRef?: string | null }): number {
    const result = this.db
      .prepare(
        `INSERT INTO terminal_runs (terminal_id, unit_id, unit_name, runtime_id, status, started_at, title, resume_ref)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(a.terminalId, a.unitId, a.unitName, a.runtimeId, Date.now(), a.title ?? null, a.resumeRef ?? null);
    return Number(result.lastInsertRowid);
  }

  /** 最近一条挂着该原生引用的终端运行行（「回到同一会话不增行」的定位查询） */
  latestTerminalRunByResume(runtimeId: string, resumeRef: string): { id: number } | undefined {
    const row = this.db
      .prepare(`SELECT id FROM terminal_runs WHERE runtime_id = ? AND resume_ref = ? ORDER BY id DESC LIMIT 1`)
      .get(runtimeId, resumeRef) as { id: unknown } | undefined;
    return row === undefined ? undefined : { id: Number(row.id) };
  }

  /**
   * 重挂：同一场原生会话再次打开时，把既有运行行指向新终端并复位为 running ——
   * 「回到它」是一次继续，不是一条新记录（用户在历史里点同一行 N 次，列表里
   * 不该多出 N 条「手动 交互式会话」）。exit 帧按 terminal_id 结算照常命中。
   */
  reattachTerminalRun(id: number, terminalId: string): void {
    this.db
      .prepare(
        `UPDATE terminal_runs SET terminal_id = ?, status = 'running', started_at = ?, finished_at = NULL, detail = NULL
         WHERE id = ?`,
      )
      .run(terminalId, Date.now(), id);
  }

  /** 更新终端运行的标题或恢复引用（捕获到首条消息时实时写回） */
  setTerminalRunTitle(terminalId: string, title: string, resumeRef?: string | null): void {
    if (resumeRef) {
      this.db
        .prepare(`UPDATE terminal_runs SET title = ?, resume_ref = ? WHERE terminal_id = ?`)
        .run(title, resumeRef, terminalId);
    } else {
      this.db
        .prepare(`UPDATE terminal_runs SET title = ? WHERE terminal_id = ?`)
        .run(title, terminalId);
    }
  }

  /** 历史回溯修补：按记录 id 更新标题与原生会话引用 */
  updateTerminalRunResume(id: number, title: string, resumeRef: string | null): void {
    this.db
      .prepare(`UPDATE terminal_runs SET title = ?, resume_ref = ? WHERE id = ?`)
      .run(title, resumeRef, id);
  }

  /** 按终端 id 结算（autoterm id 全局唯一；不存在的 id 静默无操作） */
  finishTerminalRun(terminalId: string, status: "done" | "failed", detail: string | null, outputText?: string | null): void {
    if (outputText !== undefined && outputText !== null) {
      this.db
        .prepare(`UPDATE terminal_runs SET status = ?, finished_at = ?, detail = ?, output_text = ? WHERE terminal_id = ? AND status = 'running'`)
        .run(status, Date.now(), detail, outputText, terminalId);
      this.saveTerminalTranscript(terminalId, outputText);
    } else {
      this.db
        .prepare(`UPDATE terminal_runs SET status = ?, finished_at = ?, detail = ? WHERE terminal_id = ? AND status = 'running'`)
        .run(status, Date.now(), detail, terminalId);
    }
  }

  saveTerminalTranscript(terminalId: string, outputText: string): void {
    try {
      this.db
        .prepare(`INSERT INTO terminal_transcripts (terminal_id, output_text, created_at) VALUES (?, ?, ?) ON CONFLICT(terminal_id) DO UPDATE SET output_text = excluded.output_text`)
        .run(terminalId, outputText, Date.now());
    } catch {
      // 容错
    }
  }

  getTerminalTranscript(terminalId: string): string | null {
    try {
      const row = this.db
        .prepare(`SELECT output_text FROM terminal_transcripts WHERE terminal_id = ?`)
        .get(terminalId) as { output_text: string } | undefined;
      if (row && typeof row.output_text === "string") return row.output_text;
      const tr = this.db
        .prepare(`SELECT output_text FROM terminal_runs WHERE terminal_id = ?`)
        .get(terminalId) as { output_text: string } | undefined;
      return tr && typeof tr.output_text === "string" ? tr.output_text : null;
    } catch {
      return null;
    }
  }

  listTerminalRuns(unitId?: string, limit = 50): Array<{
    id: number;
    terminalId: string;
    unitId: string;
    unitName: string;
    runtimeId: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    detail: string | null;
    title: string | null;
    resumeRef: string | null;
  }> {
    const rows = (unitId
      ? this.db.prepare(`SELECT * FROM terminal_runs WHERE unit_id = ? ORDER BY id DESC LIMIT ?`).all(unitId, limit)
      : this.db.prepare(`SELECT * FROM terminal_runs ORDER BY id DESC LIMIT ?`).all(limit)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      terminalId: String(r["terminal_id"]),
      unitId: String(r["unit_id"]),
      unitName: String(r["unit_name"]),
      runtimeId: String(r["runtime_id"]),
      status: String(r["status"]),
      startedAt: Number(r["started_at"]),
      finishedAt: r["finished_at"] === null || r["finished_at"] === undefined ? null : Number(r["finished_at"]),
      detail: r["detail"] === null || r["detail"] === undefined ? null : String(r["detail"]),
      title: r["title"] === null || r["title"] === undefined ? null : String(r["title"]),
      resumeRef: r["resume_ref"] === null || r["resume_ref"] === undefined ? null : String(r["resume_ref"]),
    }));
  }

  /** 重启自愈用：running 的全量（PTY 随 daemon 一起死，全部按中断收口） */
  listRunningTerminalRuns(): Array<{ terminalId: string; unitId: string }> {
    const rows = this.db
      .prepare(`SELECT terminal_id, unit_id FROM terminal_runs WHERE status = 'running'`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({ terminalId: String(r["terminal_id"]), unitId: String(r["unit_id"]) }));
  }

  /**
   * 被自动化或待办认领的全部会话 id（全量，不受单次列表 limit 截断限制）：
   * unit.history 合并时间轴时将会话条目去重，防止历史上的 headless 会话溢出成无标题杂项。
   */
  getClaimedSessionIds(): Set<string> {
    const set = new Set<string>();
    const aRows = this.db
      .prepare(`SELECT session_id FROM automation_runs WHERE session_id IS NOT NULL AND session_id NOT LIKE 'autoterm_%'`)
      .all() as Array<{ session_id: string }>;
    for (const r of aRows) set.add(r.session_id);
    const bRows = this.db
      .prepare(`SELECT session_id FROM backlog_runs WHERE session_id IS NOT NULL AND session_id NOT LIKE 'autoterm_%'`)
      .all() as Array<{ session_id: string }>;
    for (const r of bRows) set.add(r.session_id);
    return set;
  }

  // ---- 记忆三柱（Phase 7，sqlite 后端）---------------------------------------

  insertMemory(pillar: string, content: string, source: string | null): number {
    const result = this.db
      .prepare(`INSERT INTO memory (pillar, content, source, created_at) VALUES (?, ?, ?, ?)`)
      .run(pillar, content, source, Date.now());
    return Number(result.lastInsertRowid);
  }

  listMemory(pillar: string, limit = 200): Array<{ id: number; pillar: string; content: string; source: string | null; createdAt: number }> {
    const rows = this.db
      .prepare(`SELECT * FROM memory WHERE pillar = ? ORDER BY id DESC LIMIT ?`)
      .all(pillar, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      pillar: String(r["pillar"]),
      content: String(r["content"]),
      source: r["source"] === null ? null : String(r["source"]),
      createdAt: Number(r["created_at"]),
    }));
  }

  searchMemory(pillar: string, query: string, limit = 10): Array<{ id: number; content: string; source: string | null; createdAt: number }> {
    // sqlite 端的检索就是 LIKE 兜底（语义检索是 WeKnora 的事；sqlite 后端保"永远可用"）
    // ⚠ 用户查询里的 `%` / `_` 必须转义：不转义时搜 "_" 或 "%" 会命中**所有**行
    // （LIKE 里它们是通配符），看起来像「检索坏了」。
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db
      .prepare(`SELECT * FROM memory WHERE pillar = ? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`)
      .all(pillar, `%${escaped}%`, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      content: String(r["content"]),
      source: r["source"] === null ? null : String(r["source"]),
      createdAt: Number(r["created_at"]),
    }));
  }

  // ---- 分发日志（docs/10 WP-3）------------------------------------------------
  insertDispatch(input: {
    sessionId: string;
    runtimeId: string;
    rootPath: string;
    userText: string;
    injectedBlock: string;
    injectedChars: number;
    parts: ReadonlyArray<{ scope: string; sourcePath: string; chars: number }>;
    createdAt: number;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO dispatches
         (session_id, runtime_id, root_path, user_text, injected_block, injected_chars, parts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.runtimeId,
        input.rootPath,
        input.userText,
        input.injectedBlock,
        input.injectedChars,
        JSON.stringify(input.parts),
        input.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  listDispatches(sessionId: string): Array<{
    id: number;
    runtimeId: string;
    rootPath: string;
    userText: string;
    injectedBlock: string;
    injectedChars: number;
    parts: Array<{ scope: string; sourcePath: string; chars: number }>;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM dispatches WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let parts: Array<{ scope: string; sourcePath: string; chars: number }> = [];
      try {
        parts = JSON.parse(String(r["parts_json"] ?? "[]")) as typeof parts;
      } catch {
        // 坏 parts 不该让整条日志读不出来
      }
      return {
        id: Number(r["id"]),
        runtimeId: String(r["runtime_id"]),
        rootPath: String(r["root_path"]),
        userText: String(r["user_text"]),
        injectedBlock: String(r["injected_block"]),
        injectedChars: Number(r["injected_chars"]),
        parts,
        createdAt: Number(r["created_at"]),
      };
    });
  }

  // ---- curator 遥测（docs/10 WP-9）--------------------------------------------

  listMemoryMeta(prefix?: string): Array<{
    path: string; bytes: number; charUsed: number; useCount: number;
    lastUsedAt: number | null; hitCount: number; lastHitAt: number | null;
    state: string; pinned: boolean; createdAt: number;
  }> {
    // 不用 `LIKE '${prefix}%'`：`_` 和 `%` 在 LIKE 里是通配符，
    // 而 Windows 用户目录带下划线极常见（my_project / agent_workbench）——
    // 会把**别的项目**的遥测也捞进来，curator 的项目隔离就破了。
    // `substr(path,1,?)=?` 是纯字符串前缀比较，没有通配符语义。
    //
    // ⚠ 但纯前缀仍然会串到「同名前缀的兄弟目录」：prefix=`C:/work/my_project` 时
    // `C:/work/my_project2/MEMORY.md` 也算命中。前缀必须带路径分隔符
    // （两种斜杠都试，库里的路径写法不保证统一），目录自身用精确相等兜一条。
    const base = prefix === undefined ? undefined : prefix.replace(/[\\/]+$/, "");
    const rows = (
      prefix === undefined
        ? this.db.prepare(`SELECT * FROM memory_meta ORDER BY path`).all()
        : this.db
            .prepare(
              `SELECT * FROM memory_meta
               WHERE path = ? OR substr(path, 1, ?) = ? OR substr(path, 1, ?) = ?
               ORDER BY path`,
            )
            .all(
              prefix,
              base!.length + 1, `${base!}/`,
              base!.length + 1, `${base!}\\`,
            )
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      path: String(r["path"]),
      bytes: Number(r["bytes"]),
      charUsed: Number(r["char_used"]),
      useCount: Number(r["use_count"]),
      lastUsedAt: r["last_used_at"] === null ? null : Number(r["last_used_at"]),
      hitCount: Number(r["hit_count"]),
      lastHitAt: r["last_hit_at"] === null ? null : Number(r["last_hit_at"]),
      state: String(r["state"]),
      pinned: Number(r["pinned"]) === 1,
      createdAt: Number(r["created_at"]),
    }));
  }

  upsertMemoryMeta(m: {
    path: string; bytes: number; charUsed: number; useCount: number;
    lastUsedAt: number | null; hitCount: number; lastHitAt: number | null;
    state: string; pinned: boolean; createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_meta
         (path, bytes, char_used, use_count, last_used_at, hit_count, last_hit_at, state, pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           bytes=excluded.bytes, char_used=excluded.char_used,
           use_count=excluded.use_count, last_used_at=excluded.last_used_at,
           hit_count=excluded.hit_count, last_hit_at=excluded.last_hit_at,
           state=excluded.state, pinned=excluded.pinned`,
      )
      .run(
        m.path, m.bytes, m.charUsed, m.useCount, m.lastUsedAt,
        m.hitCount, m.lastHitAt, m.state, m.pinned ? 1 : 0, m.createdAt,
      );
  }

  /** 记一次「被注入过」—— curator 判断「多久没用了」的唯一依据 */
  markMemoryUsed(path: string, at: number, charUsed: number): void {
    this.db
      .prepare(
        // ⚠ bytes 以前也绑 charUsed —— 字符数被当成字节数写进库，memory.telemetry
        // 从此永久显示一个错的体积（ON CONFLICT 分支不刷新 bytes，只有 curator
        // 钉选时才会被 upsertMemoryMeta 纠正）。这里没有真实字节数就写 0：
        // 「不知道」比「记一个错的」好。
        `INSERT INTO memory_meta (path, bytes, char_used, use_count, last_used_at, state, pinned, created_at)
         VALUES (?, 0, ?, 1, ?, 'active', 0, ?)
         ON CONFLICT(path) DO UPDATE SET
           use_count = use_count + 1, last_used_at = excluded.last_used_at, char_used = excluded.char_used`,
      )
      .run(path, charUsed, at, at);
  }

  private toRow(r: Record<string, unknown>): SessionRow {
    let stats: StatsJson = EMPTY_STATS;
    try {
      stats = { ...EMPTY_STATS, ...(JSON.parse(String(r["stats_json"] ?? "{}")) as Partial<StatsJson>) };
    } catch {
      // 坏行按空 stats 处理，不掀翻 listSessions
    }
    return {
      id: String(r["id"]),
      unitId: String(r["unit_id"]),
      runtimeId: String(r["runtime_id"]),
      title: String(r["title"]),
      status: String(r["status"]),
      startedAt: Number(r["started_at"]),
      endedAt: r["ended_at"] === null || r["ended_at"] === undefined ? null : Number(r["ended_at"]),
      cliRef: r["cli_ref"] === null || r["cli_ref"] === undefined ? null : String(r["cli_ref"]),
      rootPath: r["root_path"] === null || r["root_path"] === undefined ? null : String(r["root_path"]),
      source: r["source"] === null || r["source"] === undefined ? null : String(r["source"]),
      conversationId: r["conversation_id"] === null || r["conversation_id"] === undefined ? null : String(r["conversation_id"]),
      lastSeq: Number(r["last_seq"] ?? 0),
      turnCount: Number(r["turn_count"] ?? 0),
      forkOfSession: r["fork_of_session"] === null || r["fork_of_session"] === undefined ? null : String(r["fork_of_session"]),
      forkAtSeq: r["fork_at_seq"] === null || r["fork_at_seq"] === undefined ? null : Number(r["fork_at_seq"]),
      forkKind:
        r["fork_kind"] === "branch" || r["fork_kind"] === "revision" ? r["fork_kind"] : null,
      stats,
    };
  }

  close(): void {
    this.db.close();
  }
}
