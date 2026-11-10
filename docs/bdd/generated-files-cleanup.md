# 可再生临时文件清理 BDD

```gherkin
# language: zh-CN
功能: 可再生临时文件清理

  作为项目维护者
  我希望有一个明确、安全的清理入口
  以便删除本地可再生成的构建产物、缓存和运行日志
  同时避免误删环境配置、数据库、备份、部署归档和客户数据

  背景:
    假如项目根目录存在 Makefile
    并且前端项目位于 "前端源码/zggeo-dashboard"
    并且后端项目位于 "后端源码/ai-service"

  场景: 查看清理范围但不实际删除文件
    假如本地存在以下可再生文件或目录:
      | 路径 |
      | .local/logs |
      | .local/run |
      | 前端源码/zggeo-dashboard/dist |
      | 前端源码/zggeo-dashboard/dist-admin |
      | 前端源码/zggeo-dashboard/dist-client |
      | 前端源码/zggeo-dashboard/node_modules/.vite |
      | 后端源码/ai-service/__pycache__ |
      | 后端源码/ai-service/tests/__pycache__ |
    当我执行 "scripts/clean-generated.sh --dry-run"
    那么命令应该输出将要清理的路径
    并且这些文件或目录仍然存在

  场景: 清理默认可再生产物
    假如本地存在前端构建产物、Python 字节码缓存和本地运行日志
    当我执行 "make clean"
    那么以下内容应该被删除:
      | 类型 |
      | 前端 dist 构建目录 |
      | Vite 本地缓存 |
      | Python __pycache__ 目录 |
      | Python .pyc 和 .pyo 文件 |
      | pytest / ruff / mypy / coverage 缓存 |
      | .local/logs 和 .local/run |
    并且命令应该成功退出

  场景: 默认清理不得删除有状态或敏感内容
    假如项目中存在以下文件或目录:
      | 路径 |
      | .env |
      | 后端源码/ai-service/.env |
      | 后端源码/ai-service/.venv |
      | 后端源码/ai-service/.venv-local |
      | 前端源码/zggeo-dashboard/node_modules |
      | deploy/production/data |
      | deploy/production/backups |
      | deploy/production/releases |
      | deploy/production/current |
      | backups |
    当我执行 "make clean"
    那么这些文件或目录不应该被删除

  场景: 前端项目可以单独清理自己的可再生产物
    假如我位于前端项目目录
    并且存在 "dist"、"dist-admin"、"dist-client" 或 "node_modules/.vite"
    当我执行 "npm run clean"
    那么前端构建产物和 Vite 缓存应该被删除
    并且 "node_modules" 本身不应该被删除

  场景: 系统临时目录文件必须显式清理
    假如 /tmp 下存在项目生成的 "zggeo-*" 临时文件
    当我执行 "make clean"
    那么这些 /tmp 文件不应该被删除
    当我执行 "scripts/clean-generated.sh --include-system-tmp"
    那么已知的项目 /tmp 临时文件应该被删除

  场景: 清理命令可以重复执行
    假如所有可再生产物已经被清理
    当我再次执行 "make clean"
    那么命令应该成功退出
    并且不应该报错

  场景: 清理脚本拒绝未知参数
    当我执行 "scripts/clean-generated.sh --unknown-option"
    那么命令应该失败
    并且输出帮助信息或错误提示
```
