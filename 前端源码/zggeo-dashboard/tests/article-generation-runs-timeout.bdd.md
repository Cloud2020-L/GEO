# Feature: 文章生成任务超时收敛

作为内容运营用户，我希望文章生成任务即使在模型调用或后台 worker 异常时也能自动进入终态，以便页面不会一直转圈，已生成文章和积分结算也保持一致。

## Background

Given 当前用户已登录 ZGEO 后台

And 当前用户属于租户 `tenantA`

And 当前用户进入 `内容生成 / 文章生成NEW`

And 页面通过 `article_generation_runs` 查询文章生成任务状态

And 每篇文章生成固定消耗 `50` 积分

## Scenario: 正常完成的文章生成任务会解锁按钮

Given 用户发起生成 `1` 篇文章

And 系统创建一条文章生成任务，状态为 `queued`

When 后台任务完成模型调用并写入文章草稿

Then 文章生成任务状态应更新为 `succeeded`

And 任务阶段应更新为 `completed`

And `created_count` 应为 `1`

And `draft_ids` 应包含新生成文章 ID

And 前端应停止生成按钮 loading

And 页面应展示生成成功提示

## Scenario: 多篇文章生成到一半后卡死会自动超时

Given 用户发起生成 `10` 篇文章

And 系统已成功生成 `7` 篇文章

And 文章生成任务状态仍为 `running`

And 任务阶段为 `calling_model`

And `updated_at` 已超过系统允许的最长无进度时间

When 前端轮询该文章生成任务状态

Then 后端应自动将任务状态更新为 `timeout`

And 任务阶段应更新为 `timeout`

And `created_count` 应保持为 `7`

And `draft_ids` 中已生成的 `7` 篇文章应保留

And 系统应按 `7` 篇文章实际扣除积分

And 未生成的 `3` 篇不应继续扣费

And 前端应停止生成按钮 loading

And 页面应展示生成超时或失败提示

## Scenario: 未生成任何文章的卡死任务会释放预占积分

Given 用户发起生成 `1` 篇文章

And 文章生成任务状态为 `queued` 或 `running`

And `created_count` 为 `0`

And `draft_ids` 为空

And 系统已预占 `50` 积分

And 任务超过系统允许的无进度时间

When 前端查询该文章生成任务状态

Then 后端应自动将任务状态更新为 `timeout`

And 系统应释放本次生成的预占积分

And 不应新增文章草稿

And 前端应停止生成按钮 loading

And 用户可以重新发起文章生成

## Scenario: 已卡死的旧任务不应阻塞新任务

Given 数据库中存在一条相同请求指纹的旧文章生成任务

And 该旧任务状态为 `running`

And 该旧任务已超过系统允许的无进度时间

When 用户再次点击生成文章

Then 后端应先将旧任务标记为 `timeout`

And 后端不应继续复用这条旧任务

And 后端应允许创建新的文章生成任务

And 前端应显示新的生成进度

## Scenario: 未超时的运行中任务应继续恢复进度

Given 数据库中存在一条相同请求指纹的文章生成任务

And 该任务状态为 `running`

And `updated_at` 尚未超过系统允许的无进度时间

When 用户再次点击生成文章

Then 后端应返回该运行中任务

And 后端不应重复创建新的文章生成任务

And 前端应恢复显示当前任务进度

And 前端不应允许重复发起相同任务

## Scenario: 部分草稿已生成但积分处理失败也不能让页面无限转圈

Given 文章生成任务已经超过系统允许的无进度时间

And `created_count` 大于 `0`

And 系统尝试按实际生成篇数结算预占积分

When 积分结算发生异常

Then 后端仍应将文章生成任务更新为 `timeout`

And 系统应记录积分处理失败日志

And 前端应停止生成按钮 loading

And 已生成文章应继续保留在文章库

## Acceptance Criteria

Then 任意文章生成任务不应永久停留在 `queued` 或 `running`

And 超时任务必须进入 `timeout` 终态

And 已生成文章不能丢失

And 未生成文章不能继续扣费

And 前端按钮不能因为旧任务永久锁死
