import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SourcesPanel from "./SourcesPanel";

describe("SourcesPanel", () => {
  it("默认折叠，展开后为安全网页链接设置隔离属性", () => {
    render(<SourcesPanel sources={[
      {
        source_id: "web:policy",
        source_type: "web",
        label: "跨境政策说明",
        summary: "用于核验当前关税口径。",
        url: "https://example.com/policy",
      },
      {
        source_id: "knowledge:guide",
        source_type: "knowledge",
        label: "旅行装备指南",
        summary: "用于判断材料与重量。",
      },
    ]} />);
    const toggle = screen.getByRole("button", { name: /回答来源.*2 条可核验资料/s });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    const link = screen.getByRole("link", { name: "跨境政策说明" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(link).toHaveAttribute("href", "https://example.com/policy");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("旅行装备指南")).toBeInTheDocument();
  });
});
