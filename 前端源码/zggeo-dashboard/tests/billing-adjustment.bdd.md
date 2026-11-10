# Billing Adjustment BDD

## Feature: 管理端支持明确租户的运营调账

为了避免管理员误把点数加到自己的默认租户，作为管理员或运营人员，我希望手动加点时必须明确选择目标客户租户、填写原因，并生成可审计账本流水。

## Background

Given 系统已启用多租户

And 点数账户归属于租户而不是单个用户

And 一个租户下的多个用户共享同一个点数账户

And 人工调账必须写入不可变账本流水

## Scenario: 点数订阅页只给当前租户加点

Given 当前登录用户是 `admin`

And 当前登录用户绑定租户“ZGEO 智改”

When 用户进入“点数 / 订阅”

Then 页面应展示“租户：ZGEO 智改”

And 内部加点按钮应显示为“给当前租户加点”

And 用户点击该按钮时

Then 弹窗应明确提示“将为 ZGEO 智改 调整点数”

## Scenario: 当前租户加点必须填写原因

Given 当前用户打开“给当前租户加点”弹窗

When 用户输入 1000 点

And 未填写调整原因

And 点击确认

Then 系统应阻止提交

And 提示“请填写调整原因”

And 不应调用调账接口

And 不应写入账本流水

## Scenario: 给当前租户加点成功

Given 当前用户是 `admin`

And 当前用户绑定租户“ZGEO 智改”

And 租户“ZGEO 智改”当前可用点数为 13200

When 用户打开“给当前租户加点”弹窗

And 输入 1000 点

And 填写调整原因“测试环境补点”

And 点击确认

Then 系统应调用调账接口

And 请求中不传 `tenant_id`

And 后端应将点数加到当前用户绑定租户“ZGEO 智改”

And 租户可用点数应变为 14200

And 系统应写入 `adjust` 类型账本流水

And 流水说明应为“测试环境补点”

And 流水应记录操作人

And 页面应刷新余额和最近流水

## Scenario: 客户账号不能看到内部加点按钮

Given 当前登录用户是 `client`

When 用户进入“点数 / 订阅”

Then 页面应展示当前租户余额

And 页面应展示点数包购买入口

But 页面不应展示“给当前租户加点”按钮

## Scenario: 新增运营调账入口

Given 当前登录用户是 `admin`

When 用户查看“商业中心”菜单

Then 菜单中应展示“运营调账”

And “运营调账”入口只对 `admin` 或 `operator` 可见

And `client` 用户不应看到该入口

## Scenario: 运营调账页加载客户租户列表

Given 当前登录用户是 `admin`

When 用户进入“运营调账”

Then 系统应调用 `/admin/billing/accounts`

And 页面应展示可调账客户租户列表

And 每个租户应展示租户名称、当前余额、冻结点数、套餐和最近更新时间

## Scenario: 管理员选择客户租户后查看余额

Given 当前登录用户是 `admin`

And 系统存在租户“青创美居”

When 用户在“运营调账”页选择租户“青创美居”

Then 页面应展示该租户当前可用点数

And 页面应展示该租户冻结点数

And 页面应展示该租户累计充值

And 页面应展示该租户累计消耗

## Scenario: 管理员给指定客户租户加点

Given 当前登录用户是 `admin`

And 租户“青创美居”当前可用点数为 500

When 用户进入“运营调账”

And 选择租户“青创美居”

And 选择调整类型“加点”

And 输入点数 8000

And 填写调整原因“线下合同赠送”

And 点击确认

Then 系统应弹出二次确认

And 二次确认应展示“青创美居”

And 二次确认应展示“500 → 8500”

When 用户确认提交

Then 系统应调用 `/admin/billing/credits/adjust`

And 请求应包含 `tenant_id` 为“青创美居”对应租户 ID

And 请求应包含 `amount` 为 8000

And 请求应包含 `description` 为“线下合同赠送”

And 租户“青创美居”可用点数应变为 8500

And 系统应写入 `adjust` 类型账本流水

And 流水应关联操作人

And 页面应刷新该租户余额

## Scenario: 管理员给指定客户租户扣点

Given 当前登录用户是 `admin`

And 租户“青创美居”当前可用点数为 8500

When 用户进入“运营调账”

And 选择租户“青创美居”

And 选择调整类型“扣点”

And 输入点数 500

And 填写调整原因“错误入账冲正”

And 点击确认

Then 系统应弹出二次确认

And 二次确认应展示“8500 → 8000”

When 用户确认提交

Then 系统应调用调账接口

And 请求 `amount` 应为 -500

And 租户“青创美居”可用点数应变为 8000

And 系统应写入 `adjust` 类型账本流水

And 流水说明应为“错误入账冲正”

## Scenario: 扣点不能导致余额为负

Given 当前登录用户是 `admin`

And 租户“青创美居”当前可用点数为 300

When 用户选择扣点 500

And 填写调整原因“错误入账冲正”

And 点击确认

Then 系统应拒绝调账

And 返回错误码 `INSUFFICIENT_CREDITS`

And 错误信息应包含 `required: 500`

And 错误信息应包含 `available: 300`

And 租户余额仍为 300

And 系统不应写入成功调账流水

## Scenario: 运营人员可以给指定租户加点

Given 当前登录用户是 `operator`

And 系统存在租户“青创美居”

When 用户进入“运营调账”

And 选择租户“青创美居”

And 输入 1000 点

And 填写调整原因“运营补偿”

And 确认提交

Then 系统应允许调账

And 系统应写入 `adjust` 类型账本流水

And 流水操作人应为当前 `operator`

## Scenario: 销售不能手动调账

Given 当前登录用户是 `sales`

When 用户访问“运营调账”

Then 系统应拒绝访问

Or 页面不应展示“运营调账”菜单入口

When `sales` 直接请求 `/admin/billing/credits/adjust`

Then 后端应返回 403

And 不应调整任何租户余额

## Scenario: 客户不能手动调账

Given 当前登录用户是 `client`

When 用户直接请求 `/admin/billing/credits/adjust`

Then 后端应返回 403

And 不应调整任何租户余额

And 不应写入账本流水

## Scenario: 调账流水可在消耗账单中查看

Given 管理员已给租户“青创美居”加点 8000

And 调整原因是“线下合同赠送”

When 用户进入“消耗明细”

And 筛选流水类型为“调整”

Then 页面应展示该调账记录

And 记录应展示点数变化“+8000”

And 记录应展示说明“线下合同赠送”

And 记录应展示变更后余额

And 记录应展示操作时间

## Scenario: 管理员可以按租户查看调账流水

Given 当前登录用户是 `admin`

And 系统存在多个租户

When 用户进入“运营调账”

And 选择租户“青创美居”

Then 页面应展示该租户最近调账流水

And 不应混入其他租户的调账流水

## Scenario: 调账必须记录操作人

Given 当前登录用户是 `admin`

When 用户给租户“青创美居”加点 1000

Then 账本流水 `created_by` 应为当前用户 ID

And 操作日志 `actor` 或 `detail` 应能追溯到当前用户

And 后续审计可以知道是谁进行了该次调账

## Scenario: 当前租户加点与运营调账语义分离

Given 当前用户是 `admin`

When 用户进入“点数 / 订阅”

Then 页面只能调整当前登录用户绑定租户

When 用户进入“运营调账”

Then 页面可以选择目标客户租户

And 两个页面的按钮文案和确认文案应明确区分
