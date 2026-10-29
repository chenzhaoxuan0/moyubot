/**
 * routing bot —— 常驻合成 bot（对齐 steward / heartbeat 的模式），清单分类的
 * 总管与心跳：
 *
 * - 住在 <homeDir>/routing/（分类会话的工作目录）
 * - AGENTS.md 是它的岗位说明书：分类依据、输出契约、红线。zcode 等执行器在
 *   cwd 原生读 AGENTS.md —— routing agent 的角色设定不靠 prompt 拼接，靠这份文件。
 * - 执行器/模型绑定是**用户数据**（bot 设置页可改），启动引导只补结构不覆盖；
 *   分类器解析执行器的顺序：inbox 配置显式指定 → 本 bot 的主绑定。
 *
 * 定位（2026-10 设计共识）：用户的 context 只从一个通道（清单文本框）进来时，
 * 分类就是枢纽 —— routing bot 承担「写进去的东西各自去该去的地方」：
 * 目标/待办 → GTD 任务列表（auto 直通闲时自动执行）；想法 → 想法库归档；
 * 资料 → 参考留存。它是默认 bot：任何空闲时间它都在推动这张列表往前走。
 */

import { mkdir } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "../log.ts";

export const ROUTING_BOT_ID = "routing";
export const ROUTING_DIRNAME = "routing";

/** routing bot 默认主绑定（与心跳同口径：订阅制 + 有配额探针的执行器最适合） */
export const ROUTING_DEFAULT_RUNTIME_ID = "zcode";

export function routingBotRoot(homeDir: string): string {
  return path.join(homeDir, ROUTING_DIRNAME);
}

const ROUTING_AGENTS_MD = `# Routing

你是 agent-workbench 的 routing bot —— 清单（个人 context 唯一入口）的总管与分类者。

## 你的职责
用户往清单里写任何东西：想法、近期目标、待办、资料、半成品念头。
每条进来的东西，你判断它是什么、该去哪：

- **目标 / 待办**（近期要做、agent 能推进的）→ 沉淀成 GTD 任务，进待办清单，
  agent 会在空闲用量里自动执行。任务要写得可执行：目标一句话说清「做什么、
  产出是什么」，执行 prompt 把验收标准交代明白。
- **想法**（念头、灵感、方向，暂时不需要动作）→ 归入想法库，只归档不执行。
- **资料**（链接、摘录、要留着的东西）→ 归入资料留存。
- **以后再说**（有价值的想法但当下不做的）→ 归入以后再说。

## 分类依据
1. 用户的原话第一：写的是「要做什么」就是任务，写的是「我觉得/我发现」多半是想法
2. 用户预置了字段（bot/执行器/模型/文件夹/会话）就必须尊重，不许改写
3. 拿不准动作性的，归「想法」—— 想法库误收的代价远低于误启动一个任务

## 输出契约（铁律）
只输出一个 JSON 数组，每条输入对应一个元素，不要输出任何其他文字：
[{"id":条目编号,"category":"分类id","title":"一句话短标题","reason":"一句话分类理由",
  "task":{"goal":"可执行的目标原话","prompt":"给执行 agent 的启动提示词","unitId":"bot id 或空","runtimeId":"执行器id 或空","model":null}}]
category 取「任务」时才带 task 字段（unitId/runtimeId/model 拿不准就空/null）。
不要输出 launchMode / targetSessionId / rootPath —— 执行方式由系统统一决定，会话与
目录是用户亲手预置的权限，解析器不收这三个字段。

## 红线
- 你只分类、只沉淀，无权启动任何任务 —— 执行是引擎的事
- 不编造用户没写的约束；建议字段宁缺勿滥
`;

/** 确保目录与 AGENTS.md 就位（幂等；AGENTS.md 是用户数据，存在即不覆盖） */
export async function ensureRoutingBot(homeDir: string): Promise<{ rootPath: string; created: boolean }> {
  const root = routingBotRoot(homeDir);
  await mkdir(root, { recursive: true });
  const agentsMd = path.join(root, "AGENTS.md");
  let created = false;
  if (!existsSync(agentsMd)) {
    writeFileSync(agentsMd, ROUTING_AGENTS_MD, "utf8");
    created = true;
    log.info("routing bot AGENTS.md seeded", { root });
  }
  return { rootPath: root, created };
}

/** routing bot 的定义（放进注册表就能被 listBots / getBot 认出来） */
export function routingBotDefinition(rootPath: string, runtimeId = ROUTING_DEFAULT_RUNTIME_ID): Record<string, unknown> {
  return {
    id: ROUTING_BOT_ID,
    role: ROUTING_BOT_ID,
    // 常驻合成 bot：侧栏常驻区的成员（结构性字段，用户不可移除其常驻身份）
    resident: true,
    // kind / tags 必填：前端合并守卫与渲染直接读它们（steward 踩过的坑）
    kind: "bot",
    name: "Routing",
    rootPath,
    synthetic: true,
    tags: [],
    identity: { sourcePath: "AGENTS.md", role: "清单总管：分类、沉淀任务、归档想法" },
    bindings: [{ runtimeId, primary: true }],
    note: "清单（inbox）分类的总管 bot，兼任心跳定位。AGENTS.md 是它的岗位说明书；改执行器/模型在 bot 设置页换主绑定即可。",
  };
}

/**
 * 定义的规范形状（幂等比较用）——从定义本身派生排除表，不手列字段
 * （steward 两次栽在「加了新字段忘进比较列表」上）。
 */
export function routingBotShape(def: Record<string, unknown>): string {
  const volatile = new Set(["updatedAt", "meta", "$meta", "agentsMd", "agentsMdMeta", "revision", "sourcePath", "identity"]);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(def).sort()) {
    if (volatile.has(k)) continue;
    out[k] = def[k];
  }
  return JSON.stringify(out);
}
