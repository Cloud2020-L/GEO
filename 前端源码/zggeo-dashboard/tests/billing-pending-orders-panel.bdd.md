# Feature: 待支付订单模块

作为客户、运营或管理员，我希望在商业中心按订单类型查看和处理待支付订单，以便区分点数包订单、套餐权益订单，并安全地取消或确认订单。

## Background

Given 系统存在商业订单表 `billing_orders`
And 订单类型包括 `credit_pack`、`plan_subscription`、`manual_contract`
And 订单状态包括 `pending`、`paid`、`cancelled`
And 待支付订单模块只展示 `status = pending` 的订单

## Scenario: 点数账户默认展示点数包待支付订单

Given 当前用户进入点数账户页面
When 页面展示待支付订单模块
Then 模块默认筛选 `credit_pack`
And 用户可以切换到全部、套餐权益订单、线下合同订单

## Scenario: 套餐权益页面默认展示套餐待支付订单

Given 当前用户进入套餐权益页面
When 页面展示待支付订单模块
Then 模块默认筛选 `plan_subscription`
And 取消订单后页面应刷新套餐订单数据

## Scenario: 支付中心展示全部待支付订单

Given 当前用户进入支付中心
When 页面展示待支付订单模块
Then 模块默认筛选 `all`
And 运营或管理员可以按租户筛选

## Scenario: 客户取消自己的待支付订单

Given 当前用户角色是 `client`
And 当前租户存在一笔状态为 `pending` 的订单
When 用户点击取消订单并确认
Then 系统应将订单状态更新为 `cancelled`
And 该订单不再出现在待支付订单模块

## Scenario: 非待支付订单不能取消

Given 订单状态不是 `pending`
When 用户请求取消该订单
Then 系统应拒绝取消
And 返回 `只有待支付订单可以取消`

## Scenario: 运营或管理员跨租户查看和处理待支付订单

Given 当前用户角色是 `operator` 或 `admin`
When 用户进入支付中心
Then 用户可以查看全部租户待支付订单
And 用户可以按租户筛选
And 用户可以取消订单或确认到账
