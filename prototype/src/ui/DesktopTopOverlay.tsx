import { PanelLeftOpen } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { BrandLogo } from "./BrandLogo.tsx";

/**
 * 左上浮层 —— 仅在侧边栏折叠时常驻左上角，提供侧栏展开入口。
 * 当侧边栏展开时，由 Sidebar 自行渲染顶栏（A 图标、搜索、自动化、出图；或在子页面时顶掉为统一的返回工作台）。
 *
 * 只放这一颗图标（pl-3 + w-7 = 40px，头部内容从 48px 起排正好让出它）：
 * 「手机视图」切换不在这里重复——工作区头部右侧那颗常驻的是唯一出口，
 * 这里再放一颗会顶进头部 Agent 名称的对齐带。
 */
export function DesktopTopOverlay() {
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);

  if (!sidebarCollapsed) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute left-0 top-0 z-30 flex h-12 items-center">
      {/* titlebar-no-drag：悬浮在下方 titlebar-drag 头部之上，必须显式打洞才可点击 */}
      <div className="titlebar-no-drag pointer-events-auto flex items-center gap-1 pl-3 text-body-sm">
        {/* 侧栏开关：点击展开侧栏 */}
        <button
          onClick={() => useShell.getState().toggleSidebar()}
          aria-label="展开侧栏"
          title="展开侧栏 · ⌘B"
          className="group relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-btn text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
        >
          <BrandLogo
            className="h-5 w-5 rounded-sm object-cover transition-opacity duration-150 group-hover:opacity-0"
          />
          <PanelLeftOpen
            size={14}
            className="absolute inset-0 m-auto opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          />
        </button>
      </div>
    </div>
  );
}
