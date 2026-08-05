import { describe, expect, it } from "vitest";
import { isTerminalProcessError, projectAgentProcess } from "./agentProcess";
import type { TradeEvent } from "@/types";

function event(type: TradeEvent["type"], seq: number, payload: Record<string, any> = {}): TradeEvent {
  return {
    type,
    payload,
    occurred_at: `2026-08-05T12:00:${String(seq).padStart(2, "0")}+08:00`,
    generation_id: "gen-1",
    seq,
  };
}

describe("projectAgentProcess", () => {
  it("把工具开始、业务结果和耗时结果归并成一个步骤", () => {
    const view = projectAgentProcess([
      event("tool.invoke", 1, { tool: "product_search_tool", args: { normalized_query: "通勤降噪耳机" } }),
      event("tool.result", 2, { tool: "product_search_tool", hit_count: 7 }),
      event("tool.result", 3, { tool: "product_search_tool", elapsed_ms: 1260 }),
      event("final.result", 4, { text: "结果" }),
    ]);

    expect(view.status).toBe("completed");
    expect(view.steps).toHaveLength(2);
    expect(view.steps[0]).toMatchObject({
      title: "搜索商品",
      detail: "找到 7 个候选结果",
      status: "completed",
      durationMs: 1260,
    });
    expect(view.steps[1].title).toBe("完成回答");
  });

  it("缺少 invoke 时仍保留工具结果", () => {
    const view = projectAgentProcess([
      event("tool.result", 2, { tool: "web_search_tool", hit_count: 3 }),
    ]);

    expect(view.status).toBe("running");
    expect(view.steps[0]).toMatchObject({ title: "查询跨境信息", detail: "找到 3 个候选结果" });
  });

  it("把重试和诊断错误当提醒，只有 error 字段结束任务", () => {
    const retry = event("error", 1, { message: "upstream 429", retrying: true });
    const diagnostic = event("error", 2, { message: "检测到可能的目标漂移" });
    const terminal = event("error", 3, { error: "[error] gateway failed" });

    expect(isTerminalProcessError(retry)).toBe(false);
    expect(isTerminalProcessError(diagnostic)).toBe(false);
    expect(projectAgentProcess([retry, diagnostic]).status).toBe("running");
    expect(isTerminalProcessError(terminal)).toBe(true);
    expect(projectAgentProcess([retry, terminal]).status).toBe("failed");
  });

  it("终态会收口仍在运行的步骤", () => {
    const cancelled = projectAgentProcess([
      event("agent.dispatch", 1, { agent: "search_agent", demands: "查商品" }),
      event("cancelled", 2),
    ]);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps[0].status).toBe("cancelled");
    expect(cancelled.steps.at(-1)?.title).toBe("任务已停止");
  });

  it("计划、缓存、压缩和降级事件都有稳定摘要", () => {
    const view = projectAgentProcess([
      event("plan.update", 1, { tasks: [{ state: "done" }, { state: "pending" }] }),
      event("cache.hit", 2, { similarity: 0.934, matched_query: "旧问题" }),
      event("context.compressed", 3, { context_messages: 8, summary_length: 320 }),
      event("model.fallback", 4, { from: "main", to: "backup", reason: "429" }),
    ]);

    expect(view.steps.map((step) => step.detail)).toEqual([
      "1/2 项已完成",
      "匹配度 93%",
      "保留 8 条上下文消息",
      "已改用 backup",
    ]);
    expect(view.steps.at(-1)?.status).toBe("warning");
    expect(view.completedCount).toBe(4);
  });

  it("订单参数、电话、完整地址与内部错误不会进入步骤快照", () => {
    const view = projectAgentProcess([
      event("tool.invoke", 1, {
        tool: "create_order_tool",
        args: { phone: "19327423431", shipping_address: "广州市天河区某路 1 号" },
      }),
      event("tool.result", 2, { tool: "create_order_tool", error: "SQL detail: private row" }),
      event("error", 3, { error: "traceback /srv/private.py" }),
    ]);
    const rendered = JSON.stringify(view);

    expect(rendered).not.toContain("19327423431");
    expect(rendered).not.toContain("天河区");
    expect(rendered).not.toContain("SQL detail");
    expect(rendered).not.toContain("traceback");
    expect(rendered).toContain("创建订单");
  });
});
