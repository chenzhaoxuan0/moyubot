import { createContext } from "react";

/**
 * 会话画布可见性 —— WorkspaceShell 画布 mount-once latch 的配套。
 *
 * 画布在自动化/清单/出图主视图下常驻但隐藏（hidden + inert），而 inert 只挡
 * 焦点、挡不住 window/document 级监听：画布里挂全局键盘监听的组件（权限卡、
 * 问卷卡、对话内查找、斜杠菜单）读它，隐藏时不挂监听 —— 否则在别的页按个数字
 * 就裁决了看不见的权限请求、Enter 提交了看不见的问卷。
 *
 * 用 Context 而不是读 useShell.mainView：问的是「我是否在被隐藏的画布子树里」，
 * 画布之外（弹出窗口 / 移动端布局）没有 Provider，默认可见 —— 移动端不维护
 * mainView，读它会被桌面端遗留的值误伤。
 */
export const CanvasVisibleContext = createContext(true);
