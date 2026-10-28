const { contextBridge, ipcRenderer } = require("electron");

/**
 * 启动主题接力：main.cjs 代读了 appearance.json 的 mode，经
 * --aw-appearance=<mode> 传到这里。preload 先于页面任何脚本执行，在这里把
 * mode 合进 localStorage 的外观缓存（与 appearanceStore.ts 的
 * FALLBACK_STORAGE_KEY 同键），index.html 首屏脚本与 useAppearance 的初始态
 * 读到的就是「上次主题」——不然要等 daemon RPC 往返（dev 冷启动数秒），
 * 系统深色 + 应用钉浅色的用户每次启动都先黑一截再被纠正。
 * 只动 mode：缓存里其余字段（用户调过的色板等）归渲染层自己维护。
 * 整段防御式，任何一步失败都不影响加载（回落默认链路）。
 */
try {
  const FLAG = "--aw-appearance=";
  const flag = process.argv.find((arg) => arg.startsWith(FLAG));
  const mode = flag ? flag.slice(FLAG.length) : null;
  if (mode === "light" || mode === "dark" || mode === "auto") {
    const KEY = "agent-workbench:appearance:fallback";
    let state = null;
    try {
      state = JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {
      state = null;
    }
    if (!state || typeof state !== "object") {
      // 没有缓存时写一份最小骨架：sanitizeAppearanceState 读回时会补全其余字段
      state = { schemaVersion: 1 };
    } else if (state.schemaVersion !== 1) {
      // 旧缓存缺 schemaVersion 的话 sanitize 会整份判废、mode 也跟着失效 —— 归一化
      state.schemaVersion = 1;
    }
    if (state.mode !== mode) {
      state.mode = mode;
      localStorage.setItem(KEY, JSON.stringify(state));
    }
  }
} catch {
  /* localStorage 不可用（隐私模式等）—— 走默认链路 */
}

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  arch: process.arch,
  /**
   * 推送应用的主题结论（appearance mode 解析出的 light/dark）到主进程：
   * 主进程据此切换窗口图标与托盘图标（亮主题白底 logo / 暗主题黑底 logo，
   * 见 main.cjs 的 applyBrandIcons）。纯浏览器访问时 electronAPI 不存在，
   * useAppearance.applyToDom 里的调用自然落空，不影响主题本身。
   */
  notifyTheme: (resolved) => ipcRenderer.send("app:theme-changed", resolved),
  /**
   * 推送自定义品牌图标（用户在外观设置里换的自定义 logo）：
   * payload 是渲染层 canvas 居中裁方后的 PNG data URL —— window 256px / tray 32px 两档。
   * 传 null 恢复内置品牌图标（亮白底/暗黑底双版，随主题切换）。
   */
  setBrandIcon: (payload) => ipcRenderer.send("app:brand-icon", payload ?? null),
  /**
   * 原生目录选择对话框：系统文件资源管理器的「选择文件夹」窗口。
   * resolve 选中的绝对路径；取消 / 不可用 resolve null。
   */
  pickDirectory: (opts) => ipcRenderer.invoke("dialog:pick-directory", opts),
  /**
   * 保存文本文件（docs/26 会话分享导出）：系统「另存为」框 + 主进程写盘。
   * resolve 实际保存的绝对路径；取消 / 不可用 resolve null。
   */
  saveFile: (opts) => ipcRenderer.invoke("dialog:save-file", opts),
  /**
   * 用系统默认程序打开文件 / 在资源管理器中显示（设置页「打开文件」按钮）。
   * 纯浏览器访问时整块 electronAPI 不存在，前端回落 daemon 的 open-folder。
   */
  shell: {
    openPath: (path) => ipcRenderer.invoke("shell:open-path", path),
    showItemInFolder: (path) => ipcRenderer.invoke("shell:show-item-in-folder", path),
  },
  /**
   * 前端自绘窗口控制按钮（WindowControls.tsx）的通道。
   * 纯浏览器访问时整块 electronAPI 不存在，组件自行隐藏。
   */
  windowControls: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    /** 标题栏右键：弹出 Windows 系统菜单同款的原生菜单（还原/最大化/最小化/关闭） */
    openSystemMenu: () => ipcRenderer.send("window:system-menu"),
    onMaximizedChanged: (listener) => {
      const wrapped = (_event, value) => listener(value);
      ipcRenderer.on("window:maximized-changed", wrapped);
      return () => ipcRenderer.removeListener("window:maximized-changed", wrapped);
    },
  },
});

// Ctrl+滚轮缩放：Electron 没有内置，这里捕获后转给主进程调 webContents.setZoomLevel
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    ipcRenderer.send("zoom-wheel", e.deltaY);
  },
  { passive: false },
);
