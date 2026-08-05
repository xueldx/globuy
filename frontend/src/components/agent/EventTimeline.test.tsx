import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectAgentProcess } from "@/lib/agentProcess";
import { useAgentProcessStore } from "@/stores/agentProcessStore";
import type { TradeEvent } from "@/types";
import EventTimeline, { LiveEventTimeline } from "./EventTimeline";

function event(type: TradeEvent["type"], seq: number, payload: Record<string, any> = {}): TradeEvent {
  return {
    type,
    payload,
    occurred_at: `2026-08-05T18:00:0${seq}+08:00`,
    generation_id: "gen-visual",
    seq,
  };
}

describe("EventTimeline", () => {
  beforeEach(() => useAgentProcessStore.getState().reset());
  afterEach(cleanup);

  it("运行中默认展开并展示当前步骤、进度和状态文字", () => {
    const view = projectAgentProcess([
      event("tool.invoke", 1, { tool: "product_search_tool", args: { normalized_query: "降噪耳机" } }),
    ]);
    render(<EventTimeline steps={view.steps} status={view.status} live />);

    const toggle = screen.getByRole("button", { name: /正在执行.*搜索商品/s });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("检索：降噪耳机")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });

  it("完成后默认收起，点击同一按钮可回看", () => {
    const view = projectAgentProcess([
      event("cache.hit", 1, { similarity: 0.92 }),
      event("final.result", 2, { text: "结果" }),
    ]);
    render(<EventTimeline steps={view.steps} status={view.status} />);

    const toggle = screen.getByRole("button", { name: /处理完成/s });
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(region).toHaveAttribute("hidden");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(region).not.toHaveAttribute("hidden");
    expect(screen.getByText("匹配度 92%")).toBeInTheDocument();
  });

  it("事件尚未到达时显示准备步骤，并响应 store 更新", () => {
    render(<LiveEventTimeline sessionId="session-a" />);
    expect(screen.getAllByText("理解购物需求")).toHaveLength(2);

    act(() => {
      useAgentProcessStore.getState().pushEvent(
        "session-a",
        event("agent.dispatch", 1, { agent: "search_agent", demands: "完整用户地址不应展示" }),
      );
    });

    expect(screen.getAllByText("调度商品检索 Agent")).toHaveLength(2);
    expect(screen.queryByText(/完整用户地址/)).not.toBeInTheDocument();
  });
});
