# Billing Commercial Center BDD

## Feature: 商业中心支持套餐、点数、订单和消耗账单闭环

商业中心不应只是演示页面，而应成为客户侧账户中心和内部运营计费后台。

系统应围绕四个核心对象设计：

- `Plan`：套餐与权益。
- `CreditAccount`：租户点数账户。
- `BillingOrder`：套餐、点数包、对公转账和支付订单。
- `CreditLedgerEntry`：不可变点数账本流水。

所有商业中心数据必须按 `tenant_id` 隔离。客户只能查看自己的账户、订单和流水；运营和管理员可以按权限查看或处理租户计费数据。

## Scenario: 客户查看商业中心概览

Given 当前用户是 `client` 角色

And 当前用户绑定了租户 A

When 用户进入“商业中心”

Then 系统应展示租户 A 的当前套餐

And 系统应展示租户 A 的可用点数

And 系统应展示租户 A 的冻结点数

And 系统应展示租户 A 的本月消耗

And 系统应展示租户 A 最近的点数流水

And 系统不应展示其他租户的数据

## Scenario: 管理员查看商业中心概览

Given 当前用户是 `admin` 角色

When 管理员进入“商业中心”

Then 系统应展示全部租户的商业数据汇总

And 管理员可以按租户筛选点数账户

And 管理员可以查看低余额租户

And 管理员可以查看待处理支付订单

And 管理员可以查看异常扣点记录

## Scenario: 客户查看套餐和权益

Given 当前用户是 `client` 角色

When 用户进入“套餐 / 权益”

Then 系统应展示可购买套餐列表

And 每个套餐应展示价格、周期、月赠点数、项目数量、团队人数和可用模块

And 当前套餐应被明确标记

And 用户可以发起升级套餐订单

But 用户不能新增、编辑、启用或停用套餐配置

## Scenario: 管理员配置套餐

Given 当前用户是 `admin` 角色

When 管理员进入“套餐 / 权益”

Then 管理员可以新增套餐

And 管理员可以编辑套餐价格、周期点数、功能权益和限制

And 管理员可以启用或停用套餐

And 套餐配置变更必须记录操作日志

## Scenario: 客户查看点数账户

Given 当前用户是 `client` 角色

When 用户进入“点数账户”

Then 系统应展示当前可用点数

And 系统应展示当前冻结点数

And 系统应展示累计充值点数

And 系统应展示累计消耗点数

And 系统应展示可购买点数包

But 系统不应展示“内部加点”操作

## Scenario: 管理员人工调整点数

Given 当前用户是 `admin` 角色

And 管理员选择租户 A

When 管理员提交人工加点 1000 点

And 填写调整原因“线下合同赠送”

Then 系统应增加租户 A 的可用点数 1000

And 系统应写入一条 `adjust` 类型账本流水

And 流水应包含操作人、调整原因、变更点数和变更后余额

And 系统应记录商业化操作日志

## Scenario: 客户购买点数包时创建订单

Given 当前用户是 `client` 角色

And 当前租户可用点数为 500

When 用户选择购买“增长点数包”

Then 系统应创建一笔 `billing_order`

And 订单状态应为 `pending`

And 订单应记录点数包名称、金额、点数和租户 ID

And 系统不应立即增加点数余额

And 用户应进入支付或对公转账确认流程

## Scenario: 支付成功后点数入账

Given 存在一笔 `pending` 状态的点数包订单

And 订单包含 8000 点

When 支付网关回调成功

Or 管理员确认对公转账已到账

Then 订单状态应变更为 `paid`

And 系统应为订单所属租户增加 8000 可用点数

And 系统应写入一条 `recharge` 类型账本流水

And 流水应关联订单 ID

And 同一订单重复回调不应重复入账

## Scenario: 客户查看订单和支付记录

Given 当前用户是 `client` 角色

When 用户进入“订单 / 支付”

Then 系统应展示当前租户的订单列表

And 订单应展示订单号、订单类型、金额、点数、支付方式和状态

And 用户不能看到其他租户订单

## Scenario: 客户查看消耗账单

Given 当前用户是 `client` 角色

When 用户进入“消耗账单”

Then 系统应展示真实账本流水

And 流水应包含时间、模块、说明、点数变化、变更后余额、关联对象和状态

And 用户可以按时间筛选

And 用户可以按模块筛选

And 用户可以按流水类型筛选

And 用户可以导出当前租户的账单

## Scenario: 文章生成前预占点数

Given 当前租户可用点数为 100

And 文章生成预计消耗 50 点

When 用户发起文章生成任务

Then 系统应先创建 50 点预占记录

And 租户可用点数应减少 50

And 租户冻结点数应增加 50

And 文章生成任务应继续执行

## Scenario: 文章生成成功后结算点数

Given 文章生成任务已成功

And 该任务存在 50 点预占记录

When 系统结算任务

Then 预占记录状态应变更为 `captured`

And 租户冻结点数应减少 50

And 系统应写入一条 `consume` 类型账本流水

And 流水应关联文章 ID 或任务 ID

## Scenario: 文章生成失败后释放点数

Given 文章生成任务执行失败

And 该任务存在 50 点预占记录

When 系统处理失败结果

Then 预占记录状态应变更为 `released`

And 租户冻结点数应减少 50

And 租户可用点数应返还 50

And 系统应写入一条 `release` 类型账本流水

## Scenario: 点数不足时阻止任务启动

Given 当前租户可用点数为 20

And 文章生成预计消耗 50 点

When 用户发起文章生成任务

Then 系统应拒绝启动任务

And 系统应返回错误码 `INSUFFICIENT_CREDITS`

And 错误信息应包含 `required: 50`

And 错误信息应包含 `available: 20`

And 系统不应创建业务任务

And 系统不应扣减点数

## Scenario: 重复请求不会重复扣点

Given 用户已经发起过一次文章生成请求

And 请求的 `idempotency_key` 为 `content.article.generate:tenantA:task001`

When 前端或后台任务重复提交相同请求

Then 系统应返回第一次请求的处理结果

And 系统不应重复创建预占记录

And 系统不应重复扣减点数

## Scenario: Agent 自动运作按步骤结算

Given 当前租户可用点数充足

When 用户启动 Agent 自动运作

Then 系统应计算预计总点数

And 系统应创建任务级预占记录

When Agent 步骤成功完成

Then 系统应按实际步骤消耗结算点数

When Agent 部分步骤失败

Then 系统应释放未使用的预占点数

And 消耗账单应能追踪到每个 Agent 步骤

## Scenario: 媒体分发真实订单需要二次确认

Given 用户准备创建媒体投稿订单

And 该操作会产生真实外部成本

When 用户点击提交

Then 系统应展示费用和风险确认

And 用户确认后才允许创建订单

And 系统应记录平台服务点数消耗

And 外部媒体费用应单独记录

And 外部媒体费用不应混入普通点数消耗

## Scenario: 客户不能访问运营调账能力

Given 当前用户是 `client` 角色

When 用户访问运营调账接口

Then 系统应返回 403

And 系统不应执行任何点数调整

And 系统不应写入调账流水

## Scenario: 运营人员处理对公转账

Given 当前用户是 `operator` 角色

And 存在一笔待确认的对公转账订单

When 运营人员确认到账凭证有效

Then 订单状态应变更为 `paid`

And 系统应为对应租户入账点数

And 系统应记录操作日志

And 该操作应可被管理员审计

## Scenario: 低余额提醒

Given 租户设置低余额阈值为 500 点

And 当前可用点数下降到 480 点

When 系统完成扣点结算

Then 系统应生成低余额提醒事件

And 系统可以通过站内通知或企业微信通知运营人员

And 同一阈值周期内不应频繁重复提醒

## Scenario: 账本与余额校验

Given 系统存在点数账户和账本流水

When 定时任务执行账本校验

Then 系统应根据账本重新计算账户余额

And 如果计算余额与账户余额不一致

Then 系统应记录异常

And 系统应通知管理员处理
