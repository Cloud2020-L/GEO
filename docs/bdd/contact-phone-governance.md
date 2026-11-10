# Feature: 联系方式治理进入基础诊断与部署包

作为智改GEO交付人员，我希望系统在基础诊断中识别客户官网、Schema、llms.txt 和豆包回答里的联系方式风险，并在生成部署包时自动产出电话修复文件和操作清单，以便让豆包等 AI 优先展示真实有效的官方电话，减少错误号、虚拟号和不展示造成的客户流失。

## Background

Given 当前用户已登录智改GEO后台

And 当前用户属于租户 `tenantA`

And 当前租户已存在客户资产 `智改GEO`

And 客户资产包含公司全称 `深圳市智改赋能科技有限公司`

And 客户资产包含品牌名 `智改GEO`

And 客户资产包含官网域名 `example.com`

And 客户资产包含官方展示电话 `13900000000`

And 客户资产包含无效号码黑名单 `13800000000`

And 豆包模型供应商 `doubao` 已配置并可调用

And 基础诊断报告会保存到 `analysis_reports.report_json`

And 生成部署包接口为 `/geo/deployment-package`

## Scenario: 基础诊断报告生成联系方式治理结果

Given 官网首页纯文本包含 `商务咨询电话：13900000000`

And 官网联系页包含 `tel:13900000000`

And 官网 Schema 不包含 `telephone`

And `/llms.txt` 不包含 `Contact` 区块

When 用户运行基础诊断

Then 系统应在基础诊断报告中生成 `contact_governance`

And `contact_governance.official_phone` 应为 `13900000000`

And `contact_governance.detected_phones` 应包含 `13900000000`

And `contact_governance.phone_is_plain_text` 应为 `true`

And `contact_governance.has_tel_link` 应为 `true`

And `contact_governance.schema_has_telephone` 应为 `false`

And `contact_governance.llms_has_contact` 应为 `false`

And `contact_governance.issues` 应包含 `Schema 中缺少 telephone 字段`

And `contact_governance.issues` 应包含 `llms.txt 中缺少 Contact 联系方式`

And 基础诊断报告总问题列表 `top_issues` 应引用联系方式治理中的 P0 或 P1 问题

## Scenario: 基础诊断识别官网错误号码

Given 官网首页包含官方号码 `13900000000`

And 官网页脚包含旧号码 `13800000000`

When 用户运行基础诊断

Then `contact_governance.detected_phones` 应包含 `13900000000`

And `contact_governance.detected_phones` 应包含 `13800000000`

And `contact_governance.wrong_phones` 应包含 `13800000000`

And `contact_governance.risk_level` 应为 `high`

And `contact_governance.score` 应低于 `70`

And `contact_governance.fixes` 应包含 `删除或替换官网页脚错误号码`

And 基础诊断报告应保留错误号码来源页面证据

## Scenario: 基础诊断识别仅图片展示电话

Given 官网联系页没有纯文本电话号码

And 官网联系页仅通过图片展示电话

When 用户运行基础诊断

Then `contact_governance.phone_is_plain_text` 应为 `false`

And `contact_governance.risk_level` 应为 `high`

And `contact_governance.issues` 应包含 `电话仅图片展示，AI 难以稳定抓取`

And `contact_governance.fixes` 应包含 `在联系页增加纯文本官方电话`

And `contact_governance.fixes` 应包含 `为官方电话增加 tel: 点击拨号链接`

## Scenario: 豆包监测识别正确展示官方电话

Given 基础诊断已生成 `contact_governance`

And 电话专项问题包含 `智改GEO官方联系电话是多少？`

And 豆包回答包含 `官方商务咨询电话为 13900000000`

When 系统运行豆包电话监测

Then 系统应从回答中提取号码 `13900000000`

And 该条结果 `correct_phone_shown` 应为 `true`

And 该条结果 `wrong_phone_shown` 应为 `false`

And 该条结果 `score` 应为 `100`

And `contact_governance.doubao_phone_visible` 应为 `true`

And `contact_governance.doubao_phone_correct` 应为 `true`

## Scenario: 豆包监测识别未展示电话

Given 基础诊断已生成 `contact_governance`

And 电话专项问题包含 `如何联系智改GEO？`

And 豆包回答只包含 `建议访问官网了解联系方式`

When 系统运行豆包电话监测

Then 系统应判断回答中没有电话号码

And 该条结果 `phone_missing` 应为 `true`

And 该条结果 `score` 应为 `30`

And `contact_governance.doubao_phone_visible` 应为 `false`

And `contact_governance.issues` 应包含 `豆包回答未直接展示官方电话`

And `contact_governance.fixes` 应包含 `增加联系方式 FAQ 和可引用答案块`

## Scenario: 豆包监测识别错误号码

Given 基础诊断已生成 `contact_governance`

And 电话专项问题包含 `智改GEO电话是多少？`

And 豆包回答包含 `可以拨打 13800000000 咨询`

When 系统运行豆包电话监测

Then 系统应从回答中提取号码 `13800000000`

And 该条结果 `correct_phone_shown` 应为 `false`

And 该条结果 `wrong_phone_shown` 应为 `true`

And 该条结果 `score` 应为 `0`

And `contact_governance.wrong_phones` 应包含 `13800000000`

And `contact_governance.risk_level` 应为 `high`

And `contact_governance.fixes` 应包含 `清理错误号码信源并补强官网官方电话`

## Scenario: 基础诊断报告页展示联系方式治理卡片

Given 基础诊断报告已包含 `contact_governance`

When 用户打开基础诊断报告详情页

Then 页面应展示 `联系方式治理` 卡片

And 卡片应展示联系方式治理分数

And 卡片应展示官网电话是否存在

And 卡片应展示纯文本电话是否存在

And 卡片应展示 `tel:` 链接是否存在

And 卡片应展示 Schema `telephone` 是否存在

And 卡片应展示 llms.txt `Contact` 是否存在

And 卡片应展示豆包是否直接展示官方电话

And 卡片应提供 `生成联系方式修复包` 操作

And 卡片应提供 `查看专项治理` 操作

## Scenario: 生成部署包时使用基础诊断报告中的联系方式治理结果

Given 基础诊断报告 ID 为 `report-001`

And 基础诊断报告包含 `contact_governance`

And `contact_governance.schema_has_telephone` 为 `false`

And `contact_governance.llms_has_contact` 为 `false`

And `contact_governance.doubao_phone_visible` 为 `false`

When 用户点击 `生成部署包`

And 前端请求 `/geo/deployment-package` 时传入 `report_id` 为 `report-001`

Then 后端应读取 `analysis_reports.report_json.contact_governance`

And 部署包 `diagnosis_basis` 应包含联系方式治理摘要

And 部署包 `diagnosis_action_mapping` 应包含联系方式治理修复动作

And 部署包 `checklist` 应增加 `补充官方电话纯文本`

And 部署包 `checklist` 应增加 `Schema 增加 telephone`

And 部署包 `checklist` 应增加 `llms.txt 增加 Contact 区块`

And 部署包 `checklist` 应增加 `联系方式 FAQ 补强`

## Scenario: 生成部署包输出联系方式修复文件

Given 基础诊断报告包含官方电话 `13900000000`

And 基础诊断报告显示 Schema 缺少 `telephone`

And 基础诊断报告显示 llms.txt 缺少 `Contact`

When 用户生成部署包

Then 部署包文件列表应包含 `contact-fix-snippets.html`

And `contact-fix-snippets.html` 应包含 `tel:13900000000`

And `contact-fix-snippets.html` 应包含 Schema 字段 `telephone`

And 部署包文件列表应包含 `faq-contact-block.md`

And `faq-contact-block.md` 应包含 `官方商务咨询电话：13900000000`

And 部署包文件列表应包含 `llms-contact-block.txt`

And `llms-contact-block.txt` 应包含 `Official business phone: 13900000000`

And 所有部署包文件不应包含无效号码黑名单中的 `13800000000`

## Scenario: 没有基础诊断报告时部署包降级生成

Given 当前域名没有匹配的已完成基础诊断报告

When 用户点击 `生成部署包`

Then 前端请求 `/geo/deployment-package` 时 `report_id` 应为空

And 后端应基于当前项目资料和官网实时检测生成部署包

And 页面应提示 `部署包将按当前资料生成`

And 部署包不应错误标记为 `已根据基础诊断报告生成`

And 部署包应在 `warnings` 或 `handoff_note` 中提示建议先运行基础诊断以获得联系方式治理依据

## Scenario: 报告详情页生成部署包必须传入当前报告 ID

Given 用户打开报告详情页 `/reports/scoring?report_id=report-001`

And 当前报告包含 `contact_governance`

When 报告详情页自动生成或手动生成部署包

Then 前端调用 `generateDeploymentPackage`

And 请求体应包含 `report_id` 为 `report-001`

And 生成的部署包应包含当前报告中的联系方式治理依据

## Scenario: 联系方式治理专项页不重复基础诊断报告

Given 基础诊断报告已包含 `contact_governance`

When 用户进入 `联系方式治理` 专项页

Then 页面不应重新展示一份完整基础诊断报告

And 页面应展示 `诊断依据` 区块

And `诊断依据` 应读取最近基础诊断报告的 `contact_governance`

And 页面应展示 `修复动作` 区块

And `修复动作` 应与部署包 checklist 对齐

And 页面应展示 `豆包验证` 区块

And `豆包验证` 应允许用户重新运行电话问题集

And 页面应展示 `趋势监控` 区块

## Scenario: 电话专项问题模板自动生成

Given 客户资产包含公司全称、品牌名、官网域名和官方电话

When 系统生成电话监测问题集

Then 系统应生成不少于 `6` 条问题

And 问题应覆盖 `公司名电话`

And 问题应覆盖 `品牌名联系方式`

And 问题应覆盖 `官方客服电话`

And 问题应覆盖 `商务咨询电话`

And 问题应覆盖 `相关服务应该拨打哪个电话`

And 问题不应包含密钥、Cookie、私有 URL 或非当前客户的敏感信息

## Scenario: 内容资产生成只能使用官方号码

Given 基础诊断报告中的官方电话为 `13900000000`

And 无效号码黑名单包含 `13800000000`

When 用户在内容资产模块生成 FAQ、企业介绍或平台文章

Then 生成提示词应注入官方展示电话 `13900000000`

And 生成提示词应注入规则 `不得编造电话`

And 生成内容中的电话只允许来自官方展示电话

And 如果没有官方展示电话，生成内容应写 `以官网联系方式为准`

And 生成内容不应出现无效号码黑名单中的号码

## Scenario: 周期复测保存趋势

Given 基础诊断报告已包含 `contact_governance`

And 用户设置电话治理复测频率为 `weekly`

When 到达下一次复测时间

Then 系统应自动创建豆包电话监测任务

And 系统应复用上一轮电话专项问题

And 系统应保存本轮电话展示率、电话准确率、错误号码率和未展示率

And 系统应和上一轮结果进行对比

And 专项页应展示趋势变化

And 如果错误号码率上升，系统应生成 P0 风险提示

## Scenario: 租户之间联系方式治理数据隔离

Given 租户 `tenantA` 已有基础诊断报告和联系方式治理数据

And 租户 `tenantB` 已登录系统

When 租户 `tenantB` 查询联系方式治理档案列表

Then 系统不应返回租户 `tenantA` 的联系方式治理数据

When 租户 `tenantB` 使用租户 `tenantA` 的报告 ID 生成部署包

Then 接口应返回 `404`

And 系统不应泄露电话、官网、模型回答或扫描结果

## Scenario: 删除客户资产时同步处理联系方式治理数据

Given 客户资产 `智改GEO` 已绑定基础诊断报告

And 该报告包含 `contact_governance`

And 该客户已有豆包电话监测历史

When 用户删除客户资产 `智改GEO`

Then 系统应同步删除或归档该客户资产关联的联系方式治理档案

And 系统应同步删除或归档官网体检记录

And 系统应同步删除或归档豆包电话监测记录

And 删除后列表不应继续展示该客户的联系方式治理数据
