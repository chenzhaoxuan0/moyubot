import { ArrowDown } from "lucide-react";
import { cn } from "../../cn.ts";

export function BackToBottomFab({
  visible,
  busy,
  onClick,
}: {
  visible: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="回到底部"
      title={busy ? "助手正在生成新内容，点击回到底部跟随" : "回到底部"}
      className={cn(
        "group absolute bottom-4 right-6 z-20 flex items-center gap-1.5 rounded-full border border-line bg-card/90 px-3 py-1.5 shadow-md backdrop-blur-sm transition-all duration-150 hover:bg-card hover:shadow-lg active:scale-95 cursor-pointer",
        "animate-in fade-in slide-in-from-bottom-2",
      )}
    >
      {busy ? (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-teal" />
        </span>
      ) : (
        <ArrowDown size={13} className="text-graphite transition-transform group-hover:translate-y-0.5 text-ink" />
      )}
      <span className="text-caption font-medium text-graphite group-hover:text-ink">
        {busy ? "有新生成" : "回到底部"}
      </span>
    </button>
  );
}
