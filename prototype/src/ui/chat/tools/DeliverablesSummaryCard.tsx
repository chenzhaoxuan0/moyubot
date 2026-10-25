import { Code2, FileCode, FolderOpen } from "lucide-react";
import { openInEditor } from "../../../adapters/daemon/client.ts";

export interface DeliverableFile {
  path: string;
  kind?: "created" | "modified" | "deleted";
}

export function DeliverablesSummaryCard({
  files,
}: {
  files: DeliverableFile[];
}) {
  if (files.length === 0) return null;

  return (
    <div className="rounded-card border border-teal/20 bg-teal-tint/10 p-3 shadow-xs">
      <div className="flex items-center gap-1.5 text-caption font-medium text-teal mb-2">
        <FileCode size={13} />
        <span>本轮修改/交付的文件 ({files.length})</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {files.map((f, i) => (
          <div
            key={i}
            className="flex items-center gap-1.5 rounded-input border border-line bg-card px-2.5 py-1 text-caption font-mono shadow-2xs hover:border-teal/50 transition group"
          >
            <span className="truncate max-w-[220px] text-ink" title={f.path}>
              {f.path.split(/[\\/]/).pop()}
            </span>

            <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition">
              <button
                type="button"
                onClick={() => void openInEditor({ path: f.path, editorId: "vscode" })}
                title="用 VS Code 打开"
                className="rounded p-0.5 text-ash hover:text-ink cursor-pointer"
              >
                <Code2 size={11} />
              </button>
              <button
                type="button"
                onClick={() => {
                  const parent = f.path.replace(/[\\/][^\\/]*$/, "") || f.path;
                  void openInEditor({ path: parent, editorId: "explorer" });
                }}
                title="在资源管理器中定位"
                className="rounded p-0.5 text-ash hover:text-ink cursor-pointer"
              >
                <FolderOpen size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
