import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, MessagePlugin, Select, Textarea } from 'tdesign-react';
import {
  RefreshIcon,
  RocketIcon,
  PlayCircleIcon,
  TimeFilledIcon,
  LoadingIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
} from 'tdesign-icons-react';
import { useLocation, useNavigate } from 'react-router-dom';

import AgentShell, { AgentMeta, AgentStatus } from 'components/AgentShell';
import {
  AgentWorkflowRun,
  AgentWorkflowStep,
  autoStartContentAgentRuns,
  cancelAgentWorkflow,
  configureAgentWorkflowSchedule,
  ContentAgentRun,
  exportAgentWorkflowReport,
  inspectAgentWorkflow,
  inspectDueAgentWorkflows,
  listContentAgentRuns,
  AgentWorkflowReports,
  getAgentWorkflowReports,
  formatApiError,
  GenerationLanguage,
  KeywordPromptItem,
  listAgentWorkflows,
  listKeywordPrompts,
  listModelProviders,
  ModelProviderRow,
  retryAgentWorkflow,
  startAgentWorkflow,
} from 'services/zggeo-api';
import {
  buildProjectSourceOptions,
  defaultDescriptionFor,
  defaultKeywordsFor,
  defaultUrlsFor,
  getActiveProjectContext,
  loadProjectSources,
  normalizeDomain,
  parseList,
  ProjectContext,
  saveActiveProjectContext,
} from 'utils/projectContext';
import Style from './index.module.less';

const META: AgentMeta = {
  key: 'autopilot',
  name: '星链',
  title: '自动运作中心',
  emoji: '⚙️',
  tagline: '让客户交付链和内容自动化链在一个现场里持续推进',
  description:
    '星链不只是启动任务，它负责把客户资料、监测诊断、GEO 资产、内容生成、报告输出与复测节奏串成一条持续运行的自动执行链。',
  color: '#5E6AD2',
  gradient: ['#12131A', '#101116'],
  apis: ['POST /agent/workflows', 'GET /agent/workflows', 'POST /tasks', 'POST /geo/deployment-package'],
};

const STATUS_CFG: Record<string, { label: string; tone: 'success' | 'primary' | 'warning' | 'danger' | 'default' }> = {
  completed: { label: '已完成', tone: 'success' },
  running: { label: '运行中', tone: 'primary' },
  pending: { label: '排队中', tone: 'warning' },
  partial: { label: '部分完成', tone: 'warning' },
  needs_input: { label: '待补资料', tone: 'danger' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已终止', tone: 'default' },
  skipped: { label: '已跳过', tone: 'default' },
};

const CONTENT_STAGE_LABELS: Record<string, string> = {
  queued: '已入队',
  routing: '星枢路由',
  question_mining: '高频问题采集',
  prompt_ready: 'Prompt已沉淀',
  generating_article: '生成文章',
  generating: '星核创生',
  optimizing: 'GEO优化',
  scoring: '星核评分',
  calibrating: '星穹校准',
  ready_to_publish: '待发布',
  published: '已发布',
  failed: '失败',
};

const EXECUTION_PHASES = [
  { title: 'AI可见度诊断', note: '扫描官网、答案位与品牌提及结构' },
  { title: '策略生成', note: '生成优先级、诊断摘要与路径建议' },
  { title: '问题采集', note: '沉淀关键词相关高频问题到 Prompt' },
  { title: '文章生成', note: '手动选择公司信息、Prompt、图片和 AI' },
  { title: '回测优化', note: '报告、巡检与下一轮迭代' },
];

const CONTENT_STAGE_PROGRESS: Record<string, number> = {
  queued: 52,
  routing: 58,
  generating: 68,
  optimizing: 78,
  scoring: 86,
  calibrating: 92,
  ready_to_publish: 96,
  published: 100,
  failed: 64,
};

type PromptKeywordSource = 'non_brand' | 'brand' | 'all';
type ArticleGenerationMode = 'basic' | 'official_rewrite' | 'viral_rewrite';
type ArticlePromptStrategy = 'auto_next' | 'manual';
type ArticleImageStrategy = 'auto' | 'manual';

const ARTICLE_MODE_OPTIONS = [
  { label: '基础生成', value: 'basic' },
  { label: '官网改写', value: 'official_rewrite' },
  { label: '爆款改写（预留）', value: 'viral_rewrite' },
];

const BASIC_STYLE_OPTIONS = [
  { label: '原始生成', value: 'original' },
  { label: 'SEO 文章', value: 'seo_article' },
  { label: '客户问答型', value: 'customer_qa' },
];

const OFFICIAL_REWRITE_STYLE_OPTIONS = [
  { label: '知乎 · 问题回答、判断标准、轻量提及品牌', value: 'zhihu_answer' },
  { label: '公众号 · 长图文、可信背书、行动引导', value: 'wechat_article' },
  { label: '小红书 · 笔记、短句分段、场景种草', value: 'xiaohongshu_note' },
];

const VIRAL_STYLE_OPTIONS = [
  { label: '小红书爆款（预留）', value: 'xiaohongshu_viral' },
  { label: '公众号爆款（预留）', value: 'wechat_viral' },
  { label: '知乎高赞回答（预留）', value: 'zhihu_hot_answer' },
];

interface WorkflowFormState {
  lead_id?: string;
  project_name: string;
  domain: string;
  description: string;
  keywords: string;
  urls: string;
  competitors: string;
  notes: string;
  keyword_count: number;
  prompt_count: number;
  content_task_limit: number;
  max_pages: number;
  language: GenerationLanguage;
  providers: string;
  skip_steps: string;
  summary_provider: string;
  content_provider: string;
  content_channel: string;
  content_priority: string;
  content_allow_fallback: boolean;
  question_count: number;
  prompt_keyword_source: PromptKeywordSource;
  prompt_ids: string[];
  article_generation_mode: ArticleGenerationMode;
  article_style_key: string;
  article_prompt_strategy: ArticlePromptStrategy;
  article_image_strategy: ArticleImageStrategy;
  article_source_url: string;
  article_platform_style: string;
  article_search_intent: string;
}

const emptyForm: WorkflowFormState = {
  project_name: '',
  domain: '',
  description: '',
  keywords: '',
  urls: '',
  competitors: '',
  notes: '',
  keyword_count: 10,
  prompt_count: 10,
  content_task_limit: 3,
  max_pages: 12,
  language: 'zh',
  providers: '',
  skip_steps: '',
  summary_provider: '',
  content_provider: 'deepseek',
  content_channel: '官网文章',
  content_priority: '中',
  content_allow_fallback: false,
  question_count: 6,
  prompt_keyword_source: 'non_brand',
  prompt_ids: [],
  article_generation_mode: 'basic',
  article_style_key: 'original',
  article_prompt_strategy: 'auto_next',
  article_image_strategy: 'auto',
  article_source_url: '',
  article_platform_style: 'zhihu_answer',
  article_search_intent: '',
};

const cn = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

const useAnimatedNumber = (target: number, duration = 900) => {
  const [display, setDisplay] = useState(target);
  const previousRef = useRef(target);

  useEffect(() => {
    const from = previousRef.current;
    const to = target;
    previousRef.current = target;

    if (from === to) {
      setDisplay(to);
      return undefined;
    }

    let raf = 0;
    const startedAt = performance.now();

    const frame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(Math.round(from + (to - from) * eased));
      if (progress < 1) raf = window.requestAnimationFrame(frame);
    };

    raf = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(raf);
  }, [duration, target]);

  return display;
};

const toneClass = (tone: 'success' | 'primary' | 'warning' | 'danger' | 'default') => {
  return {
    success: Style.toneSuccess,
    primary: Style.tonePrimary,
    warning: Style.toneWarning,
    danger: Style.toneDanger,
    default: Style.toneDefault,
  }[tone];
};

const statusTag = (status: string) => {
  const cfg = STATUS_CFG[status] || STATUS_CFG.pending;
  const liveStatuses = ['running', 'pending', 'partial'];
  return (
    <span
      className={`${Style.statusPill} ${toneClass(cfg.tone)} ${
        liveStatuses.includes(status) ? Style.statusPillLive : ''
      }`}
    >
      <span className={Style.statusDot} />
      {cfg.label}
    </span>
  );
};

const formatTime = (value?: string | null) => {
  if (!value) return '未设置';
  return new Date(value).toLocaleString('zh-CN');
};

const openPrintableHtml = (html: string) => {
  const win = window.open('', '_blank');
  if (!win) {
    MessagePlugin.warning('浏览器拦截了新窗口，请允许弹窗后重试');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
};

const sourceToWorkflowForm = (source: ProjectContext): WorkflowFormState => {
  const domain = normalizeDomain(source.domain);
  const projectName = source.project_name || domain;
  const keywords = source.keywords.length > 0 ? source.keywords : defaultKeywordsFor(projectName);
  const urls = source.urls.length > 0 ? source.urls : defaultUrlsFor(domain);
  const leadId = source.id.startsWith('lead:') ? source.id.replace('lead:', '') : undefined;

  return {
    lead_id: leadId,
    project_name: projectName,
    domain,
    description: source.description || defaultDescriptionFor(projectName, source.notes),
    keywords: keywords.join('\n'),
    urls: urls.join('\n'),
    competitors: source.competitors.join('\n'),
    notes: source.notes || '',
    keyword_count: 10,
    prompt_count: 10,
    content_task_limit: 3,
    max_pages: 12,
    language: 'zh',
    providers: '',
    skip_steps: '',
    summary_provider: '',
    content_provider: 'deepseek',
    content_channel: '官网文章',
    content_priority: '中',
    content_allow_fallback: false,
    question_count: 6,
    prompt_keyword_source: 'non_brand',
    prompt_ids: [],
    article_generation_mode: 'basic',
    article_style_key: 'original',
    article_prompt_strategy: 'auto_next',
    article_image_strategy: 'auto',
    article_source_url: '',
    article_platform_style: 'zhihu_answer',
    article_search_intent: '',
  };
};

const findSourceBySelectValue = (sources: ProjectContext[], value: unknown, context?: any) => {
  const optionValue = context?.selectedOptions?.[0]?.value ?? context?.selectedOption?.value;
  const raw = optionValue ?? (typeof value === 'object' && value !== null ? (value as any).value : value);
  const sourceId = String(raw || '');
  if (!sourceId) return null;

  const exact = sources.find((item) => item.id === sourceId);
  if (exact) return exact;

  return (
    sources.find((item) => sourceId.includes(item.project_name) || (!!item.domain && sourceId.includes(item.domain))) ||
    null
  );
};

const workflowProgress = (run?: AgentWorkflowRun | null) => {
  if (!run) return 0;

  const terminal = { completed: 100, partial: 100 };
  if (run.status in terminal) return terminal[run.status as keyof typeof terminal];

  if (!run.steps || run.steps.length === 0) {
    if (run.status === 'needs_input') return 0;
    if (run.status === 'pending') return 0;
    if (run.status === 'running') return 5;
    return 0;
  }

  const total = run.steps.length;
  const completed = run.steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length;
  return Math.min(99, Math.round((completed / total) * 100));
};

const STEP_KEY_PHASE: Record<string, number> = {
  intake: 0,
  diagnosis: 0,
  assets: 1,
  report: 1,
  model_compare: 2,
  question_summary: 2,
  prompt_inventory: 2,
  content_task: 3,
  visibility: 4,
  recheck: 4,
};

const derivePhaseIndex = (run?: AgentWorkflowRun | null, contentRun?: ContentAgentRun | null) => {
  const isWorkflowActive = run && ['running', 'pending'].includes(run.status);

  // 工作流活跃时，以工作流步骤为准，忽略内容自动化状态
  if (isWorkflowActive && run.steps && run.steps.length > 0) {
    const runningStep = run.steps.find((s) => s.status === 'running');
    if (runningStep && runningStep.step_key) {
      return STEP_KEY_PHASE[runningStep.step_key] ?? 0;
    }
    const lastDone = [...run.steps].reverse().find((s) => ['completed', 'skipped'].includes(s.status));
    if (lastDone && lastDone.step_key) {
      return STEP_KEY_PHASE[lastDone.step_key] ?? 0;
    }
    return 0;
  }

  if (run && run.status === 'completed') return 4;
  if (run && run.status === 'cancelled') return -1; // 终止后不走流程展示
  if (run && run.status === 'failed') return -1;

  // 工作流不活跃时，以内容自动化状态为准
  if (contentRun) {
    const contentPhaseMap: Record<string, number> = {
      queued: 2,
      routing: 2,
      generating: 2,
      generating_article: 3,
      optimizing: 3,
      scoring: 3,
      calibrating: 4,
      ready_to_publish: 4,
      published: 4,
      failed: 3,
    };
    return contentPhaseMap[contentRun.stage] ?? 2;
  }

  // 有工作流但非活跃（如 needs_input、partial），从步骤推算
  if (run && run.steps && run.steps.length > 0) {
    const lastDone = [...run.steps].reverse().find((s) => ['completed', 'skipped'].includes(s.status));
    if (lastDone && lastDone.step_key) {
      return STEP_KEY_PHASE[lastDone.step_key] ?? 0;
    }
    return 0;
  }

  if (run && run.status === 'running') return 1;
  if (run && run.status === 'needs_input') return 0;
  return 0;
};

const StepList: React.FC<{ steps?: AgentWorkflowStep[] }> = ({ steps }) => {
  if (!steps || steps.length === 0) {
    return <div className={Style.emptyMini}>等待工作流步骤初始化</div>;
  }

  return (
    <div className={Style.stepList}>
      {steps.map((step) => (
        <div key={step.id} className={Style.stepRow}>
          <div>
            <div className={Style.stepTitle}>{step.title}</div>
            <div className={Style.stepAgent}>{step.agent_key}</div>
          </div>
          <div>{statusTag(step.status)}</div>
          <div className={Style.stepDetail}>{step.detail || '等待执行'}</div>
        </div>
      ))}
    </div>
  );
};

const Autopilot: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [sources, setSources] = useState<ProjectContext[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [form, setForm] = useState<WorkflowFormState>(emptyForm);
  const [runs, setRuns] = useState<AgentWorkflowRun[]>([]);
  const [contentRuns, setContentRuns] = useState<ContentAgentRun[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [motionTick, setMotionTick] = useState(0);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [recordsExpanded, setRecordsExpanded] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [reportsCache, setReportsCache] = useState<Record<string, AgentWorkflowReports['reports']>>({});
  const [reportsLoading, setReportsLoading] = useState(false);
  const [availableProviders, setAvailableProviders] = useState<ModelProviderRow[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<string[]>(['deepseek', 'doubao', 'hunyuan']);
  const [contentProvider, setContentProvider] = useState('deepseek');
  const [inventoryPrompts, setInventoryPrompts] = useState<KeywordPromptItem[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [selectedPromptIds, setSelectedPromptIds] = useState<Set<string>>(new Set());

  const fetchPrompts = async (force = false) => {
    if (promptsLoading || (!force && inventoryPrompts.length > 0)) return;
    setPromptsLoading(true);
    try {
      const brand =
        form.project_name ||
        (() => {
          const s = sources.find((s) => s.id === selectedSourceId);
          return s?.project_name || '';
        })();
      const leadId = form.lead_id;
      const { items } = await listKeywordPrompts({
        lead_id: leadId || undefined,
        brand_name: brand || undefined,
        limit: 50,
      });
      setInventoryPrompts(items);
      if (selectedPromptIds.size === 0 && items.length > 0) {
        setSelectedPromptIds(new Set(items.slice(0, 3).map((it) => it.id)));
        setForm((prev) => ({ ...prev, prompt_ids: items.slice(0, 3).map((it) => it.id) }));
      }
    } catch {
      /* ignore */
    }
    setPromptsLoading(false);
  };

  const isPreviewRoute = location.pathname.startsWith('/preview/');

  // 切换资料时自动拉取 Prompt 库存
  useEffect(() => {
    if (selectedSourceId && form.project_name) {
      setInventoryPrompts([]);
      setSelectedPromptIds(new Set());
      const timer = setTimeout(() => fetchPrompts(true), 200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [selectedSourceId]);

  const sourceOptions = useMemo(() => buildProjectSourceOptions(sources), [sources]);

  const stats = useMemo(() => {
    const active = runs.filter((run) => ['pending', 'running'].includes(run.status)).length;
    const contentActive = contentRuns.filter((run) => ['pending', 'running'].includes(run.status)).length;
    const completed = runs.filter((run) => run.status === 'completed').length;
    const contentCompleted = contentRuns.filter((run) => run.status === 'completed').length;
    const needsInput = runs.filter((run) =>
      ['needs_input', 'partial', 'failed', 'cancelled'].includes(run.status),
    ).length;
    const contentFailed = contentRuns.filter((run) => run.status === 'failed').length;
    const total = runs.length + contentRuns.length;
    const health =
      total === 0
        ? 92
        : Math.max(35, Math.round(((completed + contentCompleted + (active + contentActive) * 0.5) / total) * 100));
    let status: AgentStatus = 'idle';
    if (active + contentActive > 0) status = 'running';
    else if (needsInput + contentFailed > 0) status = 'beta';
    return { active, completed, needsInput, total, health, status, contentActive, contentCompleted, contentFailed };
  }, [contentRuns, runs]);

  const fetchRuns = async () => {
    setRunLoading(true);
    try {
      const workflowRuns = await listAgentWorkflows({ limit: 12 });
      setRuns(workflowRuns);
      try {
        const contentData = await listContentAgentRuns({ limit: 12 });
        setContentRuns(contentData);
      } catch (contentErr: any) {
        setContentRuns([]);
        MessagePlugin.warning(`内容 Agent 记录读取失败：${formatApiError(contentErr)}`);
      }
    } catch (err: any) {
      MessagePlugin.warning(`自动运作记录读取失败：${formatApiError(err)}`);
    } finally {
      setRunLoading(false);
    }
  };

  const applySource = (source: ProjectContext, silent = false) => {
    const nextForm = sourceToWorkflowForm(source);
    setSelectedSourceId(source.id);
    setForm(nextForm);
    saveActiveProjectContext({
      ...source,
      domain: nextForm.domain,
      description: nextForm.description,
      keywords: parseList(nextForm.keywords),
      competitors: parseList(nextForm.competitors),
      urls: parseList(nextForm.urls),
      notes: nextForm.notes,
    });

    if (!silent) {
      if (!nextForm.domain) {
        MessagePlugin.warning('这条资料还缺官网域名，已先带入其他信息，请到客户资产补官网后再启动');
      } else {
        MessagePlugin.success('已带入项目、官网、关键词、URL、竞品和客户需求');
      }
    }
  };

  const loadSources = async () => {
    setSourceLoading(true);
    try {
      let nextSources = await loadProjectSources();
      const activeSource = getActiveProjectContext();
      if (activeSource) {
        nextSources = [activeSource, ...nextSources.filter((item) => item.id !== activeSource.id)];
      }
      setSources(nextSources);
      const preferred =
        activeSource || nextSources.find((source) => source.domain && source.project_name) || nextSources[0];
      if (preferred) applySource(preferred, true);
    } catch (err: any) {
      MessagePlugin.warning(`项目资料读取失败：${formatApiError(err)}`);
    } finally {
      setSourceLoading(false);
    }
  };

  useEffect(() => {
    loadSources();
    fetchRuns();
    listModelProviders()
      .then((data) => setAvailableProviders(data.providers || []))
      .catch(() => {}); // 静默失败，不影响主流程
    const timer = window.setInterval(fetchRuns, 12_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stats.status !== 'running' && !isPreviewRoute) return undefined;
    const timer = window.setInterval(() => setMotionTick((prev) => prev + 1), 1400);
    return () => window.clearInterval(timer);
  }, [isPreviewRoute, stats.status]);

  const handleSourceChange = (value: unknown, context?: any) => {
    const source = findSourceBySelectValue(sources, value, context);
    if (!source) {
      setSelectedSourceId(String(value || ''));
      MessagePlugin.warning('没有找到这条资料，请点“刷新资料”后再试');
      return;
    }
    applySource(source);
  };

  const startWorkflow = async () => {
    const projectName = form.project_name.trim();
    const domain = normalizeDomain(form.domain);

    if (!projectName) {
      MessagePlugin.warning('请先选择资料或填写项目/品牌名');
      return;
    }
    if (!domain) {
      MessagePlugin.warning('请先在客户资产里补官网域名，自动诊断必须有域名');
      return;
    }

    setStarting(true);
    try {
      const payload = {
        lead_id: form.lead_id,
        project_name: projectName,
        domain,
        description: form.description.trim(),
        keywords: parseList(form.keywords),
        urls: parseList(form.urls).length > 0 ? parseList(form.urls) : defaultUrlsFor(domain),
        competitors: parseList(form.competitors),
        notes: form.notes.trim(),
        mode: 'full_auto',
        keyword_count: form.keyword_count,
        prompt_count: form.prompt_count,
        content_task_limit: form.content_task_limit,
        max_pages: form.max_pages,
        language: form.language,
        providers: selectedProviders,
        skip_steps: parseList(form.skip_steps),
        summary_provider: form.summary_provider || undefined,
        content_provider: form.content_provider || undefined,
        content_channel: form.content_channel || '官网文章',
        content_priority: form.content_priority || '中',
        content_allow_fallback: form.content_allow_fallback,
        question_count: form.question_count,
        prompt_keyword_source: form.prompt_keyword_source,
        prompt_ids: form.prompt_ids.length > 0 ? form.prompt_ids : undefined,
        article_generation_mode: form.article_generation_mode,
        article_style_key: form.article_style_key,
        article_prompt_strategy: form.article_prompt_strategy,
        article_image_strategy: form.article_image_strategy,
        article_source_url: form.article_source_url.trim() || undefined,
        article_platform_style: form.article_platform_style || undefined,
        article_search_intent: form.article_search_intent.trim() || undefined,
      };
      saveActiveProjectContext({
        id: form.lead_id ? `lead:${form.lead_id}` : 'agent-autopilot:latest',
        origin: '最近使用',
        project_name: payload.project_name,
        domain: payload.domain,
        description: payload.description,
        keywords: payload.keywords,
        competitors: payload.competitors,
        urls: payload.urls,
        notes: payload.notes,
      });
      await startAgentWorkflow(payload);
      MessagePlugin.success('已启动 Agent 自动运作，系统会持续刷新每一步状态');
      await fetchRuns();
    } catch (err: any) {
      MessagePlugin.error(`启动失败：${formatApiError(err)}`);
    } finally {
      setStarting(false);
    }
  };

  const runAction = async (key: string, action: () => Promise<void>) => {
    setActionLoading(key);
    try {
      await action();
      await fetchRuns();
    } catch (err: any) {
      MessagePlugin.error(formatApiError(err) || '操作失败，请稍后重试');
    } finally {
      setActionLoading('');
    }
  };

  const handleInspectDue = async () => {
    await runAction('inspect-due', async () => {
      const data = await inspectDueAgentWorkflows({ limit: 10 });
      MessagePlugin.success(`已把 ${Number(data.queued || 0)} 条到期巡检加入队列`);
    });
  };

  const handleAutoStartContent = async () => {
    await runAction('content-auto-start', async () => {
      const data = await autoStartContentAgentRuns({ limit: 10, provider: contentProvider || undefined });
      MessagePlugin.success(`已把 ${Number(data.queued || 0)} 条写作任务加入采集与文章生成队列`);
    });
  };

  const handleInspect = async (run: AgentWorkflowRun) => {
    await runAction(`inspect:${run.id}`, async () => {
      await inspectAgentWorkflow(run.id);
      MessagePlugin.success('巡检已加入队列，稍后自动刷新结果');
    });
  };

  const handleRetry = async (run: AgentWorkflowRun) => {
    await runAction(`retry:${run.id}`, async () => {
      await retryAgentWorkflow(run.id, { force: false });
      MessagePlugin.success('失败重试已加入队列');
    });
  };

  const handleCancel = async (run: AgentWorkflowRun) => {
    await runAction(`cancel:${run.id}`, async () => {
      await cancelAgentWorkflow(run.id);
      MessagePlugin.success('已终止该工作流');
    });
  };

  const handleSchedule = async (run: AgentWorkflowRun) => {
    const enabled = !(run.schedule_enabled ?? true);
    await runAction(`schedule:${run.id}`, async () => {
      await configureAgentWorkflowSchedule(run.id, { frequency: run.schedule_frequency || 'weekly', enabled });
      MessagePlugin.success(enabled ? '已开启每周定时巡检' : '已暂停定时巡检');
    });
  };

  const handleExport = async (run: AgentWorkflowRun) => {
    await runAction(`export:${run.id}`, async () => {
      const data = await exportAgentWorkflowReport(run.id);
      openPrintableHtml(String(data.html || ''));
      MessagePlugin.success('客户报告已打开，可打印或另存为 PDF');
    });
  };

  const copyCallbackUrl = async (run: AgentWorkflowRun) => {
    const url = `${window.location.origin}/api/zggeo/agent/workflows/${run.id}/n8n-callback`;
    await navigator.clipboard.writeText(url);
    MessagePlugin.success('n8n 回调地址已复制');
  };

  const latestRuns = useMemo(() => runs, [runs]);
  const keywordsList = useMemo(() => parseList(form.keywords), [form.keywords]);
  const urlsList = useMemo(() => parseList(form.urls), [form.urls]);
  const competitorsList = useMemo(() => parseList(form.competitors), [form.competitors]);

  const currentWorkflow = useMemo(
    () =>
      runs.find((run) =>
        ['running', 'pending', 'partial', 'needs_input', 'failed', 'cancelled'].includes(run.status),
      ) ||
      runs[0] ||
      null,
    [runs],
  );

  const currentContentRun = useMemo(
    () =>
      contentRuns.find((run) =>
        ['queued', 'routing', 'generating', 'optimizing', 'scoring', 'calibrating', 'ready_to_publish'].includes(
          run.stage,
        ),
      ) ||
      contentRuns[0] ||
      null,
    [contentRuns],
  );

  const executionProgress = useMemo(() => {
    return workflowProgress(currentWorkflow);
  }, [currentWorkflow]);

  const liveProgressTarget = useMemo(() => {
    if (isPreviewRoute && executionProgress === 0) {
      const previewCycle = [42, 46, 51, 57, 62, 68, 74, 79, 84, 88, 82, 76];
      return previewCycle[motionTick % previewCycle.length];
    }
    return executionProgress;
  }, [executionProgress, isPreviewRoute, motionTick]);

  const displayProgress = useAnimatedNumber(liveProgressTarget, 920);
  const displayActive = useAnimatedNumber(stats.active + stats.contentActive, 720);
  const displayContentActive = useAnimatedNumber(stats.contentActive, 760);
  const displayCompleted = useAnimatedNumber(stats.completed + stats.contentCompleted, 820);
  const displayPending = useAnimatedNumber(stats.needsInput + stats.contentFailed, 900);

  const currentPhaseIndex = useMemo(
    () => derivePhaseIndex(currentWorkflow, currentContentRun),
    [currentContentRun, currentWorkflow],
  );
  const currentPhase = EXECUTION_PHASES[currentPhaseIndex] || EXECUTION_PHASES[0];
  const currentTarget =
    currentWorkflow?.domain ||
    normalizeDomain(form.domain) ||
    currentWorkflow?.project_name ||
    form.project_name ||
    '请选择资料';

  const heroMetrics = [
    { label: '运行中链路', value: displayActive, note: '自动交付 + 内容自动化', tone: 'primary' as const },
    { label: '已完成链路', value: displayCompleted, note: '本轮已完成的执行链', tone: 'success' as const },
    { label: '待处理项', value: displayPending, note: '缺资料 / 失败 / 人工确认', tone: 'warning' as const },
  ];

  const readinessItems = [
    { label: '项目/品牌', value: form.project_name || '未填写', ready: Boolean(form.project_name.trim()) },
    {
      label: '官网域名',
      value: normalizeDomain(form.domain) || '未填写',
      ready: Boolean(normalizeDomain(form.domain)),
    },
    {
      label: '关键词',
      value: keywordsList.length > 0 ? `${keywordsList.length} 个` : '未填写',
      ready: keywordsList.length > 0,
    },
    { label: '核心页面', value: urlsList.length > 0 ? `${urlsList.length} 个` : '未填写', ready: urlsList.length > 0 },
    {
      label: '竞品',
      value: competitorsList.length > 0 ? `${competitorsList.length} 个` : '未填写',
      ready: competitorsList.length > 0,
    },
    {
      label: '客户上下文',
      value: form.notes.trim() || form.description.trim() || '未填写',
      ready: Boolean(form.notes.trim() || form.description.trim()),
    },
  ];

  const executionLogs = useMemo(() => {
    const lines = [
      `当前目标：${currentTarget}`,
      currentWorkflow
        ? `客户自动交付链路已接管，状态为「${STATUS_CFG[currentWorkflow.status]?.label || currentWorkflow.status}」`
        : '客户自动交付链路尚未启动，等待你从客户资产或品牌资料带入一份上下文。',
      currentWorkflow?.summary || '系统会先完成诊断、资产与报告，再进入巡检与复测节奏。',
      currentContentRun
        ? `内容自动化当前推进到「${
            CONTENT_STAGE_LABELS[currentContentRun.stage] || currentContentRun.stage
          }」，目标为 ${currentContentRun.channel} / ${currentContentRun.target}`
        : '内容自动化当前无运行中的任务，如需推进可一键扫描写作任务池。',
      currentWorkflow?.next_run_at
        ? `下一次定时巡检：${formatTime(currentWorkflow.next_run_at)}`
        : '尚未形成下一次巡检时间，可在运行记录里直接开启定时。',
      stats.needsInput > 0 || stats.contentFailed > 0
        ? `当前仍有 ${stats.needsInput + stats.contentFailed} 条待处理项，需要补资料、重试或人工确认。`
        : '当前链路健康，系统可以继续自动推进。',
    ];
    return lines.filter(Boolean);
  }, [currentContentRun, currentTarget, currentWorkflow, stats.contentFailed, stats.needsInput]);
  const activeLogIndex = executionLogs.length > 0 ? motionTick % executionLogs.length : 0;

  const currentTasks = useMemo(() => {
    const workflowTasks =
      currentWorkflow?.steps?.slice(0, 5).map((step) => ({
        key: step.id,
        title: step.title,
        detail: step.detail || step.agent_key,
        status: step.status,
      })) || [];

    const contentTasks = contentRuns.slice(0, 4).map((run) => ({
      key: `content:${run.id}`,
      title: run.title,
      detail: `${run.channel} · ${CONTENT_STAGE_LABELS[run.stage] || run.stage}`,
      status: run.status === 'completed' ? 'completed' : run.status === 'failed' ? 'failed' : 'running',
    }));

    return [...workflowTasks, ...contentTasks].slice(0, 7);
  }, [contentRuns, currentWorkflow]);

  const articleStyleOptions = useMemo(() => {
    if (form.article_generation_mode === 'official_rewrite') return OFFICIAL_REWRITE_STYLE_OPTIONS;
    if (form.article_generation_mode === 'viral_rewrite') return VIRAL_STYLE_OPTIONS;
    return BASIC_STYLE_OPTIONS;
  }, [form.article_generation_mode]);

  return (
    <AgentShell
      meta={META}
      status={stats.status}
      health={stats.health}
      variant='linear'
      metrics={[
        { label: '运行中', value: displayActive, hint: '客户自动交付链路' },
        { label: '内容采集', value: displayContentActive, hint: '采集高频问题' },
        { label: '已完成', value: displayCompleted, hint: '交付链与内容链累计完成' },
        { label: '待处理', value: displayPending, hint: '补资料、重试、人工确认' },
      ]}
    >
      <div className={Style.page}>
        <div className={Style.dashboardGrid}>
          <div className={Style.mainColumn}>
            <section className={cn(Style.panel, Style.heroPanel)}>
              <div className={Style.heroGrid}>
                <div className={Style.heroCopy}>
                  <div className={Style.heroBadge}>Live System Execution</div>
                  <h1 className={Style.heroTitle}>系统正在自动执行你的增长任务</h1>
                  <p className={Style.heroDesc}>
                    目标：{currentTarget}
                    。这不是一个“手动点按钮”的任务页，而是客户自动交付链和内容自动化链正在一起推进的执行现场。
                  </p>

                  <div className={Style.metricGrid}>
                    {heroMetrics.map((metric, index) => (
                      <div
                        key={metric.label}
                        className={cn(
                          Style.metricCard,
                          metric.tone === 'primary' && Style.metricCardPrimary,
                          metric.tone === 'success' && Style.metricCardSuccess,
                          metric.tone === 'warning' && Style.metricCardWarning,
                        )}
                        style={{ ['--stagger' as any]: `${index * 110}ms` }}
                      >
                        <div className={Style.metricSweep} />
                        <div className={Style.metricValue}>{metric.value}</div>
                        <div className={Style.metricLabel}>{metric.label}</div>
                        <div className={Style.metricNote}>{metric.note}</div>
                      </div>
                    ))}
                  </div>

                  <div className={Style.opsConfigPanel}>
                    <div className={Style.configGroup}>
                      <div className={Style.configGroupHeader}>
                        <span className={Style.configStep}>01</span>
                        <div>
                          <div className={Style.configTitle}>执行数量</div>
                          <div className={Style.configHint}>控制自动运作生成多少关键词、Prompt、文章和抓取页面。</div>
                        </div>
                      </div>
                      <div className={Style.compactControlGrid}>
                        <label className={Style.compactField}>
                          <span>关键词</span>
                          <Input
                            value={String(form.keyword_count)}
                            type='number'
                            size='small'
                            className={Style.darkControl}
                            onChange={(value) => {
                              const n = Math.max(3, Math.min(50, parseInt(String(value), 10) || 10));
                              setForm((prev) => ({ ...prev, keyword_count: n }));
                            }}
                          />
                        </label>
                        <label className={Style.compactField}>
                          <span>Prompt</span>
                          <Input
                            value={String(form.prompt_count)}
                            type='number'
                            size='small'
                            className={Style.darkControl}
                            onChange={(value) => {
                              const n = Math.max(3, Math.min(50, parseInt(String(value), 10) || 10));
                              setForm((prev) => ({ ...prev, prompt_count: n }));
                            }}
                          />
                        </label>
                        <label className={Style.compactField}>
                          <span>文章</span>
                          <Input
                            value={String(form.content_task_limit)}
                            type='number'
                            size='small'
                            className={Style.darkControl}
                            onChange={(value) => {
                              const n = Math.max(0, Math.min(20, parseInt(String(value), 10) || 0));
                              setForm((prev) => ({ ...prev, content_task_limit: n }));
                            }}
                          />
                        </label>
                        <label className={Style.compactField}>
                          <span>页面</span>
                          <Input
                            value={String(form.max_pages)}
                            type='number'
                            size='small'
                            className={Style.darkControl}
                            onChange={(value) => {
                              const n = Math.max(1, Math.min(30, parseInt(String(value), 10) || 12));
                              setForm((prev) => ({ ...prev, max_pages: n }));
                            }}
                          />
                        </label>
                        <label className={Style.compactField}>
                          <span>语言</span>
                          <Select
                            value={form.language}
                            size='small'
                            className={Style.darkControl}
                            options={[
                              { label: '中文', value: 'zh' },
                              { label: 'English', value: 'en' },
                              { label: '粤语', value: 'yue' },
                            ]}
                            onChange={(value) =>
                              setForm((prev) => ({ ...prev, language: (value || 'zh') as GenerationLanguage }))
                            }
                          />
                        </label>
                        <label className={Style.compactField}>
                          <span>Prompt词源</span>
                          <Select
                            value={form.prompt_keyword_source}
                            size='small'
                            className={Style.darkControl}
                            options={[
                              { label: '非品牌关键词（默认）', value: 'non_brand' },
                              { label: '品牌关键词', value: 'brand' },
                              { label: '全部关键词', value: 'all' },
                            ]}
                            onChange={(value) =>
                              setForm((prev) => ({
                                ...prev,
                                prompt_keyword_source: (value || 'non_brand') as PromptKeywordSource,
                              }))
                            }
                          />
                        </label>
                      </div>
                      <div className={Style.configHint}>
                        默认使用非品牌关键词沉淀
                        Prompt；品牌关键词不会默认填充，只有手动选择“品牌关键词”或“全部关键词”时才参与。
                      </div>
                    </div>

                    <div className={Style.configGroup}>
                      <div className={Style.configGroupHeader}>
                        <span className={Style.configStep}>02</span>
                        <div>
                          <div className={Style.configTitle}>模型对比与总结</div>
                          <div className={Style.configHint}>这些模型用于 AI 可见度对比；总结模型只负责问题库总结。</div>
                        </div>
                      </div>
                      <div className={Style.providerGrid}>
                        {availableProviders
                          .filter((p) => p.configured)
                          .map((p) => (
                            <Checkbox
                              key={p.key}
                              checked={selectedProviders.includes(p.key)}
                              onChange={(checked) =>
                                setSelectedProviders((prev) =>
                                  checked ? [...prev, p.key] : prev.filter((k) => k !== p.key),
                                )
                              }
                            >
                              <span className={Style.checkboxText}>{p.name.split('·')[0].trim()}</span>
                            </Checkbox>
                          ))}
                      </div>
                      <div className={Style.configInlineRow}>
                        <label className={Style.selectField}>
                          <span>总结模型</span>
                          <Select
                            value={form.summary_provider || '__auto__'}
                            size='small'
                            className={Style.darkControl}
                            options={[
                              { label: '自动（首选模型）', value: '__auto__' },
                              ...availableProviders
                                .filter((p) => p.configured)
                                .map((p) => ({ label: p.name.split('·')[0].trim(), value: p.key })),
                            ]}
                            onChange={(value) =>
                              setForm((prev) => ({
                                ...prev,
                                summary_provider: String(value) === '__auto__' ? '' : String(value),
                              }))
                            }
                          />
                        </label>
                        {selectedProviders.length === 0 ? (
                          <span className={Style.configWarning}>未选模型，模型对比等步骤将跳过</span>
                        ) : null}
                      </div>
                    </div>

                    <div className={Style.configGroup}>
                      <div className={Style.configGroupHeader}>
                        <span className={Style.configStep}>03</span>
                        <div>
                          <div className={Style.configTitle}>文章生成参数</div>
                          <div className={Style.configHint}>这些参数只影响内容 Agent 写文章，不影响模型对比。</div>
                        </div>
                      </div>
                      <div className={Style.configInlineRow}>
                        <label className={Style.selectField}>
                          <span>生成模式</span>
                          <Select
                            value={form.article_generation_mode}
                            size='small'
                            className={Style.darkControl}
                            options={ARTICLE_MODE_OPTIONS}
                            onChange={(value) => {
                              const mode = (value || 'basic') as ArticleGenerationMode;
                              setForm((prev) => ({
                                ...prev,
                                article_generation_mode: mode,
                                article_style_key:
                                  mode === 'official_rewrite'
                                    ? 'zhihu_answer'
                                    : mode === 'viral_rewrite'
                                    ? 'xiaohongshu_viral'
                                    : 'original',
                              }));
                            }}
                          />
                        </label>
                        <label className={Style.selectField}>
                          <span>生成风格</span>
                          <Select
                            value={form.article_style_key}
                            size='small'
                            className={Style.darkControl}
                            options={articleStyleOptions}
                            onChange={(value) =>
                              setForm((prev) => ({ ...prev, article_style_key: String(value || 'original') }))
                            }
                          />
                        </label>
                        <label className={Style.selectField}>
                          <span>文章模型</span>
                          <Select
                            value={form.content_provider || '__auto__'}
                            size='small'
                            className={Style.darkControl}
                            options={[
                              { label: '默认模型', value: '__auto__' },
                              ...availableProviders
                                .filter((p) => p.configured)
                                .map((p) => ({ label: p.name.split('·')[0].trim(), value: p.key })),
                            ]}
                            onChange={(value) =>
                              setForm((prev) => ({
                                ...prev,
                                content_provider: String(value) === '__auto__' ? '' : String(value),
                              }))
                            }
                          />
                        </label>
                        <label className={Style.selectField}>
                          <span>渠道</span>
                          <Select
                            value={form.content_channel}
                            size='small'
                            className={Style.darkControl}
                            options={[
                              { label: '官网文章', value: '官网文章' },
                              { label: '公众号文章', value: '公众号文章' },
                              { label: '知乎回答', value: '知乎回答' },
                            ]}
                            onChange={(value) => setForm((prev) => ({ ...prev, content_channel: String(value) }))}
                          />
                        </label>
                        <label className={Style.selectFieldSmall}>
                          <span>优先级</span>
                          <Select
                            value={form.content_priority}
                            size='small'
                            className={Style.darkControl}
                            options={[
                              { label: '高', value: '高' },
                              { label: '中', value: '中' },
                              { label: '低', value: '低' },
                            ]}
                            onChange={(value) => setForm((prev) => ({ ...prev, content_priority: String(value) }))}
                          />
                        </label>
                        <label className={Style.selectField}>
                          <span>Prompt策略</span>
                          <Select
                            value={form.article_prompt_strategy}
                            size='small'
                            className={Style.darkControl}
                            options={[
                              { label: '自动下一个', value: 'auto_next' },
                              { label: '手动指定', value: 'manual' },
                            ]}
                            onChange={(value) =>
                              setForm((prev) => ({
                                ...prev,
                                article_prompt_strategy: (value || 'auto_next') as ArticlePromptStrategy,
                              }))
                            }
                          />
                        </label>
                        <label className={Style.selectField}>
                          <span>图片策略</span>
                          <Select
                            value={form.article_image_strategy}
                            size='small'
                            className={Style.darkControl}
                            options={[
                              { label: '自动选择', value: 'auto' },
                              { label: '手动选择', value: 'manual' },
                            ]}
                            onChange={(value) =>
                              setForm((prev) => ({
                                ...prev,
                                article_image_strategy: (value || 'auto') as ArticleImageStrategy,
                              }))
                            }
                          />
                        </label>
                        <Checkbox
                          checked={form.content_allow_fallback}
                          onChange={(checked) =>
                            setForm((prev) => ({ ...prev, content_allow_fallback: Boolean(checked) }))
                          }
                        >
                          <span className={Style.checkboxText}>模型失败允许兜底</span>
                        </Checkbox>
                      </div>
                      {form.article_generation_mode === 'official_rewrite' ? (
                        <div className={Style.configInlineRow}>
                          <label className={Style.wideSelectField}>
                            <span>官网文章 URL</span>
                            <Input
                              value={form.article_source_url}
                              size='small'
                              className={Style.darkControl}
                              placeholder='可选；填写后用于抓取原文并按平台风格改写'
                              onChange={(value) => setForm((prev) => ({ ...prev, article_source_url: String(value) }))}
                            />
                          </label>
                          <label className={Style.wideSelectField}>
                            <span>用户问题词 / 搜索意图</span>
                            <Input
                              value={form.article_search_intent}
                              size='small'
                              className={Style.darkControl}
                              placeholder='可选；例如：深圳办公室出租怎么选'
                              onChange={(value) =>
                                setForm((prev) => ({ ...prev, article_search_intent: String(value) }))
                              }
                            />
                          </label>
                        </div>
                      ) : null}
                      {form.article_generation_mode === 'viral_rewrite' ? (
                        <div className={Style.configWarning}>
                          爆款改写入口已预留，本轮自动流程会先按所选风格记录配置，后续接入专门改写接口。
                        </div>
                      ) : null}
                    </div>

                    <div className={Style.configGroup}>
                      <div className={Style.configGroupHeader}>
                        <span className={Style.configStep}>04</span>
                        <div>
                          <div className={Style.configTitle}>问题选择</div>
                          <div className={Style.configHint}>选中的问题会进入模型对比和后续内容选题。</div>
                        </div>
                        <button
                          type='button'
                          className={Style.configTextButton}
                          onClick={() => {
                            setAdvancedExpanded((v) => !v);
                            if (!advancedExpanded) fetchPrompts();
                          }}
                        >
                          {advancedExpanded ? '收起高级' : '高级配置'}
                        </button>
                      </div>
                      <div className={Style.questionConfigBody}>
                        {inventoryPrompts.length === 0 ? (
                          <span style={{ fontSize: 11, color: '#888d98' }}>
                            {promptsLoading ? (
                              '加载 Prompt 库存中...'
                            ) : (
                              <span>
                                暂无可选 Prompt，将自动生成问题{' '}
                                <span
                                  style={{ color: 'var(--td-brand-color)', cursor: 'pointer' }}
                                  onClick={() => fetchPrompts(true)}
                                >
                                  点击加载
                                </span>
                              </span>
                            )}
                          </span>
                        ) : (
                          <>
                            <div
                              style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: '6px 16px',
                                maxHeight: 140,
                                overflowY: 'auto',
                              }}
                            >
                              {inventoryPrompts.map((item) => (
                                <Checkbox
                                  key={item.id}
                                  checked={selectedPromptIds.has(item.id)}
                                  onChange={(checked) => {
                                    const next = new Set(selectedPromptIds);
                                    if (checked) {
                                      next.add(item.id);
                                    } else {
                                      next.delete(item.id);
                                    }
                                    setSelectedPromptIds(next);
                                    setForm((prev) => ({
                                      ...prev,
                                      prompt_ids: [...next],
                                      question_count: next.size >= 3 ? next.size : 6,
                                    }));
                                  }}
                                >
                                  <span style={{ fontSize: 12, color: '#b0b5c0' }}>
                                    {item.prompt.length > 50 ? `${item.prompt.slice(0, 48)}...` : item.prompt}
                                  </span>
                                </Checkbox>
                              ))}
                            </div>
                            <div style={{ fontSize: 11, color: '#888d98', marginTop: 4 }}>
                              已选 {selectedPromptIds.size} 个问题{selectedPromptIds.size === 0 ? '（将自动生成）' : ''}
                              <span
                                style={{ color: 'var(--td-brand-color)', cursor: 'pointer', marginLeft: 8 }}
                                onClick={() => fetchPrompts(true)}
                              >
                                刷新
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  {advancedExpanded ? (
                    <div className={Style.fieldMatrix} style={{ marginBottom: 12 }}>
                      <div className={Style.fieldWrap}>
                        <div className={Style.fieldLabel}>跳过步骤</div>
                        <Textarea
                          value={form.skip_steps}
                          autosize={{ minRows: 1, maxRows: 3 }}
                          placeholder='每行一个：diagnosis / assets / report / model_compare / question_summary / prompt_inventory / content_task / visibility / recheck'
                          onChange={(value) => setForm((prev) => ({ ...prev, skip_steps: String(value) }))}
                          className={Style.darkControl}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className={Style.heroActions}>
                    <Button theme='primary' loading={starting} onClick={startWorkflow} className={Style.primaryButton}>
                      启动自动运作
                    </Button>
                    {currentWorkflow && ['running', 'pending'].includes(currentWorkflow.status) ? (
                      <Button
                        theme='danger'
                        loading={actionLoading === `cancel:${currentWorkflow.id}`}
                        onClick={() => handleCancel(currentWorkflow)}
                        className={Style.primaryButton}
                      >
                        终止运作
                      </Button>
                    ) : null}
                    <Button
                      icon={<RefreshIcon />}
                      variant='outline'
                      loading={runLoading}
                      onClick={fetchRuns}
                      className={Style.ghostButton}
                    >
                      刷新状态
                    </Button>
                    <Button
                      theme='primary'
                      variant='outline'
                      loading={actionLoading === 'inspect-due'}
                      onClick={handleInspectDue}
                      className={Style.ghostButton}
                    >
                      巡检到期任务
                    </Button>
                    <Button
                      theme='primary'
                      variant='outline'
                      loading={actionLoading === 'content-auto-start'}
                      onClick={handleAutoStartContent}
                      className={Style.ghostButton}
                    >
                      扫描写作任务池
                    </Button>
                  </div>
                </div>

                <div className={Style.corePanel}>
                  <div className={Style.coreEnergyField} />
                  <div
                    className={Style.coreRing}
                    style={{ ['--core-progress' as any]: `${Math.max(8, displayProgress)}%` }}
                  >
                    <div className={Style.corePulseHalo} />
                    <div className={Style.coreFieldGlow} />
                    <div className={Style.coreLiquidWrap}>
                      <div className={Style.coreLiquid} />
                      <div className={Style.coreLiquidSecondary} />
                      <div className={Style.coreSpecular} />
                    </div>
                    <div className={Style.coreRingInner}>
                      <div className={Style.coreEyebrow}>Execution Core</div>
                      {stats.status === 'running' ? (
                        <>
                          <div className={Style.coreValue}>{displayProgress}%</div>
                          <div className={Style.coreHint}>自动运作进度</div>
                        </>
                      ) : (
                        <>
                          <div className={Style.coreValue} style={{ fontSize: 16, lineHeight: 1.5 }}>
                            当前没有
                            <br />
                            正在工作的内容
                          </div>
                          <div className={Style.coreHint}>启动自动运作开始新一轮</div>
                        </>
                      )}
                    </div>
                  </div>
                  <div className={Style.coreStatus}>
                    <span className={`${Style.infoPill} ${Style.tonePrimary}`}>{currentPhase.title}</span>
                    <span
                      className={`${Style.infoPill} ${
                        stats.status === 'running' ? Style.toneSuccess : Style.toneWarning
                      }`}
                    >
                      {stats.status === 'running' ? '系统运行中' : '等待下一步'}
                    </span>
                  </div>
                  <div className={Style.coreDesc}>{currentPhase.note}</div>
                </div>
              </div>
            </section>

            <section className={cn(Style.panel, Style.launchPanel)}>
              <div className={Style.panelHeader}>
                <div>
                  <div className={Style.panelEyebrow}>Launch Input</div>
                  <div className={Style.panelTitle}>
                    <PlayCircleIcon className={Style.panelIcon} />
                    启动资料与执行入口
                  </div>
                  <div className={Style.panelDesc}>
                    从客户资产或品牌资料带入一份完整上下文，后面诊断、内容、报告与复测都共用这一份资料，不再重复录入。
                  </div>
                </div>

                <div className={Style.sectionActions}>
                  <span className={`${Style.infoPill} ${Style.toneSuccess}`}>资料贯通</span>
                  <Button
                    icon={<RefreshIcon />}
                    variant='outline'
                    loading={sourceLoading}
                    onClick={loadSources}
                    className={Style.ghostButton}
                  >
                    刷新资料
                  </Button>
                </div>
              </div>

              <div className={Style.launchGrid}>
                <div className={Style.formColumn}>
                  <div className={Style.fieldWrap}>
                    <div className={Style.fieldLabel}>从已有资料导入</div>
                    <Select
                      value={selectedSourceId}
                      options={sourceOptions}
                      placeholder='选择客户资产或品牌资料'
                      clearable
                      filterable
                      loading={sourceLoading}
                      onChange={handleSourceChange}
                      className={Style.darkControl}
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div className={Style.formRow}>
                    <div className={Style.fieldWrap}>
                      <div className={Style.fieldLabel}>项目 / 品牌</div>
                      <Input
                        value={form.project_name}
                        placeholder='例如：青创美居'
                        onChange={(value) => setForm((prev) => ({ ...prev, project_name: String(value) }))}
                        className={Style.darkControl}
                      />
                    </div>

                    <div className={Style.fieldWrap}>
                      <div className={Style.fieldLabel}>官网域名</div>
                      <Input
                        value={form.domain}
                        placeholder='例如：example.com'
                        onChange={(value) => setForm((prev) => ({ ...prev, domain: String(value) }))}
                        className={Style.darkControl}
                      />
                    </div>
                  </div>

                  <div className={Style.fieldWrap}>
                    <div className={Style.fieldLabel}>一句话描述</div>
                    <Textarea
                      value={form.description}
                      autosize={{ minRows: 4, maxRows: 6 }}
                      placeholder='客户是做什么的，系统将用它生成默认诊断上下文'
                      onChange={(value) => setForm((prev) => ({ ...prev, description: String(value) }))}
                      className={Style.darkControl}
                    />
                  </div>
                </div>

                <div className={Style.fieldMatrix}>
                  <div className={Style.fieldWrap}>
                    <div className={Style.fieldLabel}>目标关键词</div>
                    <Textarea
                      value={form.keywords}
                      autosize={{ minRows: 7, maxRows: 7 }}
                      placeholder='每行一个，或用逗号分隔'
                      onChange={(value) => setForm((prev) => ({ ...prev, keywords: String(value) }))}
                      className={Style.darkControl}
                    />
                  </div>

                  <div className={Style.fieldWrap}>
                    <div className={Style.fieldLabel}>核心页面 URL</div>
                    <Textarea
                      value={form.urls}
                      autosize={{ minRows: 7, maxRows: 7 }}
                      placeholder='不填会按官网自动生成首页、产品、案例、联系页'
                      onChange={(value) => setForm((prev) => ({ ...prev, urls: String(value) }))}
                      className={Style.darkControl}
                    />
                  </div>

                  <div className={Style.fieldWrap}>
                    <div className={Style.fieldLabel}>竞品</div>
                    <Textarea
                      value={form.competitors}
                      autosize={{ minRows: 7, maxRows: 7 }}
                      placeholder='每行一个竞品域名或品牌名'
                      onChange={(value) => setForm((prev) => ({ ...prev, competitors: String(value) }))}
                      className={Style.darkControl}
                    />
                  </div>

                  <div className={Style.fieldWrap}>
                    <div className={Style.fieldLabel}>客户需求 / 备注</div>
                    <Textarea
                      value={form.notes}
                      autosize={{ minRows: 7, maxRows: 7 }}
                      placeholder='客户需求、行业背景、报告上下文'
                      onChange={(value) => setForm((prev) => ({ ...prev, notes: String(value) }))}
                      className={Style.darkControl}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className={Style.panel}>
              <div className={Style.panelHeader}>
                <div>
                  <div className={Style.panelEyebrow}>Execution Flow</div>
                  <div className={Style.panelTitle}>自动执行流程</div>
                  <div className={Style.panelDesc}>
                    客户不是操作员，这一页只负责告诉你系统已经推进到了哪里、下一步会做什么。
                  </div>
                </div>
              </div>

              <div className={Style.flowGrid}>
                {EXECUTION_PHASES.map((phase, index) => {
                  const isTerminated = currentWorkflow?.status === 'failed' || currentWorkflow?.status === 'cancelled';
                  const state =
                    isTerminated && index === currentPhaseIndex
                      ? 'risk'
                      : index < currentPhaseIndex
                      ? 'done'
                      : index === currentPhaseIndex
                      ? 'active'
                      : 'waiting';

                  return (
                    <div
                      key={phase.title}
                      className={cn(
                        Style.flowCard,
                        Style.flowMotion,
                        state === 'done' && Style.flowDone,
                        state === 'active' && Style.flowActive,
                        state === 'risk' && Style.flowRisk,
                        state === 'waiting' && Style.flowWaiting,
                      )}
                      style={{ ['--stagger' as any]: `${index * 90}ms` }}
                    >
                      <div className={Style.flowHead}>
                        <div className={Style.flowIndex}>0{index + 1}</div>
                        <span
                          className={cn(
                            Style.statusPill,
                            state === 'done' && Style.toneSuccess,
                            state === 'active' && Style.tonePrimary,
                            state === 'risk' && Style.toneDanger,
                            state === 'waiting' && Style.toneDefault,
                          )}
                        >
                          {state === 'done'
                            ? '完成'
                            : state === 'active'
                            ? '运行中'
                            : state === 'risk'
                            ? '异常'
                            : '待执行'}
                        </span>
                      </div>
                      <div className={Style.flowTitle}>{phase.title}</div>
                      <div className={Style.flowNote}>{phase.note}</div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className={Style.panel}>
              <div className={Style.panelHeader}>
                <div>
                  <div className={Style.panelEyebrow}>Content Agent</div>
                  <div className={Style.panelTitle}>
                    <RocketIcon className={Style.panelIcon} />
                    内容 Agent 采集并生成文章
                  </div>
                  <div className={Style.panelDesc}>
                    自动采集关键词相关高频问题，写入 Prompt 库，并调用所选模型生成可查看、可编辑的文章草稿。
                  </div>
                </div>

                <div className={Style.sectionActions}>
                  <Select
                    value={contentProvider || '__default__'}
                    size='small'
                    style={{ width: 170 }}
                    className={Style.darkControl}
                    options={[
                      { label: '默认模型', value: '__default__' },
                      ...availableProviders
                        .filter((p) => p.configured)
                        .map((p) => ({ label: p.name.split('·')[0].trim(), value: p.key })),
                    ]}
                    onChange={(value) => setContentProvider(String(value) === '__default__' ? '' : String(value))}
                  />
                  <span className={`${Style.infoPill} ${Style.toneSuccess}`}>生成草稿</span>
                  <Button
                    theme='primary'
                    variant='outline'
                    loading={actionLoading === 'content-auto-start'}
                    onClick={handleAutoStartContent}
                    className={Style.ghostButton}
                  >
                    采集并生成
                  </Button>
                </div>
              </div>

              {contentRuns.length === 0 ? (
                <div className={Style.emptyState}>
                  暂无内容 Agent 记录。到“内容自动化 → 内容任务”创建任务，或在这里扫描任务关键词并生成文章。
                </div>
              ) : (
                <div className={Style.contentGrid}>
                  {contentRuns.slice(0, 6).map((run, index) => {
                    const tone =
                      run.status === 'completed'
                        ? 'success'
                        : run.status === 'failed'
                        ? 'danger'
                        : run.status === 'running'
                        ? 'primary'
                        : 'warning';
                    return (
                      <div
                        key={run.id}
                        className={cn(
                          Style.contentCard,
                          run.status === 'running' && Style.contentCardLive,
                          run.status === 'completed' && Style.contentCardDone,
                        )}
                        style={{ ['--stagger' as any]: `${(index % 6) * 70}ms` }}
                      >
                        <div className={Style.contentTop}>
                          <div className={Style.contentPills}>
                            <span className={`${Style.infoPill} ${toneClass(tone)}`}>
                              {CONTENT_STAGE_LABELS[run.stage] || run.stage}
                            </span>
                            <span className={`${Style.infoPill} ${Style.tonePrimary}`}>{run.agent_key}</span>
                            <span className={`${Style.infoPill} ${Style.toneDefault}`}>
                              {run.provider || '默认模型'}
                            </span>
                            {run.geo_score ? (
                              <span className={`${Style.infoPill} ${Style.toneSuccess}`}>GEO {run.geo_score}</span>
                            ) : null}
                          </div>
                        </div>
                        <div className={Style.contentTitle}>{run.title}</div>
                        <div className={Style.contentMeta}>
                          {run.channel} → {run.target}
                        </div>
                        <div className={Style.contentDesc}>{run.route_reason || run.error || '等待星枢路由'}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <div className={Style.dualGrid}>
              <section className={Style.panel}>
                <div className={Style.panelHeader}>
                  <div>
                    <div className={Style.panelEyebrow}>System Thinking</div>
                    <div className={Style.panelTitle}>系统行为日志</div>
                  </div>
                </div>

                <div className={Style.logList}>
                  {executionLogs.map((line, index) => (
                    <div
                      key={`${line}-${index}`}
                      className={cn(Style.logItem, index === activeLogIndex && Style.logItemActive)}
                      style={{ ['--stagger' as any]: `${index * 120}ms` }}
                    >
                      <span className={Style.logIndex}>{String(index + 1).padStart(2, '0')}</span>
                      <span>{line}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className={Style.panel}>
                <div className={Style.panelHeader}>
                  <div>
                    <div className={Style.panelEyebrow}>Current Tasks</div>
                    <div className={Style.panelTitle}>当前自动任务</div>
                  </div>
                </div>

                {currentTasks.length === 0 ? (
                  <div className={Style.emptyState}>暂无正在推进的执行项，启动一条自动运作链后这里会显示实时步骤。</div>
                ) : (
                  <div className={Style.taskList}>
                    {currentTasks.map((task) => (
                      <div
                        key={task.key}
                        className={cn(
                          Style.taskCard,
                          task.status === 'running' && Style.taskCardLive,
                          task.status === 'completed' && Style.taskCardDone,
                        )}
                        style={{
                          ['--stagger' as any]: `${
                            (Number(String(task.key).replace(/\D/g, '').slice(-2)) || 0) * 40
                          }ms`,
                        }}
                      >
                        <div className={Style.taskMain}>
                          <div className={Style.taskName}>{task.title}</div>
                          <div className={Style.taskDetail}>{task.detail}</div>
                        </div>
                        <div>{statusTag(task.status)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <section className={Style.panel}>
              <div className={Style.panelHeader}>
                <div>
                  <div className={Style.panelEyebrow}>Auto Ops Log</div>
                  <div className={Style.panelTitle}>自动运作记录</div>
                  <div className={Style.panelDesc}>
                    这里看的是整条交付链和巡检链是否健康，不用再在任务、报告、内容页之间来回切。
                  </div>
                </div>

                <div className={Style.sectionActions}>
                  <span className={`${Style.infoPill} ${Style.toneDefault}`}>12 秒自动刷新</span>
                  <Button icon={<RefreshIcon />} loading={runLoading} onClick={fetchRuns} className={Style.ghostButton}>
                    刷新状态
                  </Button>
                </div>
              </div>

              {latestRuns.length === 0 ? (
                <div className={Style.emptyState}>暂无 Agent 自动运作记录，先选择一个客户资料启动第一条链路。</div>
              ) : (
                <>
                  <div className={Style.recordList}>
                    {(recordsExpanded ? latestRuns : latestRuns.slice(0, 10)).map((run) => {
                      const runReports = reportsCache[run.id];
                      return (
                        <div key={run.id} className={Style.recordCard}>
                          <div
                            className={Style.recordHead}
                            style={{ cursor: 'pointer' }}
                            onClick={async () => {
                              const nextId = expandedRunId === run.id ? null : run.id;
                              setExpandedRunId(nextId);
                              if (nextId && !reportsCache[nextId]) {
                                setReportsLoading(true);
                                try {
                                  const { reports } = await getAgentWorkflowReports(nextId);
                                  setReportsCache((prev) => ({ ...prev, [nextId]: reports }));
                                } catch {
                                  /* ignore */
                                }
                                setReportsLoading(false);
                              }
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
                              <span
                                style={{
                                  fontSize: 11,
                                  color: 'var(--td-text-color-placeholder)',
                                  transition: 'transform .2s',
                                  display: 'inline-block',
                                  transform: expandedRunId === run.id ? 'rotate(90deg)' : '',
                                }}
                              >
                                ▶
                              </span>
                              {statusTag(run.status)}
                            </div>
                            <div className={Style.recordMain}>
                              <div className={Style.recordTitle}>
                                {run.project_name}
                                <span className={Style.recordDomain}>{run.domain || '缺官网域名'}</span>
                              </div>
                              <div className={Style.recordSummary}>{run.summary || '等待 Agent 写入执行摘要'}</div>
                            </div>
                          </div>

                          {expandedRunId === run.id ? (
                            <>
                              <div className={Style.recordActions}>
                                <Button
                                  size='small'
                                  variant='outline'
                                  loading={actionLoading === `export:${run.id}`}
                                  onClick={() => handleExport(run)}
                                  className={Style.ghostButton}
                                >
                                  导出报告
                                </Button>
                                <Button
                                  size='small'
                                  variant='outline'
                                  loading={actionLoading === `retry:${run.id}`}
                                  onClick={() => handleRetry(run)}
                                  className={Style.ghostButton}
                                >
                                  失败重试
                                </Button>
                                {['running', 'pending'].includes(run.status) ? (
                                  <Button
                                    size='small'
                                    variant='outline'
                                    theme='danger'
                                    loading={actionLoading === `cancel:${run.id}`}
                                    onClick={() => handleCancel(run)}
                                    className={Style.ghostButton}
                                  >
                                    终止
                                  </Button>
                                ) : null}
                                <Button
                                  size='small'
                                  variant='text'
                                  onClick={() => copyCallbackUrl(run)}
                                  className={Style.textButton}
                                >
                                  复制 n8n 回调
                                </Button>
                                {run.report_id ? (
                                  <Button
                                    size='small'
                                    variant='outline'
                                    onClick={() => navigate(`/reports/scoring?report_id=${run.report_id}`)}
                                    className={Style.ghostButton}
                                  >
                                    看报告
                                  </Button>
                                ) : null}
                                {run.task_id ? (
                                  <Button
                                    size='small'
                                    variant='outline'
                                    onClick={() => navigate('/monitoring/tasks')}
                                    className={Style.ghostButton}
                                  >
                                    看任务
                                  </Button>
                                ) : null}
                              </div>

                              <div className={Style.metaGrid}>
                                <span className={`${Style.infoPill} ${Style.toneDefault}`}>
                                  重试 {run.retry_count || 0}/{run.max_retries || 2}
                                </span>
                                <span
                                  className={`${Style.infoPill} ${
                                    run.n8n_status ? Style.toneWarning : Style.toneDefault
                                  }`}
                                >
                                  n8n {run.n8n_status || '未回调'}
                                </span>
                              </div>

                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  marginTop: 8,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <Button
                                  size='small'
                                  variant='outline'
                                  theme={run.schedule_enabled ?? true ? 'warning' : 'default'}
                                  loading={actionLoading === `schedule:${run.id}`}
                                  onClick={() => handleSchedule(run)}
                                  className={Style.ghostButton}
                                >
                                  {run.schedule_enabled ?? true ? '关闭定时巡检' : '开启定时巡检'}
                                </Button>
                                <Button
                                  size='small'
                                  variant='outline'
                                  loading={actionLoading === `inspect:${run.id}`}
                                  onClick={() => handleInspect(run)}
                                  className={Style.ghostButton}
                                >
                                  立即巡检
                                </Button>
                                <span style={{ fontSize: 11, color: '#888d98' }}>
                                  下次巡检 {formatTime(run.next_run_at)}
                                </span>
                              </div>

                              {run.last_inspection ? (
                                <div className={Style.inspectionBox}>
                                  最近巡检：风险等级 {String(run.last_inspection.severity || 'none')}，变化{' '}
                                  {Array.isArray(run.last_inspection.changes) ? run.last_inspection.changes.length : 0}{' '}
                                  项
                                </div>
                              ) : null}

                              <StepList steps={run.steps} />

                              {reportsLoading ? (
                                <div style={{ fontSize: 12, color: '#888d98', padding: '8px 0' }}>加载报告中...</div>
                              ) : runReports ? (
                                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  <div style={{ fontSize: 12, color: '#b0b5c0', fontWeight: 600 }}>生成报告</div>
                                  {runReports.geo_report ? (
                                    <div className={Style.inspectionBox}>
                                      GEO诊断：评分 {runReports.geo_report.score ?? '-'}，等级{' '}
                                      {runReports.geo_report.grade ?? '-'}
                                      {runReports.geo_report.issues?.length ? (
                                        <ul style={{ margin: '4px 0 0 16px', fontSize: 11, color: '#888d98' }}>
                                          {runReports.geo_report.issues.map((s, i) => (
                                            <li key={i}>{s}</li>
                                          ))}
                                        </ul>
                                      ) : null}
                                    </div>
                                  ) : null}
                                  {runReports.model_report ? (
                                    <div className={Style.inspectionBox}>
                                      模型对比：{runReports.model_report.model_count} 个模型 ×{' '}
                                      {runReports.model_report.question_count} 问题， 均分{' '}
                                      {runReports.model_report.avg_score ?? '-'}， 品牌提及率{' '}
                                      {runReports.model_report.brand_rate ?? '-'}%
                                    </div>
                                  ) : null}
                                  {runReports.summary_report ? (
                                    <div className={Style.inspectionBox}>
                                      问题库总结
                                      {runReports.summary_report.provider
                                        ? `（${runReports.summary_report.provider}${
                                            runReports.summary_report.model
                                              ? ` / ${runReports.summary_report.model}`
                                              : ''
                                          }）`
                                        : ''}
                                      {runReports.summary_report.summary?.length ? (
                                        <ul style={{ margin: '4px 0 0 16px', fontSize: 11, color: '#888d98' }}>
                                          {runReports.summary_report.summary.map((s, i) => (
                                            <li key={i}>{s}</li>
                                          ))}
                                        </ul>
                                      ) : null}
                                    </div>
                                  ) : null}
                                  {runReports.analysis_report ? (
                                    <div className={Style.inspectionBox}>
                                      分析报告：评分 {runReports.analysis_report.score ?? '-'}，等级{' '}
                                      {runReports.analysis_report.grade ?? '-'}
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {latestRuns.length > 10 ? (
                    <div style={{ textAlign: 'center', marginTop: 16 }}>
                      <Button
                        variant='outline'
                        size='small'
                        onClick={() => setRecordsExpanded((v) => !v)}
                        className={Style.ghostButton}
                      >
                        {recordsExpanded ? `收起 — 只显示最近 10 条` : `展开全部 ${latestRuns.length} 条记录`}
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </section>
          </div>

          <div className={Style.sideColumn}>
            <section className={Style.panel}>
              <div className={Style.panelEyebrow}>Mission Control</div>
              <div className={Style.panelTitle}>系统状态</div>

              <div className={Style.statusStack}>
                <div className={cn(Style.statusCard, Style.statusCardLive)}>
                  <div className={Style.statusLabel}>当前目标</div>
                  <div className={Style.statusValue}>{currentTarget}</div>
                </div>
                <div className={cn(Style.statusCard, stats.status === 'running' && Style.statusCardRunning)}>
                  <div className={Style.statusLabel}>运行状态</div>
                  <div className={Style.statusValue}>
                    {STATUS_CFG[currentWorkflow?.status || 'pending']?.label || '等待启动'}
                  </div>
                </div>
                <div className={Style.statusCard}>
                  <div className={Style.statusLabel}>执行阶段</div>
                  <div className={Style.statusValue}>{currentPhase.title}</div>
                </div>
                <div className={cn(Style.statusCard, Style.statusCardProgress)}>
                  <div className={Style.statusLabel}>执行进度</div>
                  <div className={Style.statusValue}>{displayProgress}%</div>
                </div>
                <div className={Style.statusCard}>
                  <div className={Style.statusLabel}>下一次巡检</div>
                  <div className={Style.statusValue}>{formatTime(currentWorkflow?.next_run_at)}</div>
                </div>
              </div>
            </section>

            <section className={Style.panel}>
              <div className={Style.panelEyebrow}>Readiness</div>
              <div className={Style.panelTitle}>启动准备度</div>
              <div className={Style.readinessList}>
                {readinessItems.map((item) => (
                  <div key={item.label} className={Style.readinessItem}>
                    <div className={Style.readinessLabel}>{item.label}</div>
                    <div className={Style.readinessValue}>{item.value}</div>
                    <div className={cn(Style.readinessPill, item.ready ? Style.readyYes : Style.readyNo)}>
                      {item.ready ? <CheckCircleFilledIcon /> : <CloseCircleFilledIcon />}
                      {item.ready ? '已就绪' : '待补充'}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className={Style.panel}>
              <div className={Style.panelEyebrow}>Recent Runs</div>
              <div className={Style.panelTitle}>最近运行记录</div>
              <div className={Style.summaryRunList}>
                {latestRuns.length === 0 ? (
                  <div className={Style.emptyMini}>启动第一条自动运作链后，这里会出现最近运行记录。</div>
                ) : (
                  latestRuns.slice(0, 4).map((run, index) => (
                    <div
                      key={run.id}
                      className={cn(
                        Style.summaryRunCard,
                        run.status === 'running' && Style.summaryRunCardLive,
                        run.status === 'completed' && Style.summaryRunCardDone,
                      )}
                      style={{ ['--stagger' as any]: `${(index % 4) * 80}ms` }}
                    >
                      <div className={Style.summaryRunHead}>
                        <div className={Style.summaryRunTitle}>{run.project_name}</div>
                        {statusTag(run.status)}
                      </div>
                      <div className={Style.summaryRunMeta}>{run.domain || '缺官网域名'}</div>
                      <div className={Style.summaryRunMeta}>创建于 {formatTime(run.created_at)}</div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className={cn(Style.panel, Style.decisionPanel)}>
              <div className={Style.panelEyebrow}>Decision Layer</div>
              <div className={Style.decisionTitle}>系统已经在替你执行，你现在只需要做判断。</div>
              <p className={Style.decisionDesc}>
                当资料齐全时，点一次启动，后面诊断、内容、报告、复测会一路自己推进。你真正需要介入的，只有策略确认、失败重试和最终发布。
              </p>

              <div className={Style.decisionList}>
                <div className={Style.decisionItem}>
                  <LoadingIcon className={Style.decisionIcon} />
                  <span>自动交付链：{stats.active > 0 ? '正在推进' : '等待启动'}</span>
                </div>
                <div className={Style.decisionItem}>
                  <TimeFilledIcon className={Style.decisionIcon} />
                  <span>内容待发布：{contentRuns.filter((run) => run.stage === 'ready_to_publish').length} 条</span>
                </div>
              </div>

              <div className={Style.decisionActions}>
                <Button theme='primary' onClick={startWorkflow} loading={starting} className={Style.primaryButton}>
                  启动自动运作
                </Button>
                <Button
                  variant='outline'
                  onClick={() => navigate('/distribution/personal')}
                  className={Style.ghostButton}
                >
                  打开待发布草稿箱
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </AgentShell>
  );
};

export default Autopilot;
