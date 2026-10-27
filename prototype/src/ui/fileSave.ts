/**
 * 文本文件保存 helper（docs/26 会话分享导出的落盘通道）：
 *
 * 1. **桌面端**：Electron preload 的 electronAPI.saveFile —— 系统「另存为」框，
 *    主进程写盘（渲染进程在 app:// 下没有 fs 权限），返回实际保存路径。
 * 2. **纯浏览器**（vite dev / 远程访问）：回落标准 Blob 下载（同源 a[download]，
 *    文件落在浏览器默认下载目录），返回 null 表示「没有系统路径可报告」。
 */

/** 桌面端注入的原生通道（electron/preload.cjs）。纯浏览器访问时不存在。 */
const nativeSave: ((opts: {
  title?: string;
  defaultName: string;
  text: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}) => Promise<string | null>) | undefined = (
  window as unknown as {
    electronAPI?: {
      saveFile?: (opts: {
        title?: string;
        defaultName: string;
        text: string;
        filters?: Array<{ name: string; extensions: string[] }>;
      }) => Promise<string | null>;
    };
  }
).electronAPI?.saveFile;

export interface SaveFileOutcome {
  /** 桌面端 = 实际保存的绝对路径；浏览器下载 = null（下载已由浏览器接管） */
  readonly path: string | null;
  /** true = 用户取消（桌面端取消 / 通道不可用且浏览器下载也失败） */
  readonly canceled: boolean;
}

/** 文件名里的非法字符压成 _（标题做文件名用） */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
}

export async function saveTextFile(
  defaultName: string,
  text: string,
  opts?: { title?: string; mime?: string },
): Promise<SaveFileOutcome> {
  if (nativeSave !== undefined) {
    const path = await nativeSave({ title: opts?.title, defaultName, text });
    return path === null ? { path: null, canceled: true } : { path, canceled: false };
  }
  // 浏览器回落：Blob 下载（无系统保存框可选目录）
  try {
    const url = URL.createObjectURL(new Blob([text], { type: opts?.mime ?? "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { path: null, canceled: false };
  } catch {
    return { path: null, canceled: true };
  }
}
