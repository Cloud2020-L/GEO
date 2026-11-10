# Feature: 支付中心订单分页与真实统计

作为客户、运营或管理员，我希望支付中心订单列表按服务端分页加载，并展示真实全量统计，以便订单数据变多后页面仍然准确、稳定、可用。

## Background

Given 系统存在商业订单表 `billing_orders`
And 订单状态包括 `pending`、`paid`、`cancelled`、`expired`、`failed`
And 订单类型包括 `credit_pack`、`plan_subscription`、`manual_contract`
And 客户只能查看当前租户订单
And 运营或管理员可以查看全部租户订单
And 订单列表必须按 `created_at desc` 展示

## Scenario: 客户进入支付中心时只分页加载当前租户订单

Given 当前用户角色是 `client`
And 当前用户属于租户 A
And 租户 A 存在 80 笔订单
And 租户 B 存在 50 笔订单

When 用户进入支付中心

Then 前端应请求 `/billing/orders?page=1&page_size=20`
And 后端只返回租户 A 的前 20 笔订单
And 响应应包含 `items`、`total`、`page`、`page_size`
And `total` 应等于租户 A 的订单总数 80
And 页面不应展示租户 B 的订单

## Scenario: 管理员进入支付中心时分页加载全部租户订单

Given 当前用户角色是 `admin`
And 系统存在多个租户订单共 300 笔

When 管理员进入支付中心

Then 前端应请求 `/admin/billing/orders?page=1&page_size=20`
And 后端应返回全部租户最近 20 笔订单
And `total` 应等于全部租户订单总数 300
And 每条订单应包含租户名称或租户 ID

## Scenario: 待支付订单模块只查询 pending 订单

Given 当前用户角色是 `admin`
And 系统存在 120 笔 `pending` 订单
And 系统存在 200 笔非 `pending` 订单

When 管理员查看待支付订单模块

Then 前端应请求 `/admin/billing/orders?status=pending&page=1&page_size=20`
And 后端只返回 `status = pending` 的订单
And `total` 应等于 120
And 页面 tab 中的“全部”表示全部待支付订单类型
And 页面不应把“全部”理解为全部状态订单

## Scenario: 待支付订单按订单类型筛选时重置到第一页

Given 用户正在待支付订单模块第 3 页
And 当前筛选类型是 `all`

When 用户切换到 `credit_pack`

Then 前端应将页码重置为第 1 页
And 请求参数应包含 `status=pending`
And 请求参数应包含 `order_type=credit_pack`
And 后端返回的订单都应为点数包待支付订单

## Scenario: 管理员按租户筛选待支付订单

Given 当前用户角色是 `operator` 或 `admin`
And 租户 A 存在 35 笔待支付订单
And 租户 B 存在 20 笔待支付订单

When 用户在待支付订单模块选择租户 A

Then 前端应请求 `/admin/billing/orders?tenant_id=租户A&status=pending&page=1&page_size=20`
And 后端只返回租户 A 的待支付订单
And `total` 应等于 35

## Scenario: 翻页时只请求目标页数据

Given 待支付订单共有 55 笔
And 当前页大小是 20
And 用户正在第 1 页

When 用户点击第 2 页

Then 前端应请求 `page=2&page_size=20`
And 后端应返回第 21 到第 40 笔订单
And 页面不应一次性加载全部 55 笔订单

## Scenario: 顶部统计使用后端聚合结果

Given 系统存在 600 笔订单
And 其中 300 笔为 `pending`
And 其中 200 笔为 `paid`
And 其中 100 笔为 `cancelled`

When 用户进入支付中心

Then 前端应请求订单统计接口
And 顶部统计不应基于订单列表当前页计算
And “待支付”应展示 300
And “已支付”应展示 200
And “已取消”应展示 100

## Scenario: 顶部金额统计不受分页影响

Given 系统存在 300 笔待支付订单
And 每笔待支付订单金额为 100 元
And 当前订单列表页大小是 20

When 用户进入支付中心

Then “待确认金额”应展示 30000 元
And 该金额不应只统计当前页 20 笔订单

## Scenario: 取消订单后刷新当前筛选条件和统计

Given 用户正在查看 `status=pending` 的第 1 页
And 当前页存在一笔待支付订单 X

When 用户取消订单 X

Then 后端应将订单 X 状态更新为 `cancelled`
And 前端应重新请求当前列表
And 前端应重新请求订单统计
And 订单 X 不应继续出现在待支付订单列表
And 顶部“待支付”数量应减少 1
And 顶部“已取消”数量应增加 1

## Scenario: 确认到账后刷新当前筛选条件和统计

Given 当前用户角色是 `admin`
And 用户正在查看待支付订单列表
And 当前页存在一笔待支付订单 X

When 用户确认订单 X 已到账

Then 后端应将订单 X 状态更新为 `paid`
And 系统应为订单所属租户入账点数
And 前端应重新请求当前列表
And 前端应重新请求订单统计
And 订单 X 不应继续出现在待支付订单列表
And 顶部“待支付”数量应减少 1
And 顶部“已支付”数量应增加 1

## Scenario: 页大小超过上限时后端拒绝或裁剪

Given 前端请求 `page_size=1000`

When 后端处理订单分页请求

Then 后端应将 `page_size` 限制在最大值 100
Or 返回参数校验错误
And 后端不应返回 1000 条订单

## Scenario: 无数据时展示空状态

Given 当前筛选条件下没有订单

When 用户查看订单列表

Then 后端应返回 `items=[]`
And `total` 应等于 0
And 页面应展示“暂无订单记录”或“暂无待支付订单”
And 页面分页器不应展示异常页码
