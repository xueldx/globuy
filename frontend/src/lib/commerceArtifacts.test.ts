import { describe, expect, it } from "vitest";
import type { TradeEvent } from "@/types";
import { parseCitationSource, projectCommerceArtifacts } from "./commerceArtifacts";

function event(seq: number, payload: Record<string, unknown>): TradeEvent {
  return {
    type: "tool.result",
    payload,
    occurred_at: `2026-08-07T17:00:0${seq}+08:00`,
    generation_id: "gen-f7",
    seq,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    product_id: "P1001",
    title: "旅行三件套",
    brand: "GoLight",
    category: "旅行装备",
    origin_country: "CN",
    price_major: 199,
    currency: "CNY",
    highlights: ["轻便", "抗造"],
    skus: [{ sku_id: "P1001-S1", spec: "蓝色", price_major: 199, currency: "CNY", stock: 8 }],
    score: 0.92,
    citations: [{
      source_id: "catalog:P1001",
      source_type: "catalog",
      label: "商品目录 · P1001",
      summary: "目录记录",
      fields: ["title", "price_major"],
    }],
    ...overrides,
  };
}

describe("projectCommerceArtifacts", () => {
  it("只采用最后一次成功商品结果，并逐项隔离坏数据", () => {
    const view = projectCommerceArtifacts([
      event(1, { tool: "product_search_tool", hits: [product({ product_id: "OLD" })] }),
      event(2, { tool: "product_search_tool", error: "暂时失败", hits: [product({ product_id: "BAD" })] }),
      event(3, {
        tool: "product_search_tool",
        hits: [product({ product_id: "NEW" }), product({ product_id: "BROKEN", price_major: Number.NaN })],
      }),
    ]);
    expect(view.products.map((item) => item.product_id)).toEqual(["NEW"]);
  });

  it("允许负相关度分数，并按商品 id 去重", () => {
    const view = projectCommerceArtifacts([
      event(1, {
        tool: "product_search_tool",
        hits: [product({ score: -0.1 }), product({ score: 0.5 })],
      }),
    ]);
    expect(view.products).toHaveLength(1);
    expect(view.products[0].score).toBe(-0.1);
  });

  it("过滤坏 SKU、无效到手价和危险链接，同时保留其余内容", () => {
    const view = projectCommerceArtifacts([
      event(1, {
        tool: "product_search_tool",
        hits: [product({
          skus: [{ sku_id: "bad", spec: "错误价格", price_major: -1, currency: "CNY", stock: 1 }],
          landed_price: { landed_total_major: "299" },
        })],
      }),
      event(2, {
        tool: "web_search_tool",
        sources: [{
          source_id: "web:1",
          source_type: "web",
          label: "外部资料",
          summary: "摘要",
          url: "javascript:alert(1)",
        }],
      }),
    ]);
    expect(view.products[0].skus).toEqual([]);
    expect(view.products[0].landed_price).toBeUndefined();
    expect(view.sources[0]).not.toHaveProperty("url");
  });

  it("按来源 id 去重，并优先保留带安全链接的完整项", () => {
    const view = projectCommerceArtifacts([
      event(1, {
        tool: "category_insight_tool",
        sources: [{ source_id: "knowledge:1", source_type: "knowledge", label: "选购指南", summary: "短" }],
      }),
      event(2, {
        tool: "web_search_tool",
        sources: [
          { source_id: "knowledge:1", source_type: "knowledge", label: "选购指南", summary: "更完整的摘要" },
          { source_id: "web:2", source_type: "web", label: "政策页", summary: "规则", url: "https://example.com/a" },
        ],
      }),
    ]);
    expect(view.sources).toHaveLength(2);
    expect(view.sources[0].summary).toBe("更完整的摘要");
    expect(view.sources[1].url).toBe("https://example.com/a");
  });
});

describe("parseCitationSource", () => {
  it("拒绝未知来源类型和空标识", () => {
    expect(parseCitationSource({ source_id: "", source_type: "web", label: "A" })).toBeNull();
    expect(parseCitationSource({ source_id: "x", source_type: "internal", label: "A" })).toBeNull();
  });
});
