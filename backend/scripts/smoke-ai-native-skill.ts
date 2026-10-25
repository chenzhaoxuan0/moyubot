/**
 * AI-native P6 验收（docs/21 §2 P6）：工作台技能同步。
 *
 *   自起 daemon → bot.put（createRoot 新建）→ .agents/skills/agent-workbench/SKILL.md
 *   随 initWorkspace 自动播种（版本标记 vN）→ skills.inventory 可见（项目级源）→
 *   workbench.skill.sync 幂等（current，两个官方技能一并返回）→ 无标记的用户自建
 *   同名不被碰（skipped-foreign）→ 旧版本标记 → 升级（updated）→ force 重装 →
 *   无参调用对全部 bot 兜底 → 仓库根自用副本与 daemon 正本零漂移。
 *
 * 用法：cd backend && pnpm smoke:ai-native-skill
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workbenchSkillMd, WORKBENCH_SKILL_VERSION } from "../src/skills/workbenchSkill.ts";
import { contextSkillMd } from "../src/skills/contextSkill.ts";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 冒烟家（隔离 AGENT_WORKBENCH_HOME）：daemon 全部状态住临时目录，绝不碰真实 ~/.agent-workbench */
const smokeHome = mkdtempSync(path.join(os.tmpdir(), "aw-skill-home-"));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("failed to acquire a free port"));
      }
    });
    srv.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

let daemon: ChildProcess | undefined;
const daemonOutput: string[] = [];

function startDaemon(port: number): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOST: "127.0.0.1", AGENT_WORKBENCH_INSECURE: "1", AGENT_WORKBENCH_HOME: smokeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      daemonOutput.push(chunk.toString().trimEnd());
    });
  }
}

async function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return daemon?.exitCode ?? null;
  const exited = new Promise<number | null>((resolve) => {
    daemon?.once("exit", (code) => resolve(code));
  });
  daemon.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(8000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    daemon.kill("SIGKILL");
    return null;
  }
  return code;
}

async function waitHealthy(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon !== undefined && daemon.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  return false;
}

async function rpc<T>(port: number, method: string, params: unknown): Promise<{ ok: boolean; result?: T; error?: { code?: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  return (await res.json()) as { ok: boolean; result?: T; error?: { code?: string } };
}

interface SyncResult {
  rootPath: string;
  path: string;
  status: "written" | "updated" | "current" | "skipped-foreign";
  version: number;
}

async function main(): Promise<void> {
  const port = await freePort();
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port);

  const tmp = mkdtempSync(path.join(os.tmpdir(), "aw-skill-"));
  const botRoot = path.join(tmp, "bot-skill");

  try {
    check("daemon healthy", await waitHealthy(port), daemonOutput);

    // 1. bot init 播种（initWorkspace 内 await，落笔随 bot.put 返回；轮询兜底时序）
    const put = await rpc(port, "bot.put", {
      unit: { id: "u-skill", rootPath: botRoot, name: "Skill Bot", kind: "bot", bindings: [], tags: [], channels: [] },
      createRoot: true,
    });
    check("bot.put createRoot", put.ok === true, put);
    const skillFile = path.join(botRoot, ".agents", "skills", "agent-workbench", "SKILL.md");
    let seeded = false;
    for (let i = 0; i < 25 && !seeded; i++) {
      seeded = existsSync(skillFile);
      if (!seeded) await sleep(200);
    }
    check("skill seeded at bot init", seeded, { skillFile });
    if (seeded) {
      const md = await readFile(skillFile, "utf8");
      check(`skill carries version marker v${WORKBENCH_SKILL_VERSION} + frontmatter`, md.includes(`agent-workbench-skill: v${WORKBENCH_SKILL_VERSION}`) && md.includes("name: agent-workbench") && md.includes("aw methods"), md.slice(0, 120));
    }

    // 2. 技能盘点可见（项目级 .agents/skills 源、启用中）
    const inv = await rpc<{ groups?: Array<{ dir?: string; skills?: Array<{ dirName?: string; disabled?: boolean }> }> }>(port, "skills.inventory", { rootPath: botRoot });
    const flat = (inv.result?.groups ?? []).flatMap((g) => (g.skills ?? []).map((s) => ({ ...s, dir: g.dir })));
    const hit = flat.find((s) => s.dirName === "agent-workbench" && (s.dir ?? "").includes(botRoot));
    check("skills.inventory sees the project-level skill", inv.ok === true && hit !== undefined, flat.map((s) => s.dirName).slice(0, 10));

    // 3. 幂等：再同步 = current（两个官方技能一并返回，agent-workbench 在前）
    const again = await rpc<{ results?: SyncResult[] }>(port, "workbench.skill.sync", { rootPath: botRoot });
    check("re-sync is a no-op (current)", again.ok === true && again.result?.results?.[0]?.status === "current", again);
    check("sync also covers workbench-context (converged base skills)", again.result?.results?.some((r) => r.path.includes("workbench-context") && r.status === "current") === true, again.result?.results);

    // 4. 用户自建同名（无标记）不被碰
    await writeFile(skillFile, "---\nname: agent-workbench\ndescription: 我的私改版\n---\n用户内容\n", "utf8");
    const foreign = await rpc<{ results?: SyncResult[] }>(port, "workbench.skill.sync", { rootPath: botRoot });
    const afterForeign = await readFile(skillFile, "utf8");
    check("unmarked user copy is left alone (skipped-foreign)", foreign.result?.results?.[0]?.status === "skipped-foreign" && afterForeign.includes("用户内容"), foreign);

    // 5. 旧版本标记 → 升级回正本
    await writeFile(skillFile, `<!-- agent-workbench-skill: v0 -->\n旧版内容\n`, "utf8");
    const upgraded = await rpc<{ results?: SyncResult[] }>(port, "workbench.skill.sync", { rootPath: botRoot });
    const afterUpgrade = await readFile(skillFile, "utf8");
    check("stale marker upgrades to canonical", upgraded.result?.results?.[0]?.status === "updated" && afterUpgrade.includes(`agent-workbench-skill: v${WORKBENCH_SKILL_VERSION}`) && afterUpgrade.includes("驾驶你所在的工作台"), upgraded);

    // 6. force 重装（含用户自建场景）
    await writeFile(skillFile, "完全无关的内容\n", "utf8");
    const forced = await rpc<{ results?: SyncResult[] }>(port, "workbench.skill.sync", { rootPath: botRoot, force: true });
    check("force reinstalls the canonical skill", forced.result?.results?.[0]?.status === "updated" && (await readFile(skillFile, "utf8")).includes(`agent-workbench-skill: v${WORKBENCH_SKILL_VERSION}`), forced);

    // 7. 无参调用：对全部 bot 兜底
    const all = await rpc<{ results?: SyncResult[] }>(port, "workbench.skill.sync", null);
    check("no-arg sync sweeps every bot", all.ok === true && (all.result?.results?.length ?? 0) >= 1, all);

    // 8. 正本漂移防线：仓库根的自用副本（dogfood）必须与 daemon 正本逐字节一致——
    //    改任一侧须同步另一侧并升版本，否则这里掀桌
    const repoAgentsDir = path.resolve(backendRoot, "..", ".agents", "skills");
    const repoAw = await readFile(path.join(repoAgentsDir, "agent-workbench", "SKILL.md"), "utf8");
    check("repo-root agent-workbench copy matches daemon canonical (no drift)", repoAw === workbenchSkillMd(), { repo: repoAw.slice(0, 80), canonical: workbenchSkillMd().slice(0, 80) });
    const repoCtx = await readFile(path.join(repoAgentsDir, "workbench-context", "SKILL.md"), "utf8");
    check("repo-root workbench-context copy matches daemon canonical (no drift)", repoCtx === contextSkillMd(), { repo: repoCtx.slice(0, 80), canonical: contextSkillMd().slice(0, 80) });
  } finally {
    await stopDaemon();
  }

  if (failures > 0) {
    console.error(`smoke: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke: all checks passed");
}

await main().catch((err: unknown) => {
  console.error("smoke: crashed", err);
  void stopDaemon();
  process.exit(1);
});
