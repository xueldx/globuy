## Summary

一句话面试故事：为动态高度、持续流式增长的 AI 消息接入虚拟窗口，并用显式滚动状态机区分自动跟随和用户阅读，让长会话保持少量 DOM 且不抢滚动。

## Why

当前聊天页会渲染全部消息，并在每次流式文本变化时无条件滚到底部。会话变长后，DOM、布局和 Markdown 渲染开销随消息总数增长；用户上滑阅读历史时还会被新 token 强制拉回底部。F5 需要同时解决长列表性能与阅读位置稳定性。

## What Changes

- 引入开源 `react-virtuoso`，用动态高度虚拟列表替换 `messages.map` 全量渲染。
- 以稳定消息 id 作为 item key，并为上下方向配置差异化 overscan。
- 建立 `FOLLOWING / USER_READING / RESTORING` 滚动状态机。
- 用户接近底部时跟随新增消息和流式高度增长；用户离开底部后保持阅读位置。
- 增加“回到最新”控制和可访问状态文案。
- 增加虚拟范围、动态高度、流式跟随、用户上滑和会话切换测试。

## Non-goals

- 不实现历史消息向上分页加载和服务端分页协议。
- 不实现 DOM recycling pool，不把 React reconciliation 描述成节点池复用。
- 不修改 SSE、消息 schema、Markdown 渲染和后端接口。
- 不引入商业授权的 `@virtuoso.dev/message-list`。
- 不添加性能调试面板或长期可见的开发指标。

## Capabilities

### New Capabilities

- `virtualized-message-list`: 动态高度消息虚拟化、overscan、稳定 item key、底部跟随、用户阅读保护和恢复滚动。

### Modified Capabilities

- 无。

## Impact

- 前端新增 `react-virtuoso` 运行时依赖。
- `ChatPage` 将消息渲染与滚动控制移入独立 `VirtualMessageList` 组件。
- 新增组件测试和 1,000 条消息的 DOM 数量验证。
- 后端 API、持久化数据和路由不变。

## Risks And Mitigations

- 动态高度修正造成跳动：仅在跟随态响应列表总高度变化，用户阅读态不执行程序化滚动。
- 流式增长触发过多滚动：复用 F2 的 rAF 文本合并，列表高度变化再按动画帧合并贴底。
- 高速滚动出现空白：配置上下 overscan，并用长列表测试限制实际 DOM 数量。
- 会话切换继承旧滚动状态：以 `sessionId` 作为列表实例 key，切换时重建测量与滚动状态。
- 第三方升级改变行为：锁定安装版本，关键滚动契约由项目测试覆盖。
