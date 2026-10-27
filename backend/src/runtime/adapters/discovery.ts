/**
 * 执行器原生技能、子智能体与命令发现（Skills, Subagents & Commands Discovery）。
 *
 * 规范事实源：
 * - Agent Skills 标准（agentskills.io）：`<dir>/<name>/SKILL.md`（含 YAML frontmatter）
 * - Subagents 标准：`<dir>/agents/*.md`（frontmatter: mode="subagent"|"all", description）
 * - Custom Commands 标准：`<dir>/commands/*.md` 或 `<dir>/prompts/*.md`
 * - 各执行器特定目录与兼容目录（如 grok/cursor 兼容 ~/.claude/skills）
 *
 * 性能保证：
 * - 纯轻量文件系统探测（existsSync / readdirSync / readFileSync 仅首部），绝不派生 CLI 子进程；
 * - 错误全面容忍，目录不存在或损坏文件直接跳过，绝不抛出；
 * - 提供通用去重合并（重名时：项目级 > 用户级，技能/子智能体优先于宽泛命令分类）。
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { NativeCommandInfo } from "../../contract.ts";

export interface FrontmatterResult {
  readonly name?: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly mode?: string;
  readonly cliVisible?: boolean;
  readonly userInvocable?: boolean;
}

/**
 * 快速解析 YAML frontmatter（仅前 4KB，不引入庞大依赖，毫秒级完成）。
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  const head = raw.slice(0, 4096);
  if (!head.startsWith("---\n") && !head.startsWith("---\r\n")) return {};
  const end = head.indexOf("\n---", 4);
  if (end === -1) return {};

  const lines = head.slice(head.indexOf("\n") + 1, end).split(/\r?\n/);
  const out: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (value !== "") out[key] = value;
  }

  const cliVisible =
    out["clivisible"] !== undefined
      ? out["clivisible"] !== "false"
      : out["surfaces"] !== undefined
        ? out["surfaces"].toLowerCase().includes("cli")
        : true;

  const userInvocable =
    out["user-invocable"] !== undefined
      ? out["user-invocable"] !== "false"
      : out["userinvocable"] !== undefined
        ? out["userinvocable"] !== "false"
        : true;

  return {
    name: out["name"],
    description: out["description"],
    argumentHint: out["argument-hint"] ?? out["argumenthint"],
    mode: out["mode"]?.toLowerCase(),
    cliVisible,
    userInvocable,
  };
}

/**
 * 扫描指定目录下的技能（`SKILL.md` 规范）。
 * 支持两级形态：
 * 1. `<dir>/<skillName>/SKILL.md`（标准包形态，如 `.agents/skills/deploy/SKILL.md`）
 * 2. `<dir>/SKILL.md`（单技能根目录形态，如插件私有技能目录）
 */
export function discoverSkillsInDir(
  dir: string,
  source: "user" | "project" | "plugin",
): NativeCommandInfo[] {
  if (!existsSync(dir)) return [];
  const out: NativeCommandInfo[] = [];

  // 单技能形态：dir 直接就是技能目录
  const directSkillFile = join(dir, "SKILL.md");
  if (existsSync(directSkillFile)) {
    try {
      const raw = readFileSync(directSkillFile, "utf8");
      const fm = parseFrontmatter(raw);
      if (fm.cliVisible !== false && fm.userInvocable !== false) {
        const fallback = basename(dir).toLowerCase() === "skills" ? basename(dirname(dir)) : basename(dir);
        const name = fm.name && fm.name !== "" ? fm.name : fallback;
        out.push({
          name,
          description: fm.description,
          source,
          kind: "skill",
        });
        return out;
      }
    } catch {
      // ignore read error
    }
  }

  // 标准目录形态：dir 下包含若干技能子目录（兼容普通目录与符号链接/Junction）
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const sub of entries) {
    if (sub.startsWith(".")) continue;
    const skillPath = join(dir, sub, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    try {
      const raw = readFileSync(skillPath, "utf8");
      const fm = parseFrontmatter(raw);
      if (fm.cliVisible === false || fm.userInvocable === false) continue;
      const name = fm.name && fm.name !== "" ? fm.name : sub;
      out.push({
        name,
        description: fm.description,
        source,
        kind: "skill",
      });
    } catch {
      continue;
    }
  }

  return out;
}

/**
 * 递归扫描的点目录防线：相对路径中任何一段以 `.` 开头（如 `.disabled/x.md`、
 * `.git/hooks.md`）都不算内容。技能的停用载体 `.disabled/` 只进 skills 目录，
 * 但 agents/commands 目录同样递归 —— 不滤点目录的话，被搬进 `.disabled/` 的
 * 子智能体会从这里泄漏回斜杠菜单（技能侧一层扫描天然不命中，此处的两层防线）。
 */
export function hasDotSegment(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => seg.startsWith("."));
}

/**
 * 枚举目录下全部 `*.md`（相对路径，**不进入**点目录与 node_modules）。
 * 取代 `readdirSync(dir, { recursive: true })` + 事后 hasDotSegment 过滤：
 * recursive 枚举会先钻进 node_modules/.git 把里面所有条目都列一遍再丢弃——
 * bot 根目录里一个 node_modules 就是数万条目，命令面板预热曾因此把主循环
 * 卡出 23 秒 loop-stall（实测 2026-10-27）。栈式遍历在进入前剪枝。
 */
export function listMarkdownFilesPruned(dir: string, limit = 2000): string[] {
  const out: string[] = [];
  const skip = (name: string): boolean => name.startsWith(".") || name === "node_modules";
  const walk = (d: string, prefix: string): void => {
    if (out.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) {
        if (skip(e.name)) continue;
        walk(join(d, e.name), rel);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        out.push(rel);
      }
    }
  };
  walk(dir, "");
  return out;
}

/**
 * 扫描指定目录下的子智能体（`*.md` 规范）。
 * 过滤掉 primary 模式（主对话形态），只保留子智能体形态。
 */
export function discoverAgentsInDir(
  dir: string,
  source: "user" | "project" | "plugin",
): NativeCommandInfo[] {
  if (!existsSync(dir)) return [];
  const files = listMarkdownFilesPruned(dir);

  const out: NativeCommandInfo[] = [];
  for (const rel of files) {
    const base = basename(rel);
    // 忽略文档与技能文件
    if (/^(readme|skill|index|license)\.md$/i.test(base)) continue;
    const defaultName = base.replace(/\.md$/i, "");
    if (defaultName === "") continue;

    const fullPath = join(dir, rel);
    try {
      const raw = readFileSync(fullPath, "utf8");
      const fm = parseFrontmatter(raw);
      // 如果声明了 mode 且不是 subagent/all（如 primary），则不作为斜杠子智能体展示
      if (fm.mode !== undefined && fm.mode !== "subagent" && fm.mode !== "all") continue;
      if (fm.cliVisible === false) continue;

      const name = fm.name && fm.name !== "" ? fm.name : defaultName;
      out.push({
        name,
        description: fm.description,
        source,
        kind: "agent",
      });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * 扫描指定目录下的自定义斜杠命令（`*.md` 规范，如 `.claude/commands` 或 `.opencode/command`）。
 */
export function discoverCommandsInDir(
  dir: string,
  source: "user" | "project" | "plugin",
): NativeCommandInfo[] {
  if (!existsSync(dir)) return [];
  const files = listMarkdownFilesPruned(dir);

  const out: NativeCommandInfo[] = [];
  for (const rel of files) {
    const base = basename(rel);
    if (/^(readme|skill|index|license)\.md$/i.test(base)) continue;
    const defaultName = base.replace(/\.md$/i, "");
    if (defaultName === "") continue;

    const fullPath = join(dir, rel);
    try {
      const raw = readFileSync(fullPath, "utf8");
      const fm = parseFrontmatter(raw);
      if (fm.cliVisible === false) continue;

      const name = fm.name && fm.name !== "" ? fm.name : defaultName;
      out.push({
        name,
        description: fm.description,
        argumentHint: fm.argumentHint,
        source,
        kind: "command",
      });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * 跨执行器统一去重合并策略：
 * 1. 同名条目规范化比较（忽略大小写与空格）；
 * 2. 种类优先级：skill 优先于 command（在斜杠菜单中，技能比普通透传命令分类更明确）；
 * 3. 作用域优先级：项目级（project）覆盖 用户级（user）与插件级（plugin）；
 * 4. 内置命令（builtin）保留，但如果用户或项目定义了同名条目，自定义条目优先。
 */
export function mergeCommandEntries(
  ...lists: readonly (readonly NativeCommandInfo[])[]
): readonly NativeCommandInfo[] {
  const map = new Map<string, NativeCommandInfo>();

  for (const list of lists) {
    for (const item of list) {
      if (!item.name || item.name.trim() === "") continue;
      const key = item.name.trim().toLowerCase();
      const existing = map.get(key);

      if (existing === undefined) {
        map.set(key, item);
        continue;
      }

      // 如果已有的是内置命令，而新来的是自定义技能/智能体/命令 -> 自定义优先
      if (existing.builtin && !item.builtin) {
        map.set(key, item);
        continue;
      }

      // 如果已有的是普通 command，而新来的是明确的 skill 或 agent -> 技能/智能体优先分类
      if ((existing.kind === "command" || existing.kind === undefined) && (item.kind === "skill" || item.kind === "agent")) {
        map.set(key, item);
        continue;
      }

      // 如果已有的是 user/plugin，而新来的是 project -> 项目级配置优先
      if (existing.source !== "project" && item.source === "project") {
        map.set(key, item);
        continue;
      }
    }
  }

  return [...map.values()];
}

/**
 * 扫描标准公共技能与子智能体路径（.agents/ 规范，适用于所有执行器）。
 */
export function readStandardAgentsWorkspace(rootPath: string): {
  skills: NativeCommandInfo[];
  agents: NativeCommandInfo[];
} {
  const userHome = homedir();
  const skills: NativeCommandInfo[] = [
    // 项目级公共技能
    ...discoverSkillsInDir(join(rootPath, ".agents", "skills"), "project"),
    // 用户级公共技能
    ...discoverSkillsInDir(join(userHome, ".agents", "skills"), "user"),
  ];

  const agents: NativeCommandInfo[] = [
    // 项目级公共子智能体
    ...discoverAgentsInDir(join(rootPath, ".agents", "agents"), "project"),
    // 用户级公共子智能体
    ...discoverAgentsInDir(join(userHome, ".agents", "agents"), "user"),
  ];

  return { skills, agents };
}

/**
 * Pi 原生技能与子智能体发现：
 * ~/.pi/agent/skills（含符号链接） + ~/.pi/skills + 项目级 .pi/skills + 标准 .agents 库。
 */
export function discoverPiSkillsAndAgents(rootPath: string): {
  commands: NativeCommandInfo[];
  skills: NativeCommandInfo[];
  agents: NativeCommandInfo[];
} {
  const userHome = homedir();
  const standard = readStandardAgentsWorkspace(rootPath);

  const skills: NativeCommandInfo[] = [
    ...discoverSkillsInDir(join(userHome, ".pi", "agent", "skills"), "user"),
    ...discoverSkillsInDir(join(userHome, ".pi", "skills"), "user"),
    ...discoverSkillsInDir(join(rootPath, ".pi", "skills"), "project"),
    ...standard.skills,
  ];

  const commands: NativeCommandInfo[] = [
    ...discoverCommandsInDir(join(userHome, ".pi", "agent", "commands"), "user"),
    ...discoverCommandsInDir(join(rootPath, ".pi", "commands"), "project"),
  ];

  const agents: NativeCommandInfo[] = [
    ...discoverAgentsInDir(join(userHome, ".pi", "agents"), "user"),
    ...discoverAgentsInDir(join(rootPath, ".pi", "agents"), "project"),
    ...standard.agents,
  ];

  return { commands, skills, agents };
}

/**
 * Cursor 原生技能与子智能体发现：
 * 递归扫描 .cursor/skills, .agents/skills, .codex/skills, .claude/skills 及 rules/agents。
 */
export function discoverCursorSkillsAndAgents(rootPath: string): {
  skills: NativeCommandInfo[];
  agents: NativeCommandInfo[];
} {
  const userHome = homedir();
  const standard = readStandardAgentsWorkspace(rootPath);

  const skills: NativeCommandInfo[] = [
    ...discoverSkillsInDir(join(rootPath, ".cursor", "skills"), "project"),
    ...discoverSkillsInDir(join(userHome, ".cursor", "skills"), "user"),
    ...discoverSkillsInDir(join(rootPath, ".codex", "skills"), "project"),
    ...discoverSkillsInDir(join(userHome, ".codex", "skills"), "user"),
    ...discoverSkillsInDir(join(userHome, ".claude", "skills"), "user"),
    ...standard.skills,
  ];

  const agents: NativeCommandInfo[] = [
    ...discoverAgentsInDir(join(rootPath, ".cursor", "agents"), "project"),
    ...discoverAgentsInDir(join(userHome, ".cursor", "agents"), "user"),
    ...standard.agents,
  ];

  return { skills, agents };
}

/**
 * Antigravity (AGY) 原生技能与子智能体发现：
 * - 内置技能（~/.gemini/antigravity-ide/builtin/skills）
 * - 全局定制技能（~/.gemini/config/skills）
 * - 插件技能与智能体（~/.gemini/config/plugins/<name>/skills 与 agents）
 * - 工作区技能（<root>/.agents/skills 与 <root>/skills）
 * - 工作区智能体（<root>/.agents/agents）
 */
export function discoverAgySkillsAndAgents(rootPath: string): {
  skills: NativeCommandInfo[];
  agents: NativeCommandInfo[];
} {
  const userHome = homedir();
  const standard = readStandardAgentsWorkspace(rootPath);
  const skills: NativeCommandInfo[] = [];
  const agents: NativeCommandInfo[] = [];

  // 内置技能
  const builtinSkillsDir = join(userHome, ".gemini", "antigravity-ide", "builtin", "skills");
  skills.push(...discoverSkillsInDir(builtinSkillsDir, "user"));

  // 全局配置根目录技能
  const globalConfigDir = join(userHome, ".gemini", "config");
  skills.push(...discoverSkillsInDir(join(globalConfigDir, "skills"), "user"));
  agents.push(...discoverAgentsInDir(join(globalConfigDir, "agents"), "user"));

  // 插件技能与智能体
  const pluginsDir = join(globalConfigDir, "plugins");
  if (existsSync(pluginsDir)) {
    try {
      for (const plugin of readdirSync(pluginsDir)) {
        if (plugin.startsWith(".")) continue;
        const pDir = join(pluginsDir, plugin);
        skills.push(...discoverSkillsInDir(join(pDir, "skills"), "plugin"));
        agents.push(...discoverAgentsInDir(join(pDir, "agents"), "plugin"));
      }
    } catch {
      // ignore
    }
  }

  // 工作区私有 skills/
  skills.push(...discoverSkillsInDir(join(rootPath, "skills"), "project"));
  skills.push(...standard.skills);
  agents.push(...standard.agents);

  return { skills, agents };
}

/**
 * Codex 原生技能与子智能体发现：
 * .codex/skills + .agents/skills + .codex/agents。
 */
export function discoverCodexSkillsAndAgents(rootPath: string): {
  skills: NativeCommandInfo[];
  agents: NativeCommandInfo[];
} {
  const userHome = homedir();
  const standard = readStandardAgentsWorkspace(rootPath);

  const skills: NativeCommandInfo[] = [
    ...discoverSkillsInDir(join(rootPath, ".codex", "skills"), "project"),
    ...discoverSkillsInDir(join(userHome, ".codex", "skills"), "user"),
    ...standard.skills,
  ];

  const agents: NativeCommandInfo[] = [
    ...discoverAgentsInDir(join(rootPath, ".codex", "agents"), "project"),
    ...discoverAgentsInDir(join(userHome, ".codex", "agents"), "user"),
    ...standard.agents,
  ];

  return { skills, agents };
}

/**
 * 通用适配器技能与子智能体发现（DSH, Hermes, Kimi, MCode, OpenClaw）：
 * 扫各自的 .<id>/{skills,agents} + 标准公共 .agents 库。
 */
export function discoverGenericToolSkillsAndAgents(
  toolId: string,
  rootPath: string,
): {
  skills: NativeCommandInfo[];
  agents: NativeCommandInfo[];
} {
  const userHome = homedir();
  const standard = readStandardAgentsWorkspace(rootPath);

  const skills: NativeCommandInfo[] = [
    ...discoverSkillsInDir(join(rootPath, `.${toolId}`, "skills"), "project"),
    ...discoverSkillsInDir(join(userHome, `.${toolId}`, "skills"), "user"),
    ...standard.skills,
  ];

  const agents: NativeCommandInfo[] = [
    ...discoverAgentsInDir(join(rootPath, `.${toolId}`, "agents"), "project"),
    ...discoverAgentsInDir(join(userHome, `.${toolId}`, "agents"), "user"),
    ...standard.agents,
  ];

  return { skills, agents };
}
