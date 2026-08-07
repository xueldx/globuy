import { useId, useState } from "react";
import type { CitationSource } from "@/types";

const SOURCE_LABEL = { knowledge: "知识库", web: "网页", catalog: "目录", calculation: "计算" } as const;

export default function SourcesPanel({ sources }: { sources: CitationSource[] }) {
  const [expanded, setExpanded] = useState(false);
  const reactId = useId();
  if (!sources.length) return null;
  const panelId = `answer-sources-${reactId.replace(/:/g, "")}`;

  return (
    <section className="mt-3 rounded-lg border border-border bg-background/50">
      <button
        type="button"
        aria-controls={panelId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-10 w-full touch-manipulation items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none [@media(hover:hover)]:hover:bg-surface"
      >
        <span><span className="text-xs font-semibold text-foreground">回答来源</span><span className="ml-2 text-[11px] text-muted">{sources.length} 条可核验资料</span></span>
        <span aria-hidden="true" className={`text-base text-muted transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-45" : ""}`}>+</span>
      </button>
      {expanded && (
        <ol id={panelId} className="space-y-2 border-t border-border px-3 py-3">
          {sources.map((source, index) => (
            <li key={source.source_id} className="flex gap-2.5 text-xs">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {source.url ? (
                    <a href={source.url} target="_blank" rel="noopener noreferrer" className="break-words font-medium text-foreground underline decoration-border underline-offset-2 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [@media(hover:hover)]:hover:text-primary">{source.label}</a>
                  ) : <span className="break-words font-medium text-foreground">{source.label}</span>}
                  <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted">{SOURCE_LABEL[source.source_type]}</span>
                </div>
                {source.summary && <p className="mt-1 break-words leading-5 text-muted">{source.summary}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
