import { useId, useState } from "react";
import type { CitationSource, ProductCard } from "@/types";

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

const FIELD_LABELS: Record<string, string> = {
  title: "商品名称", brand: "品牌", category: "品类", origin_country: "产地",
  price_major: "商品价格", highlights: "商品亮点", skus: "规格与库存", landed_price: "到手价",
};

function CardEvidence({ sources }: { sources: CitationSource[] }) {
  const [expanded, setExpanded] = useState(false);
  const reactId = useId();
  if (!sources.length) return null;
  const panelId = `product-evidence-${reactId.replace(/:/g, "")}`;

  return (
    <div className="mt-3 border-t border-border/70 pt-2.5">
      <button
        type="button"
        aria-controls={panelId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-10 w-full touch-manipulation items-center justify-between gap-3 rounded-md px-1 text-left text-xs font-medium text-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none [@media(hover:hover)]:hover:text-foreground"
      >
        <span>查看商品依据 · {sources.length}</span>
        <span aria-hidden="true" className={`text-base transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-45" : ""}`}>+</span>
      </button>
      {expanded && (
        <ul id={panelId} className="space-y-2 pb-1 pt-1" aria-label="商品信息依据">
          {sources.map((source) => (
            <li key={source.source_id} className="rounded-md bg-surface px-2.5 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-foreground">{source.label}</span>
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted">
                  {source.source_type === "calculation" ? "计算依据" : "目录事实"}
                </span>
              </div>
              {source.summary && <p className="mt-1 break-words leading-5 text-muted">{source.summary}</p>}
              {source.fields && source.fields.length > 0 && (
                <p className="mt-1 text-[11px] leading-5 text-muted">
                  支撑字段：{source.fields.map((field) => FIELD_LABELS[field] ?? field).join("、")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProductItem({ card }: { card: ProductCard }) {
  const landed = card.landed_price;
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-border bg-background/70 p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <header>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{card.brand}</span>
          <span>{card.category}</span><span aria-hidden="true">·</span><span>{card.origin_country} 发货</span>
        </div>
        <h3 className="mt-2 break-words text-[15px] font-semibold leading-6 text-foreground">{card.title}</h3>
      </header>

      <div className="mt-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted">商品价</p>
        <p className="mt-0.5 text-2xl font-semibold tracking-tight text-foreground">{formatMoney(card.price_major, card.currency)}</p>
      </div>

      {landed && (
        <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-primary">预计到手价 · {landed.ship_to}</span>
            <strong className="text-base text-foreground">{formatMoney(landed.landed_total_major, landed.currency)}</strong>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-muted">
            商品 {formatMoney(landed.subtotal_major, landed.currency)} + 运费 {formatMoney(landed.freight_major, landed.currency)} + 关税 {formatMoney(landed.tariff_major, landed.currency)}
            {landed.de_minimis_applied ? " · 免税额度内" : ""}
          </p>
        </div>
      )}

      {card.highlights.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="商品亮点">
          {card.highlights.slice(0, 4).map((highlight) => (
            <li key={highlight} className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] leading-4 text-muted">{highlight}</li>
          ))}
        </ul>
      )}

      {card.skus.length > 0 && (
        <div className="mt-3 space-y-1.5" aria-label="可选规格">
          {card.skus.slice(0, 3).map((sku) => (
            <div key={sku.sku_id} className="flex min-w-0 items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-foreground" title={sku.spec}>{sku.spec}</span>
              <span className="shrink-0 text-muted">{formatMoney(sku.price_major, sku.currency)} · 库存 {sku.stock}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto"><CardEvidence sources={card.citations} /></div>
    </article>
  );
}

export default function ProductCards({ cards }: { cards: ProductCard[] }) {
  if (!cards.length) return null;
  return (
    <section className="mt-4" aria-label="商品结果">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">可比较的商品</h2>
        <span className="text-xs text-muted">{cards.length} 件结果</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{cards.map((card) => <ProductItem key={card.product_id} card={card} />)}</div>
    </section>
  );
}
