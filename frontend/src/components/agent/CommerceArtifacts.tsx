import { useMemo } from "react";
import { projectCommerceArtifacts } from "@/lib/commerceArtifacts";
import { useAgentProcessStore } from "@/stores/agentProcessStore";
import type { CitationSource, ProductCard, TradeEvent } from "@/types";
import ProductCards from "./ProductCards";
import SourcesPanel from "./SourcesPanel";

const EMPTY_EVENTS: TradeEvent[] = [];

export function CommerceArtifacts({ products = [], sources = [] }: { products?: ProductCard[]; sources?: CitationSource[] }) {
  if (!products.length && !sources.length) return null;
  return <div data-testid="commerce-artifacts"><ProductCards cards={products} /><SourcesPanel sources={sources} /></div>;
}

export function LiveCommerceArtifacts({ sessionId }: { sessionId: string }) {
  const events = useAgentProcessStore((state) => state.eventsBySession[sessionId] ?? EMPTY_EVENTS);
  const artifacts = useMemo(() => projectCommerceArtifacts(events), [events]);
  return <CommerceArtifacts products={artifacts.products} sources={artifacts.sources} />;
}
