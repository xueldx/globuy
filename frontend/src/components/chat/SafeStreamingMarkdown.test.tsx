import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MarkdownErrorBoundary,
  SafeStreamingMarkdown,
  safeUrlTransform,
} from "./SafeStreamingMarkdown";

describe("safeUrlTransform", () => {
  const transform = (url: string, key = "href") =>
    safeUrlTransform(url, key, {} as Parameters<typeof safeUrlTransform>[2]);

  it.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["http://example.com", "http://example.com"],
    ["mailto:test@example.com", "mailto:test@example.com"],
    ["/orders/1", "/orders/1"],
    ["./help", "./help"],
    ["../help", "../help"],
    ["#result", "#result"],
  ])("保留允许的链接 %s", (url, expected) => {
    expect(transform(url)).toBe(expected);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "vbscript:msgbox(1)", "//evil.test"])(
    "移除危险链接 %s",
    (url) => {
      expect(transform(url)).toBeNull();
    },
  );

  it("拒绝所有图片来源", () => {
    expect(transform("https://example.com/tracker.gif", "src")).toBeNull();
  });
});

describe("SafeStreamingMarkdown", () => {
  it("渲染常用 Markdown，并且不生成原始 HTML、脚本或远程图片", () => {
    const { container } = render(
      <SafeStreamingMarkdown
        content={`## 推荐\n\n- 耳机\n- 键盘\n\n| 商品 | 价格 |\n| --- | ---: |\n| A | 99 |\n\n<script>alert(1)</script>\n\n<img src="https://evil.test/pixel.gif" onerror="alert(1)">`}
        messageId="safe"
      />,
    );

    expect(screen.getByRole("heading", { name: "推荐", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("耳机")).toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });

  it("在真实 Markdown 管线中保留安全操作并移除危险链接", () => {
    render(
      <SafeStreamingMarkdown
        content={"[站内帮助](/help) [安全站点](https://example.com) [危险链接](javascript:alert(1))"}
        messageId="links"
      />,
    );

    // linkSafety 会把链接包装为按钮，再决定同源直达或外链确认，DOM 不暴露 href。
    expect(screen.getByRole("button", { name: "站内帮助" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安全站点" })).toBeInTheDocument();
    expect(screen.queryByText("危险链接")).not.toBeInTheDocument();
  });

  it("流式阶段容忍未闭合的强调与代码围栏", () => {
    const { container } = render(
      <SafeStreamingMarkdown
        content={"**正在生成\n\n```ts\nconst price = 99"}
        isStreaming
        messageId="streaming"
      />,
    );

    expect(screen.getByText(/正在生成/)).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeInTheDocument();
  });

  it("渲染器抛错时只让当前消息降级为纯文本", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const BrokenRenderer = () => {
      throw new Error("fixture");
    };

    render(
      <MarkdownErrorBoundary content="保留原文">
        <BrokenRenderer />
      </MarkdownErrorBoundary>,
    );

    expect(screen.getByText("保留原文")).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
