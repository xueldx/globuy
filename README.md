# Globuy

Globuy 是一个面向跨境电商购物场景的多 Agent 助手。买家可以用自然语言提出选购、比价和下单需求，系统会完成品类知识检索、商品召回、到手价计算、订单操作与偏好记忆，并通过 WebSocket 实时展示执行过程。

## 主要能力

- **统一购物入口**：MainAgent 理解需求并决定直接处理或派发给检索、交易子 Agent。
- **商品检索**：embedding + Qdrant 向量召回，可选 Reranker 精排；外部依赖不可用时降级到关键词召回。
- **跨境计价**：结合收货国家、汇率、运费和关税规则返回到手价。
- **交易操作**：创建、查询和取消订单；写操作保留确认与幂等保护。
- **长期偏好**：记录和撤回买家偏好，并在后续会话中按相关性注入。
- **品类知识库**：将 `knowledge/*.md` 切片后写入 Qdrant，为品类选择和跨境规则提供依据。
- **工程保护**：上下文压缩、Token 预算、工具超时与熔断、内容过滤、输出脱敏、模型限流与回退。
- **异步削峰**：可选 Redis Stream 队列、独立 worker 和跨进程事件背板。

## 技术栈

- Python 3.11、AgentScope 2.x、FastAPI、Uvicorn
- SQLite / SQLAlchemy async，或 JSON 文件存储
- Qdrant、OpenAI 兼容 Embedding、可选 HTTP Reranker
- 可选 Redis 缓存、队列与 Pub/Sub
- React 18、TypeScript、Vite
- Docker Compose

## 项目结构

```text
app/
├── domain/            # 领域对象和存储端口
├── application/       # Use Case、工具、Agent、提示词与运行护栏
├── infrastructure/    # 模型、检索、存储、缓存、队列、可观测与安全实现
├── presentation/      # FastAPI、WebSocket 和 DTO
├── composition.py     # API 与 worker 共用的装配入口
└── worker.py          # Redis Stream 消费进程
frontend/              # React + Vite 前端
knowledge/             # 启动时写入知识库的 Markdown 文档
eval/                  # 回归和召回评测数据
scripts/               # 冒烟、并行、负载和评测工具
tests/                 # 自动化测试
docker/                # Docker Compose 配置
docs/                  # 稳定的维护文档
```

更完整的模块关系、运行模式和兼容性命名见 [架构说明](docs/architecture.md)。

## 本地开发

### 环境要求

- Python 3.11
- [uv](https://docs.astral.sh/uv/)
- Node.js 18 或更高版本，以及 npm
- OpenAI 兼容的大模型接口地址和 API Key

### 启动后端

在项目根目录执行：

```bash
uv sync
cp .env.example .env
```

PowerShell 可使用：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少配置：

```dotenv
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_API_KEY=your-api-key
```

启动 API：

```bash
uv run uvicorn app.presentation.server:app --host 0.0.0.0 --port 8000
```

未配置 `REDIS_URL` 时，缓存和队列自动关闭；未配置 `QDRANT_URL` 时，Qdrant 使用本地嵌入模式。

### 启动前端

```bash
cd frontend
npm ci
npm run dev
```

浏览器访问 `http://localhost:5173`。后端默认地址为 `http://localhost:8000`，需要覆盖时设置 `VITE_API_BASE`。

### 启动 worker

启用 Redis 队列时，在另一个终端执行：

```bash
uv run python -m app.worker
```

## 常用配置

| 环境变量 | 作用 | 默认行为 |
|---|---|---|
| `LLM_BASE_URL` / `LLM_API_KEY` | OpenAI 兼容模型网关 | API Key 缺失时拒绝启动 |
| `LLM_MODEL` / `LLM_FALLBACK_MODEL` | 主模型与限流回退模型 | 见 `.env.example` |
| `EMBEDDING_*` | 向量模型 | 缺省复用 LLM 网关 |
| `QDRANT_URL` | Qdrant 服务地址 | 空值使用本地嵌入模式 |
| `RERANKER_BASE_URL` | 精排服务 | 空值使用向量排序 |
| `DATABASE_URL` | 持久化数据库 | 空值使用本地 SQLite；`file` 使用 JSON 文件 |
| `REDIS_URL` | 缓存、队列和事件背板 | 空值关闭 Redis 能力 |
| `QUEUE_ENABLED` | 是否使用 Redis Stream 队列 | Redis 不可用时自动直跑 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP Trace 导出 | 空值关闭 |

完整配置及默认值以 `app/infrastructure/settings.py` 和 `.env.example` 为准。

## API

- `POST /commerce/intents`：提交买家意图并等待最终结果
- `POST /commerce/intents/async`：异步提交任务
- `GET /commerce/tasks/{task_id}`：查询异步任务状态
- `WS /commerce/events`：订阅会话事件流
- `GET /commerce/orders/{order_id}`：查询订单
- `POST /commerce/orders/{order_id}/cancel`：取消订单
- `GET /health`：健康检查

## 验证

```bash
uv run pytest -q
uv run python scripts/eval/validate_datasets.py
```

```bash
cd frontend
npm ci
npm run build
```

需要已启动服务或真实模型凭据的验证：

```bash
uv run python scripts/smoke_e2e.py
uv run python scripts/verify_parallel.py
uv run python scripts/eval_regression.py
uv run python scripts/loadtest.py --base-url http://localhost:8000 --stages 5,10,20
```

## Docker

```bash
export LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
export LLM_API_KEY=your-api-key
docker compose -f docker/docker-compose.yaml up -d --build
```

Compose 会启动 API、worker、Redis、Qdrant 和前端。SQLite 数据保存在 Docker volume 中。

## 当前边界

- 默认商品目录来自种子数据，尚未使用独立商品数据库。
- SQLite 适合本地和低并发运行；高并发部署应迁移到服务型数据库并引入正式 schema migration。
- Reranker、Redis、OTLP 和联网搜索均为可选能力。
- 模型与提示词变化会自动改变语义缓存 namespace，避免复用旧行为生成的回复。

## License

本仓库当前未声明许可证。公开发布或向第三方分发前，请补充与你的代码权利来源一致的许可证及必要 attribution。
