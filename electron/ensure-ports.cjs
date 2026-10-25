const net = require("node:net");
const { execSync } = require("node:child_process");

function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") resolve(true);
      else resolve(false);
    });
    srv.once("listening", () => {
      srv.close(() => resolve(false));
    });
    srv.listen(port, host);
  });
}

function killPid(pid) {
  if (!pid || pid === "0" || Number(pid) === process.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore" });
    } else {
      process.kill(Number(pid), "SIGKILL");
    }
  } catch {
    // 进程可能已在退出中，忽略错误
  }
}

async function freePort(port) {
  const inUse = await isPortInUse(port);
  if (!inUse) return;

  console.log(`[ensure-ports] 端口 ${port} 正被占用，正在回收残留进程以防启动冲突...`);
  if (process.platform === "win32") {
    try {
      const out = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (line.includes(`:${port}`) && line.includes("LISTENING")) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== "0" && Number(pid) !== process.pid) {
            pids.add(pid);
          }
        }
      }
      for (const pid of pids) {
        killPid(pid);
      }
    } catch {
      // 忽略检查异常
    }
  } else {
    try {
      // -sTCP:LISTEN 与 win32 分支的 LISTENING 过滤同款口径：不带它 lsof 会把
      // 「连着这个端口的客户端连接」（浏览器标签页 / Electron 的 WS）也算进来，
      // 双击启动时等于把正在跑的整套栈连同用户浏览器一起 SIGKILL。
      const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: "utf8" });
      for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
        killPid(pid);
      }
    } catch {
      // 忽略检查异常
    }
  }

  // 给操作系统 150ms 释放 socket 状态
  await new Promise((r) => setTimeout(r, 150));
  const stillInUse = await isPortInUse(port);
  if (stillInUse) {
    console.warn(`[ensure-ports] 警告：端口 ${port} 仍处于占用状态（可能为系统保留或特权进程）。`);
  } else {
    console.log(`[ensure-ports] 端口 ${port} 已就绪。`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const ports = args.length > 0 ? args.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [5281, 5280];
  for (const port of ports) {
    await freePort(port);
  }
}

main().catch((err) => {
  console.error("[ensure-ports] 异常:", err);
});
