## Summary

一句话面试故事：把多 Agent 的调度、检索、工具调用、降级与收尾事件归并成实时步骤时间线，让用户知道系统正在做什么，并在回复结束后保留本轮过程供回看。

## Why

当前前端只保存正在查看会话的过程事件，切换会话会清空；`EventTimeline` 逐条打印事件名和原始载荷，工具开始与结果没有配对，最终回复出现后也没有接入消息气泡。长链路看起来仍像一个不透明的加载过程，还可能把工具参数和内部错误直接显示给用户。

## What Changes

- 将过程事件按 `sessionId` 分片，使用 generation 与 seq 去重，并限制单会话事件数量。
- 增加纯函数投影层，把调度、工具、计划、压缩、降级、缓存和终态事件归并成步骤。
- 区分可恢复诊断事件与 generation 终态错误，避免提前结束仍在重试的回复。
- 在流式助手气泡中显示实时过程面板，结束后把步骤快照保留到消息。
- 过程文案只读取允许展示的字段，不渲染完整参数、地址、电话或内部错误。
- 增加投影、store、组件和聊天接入测试。

## Non-goals

- 不增加后端历史事件查询接口，不承诺刷新后恢复已结束轮次的过程。
- 不展示模型的隐藏推理文本或 chain-of-thought。
- 不改动 F7 商品卡片与引用溯源。
- 不实现 F8 的 WebSocket 重连策略。
- 不引入新的状态库、图标库或动画库。

## Capabilities

### New Capabilities

- `agent-process-timeline`: 事件分片、步骤投影、实时展示、终态快照、安全摘要和可访问折叠。

### Modified Capabilities

- `session-state-machine`: generation 事件无论会话是否处于前台都写入自己的过程分片；诊断错误不再提前结束流。

## Impact

- 前端新增过程投影模块、时间线组件测试和 store 测试。
- `ChatMessage` 增加可选过程快照，现有持久化接口保持兼容。
- `chatStore` 的两个 generation 订阅入口统一写入过程 store。
- 后端 API、数据库和路由不变。

## Risks And Mitigations

- 同名工具并行时无法精确配对：按最近运行步骤降级配对，并在文档中明确后续协议需补 `tool_call_id`。
- 事件回放重复：以 `generation_id + seq` 去重，旧事件不会生成第二份步骤。
- 长任务内存增长：忽略 `token.delta`，单会话最多保留 160 条过程事件。
- 过程载荷泄露隐私：所有文案使用字段白名单，不直接 `JSON.stringify(payload)`。
- 诊断事件误判成终态：只有带 `payload.error` 的 generation 错误结束回复，重试与漂移提醒继续等待真正终态。
