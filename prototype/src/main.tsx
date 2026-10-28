import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
// 外观 store 在模块加载时就往 <html> 写 CSS 变量，必须先于 App 引入，
// 否则首屏会先用 styles.css 里硬编码的旧配色闪一帧。
import "./store/useAppearance.ts";
// 待办（GTD）信号：提议弹窗/总状态点要跨主视图常驻，订阅挂在应用入口
import { bindBacklogSignals } from "./store/useBacklog.ts";
// 清单（inbox）信号：分类状态/条目变化同理跨主视图常驻
import { bindInboxSignals } from "./store/useInbox.ts";
import { App } from "./app.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";

bindBacklogSignals();
bindInboxSignals();

// 原型期的 T3 provider profiles（agent-workbench:provider-profiles）已整体删除：
// 那套 store 没有任何消费方，但用户浏览器里可能还躺着当年存进去的明文 API Key ——
// 顺手清掉，别让死数据继续当泄密面。
try {
  localStorage.removeItem("agent-workbench:provider-profiles");
} catch { /* 私有模式 */ }

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");

createRoot(el).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

