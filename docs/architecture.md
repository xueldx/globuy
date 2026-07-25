# Globuy 架构说明

本文只描述当前有效的系统结构、运行约束和兼容性边界，不记录开发阶段或实现过程。

## 分层与依赖方向

项目采用四层结构：

```text
presentation → application → domain
       │              ↑
       └─ infrastructure ─┘
```

- `domain` 定义商品、订单、买家偏好等领域对象，以及存储和队列端口。
- `application` 编排 Use Case、Agent、工具、上下文策略和运行护栏。
- `infrastructure` 实现模型接入、向量检索、SQL/JSON 存储、Redis、Tracing 和安全组件。
- `presentation` 提供 HTTP 与 WebSocket 接口。
- `app/composition.py` 是唯一装配入口，API 和 worker 共用同一套依赖接线。

新增基础设施实现时，应先实现 `domain/**/ports/` 中的端口，再在 `composition.py` 替换装配；不要让 `domain` 反向依赖框架或存储实现。

## 运行流程

1. API 接收买家意图并建立 `ShoppingContext`。
2. MainAgent 根据需求直接调用工具，或将适合隔离、并行的任务派发给 SearchAgent / TradeAgent。
3. 商品检索依次尝试向量召回和 Reranker；依赖不可用时降级到向量排序或关键词召回。
4. 交易 Use Case 通过仓储端口保存、查询或取消订单。
5. `TradeEventBus` 汇聚 token、工具、任务和最终结果事件，并通过 WebSocket 推送给前端。
6. Redis 队列启用时，API 入队并等待独立 worker；Redis Pub/Sub 负责跨进程事件转发。

## 存储模式

- 默认：SQLite 保存会话、对话、事件、订单和偏好。
- `DATABASE_URL=file`：使用 JSON 文件存储，适合无数据库环境。
- 商品目录：当前使用内存种子数据。
- Qdrant：保存商品向量与品类知识向量；未配置服务地址时使用本地嵌入模式。
- Redis：可选地承担缓存、幂等键、任务队列、跨进程事件和共享熔断状态。

SQLite 已启用 WAL 和 `busy_timeout`，但仍适合单写者或低并发场景。多实例、高写入并发部署应迁移到服务型数据库，并使用 Alembic 等工具管理 schema。

## 不可随意改变的行为

- 写操作必须保持确认和幂等语义。
- 价格、库存、运费、关税等事实必须来自工具结果，不能由模型估算。
- `filtered_out` 必须保留过滤原因，避免模型把“被约束过滤”误报为“不存在”。
- 语义缓存不得覆盖写操作、订单查询或依赖多轮上下文的问句。
- 工具失败、模型回退和缓存命中必须通过事件显式可见。
- Prompt 核心规则、Agent workflow 和模型调用策略不得在普通工程清理中顺带修改。

## 兼容性技术命名

以下名称仍包含旧品牌字符串，但它们属于已持久化或外部可见的技术标识。本次品牌清理刻意保留它们：

| 标识 | 用途 | 直接改名的影响 |
|---|---|---|
| `GBX-*` | 订单号 | 旧订单查询、测试、缓存安全判断和外部 API 兼容性 |
| `globex.db` | 默认 SQLite 文件名 | 现有会话、订单和偏好会表现为丢失 |
| `globex_products` / `globex_category_kb` | Qdrant collection | 会切换到新空 collection |
| `globex:*` / `globex-workers` | Redis key、Stream、consumer group 和事件频道 | 新旧 API/worker 无法互通，pending 消息会遗留 |
| `globex/product/{product_id}` | Qdrant point UUID 命名空间 | 同一商品会生成不同 point ID，可能产生重复数据 |
| `globex.session` / `globex.buyer` | 浏览器 localStorage key | 现有浏览器身份和偏好关联会重置 |

后续迁移应单独设计兼容期：先支持旧标识读取，再写入新标识，完成数据回填和停机切换后才能移除旧路径。
