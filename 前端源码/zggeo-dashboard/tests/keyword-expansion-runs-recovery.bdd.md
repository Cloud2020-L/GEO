# Feature: 拓展关键词生成任务可恢复且不丢结果

作为客户用户，我希望关键词生成刷新页面后仍能恢复进度和结果，以便积分扣除和生成结果始终一致。

## Background

Given 当前用户已登录客户端

And 当前用户属于租户 `tenantA`

And 当前租户已存在客户资产 `利达音响`

And 每次拓展关键词生成固定消耗 `1000` 积分

## Scenario: 发起关键词生成时创建可恢复任务

Given 当前租户可用积分为 `2000`

When 用户点击 `生成关键词`

And 用户在确认弹窗中点击 `确认扣除 1,000 积分并生成`

Then 系统应创建一条关键词生成任务

And 系统应返回 `run_id`

And 前端应保存当前 `run_id`

And 系统应预占 `1000` 积分

And 页面应展示 `关键词生成任务进行中`

## Scenario: 刷新页面后恢复生成中任务

Given 用户已发起关键词生成任务

And 任务状态为 `running`

And 前端已保存该任务的 `run_id`

When 用户刷新页面

Then 页面应自动读取该 `run_id`

And 页面应查询关键词生成任务状态

And 页面应继续展示 `关键词生成任务进行中`

And 页面不应允许重复发起相同任务

## Scenario: 刷新后任务成功仍能展示结果

Given 用户已发起关键词生成任务

And 用户在生成过程中刷新页面

When 后端任务生成成功

And 用户页面查询到任务状态为 `succeeded`

Then 页面应展示生成出的关键词结果

And 页面应提示 `生成成功，已扣除 1,000 积分`

And 当前租户可用积分应减少 `1000`

And 系统应写入一条 `consume` 类型积分流水

And 前端应清除当前 active `run_id`

## Scenario: 刷新后任务失败应退回积分

Given 当前租户可用积分为 `2000`

And 用户已发起关键词生成任务

And 系统已预占 `1000` 积分

When 用户在生成过程中刷新页面

And 后端任务执行失败

And 用户页面查询到任务状态为 `failed`

Then 页面应展示生成失败原因

And 页面应提示 `生成失败，积分已退回`

And 当前租户可用积分应恢复为 `2000`

And 当前租户冻结积分应恢复为 `0`

And 系统应写入一条 `release` 类型积分流水

And 前端应清除当前 active `run_id`

## Scenario: 结果入库成功后才正式扣费

Given 当前租户可用积分为 `2000`

When 用户发起关键词生成任务

Then 系统应预占 `1000` 积分

When 模型成功返回关键词结果

Then 系统应先把关键词结果写入任务记录 `result_json`

And 系统才应结算预占积分

And 系统应标记任务状态为 `succeeded`

And 当前租户可用积分应减少 `1000`

## Scenario: 结果入库失败不能扣费

Given 当前租户可用积分为 `2000`

When 用户发起关键词生成任务

Then 系统应预占 `1000` 积分

When 模型成功返回关键词结果

But 系统写入 `result_json` 失败

Then 系统应标记任务状态为 `failed`

And 系统应释放预占积分

And 当前租户可用积分应恢复为 `2000`

And 系统不应写入 `consume` 类型积分流水

## Scenario: 重复提交相同请求不会重复扣费

Given 当前租户可用积分为 `3000`

And 本次请求的 `client_request_id` 为 `req-keyword-001`

When 用户提交关键词生成请求

And 前端因刷新或网络重试再次提交相同 `client_request_id`

Then 系统应返回同一个 `run_id`

And 系统只应创建一条关键词生成任务

And 系统只应预占一次 `1000` 积分

When 任务生成成功

Then 系统只应结算一次 `1000` 积分

And 当前租户可用积分应为 `2000`

And 系统不应产生重复 `consume` 流水
