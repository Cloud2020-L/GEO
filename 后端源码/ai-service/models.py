from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field


class TaskCreateRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    domain: str = Field(..., min_length=1)
    task_type: str = "keyword-gap-analysis"
    keywords: list[str] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)
    pasted_text: str | None = None
    source_lead_id: UUID | None = None


class TaskResponse(BaseModel):
    task_id: UUID
    project_id: UUID
    status: str
    queue_id: str | None = None


class ConsultationLeadCreateRequest(BaseModel):
    report_id: UUID | None = None
    task_id: UUID | None = None
    source_page: str | None = None
    name: str = Field(..., min_length=1)
    contact: str = Field(..., min_length=1)
    company: str | None = None
    brand_name: str | None = None
    domain: str | None = None
    keywords: list[str] = Field(default_factory=list)
    competitors: list[str] = Field(default_factory=list)
    needs: str = Field(..., min_length=1)
    tenant_name: str | None = None


class ConsultationLeadResponse(BaseModel):
    lead_id: UUID
    status: str
    notify_status: str
    notification_channel: str | None = None


class ClientEventRequest(BaseModel):
    event_type: str = Field(..., min_length=1)
    page_path: str | None = None
    api_url: str | None = None
    http_status: int | None = None
    message: str = Field(..., min_length=1)
    error_stack: str | None = None
    request_id: str | None = None
    browser: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


FollowupStatus = Literal["new", "contacted", "in_progress", "closed"]


class LeadRow(BaseModel):
    id: UUID
    created_at: datetime
    source_page: str
    name: str
    contact: str
    company: str | None = None
    brand_name: str | None = None
    domain: str | None = None
    keywords: list[str] = Field(default_factory=list)
    competitors: list[str] = Field(default_factory=list)
    needs: str
    notify_status: str
    followup_status: FollowupStatus
    notification_channel: str | None = None
    notification_message_id: str | None = None
    notify_error: str | None = None
    report_id: UUID | None = None
    task_id: UUID | None = None


class LeadUpdateRequest(BaseModel):
    followup_status: FollowupStatus | None = None
    name: str | None = None
    contact: str | None = None
    company: str | None = None
    brand_name: str | None = None
    domain: str | None = None
    keywords: list[str] | None = None
    competitors: list[str] | None = None
    needs: str | None = None
    action_source: str | None = None
    keyword_writeback_mode: Literal["append", "replace"] | None = None


class KeywordExpansionRequest(BaseModel):
    lead_id: str | None = None
    brand_name: str = Field(..., min_length=1)
    domain: str | None = None
    company: str | None = None
    needs: str | None = None
    existing_keywords: list[str] = Field(default_factory=list)
    competitors: list[str] = Field(default_factory=list)
    count: int = Field(default=20, ge=3, le=50)
    provider: str | None = None
    language: Literal["zh", "en", "yue"] = "zh"
    client_request_id: str | None = None


class KeywordPromptGenerateRequest(BaseModel):
    lead_id: str | None = None
    brand_name: str | None = None
    domain: str | None = None
    company: str | None = None
    needs: str | None = None
    keywords: list[str] = Field(default_factory=list)
    keyword_source: Literal["brand", "non_brand"] | None = None
    count: int = Field(default=20, ge=3, le=50)
    provider: str | None = None
    language: Literal["zh", "en", "yue"] = "zh"
    client_request_id: str | None = None


class KeywordPromptDeleteRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)
    scope: Literal["ids", "all"] = "ids"
    lead_id: str | None = None
    brand_name: str | None = None


class ReportBlock(BaseModel):
    keyword_intent: list[str]
    visibility_score: int
    structure_score: int
    trust_score: int
    content_coverage_score: int
    total_score: int
    grade: str
    score_reason_visibility: str
    score_reason_structure: str
    score_reason_trust: str
    score_reason_content: str
    content_gap: list[str]
    trust_signal_missing: list[str]
    structure_problem: list[str]
    quick_fix_suggestions: list[str]
    top_issues: list[str]
    top_fixes: list[str]
    evidence_snippets: list[str]
    retrieved_context: list[dict[str, Any]]
    geo_enhancement: dict[str, Any] | None = None
    contact_governance: dict[str, Any] | None = None
    contact_governance_score: int | None = None
    generated_at: str
    report_version: str
    management_summary: dict[str, Any]
    detailed_analysis: dict[str, Any]
    score_method: dict[str, Any]


class TaskRow(BaseModel):
    id: UUID
    project_id: UUID
    project_name: str
    domain: str
    task_type: str
    status: str
    created_at: datetime
    finished_at: datetime | None = None
    report_id: UUID | None = None
    summary_text: str | None = None
    total_score: int | None = None
    grade: str | None = None
    report_version: str | None = None
    is_latest_report: bool | None = None
    is_legacy_report: bool | None = None
    is_productized_report: bool | None = None


class ReportResponse(BaseModel):
    report_id: UUID
    task_id: UUID
    project_name: str
    domain: str
    status: str
    keywords: list[str]
    urls: list[str]
    summary_text: str
    total_score: int
    grade: str
    visibility_score: int
    structure_score: int
    trust_score: int
    content_coverage_score: int
    top_issues: list[str]
    top_fixes: list[str]
    evidence_snippets: list[str]
    report_version: str
    is_latest_report: bool
    is_legacy_report: bool
    is_productized_report: bool
    report_json: ReportBlock
    raw_report_json: dict[str, Any]
    created_at: datetime




class GeoAssetRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    domain: str = Field(..., min_length=1)
    description: str | None = None
    keywords: list[str] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)
    schema_type: str = "Organization"


class BrandVisibilityRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    domain: str = Field(..., min_length=1)


class GeoAssetAuditRequest(BaseModel):
    domain: str = Field(..., min_length=1)


class GeoSitemapRequest(BaseModel):
    domain: str = Field(..., min_length=1)
    max_pages: int = Field(default=20, ge=1, le=50)




class GeoPerformanceRequest(BaseModel):
    domain: str = Field(..., min_length=1)
    strategy: Literal["mobile", "desktop"] = "mobile"
    include_field_data: bool = True


class GeoContentExtractabilityRequest(BaseModel):
    url: str | None = None
    content: str | None = None
    query: str = "general content analysis"


class GeoPromptMonitorReportRequest(BaseModel):
    brand: str = Field(..., min_length=1)
    platform: str = "AI"
    results: list[dict[str, Any]] = Field(default_factory=list)


class GeoLlmsFullRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    domain: str = Field(..., min_length=1)
    description: str | None = None
    max_pages: int = Field(default=12, ge=1, le=30)


class GeoDeploymentPackageRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    domain: str = Field(..., min_length=1)
    description: str | None = None
    keywords: list[str] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)
    max_pages: int = Field(default=12, ge=1, le=30)
    report_id: str | None = None


class ContactGovernanceProfileRequest(BaseModel):
    lead_id: str | None = None
    project_name: str = Field(..., min_length=1)
    brand_name: str | None = None
    company_name: str | None = None
    domain: str = Field(..., min_length=1)
    official_phone: str = Field(..., min_length=1)
    backup_phone: str | None = None
    hotline_400: str | None = None
    landline: str | None = None
    invalid_phones: list[str] = Field(default_factory=list)
    preferred_display_phone: str | None = None
    contact_page_url: str | None = None
    address: str | None = None
    business_hours: str | None = None
    phone_display_policy: Literal["official_phone", "hotline_400", "landline"] = "official_phone"
    verified_status: Literal["pending", "verified"] = "pending"


class ContactGovernanceProfileUpdateRequest(BaseModel):
    project_name: str | None = None
    brand_name: str | None = None
    company_name: str | None = None
    domain: str | None = None
    official_phone: str | None = None
    backup_phone: str | None = None
    hotline_400: str | None = None
    landline: str | None = None
    invalid_phones: list[str] | None = None
    preferred_display_phone: str | None = None
    contact_page_url: str | None = None
    address: str | None = None
    business_hours: str | None = None
    phone_display_policy: Literal["official_phone", "hotline_400", "landline"] | None = None
    verified_status: Literal["pending", "verified"] | None = None


class ContactAuditRunRequest(BaseModel):
    profile_id: str
    urls: list[str] = Field(default_factory=list)


class ContactVisibilityRunRequest(BaseModel):
    profile_id: str
    questions: list[str] = Field(default_factory=list)
    providers: list[str] = Field(default_factory=list)


class ContactDeploymentPackageRequest(BaseModel):
    profile_id: str


class GeoDriftRequest(BaseModel):
    domain: str = Field(..., min_length=1)
    save_snapshot: bool = True


class BrandSourceScanRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    domain: str | None = None


class GeoCompetitorCompareRequest(BaseModel):
    primary_domain: str = Field(..., min_length=1)
    competitor_domains: list[str] = Field(default_factory=list)


class CustomerReportExportRequest(BaseModel):
    report: dict[str, Any]
    deployment: dict[str, Any] | None = None
    lead_id: str | None = None


class QuestionSummaryRequest(BaseModel):
    asset: dict[str, Any]
    geo_report_id: UUID | None = None
    model_report_id: UUID | None = None
    provider: str | None = None


class DriftScheduleRequest(BaseModel):
    domain: str = Field(..., min_length=1)
    frequency: str = "weekly"
    enabled: bool = True


class AgentWorkflowStartRequest(BaseModel):
    lead_id: UUID | None = None
    project_name: str = Field(..., min_length=1)
    domain: str | None = None
    description: str | None = None
    keywords: list[str] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)
    competitors: list[str] = Field(default_factory=list)
    notes: str | None = None
    mode: str = "full_auto"
    # ---- 高级配置（可选，不填则用默认值） ----
    keyword_count: int = Field(default=10, ge=3, le=50)
    prompt_count: int = Field(default=10, ge=3, le=50)
    content_task_limit: int = Field(default=3, ge=0, le=20)
    max_pages: int = Field(default=12, ge=1, le=30)
    language: Literal["zh", "en", "yue"] = "zh"
    providers: list[str] = Field(default_factory=list)
    skip_steps: list[str] = Field(default_factory=list)
    summary_provider: str | None = None
    content_provider: str | None = None
    content_channel: str = "官网文章"
    content_priority: str = "中"
    content_allow_fallback: bool = False
    question_count: int = Field(default=6, ge=3, le=20)
    prompt_keyword_source: Literal["non_brand", "brand", "all"] = "non_brand"
    prompt_ids: list[str] = Field(default_factory=list)
    article_generation_mode: Literal["basic", "official_rewrite", "viral_rewrite"] = "basic"
    article_style_key: str = "original"
    article_prompt_strategy: Literal["auto_next", "manual"] = "auto_next"
    article_image_strategy: Literal["auto", "manual"] = "auto"
    article_source_url: str | None = None
    article_platform_style: str | None = None
    article_search_intent: str | None = None


class AgentWorkflowRetryRequest(BaseModel):
    force: bool = False


class AgentWorkflowScheduleRequest(BaseModel):
    frequency: str = "weekly"
    enabled: bool = True


class AgentWorkflowCallbackRequest(BaseModel):
    step_key: str | None = None
    status: str = "completed"
    detail: str | None = None
    ref_type: str | None = None
    ref_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class AgentWorkflowN8nEventRequest(BaseModel):
    event: str = Field(..., min_length=1)
    workflow_id: str | None = None
    workflow_name: str | None = None
    node_name: str | None = None
    status: str = "completed"
    detail: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class ModelTestRequest(BaseModel):
    provider: str = Field(..., min_length=1)


class ModelGenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    provider: str | None = None
    system_prompt: str | None = None
    temperature: float = Field(default=0.3, ge=0, le=2)
    max_tokens: int = Field(default=1200, ge=1, le=8000)


class ModelRegressionRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    domain: str | None = None
    questions: list[str] = Field(default_factory=list)
    providers: list[str] = Field(default_factory=list)
    source_probe_enabled: bool = False


class ModelVisibilityRunRequest(ModelRegressionRequest):
    lead_id: str | None = None
    competitors: list[str] = Field(default_factory=list)


class LoginRequest(BaseModel):
    username: str | None = Field(default=None, min_length=2)
    email: str | None = Field(default=None, min_length=2)
    password: str = Field(..., min_length=1)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)


class ClientRegisterRequest(BaseModel):
    name: str = Field(..., min_length=1)
    phone: str = Field(..., min_length=11)
    verification_code: str = Field(..., min_length=4, max_length=8)
    password: str = Field(..., min_length=6)
    company: str | None = None


class SmsCodeRequest(BaseModel):
    phone: str = Field(..., min_length=11)


class UserCreateRequest(BaseModel):
    username: str
    name: str
    email: str | None = None
    role: str = "client"
    tenant_name: str = "ZGEO 智改"
    lead_id: str | None = None
    password: str = "zggeo123"


class UserUpdateRequest(BaseModel):
    username: str | None = None
    name: str | None = None
    email: str | None = None
    role: str | None = None
    tenant_name: str | None = None
    lead_id: str | None = None
    password: str | None = Field(default=None, min_length=6)
    status: Literal["active", "disabled"] | None = None


class PermissionUpdateRequest(BaseModel):
    can_view: bool | None = None
    can_edit: bool | None = None


class ApiKeyCreateRequest(BaseModel):
    name: str
    scope: str = "reports:read"


class WritingTaskCreateRequest(BaseModel):
    lead_id: UUID | None = None
    source_prompt_id: UUID | None = None
    source_prompt_text: str | None = None
    source_prompt_keyword: str | None = None
    source_prompt_intent: str | None = None
    source_prompt_scenario: str | None = None
    title: str
    brand: str = "ZGEO 智改"
    domain: str = "example.com"
    keyword: str
    channel: str = "官网文章"
    angle: str
    priority: str = "中"
    outline: list[str] = Field(default_factory=list)
    report_id: UUID | None = None


class ContentQuestionMiningRequest(BaseModel):
    keyword: str = Field(..., min_length=1)
    brand: str | None = None
    domain: str | None = None
    limit: int = Field(default=8, ge=1, le=20)


class ContentImageGroupCreateRequest(BaseModel):
    lead_id: UUID
    name: str = Field(..., min_length=1)
    description: str | None = None
    usage: Literal["article", "product", "case", "banner", "other"] = "article"


class ContentImageGroupUpdateRequest(BaseModel):
    lead_id: UUID | None = None
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None
    usage: Literal["article", "product", "case", "banner", "other"] | None = None


class ArticleDraftUpdateRequest(BaseModel):
    title: str | None = None
    body: str = Field(..., min_length=1)
    status: str | None = None
    human_reviewed: bool | None = None


class ArticleDraftCreateRequest(BaseModel):
    task_id: UUID | None = None
    source_prompt_id: UUID | None = None
    source_prompt_text: str | None = None
    source_prompt_keyword: str | None = None
    source_prompt_intent: str | None = None
    source_prompt_scenario: str | None = None
    generated_from: str = "manual"
    title: str = Field(..., min_length=1)
    channel: str = "官网文章"
    article_type: str | None = None
    body: str = Field(..., min_length=1)
    model: str | None = None
    provider: str = "local"
    status: str = "已生成"
    compliance_platform: str | None = None
    compliance_status: str | None = None
    compliance_summary: str | None = None
    compliance_issues: list[dict[str, Any]] = Field(default_factory=list)
    ai_disclosure_required: bool = False
    source_required: bool = False
    fiction_disclosure_required: bool = False
    human_review_required: bool = False


class ArticleGenerateRequest(BaseModel):
    task_id: UUID
    client_request_id: str | None = None
    source_prompt_id: UUID | None = None
    source_prompt_text: str | None = None
    source_prompt_keyword: str | None = None
    source_prompt_intent: str | None = None
    source_prompt_scenario: str | None = None
    company_info: str | None = None
    prompt_text: str | None = None
    provider: str | None = None
    language: Literal["zh", "en", "yue"] = "zh"
    generation_mode: str | None = "basic"
    style_key: str | None = "original"
    platform: Literal["zhihu", "xiaohongshu", "wechat", "moments", "video"] | None = None
    compliance_mode: Literal["standard", "strict"] = "standard"
    images: list[dict[str, Any]] = Field(default_factory=list)
    use_source_preference: bool = True
    source_preference_profile: dict[str, Any] | None = None


class ArticleGenerationRunCreateRequest(ArticleGenerateRequest):
    mode: Literal["basic", "official_rewrite", "viral_rewrite"] = "basic"
    requested_count: int = Field(default=1, ge=1, le=10)


class ContentOptimizationCampaignCreateRequest(BaseModel):
    article_generation_run_id: UUID | None = None
    draft_id: UUID | None = None
    brand: str = Field(..., min_length=1)
    domain: str | None = None
    published_url: str | None = None
    target_prompts: list[str] = Field(default_factory=list)
    target_keywords: list[str] = Field(default_factory=list)
    before_run_id: UUID | None = None
    providers: list[str] = Field(default_factory=list)
    competitors: list[str] = Field(default_factory=list)
    published_at: datetime | None = None


class ContentOptimizationRetestRequest(BaseModel):
    providers: list[str] | None = None
    questions: list[str] | None = None
    competitors: list[str] | None = None


class ArticlePlatformRewriteRequest(BaseModel):
    article_id: UUID | None = None
    source_url: str | None = None
    client_request_id: str | None = None
    platform: Literal["zhihu", "xiaohongshu", "wechat", "moments", "video"] = "zhihu"
    provider: str | None = None
    user_angle: str | None = None
    image_notes: str | None = None
    selected_intents: list[str] = Field(default_factory=list)
    language: Literal["zh", "en", "yue"] = "zh"
    generation_mode: str | None = "official_rewrite"
    style_key: str | None = "zhihu_answer"


class ArticleViralRewriteRequest(BaseModel):
    source_url: str | None = None
    source_text: str | None = None
    client_request_id: str | None = None
    lead_id: UUID | None = None
    platform: Literal["zhihu", "xiaohongshu", "wechat", "moments", "video"] = "xiaohongshu"
    provider: str | None = None
    user_angle: str | None = None
    brand_context: str | None = None
    image_notes: str | None = None
    language: Literal["zh", "en", "yue"] = "zh"
    style_key: str | None = "xiaohongshu_viral"


class ArticleComplianceCheckRequest(BaseModel):
    platform: Literal["zhihu", "xiaohongshu", "wechat", "moments", "video"] | None = None
    title: str | None = None
    body: str = Field(..., min_length=1)
    generation_mode: str | None = None
    source_url: str | None = None
    source_text: str | None = None
    human_reviewed: bool = False


class ArticlePlatformIntentAnalyzeRequest(BaseModel):
    source_url: str = Field(..., min_length=1)


class ContentAgentRunStartRequest(BaseModel):
    task_id: UUID
    provider: str | None = None


class KnowledgeCreateRequest(BaseModel):
    title: str
    type: str = "产品卖点"
    content: str
    tags: list[str] = Field(default_factory=list)


class CreditAdjustRequest(BaseModel):
    amount: int
    description: str = Field(..., min_length=1)
    tenant_id: UUID | None = None
    refresh_expiry: bool | None = None


class BillingOrderCreateRequest(BaseModel):
    order_type: Literal["credit_pack", "plan_subscription", "manual_contract"] = "credit_pack"
    payment_method: Literal["wechat", "alipay", "bank"] = "bank"
    tenant_id: UUID | None = None
    credit_pack_code: str | None = None
    plan_code: str | None = None
    amount_cents: int | None = None
    credits: int | None = None
    description: str | None = None


class BillingQuoteRequest(BaseModel):
    module: str
    action: str | None = None
    quantity: int = 1


class DistributionRecordCreateRequest(BaseModel):
    draft_id: UUID | None = None
    title: str
    channel: str = "媒体市场"
    target: str
    status: str = "待提交"
    cost: int = 0
    publish_url: str | None = None
    platform: str | None = None
    account_name: str | None = None
    account_id: UUID | None = None
    publish_mode: str = "manual_copy"
    platform_entry_url: str | None = None
    scheduled_at: datetime | None = None
    review_note: str | None = None
    publisher_name: str | None = None
    # 手动新建草稿时把正文一起传过来；后端会顺手在 article_drafts
    # 里建一条记录，用它的 id 当 draft_id，让"预览草稿"对话框能看到正文。
    draft_body: str | None = None


class DistributionRecordPublishRequest(BaseModel):
    platform: str | None = None
    account_name: str | None = None
    publish_url: str | None = None
    scheduled_at: datetime | None = None
    review_note: str | None = None
    publisher_name: str | None = None


class PublishingAccountCreateRequest(BaseModel):
    platform: str
    account_name: str
    account_home_url: str | None = None
    account_type: Literal["personal", "enterprise", "organization"] = "personal"
    subject_name: str | None = None
    auth_method: Literal["manual", "oauth", "api_key"] = "manual"
    auth_status: str = "manual_only"
    publish_mode: str = "manual_copy"
    remark: str | None = None


class PublishingAccountUpdateRequest(BaseModel):
    platform: str | None = None
    account_name: str | None = None
    account_home_url: str | None = None
    account_type: Literal["personal", "enterprise", "organization"] | None = None
    subject_name: str | None = None
    auth_method: Literal["manual", "oauth", "api_key"] | None = None
    auth_status: str | None = None
    publish_mode: str | None = None
    remark: str | None = None


class OwnedPublishingTaskCreateRequest(BaseModel):
    draft_id: UUID
    platform: str
    account_id: UUID
    publish_mode: str = "manual_copy"
    scheduled_at: datetime | None = None
    review_note: str | None = None


class OwnedPublishingTaskActionRequest(BaseModel):
    operator_name: str | None = None
    review_note: str | None = None
    publish_url: str | None = None
    error_message: str | None = None


class PublishingTaskCreateRequest(BaseModel):
    draft_id: UUID
    platform: str
    account_id: UUID | None = None
    account_name: str | None = None
    publish_mode: str = "manual_copy"
    scheduled_at: datetime | None = None
    review_note: str | None = None
    platform_entry_url: str | None = None


class PublishingTaskActionRequest(BaseModel):
    operator_name: str | None = None
    review_note: str | None = None
    publish_url: str | None = None
    error_message: str | None = None


class MediaMarketTitleCheckRequest(BaseModel):
    title: str = Field(..., min_length=1)
    media_ids: list[str] = Field(default_factory=list)


class MediaMarketOrderCreateRequest(BaseModel):
    title: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    link: str | None = ""
    remark: str | None = ""
    media_ids: list[str] = Field(default_factory=list)
    media_quote_tokens: list[str] = Field(default_factory=list)
    confirm: bool = False
    allow_duplicate: bool = False


class MediaMarketOrderUpdateRequest(BaseModel):
    title: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    link: str = Field(..., min_length=1)
    remark: str | None = ""
