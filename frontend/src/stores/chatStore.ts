import { create } from "zustand";
import type { ChatMessage, ChatMessageStatus, SessionSummary, SessionTurn, TradeEventType } from "@/types";
import { ApiError } from "@/lib/api";
import {
  DEMO_BUYER_ID,
  deleteSession as apiDeleteSession,
  fetchTurns,
  fetchLatestGeneration,
  listSessions,
  renameSession as apiRenameSession,
  cancelGeneration,
  createGeneration,
  subscribeGenerationWithResume,
} from "@/services/commerce";
import { useAgentProcessStore } from "./agentProcessStore";

/**
 * F3.1 会话状态机（分片 + generation 可恢复订阅 + 服务端真相源）
 *
 * 设计要点（详见 AICoding/02-会话状态机/决策.md）：
 *
 * 1. 分片：一切按 sessionId 归位。messages/流式文本/守卫消息 id/状态都是
 *    `...BySession` 记录，切会话不可能串消息——token 永远写进自己的分片。
 * 2. generation 与订阅分离：Agent 任务由服务端 generation 承载，SSE 断开可按 seq 重连，
 *    浏览器连接不再决定任务生命周期。activeStreams 只控制本页订阅，不进 zustand。
 * 3. 派生 isStreaming：statusBySession[sid] === "streaming" ⇔ 该会话在流。
 *    不做独立的 isStreaming 布尔，消灭「一个真一个假」的失同步。
 * 4. 并发上限：前端提前提示，服务端按 buyer_id 兜底；前端限制不是安全边界。
 * 5. 竞态守卫：generationId 隔离运行，seq 去重回放，messageId 锁定 UI 写入目标。
 */
export interface ChatState {
  /** 会话列表（服务端为真相源，本状态只是缓存） */
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  sessionsLoading: boolean;
  sessionsFailed: boolean;
  currentSessionId: string | null;
  /** per-session 分片：每条激活流只写自己那格的增量/文本/消息 */
  messagesBySession: Record<string, ChatMessage[]>;
  streamingMsgIdBySession: Record<string, string>;
  streamingBySession: Record<string, string>;
  statusBySession: Record<string, ChatMessageStatus | null>;
  /** 历史拉取进行中（幂等守卫的开关） */
  loadingBySession: Record<string, boolean>;
  /** 全局一次性提示（并发超限 / 删除失败等） */
  notice: string | null;
  setCurrentSession: (id: string | null) => void;
  loadSessions: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  /** 对当前会话发送意图并启动 SSE 流；被并发上限拒绝时返回 false */
  sendMessage: (rawQuery: string) => Promise<boolean>;
  /** 停止指定会话（默认当前）的生成：请求服务端取消，收到 cancelled 后再收口 UI */
  stopStream: (sessionId?: string) => void;
  /** 乐观重命名，失败回滚并返回 false */
  renameSession: (sessionId: string, title: string) => Promise<boolean>;
  /** 删除：先掐流 → 乐观移除列表 → DELETE。服务端确认（含 404 幂等）才清分片并返回 true；
   *  失败回滚列表返回 false。后端删除接口会先持久化取消请求，再执行软删。 */
  deleteSession: (sessionId: string) => Promise<boolean>;
  dismissNotice: () => void;
}

/** 并发 generation 上限：前端提前提示，服务端仍会独立校验。 */
export const MAX_CONCURRENT_STREAMS = 3;

/**
 * 删除墓碑：页生命周期内保留「正在/已经删除」的会话 id。
 * 挡住并发 loadSessions 把「DELETE 还在路上 / 刚删掉」的会话从服务端旧快照合并回列表（幽灵条目）。
 * 只存 id 字符串、只增不减，量级=一次页面会话的删除次数，可忽略；刷新即清空。
 */
const deletingIds = new Set<string>();

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function fallbackTitle(query: string): string {
  const collapsed = query.replace(/\s+/g, " ").trim();
  return collapsed.length > 30 ? `${collapsed.slice(0, 30)}…` : collapsed;
}

/** 服务端历史轮（buyer/agent）→ 前端消息（user/assistant）。id 用会话内序号稳定生成，重拉不抖。 */
function turnsToMessages(sessionId: string, turns: SessionTurn[]): ChatMessage[] {
  return turns.map((turn, index) => ({
    id: `${sessionId}:h${index}:${turn.role}`,
    role: turn.role === "buyer" ? "user" : "assistant",
    content: turn.content,
    status: "done" as const,
    createdAt: turn.created_at,
  }));
}

// ---- 不可变 record 小工具（zustand 状态不许原地改）----
function setKey<T>(map: Record<string, T>, key: string, value: T): Record<string, T> {
  return { ...map, [key]: value };
}
function delKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

/**
 * 模块级 activeStreams：不进 zustand。
 * 放进组件可见的状态会让每个无关订阅者跟着空转，而控制器本身也不可序列化。
 * devtools 可观测、HMR 安全——Map 生命周期与 store 解耦，页面关掉任务自然结束。
 */
const activeStreams = new Map<string, AbortController>();
const activeGenerations = new Map<string, { generationId: string; lastSeq: number }>();

// 一次性提示的自动熄灭定时器
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function flashNotice(set: (partial: Partial<ChatState>) => void, text: string) {
  set({ notice: text });
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => set({ notice: null }), 4000);
}

export const useChatStore = create<ChatState>((set, get) => {
  /** 把一条消息定型进它的分片并清掉流式状态（done/cancelled/error 三态唯一收口） */
  function finalizeStream(sessionId: string, messageId: string, status: ChatMessageStatus) {
    // 竞态守卫：该消息已经不是这条会话的激活流（被新消息顶替 / 会话已删除）→ 丢弃
    if (get().streamingMsgIdBySession[sessionId] !== messageId) return;
    const content = get().streamingBySession[sessionId] ?? "";
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: (s.messagesBySession[sessionId] ?? []).map((m) =>
          m.id === messageId ? { ...m, content, status } : m,
        ),
      },
      streamingBySession: delKey(s.streamingBySession, sessionId),
      streamingMsgIdBySession: delKey(s.streamingMsgIdBySession, sessionId),
      statusBySession: delKey(s.statusBySession, sessionId),
    }));
  }

  return {
    sessions: [],
    sessionsLoaded: false,
    sessionsLoading: false,
    sessionsFailed: false,
    currentSessionId: null,
    messagesBySession: {},
    streamingMsgIdBySession: {},
    streamingBySession: {},
    statusBySession: {},
    loadingBySession: {},
    notice: null,

    dismissNotice: () => set({ notice: null }),

    setCurrentSession: (id) => set({ currentSessionId: id }),

    loadSessions: async () => {
      set({ sessionsLoading: true });
      try {
        const server = await listSessions(DEMO_BUYER_ID);
        // 合并策略：服务端列表是真相源，但保留「还没被服务端收录」的本地会话
        //（刚发首轮、流还没走完持久化的新会话）——否则刷新会把正在聊的会话刷没。
        const g = get();
        const keptLocal = g.sessions.filter(
          (local) =>
            !server.some((item) => item.id === local.id) &&
            ((g.messagesBySession[local.id]?.length ?? 0) > 0 ||
              g.statusBySession[local.id] === "streaming"),
        );
        const merged = [...server, ...keptLocal]
          .filter((item) => !deletingIds.has(item.id)) // 幽灵条目守卫：删除确认前不把旧快照刷回列表
          .sort((a, b) => (b.last_active_at || "").localeCompare(a.last_active_at || ""));
        set({ sessions: merged, sessionsLoaded: true, sessionsFailed: false });
      } catch (err) {
        set({ sessionsLoaded: true, sessionsFailed: true });
        flashNotice(set, `会话列表加载失败：${(err as Error).message}`);
      } finally {
        set({ sessionsLoading: false });
      }
    },

    selectSession: async (sessionId) => {
      const state = get();
      // ① 幂等守卫：正在看同一个会话且分片已有内容 → 不重拉（顺带挡 StrictMode 双挂载）
      if (
        state.currentSessionId === sessionId &&
        (state.messagesBySession[sessionId]?.length ?? 0) > 0
      ) {
        return;
      }
      // 切换查看的会话：清空上一会话的过程事件时间线（events 无界累积防护；F6 落地时按 sessionId 归位）
      if (state.currentSessionId && state.currentSessionId !== sessionId) {
        useAgentProcessStore.getState().reset();
      }
      // ② 已有活跃流 → 本地分片就是真相（当轮还没落库，拉历史会抹掉增长中的文本）
      if (activeStreams.has(sessionId)) {
        set({ currentSessionId: sessionId });
        return;
      }
      set({ currentSessionId: sessionId });
      // 刷新/断网恢复：运行状态在服务端，不从已消失的内存 boolean 猜。
      // 从 seq=0 回放是安全的，当前页还没有消费记录；generationId+seq 双守卫会去重。
      try {
        const generation = await fetchLatestGeneration(sessionId);
        if (generation.status === "queued" || generation.status === "running" || generation.status === "cancelling") {
          const settledTurns = await fetchTurns(sessionId);
          const assistantMsg: ChatMessage = {
            id: makeId("resume"), role: "assistant", content: "", status: "streaming", createdAt: nowISO(),
          };
          set((s) => ({
            messagesBySession: setKey(
              s.messagesBySession,
              sessionId,
              [...turnsToMessages(sessionId, settledTurns), assistantMsg],
            ),
            streamingMsgIdBySession: setKey(s.streamingMsgIdBySession, sessionId, assistantMsg.id),
            streamingBySession: setKey(s.streamingBySession, sessionId, ""),
            statusBySession: setKey(s.statusBySession, sessionId, "streaming"),
          }));
          const controller = new AbortController();
          activeStreams.set(sessionId, controller);
          activeGenerations.set(sessionId, { generationId: generation.generation_id, lastSeq: 0 });
          void subscribeGenerationWithResume(generation.generation_id, 0, (event, raw) => {
            const envelope = raw as { generation_id?: string; seq?: number; payload?: unknown };
            const active = activeGenerations.get(sessionId);
            if (!active || active.generationId !== envelope.generation_id || (envelope.seq ?? 0) <= active.lastSeq) return;
            active.lastSeq = envelope.seq ?? active.lastSeq;
            if (get().streamingMsgIdBySession[sessionId] !== assistantMsg.id) return;
            const payload = envelope.payload as { token?: string; text?: string; error?: string; message?: string };
            if (event === "token.delta") {
              set((s) => ({ streamingBySession: setKey(s.streamingBySession, sessionId, (s.streamingBySession[sessionId] ?? "") + (payload.token ?? "")) }));
            } else if (event === "final.result") {
              if (payload.text) set((s) => ({ streamingBySession: setKey(s.streamingBySession, sessionId, payload.text!) }));
              finalizeStream(sessionId, assistantMsg.id, "done");
            } else if (event === "cancelled") {
              finalizeStream(sessionId, assistantMsg.id, "cancelled");
            } else if (event === "error") {
              const text = payload.error ?? payload.message;
              if (text) set((s) => ({ streamingBySession: setKey(s.streamingBySession, sessionId, text) }));
              finalizeStream(sessionId, assistantMsg.id, "error");
            }
          }, controller.signal).catch((err) => {
            if (!controller.signal.aborted && get().streamingMsgIdBySession[sessionId] === assistantMsg.id) {
              set((s) => ({ streamingBySession: setKey(s.streamingBySession, sessionId, `[interrupted] ${(err as Error).message}`) }));
              finalizeStream(sessionId, assistantMsg.id, "error");
            }
          }).finally(() => {
            if (activeStreams.get(sessionId) === controller) activeStreams.delete(sessionId);
            activeGenerations.delete(sessionId);
          });
          return;
        }
      } catch {
        // 404 表示没有活跃 generation，继续走已定型历史加载。
      }
      // ③ 历史已缓存 → 直接渲染本地
      if ((state.messagesBySession[sessionId]?.length ?? 0) > 0) return;
      // 拉取中 → 不重复发请求
      if (state.loadingBySession[sessionId]) return;

      set((s) => ({ loadingBySession: setKey(s.loadingBySession, sessionId, true) }));
      try {
        const turns = await fetchTurns(sessionId);
        // await 之后回查：期间用户又切走了 → 丢弃这份结果，不许污染别人的视图
        if (get().currentSessionId !== sessionId) return;
        set((s) => {
          const local = s.messagesBySession[sessionId] ?? [];
          // 合并而非覆盖：拉历史期间该会话可能已发出新一轮（本地分片有了刚发的消息）。
          // 服务端历史在前、本地轮在后拼接——整片覆盖会把刚发的本轮消息抹掉（历史拉取 vs 发送竞态）。
          return {
            messagesBySession: setKey(s.messagesBySession, sessionId, [
              ...turnsToMessages(sessionId, turns),
              ...local,
            ]),
          };
        });
      } catch {
        // 会话已在服务端被删/不存在：保留空分片 + 提示
        if (get().currentSessionId === sessionId) {
          flashNotice(set, "该会话已不存在（可能已被删除）");
          set((s) => ({
            messagesBySession: setKey(s.messagesBySession, sessionId, []),
            sessions: s.sessions.filter((item) => item.id !== sessionId),
          }));
        }
      } finally {
        // finally 里再回查：无论有没有切走都释放 loading，让后续 select 能重新拉
        set((s) => ({ loadingBySession: delKey(s.loadingBySession, sessionId) }));
      }
    },

    sendMessage: async (rawQuery) => {
      const query = rawQuery.trim();
      if (!query) return false;
      // 决策 D10：超限明确拒绝，不排队（排队看起来像页面死了）。
      // 用「仍在生成的消息数」而非 activeStreams.size——收尾窗口（final.result 已到但 SSE 未关）
      // activeStreams 还有条目，会短暂误拒第 4 条
      const activeGenerating = Object.values(get().streamingMsgIdBySession).filter(Boolean).length;
      if (activeGenerating >= MAX_CONCURRENT_STREAMS) {
        flashNotice(set, `同时在跑 ${MAX_CONCURRENT_STREAMS} 条 Agent 任务，请等其中一条完成后重试`);
        return false;
      }
      const state = get();
      let sessionId = state.currentSessionId;
      if (sessionId && state.statusBySession[sessionId] === "streaming") return false;

      // 新聊天（无当前会话）：客户端先占一个临时 id——服务端首轮就会用这个 id 建会话，
      // 首轮结束兜底标题写入后由 loadSessions 合并回来（见其 keptLocal 逻辑）
      let wasKnown = !!sessionId && state.sessions.some((item) => item.id === sessionId);
      if (!sessionId) {
        const placeholderId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        sessionId = placeholderId; // 闭包外完成窄化；set 回调里引用 const，避免 string|null 投诉
        const timestamp = nowISO();
        set((s) => ({
          currentSessionId: placeholderId,
          messagesBySession: setKey(s.messagesBySession, placeholderId, []),
          sessions: [
            {
              id: placeholderId,
              title: fallbackTitle(query),
              created_at: timestamp,
              last_active_at: timestamp,
            },
            ...s.sessions,
          ],
        }));
      }

      const sid = sessionId;
      const userMsg: ChatMessage = {
        id: makeId("u"),
        role: "user",
        content: query,
        status: "done",
        createdAt: nowISO(),
      };
      const assistantMsg: ChatMessage = {
        id: makeId("a"),
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: nowISO(),
      };
      set((s) => ({
        messagesBySession: {
          ...s.messagesBySession,
          [sid]: [...(s.messagesBySession[sid] ?? []), userMsg, assistantMsg],
        },
        streamingMsgIdBySession: setKey(s.streamingMsgIdBySession, sid, assistantMsg.id),
        streamingBySession: setKey(s.streamingBySession, sid, ""),
        statusBySession: setKey(s.statusBySession, sid, "streaming"),
      }));

      const controller = new AbortController();
      activeStreams.set(sid, controller);
      // 竞态守卫（per-session）：A 的 token 只写 A 的分片，且只在还是激活消息时才写
      const isActive = () => get().streamingMsgIdBySession[sid] === assistantMsg.id;

      const finalize = (status: ChatMessageStatus) => {
        finalizeStream(sid, assistantMsg.id, status);
        // 新会话首轮收流：服务端轮末才落库并写兜底标题，稍等一拍再刷新列表
        if (status === "done" && !wasKnown) {
          setTimeout(() => void get().loadSessions(), 1400);
        }
      };

      try {
        const generation = await createGeneration(sid, {
            request_id: makeId("req"),
            buyer_id: DEMO_BUYER_ID,
            locale: "zh-CN",
            currency: "CNY",
            raw_query: query,
        });
        activeGenerations.set(sid, { generationId: generation.generation_id, lastSeq: 0 });
        await subscribeGenerationWithResume(
          generation.generation_id,
          0,
          (event, raw) => {
              const envelope = raw as { generation_id?: string; seq?: number; payload?: unknown };
              const active = activeGenerations.get(sid);
              if (!active || active.generationId !== envelope.generation_id || (envelope.seq ?? 0) <= active.lastSeq) return;
              active.lastSeq = envelope.seq ?? active.lastSeq;
              const payload = envelope.payload;
              if (!isActive()) return;
              switch (event) {
                case "token.delta": {
                  const token = (payload as { token?: string }).token ?? "";
                  if (!token) return;
                  // 只更新本会话分片的文本：别的会话分片与消息列表引用都不动
                  set((s) => ({
                    streamingBySession: setKey(
                      s.streamingBySession,
                      sid,
                      (s.streamingBySession[sid] ?? "") + token,
                    ),
                  }));
                  break;
                }
                case "final.result": {
                  const text = (payload as { text?: string }).text;
                  if (typeof text === "string") {
                    set((s) => ({
                      streamingBySession: setKey(s.streamingBySession, sid, text),
                    }));
                  }
                  finalize("done");
                  break;
                }
                case "cancelled": {
                  finalize("cancelled");
                  break;
                }
                case "error": {
                  // 服务端真实错误帧用 {message}（orchestrator 校验拦截 / 异常回退）；
                  // 只有 SSE 超时的合成帧用 {error}。两个 key 都读，别让真实错误只剩空气泡。
                  const data = payload as { error?: string; message?: string };
                  const message = data.error ?? data.message;
                  if (message) {
                    set((s) => ({
                      streamingBySession: setKey(s.streamingBySession, sid, message),
                    }));
                  }
                  finalize("error");
                  break;
                }
                default:
                  // 过程事件：只喂给「当前在看的会话」的时间线（agentProcessStore 未分片，
                  // 后台流的入账是 F6 的活；这里不喂就不会串到别的会话视图）
                  if (
                    get().currentSessionId === sid &&
                    typeof payload === "object" &&
                    payload !== null
                  ) {
                    useAgentProcessStore.getState().pushEvent({
                      type: event as TradeEventType,
                      payload: payload as Record<string, unknown>,
                      occurred_at: nowISO(),
                    });
                  }
              }
          },
          controller.signal,
        );
        // 正常收流但没等来 final.result（服务端异常关闭）：统一收口
        if (isActive()) finalize(controller.signal.aborted ? "cancelled" : "done");
      } catch (err) {
        // abort（用户点停止 / 删除掐流）→ cancelled；其他（fetch 失败等）→ error
        if (!isActive()) return true;
        if (controller.signal.aborted) finalize("cancelled");
        else {
          const text =
            get().streamingBySession[sid] || `[error] ${(err as Error)?.message ?? "请求失败"}`;
          set((s) => ({ streamingBySession: setKey(s.streamingBySession, sid, text) }));
          finalize("error");
        }
      } finally {
        // 只删自己这个 controller：不误伤同会话新起的流（本版本同会话同一时刻仅一条）
        if (activeStreams.get(sid) === controller) activeStreams.delete(sid);
        activeGenerations.delete(sid);
      }
      return true;
    },

    stopStream: (sessionId) => {
      const sid = sessionId ?? get().currentSessionId;
      if (!sid) return;
      const generation = activeGenerations.get(sid);
      if (generation) {
        // 保留订阅直到收到 cancelled 终态，避免把“服务端已接受取消”误显示成“任务已停止”。
        void cancelGeneration(generation.generationId).catch((err) => {
          flashNotice(set, `取消失败：${(err as Error).message}`);
        });
      } else {
        activeStreams.get(sid)?.abort();
      }
    },

    renameSession: async (sessionId, title) => {
      const session = get().sessions.find((item) => item.id === sessionId);
      if (!session) return false;
      const previousTitle = session.title;
      // 乐观更新：标题立刻上屏，失败再回滚
      set((s) => ({
        sessions: s.sessions.map((item) => (item.id === sessionId ? { ...item, title } : item)),
      }));
      try {
        const updated = await apiRenameSession(sessionId, title);
        set((s) => ({
          sessions: s.sessions.map((item) =>
            item.id === sessionId
              ? {
                  ...item,
                  title: updated.title,
                  created_at: updated.created_at || item.created_at,
                  last_active_at: updated.last_active_at || item.last_active_at,
                }
              : item,
          ),
        }));
        return true;
      } catch (err) {
        // 失败只回滚标题（乐观更新的回滚边界）
        set((s) => ({
          sessions: s.sessions.map((item) =>
            item.id === sessionId ? { ...item, title: previousTitle } : item,
          ),
        }));
        flashNotice(set, `重命名失败：${(err as Error).message}`);
        return false;
      }
    },

    deleteSession: async (sessionId) => {
      const wasCurrent = get().currentSessionId === sessionId;
      const previousSessions = get().sessions;

      // ① 先关闭本页订阅，避免已删除会话继续更新 UI；后端 DELETE 会取消该会话的活跃 generation。
      const controller = activeStreams.get(sessionId);
      if (controller) {
        controller.abort();
        activeStreams.delete(sessionId);
      }
      // ② 墓碑：挡住 in-flight 的 loadSessions 把「刚删/删中」的会话从服务端旧快照刷回列表（幽灵条目）
      deletingIds.add(sessionId);
      // ③ 乐观移除列表 + 置空当前会话。**分片暂不清**：失败回滚后 UI 回到原样，不必重拉历史。
      set((s) => ({
        sessions: s.sessions.filter((item) => item.id !== sessionId),
        currentSessionId: wasCurrent ? null : s.currentSessionId,
      }));

      // ④ 服务端确认（含 404 幂等）后才清分片；删的是当前会话则顺带清掉它的过程时间线
      const commitRemoval = () => {
        if (wasCurrent) useAgentProcessStore.getState().reset();
        set((s) => ({
          messagesBySession: delKey(s.messagesBySession, sessionId),
          streamingMsgIdBySession: delKey(s.streamingMsgIdBySession, sessionId),
          streamingBySession: delKey(s.streamingBySession, sessionId),
          statusBySession: delKey(s.statusBySession, sessionId),
          loadingBySession: delKey(s.loadingBySession, sessionId),
        }));
      };

      try {
        await apiDeleteSession(sessionId);
      } catch (err) {
        // 404 = 服务端本就没有该会话（幂等删除），本地已移除即视为成功
        if (err instanceof ApiError && err.status === 404) {
          commitRemoval();
          return true;
        }
        // 真失败：回滚列表与当前会话；分片从没动过，回来仍是原样。已断的流不复活。
        deletingIds.delete(sessionId);
        set((s) => ({
          sessions: previousSessions,
          currentSessionId: wasCurrent && s.currentSessionId === null ? sessionId : s.currentSessionId,
        }));
        flashNotice(set, `删除失败：${(err as Error).message}`);
        return false;
      }
      commitRemoval();
      return true;
    },
  };
});
