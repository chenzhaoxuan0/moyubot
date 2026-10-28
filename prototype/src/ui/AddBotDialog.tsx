import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  BookOpen,
  Bot,
  Brain,
  Check,
  Download,
  FileText,
  FolderOpen,
  ImagePlus,
  Package,
  Pin,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Wand2,
  X,
  Radio,
  type LucideIcon,
} from "lucide-react";
import { useWorkbench, selectVisibleModels, BOT_CONFLICT, type BotWriteGuards } from "../store/useWorkbench.ts";
import { type WorkUnit, type UnitKind, type BotChannel } from "../core/units.ts";
import { toHex, isValidColor } from "../core/appearance.ts";
import { accentCandidatesFromImageData, extractAvatarAccents } from "../core/avatarAccent.ts";
import { type SearchProviderId } from "../core/search.ts";
import { fetchBotDefaultRoot, inspectBotFolder, openFolder } from "../adapters/daemon/client.ts";
import { ChannelSection } from "./ChannelSection.tsx";
import { ImportSessionsSection } from "./ImportSessionsSection.tsx";
import { FolderPickerField } from "./FolderPickerField.tsx";
import { UnitContextBadge, UnitContextEditor, WorkspaceInitAndUnregisterBar } from "./UnitContextEditor.tsx";
import { WorkspaceSkillsEditor } from "./WorkspaceSkillsEditor.tsx";
import { SEARCH_DRAFT_INIT, SearchSection, type SearchDraftState } from "./SearchSection.tsx";
import { cn } from "./cn.ts";

/**
 * 新建 / 编辑 bot 对话框 —— 单轨零门槛（ADR 0011 第 1、2、4 条）。
 *
 * 新建的唯一必填交互 = 文件夹：打开时向 daemon 要「自动安置默认位置」
 * （`<homeDir>/bots/<建议名>`）预填进输入框——用户不动就是自动安置，改了
 * （手输或点「浏览」）就是自定义指位。名字默认跟随文件夹名，可改。
 * 其余一切（persona / AGENTS.md / 渠道 / 记忆 / 绑定）全部可选、后补；
 * AGENTS.md 留空保存时 daemon 静默生成最小占位（文件即数据库不破）。
 *
 * **新建＝新建＋认领单轨**（原 ImportBotDialog 已并入）：指向一个已存在的
 * 文件夹时，输入框防抖探测一次——有 AGENTS.md 就预填派生身份，已被别的
 * bot 注册就当场说破；提交时 daemon 对已存在目录只注册不搬动，AGENTS.md
 * 留空不覆盖既有文件（putBot 的「带空正文不碰盘上文件」分支）。
 *
 * 编辑模式额外暴露 kind 切换（bot ↔ 项目，弱标签）：判据问句文案，
 * 保存走既有 putBot 乐观锁链路。
 */

export interface BotMemoryPolicy {
  readonly semantic: boolean;
  readonly episodic: boolean;
  readonly procedural: boolean;
}

export interface AddBotDraft {
  readonly name: string;
  readonly role: string;
  /** 自定义头像（96×96 data URL）。undefined = 用按名字生成的默认头像 */
  readonly avatar?: string;
  /**
   * 对话主题色（#rrggbb，2026-10-28）：这个 bot 对话列的强调色，可从头像
   * 提取（签名色，非最大面积色）也可手动指定。undefined = 跟随全局主题。
   */
  readonly themeAccent?: string;
  readonly rootPath: string;
  readonly runtimeId: string;
  readonly modelHint: string | null;
  readonly persona: string;
  readonly memory: BotMemoryPolicy;
  /** 留空 = 不写正文，daemon 落盘时静默补最小占位（AGENTS.md 可选化，ADR 0011） */
  readonly agentsMd?: string;
  readonly channels: readonly BotChannel[];
  readonly resident?: boolean;
  /** 外部会话自动收录（写穿 bot.json；缺省 = 开） */
  readonly autoCollect?: boolean;
  /** 弱标签（ADR 0011 第 2 条）：新建恒 "bot"；编辑模式的切换由对话框自己补写 */
  readonly kind: UnitKind;
  /**
   * 搜索配置（bot 级，daemon 侧存储）：undefined = 本次未动搜索分区。
   * 保存链路：bot 定义落盘后由调用方（BotSettingsPane / NewBotPane）调
   * `search.configure` 写密钥槽——密钥不进 bot.json。
   */
  readonly search?: { provider: SearchProviderId | "none"; apiKey: string };
}

type Section = "identity" | "context" | "skills" | "channels" | "search" | "importSessions";

const SECTIONS: readonly { id: Section; label: string; icon: LucideIcon; hint: string }[] = [
  { id: "identity", label: "身份", icon: FileText, hint: "目录、名称、角色、执行器" },
  { id: "context", label: "上下文与文件", icon: BookOpen, hint: "注入清单与 SOUL/AGENTS/MEMORY/STANDING/USER" },
  { id: "channels", label: "渠道", icon: Radio, hint: "把 bot 接到 IM / webhook" },
  { id: "search", label: "搜索", icon: Search, hint: "这个 bot 的联网搜索（Tavily / DeepSeek / 豆包 / 元宝）", },
];

const SECTION_LIBRARY: readonly { label: string; snippet: (name: string) => string }[] = [
  {
    label: "项目概览",
    snippet: (n) => `## 项目概览\n- ${n} 服务于：\n- 关键依赖与数据来源：\n`,
  },
  {
    label: "环境提示",
    snippet: () => `## 环境提示\n- 首选命令与参数：\n- 需要规避的操作：\n`,
  },
  {
    label: "代码风格",
    snippet: () => `## 代码风格\n- 语言与框架偏好：\n- 命名与注释约定：\n`,
  },
  {
    label: "测试说明",
    snippet: () => `## 测试说明\n- 交付前必须通过的检查：\n- 回归验证方式：\n`,
  },
  {
    label: "交付说明",
    snippet: () => `## 交付说明\n- 产物位置与命名：\n- 汇报格式：做了什么 / 产出在哪 / 下一步\n`,
  },
];

const PERSONA_TEMPLATE = (name: string, role: string) =>
  `你是「${name}」——${role || "一个领域专属助手"}。\n\n语气与风格：\n- 简洁、务实、不堆砌客套\n- 结论先行，细节按需展开\n\n原则：\n- 不确定先问，不要猜\n- 交付前自检一遍\n`;

function agentsMdTemplate(name: string, role: string, rootPath: string): string {
  return `# ${name}\n\n> ${role || "（一句话说清这个 bot 被设计用来做什么）"}\n\n## 这个 bot 负责什么\n- 边界：\n- 产出物：\n\n## 工作目录\n- 根目录：\`${rootPath}\`\n- 动手前先读目录里已有的文件，长期记忆与产出都落在这里\n\n## 工作方式\n- 接到任务先列 3 步以内的计划，再执行\n- 不确定的地方先提问，不要猜\n\n## 交付与验收\n- 每次交付一个可检查的产物（文件 / 清单 / 报告）\n- 完成后汇报：做了什么、产出在哪、下一步建议\n`;
}

/** 路径末段（兼容 / 与 \）。名字默认跟随文件夹名的那条线靠它。 */
function folderBasename(p: string): string {
  const parts = p.replace(/\\/g, "/").replace(/\/+$/u, "").split("/");
  return parts[parts.length - 1] ?? "";
}

export function AddBotDialog({
  open,
  initial,
  onClose,
  onSubmit,
  embedded = false,
}: {
  open: boolean;
  /**
   * 编辑模式：传入已有单元即预填、按「保存」提交；null / undefined 是新建。
   * 和新建共用一份表单状态 —— 两套表单迟早会长歪。
   */
  initial?: WorkUnit | null;
  onClose: () => void;
  /**
   * 提交。返回的 Promise 若以 code="conflict" 拒绝，表示「盘上已被改过，未写入」——
   * 对话据展示覆盖 / 重新加载 / 取消三选一。`opts.overwrite` 让调用方跳过乐观锁。
   */
  onSubmit: (draft: AddBotDraft, opts?: { overwrite?: boolean }) => void | Promise<void>;
  /**
   * 嵌入右栏形态（2026-10-23 设置面归拢）：bot 设置不再弹 920px 大窗，改由右侧栏
   * 承载——去掉遮罩/头部（tab 条即标题），分区导航从竖排侧栏换成横排 chips，
   * 底部（冲突三选一 + 保存）原样保留。新建流仍走弹窗。
   */
  embedded?: boolean;
}) {
  const runtimes = useWorkbench((s) => s.runtimes);
  const [section, setSection] = useState<Section>("identity");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [agentsMd, setAgentsMd] = useState("");
  const [persona, setPersona] = useState("");
  const [personaTouched, setPersonaTouched] = useState(false);
  const [memory, setMemory] = useState<BotMemoryPolicy>({ semantic: true, episodic: true, procedural: true });
  const [error, setError] = useState<string | null>(null);
  const [runtimeId, setRuntimeId] = useState<string>("");
  const [modelHint, setModelHint] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  /** 对话主题色（#rrggbb）。null = 跟随全局主题（不写 bot.json） */
  const [themeAccent, setThemeAccent] = useState<string | null>(null);
  /** 从当前头像提取的候选签名色（推荐度降序）。头像一变就重算 */
  const [accentCandidates, setAccentCandidates] = useState<readonly string[]>([]);
  /** hex 输入的草稿（draft-on-blur 提交，AppearanceSettingsSection.ColorField 同款） */
  const [accentHexDraft, setAccentHexDraft] = useState<string | null>(null);
  /** 未设主题色时原生取色器的起始位（读一次全局 accent，让 picker 从用户熟悉的颜色出发） */
  const [accentPickerSeed, setAccentPickerSeed] = useState("#7aa2f7");
  const [resident, setResident] = useState(false);
  const [autoCollect, setAutoCollect] = useState(true);
  /** 单元形态（弱标签）：编辑模式可切 bot ↔ 项目（ADR 0011 第 2 条） */
  const [kind, setKind] = useState<UnitKind>("bot");
  /** 目录浏览器的起始根候选（打开时向 daemon 要；daemon 未连接则浏览禁用、手输兜底） */
  const [browseRoots, setBrowseRoots] = useState<readonly string[]>([]);
  /** 名字是否被用户亲手改过——没改过就跟随文件夹名（单轨零门槛：名字不必输入） */
  const nameTouchedRef = useRef(false);
  /** 用户动过文件夹输入（手输/浏览选择）——RPC 往返期间不覆盖用户已填的路径 */
  const rootPathTouchedRef = useRef(false);
  /** 打开这一刻盘上的真值，保存时当乐观锁基线传回 daemon */
  const [baseGuards, setBaseGuards] = useState<BotWriteGuards>({});
  /** 盘上已被改过、未写入。等用户选：覆盖 / 重新加载 / 取消 */
  const [conflict, setConflict] = useState<{ reason: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [diskNote, setDiskNote] = useState<string | null>(null);
  /** AGENTS.md 落盘位置（编辑模式才有）。显示它，用户才知道去 VS Code 改哪个文件。 */
  const [agentsMdMeta, setAgentsMdMeta] = useState<WorkUnit["agentsMdMeta"]>(undefined);
  /** 渠道配置。空 = 纯工作台内 bot。改了跟着保存一起写穿 bot.json。 */
  const [channels, setChannels] = useState<readonly BotChannel[]>(initial?.channels ?? []);
  /** 搜索分区草稿（daemon 侧存储，保存链路见 AddBotDraft.search 注释） */
  const [searchDraft, setSearchDraft] = useState<SearchDraftState>(SEARCH_DRAFT_INIT);
  const [folderOpened, setFolderOpened] = useState(false);
  /** 认领提示：目标文件夹已被别的 bot 注册（提交会被 daemon 的 root_taken 拦下） */
  const [claimHint, setClaimHint] = useState<string | null>(null);

  const isEdit = Boolean(initial);

  // selectVisibleModels 引用稳定（visibleModelsFor 按 runtimeId 分槽缓存），
  // 不能在此处 .map() 出新对象——那会回到 getSnapshot 无限循环的老坑
  const runtimeModelSpecs = useWorkbench(selectVisibleModels(runtimeId));

  /** 用一个单元定义填满整张表单（预填与「重新加载」共用，免得两处走偏） */
  const fillFrom = (b: WorkUnit) => {
    const binding = b.bindings.find((x) => x.primary) ?? b.bindings[0];
    // 初始默认不为空：没绑过执行器/模型时，预填当前执行器与它的默认模型，保存即可用
    const rid = binding?.runtimeId ?? (runtimes.length > 0 ? useWorkbench.getState().activeRuntimeId : "");
    setName(b.name);
    nameTouchedRef.current = true; // 编辑模式的名字是既有事实，不跟随文件夹名
    setRole(b.identity?.role ?? "");
    setRootPath(b.rootPath);
    setAgentsMd(b.agentsMd ?? "");
    // ADR 0014：人设优先读 SOUL.md 文件；老 bot 回落 identity.persona（保存即迁移）
    setPersona(b.soulMd ?? b.identity?.persona ?? "");
    setPersonaTouched(true);
    setMemory(b.memory ?? { semantic: true, episodic: true, procedural: true });
    setRuntimeId(rid);
    setModelHint(binding?.modelHint ?? runtimes.find((r) => r.id === rid)?.defaultModel ?? null);
    setAvatar(b.avatar ?? null);
    setThemeAccent(b.themeAccent ?? null);
    setAccentHexDraft(null);
    setResident(Boolean(b.resident));
    setAutoCollect(b.autoCollect !== false);
    setKind(b.kind ?? "bot");
    setChannels(b.channels ?? []);
    setAgentsMdMeta(b.agentsMdMeta);
    setBaseGuards({
      ifRevision: b.revision,
      ifAgentsMdHash: b.agentsMdMeta?.hash ?? "",
    });
  };

  // 打开时重置 / 预填。
  // 新建（单轨零门槛，ADR 0011 第 1 条）：对话框自己向 daemon 要「自动安置默认
  // 位置」预填文件夹（Sidebar 的接线不动）；用户不动就是自动安置，改了就是自定义
  // 指位。daemon 未连接时输入框留空、手输兜底。
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConflict(null);
    setDiskNote(null);
    setClaimHint(null);
    setSection("identity");
    // 搜索草稿两种模式都要归零：编辑分支若不重置，上一个 bot 的草稿（含密钥）
    // 会跟着 initial 切换串进另一个 bot 的保存里
    setSearchDraft(SEARCH_DRAFT_INIT);
    let cancelled = false;
    const fetchPlacement = async (prefill: boolean): Promise<void> => {
      try {
        const r = await fetchBotDefaultRoot();
        if (cancelled) return;
        setBrowseRoots(r.browseRoots);
        if (prefill && !rootPathTouchedRef.current) {
          setRootPath(r.suggestedPath);
          if (!nameTouchedRef.current) setName(folderBasename(r.suggestedPath));
        }
      } catch {
        // daemon 未连接：浏览禁用、默认位置留空——手输路径始终可用
      }
    };
    if (initial) {
      fillFrom(initial);
      void fetchPlacement(false);
    } else {
      setName("");
      nameTouchedRef.current = false;
      rootPathTouchedRef.current = false;
      setRole("");
      setRootPath("");
      setAgentsMd("");
      setPersona("");
      setPersonaTouched(false);
      setMemory({ semantic: true, episodic: true, procedural: true });
      // activeRuntimeId 在没有 daemon 时是个残留的默认字符串（如 "zcode"），
      // 直接用它会让「默认模型」列出某个并不存在的执行器的模型，
      // 提交时还会写出一条指向幽灵执行器的绑定。没有可用执行器就置空。
      const st = useWorkbench.getState();
      setRuntimeId(st.runtimes.length > 0 ? st.activeRuntimeId : "");
      setModelHint(
        st.runtimes.find((r) => r.id === st.activeRuntimeId)?.defaultModel ?? null,
      );
      setAvatar(null);
      setThemeAccent(null);
      setAccentCandidates([]);
      setAccentHexDraft(null);
      setResident(false);
      setKind("bot");
      setChannels([]);
      setAgentsMdMeta(undefined);
      setBaseGuards({});
      void fetchPlacement(true);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fillFrom 依赖表单重置语义，随 open/initial?.id 整体重跑
  }, [open, initial?.id]);

  // 头像候选签名色：头像一变（上传 / 更换 / 编辑预填）就重算。黑底头像的
  // 签名色常只有小面积，这里只出候选，选哪个永远归用户；头像清空即候选清空。
  useEffect(() => {
    if (!open) return;
    const src = avatar;
    if (!src) {
      setAccentCandidates([]);
      return;
    }
    let cancelled = false;
    void extractAvatarAccents(src)
      .then((cs) => {
        if (!cancelled) setAccentCandidates(cs);
      })
      .catch(() => {
        if (!cancelled) setAccentCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, avatar]);

  // 未设主题色时，取色器起始位对齐当前全局 accent（一次性读 computed 变量，
  // 不订阅——picker 起始位只是便利，不是状态）
  useEffect(() => {
    if (!open || themeAccent !== null) return;
    const v = getComputedStyle(document.documentElement).getPropertyValue("--color-teal").trim();
    if (isValidColor(v)) setAccentPickerSeed(toHex(v));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开/清空那一刻读一次
  }, [open, themeAccent === null]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 认领并入新建的探测（只读，防抖 350ms）：新建模式下文件夹指向一个已存在的
  // 目录时问一次 bot.inspect —— 已被注册当场说破（提交也会被 root_taken 拦，
  // 早说早省事）；有 AGENTS.md 就预填派生身份（名字未手改时跟随，角色只补空）；
  // 文件夹里已有 bot.json（换机/移动目录后的重连场景）则身份与主执行器直接取
  // 既有定义，尽量让这次注册与原定义内容一致。daemon 不可达 / 路径不存在都
  // 静默：前者提交时自会报错，后者是「将自动创建」。
  useEffect(() => {
    if (!open || isEdit) return;
    const target = rootPath.trim();
    if (target === "") {
      setClaimHint(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void inspectBotFolder(target)
        .then(({ report, existing }) => {
          if (cancelled) return;
          const taken = report.conflicts.alreadyRegistered;
          if (report.exists && taken !== null) {
            setClaimHint(`这个目录已经是「${taken.name}」的工作目录 —— 换一个，或直接在侧栏里用它`);
            return;
          }
          setClaimHint(null);
          if (!report.exists) return;
          if (report.hasBotJson && existing !== null) {
            if (existing.name !== "" && !nameTouchedRef.current) setName(existing.name);
            const role = existing.identity?.role;
            if (role !== undefined && role !== "") setRole((r) => (r.trim() === "" ? role : r));
            const b = existing.bindings.find((x) => x.primary) ?? existing.bindings[0];
            if (b !== undefined && runtimes.some((r) => r.id === b.runtimeId)) {
              setRuntimeId(b.runtimeId);
              setModelHint(b.modelHint ?? null);
            }
            return;
          }
          const derived = report.hasAgentsMd ? report.derived : null;
          if (derived !== null && derived.name !== "" && !nameTouchedRef.current) {
            setName(derived.name);
          }
          if (derived !== null && derived.role !== "") {
            setRole((r) => (r.trim() === "" ? derived.role : r));
          }
        })
        .catch(() => undefined);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, isEdit, rootPath, runtimes]);

  /** 选图 → 居中裁 96×96 → dataURL（webp 优先，浏览器不支持时 toDataURL 自动回退 png） */
  const onAvatarFile = (file: File): void => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 96;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 96, 96);
        const dataUrl = canvas.toDataURL("image/webp", 0.9);
        setAvatar(dataUrl);
        // 换头像即换签名色：画布现成，同步提取候选并自动顶上最优一个
        //（候选行随后展示，用户可再改；提不到鲜明色则保持原值不动）
        const candidates = accentCandidatesFromImageData(ctx.getImageData(0, 0, 96, 96));
        if (candidates.length > 0) setThemeAccent(candidates[0]!);
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  /** hex 输入提交：合法 → 归一成 #rrggbb；清空 → 跟随全局；非法 → 静默回退 */
  const commitAccentDraft = (): void => {
    if (accentHexDraft === null) return;
    const v = accentHexDraft.trim();
    if (v === "") setThemeAccent(null);
    else if (isValidColor(v)) setThemeAccent(toHex(v));
    setAccentHexDraft(null);
  };

  const draft = (): AddBotDraft => {
    const folder = rootPath.trim().replace(/[\\/]+$/u, "");
    return {
      // 零门槛：名字留空时跟随文件夹名——用户唯一必须面对的交互是文件夹本身
      name: name.trim() || folderBasename(folder),
      role: role.trim(),
      avatar: avatar ?? undefined,
      themeAccent: themeAccent ?? undefined,
      rootPath: folder,
      runtimeId,
      modelHint,
      persona: persona.trim(),
      memory,
      // AGENTS.md 可选：留空不写正文，daemon 落盘时静默补最小占位
      agentsMd: agentsMd.trim() === "" ? undefined : agentsMd,
      channels,
      resident,
      autoCollect,
      kind,
      // 搜索分区没动过就不带（调用方据 undefined 跳过 search.configure）
      ...(searchDraft.touched
        ? { search: { provider: searchDraft.provider, apiKey: searchDraft.apiKey.trim() } }
        : {}),
    };
  };

  const submit = async (overwrite = false) => {
    if (saving) return;
    const d = draft();
    if (d.rootPath.length === 0) return setError("选一个文件夹（或接受默认位置）");
    if (d.name.length === 0) return setError("给 bot 起个名字（留空则跟随文件夹名）");
    setSaving(true);
    setError(null);
    try {
      // kind 随主保存一笔写穿（draft.kind → Sidebar 编辑接线 → updateUnit 乐观锁链路），
      // 不做保存后补写——两笔写之间他端改动会被静默覆盖
      await onSubmit(d, overwrite ? { overwrite: true } : undefined);
      // 搜索分区草稿归位（密钥已随调用方的 search.configure 落盘；touched 归零触发分区重拉状态）
      setSearchDraft((prev) => (prev.touched ? { ...prev, apiKey: "", touched: false } : prev));
    } catch (err: unknown) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === BOT_CONFLICT) {
        // 盘上已被改过，daemon 没写。这里**不做任何重试**——让用户决定谁赢。
        const reason = String((err as { data?: { reason?: unknown } }).data?.reason ?? "");
        setConflict({ reason });
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  /** 重拉盘上定义（用户在 VS Code 改完 AGENTS.md 后的那一下）。daemon 无缓存，每次重扫盘。 */
  const reloadFromDisk = async () => {
    if (initial === undefined || initial === null) return;
    try {
      const fresh = await useWorkbench.getState().reloadUnit(initial.id);
      if (fresh === null) {
        setDiskNote("盘上找不到这个 bot 的定义了（bot.json 可能被删了）");
        return;
      }
      fillFrom(fresh);
      setConflict(null);
      setError(null);
      setDiskNote(null);
    } catch (err: unknown) {
      setDiskNote(`重新加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!open) return null;

  // 分区导航（弹窗竖排 / 嵌入右栏横排 chips 共用同一组定义）。
  // 新建与编辑同一套分区（2026-10-23 页面合并）：不适合新建态的功能（技能管理/
  // 会话导入）以「新建适配形态」呈现——分区可见，正文换成说明卡而不是直接隐藏。
  const navItems: readonly { id: Section; label: string; icon: LucideIcon; hint: string; hintNew?: string }[] = [
    ...SECTIONS,
    { id: "skills", label: "工作区技能", icon: Package, hint: "本目录技能置顶与停用", hintNew: "创建时自动播种官方技能" },
    { id: "importSessions", label: "导入会话", icon: Download, hint: "收入外部终端跑的 CLI 会话", hintNew: "创建后可用" },
  ];
  const visibleNavItems = navItems;
  const navBtn = (it: { id: Section; label: string; icon: LucideIcon; hint: string; hintNew?: string }): ReactElement => {
    const active = section === it.id;
    const Icon = it.icon;
    return embedded ? (
      <button
        key={it.id}
        onClick={() => setSection(it.id)}
        aria-current={active}
        title={isEdit || it.hintNew === undefined ? it.hint : it.hintNew}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-chip border px-2 py-1 text-caption transition",
          active ? "border-teal bg-teal-tint font-medium text-ink" : "border-line text-graphite hover:bg-line-soft hover:text-ink",
        )}
      >
        <Icon size={12} className={active ? "text-teal" : "text-ash"} />
        <span className="truncate">{it.label}</span>
      </button>
    ) : (
      <button
        key={it.id}
        onClick={() => setSection(it.id)}
        aria-current={active}
        className={cn(
          "flex items-start gap-2 rounded-btn px-2 py-2 text-left",
          active ? "bg-teal-tint" : "hover:bg-line-soft",
        )}
      >
        <Icon size={13} className={cn("mt-0.5 shrink-0", active ? "text-teal" : "text-ash")} />
        <span className="min-w-0">
          <span
            className={cn("block truncate text-body-sm", active ? "font-medium text-ink" : "text-graphite")}
            title={isEdit || it.hintNew === undefined ? it.hint : it.hintNew}
          >
            {it.label}
          </span>
        </span>
      </button>
    );
  };
  const navArea = embedded ? (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-rail px-2 py-1.5">
      {visibleNavItems.map(navBtn)}
    </div>
  ) : (
    <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line bg-rail p-2">
      {visibleNavItems.map(navBtn)}
    </nav>
  );

  // 内容区（分区主体）：弹窗与嵌入共用，classes 在两种父布局下都成立
  const contentArea = (
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {section === "identity" && (
              <div className="space-y-4">
                {/* 工作目录放第一行（必填，主题色星标）：bot 的本体是文件夹，
                    目录定了名字才有跟随来源；先选目录，名称自动跟随文件夹名 */}
                <Field
                  label="工作目录"
                  required
                  hint={
                    isEdit
                      ? "必填。这个 bot 的根文件夹（AGENTS.md 与产出都放这里）。编辑时目录必须已存在——改成不存在的路径会报错"
                      : "必填。这个 bot 的根文件夹（AGENTS.md 与产出都放这里）。不动就是自动安置；指向已有文件夹即为认领（原地注册、不覆盖里面的文件），不存在的路径会自动创建"
                  }
                >
                  <FolderPickerField
                    value={rootPath}
                    onChange={(v) => {
                      rootPathTouchedRef.current = true;
                      setRootPath(v);
                      // 名字默认跟随文件夹名（新建且用户没亲手改过名字时）
                      if (!isEdit && !nameTouchedRef.current) setName(folderBasename(v));
                    }}
                    browseRoots={browseRoots}
                    ariaLabel="工作目录"
                    trailing={
                      <button
                        type="button"
                        onClick={async () => {
                          if (!rootPath.trim()) return;
                          try {
                            await openFolder({ path: rootPath.trim() });
                            setFolderOpened(true);
                            setTimeout(() => setFolderOpened(false), 2000);
                          } catch (err) {
                            console.error("[AddBotDialog] 打开文件夹失败:", err);
                          }
                        }}
                        disabled={!rootPath.trim()}
                        title="在文件资源管理器中打开"
                        className="flex shrink-0 items-center gap-1 rounded-btn border border-line bg-canvas px-2.5 py-1.5 text-caption font-medium text-graphite hover:bg-line-soft hover:text-ink active:scale-95 transition disabled:opacity-40"
                      >
                        {folderOpened ? <Check size={12} className="text-gain" /> : <FolderOpen size={12} />}
                        <span>{folderOpened ? "已打开" : "打开"}</span>
                      </button>
                    }
                  />
                </Field>
                {!isEdit && claimHint !== null && (
                  <p className="-mt-3 text-caption text-loss">{claimHint}</p>
                )}
                <Field label="名称" hint="名字决定头像的颜色与形状；留空则跟随文件夹名">
                  <input
                    value={name}
                    onChange={(e) => {
                      nameTouchedRef.current = true;
                      setName(e.target.value);
                    }}
                    placeholder="例如：竞品分析师"
                    className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                </Field>
                <Field label="一句话角色" hint="做什么，一句话讲清（可留空后补）">
                  <input
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="例如：每天跟踪竞品动态并产出对比简报"
                    className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                </Field>
                <Field label="头像" hint="可选，上传后居中裁成方形；外框形态跟随外观设置的「bot 头像框形态」">
                  <div className="flex items-center gap-3">
                    {avatar ? (
                      <img
                        src={avatar}
                        alt="bot 头像预览"
                        className="h-12 w-12 shrink-0 rounded-full object-cover"
                      />
                    ) : (
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-line-soft text-body-sm font-medium text-graphite">
                        {name.trim().slice(0, 1) || "?"}
                      </span>
                    )}
                    <div className="flex items-center gap-1.5">
                      <label className="flex cursor-pointer items-center gap-1 rounded-btn border border-line bg-canvas px-2.5 py-1.5 text-caption font-medium text-graphite transition hover:bg-line-soft hover:text-ink">
                        <ImagePlus size={12} />
                        <span>{avatar ? "更换图片" : "选择图片"}</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onAvatarFile(f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      {avatar && (
                        <button
                          type="button"
                          onClick={() => setAvatar(null)}
                          className="rounded-btn border border-line px-2.5 py-1.5 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
                        >
                          恢复默认
                        </button>
                      )}
                    </div>
                  </div>
                </Field>
                <Field
                  label="对话主题色"
                  hint="只作用于这个 bot 的对话界面；候选色块从头像自动提取（取鲜明签名色，不是最大面积色），也可手动取色；留空跟随全局主题"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {/* 手动取色：色块包原生 picker（外观设置 ColorField 同款）；未设值时显示「全局」占位 */}
                    <label
                      className="relative h-8 w-8 shrink-0 overflow-hidden rounded-btn border border-dashed border-line"
                      title="自定义颜色（打开取色器）"
                    >
                      <span
                        className="absolute inset-0"
                        style={themeAccent !== null ? { backgroundColor: themeAccent } : undefined}
                      />
                      {themeAccent === null && (
                        <span className="absolute inset-0 flex items-center justify-center text-[10px] text-ash">
                          全局
                        </span>
                      )}
                      <input
                        type="color"
                        value={toHex(themeAccent ?? accentPickerSeed)}
                        onChange={(e) => setThemeAccent(e.target.value)}
                        aria-label="自定义对话主题色"
                        className="absolute inset-0 cursor-pointer opacity-0"
                      />
                    </label>
                    {/* hex 精确输入：draft-on-blur；清空回车 = 跟随全局 */}
                    <input
                      value={accentHexDraft ?? themeAccent ?? ""}
                      placeholder="#rrggbb"
                      onChange={(e) => setAccentHexDraft(e.target.value)}
                      onBlur={() => commitAccentDraft()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      spellCheck={false}
                      aria-label="对话主题色色值"
                      className="w-24 shrink-0 rounded-btn border border-line bg-canvas px-2 py-1 text-caption font-mono text-ink outline-none placeholder:text-ash focus:border-teal"
                    />
                    {/* 头像提取候选：点击即用 */}
                    {accentCandidates.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setThemeAccent(c)}
                        title={`使用头像提取色 ${c}`}
                        aria-label={`使用头像提取色 ${c}`}
                        className={cn(
                          "h-8 w-8 shrink-0 rounded-btn border transition active:scale-95",
                          themeAccent === c
                            ? "border-teal ring-2 ring-teal/30"
                            : "border-line hover:border-teal/60",
                        )}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                    {themeAccent !== null && (
                      <button
                        type="button"
                        onClick={() => setThemeAccent(null)}
                        className="rounded-btn border border-line px-2.5 py-1.5 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
                      >
                        跟随全局
                      </button>
                    )}
                  </div>
                  {avatar !== null && accentCandidates.length === 0 && (
                    <p className="mt-1.5 text-caption text-ash">
                      头像里没找到足够鲜明的颜色，可手动取色。
                    </p>
                  )}
                </Field>
                <Field label="默认执行器 (CLI)" hint="这个 bot 主要由哪家 CLI 执行">
                  {runtimes.length === 0 ? (
                    <div className="rounded-input bg-rail px-3 py-2.5">
                      <p className="text-body-sm text-graphite">暂无可用执行器</p>
                      <p className="mt-1 text-caption leading-relaxed text-ash">
                        本地 daemon 没有连上，所以执行器清单是空的。
                      </p>
                    </div>
                  ) : (
                    <select
                      value={runtimeId}
                      onChange={(e) => {
                        const rid = e.target.value;
                        setRuntimeId(rid);
                        setModelHint(runtimes.find((r) => r.id === rid)?.defaultModel ?? null);
                      }}
                      className="w-full rounded-input border border-line bg-canvas px-3 py-2 text-body-sm text-ink outline-none focus:border-teal"
                    >
                      <option value="">未指定（由会话按需选择）</option>
                      {runtimes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.presentation.displayName} {r.testOnly ? "· 测试夹具" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="默认模型（可选）" hint="不指定则跟随该执行器的默认模型">
                  {runtimeId === "" ? (
                    <p className="text-caption text-ash">先选一个主执行器，这里才会列出它支持的模型清单。</p>
                  ) : (
                    <select
                      value={modelHint ?? ""}
                      onChange={(e) => setModelHint(e.target.value === "" ? null : e.target.value)}
                      className="w-full rounded-input border border-line bg-canvas px-3 py-2 text-body-sm text-ink outline-none focus:border-teal"
                    >
                      <option value="">自动（跟随执行器原生默认）</option>
                      {runtimeModelSpecs.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="常驻设置" hint="固定在侧栏顶部，不受普通列表拖拽排序影响">
                  <div className="flex items-center justify-between rounded-input border border-line bg-canvas/40 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Pin size={13} className={resident ? "text-teal fill-teal/20" : "text-ash"} />
                      <span className="text-body-sm font-medium text-ink">固定在侧栏顶部常驻区</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setResident(!resident)}
                      className={cn(
                        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden",
                        resident ? "bg-teal" : "bg-line",
                      )}
                      role="switch"
                      aria-checked={resident}
                      title={resident ? "取消常驻" : "设为常驻"}
                    >
                      <span
                        className={cn(
                          "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-canvas shadow-xs ring-0 transition duration-200 ease-in-out",
                          resident ? "translate-x-4" : "translate-x-0",
                        )}
                      />
                    </button>
                  </div>
                </Field>
                {/* kind 切换（ADR 0011 第 2 条）：弱标签，编辑模式手动标。判据问句
                    风格——产出物是否为软件工件；git 只是文件版本管理，不构成判据。 */}
                {isEdit && (
                  <Field
                    label="单元形态 · 这个文件夹主要用来产出软件吗？"
                    hint="判据是产出物是否为软件工件（代码、diff、PR、构建产物）；只是用 git 管文件不算。这是个弱标签，只影响侧栏视图分组，不改变任何行为"
                  >
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setKind("bot")}
                        aria-pressed={kind === "bot"}
                        className={cn(
                          "flex flex-1 items-center gap-2 rounded-input border px-3 py-2 text-left transition",
                          kind === "bot" ? "border-teal-edge bg-teal-tint/60" : "border-line hover:bg-line-soft",
                        )}
                      >
                        <Bot size={14} className={kind === "bot" ? "text-teal" : "text-ash"} />
                        <span>
                          <span
                            className={cn("block text-body-sm", kind === "bot" ? "font-medium text-ink" : "text-graphite")}
                            title="默认形态：一类事务的专人专事"
                          >
                            不是 · bot（数字员工）
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setKind("project")}
                        aria-pressed={kind === "project"}
                        className={cn(
                          "flex flex-1 items-center gap-2 rounded-input border px-3 py-2 text-left transition",
                          kind === "project" ? "border-teal-edge bg-teal-tint/60" : "border-line hover:bg-line-soft",
                        )}
                      >
                        <Package size={14} className={kind === "project" ? "text-teal" : "text-ash"} />
                        <span>
                          <span
                            className={cn("block text-body-sm", kind === "project" ? "font-medium text-ink" : "text-graphite")}
                            title="按开发项目消费：源代码管理、提交图"
                          >
                            是 · 项目
                          </span>
                        </span>
                      </button>
                    </div>
                  </Field>
                )}

                {/* 工作区生命周期（2026-10-23 自「上下文与文件」移入身份分区）：
                    补充工作区配置与注销 Bot 是 bot 的大设置，不该混在注入清单里 */}
                {isEdit && initial && <WorkspaceInitAndUnregisterBar unit={initial} />}
              </div>
            )}

            {section === "context" && isEdit && initial && (
              <div className="h-full min-h-0 overflow-y-auto pr-1">
                <UnitContextEditor unitId={String(initial.id)} />
              </div>
            )}

            {section === "skills" && isEdit && initial && (
              <div className="h-full min-h-0 overflow-y-auto pr-1">
                <WorkspaceSkillsEditor unit={initial} />
              </div>
            )}

            {/* 工作区技能 · 新建适配形态（2026-10-23 页面合并）：还没有工作区，
                管理器换成说明卡——告诉用户创建那一刻会自动得到什么 */}
            {section === "skills" && !isEdit && (
              <div className="space-y-3">
                <div>
                  <h2
                    className="text-body-sm font-medium text-ink"
                    title="不需要任何操作，落盘即生效（.agents/skills/ 规范位，全执行器可发现）。创建后可回到这个分区管理：置顶排序（bot.json pinnedSkills）、停用（.disabled/ 搬运）。"
                  >
                    创建时自动播种的官方基础技能
                  </h2>
                </div>
                <ul className="space-y-1.5 rounded-card border border-line bg-rail/40 p-3 text-caption leading-relaxed">
                  <li>
                    <span className="font-medium text-ink">agent-workbench</span>
                    <span className="text-ash"> —— 驾驶这台工作台：aw CLI 全操作面（会话 / 待办 / git / 通知 / 出图），发现不背诵</span>
                  </li>
                  <li>
                    <span className="font-medium text-ink">workbench-context</span>
                    <span className="text-ash"> —— 检索本工作区记忆：MEMORY.md / memory/daily / STANDING.md 按需查阅</span>
                  </li>
                </ul>
              </div>
            )}

            {section === "context" && !isEdit && (
              <div className="space-y-5">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p
                        className="text-body-sm font-medium text-ink"
                        title="保存时物化为文件夹根目录的 SOUL.md。默认 Bare（0 注入），创建后可在设置中按需打开"
                      >
                        SOUL.md · 人设与语气
                      </p>
                    </div>
                    {!personaTouched && (
                      <button
                        type="button"
                        onClick={() => {
                          setPersonaTouched(true);
                          setPersona(PERSONA_TEMPLATE(name, role));
                        }}
                        className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink transition"
                      >
                        <Wand2 size={10} />
                        按名称角色生成人设
                      </button>
                    )}
                  </div>
                  <textarea
                    value={persona}
                    onChange={(e) => {
                      setPersonaTouched(true);
                      setPersona(e.target.value);
                    }}
                    spellCheck={false}
                    rows={5}
                    aria-label="soul.md 人设与语气"
                    placeholder="留空则使用默认语气：简洁、务实、结论先行。"
                    className="w-full resize-y rounded-card border border-line bg-canvas p-3 font-mono text-caption leading-relaxed text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                </div>

                <div className="space-y-1.5 border-t border-line-soft pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p
                        className="text-body-sm font-medium text-ink"
                        title="bot 的规矩与交付规范。执行器通常原生读取；留空保存时生成最小占位"
                      >
                        AGENTS.md · 岗位说明书
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {SECTION_LIBRARY.map((s) => (
                        <button
                          key={s.label}
                          type="button"
                          onClick={() => {
                            setAgentsMd((md) => `${md.trimEnd()}\n\n${s.snippet(name || "这个 bot")}`);
                          }}
                          title={`插入「${s.label}」段落`}
                          className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
                        >
                          <Plus size={9} />
                          {s.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          setAgentsMd(agentsMdTemplate(name, role, rootPath));
                        }}
                        title="按名称与角色生成完整模板"
                        className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
                      >
                        <Wand2 size={9} />
                        生成模板
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={agentsMd}
                    onChange={(e) => {
                      setAgentsMd(e.target.value);
                    }}
                    spellCheck={false}
                    rows={6}
                    aria-label="AGENTS.md 内容"
                    placeholder={"可选。这是 bot 的规矩文件，想清楚要它遵守什么时再回来补；\n留空保存时会在 bot 文件夹里生成一份最小占位 AGENTS.md。"}
                    className="w-full resize-y rounded-card border border-line bg-canvas p-3 font-mono text-caption leading-relaxed text-ink outline-none placeholder:text-ash focus:border-teal"
                  />
                </div>
              </div>
            )}

            {section === "channels" && (
              <ChannelSection
                botId={initial?.id ?? ""}
                channels={channels}
                onChange={setChannels}
                disabled={!isEdit}
              />
            )}

            {/* 搜索（bot 级）：新建与编辑同一套表单——草稿随保存生效，
                编辑模式多拉一份已存状态（掩码 + 余量） */}
            {section === "search" && (
              <SearchSection
                botId={isEdit && initial ? String(initial.id) : null}
                draft={searchDraft}
                onDraftChange={setSearchDraft}
              />
            )}

            {/* 导入外部会话（收进滚动容器，2026-10-23 重构：原版挂在容器外，
                布局上是 flex 行的第二个子项——归拢后统一进 contentArea） */}
            {section === "importSessions" && isEdit && (
            <div className="space-y-3">
              <div>
                <h2 className="text-body-sm font-medium text-ink">导入外部会话</h2>
                <p className="mt-0.5 text-caption text-ash">
                  工作目录：<span className="font-mono">{rootPath || "（未设置）"}</span>
                </p>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-input border border-line bg-canvas/40 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Radar size={13} className={autoCollect ? "text-teal" : "text-ash"} />
                  <div>
                    <p className="text-body-sm font-medium text-ink">自动收录这个目录的外部会话</p>
                    <p className="text-caption text-ash">
                      在任意终端用 CLI 在此目录跑过的会话自动进侧栏（约 30 秒内，含历史会话）
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoCollect(!autoCollect)}
                  className={cn(
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden",
                    autoCollect ? "bg-teal" : "bg-line",
                  )}
                  role="switch"
                  aria-checked={autoCollect}
                  title={autoCollect ? "关闭自动收录（手动导入仍可用）" : "开启自动收录"}
                >
                  <span
                    className={cn(
                      "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-canvas shadow-xs ring-0 transition duration-200 ease-in-out",
                      autoCollect ? "translate-x-4" : "translate-x-0",
                    )}
                  />
                </button>
              </div>
              {rootPath ? (
                <ImportSessionsSection unitId={String(initial!.id)} />
              ) : (
                <p className="text-caption text-ash">先在「身份」里设置工作目录 —— 外部会话按它匹配。</p>
              )}
            </div>
          )}

            {/* 导入会话 · 新建适配形态（2026-10-23 页面合并）：bot 还没落盘，
                没有可挂账的会话台账——说明卡告知创建后可用 */}
            {section === "importSessions" && !isEdit && (
              <div className="space-y-3">
                <div>
                  <h2 className="text-body-sm font-medium text-ink" title="创建后可用">
                    导入外部会话
                  </h2>
                </div>
                <p className="rounded-card border border-line bg-rail/40 p-3 text-caption leading-relaxed text-ash">
                  把在工作台外、直接用 CLI 在这个工作目录里跑过的会话收进历史台账。
                  bot 创建后回到这个分区，按工作目录匹配导入。
                </p>
              </div>
            )}
    </div>
  );

  // 底部（冲突三选一 / 错误提示 / 取消·保存）：两种形态原样共用
  const footerArea = (
        <div className="flex min-h-12 shrink-0 items-center gap-3 border-t border-line px-4 py-2">
          {conflict !== null ? (
            <>
              {/* 冲突态整条换掉提示语：此刻最重要的信息是"你没写进去"，不是"保存" */}
              <p className="min-w-0 flex-1 text-caption text-loss">
                磁盘上的 {conflict.reason === "agents_md" ? "AGENTS.md" : conflict.reason === "soul_md" ? "SOUL.md" : "bot.json"} 在你编辑期间被改过
                （多半是在 VS Code 里直接编辑了）。<span className="font-medium">这次没有写入。</span>
              </p>              <div className="flex shrink-0 flex-nowrap items-center gap-2">
                <button
                  onClick={() => void reloadFromDisk()}
                  className="shrink-0 whitespace-nowrap rounded-btn border border-line px-3 py-1.5 text-body-sm text-ink hover:bg-line-soft"
                >
                  重新加载
                </button>
                <button
                  onClick={() => void submit(true)}
                  className="shrink-0 whitespace-nowrap rounded-btn px-3 py-1.5 text-body-sm text-loss hover:bg-loss/10"
                  title="用这里的版本覆盖磁盘上的改动"
                >
                  仍然覆盖
                </button>
                <button
                  onClick={() => setConflict(null)}
                  className="shrink-0 whitespace-nowrap rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition"
                >
                  取消
                </button>
              </div>
            </>
          ) : (
            <>
              {error ? (
                <p className="text-caption text-loss">{error}</p>
              ) : diskNote !== null ? (
                <p className="text-caption text-loss">{diskNote}</p>
              ) : runtimes.length === 0 ? (
                <p className="text-caption text-ash">
                  未连接 daemon，这个 bot 会先以「无执行器」保存 —— 之后可在设置里补
                </p>
              ) : (
              <p className="text-caption text-ash">
                {isEdit
                  ? "保存写穿到 bot.json 与工作目录下的 AGENTS.md"
                  : "唯一必填的是文件夹；指向已有文件夹即为认领（原地注册，不动里面的文件），创建后的一切都在这个文件夹里，名字、人设、AGENTS.md、渠道都可以后补"}
              </p>
              )}
              {/* 按钮组强制横排（shrink-0 + nowrap）：右栏嵌入形态宽度有限，
                  此前提示文案会把按钮挤到竖排文字（一个字一行），宁可文案自己折行 */}
              <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
                <button onClick={onClose} className="shrink-0 whitespace-nowrap rounded-btn px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink">
                  取消
                </button>
                <button
                  onClick={() => void submit(false)}
                  disabled={saving}
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:opacity-90 active:scale-95 disabled:opacity-50 transition"
                >
                  {isEdit ? <Check size={11} /> : <Plus size={11} />}
                  {saving ? "写入中…" : isEdit ? "保存" : "创建 bot"}
                </button>
              </div>
            </>
          )}
        </div>
  );

  if (embedded) {
    // 嵌入右栏（bot 设置归拢，2026-10-23）：tab 条即标题，导航横排，内容+底部纵向铺满
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-card">
        {navArea}
        <div className="flex min-h-0 flex-1 flex-col">{contentArea}</div>
        {footerArea}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "bot 设置" : "新建 bot"}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[620px] max-h-[92vh] w-[920px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        {/* 头部 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <FileText size={14} className="text-graphite" />
          <p className="text-body-sm font-medium text-ink">{isEdit ? "bot 设置" : "新建 bot"}</p>
          {isEdit && initial && <UnitContextBadge unit={initial} />}
          <div className="flex-1" />
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {navArea}
          {contentArea}
        </div>

        {footerArea}
      </div>
    </div>
  );
}

function MemoryToggle({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className={cn(
        "flex w-full items-center gap-3 rounded-card border px-3 py-2.5 text-left",
        checked ? "border-teal-edge bg-teal-tint/60" : "border-line hover:bg-line-soft",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body-sm font-medium text-ink" title={desc}>
          {label}
        </span>
      </span>
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-teal" : "bg-line",
        )}
        aria-hidden
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-canvas transition-[left]",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-caption font-medium text-graphite" title={hint}>
        {label}
        {required && (
          <span className="ml-1 text-teal" title="必填">
            *
          </span>
        )}
      </span>
      {children}
    </label>
  );
}
