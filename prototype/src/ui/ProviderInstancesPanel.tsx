import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Info,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { prefsOf, resolveVisibleModels } from "../core/modelPrefs.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { useShell } from "../store/useShell.ts";
import { DaemonClient, defaultDaemonEndpoint, readModelDefaults, writeModelDefaults, type DaemonExecutorInfo, type ModelSyncReport, type NativeModelConfig } from "../adapters/daemon/client.ts";
import {
  readModelCatalog,
  writeModelCatalog,
  readModelProviders,
  writeModelProviders,
  type ModelCatalogInfo,
  type ModelCatalogWriteRow,
  type NativeProvidersInfo,
  type ProviderWriteRow,
} from "../adapters/daemon/client.ts";
import { runtimeRegistry } from "../core/registry.ts";
import { asModelId } from "../core/units.ts";
import { executorIconSrc } from "./executorIcon.ts";
import { ProviderModelPanel } from "./ModelSettings.tsx";
import { cn } from "./cn.ts";

/**
 * 执行器实例与模型生态面板：
 *
 * 1. 左列：执行器列表（图标 + 名称 + 版本 + 就绪状态 + 启用 Switch）；
 * 2. 右列：
 *    - 顶卡：执行器真实状态卡片（Display Name 内联重命名、默认执行器标识/设为默认、传输通道）；
 *    - 主卡：平铺展开的可用模型生态管理（搜索、星标置顶、上下文窗口、推理/视觉能力、主对话底栏显隐开关）；
 *    - 底卡：终端凭据与配置指南（指导用户在 CLI 终端中如何通过官方命令完成认证与配置，剔除假输入框）。
 */

interface CliGuide {
  desc: string;
  authCmd?: string;
  configPath?: string;
  tips: string;
}

/** 本应用会话内是否已经自动探测过一轮（见 ProviderInstancesPanel 挂载 effect） */
let autoProbedThisSession = false;

const CLI_GUIDES: Record<string, CliGuide> = {
  codex: {
    desc: "OpenAI 官方终端 Agent 交互式执行器，深度适配代码感知与多步复杂自动化任务。",
    authCmd: "codex login",
    configPath: "~/.codex/config.json",
    tips: "支持绑定 ChatGPT Plus/Pro 订阅或 OpenAI API Key。工作台通过本地子进程 stdio 交互式会话自动继承终端认证状态。",
  },
  claude: {
    desc: "Anthropic 官方终端 Agent 交互式执行器，针对大型工程重构与代码推理具备深度优化。",
    authCmd: "claude login",
    configPath: "环境变量 ANTHROPIC_API_KEY",
    tips: "可使用 Claude 官方账号登录或配置系统环境变量。工作台直接复用终端运行凭据。",
  },
  opencode: {
    desc: "开源灵活的多模型终端 Agent 执行器，支持同时接入数十种主流大模型与自建 API。",
    authCmd: "opencode auth login",
    configPath: "~/.config/opencode/",
    tips: "可在系统终端中配置各厂商的 Provider 密钥，工作台会自动动态探测已就绪的真实模型生态。",
  },
  pi: {
    desc: "轻量级全栈 Agent 终端工具，具备极简的交互架构与多供应商模型路由。",
    authCmd: "pi login",
    configPath: "~/.pi/agent/models.json",
    tips: "支持通过本地终端配置多模型路由与凭据，工作台保持实时状态同步。",
  },
  zcode: {
    desc: "本地极速 Agent 引擎，专为高并发与低延迟自动化交互设计。",
    tips: "无需额外认证，工作台通过专属管道直连本地 Agent 守护进程，开箱即用。",
  },
  mcode: {
    desc: "MCode 研发套件与私有化模型调度执行器。",
    tips: "自动适配本机与内网环境，保持稳定开箱即用状态。",
  },
  agy: {
    desc: "Google 官方 Antigravity Agent 执行器，提供强大的全功能代码与多模态模型调度。",
    authCmd: "agy",
    configPath: "~/.gemini/",
    tips: "支持 Gemini 3.8 / 3.7 / 3.1 等系列模型，具备深度思考、工具调用与多模态能力。",
  },
  antigravity: {
    desc: "Google 官方 Antigravity Agent 执行器，提供强大的全功能代码与多模态模型调度。",
    authCmd: "agy",
    configPath: "~/.gemini/",
    tips: "支持 Gemini 3.8 / 3.7 / 3.1 等系列模型，具备深度思考、工具调用与多模态能力。",
  },
  grok: {
    desc: "SpaceXAI 官方终端 Agent 执行器，深度适配代码感知与多步复杂自动化任务。",
    authCmd: "grok login",
    configPath: "~/.grok/config.toml",
    tips: "支持 xAI 官方账户登录，工作台通过 streaming-messages-json 协议流式直连 Grok Build 执行器。",
  },
  cursor: {
    desc: "Cursor 官方 CLI 模式 Agent 执行器（cursor-agent），支持跨模型路由、推理与工具调用。",
    authCmd: "cursor-agent login",
    configPath: "~/.cursor/",
    tips: "可使用 Cursor 账号或 CURSOR_API_KEY 环境变量登录，工作台通过 stream-json 协议保持双向交互与模型同步。",
  },
  "cursor-agent": {
    desc: "Cursor 官方 CLI 模式 Agent 执行器（cursor-agent），支持跨模型路由、推理与工具调用。",
    authCmd: "cursor-agent login",
    configPath: "~/.cursor/",
    tips: "可使用 Cursor 账号或 CURSOR_API_KEY 环境变量登录，工作台通过 stream-json 协议保持双向交互与模型同步。",
  },
  openclaw: {
    desc: "OpenClaw 统一 Agent 与多渠道消息网关执行器，支持多 Agent 隔离与本地/网关调度。",
    authCmd: "openclaw onboard",
    configPath: "~/.openclaw/openclaw.json",
    tips: "支持通过本地终端配置多模型凭据与网关，工作台动态对接模型目录并支持单轮与多轮会话调度。",
  },
  mockperm: {
    desc: "工作台权限闸（Permission Gate）端到端自动化验收测试夹具。",
    tips: "每轮对话均会触发真实的模拟权限审批挂起，专门用于测试与验收工作台的人机交互闸门。",
  },
};

export interface ProviderInstallGuide {
  readonly title: string;
  readonly commandWindows: string;
  readonly commandPosix?: string;
  readonly altCommand?: string;
  readonly altCommandLabel?: string;
  readonly docUrl?: string;
  readonly tips: string;
}

export const PROVIDER_INSTALL_GUIDES: Record<string, ProviderInstallGuide> = {
  grok: {
    title: "Grok Build CLI",
    commandWindows: "irm https://x.ai/cli/install.ps1 | iex",
    commandPosix: "curl -fsSL https://x.ai/cli/install.sh | bash",
    altCommand: "cargo build -p xai-grok-pager-bin --release",
    altCommandLabel: "本地源码编译 (grok-build)",
    docUrl: "https://x.ai/cli",
    tips: "SpaceXAI 官方安装脚本会自动下载预编译二进制至 ~/.grok/bin 并写入环境变量。若使用本地 grok-build 源码，也可在源码根目录运行 cargo build 编译。",
  },
  cursor: {
    title: "Cursor Agent CLI (cursor-agent)",
    commandWindows: "npm install -g cursor-agent",
    commandPosix: "npm install -g cursor-agent",
    altCommand: "irm https://cursor.com/install.ps1 | iex",
    altCommandLabel: "官方安装脚本",
    docUrl: "https://cursor.com/cli",
    tips: "Cursor 官方 CLI 模式（cursor-agent）。安装后在终端运行 cursor-agent login 即可完成认证。",
  },
  "cursor-agent": {
    title: "Cursor Agent CLI (cursor-agent)",
    commandWindows: "npm install -g cursor-agent",
    commandPosix: "npm install -g cursor-agent",
    altCommand: "irm https://cursor.com/install.ps1 | iex",
    altCommandLabel: "官方安装脚本",
    docUrl: "https://cursor.com/cli",
    tips: "Cursor 官方 CLI 模式（cursor-agent）。安装后在终端运行 cursor-agent login 即可完成认证。",
  },
  openclaw: {
    title: "OpenClaw CLI",
    commandWindows: "npm install -g openclaw",
    commandPosix: "npm install -g openclaw",
    altCommand: "openclaw onboard",
    altCommandLabel: "初始化向导",
    docUrl: "https://openclaw.ai",
    tips: "OpenClaw 全局 npm 包安装后，在终端执行 openclaw onboard 即可完成初始化网关配置与模型接入。",
  },
  codex: {
    title: "OpenAI Codex CLI",
    commandWindows: "irm https://chatgpt.com/codex/install.ps1 | iex",
    commandPosix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    altCommand: "npm i -g @openai/codex",
    altCommandLabel: "npm 全局安装",
    docUrl: "https://developers.openai.com/codex/cli",
    tips: "OpenAI 官方 Codex CLI。安装后运行 codex login 进行账号登录或绑定 API 密钥。",
  },
  claude: {
    title: "Claude Code CLI",
    commandWindows: "irm https://claude.ai/install.ps1 | iex",
    commandPosix: "curl -fsSL https://claude.ai/install.sh | bash",
    altCommand: "npm i -g @anthropic-ai/claude-code",
    altCommandLabel: "npm 全局安装",
    docUrl: "https://claude.com/product/claude-code",
    tips: "Anthropic 官方 Claude Code 终端执行器。安装后运行 claude login 登录账号。",
  },
  opencode: {
    title: "OpenCode CLI",
    commandWindows: "npm i -g opencode-ai",
    commandPosix: "npm i -g opencode-ai",
    docUrl: "https://opencode.ai",
    tips: "开源多模型终端 Agent 执行器。安装后运行 opencode auth login 配置各厂商模型密钥。",
  },
  pi: {
    title: "Pi Agent CLI",
    commandWindows: "npm i -g @earendil-works/pi-coding-agent",
    commandPosix: "npm i -g @earendil-works/pi-coding-agent",
    tips: "轻量全栈 Agent 工具。安装后运行 pi login 配置模型路由。",
  },
  mcode: {
    title: "MiniMax MCode CLI",
    commandWindows: "npm i -g @minimax/mcode",
    commandPosix: "npm i -g @minimax/mcode",
    tips: "MiniMax Code 研发套件，支持私有化模型调度。",
  },
  hermes: {
    title: "Hermes Agent CLI",
    commandWindows: "pip install hermes-agent",
    commandPosix: "pipx install hermes-agent",
    altCommand: "pipx install hermes-agent",
    altCommandLabel: "pipx 隔离安装",
    tips: "通过 Python pip 或 pipx 安装 hermes-agent。",
  },
  kimi: {
    title: "Kimi Code CLI",
    commandWindows: "npm i -g @moonshot-ai/kimi-code",
    commandPosix: "npm i -g @moonshot-ai/kimi-code",
    tips: "Moonshot Kimi Code 终端执行器，安装后在终端进行认证。",
  },
  dsh: {
    title: "DeepSeek Harness CLI",
    commandWindows: "npm i -g @deepseek-ai/dsh",
    commandPosix: "npm i -g @deepseek-ai/dsh",
    tips: "DeepSeek Harness 官方 CLI，安装后运行 dsh login 或配置 DEEPSEEK_API_KEY。",
  },
  agy: {
    title: "Google Antigravity CLI",
    commandWindows: "agy",
    docUrl: "https://antigravity.google",
    tips: "Google 官方 Antigravity 执行器，已集成在本地环境。",
  },
  antigravity: {
    title: "Google Antigravity CLI",
    commandWindows: "agy",
    docUrl: "https://antigravity.google",
    tips: "Google 官方 Antigravity 执行器，已集成在本地环境。",
  },
};

function InstallGuideCard({
  runtimeId,
  displayName,
  hint,
  status,
  onRecheck,
}: {
  runtimeId: string;
  displayName: string;
  hint?: string;
  status: string;
  onRecheck?: () => void;
}) {
  const bareId = runtimeId.replace(/^daemon:/, "").toLowerCase();
  const guide = PROVIDER_INSTALL_GUIDES[bareId];
  const [copiedMain, setCopiedMain] = useState(false);
  const [copiedAlt, setCopiedAlt] = useState(false);
  const [runningInTerminal, setRunningInTerminal] = useState(false);
  const [checking, setChecking] = useState(false);

  if (!guide && !hint) return null;

  const isWindows = typeof navigator !== "undefined" ? navigator.userAgent.includes("Windows") : true;
  const mainCmd = (isWindows ? guide?.commandWindows : (guide?.commandPosix ?? guide?.commandWindows)) ?? "";

  const handleCopy = (cmd: string, isAlt: boolean) => {
    if (!cmd) return;
    void navigator.clipboard.writeText(cmd);
    if (isAlt) {
      setCopiedAlt(true);
      setTimeout(() => setCopiedAlt(false), 2000);
    } else {
      setCopiedMain(true);
      setTimeout(() => setCopiedMain(false), 2000);
    }
  };

  const handleRunInTerminal = (cmdToRun: string) => {
    if (!cmdToRun) return;
    setRunningInTerminal(true);
    // 复制到剪贴板兜底
    void navigator.clipboard.writeText(cmdToRun);

    // 在工作台终端新建标签
    const termId = useTerminalStore.getState().createTab({
      profileId: "pwsh",
      title: `安装 ${displayName}`,
    });

    // 关闭设置页切到终端让用户直接观看安装
    useShell.getState().closeSettings();

    // 稍等 PTY 初始化完成后注入命令并回车执行
    setTimeout(() => {
      try {
        const client = DaemonClient.get(defaultDaemonEndpoint());
        void client.rpc("terminal.input", { terminalId: termId, data: `${cmdToRun}\r` }).catch(() => {});
      } catch {
        /* ignore */
      }
      setRunningInTerminal(false);
    }, 800);
  };

  const handleRecheck = async () => {
    setChecking(true);
    try {
      if (onRecheck) {
        await onRecheck();
      }
    } finally {
      setTimeout(() => setChecking(false), 600);
    }
  };

  return (
    <section className="rounded-card border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-500">
            <Download size={15} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-body-sm font-semibold text-ink">未检测到该执行器 CLI</h4>
              <span className="rounded-chip bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-500">
                需要安装
              </span>
            </div>
            <p className="mt-1 text-caption text-graphite leading-relaxed">
              {hint ?? guide?.tips ?? "检测到本机未安装或 PATH 中尚未包含该执行器可执行文件。可通过下方官方命令一键安装。"}
            </p>
          </div>
        </div>

        {/* 重新探测按钮 */}
        <button
          onClick={handleRecheck}
          disabled={checking}
          title="重新检测该执行器安装状态"
          className="shrink-0 flex items-center gap-1.5 rounded-btn border border-line bg-card px-2.5 py-1 text-caption font-medium text-graphite hover:border-teal hover:text-ink hover:bg-line-soft transition"
        >
          <RefreshCw size={12} className={cn(checking && "animate-spin text-teal")} />
          <span>重新检测</span>
        </button>
      </div>

      {mainCmd && (
        <div className="rounded-card border border-line bg-canvas p-3 space-y-2">
          <div className="flex items-center justify-between text-caption text-ash">
            <span className="font-sans font-medium">推荐安装命令（Windows PowerShell / 终端）：</span>
            {guide?.docUrl && (
              <a
                href={guide.docUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] text-teal hover:underline"
              >
                <span>官方文档</span>
                <ExternalLink size={10} />
              </a>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 rounded bg-card px-3 py-2 border border-line/60 font-mono text-caption text-ink">
            <span className="select-all overflow-x-auto whitespace-nowrap">{mainCmd}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => handleCopy(mainCmd, false)}
                title="复制命令"
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-sans font-medium border border-line bg-canvas hover:border-teal hover:text-teal transition"
              >
                {copiedMain ? <Check size={11} className="text-teal" /> : <Copy size={11} />}
                <span>{copiedMain ? "已复制" : "复制"}</span>
              </button>
              <button
                onClick={() => handleRunInTerminal(mainCmd)}
                disabled={runningInTerminal}
                title="新建终端标签并自动执行安装命令"
                className="flex items-center gap-1 rounded bg-teal px-2.5 py-1 text-[11px] font-sans font-medium text-white hover:bg-teal-hover transition shadow-xs"
              >
                <Terminal size={11} />
                <span>在终端运行安装</span>
              </button>
            </div>
          </div>

          {guide?.altCommand && (
            <div className="flex items-center justify-between pt-1 text-[11px] text-ash">
              <span className="font-sans">
                {guide.altCommandLabel ?? "备选方案"}：
                <code className="ml-1 text-graphite font-mono">{guide.altCommand}</code>
              </span>
              <button
                onClick={() => handleCopy(guide.altCommand!, true)}
                className="text-teal hover:underline font-sans ml-2"
              >
                {copiedAlt ? "已复制" : "复制备选命令"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function ProviderInstancesPanel() {
  const runtimes = useWorkbench((s) => s.runtimes);
  const prefs = useWorkbench((s) => s.runtimePrefs);
  const setPref = useWorkbench((s) => s.setRuntimePref);
  const probeAll = useWorkbench((s) => s.probeAll);
  const syncModelsAll = useWorkbench((s) => s.syncModelsAll);
  const syncingModels = useWorkbench((s) => s.syncingModels);
  const modelSync = useWorkbench((s) => s.modelSync);

  const [checkedLabel, setCheckedLabel] = useState("刚刚");
  const [checking, setChecking] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(runtimes[0]?.id ?? "");
  const activeId = useWorkbench((s) => s.activeRuntimeId);
  const selectRuntime = useWorkbench((s) => s.selectRuntime);

  const selected = runtimes.find((r) => r.id === selectedId) ?? runtimes[0];

  const refresh = async () => {
    setChecking(true);
    await probeAll();
    setChecking(false);
    setCheckedLabel("刚刚");
  };

  /**
   * 模型清单刷新 —— 与执行器探测**分成两个按钮**。
   *
   * 之前模型刷新寄生在执行器探测里（daemon 的 probe 顺带调 syncModels），两个后果：
   * 一是点「探测」要等模型 CLI 冷启动才知道装没装；二是刷新结果只留在 daemon 内存里，
   * 界面永远看不到，用户只能反复点然后怀疑「是不是我该重启一下」。
   *
   * 只读元数据探测，零 token 零计费 —— 可以放心按。
   */
  const refreshModels = async () => {
    await syncModelsAll();
  };

  // 打开设置页自动探测一轮 —— 但**每个应用会话只一次**（模块级标记，不是 ref：
  // ref 随组件卸载归零，从会话页选择器「打开模型设置」进出设置页一趟就重探一趟，
  // 每趟都要等各 CLI 冷启动，纯浪费）。首次之后的刷新由两个按钮显式触发。
  // 启动时 useWorkbench 模块级那次探测与本标记互不冲突：那次面向「daemon 起晚了的
  // 注册竞态」，这里面向「用户进设置页想看现状」，都只在各自轨道上跑一次。
  useEffect(() => {
    if (autoProbedThisSession) return;
    autoProbedThisSession = true;
    setChecking(true);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 每家的模型同步来源 → 一句话标签。static = 没刷到，用的是内置兜底清单 */
  const syncLabel = useMemo(() => {
    const m = new Map<string, { live: boolean; count: number; reason?: string }>();
    for (const r of modelSync?.report ?? []) {
      m.set(r.runtimeId, { live: r.source === "live", count: r.count, reason: r.reason });
    }
    return m;
  }, [modelSync]);

  const modelsSyncedLabel = modelSync === null ? "尚未刷新" : `已刷新 ${formatAgo(modelSync.at)}`;
  const liveCount = (modelSync?.report ?? []).filter((r) => r.source === "live").length;
  const totalCount = (modelSync?.report ?? []).length;

  if (!selected) {
    return <p className="p-4 text-body-sm text-ash">没有已注册的执行器。</p>;
  }

  const pref = prefs[selected.id] ?? { enabled: true };
  const enabled = pref.enabled !== false;

  return (
    <div className="space-y-3">
      {/* 顶栏：两个独立按钮 —— 执行器探测 / 模型探测 */}
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <div>
          <h2
            className="text-body-sm font-medium text-ink"
            title="工作台直接调度本地安装的 Agent CLI；模型清单单独探测，订阅里有新模型点一下就能刷出来。"
          >
            执行器与可用模型
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-col items-end gap-0.5">
            {syncingModels ? (
              <span className="text-caption text-ash">正在读各执行器的模型清单…</span>
            ) : (
              <span className="text-caption text-ash">
                {modelsSyncedLabel}
                {totalCount > 0 && (
                  <span className="tnum">
                    {" "}
                    · {liveCount}/{totalCount} 家实时
                  </span>
                )}
              </span>
            )}
            <span className="text-[11px] text-ash/80">探测执行器：{checking ? "进行中…" : checkedLabel}</span>
          </div>
          <button
            onClick={() => {
              setChecking(true);
              void refresh();
            }}
            disabled={checking}
            title="重新检测各执行器的安装状态与版本（不碰模型清单）"
            aria-label="重新探测执行器"
            className="flex items-center gap-1.5 rounded-btn border border-line bg-canvas px-2.5 py-1 text-caption font-medium text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-50 transition"
          >
            <RefreshCw size={12} className={cn(checking && "animate-spin text-teal")} />
            探测执行器
          </button>
          <button
            onClick={() => void refreshModels()}
            disabled={syncingModels}
            title="重新读取各执行器的可用模型（模型 id / 名称 / 上下文窗口）。只读元数据，不发任何请求、不消耗用量。"
            aria-label="重新探测模型"
            className="flex items-center gap-1.5 rounded-btn border border-teal/40 bg-teal-tint/50 px-2.5 py-1 text-caption font-medium text-ink hover:bg-teal-tint disabled:opacity-50 transition"
          >
            <Sparkles size={12} className={cn(syncingModels && "animate-pulse text-teal")} />
            探测模型
          </button>
        </div>
      </div>

      {modelSync?.error !== undefined && (
        <p className="flex items-center gap-1.5 rounded-card border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-caption text-amber-600">
          <AlertCircle size={12} className="shrink-0" />
          模型刷新失败：{modelSync.error}
        </p>
      )}

      <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
        {/* 左列：实例列表 */}
        <ul className="space-y-2">
          {runtimes.map((r) => {
            const p = prefs[r.id] ?? { enabled: true };
            const isEnabled = p.enabled !== false;
            const isSelected = r.id === selected.id;
            const isDefault = activeId === r.id;
            const rawVersion = r.state.status === "ready" ? r.state.version : undefined;
            const shortVer = formatShortVersion(rawVersion);
            const displayName = cleanDisplayName(p.displayName ?? r.presentation.displayName);
            return (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  aria-current={isSelected}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-card border px-3 py-2.5 text-left transition",
                    isSelected
                      ? "border-teal bg-teal-tint/60 shadow-sm"
                      : "border-line bg-card hover:bg-line-soft",
                    !isEnabled && "opacity-60",
                  )}
                >
                  {executorIconSrc(r.id) ? (
                    <img
                      src={executorIconSrc(r.id) ?? undefined}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded-btn object-contain"
                      aria-hidden
                    />
                  ) : (
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-[11px] font-semibold text-white shadow-xs"
                      style={{ background: r.presentation.accent }}
                      aria-hidden
                    >
                      {r.presentation.glyph}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 overflow-hidden">
                    {/* 第一行：执行器名称 + 默认标识 */}
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-body-sm font-medium text-ink">
                        {displayName}
                      </span>
                      {r.testOnly && (
                        <span
                          title="测试夹具：模拟触发真实权限审批"
                          className="shrink-0 rounded-chip border border-line bg-line-soft px-1.5 py-px text-[10px] leading-4 text-graphite"
                        >
                          测试夹具
                        </span>
                      )}
                      {isDefault && (
                        <span className="shrink-0 rounded-chip bg-ink px-1.5 py-px text-[10px] font-medium leading-4 text-canvas">
                          默认
                        </span>
                      )}
                    </span>

                    {/* 第二行：状态 + 版本号（严格单行，绝不折断中文字符，超长尾部截断） */}
                    <span className="mt-1 flex items-center gap-1.5 text-caption text-ash min-w-0 whitespace-nowrap overflow-hidden">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full shrink-0",
                          r.state.status === "ready"
                            ? "bg-teal"
                            : r.state.status === "starting"
                              ? "bg-amber-500"
                              : "bg-ash",
                        )}
                      />
                      <span className="shrink-0 whitespace-nowrap">
                        {isEnabled ? statusLabel(r.state.status, checking) : "已停用"}
                      </span>
                      {shortVer && (
                        <span
                          title={rawVersion}
                          className="font-mono text-[10px] text-ash truncate min-w-0"
                        >
                          {shortVer}
                        </span>
                      )}
                    </span>

                    {/* 第三行：模型清单来源。这是「刷新有没有用」的唯一可见依据 ——
                        没标的话，用户对着一个从没变过的列表只会怀疑是自己没刷新对 */}
                    <span className="mt-1 flex items-center gap-1 text-[11px] text-ash min-w-0">
                      <span className="tnum shrink-0">模型 {r.models.length}</span>
                      {r.modelsCachedAt !== null ? (
                        /* 这一档排最前，因为它盖过其余所有情况：连实时源都没碰到，
                           显示的是上次成功探测的结果。用户必须一眼看出「这不是刚探的」，
                           否则「我明明刷新过」和「其实没刷到」永远分不开。 */
                        <span
                          className="shrink-0 text-amber-600"
                          title="本次启动没能连上实时源，当前清单来自上次成功探测的结果"
                        >
                          · 来自上次探测 {formatAgo(r.modelsCachedAt)}
                        </span>
                      ) : !r.modelsDiscoverable ? (
                        <span
                          className="shrink-0 text-ash/90"
                          title="该执行器没有模型清单查询接口，只能用内置清单 —— 刷新对它无效"
                        >
                          · 静态清单
                        </span>
                      ) : modelSync === null ? (
                        <span className="shrink-0">· 未刷新</span>
                      ) : (
                        syncLabel.get(r.id.replace(/^daemon:/, ""))?.live === true ? (
                          <span className="shrink-0 text-teal" title="已从该执行器的 CLI / 本地目录实时读到">
                            · 实时
                          </span>
                        ) : (
                          <span
                            className="shrink-0 text-amber-600"
                            title={
                              syncLabel.get(r.id.replace(/^daemon:/, ""))?.reason ??
                              "没读到实时清单，当前显示的是内置兜底"
                            }
                          >
                            · 兜底
                          </span>
                        )
                      )}
                    </span>
                  </span>
                  <InstanceSwitch
                    checked={isEnabled}
                    onChange={(v) => setPref(r.id, { enabled: v })}
                    label={`启用 ${r.presentation.displayName}`}
                  />
                </button>
              </li>
            );
          })}
        </ul>

        {/* 右列：当前选中执行器的核心管理 */}
        <div className="min-w-0 space-y-4">
          <InstanceEditor
            runtimeId={selected.id}
            isDefault={activeId === selected.id}
            onSetDefault={() => selectRuntime(selected.id)}
          />
          <NativeModelDefaultsCard runtimeId={selected.id} />
          <ModelCatalogCard runtimeId={selected.id} />
          <ModelProvidersCard runtimeId={selected.id} />
        </div>
      </div>
    </div>
  );
}

/**
 * 清洗执行器显示名称：
 * 去除历史或默认生成的「 · daemon」后缀，保持名称极简精炼。
 */
export function cleanDisplayName(name: string | undefined): string {
  if (!name) return "";
  return name.replace(/\s*·\s*daemon$/i, "").trim();
}

/**
 * 提取精简版本号（保证左侧实例卡第二行单行展示，不换行）：
 * 优先提取核心版本号（如 v0.16.9, v0.20.0, v2026.10.2），
 * 剔除冗长的包名前缀或长括号说明，多余内容由右侧卡片与悬浮 title 显示。
 */
/** 距今多久（模型刷新时间的展示用）。超过 1 分钟就不再精确到秒 —— 没人关心 3 分钟前的刷新 */
function formatAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export function formatShortVersion(rawVersion: string | undefined): string | null {  if (!rawVersion || rawVersion.trim() === "") return null;
  const trimmed = rawVersion.trim();
  // 匹配类似 0.16.9 / v0.20.0 / 2026.10.2 / 0.2.0-rc.2 / 1.0.52
  const match = trimmed.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/);
  if (match?.[1]) {
    return `v${match[1]}`;
  }
  const first = trimmed.split(/[\s(]/)[0] ?? trimmed;
  return first.startsWith("v") || first.startsWith("V") ? first : `v${first}`;
}

function statusLabel(status: string | undefined, checking = false): string {
  // 探测进行中，还没拿到结论（ready/error/not_installed 都是结论）的先显示「启动中」
  if (checking && status !== "ready" && status !== "error" && status !== "not_installed") {
    return "启动中";
  }
  switch (status) {
    case "ready":
      return "已就绪";
    case "starting":
      return "启动中";
    case "not_installed":
      return "未安装";
    case "error":
      return "异常";
    case "stopped":
      return "已离线";
    default:
      return "未探测";
  }
}

function InstanceSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={checked ? "已启用（点击停用）" : "已停用（点击启用）"}
      className={cn(
        "relative h-5 w-9 shrink-0 self-center rounded-full transition-colors",
        checked ? "bg-teal" : "bg-line",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-canvas shadow-xs transition-[left]",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------- 详情编辑器 */

function InstanceEditor({
  runtimeId,
  isDefault,
  onSetDefault,
}: {
  runtimeId: string;
  isDefault: boolean;
  onSetDefault: () => void;
}) {
  const runtime = useWorkbench((s) => s.runtimes.find((r) => r.id === runtimeId));
  const pref = useWorkbench((s) => s.runtimePrefs[runtimeId]) ?? { enabled: true };
  const setPref = useWorkbench((s) => s.setRuntimePref);
  const probeAll = useWorkbench((s) => s.probeAll);
  const [editingName, setEditingName] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const agyDefaultYolo = useTerminalStore((s) => s.agyDefaultYolo);
  const setAgyDefaultYolo = useTerminalStore((s) => s.setAgyDefaultYolo);

  if (!runtime) return null;
  const bareRuntimeId = runtimeId.replace(/^daemon:/, "").toLowerCase();
  const name = cleanDisplayName(pref.displayName ?? runtime.presentation.displayName);
  const guide = CLI_GUIDES[bareRuntimeId] ?? {
    desc: `${name} 终端执行器。`,
    tips: "工作台直接调度本地安装的命令行进程。",
  };

  return (
    <div className="space-y-4">
      {/* 顶部卡片：执行器概览与状态 */}
      <section className="rounded-card border border-line bg-card p-4">
        <div className="flex flex-wrap sm:flex-nowrap items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {executorIconSrc(runtime.id) ? (
              <img
                src={executorIconSrc(runtime.id) ?? undefined}
                alt=""
                className="h-10 w-10 shrink-0 rounded-card object-contain"
                aria-hidden
              />
            ) : (
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card text-body font-medium text-white shadow-xs"
                style={{ background: runtime.presentation.accent }}
              >
                {runtime.presentation.glyph}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {editingName ? (
                  <input
                    value={name}
                    onChange={(e) => setPref(runtimeId, { displayName: e.target.value })}
                    onBlur={() => setEditingName(false)}
                    onKeyDown={(e) => e.key === "Enter" && setEditingName(false)}
                    autoFocus
                    className="rounded-input border border-teal bg-canvas px-2 py-0.5 text-body-sm font-medium text-ink outline-none"
                  />
                ) : (
                  <div className="flex items-center gap-1 shrink-0">
                    <h3 className="text-body font-medium text-ink whitespace-nowrap" title={guide.desc}>
                      {name}
                    </h3>
                    <button
                      onClick={() => setEditingName(true)}
                      title="修改显示名称"
                      className="rounded p-1 text-ash hover:bg-line-soft hover:text-ink transition"
                    >
                      <Pencil size={12} />
                    </button>
                  </div>
                )}
                {runtime.state.status === "ready" && (
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-chip bg-teal-tint px-2 py-0.5 text-caption font-medium text-teal">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal" />
                    已就绪
                  </span>
                )}
                {runtime.state.status === "ready" && runtime.state.version && (
                  <span
                    title={runtime.state.version}
                    className="max-w-[200px] shrink-0 truncate rounded-chip border border-line bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-graphite whitespace-nowrap"
                  >
                    {runtime.state.version.startsWith("v") || runtime.state.version.startsWith("V")
                      ? runtime.state.version
                      : /^\d/.test(runtime.state.version)
                        ? `v${runtime.state.version}`
                        : runtime.state.version}
                  </span>
                )}
                {runtime.state.status === "not_installed" && (
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-chip bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 text-caption font-medium text-amber-500">
                    <AlertCircle size={11} />
                    未安装
                  </span>
                )}
                {runtime.state.status === "error" && (
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-chip bg-red-500/10 border border-red-500/25 px-2 py-0.5 text-caption font-medium text-red-500">
                    <AlertCircle size={11} />
                    异常
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* 设为默认按钮 */}
          <div className="shrink-0 flex items-center gap-2">
            {isDefault ? (
              <span className="flex items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-caption font-medium text-canvas">
                <CheckCircle2 size={12} className="text-teal" />
                当前默认执行器
              </span>
            ) : (
              <button
                onClick={onSetDefault}
                className="rounded-btn border border-line bg-canvas px-3 py-1.5 text-caption font-medium text-graphite hover:border-teal hover:text-ink hover:bg-line-soft transition"
              >
                设为新对话默认
              </button>
            )}
          </div>
        </div>

        {/* 传输协议与模式透视 */}
        <div className="mt-3 flex items-center gap-4 border-t border-line/60 pt-2.5 text-caption text-ash">
          <span className="flex items-center gap-1.5">
            <Terminal size={12} className="text-graphite" />
            <span>通信通道：</span>
            <span className="font-mono text-graphite">
              {runtime.transportKind === "stdio" ? "本地进程管道 (stdio)" : runtime.transportKind}
            </span>
          </span>
          <span>·</span>
          <span>
            可用模型：<span className="font-medium text-ink">{runtime.models.length}</span> 款
          </span>
        </div>
      </section>

      {/* 未安装 / 异常引导卡片：一键在终端安装与复制命令 */}
      {(runtime.state.status === "not_installed" || runtime.state.status === "error") && (
        <InstallGuideCard
          runtimeId={runtimeId}
          displayName={name}
          hint={runtime.state.status === "not_installed" ? runtime.state.hint : (runtime.state.status === "error" ? runtime.state.message : undefined)}
          status={runtime.state.status}
          onRecheck={probeAll}
        />
      )}

      {/* 核心主区：平铺展开的模型生态管理（不折叠） */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h3
              className="text-body-sm font-medium text-ink"
              title="点击星星可置顶收藏；隐藏的模型不会出现在对话底栏的下拉菜单中，保持界面清爽。"
            >
              模型生态与选择器过滤
            </h3>
          </div>
        </div>
        <ProviderModelPanel runtimeId={runtimeId} displayName={name} />
      </section>

      {/* Antigravity 专属：终端默认 YOLO 免审批开关 */}
      {(bareRuntimeId === "agy" || bareRuntimeId === "antigravity") && (
        <section className="rounded-card border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div
                className="flex items-center gap-2 text-body-sm font-medium text-ink"
                title="开启后，在工作台启动 Antigravity 终端时将自动注入免审批参数，自动放行所有终端命令与文件读写，无需每步手动确认。"
              >
                <Zap size={14} className="text-amber-500" />
                <span>终端默认启用 YOLO 免审批模式</span>
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500 font-mono">
                  --dangerously-skip-permissions
                </span>
              </div>
            </div>
            <InstanceSwitch
              checked={agyDefaultYolo}
              onChange={setAgyDefaultYolo}
              label="终端默认启用 YOLO 免审批模式"
            />
          </div>
        </section>
      )}

      {/* 底部卡片：终端凭据与配置指南（真实指导） */}
      <section className="rounded-card border border-line bg-card p-4 space-y-2.5">
        <div className="flex items-center gap-2 text-body-sm font-medium text-ink">
          <KeyRound size={14} className="text-teal" />
          <span>终端凭据与配置指南</span>
        </div>
        <p className="text-caption text-graphite leading-relaxed">
          {guide.tips}
        </p>
        {(guide.authCmd || guide.configPath) && (
          <div className="rounded-card border border-line/80 bg-canvas p-3 text-caption font-mono space-y-1.5">
            {guide.authCmd && (
              <div className="flex items-center gap-2">
                <span className="text-ash font-sans select-none">终端登录命令：</span>
                <code className="text-teal font-semibold">{guide.authCmd}</code>
              </div>
            )}
            {guide.configPath && (
              <div className="flex items-center gap-2">
                <span className="text-ash font-sans select-none">本地配置文件：</span>
                <code className="text-graphite">{guide.configPath}</code>
              </div>
            )}
            {PROVIDER_INSTALL_GUIDES[bareRuntimeId]?.commandWindows && (
              <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-line/60">
                <div className="flex items-center gap-2 overflow-hidden">
                  <span className="text-ash font-sans select-none shrink-0">安装命令：</span>
                  <code className="text-graphite font-mono truncate">{PROVIDER_INSTALL_GUIDES[bareRuntimeId]?.commandWindows}</code>
                </div>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(PROVIDER_INSTALL_GUIDES[bareRuntimeId]?.commandWindows ?? "");
                    setCopiedInstall(true);
                    setTimeout(() => setCopiedInstall(false), 2000);
                  }}
                  title="复制安装命令"
                  className="text-teal hover:underline text-[11px] font-sans shrink-0 font-medium"
                >
                  {copiedInstall ? "已复制" : "复制"}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/* --------------------------------------------------- 原生模型默认值（真写入） */

/**
 * 把「设置页改模型参数」落成真改动 —— 写进 CLI 自己的配置文件（cc-switch 思路）：
 * claude 写 ~/.claude/settings.json 的 env 模型映射与窗口键，codex 写
 * ~/.codex/config.toml 顶层 model_* 键。daemon 侧字段级补丁 + 原子写，
 * 用户的 hooks / permissions / MCP 等其余配置一律不动。
 *
 * 保存后的闭环：daemon 顺带刷一次该执行器的模型清单并带回全新清单 ——
 * claude 的清单就住在 settings.json 里（syncModels 读同一份），界面立刻反映；
 * 这里就地把它灌进注册表（与 useWorkbench.syncModelsAll 同一套归一逻辑，
 * 但只动这一家，不做全量刷新 —— 全量要等所有 CLI 冷启动，正是要省的那笔）。
 */
function NativeModelDefaultsCard({ runtimeId }: { runtimeId: string }) {
  const bare = runtimeId.replace(/^daemon:/, "");
  const [cfg, setCfg] = useState<NativeModelConfig | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setCfg(null);
    setUnsupported(null);
    setLoadErr(null);
    setSaveErr(null);
    setSavedAt(null);
    setDrafts({});
    readModelDefaults(bare)
      .then((res) => {
        if (!alive) return;
        if ("reason" in res) {
          setUnsupported(res.reason);
          return;
        }
        setCfg(res);
        setDrafts(Object.fromEntries(res.fields.map((f) => [f.key, f.value])));
      })
      .catch((err: unknown) => {
        if (alive) setLoadErr(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [bare]);

  const dirty = cfg !== null && cfg.fields.some((f) => (drafts[f.key] ?? "") !== f.value);

  const save = async () => {
    if (cfg === null || !dirty || saving) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await writeModelDefaults(bare, drafts);
      setCfg(res.config);
      setDrafts(Object.fromEntries(res.config.fields.map((f) => [f.key, f.value])));
      setSavedAt(Date.now());
      applyDaemonAdapterToRegistry(res.adapters, bare, res.report);
    } catch (err: unknown) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (unsupported !== null) {
    return (
      <section className="rounded-card border border-line-soft bg-card/60 px-4 py-3">
        <p className="text-caption text-ash">
          <SlidersHorizontal size={11} className="mr-1 inline align-[-1px]" />
          {unsupported}
        </p>
      </section>
    );
  }
  if (loadErr !== null) {
    return (
      <section className="rounded-card border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-caption text-amber-600">模型默认值读取失败：{loadErr}</p>
      </section>
    );
  }
  if (cfg === null) {
    return (
      <section className="rounded-card border border-line-soft bg-card/60 px-4 py-3">
        <p className="text-caption text-ash">正在读取原生模型默认配置…</p>
      </section>
    );
  }

  return (
    <section className="rounded-card border border-line bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-body-sm font-medium text-ink" title={cfg.note}>
            <SlidersHorizontal size={13} className="text-teal" />
            原生模型默认值 · 写入 CLI 自己的配置
          </h3>
          <ConfigPathBar path={cfg.configPath} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {savedAt !== null && !dirty && <span className="text-caption text-teal">已写入 · {formatAgo(savedAt)}</span>}
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 rounded-btn bg-ink px-2.5 py-1.5 text-caption font-medium text-canvas transition hover:opacity-90 active:scale-95 disabled:opacity-40"
          >
            <Check size={12} />
            {saving ? "写入中…" : "保存并写入配置"}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
        {cfg.fields.map((f) => (
          <label key={f.key} className="block min-w-0">
            <span className="text-caption font-medium text-graphite" title={f.hint}>
              {f.label}
            </span>
            {f.kind === "enum" ? (
              <select
                value={drafts[f.key] ?? ""}
                onChange={(e) => {
                  setDrafts((d) => ({ ...d, [f.key]: e.target.value }));
                  setSavedAt(null);
                }}
                className="mt-0.5 w-full rounded-input border border-line bg-rail px-2 py-1 text-caption text-ink outline-none focus:border-teal"
              >
                <option value="">（未设置 · 跟随 CLI 默认）</option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
                {/* 配置里有但不在声明档位里的值：照实列出可保留，否则一保存就被悄悄改掉 */}
                {f.value !== "" && !(f.options ?? []).includes(f.value) && (
                  <option value={f.value}>{f.value}（配置现状）</option>
                )}
              </select>
            ) : (
              <input
                value={drafts[f.key] ?? ""}
                onChange={(e) => {
                  setDrafts((d) => ({ ...d, [f.key]: e.target.value }));
                  setSavedAt(null);
                }}
                list={(f.suggestions ?? []).length > 0 ? `awb-model-suggest-${bare}-${f.key}` : undefined}
                inputMode={f.kind === "number" ? "numeric" : "text"}
                placeholder={f.placeholder ?? (f.kind === "number" ? "token 数，留空 = 用默认" : "留空 = 用默认")}
                spellCheck={false}
                className={cn(
                  "mt-0.5 w-full rounded-input border bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal",
                  saveErr !== null ? "border-loss" : "border-line",
                )}
              />
            )}
            {(f.suggestions ?? []).length > 0 && (
              <datalist id={`awb-model-suggest-${bare}-${f.key}`}>
                {f.suggestions!.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </label>
        ))}
      </div>

      {saveErr !== null && (
        <p className="mt-2 flex items-start gap-1.5 text-caption text-loss">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {saveErr}
        </p>
      )}
      <p
        className="mt-2 text-[10px] text-ash"
        title="清空一个字段 = 删掉对应的键（回到 CLI 自己的默认）；写的是字段级补丁，配置文件里你手写的其余内容不会被改动。"
      >
        清空字段 = 删键回默认；字段级补丁，不动你手写的其余内容。
      </p>
    </section>
  );
}

/** 打开配置文件的通道：Electron 桌面端可开文件本身；文件夹统一走 daemon 的 open-folder */
async function openConfigTarget(path: string, what: "file" | "folder"): Promise<void> {
  const electronShell = (window as unknown as { electronAPI?: { shell?: { openPath?: (p: string) => Promise<unknown> } } }).electronAPI?.shell;
  if (what === "file" && electronShell?.openPath) {
    await electronShell.openPath(path);
    return;
  }
  const folder = what === "folder" ? path : path.replace(/[\\/][^\\/]+$/, "");
  try {
    const base = defaultDaemonEndpoint().replace(/\/ws$/, "");
    const boot = await fetch(`${base}/bootstrap`);
    const token = ((await boot.json()) as { token?: string }).token ?? "";
    await fetch(`${base}/api/workspaces/open-folder`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-awb-token": token },
      body: JSON.stringify({ path: folder }),
    });
  } catch {
    /* daemon 不可达时静默（按钮无害失败） */
  }
}

/** 配置路径行 + 打开文件 / 打开文件夹按钮（各卡片共用） */
function ConfigPathBar({ path }: { path: string }) {
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate font-mono text-[10px] text-ash/80" title={path}>
        {path}
      </span>
      <button
        type="button"
        onClick={() => void openConfigTarget(path, "file")}
        title="用系统默认程序打开这份配置文件（浏览器模式下不可用）"
        className="flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[10px] text-teal hover:bg-line-soft"
      >
        <FileText size={10} />
        打开文件
      </button>
      <button
        type="button"
        onClick={() => void openConfigTarget(path, "folder")}
        title="在文件管理器中打开所在文件夹"
        className="flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[10px] text-teal hover:bg-line-soft"
      >
        <FolderOpen size={10} />
        打开文件夹
      </button>
    </p>
  );
}

/* ----------------------------------------------------- 供应商配置（累加式面） */

/** 供应商编辑行（本地草稿） */
interface ProviderDraftRow {
  key: number;
  origKey?: string;
  keyId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  models: string;
}

let providerDraftSeq = 0;

/**
 * 供应商与模型编辑器（pi / opencode 一类「多家共存」的原生配置面，cc-switch 累加式同款）：
 * 每行一个供应商（标识 / 名称 / baseURL / API Key / 协议或包名 / 模型 id 清单），
 * 保存写进 CLI 自己的配置文件并顺带刷模型清单 —— 新加的模型立刻出现在选择器里。
 * 没有本地供应商面的执行器（kimi / agy / zcode 一类，清单在服务侧）整卡不渲染。
 */
function ModelProvidersCard({ runtimeId }: { runtimeId: string }) {
  const bare = runtimeId.replace(/^daemon:/, "");
  const [info, setInfo] = useState<NativeProvidersInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const [rows, setRows] = useState<ProviderDraftRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const toDrafts = (
    providers: readonly { key: string; name: string; baseUrl: string; apiKey: string; api: string; models: readonly string[] }[],
  ) =>
    providers.map((e) => ({
      key: ++providerDraftSeq,
      origKey: e.key,
      keyId: e.key,
      name: e.name,
      baseUrl: e.baseUrl,
      apiKey: e.apiKey,
      api: e.api,
      models: e.models.join(", "),
    }));

  useEffect(() => {
    let alive = true;
    setHidden(false);
    setInfo(null);
    setSaveErr(null);
    setSavedAt(null);
    setDirty(false);
    setRows([]);
    readModelProviders(bare)
      .then((res) => {
        if (!alive) return;
        if ("reason" in res) {
          setHidden(true);
          return;
        }
        setInfo(res);
        setRows(toDrafts(res.providers));
      })
      .catch(() => {
        if (alive) setHidden(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bare]);

  const patchRow = (key: number, patch: Partial<ProviderDraftRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
    setSavedAt(null);
  };

  const save = async () => {
    if (info === null || !dirty || saving) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const out: ProviderWriteRow[] = rows.map((r) => ({
        origKey: r.origKey,
        key: r.keyId.trim(),
        name: r.name.trim(),
        baseUrl: r.baseUrl.trim(),
        apiKey: r.apiKey.trim(),
        api: r.api.trim(),
        models: r.models.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== ""),
      }));
      if (out.some((r) => r.key === "")) throw new Error("供应商标识（key）不能为空");
      const dup = out.map((r) => r.key).find((k, i, a) => a.indexOf(k) !== i);
      if (dup !== undefined) throw new Error(`供应商标识重复：${dup}`);
      const res = await writeModelProviders(bare, out);
      setInfo(res.providers);
      setRows(toDrafts(res.providers.providers));
      setDirty(false);
      setSavedAt(Date.now());
      applyDaemonAdapterToRegistry(res.adapters, bare, res.report);
    } catch (err: unknown) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (hidden) return null;
  if (info === null) {
    return (
      <section className="rounded-card border border-line-soft bg-card/60 px-4 py-3">
        <p className="text-caption text-ash">正在读取供应商配置…</p>
      </section>
    );
  }

  return (
    <section className="rounded-card border border-line bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-body-sm font-medium text-ink" title={info.note}>
            <Zap size={13} className="text-teal" />
            供应商与模型 · 写入 CLI 自己的配置
          </h3>
          <ConfigPathBar path={info.configPath} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {savedAt !== null && !dirty && <span className="text-caption text-teal">已写入 · {formatAgo(savedAt)}</span>}
          <button
            onClick={() => {
              setRows((rs) => [...rs, { key: ++providerDraftSeq, keyId: "", name: "", baseUrl: "", apiKey: "", api: "", models: "" }]);
              setDirty(true);
              setSavedAt(null);
            }}
            className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption font-medium text-graphite hover:bg-line-soft hover:text-ink"
          >
            <Plus size={11} />
            添加供应商
          </button>
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 rounded-btn bg-ink px-2.5 py-1.5 text-caption font-medium text-canvas transition hover:opacity-90 active:scale-95 disabled:opacity-40"
          >
            <Check size={12} />
            {saving ? "写入中…" : "保存供应商"}
          </button>
        </div>
      </div>

      {info.managedByExternal !== undefined && (
        <p className="mt-2 flex items-start gap-1.5 rounded-btn border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-caption text-amber-600">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {info.managedByExternal}：这份文件暂不能在界面内编辑，可点上方「打开文件」直接手改。
        </p>
      )}

      <div className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-1 gap-1.5 rounded-btn border border-line-soft px-2 py-2 sm:grid-cols-[110px_minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
            <input value={r.keyId} onChange={(e) => patchRow(r.key, { keyId: e.target.value })} placeholder="标识 *" aria-label="供应商标识" spellCheck={false} className="min-w-0 rounded-input border border-line bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:font-sans placeholder:text-ash focus:border-teal" />
            <input value={r.name} onChange={(e) => patchRow(r.key, { name: e.target.value })} placeholder="名称" aria-label="供应商名称" className="min-w-0 rounded-input border border-line bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal" />
            <input value={r.baseUrl} onChange={(e) => patchRow(r.key, { baseUrl: e.target.value })} placeholder="baseURL https://…/v1" aria-label="baseURL" spellCheck={false} className="min-w-0 rounded-input border border-line bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:font-sans placeholder:text-ash focus:border-teal" />
            <input value={r.apiKey} onChange={(e) => patchRow(r.key, { apiKey: e.target.value })} placeholder="API Key" aria-label="API Key" spellCheck={false} className="min-w-0 rounded-input border border-line bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:font-sans placeholder:text-ash focus:border-teal" />
            <input value={r.api} onChange={(e) => patchRow(r.key, { api: e.target.value })} placeholder="协议/包名（空=默认）" aria-label="协议或包名" spellCheck={false} className="min-w-0 rounded-input border border-line bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:font-sans placeholder:text-ash focus:border-teal" />
            <div className="col-span-1 flex items-center gap-1.5 sm:col-span-5">
              <input
                value={r.models}
                onChange={(e) => patchRow(r.key, { models: e.target.value })}
                placeholder="模型 id 清单（逗号分隔）—— 选择器里「标识/模型」的后半段"
                aria-label="模型清单"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-input border border-line bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:font-sans placeholder:text-ash focus:border-teal"
              />
              <button
                onClick={() => {
                  setRows((rs) => rs.filter((x) => x.key !== r.key));
                  setDirty(true);
                  setSavedAt(null);
                }}
                aria-label={`删除供应商 ${r.name || r.keyId}`}
                title="删除这个供应商（其余供应商不受影响）"
                className="shrink-0 rounded p-1 text-ash hover:bg-line hover:text-loss"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="px-1 py-2 text-caption text-ash">还没有本地供应商 —— 「添加供应商」接一个网关，模型清单里填它的模型 id，保存即出现在选择器。</p>
        )}
      </div>

      {saveErr !== null && (
        <p className="mt-2 flex items-start gap-1.5 text-caption text-loss">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {saveErr}
        </p>
      )}
      <p
        className="mt-2 text-[10px] text-ash"
        title="条目里未列出的字段（headers / compat 一类）保存时原样保留；整表提交，删掉的供应商会从配置中移除。"
      >
        未列出字段原样保留；整表提交，删掉的供应商会从配置移除。
      </p>
    </section>
  );
}

/* ----------------------------------------------------- 模型目录（清单级编辑） */

/** 目录编辑行（本地草稿）：origSlug 有值 = 编辑现有条目，缺省 = 新增 */
interface CatalogDraftRow {
  key: number;
  origSlug?: string;
  slug: string;
  name: string;
  ctx: string;
  efforts: string;
  visibility: string;
  multimodal: boolean;
}

let catalogDraftSeq = 0;

/**
 * 执行器模型目录编辑器 —— cc-switch 的模型目录功能同款：增删模型、改显示名 /
 * 上下文窗口 / 推理档位 / 可见性，写进 CLI 自己的目录文件（codex 的
 * model-catalogs/*.json，经 config.toml 的 model_catalog_json 挂载）。
 *
 * 整表提交语义：表里没出现的旧条目视为**删除**（内置同名模型回落 codex 自带）；
 * 保存后 daemon 顺带跑一次模型同步，选择器与设置页立刻反映新目录。
 * 没有目录面的执行器（claude / ACP 系）不渲染本卡 —— 目录是 codex 一类
 * 「目录文件」执行器的编辑面，别家显示一行「不支持」徒增噪音。
 */
function ModelCatalogCard({ runtimeId }: { runtimeId: string }) {
  const bare = runtimeId.replace(/^daemon:/, "");
  const [info, setInfo] = useState<ModelCatalogInfo | null>(null);
  const [hidden, setHidden] = useState(true); // unsupported 时不渲染整卡
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [rows, setRows] = useState<CatalogDraftRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setHidden(false);
    setInfo(null);
    setLoadErr(null);
    setSaveErr(null);
    setSavedAt(null);
    setDirty(false);
    setRows([]);
    readModelCatalog(bare)
      .then((res) => {
        if (!alive) return;
        if ("reason" in res) {
          setHidden(true); // 没有目录面的执行器：整卡不渲染
          return;
        }
        setInfo(res);
        setRows(
          res.entries.map((e) => ({
            key: ++catalogDraftSeq,
            origSlug: e.slug,
            slug: e.slug,
            name: e.display_name,
            ctx: e.context_window !== undefined ? String(e.context_window) : "",
            efforts: (e.supported_reasoning_levels ?? []).join(", "),
            visibility: e.visibility,
            multimodal: e.multimodal === true,
          })),
        );
      })
      .catch((err: unknown) => {
        if (alive) setLoadErr(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [bare]);

  const patchRow = (key: number, patch: Partial<CatalogDraftRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
    setSavedAt(null);
  };

  const addRow = () => {
    setRows((rs) => [...rs, { key: ++catalogDraftSeq, slug: "", name: "", ctx: "", efforts: "", visibility: "list", multimodal: false }]);
    setDirty(true);
    setSavedAt(null);
  };

  const save = async () => {
    if (info === null || !dirty || saving) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const out: ModelCatalogWriteRow[] = [];
      for (const r of rows) {
        const ctxTrim = r.ctx.trim();
        if (ctxTrim !== "" && !/^\d+$/.test(ctxTrim)) {
          throw new Error(`${r.slug || "新条目"} 的窗口需为正整数 token 数（留空 = 不声明）`);
        }
        const efforts = r.efforts.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== "");
        out.push({
          origSlug: r.origSlug,
          slug: r.slug.trim(),
          display_name: r.name.trim(),
          context_window: ctxTrim === "" ? undefined : Number(ctxTrim),
          supported_reasoning_levels: efforts.length > 0 ? efforts : undefined,
          visibility: r.visibility === "hide" ? "hide" : "list",
          multimodal: r.multimodal,
        });
      }
      const res = await writeModelCatalog(bare, out);
      setInfo(res.catalog);
      setRows(
        res.catalog.entries.map((e) => ({
          key: ++catalogDraftSeq,
          origSlug: e.slug,
          slug: e.slug,
          name: e.display_name,
          ctx: e.context_window !== undefined ? String(e.context_window) : "",
          efforts: (e.supported_reasoning_levels ?? []).join(", "),
          visibility: e.visibility,
          multimodal: e.multimodal === true,
        })),
      );
      setDirty(false);
      setSavedAt(Date.now());
      applyDaemonAdapterToRegistry(res.adapters, bare, res.report);
    } catch (err: unknown) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (hidden) return null;
  if (loadErr !== null) {
    return (
      <section className="rounded-card border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-caption text-amber-600">模型目录读取失败：{loadErr}</p>
      </section>
    );
  }
  if (info === null) {
    return (
      <section className="rounded-card border border-line-soft bg-card/60 px-4 py-3">
        <p className="text-caption text-ash">正在读取模型目录…</p>
      </section>
    );
  }

  const hiddenCount = rows.filter((r) => r.visibility === "hide").length;

  return (
    <section className="rounded-card border border-line bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-body-sm font-medium text-ink" title={info.note}>
            <Sparkles size={13} className="text-teal" />
            模型目录 · 增删与编辑（写入 CLI 目录文件）
          </h3>
          {info.activePath !== null ? (
            <ConfigPathBar path={info.activePath} />
          ) : (
            <p className="mt-0.5 font-mono text-[10px] text-ash/80">（未配置 —— 保存后创建工作台目录）</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {savedAt !== null && !dirty && <span className="text-caption text-teal">已写入 · {formatAgo(savedAt)}</span>}
          <button onClick={addRow} className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption font-medium text-graphite hover:bg-line-soft hover:text-ink">
            <Plus size={11} />
            添加模型
          </button>
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 rounded-btn bg-ink px-2.5 py-1.5 text-caption font-medium text-canvas transition hover:opacity-90 active:scale-95 disabled:opacity-40"
          >
            <Check size={12} />
            {saving ? "写入中…" : "保存目录"}
          </button>
        </div>
      </div>

      {info.managedByExternal !== undefined && (
        <p className="mt-2 flex items-start gap-1.5 rounded-btn border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-caption text-amber-600">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          这份目录文件由 {info.managedByExternal} 生成 —— 保存直接生效；但在 {info.managedByExternal} 里切换供应商会重新生成它，这里的编辑会被覆盖。
        </p>
      )}

      <div className="mt-3 space-y-1">
        {/* 表头（与行内输入同栅格） */}
        <div className="hidden sm:grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.1fr)_84px_minmax(0,1.2fr)_auto] items-center gap-1.5 px-1 text-[10px] font-medium text-ash">
          <span>模型 slug（实际模型 id）</span>
          <span>显示名</span>
          <span>窗口 token</span>
          <span>推理档位（逗号分隔，留空 = 不声明）</span>
          <span className="w-[68px] text-center">可见 / 视觉</span>
        </div>
        {rows.map((r) => {
          const isHidden = r.visibility === "hide";
          return (
            <div
              key={r.key}
              className={cn(
                "grid grid-cols-2 items-center gap-1.5 rounded-btn px-1 py-1 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1.1fr)_84px_minmax(0,1.2fr)_auto]",
                isHidden && "opacity-60",
              )}
            >
              <input
                value={r.slug}
                onChange={(e) => patchRow(r.key, { slug: e.target.value })}
                placeholder="模型 id *"
                aria-label="模型 slug"
                spellCheck={false}
                className="min-w-0 rounded-input border border-line bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:font-sans placeholder:text-ash focus:border-teal"
              />
              <input
                value={r.name}
                onChange={(e) => patchRow(r.key, { name: e.target.value })}
                placeholder="显示名（空 = 用 slug）"
                aria-label="显示名"
                className="min-w-0 rounded-input border border-line bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
              />
              <input
                value={r.ctx}
                onChange={(e) => patchRow(r.key, { ctx: e.target.value })}
                inputMode="numeric"
                placeholder="272000"
                aria-label="上下文窗口"
                className="min-w-0 rounded-input border border-line bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
              />
              <input
                value={r.efforts}
                onChange={(e) => patchRow(r.key, { efforts: e.target.value })}
                placeholder="low, medium, high"
                aria-label="推理档位"
                spellCheck={false}
                className="min-w-0 rounded-input border border-line bg-rail px-2 py-1 text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
              />
              <div className="col-span-2 flex items-center justify-end gap-0.5 sm:col-span-1">
                <button
                  onClick={() => patchRow(r.key, { visibility: isHidden ? "list" : "hide" })}
                  aria-label={isHidden ? `恢复显示 ${r.name || r.slug}` : `隐藏 ${r.name || r.slug}`}
                  title={isHidden ? "隐藏中 —— 点击恢复到选择面" : "从选择面隐藏（不是删除）"}
                  className={cn("rounded p-1", isHidden ? "text-amber-600" : "text-ash hover:bg-line hover:text-ink")}
                >
                  {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button
                  onClick={() => patchRow(r.key, { multimodal: !r.multimodal })}
                  aria-label={r.multimodal ? "多模态" : "仅文本"}
                  title={r.multimodal ? "声明支持图片输入（input_modalities 含 image）" : "仅文本 —— 点击声明支持图片"}
                  className={cn("rounded p-1", r.multimodal ? "text-teal" : "text-ash/60 hover:bg-line hover:text-ink")}
                >
                  <ImageIcon size={12} />
                </button>
                <button
                  onClick={() => {
                    setRows((rs) => rs.filter((x) => x.key !== r.key));
                    setDirty(true);
                    setSavedAt(null);
                  }}
                  aria-label={`删除 ${r.name || r.slug}`}
                  title="从目录删除（codex 内置同名模型会回到自带清单）"
                  className="rounded p-1 text-ash hover:bg-line hover:text-loss"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="px-1 py-2 text-caption text-ash">
            目录是空的 —— 「添加模型」加一条，或这份清单本来就不在这份目录里。
          </p>
        )}
      </div>

      {saveErr !== null && (
        <p className="mt-2 flex items-start gap-1.5 text-caption text-loss">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {saveErr}
        </p>
      )}
      <p
        className="mt-2 text-[10px] text-ash"
        title={`整表提交：删掉的条目即从目录移除${hiddenCount > 0 ? `；已隐藏 ${hiddenCount} 条（隐藏 ≠ 删除，随时点眼睛恢复）` : ""}。条目里未列出的其余字段（描述 / 优先级…）保存时原样保留。`}
      >
        整表提交：删掉的条目即从目录移除{hiddenCount > 0 ? ` · 已隐藏 ${hiddenCount} 条（可恢复）` : ""}。
      </p>
    </section>
  );
}

/**
 * 把 daemon 带回的**单家**执行器清单灌进注册表（保存模型默认值后的就地刷新）。
 * 与 useWorkbench.syncModelsAll 是同一套归一逻辑（裸 id → 品牌化 ModelId、
 * cachedAt 语义），但只动这一家 —— 全量刷新要等所有 CLI 冷启动，这里等不起。
 * 顺带把该家的同步报告并进 store.modelSync（别家条目保留，避免标签退化成「兜底」）。
 */
function applyDaemonAdapterToRegistry(
  adapters: readonly DaemonExecutorInfo[],
  bare: string,
  report: readonly ModelSyncReport[],
): void {
  const fresh = adapters.find((a) => a.id === bare);
  const entryId = `daemon:${bare}`;
  const entry = runtimeRegistry.get(entryId as never);
  if (fresh !== undefined && entry !== undefined) {
    const raw = fresh.models.map((m) => ({ ...m, id: asModelId(m.id) }));
    runtimeRegistry.updateModels(
      entryId as never,
      raw,
      fresh.modelsDiscoverable !== false,
      fresh.modelsCachedAt ?? undefined,
    );
  }
  const prior = useWorkbench.getState().modelSync;
  const merged = prior === null ? [] : prior.report.filter((r) => r.runtimeId !== bare);
  for (const r of report) merged.push({ ...r });
  useWorkbench.setState({ modelSync: { at: Date.now(), report: merged } });
}
