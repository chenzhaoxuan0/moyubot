import {
  Component,
  isValidElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Check, Copy } from "lucide-react";
import { Streamdown, useIsCodeFenceIncomplete, type Components } from "streamdown";
import { cn } from "./cn.ts";
import { highlightCode, type CodeTokenLines } from "./shikiHighlighter.ts";
import { useAppearance } from "../store/useAppearance.ts";

/**
 * 聊天正文 Markdown 渲染（基于 streamdown，选型与管线设计见 docs/17）。
 *
 * 取代旧的手写零依赖解析器（只认标题/引用/平铺列表/粗体/行内代码，表格与
 * 链接原文裸露）。streamdown 提供：GFM 全要素、流式/静态双模式、未闭合
 * 代码块容错、分块缓存。这里补齐的是「外观」——所有元素映射到本项目
 * 设计令牌，代码块沿用原有的「语言标签 + 复制按钮」头部并接入 shiki。
 */

/* ------------------------------------------------------------------ 错误边界 */

/**
 * 单条消息级错误边界：markdown 渲染崩溃时降级为纯文本，不炸整条时间线。
 * content 变化时自动复位（流式期间每帧内容都不同，旧错误不应粘住）。
 */
class MarkdownBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean; content: string }
> {
  state = { failed: false, content: this.props.content };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { content: string },
    state: { failed: boolean; content: string },
  ) {
    if (props.content !== state.content) return { failed: false, content: props.content };
    return null;
  }

  render() {
    if (this.state.failed) {
      return <p className="whitespace-pre-wrap leading-[1.625] text-ink">{this.props.content}</p>;
    }
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ 组件映射 */

/** 链接三分类：http(s) 可点（新窗口）；其它协议不可点（ZCode 模式） */
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (typeof href === "string" && /^https?:\/\//i.test(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-teal underline decoration-teal/40 underline-offset-2 break-all hover:decoration-teal"
      >
        {children}
      </a>
    );
  }
  return (
    <span className="text-graphite" title="该链接协议不支持在聊天里打开">
      {children}
    </span>
  );
}

/**
 * 标题阶梯 —— 单色纪律（Codex 桌面版取向）：
 * 不用颜色区分层级，只用字号 + 字重；所有标题都是正文同色（ink），
 * 颜色留给链接与行内代码底色。间距节奏对齐 ZCode 桌面版（2026-10-28
 * 从其产物包的 Streamdown 组件表提取）：各级统一 mt-6(24px) / mb-4(16px)。
 */
const headingCls = [
  "mt-6 mb-4 text-[1.25em] font-semibold tracking-[-0.01em] text-ink", // h1
  "mt-6 mb-4 text-[1.1em] font-semibold tracking-[-0.01em] text-ink", // h2
  "mt-6 mb-4 text-[1em] font-semibold text-ink", // h3
  "mt-6 mb-4 text-[0.95em] font-semibold text-ink", // h4
  "mt-6 mb-4 text-[0.9em] font-medium text-graphite", // h5
  "mt-6 mb-4 text-[0.9em] font-normal text-ash", // h6
] as const;

const components: Components = {
  h1: ({ children }) => <h1 className={headingCls[0]}>{children}</h1>,
  h2: ({ children }) => <h2 className={headingCls[1]}>{children}</h2>,
  h3: ({ children }) => <h3 className={headingCls[2]}>{children}</h3>,
  h4: ({ children }) => <h4 className={headingCls[3]}>{children}</h4>,
  h5: ({ children }) => <h5 className={headingCls[4]}>{children}</h5>,
  h6: ({ children }) => <h6 className={headingCls[5]}>{children}</h6>,

  // 段落自身零 margin（ZCode 口径）：块间距统一由 Streamdown 根容器的
  // space-y-4(16px) 提供，首尾贴边由容器的 first:mt-0 / last:mb-0 兜底
  p: ({ children }) => <p className="leading-[inherit] text-ink">{children}</p>,

  // 列表对齐 ZCode：my-3(12px)、列表项间 space-y-1.5(6px)、嵌套列表 my-1.5(6px)；
  // ol 用 list-inside + pl-0（两位/三位编号在 overflow 容器里不会被截断，ZCode 教训）
  ul: ({ children }) => (
    <ul className="my-3 list-outside list-disc space-y-1.5 pl-5 marker:text-ash [&_ul]:my-1.5 [&_ol]:my-1.5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-inside list-decimal space-y-1.5 pl-0 marker:text-ash [&_ul]:my-1.5 [&_ol]:my-1.5">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-1 text-ink [&>p]:my-0 [&>p]:inline">{children}</li>,

  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-line pl-3 text-graphite">{children}</blockquote>
  ),
  hr: () => <hr className="my-5 border-0 border-t border-line" />,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  del: ({ children }) => <del className="text-ash line-through">{children}</del>,

  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: (props) => (
    <img
      {...props}
      loading="lazy"
      className="my-[11px] max-w-full rounded-md border border-line"
      alt={props.alt ?? ""}
    />
  ),

  table: ({ children }) => (
    <div className="my-[11px] overflow-x-auto rounded-md border border-line bg-card">
      <table className="w-full border-collapse text-[0.855em] [&_tr:last-child>td]:border-b-0">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-rail/60">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-line px-3 py-1.5 text-left font-medium text-ink">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-line/50 px-3 py-1.5 align-top text-graphite">{children}</td>
  ),

  // 块级代码：pre 的唯一子元素是 <code className="language-xx">原文</code>
  pre: ({ children }) => <PreBlock>{children}</PreBlock>,

  // 行内代码（无 language- 类名的 code）——Codex 档：12.5px、细边框、5px 圆角
  code: ({ className, children }) => {
    if (typeof className === "string" && className.includes("language-")) {
      return <code>{children}</code>;
    }
    return (
      <code className="rounded-[5px] border border-line bg-rail/60 px-[5px] py-px font-mono text-[0.875em] leading-[inherit] text-ink">
        {children}
      </code>
    );
  },

  // GFM 任务列表复选框
  input: (props) => <input {...props} className="mr-1.5 accent-teal align-middle" />,
};

/* ------------------------------------------------------------------ 代码块 */

function extractCode(children: ReactNode): { lang: string; code: string } {
  let target = children;
  if (Array.isArray(target)) {
    target = target.find(isValidElement) ?? target[0];
  }
  if (isValidElement(target)) {
    const props = target.props as { className?: string; children?: ReactNode };
    const lang = /language-([\w+#.-]+)/.exec(props.className ?? "")?.[1] ?? "";
    const raw = props.children;
    const code =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw.filter((c): c is string => typeof c === "string").join("")
          : "";
    return { lang, code };
  }
  if (typeof target === "string") {
    return { lang: "", code: target };
  }
  return { lang: "", code: "" };
}

/** 代码正文：流式未闭合围栏不高亮；shiki 就绪前先渲染纯文本（防布局跳动用等宽） */
function CodeBody({ code, lang }: { code: string; lang: string }) {
  const incomplete = useIsCodeFenceIncomplete();
  const appearance = useAppearance((s) => s.resolvedAppearance);
  const [lines, setLines] = useState<CodeTokenLines | null>(null);

  useEffect(() => {
    if (incomplete) return; // 流式围栏会被反复拆分/重挂载，异步高亮叠加更新有竞态（ZCode 模式）
    let alive = true;
    highlightCode(code, lang, appearance).then((tokens) => {
      if (alive) setLines(tokens);
    });
    return () => {
      alive = false;
    };
  }, [code, lang, appearance, incomplete]);

  if (lines === null) {
    return (
      <pre className="overflow-x-auto p-3 text-[12px] leading-[1.7] font-mono text-ink">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <pre className="overflow-x-auto p-3 text-[12px] leading-[1.7] font-mono text-ink">
      <code>
        {lines.map((line, i) => (
          <span key={i}>
            {line.map((t, j) => (
              <span key={j} style={t.color === undefined ? undefined : { color: t.color }}>
                {t.content}
              </span>
            ))}
            {i < lines.length - 1 ? "\n" : null}
          </span>
        ))}
      </code>
    </pre>
  );
}

function PreBlock({ children }: { children?: ReactNode }) {
  const { lang, code } = extractCode(children);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // quiet fallback
    }
  };

  return (
    <div className="group relative my-[11px] overflow-hidden rounded-md border border-line bg-card">
      <div className="flex items-center justify-between border-b border-line/60 bg-rail/50 px-3 py-1 text-[11px] font-mono text-ash">
        <span>{lang || "code"}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
          title="复制代码"
        >
          {copied ? <Check size={12} className="text-teal" /> : <Copy size={12} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <CodeBody code={code} lang={lang} />
    </div>
  );
}

/* ------------------------------------------------------------------ 入口 */

export function MarkdownContent({
  content,
  className,
  streaming = false,
}: {
  content: string;
  className?: string;
  /** 流式中：容错未闭合围栏、跳过语法高亮；完成态/历史固定 static 模式 */
  streaming?: boolean;
}) {
  return (
    <MarkdownBoundary content={content}>
      {/* 排版类挂在自己的包装层上：Streamdown 2.7.0 实测不把 className 落到
          渲染树（此前正文行距因此一路回落到 body 的 1.43，行距 token 从未生效
          —— 2026-10-28 探针实测修正） */}
      <div className={cn("text-thread text-ink", className)}>
        <Streamdown
          mode={streaming ? "streaming" : "static"}
          parseIncompleteMarkdown={streaming}
          animated={false}
          isAnimating={false}
          lineNumbers={false}
          components={components}
        >
          {content}
        </Streamdown>
      </div>
    </MarkdownBoundary>
  );
}
