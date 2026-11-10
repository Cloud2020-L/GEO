# Billing Credits Account Unified BDD

## Feature: 点数账户整合当前租户点数与运营调账

为了减少商业中心菜单复杂度，作为客户、管理员和运营人员，我希望“点数 / 订阅”和“运营调账”合并为“点数账户”，并在同一个页面内按权限展示当前租户账户、点数包、流水和运营调账能力。

## Background

Given 系统已启用多租户

And 点数账户归属于租户而不是单个用户

And 一个租户下的多个用户共享同一个点数账户

And 人工调账必须写入不可变账本流水

And 客户只能查看和操作自己的租户账户

And `admin` 和 `operator` 可以进行运营调账

## Scenario: 商业中心菜单合并点数入口

Given 当前用户是 `admin`

When 用户查看“商业中心”菜单

Then 菜单中应展示“点数账户”

And 菜单中不应再展示“点数 / 订阅”

And 菜单中不应再展示独立的“运营调账”

And “点数账户”应指向 `/billing/credits`

## Scenario: 客户菜单只展示点数账户

Given 当前用户是 `client`

When 用户查看“商业中心”菜单

Then 菜单中应展示“点数账户”

And 不应展示“运营调账”

And 不应展示任何跨租户调账入口

## Scenario: 点数账户页面展示当前租户概览

Given 当前用户已登录

And 当前用户绑定租户“ZGEO 智改”

When 用户进入“点数账户”

Then 页面应展示当前租户名称“ZGEO 智改”

And 页面应展示当前套餐

And 页面应展示可用点数

And 页面应展示冻结点数

And 页面应展示累计充值

And 页面应展示累计消耗

And 页面应展示低余额阈值

## Scenario: 点数账户页面展示点数包

Given 当前用户已登录

When 用户进入“点数账户”

Then 页面应展示可购买点数包

And 每个点数包应展示名称、点数、价格和说明

And 用户点击“创建订单”

Then 系统应创建点数包订单

And 不应立即增加点数余额

And 页面应提示用户到支付中心完成支付或对公确认

## Scenario: 点数账户页面展示当前租户流水

Given 当前用户已登录

When 用户进入“点数账户”

Then 页面应展示当前租户最近点数流水

And 流水应包含时间、模块、说明、点数变化和类型

And 页面不应展示其他租户流水

## Scenario: 客户不能看到当前租户加点入口

Given 当前用户是 `client`

When 用户进入“点数账户”

Then 页面不应展示“给当前租户加点”

And 页面不应展示“运营调账”区域

## Scenario: 管理员可以看到当前租户加点入口

Given 当前用户是 `admin`

When 用户进入“点数账户”

Then 页面应展示“给当前租户加点”

And 按钮旁应明确提示该操作只影响当前登录账号绑定租户

And 页面应展示“运营调账”Tab 或区域

## Scenario: 当前租户加点必须填写原因

Given 当前用户是 `admin`

And 当前用户进入“点数账户”

When 用户点击“给当前租户加点”

And 输入 1000 点

And 未填写调整原因

And 点击确认

Then 系统应阻止提交

And 页面应提示“请填写调整原因”

And 不应调用调账接口

And 不应写入账本流水

## Scenario: 当前租户加点成功

Given 当前用户是 `admin`

And 当前用户绑定租户“ZGEO 智改”

And 租户“ZGEO 智改”当前可用点数为 13200

When 用户点击“给当前租户加点”

And 输入 1000 点

And 填写调整原因“测试环境补点”

And 确认提交

Then 系统应调用 `/billing/credits/adjust`

And 请求中不应包含 `tenant_id`

And 后端应将点数加到当前用户绑定租户“ZGEO 智改”

And 租户可用点数应变为 14200

And 系统应写入 `adjust` 类型账本流水

And 页面应刷新余额和最近流水

## Scenario: 管理员进入运营调账区域

Given 当前用户是 `admin`

When 用户进入“点数账户”

And 打开“运营调账”Tab 或区域

Then 系统应调用 `/admin/billing/accounts`

And 页面应展示可调账租户列表

And 每个租户应展示租户名称、当前余额、冻结点数、套餐和最近更新时间

## Scenario: 运营调账区域默认不影响当前租户

Given 当前用户是 `admin`

When 用户打开“运营调账”区域

Then 页面应要求用户选择目标客户租户

And 页面文案应说明“运营调账用于给指定客户租户加点或扣点”

And 页面不应默认把调账目标混同为当前登录租户

## Scenario: 管理员给指定客户租户加点

Given 当前用户是 `admin`

And 系统存在租户“青创美居”

And 租户“青创美居”当前可用点数为 500

When 用户进入“点数账户”

And 打开“运营调账”区域

And 选择租户“青创美居”

And 选择调整类型“加点”

And 输入点数 8000

And 填写调整原因“线下合同赠送”

And 点击确认

Then 系统应弹出二次确认

And 二次确认应展示目标租户“青创美居”

And 二次确认应展示余额变化“500 → 8500”

When 用户确认提交

Then 系统应调用 `/admin/billing/credits/adjust`

And 请求应包含“青创美居”对应的 `tenant_id`

And 请求应包含 `amount: 8000`

And 请求应包含 `description: "线下合同赠送"`

And 租户“青创美居”可用点数应变为 8500

And 系统应写入 `adjust` 类型账本流水

And 页面应刷新该租户余额和调账流水

## Scenario: 管理员给指定客户租户扣点

Given 当前用户是 `admin`

And 租户“青创美居”当前可用点数为 8500

When 用户打开“运营调账”区域

And 选择租户“青创美居”

And 选择调整类型“扣点”

And 输入点数 500

And 填写调整原因“错误入账冲正”

And 点击确认

Then 系统应弹出二次确认

And 二次确认应展示余额变化“8500 → 8000”

When 用户确认提交

Then 系统应调用 `/admin/billing/credits/adjust`

And 请求应包含 `amount: -500`

And 租户“青创美居”可用点数应变为 8000

And 系统应写入 `adjust` 类型账本流水

## Scenario: 扣点不能导致余额为负

Given 当前用户是 `admin`

And 租户“青创美居”当前可用点数为 300

When 用户打开“运营调账”区域

And 选择租户“青创美居”

And 选择调整类型“扣点”

And 输入点数 500

And 填写调整原因“错误入账冲正”

And 点击确认

Then 系统应阻止提交

And 页面应提示当前余额不足

And 不应调用调账接口

And 不应写入账本流水

## Scenario: 后端防止调账扣成负数

Given 当前用户是 `admin`

And 租户“青创美居”当前可用点数为 300

When 用户绕过前端直接请求 `/admin/billing/credits/adjust`

And 请求包含 `amount: -500`

Then 后端应返回错误码 `INSUFFICIENT_CREDITS`

And 错误信息应包含 `required: 500`

And 错误信息应包含 `available: 300`

And 租户余额仍为 300

And 系统不应写入成功调账流水

## Scenario: operator 可以使用运营调账区域

Given 当前用户是 `operator`

When 用户进入“点数账户”

Then 页面应展示“运营调账”Tab 或区域

When 用户选择租户并提交有效调账

Then 系统应允许调账

And 账本流水 `created_by` 应记录当前 `operator`

## Scenario: sales 不能使用运营调账区域

Given 当前用户是 `sales`

When 用户进入“点数账户”

Then 页面不应展示“运营调账”Tab 或区域

And 页面不应展示跨租户调账入口

When `sales` 直接请求 `/admin/billing/credits/adjust`

Then 后端应返回 403

And 不应调整任何租户余额

## Scenario: client 不能使用运营调账区域

Given 当前用户是 `client`

When 用户进入“点数账户”

Then 页面不应展示“运营调账”Tab 或区域

When `client` 直接请求 `/admin/billing/credits/adjust`

Then 后端应返回 403

And 不应调整任何租户余额

## Scenario: 运营调账流水只展示目标租户

Given 当前用户是 `admin`

And 系统存在多个租户

When 用户进入“点数账户”

And 打开“运营调账”区域

And 选择租户“青创美居”

Then 页面应展示“青创美居”的最近调账流水

And 不应混入其他租户的调账流水

## Scenario: 合并后仍保留语义隔离

Given 当前用户是 `admin`

When 用户进入“点数账户”

Then “当前租户账户”区域应只操作当前登录用户绑定租户

And “运营调账”区域应只操作用户显式选择的客户租户

And 两个区域的标题、说明和确认文案应明确区分
