import { useId, useMemo, useState } from "react";
import { projectAgentProcess } from "@/lib/agentProcess";
import { useAgentProcessStore } from "@/stores/agentProcessStore";
import type { AgentProcessStatus, AgentProcessStep, AgentProcessStepStatus, TradeEvent } from "@/types";

const EMPTY_EVENTS: TradeEvent[] = [];

const STATUS_COPY: Record<AgentProcessStepStatus, string> = {
  running: "进行中",
  completed: "已完成",
  warning: "已提醒",
  failed: "失败",
  cancelled: "已停止",
};

const DOT_CLASS: Record<AgentProcessStepStatus, string> = {
  running: "border-amber-500 bg-amber-400 shadow-[0_0_0_3px_rgba(245,158,11,0.14)]",
  completed: "border-emerald-600 bg-emerald-500",
  warning: "border-amber-600 bg-amber-500",
  failed: "border-red-600 bg-red-500",
  cancelled: "border-muted bg-muted",
};

const PANEL_COPY: Record<AgentProcessStatus, { label: string; className: string }> = {
  idle: { label: "准备处理", className: "text-muted" },
  running: { label: "正在执行", className: "text-amber-700 dark:text-amber-300" },
  completed: { label: "处理完成", className: "text-emerald-700 dark:text-emerald-300" },
  cancelled: { label: "任务已停止", className: "text-muted" },
  failed: { label: "处理失败", className: "text-red-700 dark:text-red-300" },
};

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function preparingStep(): AgentProcessStep {
  return {
    id: "preparing",
    kind: "agent",
    title: "理解购物需求",
    detail: "正在准备执行计划",
    status: "running",
    startedAt: "",
  };
}

interface EventTimelineProps {
  steps: AgentProcessStep[];
  status: AgentProcessStatus;
  live?: boolean;
}

/**
 * F6 Agent 过程面板。
 * 运行时默认展开，结束后默认收起；组件只接收已脱敏步骤，不读取原始事件 payload。
 */
export default function EventTimeline({ steps, status, live = false }: EventTimelineProps) {
  const regionId = useId();
  const [expanded, setExpanded] = useState(live);
  const shownSteps = steps.length > 0 ? steps : live ? [preparingStep()] : [];
  if (shownSteps.length === 0) return null;

  const completedCount = shownSteps.filter((step) => step.status === "completed").length;
  const activeStep = [...shownSteps].reverse().find((step) => step.status === "running");
  const headline = activeStep?.title ?? PANEL_COPY[status].label;

  return (
    <section
      data-agent-process=""
      className="mb-3 w-[min(34rem,calc(100vw-3.5rem))] max-w-full overflow-hidden rounded-lg bg-background shadow-[inset_0_0_0_1px_rgb(var(--border))]"
      aria-label="Agent 执行过程"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded((current) => !current)}
        className="flex min-h-10 w-full touch-manipulation items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-[transform,background-color] duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset motion-reduce:transition-none [@media(hover:hover)]:hover:bg-foreground/[0.035]"
      >
        <span
          aria-hidden="true"
          className={`h-2.5 w-2.5 shrink-0 rounded-full border ${DOT_CLASS[activeStep?.status ?? (status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed")]} ${activeStep ? "animate-pulse motion-reduce:animate-none" : ""}`}
        />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-xs font-semibold ${PANEL_COPY[status].className}`}>
            {PANEL_COPY[status].label}
          </span>
          <span aria-live="polite" className="block truncate text-[13px] font-medium text-foreground">
            {headline}
          </span>
        </span>
        <span className="shrink-0 text-right text-[11px] tabular-nums text-muted">
          {completedCount}/{shownSteps.length}
        </span>
        <span aria-hidden="true" className="w-7 shrink-0 text-right text-xs text-muted">
          {expanded ? "收起" : "展开"}
        </span>
      </button>

      <div id={regionId} hidden={!expanded}>
        <ol className="px-3 pb-3 pt-1">
          {shownSteps.map((step, index) => {
            const duration = formatDuration(step.durationMs);
            return (
              <li key={step.id} className="relative flex gap-3 pb-3 last:pb-0">
                {index < shownSteps.length - 1 && (
                  <span aria-hidden="true" className="absolute left-[5px] top-3 h-[calc(100%-4px)] w-px bg-border" />
                )}
                <span
                  aria-hidden="true"
                  className={`relative z-[1] mt-1.5 h-3 w-3 shrink-0 rounded-full border-2 border-background ${DOT_CLASS[step.status]} ${step.status === "running" ? "animate-pulse motion-reduce:animate-none" : ""}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 break-words text-[13px] font-medium leading-5 text-foreground">
                      {step.title}
                    </span>
                    {duration && (
                      <time className="shrink-0 text-[11px] tabular-nums text-muted">{duration}</time>
                    )}
                  </div>
                  <p className="break-words text-xs leading-5 text-muted">{step.detail}</p>
                  <span className="sr-only">{STATUS_COPY[step.status]}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

export function LiveEventTimeline({ sessionId }: { sessionId: string }) {
  const events = useAgentProcessStore((state) => state.eventsBySession[sessionId] ?? EMPTY_EVENTS);
  const view = useMemo(() => projectAgentProcess(events), [events]);
  return <EventTimeline steps={view.steps} status={view.status} live />;
}
