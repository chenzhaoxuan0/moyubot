/**
 * 设置页「MCP 服务」分区 —— 分执行器管理各家原生配置里的 MCP 服务。
 *
 * 领域语义（CONTEXT.md「技能与扩展」+ ADR 0004）：
 * - 原生配置文件是唯一真相源：打开页面实时读盘，用户在原生 TUI 里的手改天然被尊重；
 * - 停用 = 条目从原生文件移除并存入停用库（不是镜像，只是留档）；恢复即写回；
 * - 乐观锁：每次变更带读盘时的指纹，盘上被外部改过 → 冲突三选一（覆盖 / 重载 / 取消）；
 * - 跨执行器复制是一次性动作：读源 → 格式转换 → 写目标，此后各家独立演化。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { McpInventory, McpMutationResult, McpServerEntry, McpServerInstance, McpServerRow } from "../core/mcp.ts";
import {
  mcpCopyRpc,
  mcpInventoryRpc,
  mcpReadFileRpc,
  mcpRemoveRpc,
  mcpSaveRpc,
  mcpSetEnabledRpc,
} from "../adapters/daemon/client.ts";
import { Toggle } from "./SettingsPage.tsx";
import { cn } from "./cn.ts";

type LoadStatus = "loading" | "ready" | "error";

interface ConflictState {
  readonly message: string;
  /** 覆盖重试：同一操作但不带指纹（用户已知晓盘上变化，选择以工作台为准） */
  readonly retry: () => Promise<void>;
}

export function McpSettingsSection() {
  const [inv, setInv] = useState<McpInventory | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  /** 拉取错误（load 自管：成功清、失败设；有旧数据时不清屏只挂横幅） */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** 操作错误（启停/编辑/删除/复制）——与 loadErr 分离，清单重载不会把它冲掉 */
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("claude");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [lastMutation, setLastMutation] = useState<{ executorId: string; text: string } | null>(null);
  /** 编辑器（新建/编辑）与复制面板互斥展开 */
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; entry: McpServerEntry } | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
  /** 逐家 / 矩阵两种视图（矩阵 = cc-switch AppMatrix 形态的真相源实时投影） */
  const [view, setView] = useState<"list" | "matrix">("list");
  /** 矩阵在途格子（`${row}|${executorId}`） */
  const [cellPending, setCellPending] = useState<ReadonlySet<string>>(new Set());
  /** 请求序号：并发 load 时只有最新一次允许写状态（旧响应后到不得覆盖新数据） */
  const reqSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++reqSeq.current;
    try {
      const data = await mcpInventoryRpc();
      if (seq !== reqSeq.current) return;
      setInv(data);
      setStatus("ready");
      setLoadErr(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      // 拉取失败保留旧清单（好过清屏），只在从没成功过时进 error 态
      setStatus((s) => (s === "ready" ? "ready" : "error"));
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const file = inv?.files.find((f) => f.executorId === selected);
  const sha = file?.sha;

  /** 统一变更出口：成功 → 记录落盘预览 + 就地更新指纹 + 重载；conflict → 三选一；其余 → 红条。
   *  executorId 显式传参：矩阵视图的操作跨执行器，锁与预览都按目标家算 */
  const runMutation = useCallback(
    (label: string, executorId: string, op: (expectedSha?: string) => Promise<McpMutationResult>): Promise<void> => {
      const fileSha = inv?.files.find((f) => f.executorId === executorId)?.sha;
      const attempt = async (withSha: boolean): Promise<void> => {
        try {
          const r = await op(withSha ? fileSha : undefined);
          setLastMutation({ executorId, text: r.newText });
          setConflict(null);
          setRawText(null); // 原文已过期（刚被改写），别和落盘预览打架
          // 回执的新指纹先就地更新：不等全量重载，紧接着的下一次操作就不会
          // 拿着旧 sha 撞出「自己和自己冲突」
          setInv((prev) =>
            prev === null
              ? prev
              : { ...prev, files: prev.files.map((f) => (f.executorId === executorId ? { ...f, sha: r.newSha } : f)) },
          );
          await load();
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "conflict") {
            const name = inv?.files.find((f) => f.executorId === executorId)?.executorName ?? executorId;
            setConflict({
              message: `${label}（${name}）：${e instanceof Error ? e.message : String(e)}`,
              retry: () => attempt(false),
            });
          } else {
            setErr(`${label}失败：${e instanceof Error ? e.message : String(e)}`);
          }
        }
      };
      return attempt(true);
    },
    [load, inv],
  );

  const rowsOf = (executorId: string): McpServerRow[] =>
    (inv?.rows ?? []).filter((r) => r.instances.some((i) => i.executorId === executorId));
  const instOf = (row: McpServerRow): McpServerInstance | undefined =>
    row.instances.find((i) => i.executorId === selected);

  const toggle = (name: string, disabled: boolean): void => {
    // enabled 的「下一态」恰是当前 disabled 位：live(disabled=false)点关 → enabled=false 停用；
    // 停用库(disabled=true)点开 → enabled=true 恢复
    void runMutation(disabled ? `恢复 ${name}` : `停用 ${name}`, selected, (s) => mcpSetEnabledRpc(selected, name, disabled, s));
  };

  const purge = (name: string): void => {
    void runMutation(`彻底删除 ${name}`, selected, (s) => mcpRemoveRpc(selected, name, { toVault: false, expectedSha: s }));
  };

  /** 矩阵格子操作：空 = 从行内首个启用实例分发（复制写入）；✓ = 停用进库；◦ = 从库恢复 */
  const matrixCell = (row: McpServerRow, executorId: string): void => {
    const key = `${row.name}|${executorId}`;
    const execName = inv?.files.find((f) => f.executorId === executorId)?.executorName ?? executorId;
    const inst = row.instances.find((i) => i.executorId === executorId);
    const markPending = (on: boolean): void =>
      setCellPending((prev) => {
        const n = new Set(prev);
        if (on) n.add(key);
        else n.delete(key);
        return n;
      });
    if (inst === undefined) {
      const src = row.instances.find((i) => !i.disabled);
      if (src === undefined) {
        setErr(`「${row.name}」在任何执行器上都没有定义——请先在某一家添加，再回矩阵分发`);
        return;
      }
      // 分发走复制通道：结果是逐目标 outcomes（不是单文件回执），独立处理
      markPending(true);
      void (async () => {
        try {
          const fileSha = inv?.files.find((f) => f.executorId === executorId)?.sha;
          const outcomes = await mcpCopyRpc(src.executorId, row.name, [executorId], fileSha !== undefined ? { [executorId]: fileSha } : {});
          const fail = outcomes.find((o) => !o.ok);
          if (fail !== undefined) setErr(`分发 ${row.name} 到 ${execName} 未完成：${fail.error}`);
          await load();
        } catch (e) {
          setErr(`分发 ${row.name} 到 ${execName} 失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          markPending(false);
        }
      })();
      return;
    }
    const label = inst.disabled ? `恢复 ${row.name}（${execName}）` : `停用 ${row.name}（${execName}）`;
    markPending(true);
    void runMutation(label, executorId, (s) => mcpSetEnabledRpc(executorId, row.name, inst.disabled, s)).finally(() => markPending(false));
  };

  const showRaw = (): void => {
    void (async () => {
      try {
        const r = await mcpReadFileRpc(selected);
        setRawText("missing" in r ? "（配置文件还不存在 —— 添加第一个服务时将创建）" : r.text);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  if (status === "loading") return <p className="text-body-sm text-ash">正在读取各执行器的 MCP 配置…</p>;
  if (inv === null) {
    return (
      <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">
        MCP 清单拉取失败：{loadErr ?? "daemon 未响应"}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* 视图切换：逐家（tab 进单家清单） / 矩阵（行=服务 × 列=执行器，cc-switch AppMatrix 形态） */}
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          {(["list", "matrix"] as const).map((v) => (
            <button
              key={v}
              onClick={() => {
                setView(v);
                setConflict(null);
                setErr(null);
                setLastMutation(null);
                setEditing(null);
                setCopyOpen(false);
              }}
              className={cn(
                "rounded-chip border px-2.5 py-1 text-caption transition",
                view === v ? "border-teal bg-teal-tint font-medium text-ink" : "border-line text-graphite hover:bg-line-soft hover:text-ink",
              )}
            >
              {v === "list" ? "逐家管理" : "统合矩阵"}
            </button>
          ))}
        </div>
        {view === "matrix" && (
          <span className="text-caption text-ash">
            打钩 = 分发到该执行器（从行内首个启用定义复制）；取消 = 停用进库；空心点 = 停用库可恢复
          </span>
        )}
      </div>

      {view === "matrix" ? (
        <McpMatrix inv={inv} pending={cellPending} onCell={matrixCell} />
      ) : (
        <>
      {/* 执行器 tab */}
      <div className="flex flex-wrap items-center gap-1.5">
        {inv.files.map((f) => (
          <button
            key={f.executorId}
            onClick={() => {
              setSelected(f.executorId);
              setEditing(null);
              setCopyOpen(false);
              setRawText(null);
              // 上家的冲突提示/错误/落盘预览不带过来：留着的话「覆盖重试」
              // 的闭包还绑着旧执行器，会在 B 家页面上覆写 A 家的配置文件
              setConflict(null);
              setErr(null);
              setLastMutation(null);
            }}
            className={cn(
              "rounded-chip border px-2.5 py-1 text-body-sm transition",
              f.executorId === selected
                ? "border-teal bg-teal-tint font-medium text-ink"
                : "border-line text-graphite hover:bg-line-soft hover:text-ink",
            )}
          >
            {f.executorName}
            {f.count !== undefined && <span className="ml-1 tnum text-caption">{f.count}</span>}
          </button>
        ))}
      </div>

      {/* 文件状态行 */}
      {file !== undefined && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="truncate font-mono text-caption text-ash" title={file.path}>{file.path}</span>
          {!file.exists && <span className="text-caption text-ash">（文件不存在，首次写入时创建）</span>}
          {file.error !== undefined && <span className="text-caption text-loss">{file.error}（修复前写入被拒绝）</span>}
          <button
            onClick={showRaw}
            className="ml-auto rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
          >
            查看原文
          </button>
        </div>
      )}

      {/* 工具行 */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            setCopyOpen(false);
            setEditing({ mode: "create" });
          }}
          className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas"
        >
          添加服务
        </button>
        <button
          onClick={() => {
            setEditing(null);
            setCopyOpen((v) => !v);
          }}
          className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite transition hover:bg-line-soft hover:text-ink"
        >
          从其他执行器复制…
        </button>
      </div>

      {editing !== null && (
        <EntryEditor
          initial={editing.mode === "edit" ? editing.entry : undefined}
          onCancel={() => setEditing(null)}
          onSubmit={(entry) => {
            const label = editing.mode === "edit" ? `编辑 ${entry.name}` : `添加 ${entry.name}`;
            setEditing(null);
            void runMutation(label, selected, (s) => mcpSaveRpc(selected, entry, s));
          }}
        />
      )}

      {copyOpen && (
        <CopyPanel
          inv={inv}
          targetId={selected}
          expectedSha={sha}
          onDone={async (outcomes) => {
            setCopyOpen(false);
            const fails = outcomes.filter((o) => !o.ok);
            if (fails.length > 0) setErr(`复制部分未完成：${fails.map((f) => `${f.executorId}（${f.error}）`).join("、")}`);
            else setLastMutation(null);
            await load();
          }}
        />
      )}

      {/* 冲突三选一 */}
      {conflict !== null && (
        <div className="rounded-btn border border-loss/40 bg-card px-3 py-2 text-caption leading-relaxed text-loss">
          <p>{conflict.message}</p>
          <div className="mt-1.5 flex gap-2">
            <button
              onClick={() => void conflict.retry()}
              className="rounded-btn bg-ink px-2.5 py-1 text-caption text-canvas"
            >
              覆盖重试
            </button>
            <button
              onClick={() => {
                setConflict(null);
                void load();
              }}
              className="rounded-btn border border-line px-2.5 py-1 text-caption text-graphite"
            >
              重载清单
            </button>
            <button onClick={() => setConflict(null)} className="rounded-btn border border-line px-2.5 py-1 text-caption text-graphite">
              取消
            </button>
          </div>
        </div>
      )}

      {loadErr !== null && (
        <p className="flex items-center gap-2 rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-ash">
          <span className="min-w-0 flex-1">清单刷新失败（保留上次内容）：{loadErr}</span>
          <button
            onClick={() => void load()}
            className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
          >
            重试
          </button>
        </p>
      )}

      {err !== null && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
      )}

      {/* 服务清单 */}
      <div className="overflow-hidden rounded-card border border-line bg-card">
        <ul className="divide-y divide-line-soft">
          {rowsOf(selected).length === 0 && (
            <li className="px-4 py-3 text-caption text-ash">这家还没有 MCP 服务。添加、或从其他执行器复制一份。</li>
          )}
          {rowsOf(selected).map((row) => {
            const inst = instOf(row);
            if (inst === undefined) return null;
            return (
              <McpRow
                key={row.name}
                name={row.name}
                inst={inst}
                onToggle={() => toggle(row.name, inst.disabled)}
                onPurge={() => purge(row.name)}
                onEdit={() => setEditing({ mode: "edit", entry: inst.entry })}
              />
            );
          })}
        </ul>
      </div>
        </>
      )}

      {/* 原文 / 落盘预览 */}
      {rawText !== null && (
        <details className="rounded-card border border-line bg-card px-4 py-2" open>
          <summary className="cursor-pointer text-caption font-medium text-graphite">配置文件原文</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-btn bg-canvas p-3 font-mono text-caption leading-relaxed text-ink">{rawText}</pre>
        </details>
      )}
      {lastMutation !== null && (
        <details className="rounded-card border border-line bg-card px-4 py-2" open>
          <summary className="cursor-pointer text-caption font-medium text-graphite">
            落盘后的内容（{inv.files.find((f) => f.executorId === lastMutation.executorId)?.executorName ?? lastMutation.executorId}）
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-btn bg-canvas p-3 font-mono text-caption leading-relaxed text-ink">{lastMutation.text}</pre>
        </details>
      )}

      {(inv.unsupported?.length ?? 0) > 0 && (
        <p className="text-caption leading-relaxed text-ash">
          无持久化配置、不在上列：
          {inv.unsupported!.map((u) => `${u.name}（${u.reason}）`).join("；")}。
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 行 */

function McpRow({
  name,
  inst,
  onToggle,
  onPurge,
  onEdit,
}: {
  name: string;
  inst: McpServerInstance;
  onToggle: () => void;
  onPurge: () => void;
  onEdit: () => void;
}) {
  const [confirmPurge, setConfirmPurge] = useState(false);
  useEffect(() => {
    if (!confirmPurge) return;
    const t = setTimeout(() => setConfirmPurge(false), 3000);
    return () => clearTimeout(t);
  }, [confirmPurge]);

  const summary =
    inst.entry.transport === "stdio"
      ? [inst.entry.command, ...(inst.entry.args ?? [])].join(" ")
      : (inst.entry.url ?? "");

  return (
    <li className={cn("flex items-center gap-3 px-4 py-2.5", inst.disabled && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn("truncate text-body-sm", inst.disabled ? "text-graphite" : "text-ink")}>{name}</span>
          <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-0.5 text-caption text-graphite">{inst.entry.transport}</span>
          {inst.disabled && <span className="shrink-0 text-caption text-ash">停用库</span>}
        </div>
        <p className="truncate font-mono text-caption text-ash" title={summary}>{summary}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Toggle on={!inst.disabled} onChange={onToggle} />
        {!inst.disabled ? (
          <button onClick={onEdit} className="rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink">
            编辑
          </button>
        ) : null}
        <button
          onClick={() => {
            if (confirmPurge) {
              setConfirmPurge(false); // 立即复位：3 秒窗口内连点不得重复触发删除
              onPurge();
            } else {
              setConfirmPurge(true);
            }
          }}
          className={cn(
            "rounded-btn border px-2 py-1 text-caption transition",
            confirmPurge ? "border-loss text-loss" : "border-line text-graphite hover:bg-line-soft hover:text-ink",
          )}
        >
          {confirmPurge ? "确认删除？" : "彻底删除"}
        </button>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------- 编辑器 */

function EntryEditor({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: McpServerEntry;
  onSubmit: (entry: McpServerEntry) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"form" | "json">("form");
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<McpServerEntry["transport"]>(initial?.transport ?? "stdio");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState((initial?.args ?? []).join(" "));
  const [env, setEnv] = useState(kvToText(initial?.env));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headers, setHeaders] = useState(kvToText(initial?.headers));
  const [jsonText, setJsonText] = useState(initial === undefined ? DEFAULT_ENTRY_JSON : JSON.stringify(initial, null, 2));
  const [formErr, setFormErr] = useState<string | null>(null);

  /** 从表单状态构造条目（不校验 —— JSON 模式预填与提交共用，提交前另行校验） */
  const buildFromForm = (): McpServerEntry => {
    const parsedEnv = textToKv(env, () => {});
    const parsedHeaders = textToKv(headers, () => {});
    return {
      name: name.trim(),
      transport,
      ...(transport === "stdio"
        ? {
            command: command.trim(),
            ...(args.trim() !== "" ? { args: args.trim().split(/\s+/) } : {}),
            ...(parsedEnv !== undefined && parsedEnv !== null ? { env: parsedEnv } : {}),
          }
        : {
            url: url.trim(),
            ...(parsedHeaders !== undefined && parsedHeaders !== null ? { headers: parsedHeaders } : {}),
          }),
    };
  };

  /** 提交前统一校验（两种模式共用，镜像后端 validateEntry） */
  const validateEntry = (entry: McpServerEntry): string | null => {
    if (entry.name === "") return "服务名不能为空";
    if (entry.name.startsWith(".")) return "服务名不能以点开头";
    if (/[\\/]/.test(entry.name)) return "服务名不能包含 / 或 \\";
    if (entry.transport !== "stdio" && entry.transport !== "http" && entry.transport !== "sse") {
      return "连接方式必须是 stdio / http / sse";
    }
    if (entry.transport === "stdio" && (entry.command === undefined || entry.command.trim() === "")) return "stdio 服务必须填命令";
    if (entry.transport !== "stdio" && (entry.url === undefined || entry.url.trim() === "")) return `${entry.transport} 服务必须填端点 URL`;
    if (initial !== undefined && entry.name !== initial.name) return "编辑时不能改名（改名 = 删除后新建）";
    return null;
  };

  const submit = (): void => {
    const entry = mode === "form" ? buildFromForm() : parseJsonEntry(jsonText);
    if (typeof entry === "string") {
      setFormErr(entry);
      return;
    }
    const v = validateEntry(entry);
    if (v !== null) {
      setFormErr(v);
      return;
    }
    onSubmit(entry);
  };

  /** 双模式互切：表单 → JSON 序列化当前值；JSON → 表单尽量回填（解析失败保持表单现值） */
  const switchMode = (next: "form" | "json"): void => {
    if (next === mode) return;
    if (next === "json") {
      setJsonText(JSON.stringify(buildFromForm(), null, 2));
    } else {
      try {
        const r = JSON.parse(jsonText) as Record<string, unknown>;
        if (typeof r.name === "string") setName(r.name);
        if (r.transport === "stdio" || r.transport === "http" || r.transport === "sse") setTransport(r.transport);
        if (typeof r.command === "string") setCommand(r.command);
        if (Array.isArray(r.args)) setArgs(r.args.filter((x): x is string => typeof x === "string").join(" "));
        if (typeof r.url === "string") setUrl(r.url);
        if (r.env !== null && typeof r.env === "object" && !Array.isArray(r.env)) {
          const e: Record<string, string> = {};
          for (const [k, val] of Object.entries(r.env)) if (typeof val === "string") e[k] = val;
          setEnv(kvToText(e));
        }
        if (r.headers !== null && typeof r.headers === "object" && !Array.isArray(r.headers)) {
          const h: Record<string, string> = {};
          for (const [k, val] of Object.entries(r.headers)) if (typeof val === "string") h[k] = val;
          setHeaders(kvToText(h));
        }
      } catch {
        /* JSON 暂时非法：保持表单现值，用户切回 JSON 可继续改 */
      }
    }
    setMode(next);
    setFormErr(null);
  };

  const input = "h-8 w-full rounded-btn border border-line bg-canvas px-2.5 font-mono text-body-sm text-ink focus:border-teal focus:outline-none";

  return (
    <div className="space-y-3 rounded-card border border-line bg-card p-4">
      <div className="flex items-center gap-2">
        <p className="text-caption font-medium text-graphite">{initial === undefined ? "添加服务" : `编辑 ${initial.name}`}</p>
        <div className="ml-auto flex gap-1">
          {(["form", "json"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              className={cn(
                "rounded-chip border px-2 py-0.5 text-caption transition",
                mode === m ? "border-teal bg-teal-tint font-medium text-ink" : "border-line text-graphite hover:bg-line-soft hover:text-ink",
              )}
            >
              {m === "form" ? "表单" : "JSON"}
            </button>
          ))}
        </div>
      </div>

      {mode === "form" ? (
        <>
          <Field label="服务名称" hint="各执行器配置里的唯一键名，斜杠菜单与日志里都叫它（如 web-reader）。编辑时不可改名">
            <input className={input} value={name} disabled={initial !== undefined} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="连接方式" hint="stdio = 本地命令子进程；http = Streamable HTTP 端点；sse = SSE 端点">
            <select
              className={cn(input, "font-sans")}
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpServerEntry["transport"])}
            >
              <option value="stdio">stdio（本地命令）</option>
              <option value="http">http（Streamable HTTP）</option>
              <option value="sse">sse（SSE 端点）</option>
            </select>
          </Field>
          {transport === "stdio" ? (
            <>
              <Field label="命令" hint="可执行文件名，如 npx / uvx / python。Windows 下 npx 等会自动包 cmd /c，无需手写">
                <input className={input} value={command} onChange={(e) => setCommand(e.target.value)} />
              </Field>
              <Field label="参数" hint="空格分隔（暂不支持含空格的单个参数，复杂参数请用 JSON 模式）">
                <input className={input} value={args} onChange={(e) => setArgs(e.target.value)} />
              </Field>
              <Field label="环境变量" hint="每行一个 KEY=VALUE，注入子进程环境（放 API Key 的地方）">
                <textarea className={cn(input, "h-20 py-1.5")} value={env} onChange={(e) => setEnv(e.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <Field label="端点 URL" hint="服务提供方的 MCP 端点，如 https://open.bigmodel.cn/api/mcp/xxx/mcp">
                <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <Field label="请求头" hint="每行一个 KEY=VALUE（如 Authorization=Bearer xxx）">
                <textarea className={cn(input, "h-20 py-1.5")} value={headers} onChange={(e) => setHeaders(e.target.value)} />
              </Field>
            </>
          )}
        </>
      ) : (
        <Field
          label="条目 JSON"
          hint={initial === undefined ? "完整条目定义，字段：name / transport / command / args / env / url / headers" : "完整条目定义；name 必须保持不变（改名 = 删除后新建）"}
        >
          <textarea
            className={cn(input, "h-64 py-1.5")}
            spellCheck={false}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
        </Field>
      )}

      {formErr !== null && <p className="text-caption text-loss">{formErr}</p>}
      <div className="flex gap-2">
        <button onClick={submit} className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas">保存</button>
        <button onClick={onCancel} className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite">取消</button>
      </div>
    </div>
  );
}

/** 编辑器字段：标题 + 控件（说明收进悬停，对齐 cc-switch 的表单形态） */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-caption font-medium text-graphite" title={hint}>
        {label}
      </p>
      {children}
    </div>
  );
}

/** 新建时的 JSON 模板 */
const DEFAULT_ENTRY_JSON = `{
  "name": "",
  "transport": "stdio",
  "command": "",
  "args": [],
  "env": {}
}`;

/** JSON 模式解析：返回条目或错误信息（字符串）。只收已知字段，与后端 sanitizeEntry 同口径 */
function parseJsonEntry(text: string): McpServerEntry | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "条目必须是 JSON 对象";
  const r = raw as Record<string, unknown>;
  if (r.transport !== "stdio" && r.transport !== "http" && r.transport !== "sse") {
    return "transport 必须是 stdio / http / sse";
  }
  const pick = (v: unknown): Record<string, string> | undefined => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
    return out;
  };
  const args = Array.isArray(r.args) && r.args.every((x) => typeof x === "string") ? (r.args as string[]) : undefined;
  return {
    name: typeof r.name === "string" ? r.name : "",
    transport: r.transport,
    ...(typeof r.command === "string" ? { command: r.command } : {}),
    ...(args !== undefined && args.length > 0 ? { args } : {}),
    ...(pick(r.env) !== undefined ? { env: pick(r.env) } : {}),
    ...(typeof r.url === "string" ? { url: r.url } : {}),
    ...(pick(r.headers) !== undefined ? { headers: pick(r.headers) } : {}),
  };
}

function kvToText(kv: Readonly<Record<string, string>> | undefined): string {
  if (kv === undefined) return "";
  return Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n");
}

/** KEY=VALUE 逐行解析；坏行返回 null 并把错误写进 setErr */
function textToKv(text: string, setErr: (m: string) => void): Record<string, string> | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const out: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      setErr(`这行不是 KEY=VALUE：${line}`);
      return null;
    }
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

/* ------------------------------------------------------------- 复制面板 */

function CopyPanel({
  inv,
  targetId,
  expectedSha,
  onDone,
}: {
  inv: McpInventory;
  targetId: string;
  expectedSha?: string;
  onDone: (outcomes: readonly { executorId: string; ok: boolean; error?: string }[]) => Promise<void>;
}) {
  // 源候选是挂载时的快照（inv 刷新后不追新）；count 缺省 = 解析失败的家，排除出复制源是保护
  const sources = inv.files.filter((f) => f.executorId !== targetId && (f.count ?? 0) > 0);
  const [src, setSrc] = useState(sources[0]?.executorId ?? "");
  const srcRows = inv.rows.filter((r) => r.instances.some((i) => i.executorId === src && !i.disabled));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const selectCls = "h-8 w-full rounded-btn border border-line bg-canvas px-2 text-body-sm text-ink focus:border-teal focus:outline-none";

  useEffect(() => {
    setName("");
  }, [src]);

  return (
    <div className="space-y-2.5 rounded-card border border-line bg-card p-4">
      <p className="text-caption font-medium text-graphite">
        从其他执行器复制到 {inv.files.find((f) => f.executorId === targetId)?.executorName}
        （一次性拷贝，此后两家各自演化；目标已有同名时跳过不覆盖）
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <select className={selectCls} value={src} onChange={(e) => setSrc(e.target.value)}>
          {sources.length === 0 && <option value="">（没有其他家有服务）</option>}
          {sources.map((f) => (
            <option key={f.executorId} value={f.executorId}>{f.executorName}（{f.count} 个）</option>
          ))}
        </select>
        <select className={selectCls} value={name} onChange={(e) => setName(e.target.value)}>
          <option value="">选择服务…</option>
          {srcRows.map((r) => (
            <option key={r.name} value={r.name}>{r.name}</option>
          ))}
        </select>
      </div>
      <button
        disabled={src === "" || name === "" || busy}
        onClick={() => {
          setBusy(true);
          void (async () => {
            // 指纹只在真拿到时才带 —— 空 sha 会被 daemon 当成"必然冲突"
            const expectedShas = expectedSha !== undefined ? { [targetId]: expectedSha } : {};
            const outcomes = await mcpCopyRpc(src, name, [targetId], expectedShas);
            await onDone(outcomes);
          })().finally(() => setBusy(false));
        }}
        className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas disabled:opacity-40"
      >
        {busy ? "复制中…" : "复制"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- 统合矩阵 */

/**
 * 行 = 服务（跨执行器按名聚合），列 = 执行器。格子三态：
 * ✓ = 该家配置文件里（live）；◦ = 该家停用库；空 = 该家没有。
 * 数据全部来自实时 inventory —— 矩阵是真相源的投影，不是账本。
 */
function McpMatrix({
  inv,
  pending,
  onCell,
}: {
  inv: McpInventory;
  pending: ReadonlySet<string>;
  onCell: (row: McpServerRow, executorId: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-card">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th className="sticky left-0 z-[1] bg-card px-3 py-2 text-left text-caption font-medium text-graphite">服务</th>
            {inv.files.map((f) => (
              <th key={f.executorId} className="min-w-[64px] px-1 py-2 text-center text-caption font-medium text-graphite" title={f.path}>
                <span className="block truncate">{f.executorName}</span>
                <span className={cn("tnum block text-[10px]", f.error !== undefined ? "text-loss" : "text-ash")}>
                  {f.error !== undefined ? "!" : f.count ?? "—"}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {inv.rows.length === 0 && (
            <tr>
              <td colSpan={inv.files.length + 1} className="px-4 py-3 text-caption text-ash">
                还没有任何 MCP 服务 —— 在「逐家管理」里添加第一条，再回矩阵分发到各家。
              </td>
            </tr>
          )}
          {inv.rows.map((row) => {
            const anyLive = row.instances.some((i) => !i.disabled);
            const transport = row.instances[0]?.entry.transport ?? "stdio";
            return (
              <tr key={row.name} className="border-b border-line-soft last:border-b-0">
                <td className="sticky left-0 z-[1] max-w-[200px] bg-card px-3 py-1.5">
                  <span className={cn("block truncate text-body-sm", anyLive ? "text-ink" : "text-ash")} title={row.name}>{row.name}</span>
                  <span className="block text-[10px] text-ash">{transport}</span>
                </td>
                {inv.files.map((f) => {
                  const inst = row.instances.find((i) => i.executorId === f.executorId);
                  const key = `${row.name}|${f.executorId}`;
                  const busy = pending.has(key);
                  const state = inst === undefined ? "none" : inst.disabled ? "vault" : "live";
                  const title =
                    state === "live" ? `${row.name} 已在 ${f.executorName}（点击停用进库）`
                      : state === "vault" ? `${row.name} 在 ${f.executorName} 停用库（点击恢复）`
                        : anyLive ? `分发到 ${f.executorName}（从行内首个启用定义复制）`
                          : "行内没有启用定义，无法分发";
                  return (
                    <td key={f.executorId} className="px-1 py-1 text-center">
                      <button
                        onClick={() => onCell(row, f.executorId)}
                        disabled={busy}
                        title={title}
                        className={cn(
                          "h-6 w-6 rounded-chip border text-caption leading-none transition",
                          state === "live" ? "border-teal bg-teal text-canvas"
                            : state === "vault" ? "border-line bg-line-soft text-graphite"
                              : "border-line bg-canvas text-ash hover:border-teal hover:text-teal",
                        )}
                      >
                        {busy ? "…" : state === "live" ? "✓" : state === "vault" ? "◦" : "+"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
