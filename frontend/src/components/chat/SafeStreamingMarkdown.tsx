import {
  Component,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  Streamdown,
  defaultRehypePlugins,
  type CodeHighlighterPlugin,
  type StreamdownTranslations,
  type UrlTransform,
} from "streamdown";
import { useRafBatchedValue } from "@/hooks/useRafBatchedValue";

const ALLOWED_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

// 不启用 raw HTML 解析。保留 Streamdown 默认的 sanitize 和 harden 两层防护。
const SECURE_REHYPE_PLUGINS = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== "raw")
  .map(([, plugin]) => plugin);

const TRANSLATIONS: Partial<StreamdownTranslations> = {
  close: "关闭",
  copied: "已复制",
  copyCode: "复制代码",
  externalLinkWarning: "即将打开外部链接",
  openExternalLink: "继续打开",
  openLink: "打开链接",
};

/**
 * 链接白名单：只允许页内锚点、站内相对路径、http(s) 与邮箱链接。
 * 图片在允许元素层直接禁用，避免远程追踪像素与 data URL 进入页面。
 */
export const safeUrlTransform: UrlTransform = (url, key) => {
  if (key === "src") return null;
  if (url.startsWith("#")) return url;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (url.startsWith("./") || url.startsWith("../")) return url;

  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
};

const LINK_SAFETY = {
  enabled: true,
  onLinkCheck: (url: string) => {
    try {
      return new URL(url, window.location.href).origin === window.location.origin;
    } catch {
      return false;
    }
  },
};

interface SafeStreamingMarkdownProps {
  content: string;
  isStreaming?: boolean;
  messageId: string;
}

/**
 * F4 的唯一 Markdown 入口。
 * 流式阶段每帧最多解析一次；结束后用原始完整文本静态重渲染，清除补全猜测。
 */
export function SafeStreamingMarkdown({
  content,
  isStreaming = false,
  messageId,
}: SafeStreamingMarkdownProps) {
  const renderedContent = useRafBatchedValue(content, !isStreaming);

  return (
    <MarkdownErrorBoundary content={content} key={messageId}>
      <MarkdownContent content={renderedContent} isStreaming={isStreaming} />
    </MarkdownErrorBoundary>
  );
}

function MarkdownContent({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const [codeHighlighter, setCodeHighlighter] = useState<CodeHighlighterPlugin | null>(null);
  const containsCodeFence = content.includes("```") || content.includes("~~~");

  useEffect(() => {
    if (isStreaming || !containsCodeFence || codeHighlighter) return;

    let active = true;
    void import("@streamdown/code")
      .then(({ code }) => {
        if (active) setCodeHighlighter(code);
      })
      .catch(() => {
        // 高亮模块失败时仍保留可读、可复制的纯文本代码块。
      });

    return () => {
      active = false;
    };
  }, [codeHighlighter, containsCodeFence, isStreaming]);

  const plugins = useMemo(
    () => (codeHighlighter ? { code: codeHighlighter } : undefined),
    [codeHighlighter],
  );

  return (
    <Streamdown
      allowedElements={ALLOWED_ELEMENTS}
      animated={false}
      caret={isStreaming ? "block" : undefined}
      className="markdown-body"
      controls={{ code: { copy: true, download: false }, mermaid: false, table: false }}
      dir="auto"
      isAnimating={isStreaming}
      lineNumbers={false}
      linkSafety={LINK_SAFETY}
      mode={isStreaming ? "streaming" : "static"}
      parseIncompleteMarkdown={isStreaming}
      plugins={plugins}
      rehypePlugins={SECURE_REHYPE_PLUGINS}
      remend={{ images: false }}
      skipHtml
      translations={TRANSLATIONS}
      urlTransform={safeUrlTransform}
    >
      {content}
    </Streamdown>
  );
}

export class MarkdownErrorBoundary extends Component<
  { children: ReactNode; content: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error("Markdown 渲染失败，已降级为纯文本", error, info);
  }

  componentDidUpdate(previousProps: Readonly<{ children: ReactNode; content: string }>) {
    if (this.state.failed && previousProps.content !== this.props.content) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return <p className="whitespace-pre-wrap break-words">{this.props.content}</p>;
    }
    return this.props.children;
  }
}
