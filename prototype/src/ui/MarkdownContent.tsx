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
      return <p className="whitespace-pre-wrap leading-relaxed text-ink">{this.props.content}</p>;
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
 * 标题阶梯分级（对齐 mcode/TUI 的 markdownHeading 调色板与现代分级阅读）：
 * h1: 大标题 + 底部轻分割线 + 主色高光
 * h2: 二级重点分节（蓝青色，分层显著）
 * h3: 三级子议题（紫青色）
 * h4+: 紧凑加粗小标题
 */
const headingCls = [
  "mt-6 mb-3 text-[17px] font-bold text-teal dark:text-teal-tint tracking-tight border-b border-line/60 pb-1.5 flex items-center gap-1.5", // h1
  "mt-5 mb-2.5 text-[15px] font-bold text-sky-600 dark:text-sky-400 tracking-tight flex items-center gap-1.5", // h2
  "mt-4 mb-2 text-[14px] font-semibold text-indigo-600 dark:text-indigo-400 tracking-tight", // h3
  "mt-3 mb-1.5 text-[13px] font-semibold text-emerald-600 dark:text-emerald-400", // h4
  "mt-2.5 mb-1 text-[12px] font-semibold text-graphite uppercase tracking-wider", // h5
  "mt-2 mb-1 text-[12px] font-semibold text-ash uppercase tracking-wider", // h6
] as const;

const components: Components = {
  h1: ({ children }) => <h1 className={headingCls[0]}><span className="h-3 w-1 rounded-full bg-teal shrink-0" aria-hidden />{children}</h1>,
  h2: ({ children }) => <h2 className={headingCls[1]}><span className="h-2.5 w-1 rounded-full bg-sky-500 shrink-0" aria-hidden />{children}</h2>,
  h3: ({ children }) => <h3 className={headingCls[2]}>{children}</h3>,
  h4: ({ children }) => <h4 className={headingCls[3]}>{children}</h4>,
  h5: ({ children }) => <h5 className={headingCls[4]}>{children}</h5>,
  h6: ({ children }) => <h6 className={headingCls[5]}>{children}</h6>,

  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0 leading-relaxed text-ink">{children}</p>,

  // 有序列表用 list-inside：两位/三位编号在 overflow 容器里会被截断（ZCode 教训）
  ul: ({ children }) => (
    <ul className="my-2 list-outside list-disc space-y-1 pl-5 marker:text-ash">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-inside list-decimal space-y-1 marker:text-ash">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-1 text-ink [&>p]:my-0">{children}</li>,

  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line pl-3 text-graphite">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-0 border-t border-line" />,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  del: ({ children }) => <del className="text-ash line-through">{children}</del>,

  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: (props) => (
    <img
      {...props}
      loading="lazy"
      className="max-w-full rounded-btn border border-line"
      alt={props.alt ?? ""}
    />
  ),

  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-btn border border-line bg-card shadow-subtle">
      <table className="w-full border-collapse text-body-sm [&_tr:last-child>td]:border-b-0">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-rail">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-line px-3 py-2 text-left font-medium text-ink">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-line/60 px-3 py-2 align-top text-graphite">{children}</td>
  ),

  // 块级代码：pre 的唯一子元素是 <code className="language-xx">原文</code>
  pre: ({ children }) => <PreBlock>{children}</PreBlock>,

  // 行内代码（无 language- 类名的 code）
  code: ({ className, children }) => {
    if (typeof className === "string" && className.includes("language-")) {
      return <code>{children}</code>;
    }
    return (
      <code className="rounded bg-line-soft px-1.5 py-0.5 font-mono text-[0.88em] text-ink">
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
      <pre className="overflow-x-auto p-3 text-caption font-mono leading-relaxed text-ink">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <pre className="overflow-x-auto p-3 text-caption font-mono leading-relaxed text-ink">
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
    <div className="group relative my-3 overflow-hidden rounded-input border border-line bg-card shadow-subtle">
      <div className="flex items-center justify-between border-b border-line/60 bg-rail px-3 py-1.5 text-caption font-mono text-ash">
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
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        animated={false}
        isAnimating={false}
        lineNumbers={false}
        components={components}
        className={cn("text-body leading-relaxed text-ink", className)}
      >
        {content}
      </Streamdown>
    </MarkdownBoundary>
  );
}
