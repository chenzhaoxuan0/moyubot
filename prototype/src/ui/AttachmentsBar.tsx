import { useState } from "react";
import { createPortal } from "react-dom";
import {
  FileCode,
  FileText,
  ImageIcon,
  Paperclip,
  X,
  ExternalLink,
  Download,
} from "lucide-react";
import type { ChatAttachment } from "../core/attachments.ts";
import { formatAttachmentSize } from "../core/attachments.ts";
import { cn } from "./cn.ts";

export interface AttachmentsBarProps {
  attachments: ChatAttachment[];
  onRemove?: (id: string) => void;
  onPreview?: (attachment: ChatAttachment) => void;
  className?: string;
  readOnly?: boolean;
}

/**
 * 附件条 —— 在输入框中展示已选中的文件与图片，对齐 ZCode 附件条交互。
 */
export function AttachmentsBar({
  attachments,
  onRemove,
  onPreview,
  className,
  readOnly = false,
}: AttachmentsBarProps) {
  const [previewItem, setPreviewItem] = useState<ChatAttachment | null>(null);

  if (attachments.length === 0) return null;

  const handlePreview = (item: ChatAttachment) => {
    if (onPreview) {
      onPreview(item);
    } else if (item.category === "image" && (item.url || item.base64)) {
      setPreviewItem(item);
    }
  };

  return (
    <>
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 px-1 py-1.5 overflow-x-auto overscroll-contain select-none",
          className,
        )}
      >
        {attachments.map((item) => {
          const isImage = item.category === "image" && (item.url || item.base64);
          const imgSrc = item.url ?? (item.base64 ? `data:${item.mimeType};base64,${item.base64}` : "");

          return (
            <div
              key={item.id}
              className={cn(
                "group relative flex items-center gap-2 rounded-xl border border-line bg-card/80 p-1.5 pr-2.5 text-xs text-ink shadow-xs transition hover:border-line-hover hover:bg-card",
                isImage && "cursor-pointer",
              )}
              onClick={() => isImage && handlePreview(item)}
            >
              {isImage ? (
                <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-line/60 bg-line-soft">
                  <img
                    src={imgSrc}
                    alt={item.name}
                    className="h-full w-full object-cover transition group-hover:scale-105"
                  />
                </div>
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line/60 bg-line-soft/80 text-teal">
                  {item.category === "code" ? (
                    <FileCode size={18} />
                  ) : item.category === "document" ? (
                    <FileText size={18} />
                  ) : (
                    <Paperclip size={18} />
                  )}
                </div>
              )}

              <div className="flex min-w-0 max-w-[130px] sm:max-w-[180px] flex-col">
                <span className="truncate font-medium text-ink" title={item.name}>
                  {item.name}
                </span>
                <span className="text-[10px] text-ash font-mono">
                  {formatAttachmentSize(item.size)}
                </span>
              </div>

              {!readOnly && onRemove && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(item.id);
                  }}
                  aria-label={`移除 ${item.name}`}
                  title="移除此附件"
                  className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ash hover:bg-line hover:text-loss active:scale-90 transition"
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {previewItem && (
        <ImagePreviewModal
          attachment={previewItem}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </>
  );
}

/**
 * 图片全屏查看模态框
 */
export function ImagePreviewModal({
  attachment,
  onClose,
}: {
  attachment: ChatAttachment;
  onClose: () => void;
}) {
  const imgSrc =
    attachment.url ??
    (attachment.base64 ? `data:${attachment.mimeType};base64,${attachment.base64}` : "");

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 select-none"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[90vw] flex flex-col items-center overflow-hidden rounded-2xl border border-line bg-canvas shadow-2xl animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏控制条 */}
        <div className="flex w-full items-center justify-between border-b border-line px-4 py-2.5 bg-card/90">
          <div className="flex items-center gap-2 min-w-0">
            <ImageIcon size={16} className="text-teal shrink-0" />
            <span className="truncate text-xs font-semibold text-ink" title={attachment.name}>
              {attachment.name}
            </span>
            <span className="text-[11px] text-ash font-mono shrink-0">
              ({formatAttachmentSize(attachment.size)})
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {imgSrc && (
              <a
                href={imgSrc}
                download={attachment.name}
                title="保存原图"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-ash hover:bg-line-soft hover:text-ink transition"
              >
                <Download size={14} />
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭预览"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 图片主体 */}
        <div className="flex max-h-[calc(90vh-50px)] max-w-full items-center justify-center p-3 overflow-auto bg-ink/40">
          <img
            src={imgSrc}
            alt={attachment.name}
            className="max-h-[80vh] max-w-full rounded-lg object-contain shadow-lg"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
