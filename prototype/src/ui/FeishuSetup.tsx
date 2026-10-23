/**
 * 飞书绑定向导 —— 把「配一个飞书机器人给这个 bot」这条链路做成有位置、有下一步的流程。
 *
 * ## 为什么原来那个输入框不算流程
 *
 * 原来是「一个 profile 输入框 + 一行 hint 让用户自己去终端查」。而这条链路实际要走：
 *
 *   1. 本机装没装 lark-cli
 *   2. 有没有可用的飞书机器人（= 有没有 lark-cli profile）
 *   3. 挑一个绑到这个 bot
 *   4. 去飞书开放平台开机器人能力 + 事件订阅
 *
 * 每一步都可能卡住，而且卡住的原因各不相同。给一个输入框，用户看到的是「我不知道
 * 我卡在哪」。所以这里做的是 **checklist**：任何时刻都能一眼看出还差什么。
 *
 * ## 不假装能做的事
 *
 * 第 4 步（开放平台的开关）**CLI 查不到**。这里如实标成「要你去确认」，并且
 * **不给勾选框**——用户勾了不代表真开了，那是假的安全感。这条雷线跟危险声明卡
 * 是同一条：查不到就明说查不到。
 *
 * ## 一条实测出来的坑
 *
 * `lark-cli profile add` **不做任何校验**：填一个不存在的 App ID 和一个假 Secret，
 * 它照样返回 "OK: Profile added" 并写进配置（实测过）。所以「创建成功」**不等于**
 * 「机器人能用」。后端因此在写入后立刻认一次脸并把结果一起返回，界面没有机会只
 * 显示一句「创建成功」就让人以为完事了。
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Circle,
  ExternalLink,
  HelpCircle,
  Loader2,
  Plus,
  RotateCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  createLarkProfile,
  fetchLarkProfiles,
  type LarkProfileAddResult,
  type LarkProfileEntry,
  type LarkProfileList,
} from "../adapters/daemon/client.ts";
import type { ChannelAccount } from "../core/units.ts";
import { feishuProfilesOf, useWorkbench } from "../store/useWorkbench.ts";
import { ChannelMark } from "./ChannelMark.tsx";
import { cn } from "./cn.ts";

/** 开放平台：飞书版和 Lark 国际版两个域名，别让用户猜 */
const CONSOLE_URLS = [
  { href: "https://open.feishu.cn/app", label: "open.feishu.cn" },
  { href: "https://open.larksuite.com/app", label: "open.larksuite.com" },
] as const;

type StepState = "done" | "todo" | "blocked" | "manual";

export function FeishuSetup({
  botId,
  account,
  onChange,
}: {
  botId: string;
  account: ChannelAccount;
  onChange: (next: ChannelAccount) => void;
}) {
  const bound = (account.profile ?? "").trim();
  const [list, setList] = useState<LarkProfileList | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"pick" | "create">("pick");
  // 订阅 units：一个机器人被别的 bot 绑着时要说出来，所以这里必须跟着 units 变
  const units = useWorkbench((s) => s.units);

  /** 这个 profile 已经绑给哪些别的 bot 了。避免「一个机器人悄悄服务三个 bot」 */
  const ownersOf = (profile: string): readonly string[] =>
    units.filter((u) => u.id !== botId && feishuProfilesOf(u).includes(profile)).map((u) => u.name);

  // 展开即加载：用户进来看的第一眼就该是「本机有哪些机器人」，不是空表单
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const next = await fetchLarkProfiles();
      setList(next);
      // 绑的 profile 要是已经从本机消失了，那是个要摆到台面上的事实
      if (next.available && bound !== "" && !next.profiles.some((p) => p.name === bound)) {
        setMode("pick");
      }
    } catch (err: unknown) {
      setList({ available: false, version: "", detail: err instanceof Error ? err.message : String(err), profiles: [] });
    } finally {
      setLoading(false);
    }
  }

  const pick = (name: string) => {
    onChange({ ...account, profile: name });
    setMode("pick");
  };

  const envState: StepState = list === null ? "todo" : !list.available ? "blocked" : "done";
  const robotState: StepState =
    list === null
      ? "todo"
      : !list.available
        ? "blocked"
        : list.profiles.length === 0
          ? "todo"
          : "done";
  const boundEntry = list?.profiles.find((p) => p.name === bound) ?? null;
  // 提成常量：直接用 boundEntry.identity 的话 TS 在 JSX 闭包里收不住 null
  const boundIdentity = boundEntry?.identity ?? null;
  /** 已经绑上的那个不进「可选列表」——下面的身份卡已经在讲它了 */
  const others = (list?.profiles ?? []).filter((p) => p.name !== bound);

  return (
    <div className="space-y-2.5">
      <Checklist
        items={[
          {
            state: envState,
            title: "本机有 lark-cli",
            note: list === null ? "" : !list.available ? list.detail : list.version,
          },
          {
            state: robotState,
            title: "有可用的飞书机器人",
            note: list?.available === true ? `本机 ${list.profiles.length} 个` : "",
          },
          {
            state: bound === "" ? "todo" : boundEntry === null ? "blocked" : "done",
            title: "绑到这个 bot",
            note: bound === "" ? "还没绑" : boundEntry === null ? `本机找不到「${bound}」了` : (boundEntry.identity.appName || bound),
          },
        ]}
      />

      {/* 第 1 步没过的操作区：装 lark-cli。过了就折叠，只留检测按钮 */}
      {list !== null && !list.available && (
        <Card>
          <p
            className="text-caption text-ink"
            title="agent-workbench 不自己实现飞书客户端——发消息、收事件、操作文档这些都由 lark-cli 做。这里只负责「接在哪个 bot 上」。"
          >
            先装 lark-cli，飞书这一层全靠它
          </p>
          <Copyable cmd="npm i -g @larksuite/cli" />
          <div className="flex items-center gap-2">
            <SmallButton onClick={() => void load()} busy={loading} icon={<RotateCw size={9} />}>
              装好了，再检测一次
            </SmallButton>
          </div>
        </Card>
      )}

      {/* 第 2/3 步的操作区：选一个机器人，或建一个新的 */}
      {list?.available === true && (
        <Card>
          <div className="flex items-center gap-1.5">
            <span className="text-caption text-ink">
              {bound === "" ? "挑一个飞书机器人绑给它" : "当前绑的是这个"}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <SmallButton onClick={() => void load()} busy={loading} icon={<RotateCw size={9} />}>
                刷新
              </SmallButton>
              <SmallButton
                onClick={() => setMode(mode === "create" ? "pick" : "create")}
                icon={mode === "create" ? undefined : <Plus size={9} />}
              >
                {mode === "create" ? "返回列表" : "建一个新机器人"}
              </SmallButton>
            </div>
          </div>

          {mode === "create" ? (
            <CreateProfileForm
              onCreated={(r) => {
                void load();
                if (r.identity.ok) pick(r.name);
              }}
            />
          ) : list.profiles.length === 0 ? (
            <EmptyProfiles onCreate={() => setMode("create")} />
          ) : (
            <div className="space-y-1">
              {/* 已经绑上的那个不在这里列——下面的身份卡已经在讲它了，
                  两处显示同一段信息只会让人以为有两台机器 */}
              {others.length === 0 ? (
                <p className="text-[10px] text-ash">
                  本机就这一个机器人，已经绑上了。要让它换一个，先「建一个新机器人」。
                </p>
              ) : (
                others.map((p) => (
                  <ProfileRow
                    key={p.name}
                    entry={p}
                    owners={ownersOf(p.name)}
                    onPick={() => pick(p.name)}
                  />
                ))
              )}
              <p className="text-[10px] text-ash">
                同一个机器人绑给多个 bot 是允许的，但同一条消息它们都会收到 —— 想各管各的，
                就给每个 bot 建一个。
              </p>
            </div>
          )}
        </Card>
      )}

      {/* 绑好之后的确认：它到底是谁 */}
      {boundIdentity !== null && boundIdentity.ok && (
        <div className="flex items-center gap-2 rounded-card border border-line bg-rail/50 px-2 py-1.5">
          <ChannelMark kind="feishu" identity={boundIdentity} label={boundIdentity.appName} className="h-6 w-6 rounded-[4px]" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-caption font-medium text-ink">
              {boundIdentity.appName || "（飞书没给应用名）"}
            </p>
            <p className="truncate font-mono text-[10px] text-ash">
              {boundIdentity.openId === "" ? bound : boundIdentity.openId}
              {boundIdentity.activateStatus === 2 ? " · 飞书侧已启用" : ` · 飞书侧未启用（status=${boundIdentity.activateStatus}）`}
            </p>
          </div>
          <SmallButton icon={<Trash2 size={9} />} onClick={() => onChange({ ...account, profile: "" })}>
            解绑
          </SmallButton>
        </div>
      )}

      {/* 绑的 profile 在本机没了 —— 停用而不是删掉。删掉是你的凭据，不该我替你决定 */}
      {bound !== "" && list?.available === true && boundEntry === null && (
        <div className="rounded-card border border-loss/30 bg-loss/5 px-2 py-1.5">
          <p className="flex items-start gap-1.5 text-[10px] text-loss">
            <AlertTriangle size={9} className="mt-0.5 shrink-0" />
            <span>
              本机 lark-cli 里没有叫「{bound}」的 profile 了（可能用{" "}
              <code className="font-mono">lark-cli profile remove</code> 删过）。绑它不会有任何效果。
            </span>
          </p>
          <div className="mt-1 flex items-center gap-2">
            <SmallButton icon={<Trash2 size={9} />} onClick={() => onChange({ ...account, profile: "" })}>
              解除这个绑定
            </SmallButton>
          </div>
        </div>
      )}

      <ConsoleChecklist />
    </div>
  );
}

function ProfileRow({
  entry,
  owners,
  onPick,
}: {
  entry: LarkProfileEntry;
  owners: readonly string[];
  onPick: () => void;
}) {
  const id = entry.identity;
  return (
    <div className="flex items-center gap-2 rounded-card border border-line px-2 py-1.5">
      <ChannelMark kind="feishu" identity={id} label={id.appName || entry.name} className="h-6 w-6 rounded-[4px]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-caption text-ink">{id.ok ? id.appName || entry.name : entry.name}</p>
        <p className="truncate text-[10px] text-ash">
          {id.ok ? (
            <>
              {id.openId === "" ? entry.name : id.openId}
              {id.activateStatus === 2 ? " · 已启用" : ` · 未启用（status=${id.activateStatus}）`}
              {owners.length > 0 ? ` · 也绑给：${owners.join("、")}` : ""}
            </>
          ) : (
            `认不出这个机器人：${id.detail}`
          )}
        </p>
      </div>
      <SmallButton onClick={onPick} disabled={!id.ok}>
        绑这个
      </SmallButton>
    </div>
  );
}

function EmptyProfiles({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="space-y-1.5">
      <p className="text-caption text-graphite">本机还没有任何飞书机器人。</p>
      <p className="text-[10px] text-ash">
        飞书机器人 = 一个自建应用。CLI 造不出它，得先去开放平台建一个，把 App ID 和
        App Secret 拿回来。
      </p>
      <div>
        <SmallButton onClick={onCreate} icon={<Plus size={9} />}>
          告诉我怎么建
        </SmallButton>
      </div>
    </div>
  );
}

/**
 * 建新机器人：开放平台那三步 + App ID / Secret 录入。
 *
 * ## 凭据边界（用户拍板：可以填，但只转交、不落盘到本仓库）
 *
 * Secret 明文只在两个地方短暂存在：这个 state，以及发往 daemon 的那一次 WS 帧。
 * 它不进 argv、不进日志、不进 bot.json。lark-cli 收到后存进**系统钥匙串**，
 * `~/.lark-cli/config.json` 里只留一个 `{source:"keychain", id:…}` 句柄。
 */
function CreateProfileForm({ onCreated }: { onCreated: (r: LarkProfileAddResult) => void }) {
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setWarn(null);
    try {
      const r = await createLarkProfile({ name: name.trim() || appId.trim(), appId, appSecret });
      // secret 用完立刻从 state 里抹掉。它已经不需要了
      setAppSecret("");
      if (r.ok) {
        setAppId("");
        setName("");
        onCreated(r);
      } else if (r.name !== "" && r.detail.includes("已经有一个叫")) {
        setErr(r.detail);
      } else {
        // 写进去了但认不出机器人：这不是失败，是「半成品」，要如实说
        setWarn(r.detail);
      }
    } catch (e: unknown) {
      setAppSecret("");
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = appId.trim() !== "" && appSecret !== "";

  return (
    <div className="space-y-2">
      <ol className="space-y-1 text-[10px] text-graphite">
        <li>① 开放平台 → 创建<strong className="font-medium text-ink">企业自建应用</strong></li>
        <li>② 「添加应用能力」里开 <strong className="font-medium text-ink">机器人</strong></li>
        <li>
          ③ 「凭证与基础信息」复制 <strong className="font-medium text-ink">App ID</strong> 和{" "}
          <strong className="font-medium text-ink">App Secret</strong>；「事件与回调」里订阅方式选
          <strong className="font-medium text-ink">长连接</strong>，添加事件{" "}
          <code className="font-mono">im.message.receive_v1</code>
        </li>
      </ol>
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-ash">
        <span>开发者后台：</span>
        {CONSOLE_URLS.map((u) => (
          <a
            key={u.href}
            href={u.href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-0.5 text-graphite underline underline-offset-2 hover:text-ink"
          >
            {u.label}
            <ExternalLink size={8} />
          </a>
        ))}
      </div>

      <div className="space-y-1.5 border-t border-line pt-2">
        <Field label="App ID" hint="形如 cli_a94d3ea8b5f99cc0">
          <input
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="cli_xxxxxxxxxxxxxxxx"
            aria-label="App ID"
            className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
          />
        </Field>
        <Field label="App Secret">
          <input
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            type="password"
            spellCheck={false}
            autoComplete="off"
            aria-label="App Secret"
            className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
          />
        </Field>
        <Field label="profile 名（可留空，默认用 App ID）" hint="这是本机 lark-cli 里的称呼，以后绑定也用它">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={appId.trim() === "" ? "cli_xxx" : appId.trim()}
            aria-label="profile 名"
            className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none placeholder:text-ash focus:border-teal"
          />
        </Field>
      </div>

      <div className="rounded-card border border-line bg-rail/40 px-2 py-1.5">
        <p className="flex items-start gap-1.5 text-[10px] text-graphite">
          <ShieldAlert size={9} className="mt-0.5 shrink-0" />
          <span>
            Secret 只交给本机 lark-cli，它存进<strong className="font-medium">系统钥匙串</strong>；
            不进本工作台任何文件、也不进 bot.json。bot.json 事后只留一个 profile 名。
          </span>
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={!ready || busy}
          className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-ink hover:bg-line-soft disabled:opacity-50"
        >
          {busy ? <Loader2 size={9} className="animate-spin" /> : <Plus size={9} />}
          {busy ? "建好并验证中…" : "建好并验证"}
        </button>
        <span className="text-[10px] text-ash">建完会立刻去飞书认一次脸，认得出才算数</span>
      </div>

      {err !== null && <p className="text-[10px] text-loss">{err}</p>}
      {warn !== null && (
        <div className="rounded-card border border-loss/30 bg-loss/5 px-2 py-1.5">
          <p className="flex items-start gap-1.5 text-[10px] text-loss">
            <AlertTriangle size={9} className="mt-0.5 shrink-0" />
            <span>{warn}</span>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 飞书侧必须开的开关。**这三项 CLI 查不到**。
 *
 * 所以这里不给勾选框 —— 勾了不会让任何东西变安全，只会让用户以为自己已经安全了。
 * 如实列出、并把「去哪一页」指出来。查不到就明说查不到。
 */
function ConsoleChecklist() {
  return (
    <div className="rounded-card border border-line bg-rail/40 p-2">
      <p className="flex items-center gap-1.5 text-caption text-ink">
        <HelpCircle size={11} className="text-ash" />
        飞书侧还要你亲自开三项（我查不到）
      </p>
      <ul className="mt-1 space-y-0.5 text-[10px] text-graphite">
        <li>· 机器人能力 —— 开放平台 →「添加应用能力」→ 机器人</li>
        <li>· 事件订阅 —— 「事件与回调」→ 订阅方式选<strong className="font-medium">长连接</strong> → 添加 im.message.receive_v1</li>
        <li>· 权限 —— 「权限管理」开通 im:message.p2p_msg:readonly（否则收不到私聊）</li>
      </ul>
      <p className="mt-1 text-[10px] text-ash">
        CLI 读不到控制台状态，所以这三项我没法替你确认。开完用下面的「测一下连得通不」，
        它能验的那几项会给你结果。
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ 小件 */

function Checklist({ items }: { items: readonly { state: StepState; title: string; note: string }[] }) {
  return (
    <ol className="space-y-1">
      {items.map((it) => (
        <li key={it.title} className="flex items-center gap-1.5 text-caption">
          <StepMark state={it.state} />
          <span className={cn(it.state === "blocked" ? "text-loss" : it.state === "done" ? "text-ink" : "text-graphite")}>
            {it.title}
          </span>
          {/* 不排序号：✓/○ 加标题已经说清状态了，右侧再挂个裸数字反而像在数第几行 */}
          {it.note !== "" && <span className="truncate text-[10px] text-ash">{it.note}</span>}
        </li>
      ))}
    </ol>
  );
}

function StepMark({ state }: { state: StepState }) {
  if (state === "done") return <Check size={11} className="shrink-0 text-teal" />;
  if (state === "blocked") return <AlertTriangle size={11} className="shrink-0 text-loss" />;
  return <Circle size={11} className="shrink-0 text-ash" />;
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="space-y-2 rounded-card border border-line p-2">{children}</div>;
}

function SmallButton({
  children,
  onClick,
  icon,
  busy,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon?: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled === true || busy === true}
      className="flex w-fit items-center gap-1 rounded-btn border border-line px-1.5 py-0.5 text-[10px] text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-50"
    >
      {busy === true ? <Loader2 size={9} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

function Copyable({ cmd }: { cmd: string }) {
  return (
    <div className="rounded-input bg-rail px-2 py-1 font-mono text-[10px] text-ink">
      <span className="select-all">{cmd}</span>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-caption text-graphite">{label}</span>
      {children}
      {hint !== undefined && <span className="block text-[10px] text-ash">{hint}</span>}
    </label>
  );
}
