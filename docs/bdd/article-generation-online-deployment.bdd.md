# Feature: 文章生成线上部署与超时收敛

作为系统管理员，
我希望文章生成修复可以按可回滚、可验证的方式上线，
以便线上批量生成文章不再永久卡住，并且已生成文章和积分结算保持一致。

## Background

Given 本地项目目录为 `LOCAL_PROJECT`

And 服务器 SSH 参数已配置为 `SERVER` 和 `SSH_KEY`

And 服务器项目目录为 `SERVER_PROJECT`

And Docker Compose 文件为 `COMPOSE_FILE`

And 环境变量文件为 `ENV_FILE`

And Compose 项目名为 `COMPOSE_PROJECT`

And 边缘入口服务名为 `EDGE_SERVICE`

And 公网域名为 `DOMAIN`

And API 健康检查路径为 `API_READY_PATH`

And 当前线上服务可访问

And 当前线上数据库可备份

## Scenario: 发布前必须完成本地验证

Given 本地代码包含文章生成超时收敛修复

When 执行后端文章生成任务测试

Then `tests/test_article_generation_runs_bdd.py` 应全部通过

When 执行前端 admin 和 client 构建

Then `dist-admin` 应生成成功

And `dist-client` 应生成成功

And 构建过程不应出现阻断性错误

## Scenario: 发布前必须备份线上环境

When 开始同步本地代码前

Then 系统应备份线上项目目录

And 系统应备份 PostgreSQL 数据库

And 系统应备份 `ENV_FILE`

And 系统应备份 Nginx 配置

And 系统应备份 Docker Compose 配置

And 系统应保存 `ai-service` 最近日志

And 系统应保存 `ai-worker` 最近日志

And 备份目录应记录到发布记录中

## Scenario: 服务器环境变量应支持长文章生成任务

Given 服务器环境变量文件为 `ENV_FILE`

When 检查任务队列与模型网关配置

Then `TASK_QUEUE_BACKEND` 应为 `redis`

And `TASK_QUEUE_JOB_TIMEOUT` 应大于或等于 `3600`

And `TASK_QUEUE_RESULT_TTL` 应大于或等于 `86400`

And `TASK_QUEUE_FAILURE_TTL` 应大于或等于 `604800`

And `MODEL_GATEWAY_TIMEOUT` 应大于或等于 `60`

And `MODEL_GATEWAY_RETRY_ATTEMPTS` 应大于或等于 `2`

And `GUNICORN_TIMEOUT` 应大于或等于 `180`

## Scenario: 同步代码时不得覆盖服务器专属配置

When 使用 `rsync --delete` 同步本地项目到服务器

Then 不应上传 `.git`

And 不应上传 `node_modules`

And 不应上传本地日志目录

And 不应覆盖服务器 `deploy/test`

And 不应覆盖服务器 `ENV_FILE`

And 不应覆盖服务器证书

And 不应覆盖服务器专属 Dockerfile

## Scenario: 后端服务和 Worker 应按新配置重启

Given 代码已同步到服务器

And `ENV_FILE` 已包含长任务配置

When 重新构建 `ai-service`

And 启动 `ai-service`

And 启动 `ai-worker`

Then `ai-service` 容器应处于 running 状态

And `ai-worker` 容器应处于 running 状态

And `ai-worker` 应读取与 `ai-service` 相同的 `ENV_FILE`

And Worker 日志不应出现 `JobTimeoutException`

And Worker 日志不应出现 `work-horse terminated`

## Scenario: 前端 release 应以版本化目录切换

Given 前端 `dist-admin` 和 `dist-client` 已构建完成

When 在服务器创建新的 release 目录

And 将 admin 构建产物复制到 release admin 目录

And 将 client 构建产物复制到 release client 目录

And 将 current 指向新的 release 内容

And 重启 `EDGE_SERVICE`

Then `current-frontend-release` 应记录新的 release 编号

And 管理端静态资源应从 `/admin/assets/` 加载

And 客户端静态资源应从 `/assets/` 加载

## Scenario: 部署后基础健康检查必须通过

When 部署完成后访问公网首页

Then `DOMAIN` 应返回 HTTP 200

When 访问管理端入口

Then `DOMAIN/admin/` 应返回 HTTP 200

When 访问管理端深链

Then `DOMAIN/admin/system/users` 应返回 HTTP 200

When 访问客户端深链

Then 客户端深链应返回 HTTP 200

When 访问 API ready 路径

Then `DOMAIN/API_READY_PATH` 应返回 HTTP 200

And API ready 响应中任务队列状态应为可用

## Scenario: 文章生成任务正常完成

Given 用户已登录

And 用户有足够积分

And 用户发起生成 `1` 篇文章

When 后端创建 `article_generation_runs` 记录

Then 任务状态应为 `queued`

And 系统应提交一个 Redis/RQ 后台任务

When Worker 完成模型调用并写入文章草稿

Then 任务状态应更新为 `succeeded`

And 任务阶段应更新为 `completed`

And `created_count` 应为 `1`

And `draft_ids` 应包含新文章 ID

And 系统应扣除 `50` 积分

And 前端应停止 loading

And 页面应展示生成成功提示

## Scenario: 多篇文章部分完成后 Worker 超时不应造成永久卡死

Given 用户发起生成 `10` 篇文章

And 系统已成功生成 `7` 篇文章

And 任务状态仍为 `running`

And 任务阶段为 `calling_model`

And `updated_at` 已超过系统允许的无进度时间

When 用户或前端查询该生成任务状态

Then 后端应自动将任务状态更新为 `timeout`

And 任务阶段应更新为 `timeout`

And `created_count` 应保持为 `7`

And `draft_ids` 中已生成的 `7` 篇文章应保留

And 系统应按 `7` 篇文章实际扣除积分

And 未生成的 `3` 篇不应扣费

And 前端应停止 loading

And 页面应提示任务超时或部分失败

## Scenario: 未生成任何文章的卡死任务应释放预占积分

Given 用户发起生成 `1` 篇文章

And 系统已预占 `50` 积分

And 任务状态为 `queued` 或 `running`

And `created_count` 为 `0`

And `draft_ids` 为空

And 任务已超过系统允许的无进度时间

When 查询该生成任务状态

Then 后端应自动将任务状态更新为 `timeout`

And 系统应释放本次预占积分

And 不应新增文章草稿

And 前端应停止 loading

And 用户可以重新发起生成

## Scenario: 旧卡死任务不应阻塞新生成

Given 数据库中存在相同请求指纹的旧文章生成任务

And 旧任务状态为 `running`

And 旧任务已超过系统允许的无进度时间

When 用户再次点击生成文章

Then 后端应先将旧任务标记为 `timeout`

And 后端不应复用该旧任务

And 后端应创建新的文章生成任务

And 前端应显示新的生成进度

## Scenario: 状态读取接口不应长时间阻塞

Given 用户已登录

And 数据库中存在一条文章生成任务

When 前端请求 `/content/articles/generation-runs/{run_id}`

Then 接口应在 `5` 秒内返回

And 返回体应包含 `status`

And 返回体应包含 `stage`

And 返回体应包含 `created_count`

And 返回体应包含 `requested_count`

And 返回体应包含 `draft_ids`

And 接口不应因为模型调用未完成而阻塞

## Scenario: 前端连续读取状态失败应停止无限 loading

Given 用户已发起文章生成

And 前端正在轮询生成任务状态

When 状态读取连续失败达到系统阈值

Then 页面应展示状态读取失败提示

And 生成按钮不应永久保持 loading

And 页面应保留当前任务 ID

And 用户刷新页面后仍可恢复查询任务状态

And 用户可前往文章库检查已生成文章

## Scenario: 部署后日志不应出现新增关键异常

When 部署完成后检查最近 `5` 分钟日志

Then `edge-web` 日志不应出现新增 Nginx 关键错误

And `ai-service` 日志不应出现新增 `Traceback`

And `ai-worker` 日志不应出现新增 `JobTimeoutException`

And `ai-worker` 日志不应出现任务被硬杀记录

And 如出现模型供应商超时，应被记录为业务失败或任务 timeout

## Scenario: 新版本验证失败时可以回滚

Given 新版本部署后健康检查失败

When 执行前端 release 回滚

Then `current` 应恢复到上一个 release

And `EDGE_SERVICE` 应重新加载

And 管理端和客户端入口应恢复 HTTP 200

When 回滚后端镜像

Then `ai-service` 应恢复上一可用版本

And `ai-worker` 应恢复上一可用版本

And 数据库不应被直接回滚，除非已明确执行数据库恢复流程

## Scenario: 发布记录必须完整

When 本次部署验证通过

Then 发布记录应包含备份目录

And 发布记录应包含前端 release 编号

And 发布记录应包含后端镜像版本或构建时间

And 发布记录应包含健康检查结果

And 发布记录应包含文章生成专项验证结果

And 发布记录应包含是否存在历史卡死任务及处理结果
