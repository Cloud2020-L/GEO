# Feature: 基础项目诊断报告追加联系方式治理专项

作为智改GEO运营/交付人员，我希望基础项目诊断报告内置联系方式治理专项，自动检测官网、结构化数据、llms.txt 和豆包回答中的官方电话可信度，以便后续报告展示、部署包生成、客户交付报告和专项复测都基于同一份诊断结论。

## Background

Given 当前用户已登录智改GEO后台

And 当前用户属于租户 `tenantA`

And 当前租户已存在项目 `智改GEO`

And 项目公司全称为 `深圳市智改赋能科技有限公司`

And 项目品牌名为 `智改GEO`

And 项目官网域名为 `example.com`

And 项目官方电话为 `13900000000`

And 项目错误号码黑名单包含 `13800000000`

And 基础项目诊断报告保存位置为 `analysis_reports.report_json`

And 联系方式治理专项字段名为 `contact_governance`

## Scenario: 基础诊断报告包含联系方式治理专项字段

Given 官网首页包含纯文本电话 `13900000000`

And 官网联系页包含 `tel:13900000000`

When 用户运行基础项目诊断

Then 系统应生成基础项目诊断报告

And 报告 JSON 应包含 `contact_governance`

And `contact_governance.official_phone` 应为 `13900000000`

And `contact_governance.detected_phones` 应包含 `13900000000`

And `contact_governance.score` 应为 `0` 到 `100` 之间的数字

And `contact_governance.risk_level` 应为 `low`、`medium` 或 `high`

And `contact_governance.issues` 应为数组

And `contact_governance.fixes` 应为数组

And `contact_governance.evidence` 应为数组

## Scenario: 官网检测结果写入联系方式治理专项

Given 官网首页包含 `商务咨询电话：13900000000`

And 官网联系页包含 `tel:13900000000`

And 官网 footer 不包含任何错误号码

When 用户运行基础项目诊断

Then `contact_governance.homepage_has_phone` 应为 `true`

And `contact_governance.contact_page_has_phone` 应为 `true`

And `contact_governance.phone_is_plain_text` 应为 `true`

And `contact_governance.has_tel_link` 应为 `true`

And `contact_governance.wrong_phones` 应为空数组

And `contact_governance.score` 应大于或等于 `80`

## Scenario: Schema 与 llms.txt 检测结果写入联系方式治理专项

Given 官网 Schema 中没有 `telephone`

And 官网 `/llms.txt` 中没有 `Contact` 区块

When 用户运行基础项目诊断

Then `contact_governance.schema_has_telephone` 应为 `false`

And `contact_governance.llms_has_contact` 应为 `false`

And `contact_governance.issues` 应包含 `Schema 中缺少 telephone 字段`

And `contact_governance.issues` 应包含 `llms.txt 中缺少 Contact 联系方式`

And `contact_governance.fixes` 应包含 `在 Organization 或 LocalBusiness Schema 中补充 telephone`

And `contact_governance.fixes` 应包含 `在 llms.txt 中增加 Contact 区块`

## Scenario: 识别错误号、旧号或虚拟号

Given 官网首页包含官方电话 `13900000000`

And 官网页脚包含错误号码 `13800000000`

When 用户运行基础项目诊断

Then `contact_governance.detected_phones` 应包含 `13900000000`

And `contact_governance.detected_phones` 应包含 `13800000000`

And `contact_governance.wrong_phones` 应包含 `13800000000`

And `contact_governance.risk_level` 应为 `high`

And `contact_governance.score` 应低于 `70`

And `contact_governance.issues` 应包含 `官网存在非官方号码或历史错误号码`

And `contact_governance.fixes` 应包含 `删除或替换官网中的错误号码`

And `contact_governance.evidence` 应记录错误号码所在页面

## Scenario: 识别仅图片展示电话

Given 官网联系页没有纯文本电话

And 官网联系页仅通过图片展示官方电话

When 用户运行基础项目诊断

Then `contact_governance.phone_is_plain_text` 应为 `false`

And `contact_governance.has_tel_link` 应为 `false`

And `contact_governance.risk_level` 应为 `high`

And `contact_governance.issues` 应包含 `电话仅图片展示，AI 难以稳定抓取`

And `contact_governance.fixes` 应包含 `在联系页增加纯文本官方电话`

And `contact_governance.fixes` 应包含 `为官方电话增加 tel: 点击拨号链接`

## Scenario: 豆包检测结果写入联系方式治理专项

Given 豆包电话检测问题包含 `智改GEO官方联系电话是多少？`

And 豆包回答包含 `官方商务咨询电话为 13900000000`

When 用户运行基础项目诊断

Then 系统应提取豆包回答中的号码 `13900000000`

And `contact_governance.doubao_phone_visible` 应为 `true`

And `contact_governance.doubao_phone_correct` 应为 `true`

And `contact_governance.model_results` 应包含模型名 `doubao`

And `contact_governance.model_results` 中该条问题得分应为 `100`

## Scenario: 豆包未展示电话时写入风险

Given 豆包电话检测问题包含 `如何联系智改GEO？`

And 豆包回答只包含 `建议访问官网了解联系方式`

When 用户运行基础项目诊断

Then `contact_governance.doubao_phone_visible` 应为 `false`

And `contact_governance.doubao_phone_correct` 应为 `false`

And `contact_governance.issues` 应包含 `豆包回答未直接展示官方电话`

And `contact_governance.fixes` 应包含 `补充联系方式 FAQ 和可引用答案块`

And `contact_governance.model_results` 中该条问题得分应为 `30`

## Scenario: 豆包展示错误电话时写入高风险

Given 豆包电话检测问题包含 `智改GEO电话是多少？`

And 豆包回答包含 `可以拨打 13800000000 咨询`

When 用户运行基础项目诊断

Then 系统应提取豆包回答中的号码 `13800000000`

And `contact_governance.doubao_phone_visible` 应为 `true`

And `contact_governance.doubao_phone_correct` 应为 `false`

And `contact_governance.wrong_phones` 应包含 `13800000000`

And `contact_governance.risk_level` 应为 `high`

And `contact_governance.model_results` 中该条问题得分应为 `0`

And `contact_governance.fixes` 应包含 `清理错误号码信源并补强官网官方电话`

## Scenario: 联系方式治理专项影响基础诊断总分和总问题

Given `contact_governance.score` 为 `45`

And `contact_governance.risk_level` 为 `high`

When 系统生成基础项目诊断报告汇总

Then 报告维度分应包含 `contact_governance_score`

And 报告 `top_issues` 应包含联系方式治理高风险问题

And 报告 `top_fixes` 应包含联系方式治理 P0 修复建议

And 报告总分应受到联系方式治理分数影响

And 报告等级不应高于联系方式治理高风险约束允许的最高等级

## Scenario: 基础诊断报告详情页展示联系方式治理专项

Given 基础项目诊断报告已包含 `contact_governance`

When 用户打开基础诊断报告详情页

Then 页面应展示 `联系方式治理` 专项卡片

And 卡片应展示联系方式治理分数

And 卡片应展示风险等级

And 卡片应展示官方电话

And 卡片应展示检测到的错误号码

And 卡片应展示官网纯文本电话状态

And 卡片应展示 `tel:` 链接状态

And 卡片应展示 Schema `telephone` 状态

And 卡片应展示 llms.txt `Contact` 状态

And 卡片应展示豆包电话展示状态

And 卡片应提供 `生成部署包` 操作

And 卡片应提供 `进入联系方式治理` 操作

## Scenario: 生成部署包时传递基础诊断报告 ID

Given 用户正在查看报告 ID 为 `report-001` 的基础项目诊断报告

And 该报告包含 `contact_governance`

When 用户点击 `生成部署包`

Then 前端调用 `/geo/deployment-package`

And 请求体应包含 `report_id` 为 `report-001`

And 后端应读取 `analysis_reports.report_json.contact_governance`

And 部署包应包含联系方式治理修复动作

And 部署包应包含联系方式治理修复文件

## Scenario: 联系方式治理专项数据与租户隔离一致

Given 租户 `tenantA` 的基础项目诊断报告包含 `contact_governance`

And 租户 `tenantB` 已登录系统

When 租户 `tenantB` 请求租户 `tenantA` 的报告详情

Then 接口应返回 `404`

And 响应不应包含 `contact_governance`

And 响应不应泄露官方电话、错误号码、官网证据或豆包回答摘要

## Scenario: 官方电话缺失时给出降级建议

Given 项目资料中没有官方电话

When 用户运行基础项目诊断

Then 系统仍应生成 `contact_governance`

And `contact_governance.official_phone` 应为空

And `contact_governance.risk_level` 应为 `high`

And `contact_governance.issues` 应包含 `项目缺少可确认的官方电话`

And `contact_governance.fixes` 应包含 `先在客户资产中维护官方电话`

And 部署包不应编造任何电话号码
