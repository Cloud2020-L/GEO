# GEO

GEO是面向品牌生成式搜索可见性与内容运营的全栈应用，提供管理端和客户端两个入口。项目围绕品牌诊断、问题与关键词管理、内容生产、分发、模型可见性监测及报告管理组织业务流程。

前端使用 React、TypeScript 和 TDesign，后端使用 Python 与 FastAPI，业务数据保存于 PostgreSQL，向量检索使用 Qdrant。后台任务支持本地线程队列，以及基于 Redis/RQ 的独立 Worker。

## 功能模块

| 模块 | 主要内容 |
| --- | --- |
| 品牌与站点诊断 | 品牌资料、基础诊断、站点抓取、技术 GEO/SEO 检查、联系方式治理 |
| 关键词与问题库 | 关键词扩展、问题生成、提示词管理及任务关联 |
| 内容生产 | 内容任务、文章生成、文章库、图片素材、内容检查与文档导出 |
| 内容分发 | 自有渠道发布、媒介集市对接、发布记录与执行状态 |
| 可见性监测 | 多模型回答对比、品牌可见性、来源偏好分析、复测与报告 |
| 运营与系统管理 | Agent 工作流、线索管理、计费与额度、用户权限、日志及可观测性 |

具体能力取决于已配置的模型服务、外部平台账号、角色权限和运行环境。

## 技术与目录

| 层级 | 主要技术 |
| --- | --- |
| 前端 | React 18、TypeScript、Vite、TDesign React、Redux Toolkit |
| API 服务 | Python、FastAPI、Uvicorn / Gunicorn |
| 数据与检索 | PostgreSQL、Qdrant |
| 后台任务 | 本地队列，或 Redis + RQ |
| 生产部署 | Docker Compose、Nginx、独立 API 与 Worker 容器 |

```text
.
├── 前端源码/zggeo-dashboard/
│   ├── src/                    # 页面、路由、组件、状态与接口调用
│   ├── tests/                  # 前端业务场景与 BDD 文档
│   ├── .env.*.example          # 不同入口的环境配置模板
│   └── package.json            # 开发、构建及检查命令
├── 后端源码/ai-service/
│   ├── app.py                  # FastAPI 应用入口
│   ├── routers/                # API 路由
│   ├── services/               # 业务服务
│   ├── tests/                  # 后端测试
│   ├── config.py               # 环境配置加载
│   └── requirements.txt        # Python 依赖
├── deploy/production/          # 生产 Compose、Nginx 与上线手册
├── scripts/                    # 构建、发布、备份、回滚及检查脚本
├── docs/                       # BDD、仓库准备与开发文档
└── Makefile                    # 本地质量检查入口
```

## 本地开发

以下示例使用 Windows PowerShell。执行前需要安装 Git、Python、Node.js 和 npm，并准备可连接的 PostgreSQL 与 Qdrant。生产 Dockerfile 使用 Python 3.12；本地可使用相同版本。前端未在 `package.json` 中固定 Node.js 的 `engines`，需使用与当前依赖兼容的版本。

本仓库保留源码和配置模板，真实环境变量、数据库备份及业务素材需要自行配置或通过私有渠道恢复。

### 1. 获取源码

```powershell
git clone https://github.com/Cloud2020-L/GEO.git
Set-Location GEO
```

### 2. 准备数据库和环境配置

先启动 PostgreSQL 与 Qdrant，并创建项目数据库和数据库账号。后端启动时会调用 `ensure_app_schema()` 初始化或补齐表结构，连接账号需要相应的建表权限及启用 `pgcrypto` 扩展的权限。

在仓库根目录执行：

```powershell
Set-Location "后端源码/ai-service"
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

编辑新建的 `.env`，按实际环境填写配置；模板中的占位值不能直接用于运行。

| 配置项 | 用途与本地配置说明 |
| --- | --- |
| `POSTGRES_DSN` | PostgreSQL 连接串，填写自己的主机、端口、数据库和凭证 |
| `QDRANT_URL` | Qdrant 地址，例如 `http://127.0.0.1:6333` |
| `QDRANT_COLLECTION` | 向量集合名称，例如 `zggeo_pages` |
| `AI_SERVICE_PORT` | API 端口，当前开发代理默认连接 `8010` |
| `JWT_SECRET` | 自行生成并填写的强随机签名密钥，可在本地 `.env` 中添加 |
| `MODEL_DEFAULT_PROVIDER` | 默认模型提供方；同时填写对应的模型名称、API Key 和必要的服务地址 |
| `TASK_QUEUE_BACKEND` | 本地开发可显式设置为 `local`；独立 Worker 使用 `redis` |
| `REDIS_URL` | 使用 Redis 队列时填写实际连接地址 |
| `CORS_ALLOW_ORIGINS` | 按前端访问地址配置；默认包含本地 `3003`、`3004` 端口 |

其余变量见后端配置模板及 `config.py`。额度有效期、令牌有效期和通知渠道也应按使用环境检查，避免直接沿用模板示例值。

### 3. 启动后端

在 `后端源码/ai-service` 目录执行：

```powershell
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8010
```

另开终端检查就绪状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8010/health/ready
```

`/health` 提供基础存活检查；`/health/ready` 检查数据库、Qdrant 与任务队列，依赖异常时返回 HTTP 503。首次启动时如数据库初始化失败，应先检查数据库是否存在、连接参数和账号权限。

### 4. 安装前端依赖并配置两个入口

在新的终端中，从仓库根目录执行：

```powershell
Set-Location "前端源码/zggeo-dashboard"
npm ci
Copy-Item .env.admin.example .env.admin
Copy-Item .env.client.example .env.client
```

将 `.env.admin` 和 `.env.client` 中的 `VITE_API_BASE_URL` 都改为 `/api/zggeo`，保留各自的 `VITE_ZGEO_PORTAL=admin` 或 `VITE_ZGEO_PORTAL=client`。

本地 Vite 会将 `/api/zggeo` 请求转发到 `http://localhost:8010`。如果修改后端端口，也需要同步修改 `vite.config.js` 中的代理地址。

在前端目录启动管理端：

```powershell
npm run dev:admin
```

客户端使用另一个终端启动；以下命令从仓库根目录执行：

```powershell
npm --prefix "前端源码/zggeo-dashboard" run dev:client
```

| 入口 | 本地地址 |
| --- | --- |
| 管理端 | `http://localhost:3003` |
| 客户端 | `http://localhost:3004` |
| API | `http://127.0.0.1:8010` |

账号权限由后端管理。现有初始化账号逻辑仍保留，部署到实际环境前需修改初始化凭证。

### 5. 使用独立任务 Worker（可选）

启用 Redis 队列时，先启动 Redis，在后端 `.env` 中配置 `TASK_QUEUE_BACKEND=redis` 与 `REDIS_URL`，再重启 API。

另开终端，进入后端目录，使用同一虚拟环境启动 Worker：

```powershell
.\.venv\Scripts\rq.exe worker zggeo --url redis://127.0.0.1:6379/0
```

示例中的队列名与 Redis 地址必须与后端配置一致。生产 Compose 已定义独立的 `ai-worker` 服务。

## 构建与部署

在前端目录分别构建两个入口：

```powershell
npm run build:admin
npm run build:client
```

产物分别输出到 `dist-admin/` 和 `dist-client/`。`VITE_API_BASE_URL` 是构建期配置，部署时需要填写实际 API 地址或反向代理路径；已经打包的静态文件不会自动读取服务器上的新环境变量。

生产配置位于 `deploy/production/`。上线前需要：

1. 从 `.env.production.example` 创建私有的 `.env.production` 并填写真实配置。
2. 将 Nginx、前端 API 地址、CORS 和健康检查地址中的示例域名替换为实际域名，准备 DNS 与 HTTPS 证书。
3. 在部署主机准备 Docker、Docker Compose、Node.js、npm，以及发布检查脚本需要的 Python 虚拟环境。
4. 在 Linux 或具备相应工具的 Bash 环境中，按手册执行发布前检查、备份和部署。

| 脚本 | 用途 |
| --- | --- |
| `scripts/preflight-production.sh` | 发布前配置、构建和数据库检查 |
| `scripts/build-production.sh` | 构建并归档管理端、客户端产物 |
| `scripts/deploy-production.sh` | 执行检查、备份、构建与服务更新 |
| `scripts/backup-postgres.sh` | 创建 PostgreSQL 备份 |
| `scripts/rollback-production.sh` | 将前端与后端恢复到指定发布版本 |

完整步骤见 [生产上线运行手册](deploy/production/上线运行手册.md)。

## 检查与测试

仓库根目录提供以下入口；`Makefile` 使用 Bash，需要相应环境和检查工具。

| 命令 | 作用 |
| --- | --- |
| `make fmt` | 格式化代码，会修改文件 |
| `make lint` | Python 与前端静态检查 |
| `make type` | Python 与 TypeScript 类型检查 |
| `make test` | 调用可用的前后端测试入口 |
| `make security` | 调用安全检查脚本 |
| `make check` | 执行组合质量检查 |

部分目标会在工具缺失时跳过检查，应阅读实际输出。前端的 `npm test` 当前只输出占位信息，不代表已执行自动化测试；业务验收场景见前端 `tests/` 和根目录 `docs/bdd/`。

后端测试使用 `unittest` 编写。安装后端依赖后，可在后端目录执行：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
```

测试与完整构建结果以实际运行输出为准。

## 配置与数据边界

- `.env`、实际生产配置、密钥、账号密码文档和浏览器会话文件保留在本地或私有配置系统中。
- 数据库备份、上传素材、日志、虚拟环境、依赖目录和构建产物不纳入版本控制。
- `.env.*.example` 仅提供配置结构；提交前确认其中没有真实凭证。
- 仓库中的 `example.com` 域名用于演示配置，需要在部署前替换。

本仓库由当前源码生成独立的首次提交，未继承原仓库历史。脱敏范围和初始检查记录见 [仓库准备说明](docs/github-preparation.md)。前端模板的许可文件位于 [前端 LICENSE](前端源码/zggeo-dashboard/LICENSE)。
