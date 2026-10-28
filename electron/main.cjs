const { app, BrowserWindow, dialog, net, protocol, shell, ipcMain, Menu, nativeImage, nativeTheme, Tray } = require("electron");
const path = require("path");
const os = require("os");
const { fork } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");

/**
 * 生产模式（electron-builder 安装形态）：
 * - 前端走自定义 app:// 协议加载 asar 内的 prototype/dist（无 dev server；
 *   不用 file:// —— file 页面 origin 为 null，daemon 的 CORS 白名单进不去，
 *   /bootstrap 取 token 会被 401 拦死）；
 * - daemon 由本进程 fork（ELECTRON_RUN_AS_NODE 把自己当 node 用，用户机器零依赖），
 *   daemon-deploy（bundle + 原生模块实体）由 builder 放进 resources/daemon/。
 *
 * dev 模式（pnpm dev:desktop）行为不变：前端 5280 dev server，daemon 归 concurrently 管。
 */
const isPackaged = app.isPackaged;
/** app://moyubot —— 前端静态资源的固定源；daemon 侧靠 AGENT_WORKBENCH_EXTRA_ALLOWED_ORIGINS 放行它 */
const APP_ORIGIN = "app://moyubot";

if (isPackaged) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/** daemon 子进程（生产模式）。dev 模式下恒为 null —— 生命周期归 concurrently。 */
let daemonChild = null;

function startPackagedDaemon() {
  const daemonEntry = path.join(process.resourcesPath, "daemon", "daemon-deploy", "daemon.js");
  if (!fs.existsSync(daemonEntry)) {
    console.error(`[electron] daemon bundle 缺失: ${daemonEntry}`);
    return;
  }
  // fork 默认用 process.execPath —— 生产模式即本 Electron 二进制；
  // ELECTRON_RUN_AS_NODE 让它以 node 语义跑 .js（ESM 由 daemon-deploy/package.json 声明）
  daemonChild = fork(daemonEntry, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      // 桌面壳协议源进 daemon 的受信源白名单（httpd isLocalOrigin）：
      // bootstrap 取 token / WS 鉴权 / open-folder 豁免全靠它，端口固定 5281（daemon 默认）
      AGENT_WORKBENCH_EXTRA_ALLOWED_ORIGINS: APP_ORIGIN,
      AGENT_WORKBENCH_PORT: "5281",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"], // fork 的硬要求：ipc 通道必须显式在列
  });
  const tag = (buf) => `[daemon] ${buf.toString().trimEnd()}`;
  daemonChild.stdout?.on("data", (d) => console.log(tag(d)));
  daemonChild.stderr?.on("data", (d) => console.error(tag(d)));
  daemonChild.once("exit", (code) => {
    console.warn(`[electron] daemon 退出 code=${code}`);
    daemonChild = null;
  });
}

function stopPackagedDaemon() {
  if (daemonChild === null || daemonChild.exitCode !== null) return;
  const pid = daemonChild.pid;
  daemonChild = null;
  try {
    // Windows 上 kill() 是 TerminateProcess（daemon 的优雅退出收不了尾）。daemon 的
    // 落盘全部走「写临时文件 + rename」原子模式，硬杀可承受；树杀防 node-pty 子进程残留。
    if (process.platform === "win32") {
      require("node:child_process").execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // 已在退出中
  }
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/** app://moyubot/<path> → asar 内 prototype/dist/<path>。路径归一化防穿越。 */
function registerAppProtocol() {
  const distRoot = path.join(app.getAppPath(), "prototype", "dist");
  protocol.handle("app", async (request) => {
    let rel = decodeURIComponent(new URL(request.url).pathname).replace(/\\/g, "/");
    rel = rel.replace(/^\/+/, "");
    if (rel === "" || rel === "index.html") rel = "index.html";
    const abs = path.normalize(path.join(distRoot, rel));
    if (!abs.startsWith(distRoot)) {
      return new Response("forbidden", { status: 403 });
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    // 不走 net.fetch(file://)：Chromium 网络栈不认 asar 虚拟路径（ERR_FILE_NOT_FOUND）；
    // fs 在 Electron 里对 asar 透明，读出来手工组 Response
    try {
      const data = await fs.promises.readFile(abs);
      return new Response(data, { headers: { "content-type": mime } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

/**
 * 品牌图标 —— 亮主题用白底版，暗主题用黑底版（设计导出的 PNG 原图逐级减半缩放，
 * 不走 SVG 栅格化 —— SVG 小尺寸下图形外会出灰边）。窗口图标 256px，
 * 托盘 32px（Windows 通知区域的实际显示尺寸，单独出图更锐）。
 */
const ICON_LIGHT = path.join(__dirname, "icon-light.png");
const ICON_DARK = path.join(__dirname, "icon-dark.png");
const TRAY_LIGHT = path.join(__dirname, "tray-light.png");
const TRAY_DARK = path.join(__dirname, "tray-dark.png");

/**
 * 渲染层是否已上报过主题结论（app:theme-changed）。
 * 上报前跟随系统明暗（nativeTheme）；上报后以应用内 appearance 设置为准 ——
 * 用户在应用里钉死 light/dark 时，系统切换不该把图标带跑偏。
 */
let rendererThemeReported = false;

/** 用户自定义 logo 的覆盖图标（app:brand-icon 推来的 PNG），null = 用内置双版 */
let brandOverride = null;
/** 最近一次应用过的明暗档 —— 图标覆盖与主题切换共用一条应用路径，各自只记自己的状态 */
let lastDark = null;

function applyBrandIcons(dark) {
  lastDark = dark;
  const windowIcon = brandOverride ? brandOverride.window : dark ? ICON_DARK : ICON_LIGHT;
  const trayIcon = brandOverride ? brandOverride.tray : dark ? TRAY_DARK : TRAY_LIGHT;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(windowIcon);
  if (tray && !tray.isDestroyed()) tray.setImage(trayIcon);
}

ipcMain.on("app:theme-changed", (_event, resolved) => {
  if (resolved !== "dark" && resolved !== "light") return;
  rendererThemeReported = true;
  applyBrandIcons(resolved === "dark");
});

// 自定义 logo：渲染层把图裁方转成 PNG data URL 推过来（256/32 两档），
// 主进程用 nativeImage 还原。payload 不合法或解码为空 = 撤销覆盖、回内置双版。
ipcMain.on("app:brand-icon", (_event, payload) => {
  const usable =
    payload &&
    typeof payload === "object" &&
    typeof payload.window === "string" &&
    typeof payload.tray === "string";
  if (usable) {
    const windowImg = nativeImage.createFromDataURL(payload.window);
    const trayImg = nativeImage.createFromDataURL(payload.tray);
    brandOverride = !windowImg.isEmpty() && !trayImg.isEmpty() ? { window: windowImg, tray: trayImg } : null;
  } else {
    brandOverride = null;
  }
  applyBrandIcons(lastDark === null ? nativeTheme.shouldUseDarkColors : lastDark);
});

// auto 模式下渲染层会跟着系统变化重推结论；这里的 nativeTheme 兜底只服务
// 渲染层还没起来（后端未就绪、加载重试中）的那段窗口期
nativeTheme.on("updated", () => {
  if (!rendererThemeReported) applyBrandIcons(nativeTheme.shouldUseDarkColors);
});

let mainWindow = null;
let tray = null;

/**
 * 启动主题预取 —— 同步读 <homeDir>/appearance.json 的 mode（家目录规则与
 * backend/src/config.ts 一致：AGENT_WORKBENCH_HOME 优先，默认 ~/.agent-workbench）。
 *
 * appearance.json 是外观的唯一真相，但渲染层要等 React 挂载 + daemon RPC 往返
 * （dev 冷启动数秒）之后才见到它。这三样东西等不了，必须主进程先代读：
 *   1. 窗口 backgroundColor —— 页面绘出来之前窗口就是这个色；
 *   2. 窗口 / 托盘初始图标 —— 渲染层 app:theme-changed 上报前的近似值；
 *   3. 经 additionalArguments 交给 preload，preload 把 mode 合进 localStorage
 *      外观缓存，页面首帧（index.html 内联脚本 / useAppearance 初始态）
 *      读到的就是「上次主题」，而不是默认的跟随系统。
 * 读不到 / 损坏返回 null，一切回落旧行为（nativeTheme 跟随系统）。
 */
function readPersistedAppearanceMode() {
  try {
    const home = process.env.AGENT_WORKBENCH_HOME || path.join(os.homedir(), ".agent-workbench");
    const raw = fs.readFileSync(path.join(home, "appearance.json"), "utf8");
    const mode = JSON.parse(raw)?.mode;
    return mode === "light" || mode === "dark" || mode === "auto" ? mode : null;
  } catch {
    return null;
  }
}

/** 首帧按哪个明暗档：应用里钉死的 mode 优先，auto / 没有 → 跟随系统 */
function startupUseDark() {
  const mode = readPersistedAppearanceMode();
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return nativeTheme.shouldUseDarkColors;
}

/**
 * 关窗语义：X 不再退出进程，而是藏进通知区域（托盘）—— 后台守护（定时任务 /
 * IM 渠道 / 心跳）还在值班，任务栏托盘灯就是「它还在」的可见凭证。真正退出
 * 走托盘右键菜单的「退出」。
 */
let quitting = false;
let hideNotified = false;

/** zoomLevel 上下限：±4 档（每档 0.5），够用且不会把页面变成像素汤 */
const ZOOM_MAX = 4;
const ZOOM_MIN = -4;

/**
 * 文本语义的右键菜单（对齐 ZCode desktopWindowChrome.ts 的 buildTextContextMenuTemplate）：
 * - 可编辑区域（对话输入框等）→ 剪切 / 复制 / 粘贴（按 editFlags 置灰）；
 * - 纯文本选区（对话内容里选中文字）→ 只给 复制；
 * - 其余（无选区且不可编辑）→ 不弹菜单，保持右键安静。
 * 用 Electron 原生菜单而不是 DOM 浮层：剪贴板 role 由 Chromium 实现，输入框、
 * 只读文本、跨进程剪贴板行为都和系统一致，无需在前端各处接 contextmenu。
 */
function buildTextContextMenuTemplate(params) {
  if (params.isEditable) {
    return [
      { label: "剪切", role: "cut", enabled: params.editFlags.canCut },
      { label: "复制", role: "copy", enabled: params.editFlags.canCopy },
      { label: "粘贴", role: "paste", enabled: params.editFlags.canPaste },
    ];
  }
  if ((params.selectionText || "").trim().length > 0) {
    return [{ label: "复制", role: "copy", enabled: params.editFlags.canCopy }];
  }
  return [];
}

function applyZoom(delta) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, wc.getZoomLevel() + delta));
  wc.setZoomLevel(next);
}

function resetZoom() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomLevel(0);
}

/**
 * 内容缩放 —— 不依赖默认菜单的加速键：
 * - 默认菜单的放大注册在 `Ctrl+Plus` 上，那个键要 Shift+= 才按得出来，
 *   所以 `Ctrl+=` 永远不匹配（缩小 `Ctrl+-` 是直配键，因此能用）——这里自己接。
 * - Ctrl+滚轮 Electron 本身不带，preload 把 ctrlKey 的 wheel 转发到这里的 IPC。
 */
function bindZoomShortcuts(wc) {
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    // F12 或 Ctrl+Shift+I 呼出 DevTools（便于调试控制台日志与渲染异常）
    if (input.key === "F12" || (input.control && input.shift && (input.key || "").toLowerCase() === "i")) {
      wc.toggleDevTools();
      event.preventDefault();
      return;
    }
    if (!input.control || input.alt || input.meta) return;
    const key = (input.key || "").toLowerCase();
    if (key === "=" || key === "+" || input.code === "NumpadAdd") {
      applyZoom(0.5);
      event.preventDefault();
    } else if (key === "-" || input.code === "NumpadSubtract") {
      applyZoom(-0.5);
      event.preventDefault();
    } else if (key === "0") {
      resetZoom();
      event.preventDefault();
    }
  });
}

ipcMain.on("zoom-wheel", (_event, deltaY) => {
  applyZoom(deltaY < 0 ? 0.5 : -0.5);
});

/**
 * 原生「选择文件夹」对话框（与 <input type="file"> 附件选择同款系统 UI）。
 * 渲染层的 FolderPickerField 在桌面端优先走这里；纯浏览器访问没有本通道，
 * 回落到组件内置的目录浏览器。返回 null = 用户取消。
 */
ipcMain.handle("shell:open-path", async (_event, path) => {
  // 设置页「打开文件」：系统默认程序打开配置文件。空/非字符串静默拒绝
  if (typeof path !== "string" || path.trim() === "") return "";
  return await shell.openPath(path);
});
ipcMain.handle("shell:show-item-in-folder", (_event, path) => {
  if (typeof path !== "string" || path.trim() === "") return;
  shell.showItemInFolder(path);
});

ipcMain.handle("dialog:pick-directory", (_event, opts) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const o = opts !== null && typeof opts === "object" ? opts : {};
  return dialog
    .showOpenDialog(mainWindow, {
      title: typeof o.title === "string" && o.title !== "" ? o.title : "选择文件夹",
      defaultPath:
        typeof o.defaultPath === "string" && o.defaultPath !== "" ? o.defaultPath : undefined,
      properties: ["openDirectory"],
    })
    .then((r) => (r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]));
});

/**
 * 保存文本文件（docs/26 会话分享导出的落地点）：系统「另存为」框选位置，
 * 主进程直接写盘（渲染进程在 app:// 协议下没有 fs 权限）。取消返回 null。
 */
ipcMain.handle("dialog:save-file", async (_event, opts) => {
  const o = opts !== null && typeof opts === "object" ? opts : {};
  if (typeof o.defaultName !== "string" || o.defaultName === "" || typeof o.text !== "string") {
    return null;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: typeof o.title === "string" && o.title !== "" ? o.title : "保存文件",
    defaultPath: o.defaultName,
    filters: Array.isArray(o.filters)
      ? o.filters
      : [{ name: "JSON", extensions: ["json"] }],
  });
  if (picked.canceled || typeof picked.filePath !== "string" || picked.filePath === "") return null;
  await fs.promises.writeFile(picked.filePath, o.text, "utf8");
  return picked.filePath;
});

/**
 * 前端自绘窗口控制按钮（WindowControls.tsx）的主进程侧：
 * 最小化 / 最大化切换 / 关闭三个动作 + 最大化状态推送（切图标用）。
 */
ipcMain.on("window:minimize", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.on("window:toggle-maximize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on("window:close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

ipcMain.handle("window:is-maximized", () => {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized());
});

/**
 * 标题栏右键 = Windows 系统菜单同款的原生菜单（还原/最大化/最小化/关闭）。
 *
 * 为什么是原生菜单而不是 DOM 浮层：无边框窗口没有系统标题栏，右键顶栏弹
 * 系统同款菜单是 Windows 的基本预期；原生 Menu 由系统绘制、带 Alt+F4 加速键
 * 显示，观感与Explorer 桌面右键一致。移动布局下右上角自绘三钮隐藏，这是
 * 主操作入口。移动/大小两项依赖 Win32 的 SC_MOVE/SC_SIZE 循环，Electron 无法
 * 触发，省略 —— 移动由 titlebar-drag 拖拽热区覆盖。
 *
 * popup() 不传 x/y 时默认弹在当前鼠标位置（Chromium 侧已把事件给到光标处）。
 */
ipcMain.on("window:system-menu", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  Menu.buildFromTemplate([
    {
      label: "还原(&R)",
      enabled: maximized,
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.unmaximize();
      },
    },
    {
      label: "最大化(&X)",
      enabled: !maximized,
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.maximize();
      },
    },
    { type: "separator" },
    {
      label: "最小化(&N)",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
      },
    },
    { type: "separator" },
    {
      label: "关闭(&C)",
      // 只显示 Alt+F4 字样不抢注：系统本来就处理 Alt+F4，注册反而可能截获
      accelerator: "Alt+F4",
      registerAccelerator: false,
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      },
    },
  ]).popup({ window: mainWindow });
});

/** 从托盘 / 菜单把主窗口带回来（销毁过则重建） */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Windows 通知区域（托盘）图标 —— 关掉前台窗口后「后台还在不在」的答案就在这：
 * 绿托盘 = 守护还在。左键点开工作台，右键菜单可退出（退出会连带工作台 UI 进程；
 * dev 模式下 daemon 由 concurrently 另起，生命周期独立于本进程）。
 */
function createTray() {
  // 初始按持久化主题；渲染层起来后 app:theme-changed 会带着应用内结论来纠正
  tray = new Tray(startupUseDark() ? TRAY_DARK : TRAY_LIGHT);
  tray.setToolTip("MoyuBot · 后台运行中");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开工作台", click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "退出（关闭工作台）",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => showMainWindow());
}

function createWindow() {
  // 首帧底色 / 图标按「上次的主题」来（见 readPersistedAppearanceMode 注释）：
  // 写死浅色底会让深色用户在页面绘出前闪一屏白，反之亦然
  const startDark = startupUseDark();
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 360,
    minHeight: 480,
    title: "MoyuBot",
    // 初始按持久化主题；渲染层上报后 applyBrandIcons 会换（icon.png 仅作打包兜底，运行时不再引用）
    icon: startDark ? ICON_DARK : ICON_LIGHT,
    backgroundColor: startDark ? "#000000" : "#f7f7f4",
    show: true, // 立即显示窗口，防止 ready-to-show 被阻塞
    autoHideMenuBar: true,
    // 无边框窗口：隐藏系统标题栏，网页内容铺到窗口最顶端。拖拽移动 / 双击最大化 /
    // Win+方向贴靠仍是系统原生行为（前端顶行挂 .titlebar-drag 热区）。
    // 右上角的窗口控制按钮由前端自绘（WindowControls.tsx）：Electron 44 在 Win10
    // 上 titleBarOverlay 的运行时换色不可靠（symbolColor 不重绘、多次调用会串色），
    // WCO 方案验证过被否。macOS 保持系统边框不变。
    ...(process.platform === "darwin" ? {} : { titleBarStyle: "hidden" }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 把持久化的外观档位交给 preload（--aw-appearance=light|dark|auto），
      // 它会在页面任何脚本跑之前合进 localStorage 外观缓存 —— 首帧即上次主题
      additionalArguments: ["--aw-appearance=" + (readPersistedAppearanceMode() ?? "auto")],
    },
  });

  bindZoomShortcuts(mainWindow.webContents);

  // 最大化状态推送：前端 WindowControls 靠它切换「最大化/还原」图标
  const sendMaximized = (value) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("window:maximized-changed", value);
  };
  mainWindow.on("maximize", () => sendMaximized(true));
  mainWindow.on("unmaximize", () => sendMaximized(false));

  // 关窗 = 藏进托盘（见顶部 quitting 注释）。开发模式下关窗直接退出，避免孤儿进程占用端口。
  mainWindow.on("close", (event) => {
    if (process.env.NODE_ENV === "development") {
      quitting = true;
      app.quit();
      return;
    }
    if (quitting || !tray) return;
    event.preventDefault();
    mainWindow.hide();
    if (!hideNotified && process.platform === "win32" && typeof tray.displayBalloon === "function") {
      hideNotified = true;
      tray.displayBalloon({
        title: "MoyuBot 仍在后台运行",
        content: "定时任务、IM 渠道与心跳照常工作。点托盘图标重新打开窗口；右键托盘图标可退出。",
      });
    }
  });

  // 文本编辑语义的右键菜单（剪切/复制/粘贴/复制选区）——见 buildTextContextMenuTemplate 注释。
  // 之前完全没有 context-menu 处理，输入框里右键粘贴、选中对话文字右键复制都像被禁用了。
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const template = buildTextContextMenuTemplate(params);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // 粘贴走 Clipboard 异步 API 的场景（前端自定义菜单等）需要这两个许可；默认拒绝会让 readText 静默失败
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "clipboard-read" || permission === "clipboard-sanitized-write");
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5280";
  const appUrl = isPackaged ? `${APP_ORIGIN}/index.html` : devUrl;

  // 监听加载失败事件（例如服务器尚未启动时），每 800ms 自动重试
  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.log(`[electron] 加载未完成 (${errorCode}: ${errorDescription})，正在重试...`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(appUrl).catch(() => {});
      }
    }, 800);
  });

  console.log(`[electron] 正在加载页面: ${appUrl}`);
  mainWindow.loadURL(appUrl).catch((err) => {
    console.warn("[electron] 首次加载触发重试机制:", err.message);
  });
}

// 单实例锁（生产形态）：第二个实例只把已有窗口带回来，不再抢 5281 端口
if (isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
}

app.whenReady().then(() => {
  if (isPackaged) {
    registerAppProtocol();
    startPackagedDaemon();
  }
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 任何退出路径（托盘退出 / Cmd+Q / app.quit）都标记 quitting，
// 让窗口 close 处理器放行 —— 否则藏托盘的 preventDefault 会拦住退出
app.on("before-quit", () => {
  quitting = true;
  stopPackagedDaemon();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
