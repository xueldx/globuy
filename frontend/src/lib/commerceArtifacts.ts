import type {
  CitationSource,
  CitationSourceType,
  CommerceArtifacts,
  LandedPrice,
  ProductCard,
  TradeEvent,
} from "@/types";

const SOURCE_TYPES = new Set<CitationSourceType>([
  "catalog",
  "calculation",
  "knowledge",
  "web",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function finiteNumber(value: unknown, minimum = 0): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(nonEmptyString)
    .filter((item): item is string => item !== null);
}

export function parseCitationSource(value: unknown): CitationSource | null {
  const raw = record(value);
  if (!raw) return null;
  const sourceId = nonEmptyString(raw.source_id);
  const sourceType = nonEmptyString(raw.source_type) as CitationSourceType | null;
  const label = nonEmptyString(raw.label);
  if (!sourceId || !sourceType || !SOURCE_TYPES.has(sourceType) || !label) return null;

  const source: CitationSource = {
    source_id: sourceId,
    source_type: sourceType,
    label,
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
  };
  const fields = parseStringList(raw.fields);
  if (fields.length) source.fields = fields;
  const url = safeHttpUrl(raw.url);
  if (url) source.url = url;
  return source;
}

function parseLandedPrice(value: unknown): LandedPrice | undefined {
  const raw = record(value);
  if (!raw || nonEmptyString(raw.unavailable_reason)) return undefined;
  const shipTo = nonEmptyString(raw.ship_to);
  const currency = nonEmptyString(raw.currency);
  const subtotal = finiteNumber(raw.subtotal_major);
  const freight = finiteNumber(raw.freight_major);
  const tariff = finiteNumber(raw.tariff_major);
  const tariffRate = finiteNumber(raw.tariff_rate);
  const total = finiteNumber(raw.landed_total_major);
  if (
    !shipTo || !currency || subtotal === null || freight === null || tariff === null ||
    tariffRate === null || total === null || typeof raw.de_minimis_applied !== "boolean"
  ) return undefined;
  return {
    ship_to: shipTo,
    subtotal_major: subtotal,
    freight_major: freight,
    tariff_major: tariff,
    tariff_rate: tariffRate,
    de_minimis_applied: raw.de_minimis_applied,
    landed_total_major: total,
    currency,
  };
}

function parseSku(value: unknown): ProductCard["skus"][number] | null {
  const raw = record(value);
  if (!raw) return null;
  const skuId = nonEmptyString(raw.sku_id);
  const spec = nonEmptyString(raw.spec);
  const currency = nonEmptyString(raw.currency);
  const price = finiteNumber(raw.price_major);
  const stock = nonNegativeInteger(raw.stock);
  if (!skuId || !spec || !currency || price === null || stock === null) return null;
  return { sku_id: skuId, spec, currency, price_major: price, stock };
}

export function parseProductCard(value: unknown): ProductCard | null {
  const raw = record(value);
  if (!raw) return null;
  const productId = nonEmptyString(raw.product_id);
  const title = nonEmptyString(raw.title);
  const brand = nonEmptyString(raw.brand);
  const category = nonEmptyString(raw.category);
  const originCountry = nonEmptyString(raw.origin_country);
  const currency = nonEmptyString(raw.currency);
  const price = finiteNumber(raw.price_major);
  const score = finiteNumber(raw.score, Number.NEGATIVE_INFINITY);
  if (
    !productId || !title || !brand || !category || !originCountry || !currency ||
    price === null || score === null
  ) return null;

  const citations = Array.isArray(raw.citations)
    ? raw.citations.map(parseCitationSource).filter((item): item is CitationSource => item !== null)
    : [];
  return {
    product_id: productId,
    title,
    brand,
    category,
    origin_country: originCountry,
    price_major: price,
    currency,
    highlights: parseStringList(raw.highlights),
    skus: Array.isArray(raw.skus)
      ? raw.skus.map(parseSku).filter((item): item is ProductCard["skus"][number] => item !== null)
      : [],
    score,
    landed_price: parseLandedPrice(raw.landed_price),
    citations,
  };
}

function dedupeSources(sources: CitationSource[]): CitationSource[] {
  const byId = new Map<string, CitationSource>();
  for (const source of sources) {
    const previous = byId.get(source.source_id);
    if (!previous) {
      byId.set(source.source_id, source);
      continue;
    }
    const previousWeight = previous.summary.length + (previous.url ? 1000 : 0);
    const nextWeight = source.summary.length + (source.url ? 1000 : 0);
    if (nextWeight > previousWeight) byId.set(source.source_id, source);
  }
  return [...byId.values()];
}

function dedupeProducts(products: ProductCard[]): ProductCard[] {
  const byId = new Map<string, ProductCard>();
  for (const product of products) {
    if (!byId.has(product.product_id)) byId.set(product.product_id, product);
  }
  return [...byId.values()];
}

/**
 * 把不可信的工具事件投影成组件可直接消费的数据。
 * 单条坏数据只会被跳过，不会拖垮整条助手消息。
 */
export function projectCommerceArtifacts(events: TradeEvent[]): CommerceArtifacts {
  let latestProductHits: unknown[] | null = null;
  const answerSources: CitationSource[] = [];

  for (const event of events) {
    if (event.type !== "tool.result") continue;
    const payload = record(event.payload);
    if (!payload || payload.error) continue;
    if (payload.tool === "product_search_tool" && Array.isArray(payload.hits)) {
      latestProductHits = payload.hits;
    }
    if (Array.isArray(payload.sources)) {
      for (const value of payload.sources) {
        const source = parseCitationSource(value);
        if (source && (source.source_type === "knowledge" || source.source_type === "web")) {
          answerSources.push(source);
        }
      }
    }
  }

  return {
    products: dedupeProducts(
      (latestProductHits ?? [])
        .map(parseProductCard)
        .filter((item): item is ProductCard => item !== null),
    ),
    sources: dedupeSources(answerSources),
  };
}
