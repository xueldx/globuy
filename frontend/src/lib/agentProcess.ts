import type {
  AgentProcessStatus,
  AgentProcessStep,
  AgentProcessStepKind,
  AgentProcessView,
  TradeEvent,
} from "@/types";
import { isTerminalGenerationEvent } from "@/lib/generationEvents";

const TOOL_LABELS: Record<string, string> = {
  product_search_tool: "搜索商品",
  web_search_tool: "查询跨境信息",
  category_insight_tool: "检索品类知识",
  create_order_tool: "创建订单",
  query_order_tool: "查询订单",
  cancel_order_tool: "取消订单",
  remember_preference_tool: "记录购物偏好",
  forget_preference_tool: "删除购物偏好",
  task_dispatch: "子 Agent 执行任务",
};

const AGENT_LABELS: Record<string, string> = {
  search_agent: "商品检索 Agent",
  trade_agent: "交易 Agent",
};

interface MutableStep extends AgentProcessStep {
  matchKey?: string;
}

function text(value: unknown, maxLength = 52): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function eventId(event: TradeEvent, index: number): string {
  if (event.generation_id && Number.isSafeInteger(event.seq)) {
    return `${event.generation_id}:${event.seq}`;
  }
  return `${event.type}:${event.occurred_at}:${index}`;
}

export function processEventIdentity(event: TradeEvent): string | null {
  if (!event.generation_id || !Number.isSafeInteger(event.seq)) return null;
  return `${event.generation_id}:${event.seq}`;
}

export function isTerminalProcessError(event: TradeEvent): boolean {
  return event.type === "error" && isTerminalGenerationEvent(event.type, event.payload);
}

function toolLabel(tool: unknown): string {
  const key = text(tool, 80);
  return TOOL_LABELS[key] ?? "执行工具";
}

function toolDetail(tool: string, payload: Record<string, any>, result: boolean): string {
  if (result) {
    const hitCount = number(payload.hit_count);
    if (hitCount !== undefined) return `找到 ${Math.max(0, Math.trunc(hitCount))} 个候选结果`;
    if (payload.order) return "订单操作已完成";
    if (payload.saved) return "购物偏好已更新";
    if (payload.deleted || payload.forgotten) return "购物偏好已删除";
    if (payload.circuit) return "工具暂时不可用，已停止本次调用";
    if (payload.error) return "本步骤未完成";
    if (number(payload.elapsed_ms) !== undefined) return "工具调用已返回";
    return "工具调用已完成";
  }

  const args = payload.args && typeof payload.args === "object" ? payload.args as Record<string, unknown> : {};
  if (tool === "web_search_tool") {
    const query = text(args.query);
    return query ? `搜索：${query}` : "查询公开跨境信息";
  }
  if (tool === "product_search_tool") {
    const query = text(args.query ?? args.raw_query ?? args.keyword);
    return query ? `检索：${query}` : "按预算与偏好筛选商品";
  }
  if (tool === "category_insight_tool") {
    const question = text(args.question);
    return question ? `查询：${question}` : "读取品类与选购知识";
  }
  if (["create_order_tool", "query_order_tool", "cancel_order_tool"].includes(tool)) {
    return "校验订单状态与必要信息";
  }
  if (["remember_preference_tool", "forget_preference_tool"].includes(tool)) {
    return "更新本次购物偏好";
  }
  return "正在处理当前步骤";
}

function elapsedBetween(startedAt: string, completedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function findLastStepIndex(steps: MutableStep[], predicate: (step: MutableStep) => boolean): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (predicate(steps[index])) return index;
  }
  return -1;
}

function completeRunningSteps(
  steps: MutableStep[],
  status: "completed" | "failed" | "cancelled",
  completedAt: string,
) {
  for (const step of steps) {
    if (step.status !== "running") continue;
    step.status = status;
    step.completedAt = completedAt;
    step.durationMs ??= elapsedBetween(step.startedAt, completedAt);
  }
}

function addInstantStep(
  steps: MutableStep[],
  event: TradeEvent,
  index: number,
  kind: AgentProcessStepKind,
  title: string,
  detail: string,
  status: "completed" | "warning" | "failed" | "cancelled" = "completed",
) {
  steps.push({
    id: eventId(event, index),
    kind,
    title,
    detail,
    status,
    startedAt: event.occurred_at,
    completedAt: event.occurred_at,
  });
}

/**
 * 把后端协议事件投影成用户可读步骤。
 *
 * 这里故意只输出白名单文案。原始 payload 可能带地址、电话或内部错误，
 * UI 不应接触 `JSON.stringify(payload)` 的结果。
 */
export function projectAgentProcess(events: TradeEvent[]): AgentProcessView {
  const steps: MutableStep[] = [];
  let status: AgentProcessStatus = "idle";

  events.forEach((event, index) => {
    if (event.type === "token.delta") return;
    if (status === "idle") status = "running";
    const payload = event.payload ?? {};

    switch (event.type) {
      case "task.queued":
        steps.push({
          id: eventId(event, index),
          kind: "queue",
          title: "等待任务处理",
          detail: "请求已进入执行队列",
          status: "running",
          startedAt: event.occurred_at,
          matchKey: "queue",
        });
        break;
      case "task.started": {
        const queueStep = [...steps].reverse().find((step) => step.matchKey === "queue" && step.status === "running");
        if (queueStep) {
          queueStep.status = "completed";
          queueStep.completedAt = event.occurred_at;
          queueStep.durationMs = elapsedBetween(queueStep.startedAt, event.occurred_at);
        }
        addInstantStep(steps, event, index, "queue", "开始处理", "Agent 已领取任务");
        break;
      }
      case "agent.dispatch": {
        const agent = text(payload.agent, 80);
        steps.push({
          id: eventId(event, index),
          kind: "agent",
          title: `调度${AGENT_LABELS[agent] ?? "子 Agent"}`,
          detail: "已接管当前子任务",
          status: "running",
          startedAt: event.occurred_at,
          matchKey: `agent:${agent}`,
        });
        break;
      }
      case "tool.invoke": {
        const tool = text(payload.tool, 80);
        steps.push({
          id: eventId(event, index),
          kind: "tool",
          title: toolLabel(tool),
          detail: toolDetail(tool, payload, false),
          status: "running",
          startedAt: event.occurred_at,
          matchKey: `tool:${tool}`,
        });
        break;
      }
      case "tool.result": {
        const tool = text(payload.tool, 80);
        const agent = text(payload.agent, 80);
        const matchKey = tool === "task_dispatch" && agent ? `agent:${agent}` : `tool:${tool}`;
        const matchingIndex = findLastStepIndex(
          steps,
          (step) => step.matchKey === matchKey && step.status === "running",
        );
        const previousIndex = matchingIndex >= 0
          ? matchingIndex
          : findLastStepIndex(
              steps,
              (step) => step.matchKey === matchKey && step.status === "completed",
            );
        const failed = Boolean(payload.error || payload.circuit);
        const elapsedMs = number(payload.elapsed_ms);
        if (previousIndex >= 0) {
          const step = steps[previousIndex];
          step.status = failed ? "failed" : "completed";
          step.completedAt = event.occurred_at;
          step.durationMs = elapsedMs ?? step.durationMs ?? elapsedBetween(step.startedAt, event.occurred_at);
          const nextDetail = toolDetail(tool, payload, true);
          if (nextDetail !== "工具调用已返回" || step.detail === "正在处理当前步骤") {
            step.detail = nextDetail;
          }
        } else {
          addInstantStep(
            steps,
            event,
            index,
            tool === "task_dispatch" ? "agent" : "tool",
            tool === "task_dispatch" ? `完成${AGENT_LABELS[agent] ?? "子 Agent"}任务` : toolLabel(tool),
            toolDetail(tool, payload, true),
            failed ? "failed" : "completed",
          );
        }
        break;
      }
      case "plan.update": {
        const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        const completed = tasks.filter((task) => task && ["done", "completed"].includes(String(task.state))).length;
        addInstantStep(
          steps,
          event,
          index,
          "plan",
          "更新任务计划",
          tasks.length ? `${completed}/${tasks.length} 项已完成` : "任务清单已更新",
        );
        break;
      }
      case "context.compressed": {
        const contextMessages = number(payload.context_messages);
        addInstantStep(
          steps,
          event,
          index,
          "context",
          "整理对话上下文",
          contextMessages === undefined ? "已压缩早期对话" : `保留 ${Math.max(0, Math.trunc(contextMessages))} 条上下文消息`,
        );
        break;
      }
      case "model.fallback":
        addInstantStep(
          steps,
          event,
          index,
          "fallback",
          "切换备用模型",
          payload.to ? `已改用 ${text(payload.to, 32)}` : "主模型暂时不可用，已自动降级",
          "warning",
        );
        break;
      case "cache.hit": {
        const similarity = number(payload.similarity);
        addInstantStep(
          steps,
          event,
          index,
          "cache",
          "复用相似问题结果",
          similarity === undefined ? "已命中语义缓存" : `匹配度 ${Math.round(similarity * 100)}%`,
        );
        break;
      }
      case "final.result":
        completeRunningSteps(steps, "completed", event.occurred_at);
        addInstantStep(steps, event, index, "response", "完成回答", "结果已整理并返回");
        status = "completed";
        break;
      case "cancelled":
        completeRunningSteps(steps, "cancelled", event.occurred_at);
        addInstantStep(steps, event, index, "notice", "任务已停止", "保留停止前已经完成的步骤", "cancelled");
        status = "cancelled";
        break;
      case "error":
        if (isTerminalProcessError(event)) {
          completeRunningSteps(steps, "failed", event.occurred_at);
          addInstantStep(steps, event, index, "notice", "任务处理失败", "请稍后重试或调整购物需求", "failed");
          status = "failed";
        } else {
          addInstantStep(
            steps,
            event,
            index,
            "notice",
            payload.retrying ? "服务波动，正在重试" : "执行过程提醒",
            payload.retrying ? "当前任务仍在继续" : "已记录异常并继续处理",
            "warning",
          );
        }
        break;
      default:
        break;
    }
  });

  const safeSteps = steps.map(({ matchKey: _matchKey, ...step }) => step);
  const active = [...safeSteps].reverse().find((step) => step.status === "running");
  const activeLabel = active?.title ?? {
    idle: "等待开始",
    running: "正在处理",
    completed: "处理完成",
    cancelled: "任务已停止",
    failed: "处理失败",
  }[status];

  return {
    steps: safeSteps,
    status,
    completedCount: safeSteps.filter((step) => step.status === "completed").length,
    activeLabel,
  };
}
