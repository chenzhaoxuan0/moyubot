import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig(({ mode }) => {
  // 端口可配，默认 5280。**旧的 5180 在本机不可绑定** —— Windows 的 Hyper-V / WSL
  // 保留了 5141–5240 一整段动态端口，旧默认 5180 与 daemon 旧默认 5181 都落在里面，
  // 且 strictPort: true 时 vite 会直接报错退出。daemon 侧的默认端口见
  // backend/src/config.ts 的 DEFAULT_DAEMON_PORT（5281），两边必须能一起改。
  const env = loadEnv(mode, process.cwd(), "");
  const uiPort = Number(env["VITE_UI_PORT"] ?? "5280");
  // daemon 端口跟 client.ts 的 DAEMON_PORT 同源：默认 5281，可被
  // VITE_AGENT_WORKBENCH_PORT 覆盖。同源客户端（defaultDaemonEndpoint 优先取
  // window.location.origin）全部流量走这里的 proxy —— target 写死 5281 会让
  // 「AGENT_WORKBENCH_PORT=5273 换端口」的配方只改了一半，前端悄悄连回旧 daemon。
  const daemonPort = env["VITE_AGENT_WORKBENCH_PORT"]?.trim() || "5281";
  const daemonWs = `ws://127.0.0.1:${daemonPort}`;
  const daemonHttp = `http://127.0.0.1:${daemonPort}`;

  return {
    // 相对资源路径：桌面生产态经 app:// 协议加载 dist（无 dev server 根路径）；
    // dev 模式下 vite 对 './' 同样正常解析，行为不变
    base: "./",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": src },
    },
    // host: true = 绑全部网卡：Windows 上同时覆盖 ::1 与 0.0.0.0，
    // 本地工具与手机（http://<pc-ip>:<uiPort>）都可达
    // 配置 proxy 将 /ws, /bootstrap, /api 转发至 daemon，避免手机端防火墙/跨端口访问失败
    server: {
      host: true,
      port: uiPort,
      strictPort: true,
      proxy: {
        "/ws": {
          target: daemonWs,
          ws: true,
          changeOrigin: true,
        },
        "/bootstrap": {
          target: daemonHttp,
          changeOrigin: true,
        },
        "/api": {
          target: daemonHttp,
          changeOrigin: true,
        },
        "/healthz": {
          target: daemonHttp,
          changeOrigin: true,
        },
      },
    },
  };
});
