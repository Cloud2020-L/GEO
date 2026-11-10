/**
 * ZGEO codex 后端 API 封装
 *
 * 对接：/Users/yanlyubo/Documents/Codex/2026-04-17-new-chat/zggeo-stack-lab/ai-service (FastAPI :8010)
 * 代理：vite.config.js → '/api/zggeo/*' 去前缀后打到 http://localhost:8010
 *
 * 字段严格按 http://localhost:8010/openapi.json (版本 0.1.0, 2026-04-20 抓取)
 */

import axios from 'axios';
import {
  getAuthToken,
  getScopedStorageItem,
  removeAuthStorage,
  removeScopedStorageItem,
  setScopedStorageItem,
} from 'utils/scopedStorage';

type ClientEventPayload = {
  event_type: 'api_error' | 'js_error' | 'unhandled_rejection' | string;
  page_path?: string;
  api_url?: string;
  http_status?: number;
  message: string;
  error_stack?: string;
  request_id?: string;
  browser?: string;
  extra?: Record<string, unknown>;
};

// -------------------- axios 实例 --------------------
// 不复用 utils/request（那个预期 {code,data} 包装层，会把 codex 的原生响应误拒）
const http = axios.create({
  baseURL: '/api/zggeo',
  timeout: 15000,
});

http.interceptors.request.use((config) => {
  const token = getAuthToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  config.headers = config.headers || {};
  if (!getHeaderValue(config.headers, 'X-Request-ID')) {
    setHeaderValue(config.headers, 'X-Request-ID', createRequestId());
  }
  return config;
});

const HEAVY_GEO_REQUEST_TIMEOUT = 90000;
const MODEL_REGRESSION_TIMEOUT = 600000;
const ARTICLE_GENERATION_TIMEOUT = 600000;
const KEYWORD_EXPANSION_TIMEOUT = 180000;
const WORKFLOW_LIST_TIMEOUT = 60000;

http.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err?.response?.status;
    const url = String(err?.config?.url || '');
    if (status === 401 && !url.includes('/auth/login')) {
      removeAuthStorage();
      if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
        window.location.replace('/login');
      }
      return Promise.reject(err);
    }
    // 统一打印，方便在浏览器控制台看清楚问题
    // eslint-disable-next-line no-console
    console.error('[zggeo-api]', err?.config?.url, status, err?.response?.data);
    reportClientEvent({
      event_type: 'api_error',
      page_path: getPagePath(),
      api_url: err?.config?.url,
      http_status: status,
      message: formatApiError(err),
      request_id: getHeaderValue(err?.config?.headers, 'X-Request-ID'),
      extra: {
        method: err?.config?.method,
        timeout: err?.config?.timeout,
      },
    });
    return Promise.reject(err);
  },
);

export function reportClientEvent(payload: ClientEventPayload) {
  const token = getAuthToken();
  const body = JSON.stringify({
    page_path: getPagePath(),
    browser: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    ...payload,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  fetch('/api/zggeo/client-events', {
    method: 'POST',
    headers,
    body,
    keepalive: body.length < 64000,
  }).catch(() => undefined);
}

export function installClientErrorReporting() {
  if (typeof window === 'undefined') return;
  if ((window as any).__ZGEO_CLIENT_ERROR_REPORTING__) return;
  (window as any).__ZGEO_CLIENT_ERROR_REPORTING__ = true;
  window.addEventListener('error', (event) => {
    const err = event.error as Error | undefined;
    reportClientEvent({
      event_type: 'js_error',
      page_path: getPagePath(),
      message: err?.message || event.message || '页面脚本错误',
      error_stack: err?.stack,
      extra: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportClientEvent({
      event_type: 'unhandled_rejection',
      page_path: getPagePath(),
      message: reason?.message || String(reason || '未处理的 Promise 异常'),
      error_stack: reason?.stack,
    });
  });
}

/** 将 axios 错误转成可读字符串 */
export function formatApiError(err: any): string {
  const detail = err?.response?.data?.detail;
  if (!detail) return err?.message || '请检查后端服务';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((d: any) => d?.msg || JSON.stringify(d)).join('; ');
  }
  return String(detail);
}

function createRequestId() {
  const randomUUID = typeof crypto !== 'undefined' ? crypto.randomUUID?.bind(crypto) : undefined;
  return randomUUID ? randomUUID() : `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getPagePath() {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search}`;
}

function getHeaderValue(headers: any, key: string): string | undefined {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(key) || headers.get(key.toLowerCase()) || undefined;
  return headers[key] || headers[key.toLowerCase()];
}

function setHeaderValue(headers: any, key: string, value: string) {
  if (!headers) return;
  if (typeof headers.set === 'function') {
    headers.set(key, value);
    return;
  }
  headers[key] = value;
}

// -------------------- 类型（对齐 OpenAPI schemas）--------------------

/** 留资跟进状态 */
export type FollowupStatus = 'new' | 'contacted' | 'in_progress' | 'closed';

/** 留资通知状态 */
export type NotifyStatus = 'pending' | 'success' | 'failed' | string;

/**
 * GET /leads 列表项
 * 注意：实际字段是 id（不是 OpenAPI 里 create 响应的 lead_id）
 */
export interface Lead {
  id: string;
  tenant_id?: string | null;
  name?: string;
  contact?: string;
  company?: string | null;
  brand_name?: string | null;
  domain?: string | null;
  keywords?: string[];
  competitors?: string[];
  needs?: string;
  source_page?: string | null;
  task_id?: string | null;
  report_id?: string | null;
  followup_status?: FollowupStatus;
  notify_status?: NotifyStatus;
  notification_channel?: string | null;
  notification_message_id?: string | null;
  notify_error?: string | null;
  created_at?: string;
  [k: string]: unknown;
}

export interface ConsultationLeadCreateRequest {
  name: string;
  contact: string;
  needs: string;
  tenant_name?: string;
  company?: string;
  brand_name?: string;
  domain?: string;
  keywords?: string[];
  competitors?: string[];
  source_page?: string;
  task_id?: string;
  report_id?: string;
}

export interface LeadUpdateRequest {
  followup_status?: FollowupStatus;
  name?: string;
  contact?: string;
  company?: string;
  brand_name?: string;
  domain?: string;
  keywords?: string[];
  competitors?: string[];
  needs?: string;
  action_source?: string;
  keyword_writeback_mode?: 'append' | 'replace';
}

const BRAND_STORAGE_KEY = 'example.com.v1';
const ACTIVE_PROJECT_STORAGE_KEY = 'example.com-project.v1';

function normalizeLeadCacheDomain(raw: string) {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();
}

function leadCacheKey(lead: Lead) {
  const projectName = String(lead.brand_name || lead.company || lead.name || '')
    .trim()
    .toLowerCase();
  const domain = normalizeLeadCacheDomain(String(lead.domain || ''));
  return `${domain}::${projectName}`;
}

function brandCacheKey(brand: Record<string, unknown>) {
  const projectName = String(brand.name || '')
    .trim()
    .toLowerCase();
  const domain = normalizeLeadCacheDomain(String(brand.domain || ''));
  return `${domain}::${projectName}`;
}

function activeProjectLeadId(source: Record<string, unknown>) {
  const id = String(source.id || '');
  if (!id.startsWith('lead:') && !id.startsWith('lead_')) return '';
  return id.replace(/^lead[_:]/, '');
}

function activeProjectCacheKey(source: Record<string, unknown>) {
  const projectName = String(source.project_name || '')
    .trim()
    .toLowerCase();
  const domain = normalizeLeadCacheDomain(String(source.domain || ''));
  return `${domain}::${projectName}`;
}

function purgeDeletedLeadCaches(deletedLeads: Lead[]) {
  if (typeof window === 'undefined' || deletedLeads.length === 0) return;
  try {
    const deletedIds = new Set(deletedLeads.map((lead) => String(lead.id)));
    const deletedKeys = deletedLeads.map(leadCacheKey);

    const raw = getScopedStorageItem(BRAND_STORAGE_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    if (Array.isArray(rows)) {
      const nextRows = rows.filter((row: Record<string, unknown>) => {
        const sourceLeadId = String(row.source_lead_id || '').trim();
        const rowId = String(row.id || '');
        if (sourceLeadId && deletedIds.has(sourceLeadId)) return false;
        if (rowId && deletedIds.has(rowId.replace(/^lead[_:]/, ''))) return false;
        const isLeadDerived =
          String(row.notes || '').includes('来自客户资产') || rowId.startsWith('lead_') || rowId.startsWith('lead:');
        return !(isLeadDerived && deletedKeys.includes(brandCacheKey(row)));
      });
      if (nextRows.length !== rows.length) {
        setScopedStorageItem(BRAND_STORAGE_KEY, JSON.stringify(nextRows));
      }
    }

    const activeRaw = getScopedStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
    if (activeRaw) {
      const active = JSON.parse(activeRaw) as Record<string, unknown>;
      const sourceLeadId = String(active.source_lead_id || '').trim();
      const leadId = activeProjectLeadId(active);
      const cacheKey = activeProjectCacheKey(active);
      if (
        (sourceLeadId && deletedIds.has(sourceLeadId)) ||
        (leadId && deletedIds.has(leadId)) ||
        deletedKeys.includes(cacheKey)
      ) {
        removeScopedStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
      }
    }
  } catch {
    // ignore local cache cleanup failures
  }
}

function pruneLeadCachesFromCurrentLeads(currentLeads: Lead[]) {
  if (typeof window === 'undefined') return;
  try {
    const activeLeadIds = new Set(currentLeads.map((lead) => String(lead.id)));
    const activeKeys = new Set(currentLeads.map(leadCacheKey));

    const raw = getScopedStorageItem(BRAND_STORAGE_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    if (Array.isArray(rows)) {
      const nextRows = rows.filter((row: Record<string, unknown>) => {
        const sourceLeadId = String(row.source_lead_id || '').trim();
        const rowId = String(row.id || '');
        if (sourceLeadId) return activeLeadIds.has(sourceLeadId);
        if (rowId.startsWith('lead_') || rowId.startsWith('lead:')) {
          return activeLeadIds.has(rowId.replace(/^lead[_:]/, ''));
        }
        if (String(row.notes || '').includes('来自客户资产')) {
          return activeKeys.has(brandCacheKey(row));
        }
        return true;
      });
      if (nextRows.length !== rows.length) {
        setScopedStorageItem(BRAND_STORAGE_KEY, JSON.stringify(nextRows));
      }
    }

    const activeRaw = getScopedStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
    if (activeRaw) {
      const active = JSON.parse(activeRaw) as Record<string, unknown>;
      const sourceLeadId = String(active.source_lead_id || '').trim();
      const leadId = activeProjectLeadId(active);
      if ((sourceLeadId && !activeLeadIds.has(sourceLeadId)) || (leadId && !activeLeadIds.has(leadId))) {
        removeScopedStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
      }
    }
  } catch {
    // ignore local cache cleanup failures
  }
}

export interface KeywordExpansionItem {
  keyword: string;
  intent: string;
  reason: string;
  keyword_type?: 'brand' | 'category' | 'scenario' | 'question' | 'competitor' | string;
}

export type GenerationLanguage = 'zh' | 'en' | 'yue';

export interface KeywordExpansionRequest {
  lead_id?: string | null;
  brand_name: string;
  domain?: string | null;
  company?: string | null;
  needs?: string | null;
  existing_keywords?: string[];
  competitors?: string[];
  count?: number;
  provider?: string | null;
  language?: GenerationLanguage;
  client_request_id?: string | null;
}

export interface KeywordExpansionResponse {
  brand_name: string;
  lead_id?: string | null;
  domain: string;
  homepage_url: string;
  source_status: 'ok' | 'failed' | string;
  source_error?: string | null;
  provider: string;
  model: string;
  model_error?: string | null;
  business_vertical?: string;
  requested_count?: number;
  generated_count?: number;
  filtered_count?: number;
  partial?: boolean;
  quality_note?: string;
  quality_warnings?: string[];
  keywords: KeywordExpansionItem[];
  brand_keywords?: KeywordExpansionItem[];
  non_brand_keywords?: KeywordExpansionItem[];
  storage?: {
    brand_keywords?: number;
    non_brand_keywords?: number;
    stored_brand_keywords?: number;
    stored_non_brand_keywords?: number;
  };
  raw_text?: string;
}

export interface KeywordGenerationRun {
  id: string;
  tenant_id?: string;
  user_id?: string;
  lead_id?: string | null;
  brand_name: string;
  domain?: string | null;
  client_request_id?: string;
  requested_count: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  stage: string;
  queue_id?: string | null;
  credit_hold_id?: string | null;
  result_json?: Partial<KeywordExpansionResponse> | null;
  payload?: Partial<KeywordExpansionRequest> | null;
  error_type?: string | null;
  error_detail?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  created_at?: string | null;
}

export interface KeywordPromptItem {
  id: string;
  lead_id?: string | null;
  brand_name: string;
  domain?: string | null;
  keyword?: string | null;
  prompt: string;
  intent: string;
  scenario?: string | null;
  provider: string;
  model?: string | null;
  source: string;
  keyword_source?: 'brand' | 'non_brand' | string | null;
  created_at?: string | null;
  article_count?: number;
  latest_article_at?: string | null;
  latest_article_title?: string | null;
}

export interface KeywordInventoryItem {
  id: string;
  lead_id?: string | null;
  brand_name: string;
  company?: string | null;
  domain?: string | null;
  keyword: string;
  intent?: string | null;
  reason?: string | null;
  source: 'brand' | 'non_brand' | string;
  created_at?: string | null;
}

export interface KeywordPromptGenerateRequest {
  lead_id?: string | null;
  brand_name?: string | null;
  domain?: string | null;
  company?: string | null;
  needs?: string | null;
  keywords?: string[];
  keyword_source?: 'brand' | 'non_brand' | null;
  count?: number;
  provider?: string | null;
  language?: GenerationLanguage;
  client_request_id?: string | null;
}

export interface KeywordPromptDeleteRequest {
  ids?: string[];
  scope?: 'ids' | 'all';
  lead_id?: string | null;
  brand_name?: string | null;
}

export interface KeywordPromptGenerateResponse {
  brand_name: string;
  domain?: string | null;
  provider: string;
  model: string;
  model_error?: string | null;
  items: KeywordPromptItem[];
  raw_text?: string;
}

export interface KeywordPromptListResponse {
  items: KeywordPromptItem[];
}

export interface KeywordInventoryListResponse {
  items: KeywordInventoryItem[];
}

/** GET /content/article-library?lead_id=X */
export interface ArticleLibraryResponse {
  lead: {
    id: string;
    name?: string | null;
    company?: string | null;
    brand_name?: string | null;
    domain?: string | null;
    keywords?: string[] | null;
    needs?: string | null;
    created_at?: string | null;
  };
  prompts: KeywordPromptItem[];
  tasks: Record<string, unknown>[];
}

export interface ConsultationLeadResponse {
  lead_id: string;
  status: string;
  notify_status: string;
  notification_channel?: string | null;
}

export interface TaskCreateRequest {
  project_name: string;
  domain: string;
  task_type?: string; // 默认 "keyword-gap-analysis"
  keywords?: string[];
  urls?: string[];
  pasted_text?: string | null;
  source_lead_id?: string | null;
}

export interface TaskResponse {
  task_id: string;
  project_id: string;
  status: string;
}

/**
 * GET /tasks 列表项
 * 实际返回比 OpenAPI 标注的 TaskResponse 多很多字段（后端 join 了报告信息）
 * 注意 id 字段（不是 task_id）
 */
export interface AnalysisTaskRow {
  id: string;
  project_id: string;
  project_name: string;
  domain: string;
  task_type: string; // 'scoring-v2-strong' | 'scoring-v2-mid' | 'scoring-v2-weak' | 'keyword-gap-analysis' | ...
  status: string; // 'pending' | 'running' | 'completed' | 'failed'
  created_at: string;
  finished_at?: string | null;
  report_id?: string | null;
  report_version?: string | null;
  summary_text?: string;
  total_score?: number;
  grade?: string; // 'S' | 'A' | 'B' | 'C' | 'D'
  is_productized_report?: boolean;
  is_legacy_report?: boolean;
  is_latest_report?: boolean;
  [k: string]: unknown;
}

/** GET /reports/{id} 的完整报告结构（4 维评分 + 证据 + 建议） */
export interface ReportBlock {
  keyword_intent: string[];
  visibility_score: number;
  structure_score: number;
  trust_score: number;
  content_coverage_score: number;
  total_score: number;
  grade: string;
  score_reason_visibility: string;
  score_reason_structure: string;
  score_reason_trust: string;
  score_reason_content: string;
  content_gap: string[];
  trust_signal_missing: string[];
  structure_problem: string[];
  quick_fix_suggestions: string[];
  top_issues: string[];
  top_fixes: string[];
  evidence_snippets: string[];
  retrieved_context: Record<string, unknown>[];
  geo_enhancement?: {
    overall_score?: number;
    citability_score?: number;
    ai_answer_score?: number;
    trust_entity_score?: number;
    schema_readiness_score?: number;
    crawler_readiness_score?: number;
    issues?: string[];
    fixes?: string[];
    signals?: Record<string, unknown>;
    source?: Record<string, unknown>;
  } | null;
  generated_at: string;
  report_version: string;
  management_summary: Record<string, unknown>;
  detailed_analysis: Record<string, unknown>;
  score_method: Record<string, unknown>;
}

export interface ReportResponse {
  report_id: string;
  task_id: string;
  project_name: string;
  domain: string;
  status: string;
  keywords: string[];
  urls: string[];
  summary_text: string;
  total_score: number;
  grade: string;
  visibility_score: number;
  structure_score: number;
  trust_score: number;
  content_coverage_score: number;
  top_issues: string[];
  top_fixes: string[];
  evidence_snippets: string[];
  report_version: string;
  is_latest_report: boolean;
  is_legacy_report: boolean;
  is_productized_report: boolean;
  report_json: ReportBlock;
  raw_report_json: Record<string, unknown>;
  created_at: string;
}

export interface GeoAssetRequest {
  project_name: string;
  domain: string;
  description?: string;
  keywords?: string[];
  urls?: string[];
  schema_type?: string;
}

export interface BrandVisibilityRequest {
  project_name: string;
  domain: string;
}

export interface GeoAssetAuditRequest {
  domain: string;
}

export interface GeoSitemapRequest {
  domain: string;
  max_pages?: number;
}

export interface GeoPerformanceRequest {
  domain: string;
  strategy?: 'mobile' | 'desktop';
  include_field_data?: boolean;
}

export interface GeoContentExtractabilityRequest {
  url?: string;
  content?: string;
  query?: string;
}

export interface GeoPromptMonitorReportRequest {
  brand: string;
  platform?: string;
  results: Record<string, unknown>[];
}

export interface GeoLlmsFullRequest {
  project_name: string;
  domain: string;
  description?: string;
  max_pages?: number;
}

export interface GeoDeploymentPackageRequest {
  project_name: string;
  domain: string;
  description?: string;
  keywords?: string[];
  urls?: string[];
  max_pages?: number;
  report_id?: string | null;
}

export interface ContactGovernanceProfileRequest {
  lead_id?: string | null;
  project_name: string;
  brand_name?: string | null;
  company_name?: string | null;
  domain: string;
  official_phone: string;
  backup_phone?: string | null;
  hotline_400?: string | null;
  landline?: string | null;
  invalid_phones?: string[];
  preferred_display_phone?: string | null;
  contact_page_url?: string | null;
  address?: string | null;
  business_hours?: string | null;
  phone_display_policy?: 'official_phone' | 'hotline_400' | 'landline';
  verified_status?: 'pending' | 'verified';
}

export interface ContactGovernanceProfile extends ContactGovernanceProfileRequest {
  id: string;
  tenant_id?: string | null;
  official_phone_normalized: string;
  latest_audit?: ContactRunSummary | null;
  latest_visibility?: ContactRunSummary | null;
  created_at?: string;
  updated_at?: string;
  verified_at?: string | null;
}

export interface ContactRunSummary {
  id: string;
  profile_id?: string | null;
  domain?: string;
  project_name?: string;
  status: string;
  summary: Record<string, any>;
  created_at: string;
  finished_at?: string | null;
}

export interface ContactAuditRunRequest {
  profile_id: string;
  urls?: string[];
}

export interface ContactVisibilityRunRequest {
  profile_id: string;
  questions?: string[];
  providers?: string[];
}

export interface ContactAuditResult {
  id?: string;
  run_id?: string;
  source_url: string;
  source_type: string;
  extracted_phone: string;
  normalized_phone: string;
  is_official: boolean;
  is_invalid: boolean;
  has_tel_link: boolean;
  has_label: boolean;
  context_excerpt?: string;
  risk_level: string;
  suggestion?: string;
}

export interface ContactVisibilityResult {
  id?: string;
  run_id?: string;
  provider: string;
  provider_name?: string;
  vendor?: string;
  model?: string;
  question: string;
  status: string;
  answer?: string;
  error?: string;
  detected_phones: string[];
  expected_phone: string;
  correct_phone_shown: boolean;
  wrong_phone_shown: boolean;
  phone_missing: boolean;
  score: number;
}

export interface ContactRunResponse<T> {
  run: ContactRunSummary;
  summary: Record<string, any>;
  results: T[];
}

export interface GeoDriftRequest {
  domain: string;
  save_snapshot?: boolean;
}

export interface BrandSourceScanRequest {
  project_name: string;
  domain?: string;
}

export interface GeoCompetitorCompareRequest {
  primary_domain: string;
  competitor_domains?: string[];
}

export interface CustomerReportExportRequest {
  report: Record<string, unknown>;
  deployment?: Record<string, unknown> | null;
  lead_id?: string | null;
}

export interface QuestionSummaryRequest {
  asset: Record<string, unknown>;
  geo_report_id?: string | null;
  model_report_id?: string | null;
  provider?: string | null;
}

export interface DriftScheduleRequest {
  domain: string;
  frequency?: string;
  enabled?: boolean;
}

export interface SystemUserCreateRequest {
  username: string;
  name: string;
  email?: string;
  role?: string;
  tenant_name?: string;
  lead_id?: string;
  password?: string;
}

export interface SystemUserUpdateRequest {
  username?: string;
  name?: string;
  email?: string;
  role?: string;
  tenant_name?: string;
  lead_id?: string;
  password?: string;
  status?: 'active' | 'disabled';
}

export interface SystemPermissionUpdateRequest {
  can_view?: boolean;
  can_edit?: boolean;
}

export interface ApiKeyCreateRequest {
  name: string;
  scope: string;
}

export interface WritingTaskCreateRequest {
  lead_id?: string;
  source_prompt_id?: string;
  source_prompt_text?: string;
  source_prompt_keyword?: string;
  source_prompt_intent?: string;
  source_prompt_scenario?: string;
  title: string;
  brand?: string;
  domain?: string;
  keyword: string;
  channel?: string;
  angle: string;
  priority?: string;
  outline?: string[];
  report_id?: string;
}

export interface ContentQuestionMiningRequest {
  keyword: string;
  brand?: string;
  domain?: string;
  limit?: number;
}

export interface KnowledgeCreateRequest {
  title: string;
  type: string;
  content: string;
  tags?: string[];
}

export type ContentImageGroupUsage = 'article' | 'product' | 'case' | 'banner' | 'other';

export interface ContentImageGroup {
  id: string;
  tenant_id?: string;
  lead_id?: string;
  lead_name?: string;
  name: string;
  description?: string;
  usage?: ContentImageGroupUsage;
  image_count?: number;
  created_at: string;
  updated_at?: string;
}

export interface ContentImageGroupCreateRequest {
  lead_id: string;
  name: string;
  description?: string;
  usage?: ContentImageGroupUsage;
}

export interface ContentImageRow {
  id: string;
  tenant_id?: string;
  lead_id?: string;
  group_id: string;
  group_name?: string;
  name: string;
  alt: string;
  file_url: string;
  mime_type?: string;
  size?: number;
  created_at: string;
}

export interface DistributionRecordCreateRequest {
  draft_id?: string;
  title: string;
  channel?: string;
  target: string;
  status?: string;
  cost?: number;
  publish_url?: string;
  platform?: string;
  account_name?: string;
  account_id?: string;
  publish_mode?: string;
  platform_entry_url?: string;
  scheduled_at?: string;
  review_note?: string;
  publisher_name?: string;
  /**
   * 手动新建草稿时把正文一起传过来。后端会顺手在 article_drafts 里
   * 建一条记录并用它的 id 当 draft_id，这样"预览草稿"对话框能看到正文。
   */
  draft_body?: string;
}

export interface DistributionRecordPublishRequest {
  platform?: string;
  account_name?: string;
  publish_url?: string;
  scheduled_at?: string;
  review_note?: string;
  publisher_name?: string;
}

export interface DistributionRecordRow {
  id: string;
  draft_id?: string | null;
  task_id?: string | null;
  title: string;
  channel: string;
  target: string;
  status: string;
  cost: number;
  publish_url?: string | null;
  platform?: string | null;
  account_name?: string | null;
  account_id?: string | null;
  publish_mode?: string | null;
  customer_confirmed_at?: string | null;
  customer_confirmed_by?: string | null;
  platform_entry_url?: string | null;
  monitoring_status?: string | null;
  error_message?: string | null;
  scheduled_at?: string | null;
  published_at?: string | null;
  review_note?: string | null;
  publisher_name?: string | null;
  created_at: string;
  updated_at?: string;
  draft_title?: string | null;
  draft_channel?: string | null;
  draft_body?: string | null;
  draft_status?: string | null;
  draft_model?: string | null;
  draft_provider?: string | null;
  draft_created_at?: string | null;
  brand?: string | null;
  domain?: string | null;
  keyword?: string | null;
  priority?: string | null;
  account_home_url?: string | null;
  auth_status?: string | null;
  account_publish_mode?: string | null;
}

export type PublishingAccountType = 'personal' | 'enterprise' | 'organization';
export type PublishingAuthMethod = 'manual' | 'oauth' | 'api_key';

export interface PublishingAccountRow {
  id: string;
  platform: string;
  account_name: string;
  account_home_url?: string | null;
  account_type?: PublishingAccountType | string;
  subject_name?: string | null;
  auth_method?: PublishingAuthMethod | string;
  auth_status: string;
  publish_mode: string;
  remark?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublishingAccountCreateRequest {
  platform: string;
  account_name: string;
  account_home_url?: string;
  account_type?: PublishingAccountType;
  subject_name?: string;
  auth_method?: PublishingAuthMethod;
  auth_status?: string;
  publish_mode?: string;
  remark?: string;
}

export interface OwnedPublishingTaskCreateRequest {
  draft_id: string;
  platform: string;
  account_id: string;
  publish_mode?: string;
  scheduled_at?: string;
  review_note?: string;
}

export interface PublishingTaskCreateRequest {
  draft_id: string;
  platform: string;
  account_id?: string;
  account_name?: string;
  publish_mode?: string;
  scheduled_at?: string;
  review_note?: string;
  platform_entry_url?: string;
}

export interface PublishingTaskActionRequest {
  operator_name?: string;
  review_note?: string;
  publish_url?: string;
  error_message?: string;
}

export type PublishingTaskRow = DistributionRecordRow;

export interface OwnedPublishingTaskRow {
  id: string;
  draft_id?: string | null;
  account_id?: string | null;
  title: string;
  platform: string;
  account_name?: string | null;
  account_type?: PublishingAccountType | string | null;
  subject_name?: string | null;
  status: string;
  publish_mode?: string | null;
  platform_entry_url?: string | null;
  publish_url?: string | null;
  scheduled_at?: string | null;
  published_at?: string | null;
  review_note?: string | null;
  customer_confirmed_at?: string | null;
  customer_confirmed_by?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at?: string;
  draft_title?: string | null;
  draft_channel?: string | null;
  draft_body?: string | null;
  draft_status?: string | null;
  draft_model?: string | null;
  draft_provider?: string | null;
  draft_created_at?: string | null;
  brand?: string | null;
  domain?: string | null;
  keyword?: string | null;
  priority?: string | null;
  account_home_url?: string | null;
  auth_status?: string | null;
  auth_method?: string | null;
  task_source?: 'owned_account';
}

export interface PublishingLogRow {
  id: string;
  task_id: string;
  action: string;
  operator_name?: string | null;
  before_status?: string | null;
  after_status?: string | null;
  detail?: Record<string, unknown>;
  created_at: string;
}

export interface ContentAgentRun {
  id: string;
  task_id?: string | null;
  draft_id?: string | null;
  distribution_id?: string | null;
  content_type: string;
  agent_key: string;
  route_reason?: string | null;
  provider?: string | null;
  status: string;
  stage: string;
  title: string;
  channel: string;
  target: string;
  geo_score?: number;
  score_detail?: Record<string, unknown>;
  calibration?: Record<string, unknown>;
  generated_payload?: Record<string, unknown>;
  error?: string | null;
  brand?: string;
  domain?: string;
  keyword?: string;
  priority?: string;
  task_status?: string;
  created_at?: string;
  updated_at?: string;
  finished_at?: string | null;
}

export type ModelProviderStatus = 'configured' | 'unconfigured' | 'planned' | string;

export interface ModelProviderRow {
  key: string;
  name: string;
  vendor: string;
  endpoint: string;
  model?: string;
  status: ModelProviderStatus;
  configured: boolean;
  testable: boolean;
  has_api_key: boolean;
  weight: number;
  dim: string;
  note: string;
  protocol?: string;
}

export interface ModelProvidersResponse {
  providers: ModelProviderRow[];
  summary: {
    total: number;
    configured: number;
    testable: number;
  };
}

export interface ModelTestResponse extends ModelProviderRow {
  ok: boolean;
  message: string;
  latency_ms?: number | null;
  usage?: Record<string, unknown>;
}

export interface ModelRegressionRequest {
  project_name: string;
  domain?: string;
  questions?: string[];
  providers?: string[];
  source_probe_enabled?: boolean;
}

export interface ModelVisibilityRunRequest extends ModelRegressionRequest {
  lead_id?: string;
  competitors?: string[];
}

export interface ModelVisibilityRun {
  id: string;
  lead_id?: string | null;
  project_name: string;
  domain?: string | null;
  questions: string[];
  providers: string[];
  competitors: string[];
  run_type?: 'normal' | 'source_probe' | string;
  parent_run_id?: string | null;
  source_probe_count?: number;
  latest_source_probe_run_id?: string | null;
  source_probe_runs?: Array<Record<string, unknown>>;
  source_probe_enabled?: boolean;
  status: string;
  summary: {
    total_runs?: number;
    success_runs?: number;
    average_score?: number;
    brand_mention_rate?: number;
    domain_mention_rate?: number;
    recommendation_rate?: number;
    average_rank?: number | null;
    competitor_mention_rate?: number;
    first_rank_rate?: number;
    top3_rate?: number;
    explicit_source_rate?: number;
    no_explicit_source_rate?: number;
  };
  created_at: string;
  finished_at?: string | null;
}

export interface ModelVisibilityResult {
  id?: string;
  run_id?: string;
  provider: string;
  provider_name?: string;
  vendor?: string;
  model?: string;
  question: string;
  status: string;
  answer?: string;
  error?: string;
  score: number;
  brand_mentioned?: boolean;
  domain_mentioned?: boolean;
  recommended?: boolean;
  brand_rank?: number | null;
  competitor_mentions?: string[];
  latency_ms?: number | null;
  answer_length?: number;
  created_at?: string;
}

export interface ModelVisibilityRunResponse {
  run: ModelVisibilityRun;
  results: ModelVisibilityResult[];
}

export interface AgentWorkflowStep {
  id: string;
  run_id: string;
  step_key: string;
  agent_key: string;
  title: string;
  status: string;
  detail?: string | null;
  ref_type?: string | null;
  ref_id?: string | null;
  sort_order?: number;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AgentWorkflowRun {
  id: string;
  lead_id?: string | null;
  project_name: string;
  domain?: string | null;
  keywords?: string[];
  urls?: string[];
  competitors?: string[];
  notes?: string | null;
  mode?: string;
  status: string;
  summary?: string | null;
  task_id?: string | null;
  report_id?: string | null;
  deployment?: Record<string, unknown> | null;
  visibility?: Record<string, unknown> | null;
  retry_count?: number;
  max_retries?: number;
  schedule_frequency?: string;
  schedule_enabled?: boolean;
  next_run_at?: string | null;
  last_inspection?: Record<string, unknown> | null;
  exported_report?: Record<string, unknown> | null;
  n8n_status?: string | null;
  n8n_payload?: Record<string, unknown> | null;
  last_callback_at?: string | null;
  steps?: AgentWorkflowStep[];
  created_at?: string;
  updated_at?: string;
  finished_at?: string | null;
}

export interface AgentWorkflowStartRequest {
  lead_id?: string;
  project_name: string;
  domain?: string;
  description?: string;
  keywords?: string[];
  urls?: string[];
  competitors?: string[];
  notes?: string;
  mode?: string;
  keyword_count?: number;
  prompt_count?: number;
  content_task_limit?: number;
  max_pages?: number;
  language?: GenerationLanguage;
  providers?: string[];
  skip_steps?: string[];
  summary_provider?: string;
  content_provider?: string;
  content_channel?: string;
  content_priority?: string;
  content_allow_fallback?: boolean;
  question_count?: number;
  prompt_keyword_source?: 'non_brand' | 'brand' | 'all';
  prompt_ids?: string[];
  article_generation_mode?: 'basic' | 'official_rewrite' | 'viral_rewrite';
  article_style_key?: string;
  article_prompt_strategy?: 'auto_next' | 'manual';
  article_image_strategy?: 'auto' | 'manual';
  article_source_url?: string;
  article_platform_style?: string;
  article_search_intent?: string;
}

export interface AgentWorkflowCallbackRequest {
  step_key?: string;
  status?: string;
  detail?: string;
  ref_type?: string;
  ref_id?: string;
  payload?: Record<string, unknown>;
}

// -------------------- API 函数 --------------------

export async function getHealth() {
  const { data } = await http.get<Record<string, string>>('/health');
  return data;
}

export async function listModelProviders() {
  const { data } = await http.get<ModelProvidersResponse>('/models/providers');
  return data;
}

export async function testModelProvider(provider: string) {
  const { data } = await http.post<ModelTestResponse>('/models/test', { provider });
  return data;
}

export async function runModelRegression(body: ModelRegressionRequest) {
  const { data } = await http.post<Record<string, unknown>>('/models/regression', body, {
    timeout: MODEL_REGRESSION_TIMEOUT,
  });
  return data;
}

export async function createModelVisibilityRun(body: ModelVisibilityRunRequest) {
  const { data } = await http.post<ModelVisibilityRunResponse>('/model-visibility/runs', body, {
    timeout: MODEL_REGRESSION_TIMEOUT,
  });
  return data;
}

export async function createModelVisibilitySourceProbe(runId: string) {
  const { data } = await http.post<ModelVisibilityRunResponse>(`/model-visibility/runs/${runId}/source-probe`, undefined, {
    timeout: MODEL_REGRESSION_TIMEOUT,
  });
  return data;
}

export async function listModelVisibilityRuns(params?: { limit?: number }) {
  const { data } = await http.get<ModelVisibilityRun[]>('/model-visibility/runs', { params });
  return data;
}

export async function getModelVisibilityRun(runId: string) {
  const { data } = await http.get<ModelVisibilityRunResponse>(`/model-visibility/runs/${runId}`);
  return data;
}

export async function deleteModelVisibilityRun(runId: string) {
  const { data } = await http.delete<{ id: string; project_name: string; deleted: boolean }>(
    `/model-visibility/runs/${runId}`,
  );
  return data;
}

export async function listAgentWorkflows(params?: { limit?: number }) {
  const { data } = await http.get<AgentWorkflowRun[]>('/agent/workflows', { params, timeout: WORKFLOW_LIST_TIMEOUT });
  return data;
}

export async function startAgentWorkflow(body: AgentWorkflowStartRequest) {
  const { data } = await http.post<AgentWorkflowRun>('/agent/workflows', body);
  return data;
}

export async function getAgentWorkflow(runId: string) {
  const { data } = await http.get<AgentWorkflowRun>(`/agent/workflows/${runId}`);
  return data;
}

export interface AgentWorkflowReports {
  run_id: string;
  reports: {
    geo_report?: {
      id: string;
      title: string;
      score?: number;
      grade?: string;
      issues?: string[];
      created_at: string;
    };
    model_report?: {
      id: string;
      project_name: string;
      avg_score?: number;
      brand_rate?: number;
      recommend_rate?: number;
      model_count: number;
      question_count: number;
      created_at?: string;
    };
    summary_report?: {
      id: string;
      project_name: string;
      summary?: string[];
      core_issues?: string[];
      next_actions?: string[];
      provider?: string;
      model?: string;
      created_at: string;
    };
    analysis_report?: {
      id: string;
      score?: number;
      grade?: string;
      summary?: string;
      created_at: string;
    };
  };
}

export async function getAgentWorkflowReports(runId: string) {
  const { data } = await http.get<AgentWorkflowReports>(`/agent/workflows/${runId}/reports`);
  return data;
}

export async function retryAgentWorkflow(runId: string, body?: { force?: boolean }) {
  const { data } = await http.post<AgentWorkflowRun>(`/agent/workflows/${runId}/retry`, body || {});
  return data;
}

export async function inspectAgentWorkflow(runId: string) {
  const { data } = await http.post<AgentWorkflowRun>(`/agent/workflows/${runId}/inspect`);
  return data;
}

export async function inspectDueAgentWorkflows(params?: { limit?: number }) {
  const { data } = await http.post<Record<string, unknown>>('/agent/workflows/inspect-due', null, { params });
  return data;
}

export async function configureAgentWorkflowSchedule(runId: string, body?: { frequency?: string; enabled?: boolean }) {
  const { data } = await http.post<AgentWorkflowRun>(`/agent/workflows/${runId}/schedule`, {
    frequency: body?.frequency ?? 'weekly',
    enabled: body?.enabled ?? true,
  });
  return data;
}

export async function sendAgentWorkflowCallback(runId: string, body: AgentWorkflowCallbackRequest) {
  const { data } = await http.post<AgentWorkflowRun>(`/agent/workflows/${runId}/n8n-callback`, body);
  return data;
}

export async function cancelAgentWorkflow(runId: string) {
  const { data } = await http.post<AgentWorkflowRun>(`/agent/workflows/${runId}/cancel`);
  return data;
}

export async function exportAgentWorkflowReport(runId: string) {
  const { data } = await http.post<Record<string, unknown>>(`/agent/workflows/${runId}/export-report`);
  return data;
}

export async function authLogin(body: { username: string; password: string }) {
  const { data } = await http.post<Record<string, any>>('/auth/login', body);
  return data;
}

export async function authSendRegisterCode(body: { phone: string }) {
  const { data } = await http.post<Record<string, any>>('/auth/register/send-code', body);
  return data;
}

export async function authRegister(body: {
  name: string;
  phone: string;
  verification_code: string;
  password: string;
  company?: string;
}) {
  const { data } = await http.post<Record<string, any>>('/auth/register', body);
  return data;
}

export async function authChangePassword(body: { current_password: string; new_password: string }) {
  const { data } = await http.post<Record<string, any>>('/auth/change-password', body);
  return data;
}

/** GET /tasks  */
export async function listTasks(params?: { latest_only?: boolean }) {
  const { data } = await http.get<AnalysisTaskRow[]>('/tasks', { params });
  return data;
}

/** POST /tasks  */
export async function createTask(body: TaskCreateRequest) {
  const { data } = await http.post<TaskResponse>('/tasks', body);
  return data;
}

/** GET /leads */
export async function listLeads(params?: {
  notify_status?: string;
  followup_status?: FollowupStatus;
  active_only?: boolean;
}) {
  const { data } = await http.get<Lead[]>('/leads', { params });
  pruneLeadCachesFromCurrentLeads(data);
  return data;
}

/** GET /leads?active_only=true — 用于选择框，过滤关闭/已删除资产 */
export async function listSelectableLeads(params?: { notify_status?: string; followup_status?: FollowupStatus }) {
  return listLeads({ ...params, active_only: true });
}

/** PATCH /leads/{lead_id}  */
export async function updateLead(leadId: string, body: LeadUpdateRequest) {
  const { data } = await http.patch<Lead>(`/leads/${leadId}`, body);
  return data;
}

/** DELETE /leads/{lead_id} */
export async function deleteLead(leadId: string) {
  const { data } = await http.delete<Record<string, unknown>>(`/leads/${leadId}`);
  const deletedLead = (data.deleted_lead || data.lead) as Lead | undefined;
  if (deletedLead?.id) {
    purgeDeletedLeadCaches([deletedLead]);
  }
  return data;
}

/** POST /consultation-leads */
export async function createConsultationLead(body: ConsultationLeadCreateRequest) {
  const { data } = await http.post<ConsultationLeadResponse>('/consultation-leads', body);
  return data;
}

/** POST /keyword-expansion/generate */
export async function generateKeywordExpansion(body: KeywordExpansionRequest) {
  const { data } = await http.post<KeywordExpansionResponse>('/keyword-expansion/generate', body, {
    timeout: KEYWORD_EXPANSION_TIMEOUT,
  });
  return data;
}

/** POST /keyword-expansion/runs */
export async function createKeywordGenerationRun(body: KeywordExpansionRequest) {
  const { data } = await http.post<{
    run_id: string;
    run: KeywordGenerationRun;
    reused_existing?: boolean;
    active_existing?: boolean;
  }>('/keyword-expansion/runs', body, {
    timeout: 30000,
  });
  return data;
}

/** GET /keyword-expansion/runs/{run_id} */
export async function getKeywordGenerationRun(runId: string) {
  const { data } = await http.get<{ run: KeywordGenerationRun }>(`/keyword-expansion/runs/${runId}`);
  return data.run;
}

/** GET /keyword-expansion/runs/active */
export async function getActiveKeywordGenerationRun() {
  const { data } = await http.get<{ run: KeywordGenerationRun | null }>('/keyword-expansion/runs/active');
  return data.run;
}

/** GET /keyword-expansion/non-brand-keywords */
export async function listNonBrandKeywords(params?: {
  lead_id?: string;
  brand_name?: string;
  domain?: string;
  limit?: number;
}) {
  const { data } = await http.get<KeywordInventoryListResponse>('/keyword-expansion/non-brand-keywords', { params });
  return data;
}

/** GET /keyword-prompts */
export async function listKeywordPrompts(params?: {
  prompt_id?: string;
  lead_id?: string;
  brand_name?: string;
  domain?: string;
  limit?: number;
}) {
  const { data } = await http.get<KeywordPromptListResponse>('/keyword-prompts', { params });
  return data;
}

/** POST /keyword-prompts/generate */
export async function generateKeywordPrompts(body: KeywordPromptGenerateRequest) {
  const { data } = await http.post<KeywordPromptGenerateResponse>('/keyword-prompts/generate', body, {
    timeout: KEYWORD_EXPANSION_TIMEOUT,
  });
  return data;
}

/** DELETE /keyword-prompts/{prompt_id} */
export async function deleteKeywordPrompt(promptId: string) {
  const { data } = await http.delete<{ id: string; deleted: boolean }>(`/keyword-prompts/${promptId}`);
  return data;
}

/** POST /keyword-prompts/delete-batch */
export async function deleteKeywordPrompts(body: KeywordPromptDeleteRequest) {
  const { data } = await http.post<{ deleted: number; ids: string[] }>('/keyword-prompts/delete-batch', body);
  return data;
}

/** GET /reports/{report_id} */
export async function getReport(reportId: string) {
  const { data } = await http.get<ReportResponse>(`/reports/${reportId}`);
  return data;
}

/** GET /logs/{task_id} */
export async function getTaskLogs(taskId: string) {
  const { data } = await http.get<Record<string, unknown>[]>(`/logs/${taskId}`);
  return data;
}

export async function generateLlmsTxt(body: GeoAssetRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/llms-txt', body);
  return data;
}

export async function generateSchemaJsonld(body: GeoAssetRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/schema-jsonld', body);
  return data;
}

export async function getBrandVisibility(body: BrandVisibilityRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/brand-visibility', body);
  return data;
}

export async function auditGeoAssets(body: GeoAssetAuditRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/asset-audit', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function auditTechnicalGeoSeo(body: GeoAssetAuditRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/technical-audit', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function analyzeGeoSitemap(body: GeoSitemapRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/sitemap-analysis', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function auditGeoPerformance(body: GeoPerformanceRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/performance-audit', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function auditContentExtractability(body: GeoContentExtractabilityRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/content-extractability', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function buildPromptMonitorReport(body: GeoPromptMonitorReportRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/prompt-monitor-report', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function generateLlmsFullTxt(body: GeoLlmsFullRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/llms-full', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function monitorGeoDrift(body: GeoDriftRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/drift-monitor', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function generateDeploymentPackage(body: GeoDeploymentPackageRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/deployment-package', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function downloadDeploymentPackageArchive(body: Record<string, unknown>) {
  const { data } = await http.post<Blob>('/geo/deployment-package/archive', body, {
    responseType: 'blob',
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function createContactGovernanceProfile(body: ContactGovernanceProfileRequest) {
  const { data } = await http.post<ContactGovernanceProfile>('/contact-governance/profiles', body);
  return data;
}

export async function listContactGovernanceProfiles(params?: { limit?: number }) {
  const { data } = await http.get<ContactGovernanceProfile[]>('/contact-governance/profiles', { params });
  return data;
}

export async function getContactGovernanceProfile(profileId: string) {
  const { data } = await http.get<ContactGovernanceProfile>(`/contact-governance/profiles/${profileId}`);
  return data;
}

export async function updateContactGovernanceProfile(
  profileId: string,
  body: Partial<ContactGovernanceProfileRequest>,
) {
  const { data } = await http.put<ContactGovernanceProfile>(`/contact-governance/profiles/${profileId}`, body);
  return data;
}

export async function deleteContactGovernanceProfile(profileId: string) {
  const { data } = await http.delete<{ id: string; project_name: string; deleted: boolean }>(
    `/contact-governance/profiles/${profileId}`,
  );
  return data;
}

export async function createContactAuditRun(body: ContactAuditRunRequest) {
  const { data } = await http.post<ContactRunResponse<ContactAuditResult>>('/contact-governance/audit-runs', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function createContactVisibilityRun(body: ContactVisibilityRunRequest) {
  const { data } = await http.post<ContactRunResponse<ContactVisibilityResult>>(
    '/contact-governance/visibility-runs',
    body,
    { timeout: MODEL_REGRESSION_TIMEOUT },
  );
  return data;
}

export async function generateContactDeploymentPackage(body: { profile_id: string }) {
  const { data } = await http.post<Record<string, any>>('/contact-governance/deployment-package', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function exportCustomerReport(body: CustomerReportExportRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/customer-report-export', body);
  return data;
}

export async function listQuestionGeoReports(params?: { domain?: string; limit?: number }) {
  const { data } = await http.get<Record<string, unknown>[]>('/questions/geo-reports', { params });
  return data;
}

export async function createQuestionSummary(body: QuestionSummaryRequest) {
  const { data } = await http.post<Record<string, unknown>>('/questions/summaries', body, {
    timeout: MODEL_REGRESSION_TIMEOUT,
  });
  return data;
}

export async function listQuestionSummaries(params?: { domain?: string; limit?: number }) {
  const { data } = await http.get<Record<string, unknown>[]>('/questions/summaries', { params });
  return data;
}

export async function scanBrandSources(body: BrandSourceScanRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/brand-source-scan', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function compareGeoCompetitors(body: GeoCompetitorCompareRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/competitor-compare', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function configureDriftSchedule(body: DriftScheduleRequest) {
  const { data } = await http.post<Record<string, unknown>>('/geo/drift-schedule', body);
  return data;
}

export async function listDriftSchedules() {
  const { data } = await http.get<Record<string, unknown>[]>('/geo/drift-schedules');
  return data;
}

export async function listDriftSnapshots(params?: { domain?: string; limit?: number }) {
  const { data } = await http.get<Record<string, unknown>[]>('/geo/drift-snapshots', { params });
  return data;
}

export async function runDueDriftSchedules(params?: { limit?: number }) {
  const { data } = await http.post<Record<string, unknown>>('/geo/drift-schedules/run-due', null, { params });
  return data;
}

export async function listSystemUsers() {
  const { data } = await http.get<Record<string, unknown>[]>('/system/users');
  return data;
}

export async function listSystemCustomerAssetOptions() {
  const { data } = await http.get<Record<string, unknown>[]>('/system/customer-assets/options');
  return data;
}

export async function createSystemUser(body: SystemUserCreateRequest) {
  const { data } = await http.post<Record<string, unknown>>('/system/users', body);
  return data;
}

export async function updateSystemUser(userId: string, body: SystemUserUpdateRequest) {
  const { data } = await http.patch<Record<string, unknown>>(`/system/users/${userId}`, body);
  return data;
}

export async function deleteSystemUser(userId: string) {
  const { data } = await http.delete<{ ok: boolean }>(`/system/users/${userId}`);
  return data;
}

export async function resetSystemUserPassword(userId: string) {
  const { data } = await http.post<Record<string, unknown>>(`/system/users/${userId}/reset-password`);
  return data;
}

export async function listSystemPermissions() {
  const { data } = await http.get<Record<string, unknown>[]>('/system/permissions');
  return data;
}

export async function updateSystemPermission(role: string, module: string, body: SystemPermissionUpdateRequest) {
  const { data } = await http.patch<Record<string, unknown>>(
    `/system/permissions/${encodeURIComponent(role)}/${encodeURIComponent(module)}`,
    body,
  );
  return data;
}

export async function listSystemApiKeys() {
  const { data } = await http.get<Record<string, unknown>[]>('/system/api-keys');
  return data;
}

export async function createSystemApiKey(body: ApiKeyCreateRequest) {
  const { data } = await http.post<Record<string, unknown>>('/system/api-keys', body);
  return data;
}

export async function listSystemLogs() {
  const { data } = await http.get<Record<string, unknown>[]>('/system/logs');
  return data;
}

export interface SystemHealthCheck {
  key: string;
  name: string;
  status: 'ok' | 'warning' | 'error' | string;
  message?: string;
  meta?: Record<string, unknown>;
}

export async function getSystemHealth() {
  const { data } = await http.get<{ status: string; checks: SystemHealthCheck[] }>('/system/health');
  return data;
}

export interface CustomerActivityLog {
  id: string;
  tenant_id?: string | null;
  tenant_name?: string | null;
  user_id?: string | null;
  user_name?: string | null;
  user_email?: string | null;
  role?: string | null;
  module: string;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  status: 'success' | 'failed' | 'running' | string;
  message?: string | null;
  error_type?: string | null;
  error_detail?: string | null;
  request_payload?: Record<string, unknown>;
  response_summary?: Record<string, unknown>;
  request_id?: string | null;
  created_at: string;
  step_count?: number;
  failed_step_count?: number;
}

export interface ObservabilitySummary {
  status: 'ok' | 'alerting' | string;
  window_minutes: number;
  metrics: {
    model: {
      total: number;
      failures: number;
      failure_rate: number;
    };
    task_queue: {
      backend?: string;
      status?: string;
      queue?: string;
      backlog: number;
      queued_jobs: number;
      running_jobs: number;
      active_jobs: number;
      finished_recent: number;
      failures: number;
      failure_rate: number;
      message?: string;
    };
    frontend: {
      errors: number;
      total_events: number;
    };
  };
  alerts: Array<{
    key: string;
    severity: 'warning' | 'critical' | string;
    title: string;
    message: string;
  }>;
}

export async function getObservabilitySummary(params?: { window_minutes?: number }) {
  const { data } = await http.get<ObservabilitySummary>('/observability/summary', { params });
  return data;
}

export interface ObservableTenant {
  id: string;
  name: string;
  plan?: string;
  credit_balance?: number;
  created_at?: string;
  user_count?: number;
  activity_count?: number;
  last_activity_at?: string | null;
}

export async function listObservableTenants() {
  const { data } = await http.get<ObservableTenant[]>('/observability/tenants');
  return data;
}

export interface CustomerOperationStep {
  id: string;
  activity_id: string;
  step_key: string;
  step_name: string;
  status: 'success' | 'failed' | 'running' | string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number | null;
  message?: string | null;
  error_detail?: string | null;
}

export async function listCustomerActivities(params?: {
  tenant_id?: string;
  module?: string;
  status?: string;
  error_type?: string;
  q?: string;
  limit?: number;
}) {
  const { data } = await http.get<CustomerActivityLog[]>('/observability/activities', { params });
  return data;
}

export async function getCustomerActivity(activityId: string) {
  const { data } = await http.get<{ activity: CustomerActivityLog; steps: CustomerOperationStep[] }>(
    `/observability/activities/${activityId}`,
  );
  return data;
}

export interface BillingPlan {
  id: string;
  code: string;
  name: string;
  price_monthly: number;
  price_yearly: number;
  price_monthly_yuan?: number;
  price_yearly_yuan?: number;
  monthly_credits: number;
  max_projects?: number | null;
  max_users?: number | null;
  features?: string[];
  limits?: string[];
  status?: string;
}

export interface CreditPack {
  id: string;
  code: string;
  name: string;
  credits: number;
  price_cents: number;
  price_yuan?: number;
  description?: string;
  status?: string;
}

export interface BillingTransaction {
  id: string;
  tenant_id: string;
  amount: number;
  direction: string;
  entry_type: string;
  module: string;
  description: string;
  ref_type?: string | null;
  ref_id?: string | null;
  status?: string;
  balance_after?: number;
  created_at?: string;
}

export interface BillingOrder {
  id: string;
  tenant_id: string;
  tenant_name?: string;
  order_no: string;
  order_type: string;
  status: string;
  amount_cents: number;
  amount_yuan?: number;
  credits: number;
  plan_code?: string | null;
  credit_pack_code?: string | null;
  payment_method?: string;
  description?: string;
  paid_at?: string | null;
  created_at?: string;
}

export interface BillingOrderPage {
  items: BillingOrder[];
  total: number;
  page: number;
  page_size: number;
}

export interface BillingOrderSummary {
  total: number;
  pending: number;
  paid: number;
  cancelled: number;
  expired: number;
  failed: number;
  paid_amount_cents: number;
  pending_amount_cents: number;
  paid_amount_yuan?: number;
  pending_amount_yuan?: number;
  pending_type_counts?: Record<string, number>;
}

export type BillingOrderPageParams = {
  tenant_id?: string;
  status?: string;
  order_type?: string;
  page?: number;
  page_size?: number;
};

export interface BillingAccountResponse {
  tenant?: Record<string, any>;
  account?: Record<string, any>;
  transactions?: BillingTransaction[];
  orders?: BillingOrder[];
  plans?: BillingPlan[];
  credit_packs?: CreditPack[];
}

export async function getBillingAccount(params?: { tenant_id?: string }) {
  const { data } = await http.get<BillingAccountResponse>('/billing/account', { params });
  return data;
}

export async function getBillingPlans() {
  const { data } = await http.get<BillingPlan[]>('/billing/plans');
  return data;
}

export async function getCreditPacks() {
  const { data } = await http.get<CreditPack[]>('/billing/credit-packs');
  return data;
}

export async function getBillingTransactions(params?: {
  tenant_id?: string;
  limit?: number;
  module?: string;
  entry_type?: string;
}) {
  const { data } = await http.get<BillingTransaction[]>('/billing/transactions', { params });
  return data;
}

export async function getBillingOrders(params?: {
  tenant_id?: string;
  limit?: number;
  status?: string;
  order_type?: string;
}) {
  const { data } = await http.get<BillingOrder[]>('/billing/orders', { params });
  return data;
}

export async function getBillingOrdersPage(params?: BillingOrderPageParams) {
  const { data } = await http.get<BillingOrderPage>('/billing/orders', { params });
  return data;
}

export async function getBillingOrderSummary(params?: { tenant_id?: string }) {
  const { data } = await http.get<BillingOrderSummary>('/billing/order-summary', { params });
  return data;
}

export async function createBillingOrder(body: {
  order_type?: 'credit_pack' | 'plan_subscription' | 'manual_contract';
  payment_method?: 'wechat' | 'alipay' | 'bank';
  tenant_id?: string;
  credit_pack_code?: string;
  plan_code?: string;
  amount_cents?: number;
  credits?: number;
  description?: string;
}) {
  const { data } = await http.post<BillingOrder>('/billing/orders', body);
  return data;
}

export async function cancelBillingOrder(orderId: string) {
  const { data } = await http.post<BillingOrder>(`/billing/orders/${orderId}/cancel`);
  return data;
}

export async function getAdminBillingOrders(params?: {
  tenant_id?: string;
  limit?: number;
  status?: string;
  order_type?: string;
}) {
  const { data } = await http.get<BillingOrder[]>('/admin/billing/orders', { params });
  return data;
}

export async function getAdminBillingOrdersPage(params?: BillingOrderPageParams) {
  const { data } = await http.get<BillingOrderPage>('/admin/billing/orders', { params });
  return data;
}

export async function getAdminBillingOrderSummary(params?: { tenant_id?: string }) {
  const { data } = await http.get<BillingOrderSummary>('/admin/billing/order-summary', { params });
  return data;
}

export async function cancelAdminBillingOrder(orderId: string) {
  const { data } = await http.post<BillingOrder>(`/admin/billing/orders/${orderId}/cancel`);
  return data;
}

export async function adjustCredits(body: {
  amount: number;
  description?: string;
  tenant_id?: string;
  refresh_expiry?: boolean;
}) {
  const { data } = await http.post<BillingTransaction>('/billing/credits/adjust', body);
  return data;
}

export async function adminAdjustCredits(body: {
  amount: number;
  description: string;
  tenant_id: string;
  refresh_expiry?: boolean;
}) {
  const { data } = await http.post<BillingTransaction>('/admin/billing/credits/adjust', body);
  return data;
}

export async function markBillingOrderPaid(orderId: string) {
  const { data } = await http.post<BillingOrder>(`/admin/billing/orders/${orderId}/mark-paid`);
  return data;
}

export async function getAdminBillingAccounts() {
  const { data } = await http.get<Record<string, any>[]>('/admin/billing/accounts');
  return data;
}

export async function listContentTasksDb(params?: { limit?: number }) {
  const { data } = await http.get<Record<string, unknown>[]>('/content/tasks', { params });
  return data;
}

export async function createContentTaskDb(body: WritingTaskCreateRequest) {
  const { data } = await http.post<Record<string, unknown>>('/content/tasks', body);
  return data;
}

export async function mineContentQuestions(body: ContentQuestionMiningRequest) {
  const { data } = await http.post<Record<string, unknown>>('/content/questions/mine', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function listContentAgentRuns(params?: { limit?: number }) {
  const { data } = await http.get<ContentAgentRun[]>('/content/agent-runs', { params, timeout: WORKFLOW_LIST_TIMEOUT });
  return data;
}

export async function startContentAgentRun(taskId: string, provider?: string) {
  const { data } = await http.post<ContentAgentRun>('/content/agent-runs', {
    task_id: taskId,
    provider: provider || undefined,
  });
  return data;
}

export async function autoStartContentAgentRuns(params?: { limit?: number; provider?: string }) {
  const { data } = await http.post<Record<string, unknown>>('/content/agent-runs/auto-start', null, { params });
  return data;
}

export async function retryContentAgentRun(runId: string) {
  const { data } = await http.post<ContentAgentRun>(`/content/agent-runs/${runId}/retry`);
  return data;
}

export async function listBrandKnowledgeDb() {
  const { data } = await http.get<Record<string, unknown>[]>('/content/knowledge');
  return data;
}

export async function createBrandKnowledgeDb(body: KnowledgeCreateRequest) {
  const { data } = await http.post<Record<string, unknown>>('/content/knowledge', body);
  return data;
}

export async function listImageGroupsDb(params?: { lead_id?: string }) {
  const { data } = await http.get<ContentImageGroup[]>('/content/image-groups', { params });
  return data;
}

export async function createImageGroupDb(body: ContentImageGroupCreateRequest) {
  const { data } = await http.post<ContentImageGroup>('/content/image-groups', body);
  return data;
}

export async function updateImageGroupDb(groupId: string, body: Partial<ContentImageGroupCreateRequest>) {
  const { data } = await http.patch<ContentImageGroup>(`/content/image-groups/${groupId}`, body);
  return data;
}

export async function deleteImageGroupDb(groupId: string) {
  const { data } = await http.delete<{ ok: boolean; id: string }>(`/content/image-groups/${groupId}`);
  return data;
}

export async function listManagedImagesDb(params?: { group_id?: string; lead_id?: string }) {
  const { data } = await http.get<ContentImageRow[]>('/content/images', { params });
  return data;
}

export async function getManagedImageDb(imageId: string) {
  const { data } = await http.get<ContentImageRow>(`/content/images/${imageId}`);
  return data;
}

export async function uploadManagedImageDb(body: { file: File; group_id: string; lead_id: string; alt?: string }) {
  const form = new FormData();
  form.append('file', body.file);
  form.append('group_id', body.group_id);
  form.append('lead_id', body.lead_id);
  if (body.alt) form.append('alt', body.alt);
  const { data } = await http.post<ContentImageRow>('/content/images/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function deleteManagedImageDb(imageId: string) {
  const { data } = await http.delete<{ ok: boolean; id: string }>(`/content/images/${imageId}`);
  return data;
}

export interface ArticleGenerateDbRequest {
  task_id: string;
  client_request_id?: string;
  source_prompt_id?: string;
  source_prompt_text?: string;
  source_prompt_keyword?: string;
  source_prompt_intent?: string;
  source_prompt_scenario?: string;
  company_info?: string;
  prompt_text?: string;
  provider?: string;
  language?: GenerationLanguage;
  generation_mode?: string;
  style_key?: string;
  platform?: PlatformRewriteTarget;
  compliance_mode?: 'standard' | 'strict';
  use_source_preference?: boolean;
  source_preference_profile?: Record<string, unknown>;
  images?: Array<{
    id?: string;
    name?: string;
    group?: string;
    alt?: string;
    url?: string;
    file_url?: string;
  }>;
}

export interface ArticleGenerationRun {
  id: string;
  tenant_id?: string;
  user_id?: string;
  mode: 'basic' | 'official_rewrite' | 'viral_rewrite';
  task_id?: string;
  source_prompt_id?: string;
  source_prompt_text?: string;
  client_request_id?: string;
  requested_count: number;
  created_count: number;
  draft_ids: string[];
  status: 'queued' | 'running' | 'succeeded' | 'succeeded_with_warning' | 'failed' | 'timeout';
  stage: string;
  queue_id?: string;
  reused_existing?: boolean;
  error_type?: string;
  error_detail?: string;
  started_at?: string;
  updated_at?: string;
  finished_at?: string;
  duration_ms?: number;
  payload?: Record<string, unknown>;
  preference_snapshot_json?: Record<string, unknown>;
}

export interface ArticleGenerationRunCreateRequest extends ArticleGenerateDbRequest {
  mode?: 'basic' | 'official_rewrite' | 'viral_rewrite';
  requested_count?: number;
}

export interface SourcePreferenceProfile {
  filters: Record<string, unknown>;
  generated_at: string;
  answer_count: number;
  explicit_source_answer_count: number;
  no_explicit_source_answer_count: number;
  source_count: number;
  article_profile_count: number;
  verified_source_count?: number;
  suspected_source_count?: number;
  summary: Record<string, unknown>;
  top_source_domains: Array<Record<string, unknown>>;
  source_type_distribution: Array<Record<string, unknown>>;
  source_verification_distribution?: Array<Record<string, unknown>>;
  article_type_distribution: Array<Record<string, unknown>>;
  trust_anchor_rates: Record<string, Record<string, unknown>>;
  average_structure: Record<string, unknown>;
  recommendations: Record<string, unknown>;
  parent_run?: Record<string, unknown>;
  latest_source_probe_run?: Record<string, unknown>;
  source_probe_runs?: Array<Record<string, unknown>>;
  prompt?: Record<string, unknown>;
}

export interface ContentOptimizationCampaignCreateRequest {
  article_generation_run_id?: string;
  draft_id?: string;
  brand: string;
  domain?: string;
  published_url?: string;
  target_prompts?: string[];
  target_keywords?: string[];
  before_run_id?: string;
  providers?: string[];
  competitors?: string[];
  published_at?: string;
}

export interface ContentOptimizationRetestRequest {
  providers?: string[];
  questions?: string[];
  competitors?: string[];
}

export type PlatformRewriteTarget = 'zhihu' | 'xiaohongshu' | 'wechat' | 'moments' | 'video';

export interface ArticlePlatformRewriteRequest {
  article_id?: string;
  source_url?: string;
  client_request_id?: string;
  platform: PlatformRewriteTarget;
  provider?: string;
  user_angle?: string;
  image_notes?: string;
  selected_intents?: string[];
  language?: GenerationLanguage;
  generation_mode?: string;
  style_key?: string;
}

export interface ArticlePlatformIntent {
  id: string;
  label: string;
  description?: string;
}

export interface ArticlePlatformIntentAnalyzeResponse {
  source_url: string;
  source_title?: string | null;
  intents: ArticlePlatformIntent[];
}

export interface ArticlePlatformRewriteResponse {
  article_id: string;
  source_title?: string | null;
  source_url?: string | null;
  platform: PlatformRewriteTarget;
  body: string;
  provider: string;
  model: string;
  compliance?: ArticleComplianceResult;
}

export interface ArticleViralRewriteRequest {
  source_url?: string;
  source_text?: string;
  client_request_id?: string;
  lead_id?: string;
  platform: PlatformRewriteTarget;
  provider?: string;
  user_angle?: string;
  brand_context?: string;
  image_notes?: string;
  language?: GenerationLanguage;
  style_key?: string;
}

export interface ArticleViralRewriteResponse {
  draft_id?: string;
  source_title?: string | null;
  source_url?: string | null;
  source_mode?: 'url' | 'pasted_text' | string;
  viral_analysis?: {
    hook?: string;
    audience?: string;
    pain_points?: string[];
    structure?: string[];
    cta?: string;
    transferable_patterns?: string[];
  };
  title: string;
  body: string;
  platform: PlatformRewriteTarget;
  provider: string;
  model: string;
  compliance?: ArticleComplianceResult;
  length_policy?: {
    source_chars?: number;
    source_paragraphs?: number;
    source_headings?: number;
    source_lists?: number;
    target_min_chars?: number;
    target_max_chars?: number;
    final_chars?: number;
    status?: string;
    note?: string;
  };
}

export type ArticleComplianceStatus = 'pass' | 'warning' | 'blocked' | 'not_checked';

export interface ArticleComplianceIssue {
  level: 'pass' | 'warning' | 'blocked' | string;
  code: string;
  message: string;
  suggestion?: string;
}

export interface ArticleComplianceResult {
  platform?: PlatformRewriteTarget | string;
  platform_name?: string;
  status: ArticleComplianceStatus;
  summary?: string;
  rule_summary?: string;
  ai_disclosure_required?: boolean;
  source_required?: boolean;
  fiction_disclosure_required?: boolean;
  human_review_required?: boolean;
  human_reviewed?: boolean;
  issues?: ArticleComplianceIssue[];
}

export interface ArticleComplianceCheckRequest {
  platform?: PlatformRewriteTarget;
  title?: string;
  body: string;
  generation_mode?: string;
  source_url?: string;
  source_text?: string;
  human_reviewed?: boolean;
}

export async function createArticleGenerationRunDb(body: ArticleGenerationRunCreateRequest) {
  const { data } = await http.post<{
    run_id: string;
    run: ArticleGenerationRun;
    reused_existing?: boolean;
    active_existing?: boolean;
  }>('/content/articles/generation-runs', body, {
    timeout: 30000,
  });
  return data;
}

export async function getArticleGenerationRunDb(runId: string) {
  const { data } = await http.get<{ run: ArticleGenerationRun }>(`/content/articles/generation-runs/${runId}`);
  return data.run;
}

export async function getActiveArticleGenerationRunDb() {
  const { data } = await http.get<{ run: ArticleGenerationRun | null }>('/content/articles/generation-runs/active');
  return data.run;
}

export async function getSourcePreferences(params?: {
  parent_run_id?: string;
  source_probe_run_id?: string;
  project_name?: string;
  domain?: string;
  question?: string;
  model?: string;
  provider?: string;
  run_type?: string;
  verification_status?: string;
  days?: number;
}) {
  const { data } = await http.get<SourcePreferenceProfile>('/visibility/source-preferences', { params });
  return data;
}

export async function getPromptSourcePreferences(promptId: string, params?: { days?: number }) {
  const { data } = await http.get<SourcePreferenceProfile>(`/visibility/source-preferences/prompts/${promptId}`, {
    params,
  });
  return data;
}

export async function createContentOptimizationCampaign(body: ContentOptimizationCampaignCreateRequest) {
  const { data } = await http.post<{ campaign: Record<string, unknown> }>('/content/optimization-campaigns', body);
  return data;
}

export async function retestContentOptimizationCampaign(
  campaignId: string,
  body: ContentOptimizationRetestRequest = {},
) {
  const { data } = await http.post<{
    campaign: Record<string, unknown>;
    run: ModelVisibilityRun;
    report: Record<string, unknown>;
  }>(`/content/optimization-campaigns/${campaignId}/retest`, body, { timeout: HEAVY_GEO_REQUEST_TIMEOUT });
  return data;
}

export async function getContentOptimizationReport(campaignId: string) {
  const { data } = await http.get<{
    campaign: Record<string, unknown>;
    report: Record<string, unknown>;
  }>(`/content/optimization-campaigns/${campaignId}/report`);
  return data;
}

export async function getContentOptimizationTrend(campaignId: string) {
  const { data } = await http.get<{
    campaign: Record<string, unknown>;
    trend: Array<Record<string, unknown>>;
  }>(`/content/optimization-campaigns/${campaignId}/trend`);
  return data;
}

export async function generateArticleDb(body: string | ArticleGenerateDbRequest) {
  const payload = typeof body === 'string' ? { task_id: body } : body;
  const { data } = await http.post<Record<string, unknown>>('/content/articles/generate', payload, {
    timeout: ARTICLE_GENERATION_TIMEOUT,
  });
  return data;
}

export async function analyzeArticlePlatformIntentsDb(sourceUrl: string) {
  const { data } = await http.post<ArticlePlatformIntentAnalyzeResponse>(
    '/content/articles/platform-intents',
    { source_url: sourceUrl },
    { timeout: HEAVY_GEO_REQUEST_TIMEOUT },
  );
  return data;
}

export async function rewriteArticleForPlatformDb(body: ArticlePlatformRewriteRequest) {
  const { data } = await http.post<ArticlePlatformRewriteResponse>('/content/articles/platform-rewrite', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function rewriteViralArticleDb(body: ArticleViralRewriteRequest) {
  const { data } = await http.post<ArticleViralRewriteResponse>('/content/articles/viral-rewrite', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function checkArticleComplianceDb(body: ArticleComplianceCheckRequest) {
  const { data } = await http.post<ArticleComplianceResult>('/content/articles/compliance-check', body, {
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
  return data;
}

export async function listArticleDraftsDb(params?: { limit?: number; prompt_id?: string; lead_id?: string }) {
  const { data } = await http.get<Record<string, unknown>[]>('/content/articles', { params });
  return data;
}

export async function getArticleDraftDb(draftId: string) {
  const { data } = await http.get<Record<string, unknown>>(`/content/articles/${draftId}`);
  return data;
}

export async function exportArticleDocxDb(draftId: string) {
  return http.get<Blob>(`/content/articles/${draftId}/export-docx`, {
    responseType: 'blob',
    timeout: HEAVY_GEO_REQUEST_TIMEOUT,
  });
}

export async function createArticleDraftDb(body: {
  task_id?: string;
  source_prompt_id?: string;
  source_prompt_text?: string;
  source_prompt_keyword?: string;
  source_prompt_intent?: string;
  source_prompt_scenario?: string;
  generated_from?: string;
  title: string;
  channel?: string;
  article_type?: string;
  body: string;
  model?: string;
  provider?: string;
  status?: string;
  compliance_platform?: string;
  compliance_status?: ArticleComplianceStatus | string;
  compliance_summary?: string;
  compliance_issues?: ArticleComplianceIssue[];
  ai_disclosure_required?: boolean;
  source_required?: boolean;
  fiction_disclosure_required?: boolean;
  human_review_required?: boolean;
}) {
  const { data } = await http.post<Record<string, unknown>>('/content/articles', body);
  return data;
}

export async function updateArticleDraftDb(
  draftId: string,
  body: { title?: string; body: string; status?: string; human_reviewed?: boolean },
) {
  const { data } = await http.patch<Record<string, unknown>>(`/content/articles/${draftId}`, body);
  return data;
}

export async function deleteArticleDraftDb(draftId: string) {
  const { data } = await http.delete<Record<string, unknown>>(`/content/articles/${draftId}`);
  return data;
}

/** GET /content/article-library?lead_id=X — full chain: lead -> prompts -> tasks(+drafts) */
export async function fetchArticleLibrary(leadId: string) {
  const { data } = await http.get<ArticleLibraryResponse>('/content/article-library', {
    params: { lead_id: leadId },
  });
  return data;
}

export async function listDistributionRecordsDb() {
  const { data } = await http.get<DistributionRecordRow[]>('/distribution/records');
  return data;
}

export async function createDistributionRecordDb(body: DistributionRecordCreateRequest) {
  const { data } = await http.post<DistributionRecordRow>('/distribution/records', body);
  return data;
}

export async function confirmDistributionRecordPublish(recordId: string, body: DistributionRecordPublishRequest) {
  const { data } = await http.post<DistributionRecordRow>(`/distribution/records/${recordId}/confirm-publish`, body);
  return data;
}

export async function listPublishingAccounts() {
  const { data } = await http.get<PublishingAccountRow[]>('/distribution/accounts');
  return data;
}

export async function createPublishingAccount(body: PublishingAccountCreateRequest) {
  const { data } = await http.post<PublishingAccountRow>('/distribution/accounts', body);
  return data;
}

export async function updatePublishingAccount(accountId: string, body: Partial<PublishingAccountCreateRequest>) {
  const { data } = await http.patch<PublishingAccountRow>(`/distribution/accounts/${accountId}`, body);
  return data;
}

export async function deletePublishingAccount(accountId: string) {
  const { data } = await http.delete<{ ok: boolean }>(`/distribution/accounts/${accountId}`);
  return data;
}

export async function listPublishingTasks() {
  const { data } = await http.get<PublishingTaskRow[]>('/distribution/publishing-tasks');
  return data;
}

export async function listOwnedPublishingTasks() {
  const { data } = await http.get<OwnedPublishingTaskRow[]>('/distribution/owned-publishing-tasks');
  return data.map((item) => ({ ...item, task_source: 'owned_account' as const }));
}

export async function createOwnedPublishingTask(body: OwnedPublishingTaskCreateRequest) {
  const { data } = await http.post<OwnedPublishingTaskRow>('/distribution/owned-publishing-tasks', body);
  return { ...data, task_source: 'owned_account' as const };
}

export async function downloadOwnedPublishingTaskZhihuImportFile(taskId: string) {
  const { data, headers } = await http.get<Blob>(`/distribution/owned-publishing-tasks/${taskId}/zhihu-import-file`, {
    responseType: 'blob',
  });
  const disposition = String(headers['content-disposition'] || '');
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const fallbackName = String(headers['x-zggeo-import-filename'] || 'zhihu-article.md');
  return {
    blob: data,
    filename: encodedName ? decodeURIComponent(encodedName) : decodeURIComponent(fallbackName),
  };
}

export async function confirmOwnedPublishingTaskContent(taskId: string, body: PublishingTaskActionRequest = {}) {
  const { data } = await http.post<OwnedPublishingTaskRow>(
    `/distribution/owned-publishing-tasks/${taskId}/confirm-content`,
    body,
  );
  return { ...data, task_source: 'owned_account' as const };
}

export async function markOwnedPublishingTaskPublished(taskId: string, body: PublishingTaskActionRequest = {}) {
  const { data } = await http.post<OwnedPublishingTaskRow>(
    `/distribution/owned-publishing-tasks/${taskId}/mark-published`,
    body,
  );
  return { ...data, task_source: 'owned_account' as const };
}

export async function fillOwnedPublishingTaskLink(taskId: string, body: PublishingTaskActionRequest) {
  const { data } = await http.post<OwnedPublishingTaskRow>(
    `/distribution/owned-publishing-tasks/${taskId}/fill-link`,
    body,
  );
  return { ...data, task_source: 'owned_account' as const };
}

export async function failOwnedPublishingTask(taskId: string, body: PublishingTaskActionRequest = {}) {
  const { data } = await http.post<OwnedPublishingTaskRow>(`/distribution/owned-publishing-tasks/${taskId}/fail`, body);
  return { ...data, task_source: 'owned_account' as const };
}

export async function cancelOwnedPublishingTask(taskId: string, body: PublishingTaskActionRequest = {}) {
  const { data } = await http.post<OwnedPublishingTaskRow>(
    `/distribution/owned-publishing-tasks/${taskId}/cancel`,
    body,
  );
  return { ...data, task_source: 'owned_account' as const };
}

export async function deleteOwnedPublishingTask(taskId: string) {
  const { data } = await http.delete<{ ok: boolean }>(`/distribution/owned-publishing-tasks/${taskId}`);
  return data;
}

export async function listOwnedPublishingTaskLogs(taskId: string) {
  const { data } = await http.get<PublishingLogRow[]>(`/distribution/owned-publishing-tasks/${taskId}/logs`);
  return data;
}

export async function createPublishingTask(body: PublishingTaskCreateRequest) {
  const { data } = await http.post<PublishingTaskRow>('/distribution/publishing-tasks', body);
  return data;
}

export async function confirmPublishingTaskContent(taskId: string, body: PublishingTaskActionRequest = {}) {
  const { data } = await http.post<PublishingTaskRow>(`/distribution/publishing-tasks/${taskId}/confirm-content`, body);
  return data;
}

export async function markPublishingTaskPublished(taskId: string, body: PublishingTaskActionRequest = {}) {
  const { data } = await http.post<PublishingTaskRow>(`/distribution/publishing-tasks/${taskId}/mark-published`, body);
  return data;
}

export async function fillPublishingTaskLink(taskId: string, body: PublishingTaskActionRequest) {
  const { data } = await http.post<PublishingTaskRow>(`/distribution/publishing-tasks/${taskId}/fill-link`, body);
  return data;
}

export async function failPublishingTask(taskId: string, body: PublishingTaskActionRequest = {}) {
  const { data } = await http.post<PublishingTaskRow>(`/distribution/publishing-tasks/${taskId}/fail`, body);
  return data;
}

export async function cancelPublishingTask(taskId: string, body: PublishingTaskActionRequest = {}) {
  const { data } = await http.post<PublishingTaskRow>(`/distribution/publishing-tasks/${taskId}/cancel`, body);
  return data;
}

export async function deletePublishingTask(taskId: string) {
  const { data } = await http.delete<{ ok: boolean }>(`/distribution/publishing-tasks/${taskId}`);
  return data;
}

export async function listPublishingTaskLogs(taskId: string) {
  const { data } = await http.get<PublishingLogRow[]>(`/distribution/publishing-tasks/${taskId}/logs`);
  return data;
}

export async function getCustomerLifecycle() {
  const { data } = await http.get<Record<string, unknown>>('/customer/lifecycle');
  return data;
}

/**
 * 批量拉报告。并发 6 条，失败的就跳过（不中断整体）
 * 用于 /reports/grades、/reports/suggestions、/monitoring/compare 等聚合页
 */
export async function getReportsBatch(reportIds: string[]): Promise<ReportResponse[]> {
  const CONCURRENCY = 6;
  const result: ReportResponse[] = [];
  for (let i = 0; i < reportIds.length; i += CONCURRENCY) {
    const batch = reportIds.slice(i, i + CONCURRENCY);
    // Keep batches sequential so report aggregation limits concurrent API load.
    // eslint-disable-next-line no-await-in-loop
    const settled = await Promise.allSettled(batch.map((id) => getReport(id)));
    settled.forEach((s) => {
      if (s.status === 'fulfilled') result.push(s.value);
    });
  }
  return result;
}

// -------------------- 媒介集市（meijiejishi.com）新闻发稿 API --------------------
// 通过 codex 中转，凭据在 ai-service/.env，浏览器看不到。
// 后端路由见 ai-service/app.py @ /media-market/*

/** 媒介集市筛选字典：单个选项 */
export interface MediaMarketFilterOption {
  code: string;
  label: string;
  sort: number;
}

/** 媒介集市筛选字典：一组（如"综合门户" / "覆盖区域"） */
export interface MediaMarketFilterGroup {
  key: string; // dictValue，如 'sys_news_extend_mhlx'
  label: string; // 友好中文名
  multiple: boolean; // 是否允许多选
  options: MediaMarketFilterOption[];
  sort: number;
}

/** 媒介集市单条媒体（已展开 mediaExtendAttrList） */
export interface MediaMarketRow {
  mediaId?: number | string;
  mediaName?: string;
  mediaLink?: string;
  marketPrice?: number | string;
  chargeCredits?: number;
  quoteToken?: string;
  costAmountCents?: number | null;
  markupBps?: number;
  saleAmountCents?: number | null;
  grossProfitCents?: number | null;
  weighting?: number | string;
  mediaRemark?: string;
  manuscriptRate?: number | string;
  manuscriptRateStr?: string;
  salesVolume?: number;
  isCollect?: boolean | number;
  isRecommend?: boolean | number;
  isPreferred?: boolean | number;
  /** 所有扩展属性（dictValue -> dictLabel[]） */
  attrs: Record<string, string[]>;
  /** 常用属性捷径 */
  portal?: string;
  channel?: string;
  region?: string;
  priceRange?: string;
  indexing?: string;
  linkType?: string;
  speed?: string;
  special?: string[];
}

/** 媒介集市订单列表行（透传媒介集市原字段） */
export interface MediaMarketOrderRow {
  popId?: number | string;
  popOutTradeNo?: string;
  popTitle?: string;
  mediaName?: string;
  mediaLink?: string;
  popAuditing?: number | string; // 0 待审 / 1 发布中 / 2 已发布 / 3 拒稿
  popAuditingStr?: string;
  popPublishLink?: string;
  popCreateTime?: string;
  popPrice?: number | string;
  chargeCredits?: number;
  costAmountCents?: number | null;
  markupBps?: number;
  saleAmountCents?: number | null;
  grossProfitCents?: number | null;
  popRefundReason?: string;
  [k: string]: unknown;
}

/** 分页外壳（沿用媒介集市本身返回字段名） */
export interface MediaMarketPagination<T> {
  content: T[];
  totalElements?: number;
  totalPages?: number;
  number?: number;
  size?: number;
  first?: boolean;
  last?: boolean;
}

export interface MediaMarketHealth {
  status: 'ok' | 'error';
  user?: Record<string, unknown>;
  code?: string;
  mess?: string;
}

export interface MediaMarketSearchParams {
  page?: number;
  size?: number;
  /** 多选 dictCode，逗号分隔 */
  dictCode?: string;
  /** 媒体名称/链接模糊查询 */
  condition?: string;
  remark?: string;
  accurateInquiry?: boolean;
  /** 只看收藏 */
  collect?: boolean;
  /** 排序字段（参考媒介集市文档） */
  sort?: string;
  /** 排序方向 asc/desc */
  search?: string;
}

export interface MediaMarketOrdersParams {
  page?: number;
  size?: number;
  popTitle?: string;
  popOutTradeNo?: string;
  mediaName?: string;
  /** 0 待审 / 1 发布中 / 2 已发布 / 3 拒稿 */
  popAuditing?: string;
  /** YYYY-MM-DD HH:MM:SS */
  startTime?: string;
  endTime?: string;
}

export interface MediaMarketTitleCheckRequest {
  title: string;
  media_ids: string[];
}

export interface MediaMarketOrderCreateRequest {
  title: string;
  content: string;
  link?: string;
  remark?: string;
  media_ids: string[];
  media_quote_tokens?: string[];
  confirm: boolean;
  allow_duplicate?: boolean;
}

export interface MediaMarketOrderCreateResponse {
  ok: boolean;
  orders: MediaMarketOrderRow[];
}

export interface MediaMarketImageUploadResponse {
  ok: boolean;
  url: string;
  original?: string;
  size?: number;
  type?: string;
}

/** 健康检查：顺便报凭据是否配齐 */
export async function getMediaMarketHealth() {
  const { data } = await http.get<MediaMarketHealth>('/media-market/health');
  return data;
}

/** 9 组筛选字典（综合门户 / 频道类型 / 覆盖区域 / 价格区间 / 收录情况 / 链接类型 / 出稿速度 / 特殊项目 / 通发专区） */
export async function listMediaMarketFilters() {
  const { data } = await http.get<{ groups: MediaMarketFilterGroup[] }>('/media-market/filters');
  return data;
}

/** 媒体搜索（分页） */
export async function searchMediaMarket(params?: MediaMarketSearchParams) {
  const { data } = await http.get<MediaMarketPagination<MediaMarketRow>>('/media-market/media', {
    params: {
      page: params?.page ?? 1,
      size: params?.size ?? 30,
      dict_code: params?.dictCode ?? '',
      condition: params?.condition ?? '',
      remark: params?.remark ?? '',
      accurate_inquiry: params?.accurateInquiry ?? false,
      collect: params?.collect ?? false,
      sort: params?.sort ?? '',
      search: params?.search ?? '',
    },
  });
  return data;
}

/** 媒介集市订单列表（发稿记录） */
export async function listMediaMarketOrders(params?: MediaMarketOrdersParams) {
  const { data } = await http.get<MediaMarketPagination<MediaMarketOrderRow>>('/media-market/orders', {
    params: {
      page: params?.page ?? 1,
      size: params?.size ?? 20,
      pop_title: params?.popTitle ?? '',
      pop_out_trade_no: params?.popOutTradeNo ?? '',
      media_name: params?.mediaName ?? '',
      pop_auditing: params?.popAuditing ?? '',
      start_time: params?.startTime ?? '',
      end_time: params?.endTime ?? '',
    },
  });
  return data;
}

/** 投稿前标题查重：duplicated=true 时不允许直接创建订单 */
export async function checkMediaMarketTitle(body: MediaMarketTitleCheckRequest) {
  const { data } = await http.post<{
    ok: boolean;
    duplicated: boolean;
    duplicates: MediaMarketOrderRow[];
  }>('/media-market/title-check', body);
  return data;
}

/** 创建媒介集市投稿订单：会在第三方平台真实下单 */
export async function createMediaMarketOrder(body: MediaMarketOrderCreateRequest) {
  const { data } = await http.post<MediaMarketOrderCreateResponse>('/media-market/orders', body);
  return data;
}

/** 上传投稿正文图片，返回可放入 UEditor HTML 的图片地址 */
export async function uploadMediaMarketImage(file: File) {
  const form = new FormData();
  form.append('file', file);
  const { data } = await http.post<MediaMarketImageUploadResponse>('/media-market/upload-image', form, {
    timeout: 60000,
  });
  return data;
}

/** 媒介集市订单审核状态 → 标签色 */
export const MEDIA_MARKET_AUDIT_LABEL: Record<string, string> = {
  '0': '待审核',
  '1': '发布中',
  '2': '已发布',
  '3': '拒稿',
};

export const MEDIA_MARKET_AUDIT_THEME: Record<string, 'primary' | 'warning' | 'success' | 'danger' | 'default'> = {
  '0': 'warning',
  '1': 'primary',
  '2': 'success',
  '3': 'danger',
};

// -------------------- 前端展示辅助 --------------------

export const FOLLOWUP_STATUS_LABEL: Record<FollowupStatus, string> = {
  new: '新留资',
  contacted: '已联系',
  in_progress: '跟进中',
  closed: '已关闭',
};

export const FOLLOWUP_STATUS_THEME: Record<FollowupStatus, 'primary' | 'warning' | 'success' | 'default'> = {
  new: 'warning',
  contacted: 'primary',
  in_progress: 'primary',
  closed: 'default',
};
