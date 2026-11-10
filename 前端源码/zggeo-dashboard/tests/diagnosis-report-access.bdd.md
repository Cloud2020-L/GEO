# Diagnosis Report Access And Deployment Package BDD

## Feature: 基础诊断报告按角色访问并支持生成部署包

为了让客户能稳定查看自己的基础诊断报告并生成部署包，
作为客户、管理员和运营人员，
我希望基础诊断报告使用客户可访问的交付入口，内部评分分析入口只对内部角色开放，并且部署包生成不会因为权限查询错误返回 500。

## Background

Given 监测系统使用同一套任务、报告和部署包数据
And `/visibility-monitoring/diagnosis` 是基础诊断列表入口
And `/visibility-monitoring/diagnosis/report?report_id={report_id}` 是客户可访问的基础诊断报告页
And `/reports/scoring?report_id={report_id}` 是内部评分分析页
And `admin` 可以访问全部租户的基础诊断任务和报告
And `operator` 可以访问授权范围内的基础诊断任务和报告
And `client` 只能访问自己租户的基础诊断任务和报告
And 生成部署包接口为 `POST /geo/deployment-package`

## Scenario: 客户点击基础诊断报告进入客户交付报告页

Given 当前用户是 `client`
And 当前客户租户存在一条已完成基础诊断任务
And 该任务关联报告 `report-a`
When 客户进入“基础诊断”列表
And 客户点击该任务的“报告”
Then 页面应跳转到 `/visibility-monitoring/diagnosis/report?report_id=report-a`
And 页面不应跳转到 `/reports/scoring?report_id=report-a`
And 页面不应跳转到首页

## Scenario: 管理员可进入内部评分分析页

Given 当前用户是 `admin`
And 基础诊断列表中存在客户报告 `report-a`
When 管理员点击该任务的“内部分析”
Then 页面应跳转到 `/reports/scoring?report_id=report-a`
And 页面应展示内部评分分析内容

## Scenario: 客户看不到内部评分分析入口

Given 当前用户是 `client`
And 当前客户租户存在一条已完成基础诊断任务
When 客户进入“基础诊断”列表
Then 页面应展示“报告”入口
And 页面不应展示“内部分析”入口

## Scenario: 客户访问自己租户的基础诊断报告成功

Given 当前用户是 `client`
And 当前客户租户 ID 为 `tenant-a`
And 报告 `report-a` 属于租户 `tenant-a`
When 客户访问 `/visibility-monitoring/diagnosis/report?report_id=report-a`
Then 后端应返回报告详情
And 页面应展示项目名称、域名、总分、等级、诊断摘要
And 页面应展示主要问题和修复建议
And 页面应展示“生成部署包”入口

## Scenario: 客户访问其他租户报告返回 404

Given 当前用户是 `client`
And 当前客户租户 ID 为 `tenant-a`
And 报告 `report-b` 属于租户 `tenant-b`
When 客户访问 `/visibility-monitoring/diagnosis/report?report_id=report-b`
Then 后端应返回 404
And 页面应提示“未找到可用诊断报告”
And 页面不应泄露报告 `report-b` 的项目名称、域名或摘要

## Scenario: report_id 不属于当前客户时生成部署包返回 404

Given 当前用户是 `client`
And 当前客户租户 ID 为 `tenant-a`
And 报告 `report-b` 属于租户 `tenant-b`
When 客户请求 `POST /geo/deployment-package`
And 请求体包含 `report_id = report-b`
Then 后端应返回 404
And 后端不应生成部署包
And 页面应提示“未找到可用诊断报告，请先完成基础诊断”
And 页面不应显示 500 错误

## Scenario: 部署包生成不应因为 analysis_reports 缺少 tenant_id 返回 500

Given 当前用户是 `client`
And 当前客户租户存在合法报告 `report-a`
And `analysis_reports` 表没有 `tenant_id` 字段
When 客户请求 `POST /geo/deployment-package`
And 请求体包含 `report_id = report-a`
Then 后端不应在 `analysis_reports` 上直接拼接 `tenant_id` 条件
And 后端应通过任务和报告关联关系校验租户归属
And 接口不应返回 500
And 接口应返回部署包内容

## Scenario: 没有 report_id 时生成基础部署包成功并返回 warning

Given 当前用户是 `client`
And 当前页面已填写项目名称、域名、描述和关键词
And 当前页面没有关联基础诊断报告
When 客户点击“生成部署包”
Then 前端应请求 `POST /geo/deployment-package`
And 请求体不应包含 `report_id`
And 后端应按当前项目资料生成基础部署包
And 后端应返回 warning “未关联基础诊断报告”
And 页面应提示“部署建议包已生成”

## Scenario: 任务详情抽屉中的报告按钮使用客户交付页

Given 当前用户是 `client`
And 当前客户租户存在一条已完成基础诊断任务
And 该任务关联报告 `report-a`
When 客户打开任务“详情”
And 客户点击抽屉底部“查看报告”
Then 页面应跳转到 `/visibility-monitoring/diagnosis/report?report_id=report-a`
And 页面不应跳转到 `/reports/scoring?report_id=report-a`
