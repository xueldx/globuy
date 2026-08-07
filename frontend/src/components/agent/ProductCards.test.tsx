import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProductCard } from "@/types";
import ProductCards from "./ProductCards";

const baseCard: ProductCard = {
  product_id: "P1001",
  title: "GoLight 超长名称旅行收纳三件套",
  brand: "GoLight",
  category: "旅行装备",
  origin_country: "CN",
  price_major: 199,
  currency: "CNY",
  highlights: ["轻便", "耐磨", "可折叠"],
  skus: [{ sku_id: "P1001-S1", spec: "海盐蓝超长规格名称", price_major: 199, currency: "CNY", stock: 8 }],
  score: 0.92,
  citations: [{
    source_id: "catalog:P1001",
    source_type: "catalog",
    label: "商品目录 · P1001",
    summary: "目录记录：GoLight 旅行收纳三件套",
    fields: ["title", "price_major"],
  }],
};

describe("ProductCards", () => {
  it("突出价格与规格，并可展开字段级商品依据", () => {
    render(<ProductCards cards={[baseCard]} />);
    expect(screen.getByRole("region", { name: "商品结果" })).toBeInTheDocument();
    expect(screen.getByText("GoLight 超长名称旅行收纳三件套")).toBeInTheDocument();
    expect(screen.getAllByText(/¥199/)).toHaveLength(2);
    expect(screen.getByText(/库存 8/)).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /查看商品依据/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("商品目录 · P1001")).toBeInTheDocument();
    expect(screen.getByText("支撑字段：商品名称、商品价格")).toBeInTheDocument();
  });

  it("有到手价时展示拆分，无到手价时不渲染误导占位", () => {
    render(<ProductCards cards={[
      {
        ...baseCard,
        landed_price: {
          ship_to: "US",
          subtotal_major: 28,
          freight_major: 8,
          tariff_major: 2,
          tariff_rate: 0.07,
          de_minimis_applied: false,
          landed_total_major: 38,
          currency: "USD",
        },
      },
      { ...baseCard, product_id: "P1002", title: "没有到手价的商品", citations: [] },
    ]} />);
    expect(screen.getByText("预计到手价 · US")).toBeInTheDocument();
    expect(screen.getByText(/商品 US\$28.*运费 US\$8.*关税 US\$2/)).toBeInTheDocument();
    expect(screen.getAllByText(/预计到手价/)).toHaveLength(1);
  });
});
