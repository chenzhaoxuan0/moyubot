import { useMemo, useState, type ReactElement } from "react";
import { FileUp, FolderCheck } from "lucide-react";
import { importSessionFile } from "../adapters/daemon/client.ts";
import { useHistoryPrefs } from "../store/useHistoryPrefs.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 「从分享文件导入」（docs/26 会话分享的接收侧）——选 .awb.json 分享文件 →
 * 预览（标题/执行器/起止/规模）→ 选目标 bot（按 bundle 里的 rootPath 自动匹配
 * 高亮，可手改）→ session.importFile 落库。
 *
 * 与「导入外部会话」的差别：外部导入读的是本机 CLI 原生存储（登记引用），
 * 这里读的是**别的工作台导出的全量 bundle**（文件即数据）——导入后消息/
 * 工具卡/思考/用量完整回放，带「分享」标签；原生续跑引用已剥离，继续对话
 * 走换代开新段。
 */

/** bundle 的轻量预览形态（只取展示要用的字段；完整校验在 daemon 侧） */
interface ParsedBundle {
  readonly title: string;
  readonly runtimeId: string;
  readonly rootPath: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly messages: number;
  readonly events: number;
  readonly raw: unknown;
}

/** 路径归一比对（Windows 大小写不敏感 + 斜杠差异） */
const normPath = (p: string): string => p.replace(/[\\/]+/g, "/").replace(/\/+$/u, "").toLowerCase();

function fmtWhen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function parseBundleFile(text: string, fileName: string): ParsedBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${fileName} 不是合法的 JSON 文件`);
  }
  const b = parsed as Record<string, unknown>;
  if (typeof b !== "object" || b === null || b.format !== "awb-session") {
    throw new Error(`${fileName} 不是工作台会话分享文件（缺少 awb-session 格式标记）`);
  }
  const s = (b.session ?? {}) as Record<string, unknown>;
  return {
    title: typeof s.title === "string" && s.title !== "" ? s.title : "（无标题会话）",
    runtimeId: typeof s.runtimeId === "string" ? s.runtimeId : "?",
    rootPath: typeof s.rootPath === "string" ? s.rootPath : null,
    startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
    endedAt: typeof s.endedAt === "number" ? s.endedAt : null,
    messages: Array.isArray(b.messages) ? b.messages.length : 0,
    events: Array.isArray(b.events) ? b.events.length : 0,
    raw: parsed,
  };
}

export function ImportSharedSection(): ReactElement {
  const units = useWorkbench((s) => s.units).filter((u) => u.rootPath !== "");
  const [unitId, setUnitId] = useState<string>("");
  const [file, setFile] = useState<{ name: string; bundle: ParsedBundle } | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // bundle 的 rootPath 与哪个 bot 匹配（导入按钮旁的提示徽标）
  const matchedUnit = useMemo(() => {
    if (file === null || file.bundle.rootPath === null) return undefined;
    return units.find((u) => normPath(u.rootPath ?? "") === normPath(file.bundle.rootPath ?? ""));
  }, [file, units]);

  // 默认选中：rootPath 匹配的 bot > 当前选中 > 第一个
  const effectiveUnitId =
    unitId !== "" && units.some((u) => String(u.id) === unitId)
      ? unitId
      : matchedUnit !== undefined
        ? String(matchedUnit.id)
        : units[0] !== undefined
          ? String(units[0].id)
          : "";

  const pickFile = (f: File | undefined): void => {
    setDone(null);
    if (f === undefined) return;
    void f
      .text()
      .then((text) => {
        setFile({ name: f.name, bundle: parseBundleFile(text, f.name) });
        setParseErr(null);
      })
      .catch((e: unknown) => {
        setFile(null);
        setParseErr(e instanceof Error ? e.message : String(e));
      });
  };

  const runImport = (): void => {
    if (file === null || effectiveUnitId === "" || busy) return;
    setBusy(true);
    void importSessionFile(file.bundle.raw, effectiveUnitId)
      .then((r) => {
        // 导入即关注（与外部会话导入同款）：置顶 + 广播让侧栏子列表立刻重拉
        if (r.imported && r.sessionId !== undefined) {
          useHistoryPrefs.getState().pinKeys([`session-${r.sessionId}`]);
          window.dispatchEvent(new CustomEvent("awb:history-refresh", { detail: { unitId: effectiveUnitId } }));
          setDone(`已导入「${file.bundle.title}」—— 已置顶到侧栏该 bot 的历史列表（带「分享」标签），点开即完整回放`);
        } else if (r.reason === "exists") {
          setDone("这条会话此前已导入过（同一分享文件），已在历史列表中。");
        } else {
          setDone("导入未生效，请重试。");
        }
      })
      .catch((e: unknown) => setParseErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (units.length === 0) {
    return <p className="text-caption text-ash">还没有任何 bot —— 先在侧栏添加（指向已有文件夹即为认领），再导入分享文件。</p>;
  }

  return (
    <div className="space-y-3 text-body-sm">
      <label className="flex items-center gap-2 text-caption text-ash">
        导入到哪个 bot
        <select
          value={effectiveUnitId}
          onChange={(e) => setUnitId(e.target.value)}
          className="rounded-input border border-line bg-canvas px-2 py-1 text-body-sm text-ink outline-none focus:border-teal"
        >
          {units.map((u) => (
            <option key={String(u.id)} value={String(u.id)}>
              {u.name}
            </option>
          ))}
        </select>
        {matchedUnit !== undefined && String(matchedUnit.id) === effectiveUnitId && (
          <span className="flex items-center gap-1 text-[10px] text-teal">
            <FolderCheck size={10} />
            分享文件的原始目录与这个 bot 一致，已自动选中
          </span>
        )}
      </label>

      <label
        className={cn(
          "flex cursor-pointer items-center justify-center gap-2 rounded-btn border border-dashed px-3 py-4 text-caption transition",
          file !== null ? "border-teal/60 bg-teal-tint/40 text-teal" : "border-line-strong text-ash hover:border-teal hover:text-ink",
        )}
      >
        <FileUp size={14} />
        {file !== null ? `已选择：${file.name}` : "选择 .awb.json 分享文件（在原机器的会话上右键 → 分享 / 导出 得到）"}
        <input
          type="file"
          accept=".json,.awb.json,application/json"
          className="hidden"
          onChange={(e) => {
            pickFile(e.target.files?.[0]);
            e.target.value = ""; // 同名文件可重复触发 onChange
          }}
        />
      </label>

      {parseErr !== null && <p className="text-caption text-loss">无法读取：{parseErr}</p>}

      {file !== null && (
        <div className="space-y-1 rounded-btn border border-line bg-canvas px-3 py-2 text-caption text-graphite">
          <div className="truncate font-medium text-ink" title={file.bundle.title}>
            {file.bundle.title}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-ash">
            <span>
              执行器 <span className="font-mono text-graphite">{file.bundle.runtimeId}</span>
            </span>
            <span>
              {fmtWhen(file.bundle.startedAt)} ~ {fmtWhen(file.bundle.endedAt ?? file.bundle.startedAt)}
            </span>
            <span>{file.bundle.messages} 条消息</span>
            <span>{file.bundle.events} 条事件</span>
          </div>
          {file.bundle.rootPath !== null && <div className="truncate font-mono text-[10px] text-ash/70">{file.bundle.rootPath}</div>}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={file === null || busy}
          onClick={runImport}
          className="flex items-center gap-1.5 rounded-btn bg-teal px-3 py-1.5 text-caption font-medium text-canvas transition hover:opacity-90 disabled:opacity-40"
        >
          <FileUp size={12} />
          {busy ? "导入中…" : "导入并完整回放"}
        </button>
        {done !== null && <p className="text-caption text-gain">{done}</p>}
      </div>
    </div>
  );
}
