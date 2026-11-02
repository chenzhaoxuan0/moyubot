/**
 * node-pty 1.1.0 的 npm tarball 把 macOS 的 spawn-helper 打包成了 644（无执行位，
 * 应是上游在 Windows 机器上发包丢了 mode）——macOS 上 node-pty 走 posix_spawn
 * helper 二进制起 PTY，没执行位直接 posix_spawnp failed，终端全灭。
 * Linux 不经 helper、Windows 走 ConPTY，均不受影响。
 *
 * 这里在 install 后就地补执行位：幂等、unix-only、文件不存在静默跳过。
 * build-daemon.mjs 拷贝 node-pty 时会对 daemon-deploy 副本做同样处理（自包含产物）。
 */

import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const ptyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "node-pty");
  const targets = [path.join(ptyRoot, "build", "Release", "spawn-helper")];
  const prebuildsDir = path.join(ptyRoot, "prebuilds");
  if (existsSync(prebuildsDir)) {
    for (const plat of readdirSync(prebuildsDir)) {
      if (plat.startsWith("darwin")) targets.push(path.join(prebuildsDir, plat, "spawn-helper"));
    }
  }
  for (const p of targets) {
    if (existsSync(p)) {
      try {
        chmodSync(p, 0o755);
        console.log(`[fix-node-pty-helper] chmod +x ${path.relative(ptyRoot, p)}`);
      } catch (err) {
        console.warn(`[fix-node-pty-helper] chmod 失败（忽略，可能是挂载权限）: ${p}`, err?.message ?? err);
      }
    }
  }
}
