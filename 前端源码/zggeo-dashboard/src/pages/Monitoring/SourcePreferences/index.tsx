import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  Dialog,
  Input,
  MessagePlugin,
  PrimaryTableCol,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'tdesign-react';
import { RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import {
  createArticleGenerationRunDb,
  createContentOptimizationCampaign,
  createModelVisibilitySourceProbe,
  getContentOptimizationReport,
  getContentOptimizationTrend,
  getPromptSourcePreferences,
  getSourcePreferences,
  listContentTasksDb,
  listKeywordPrompts,
  listModelVisibilityRuns,
  ModelVisibilityRun,
  retestContentOptimizationCampaign,
  SourcePreferenceProfile,
  KeywordPromptItem,
} from 'services/zggeo-api';
import {
  buildProjectSourceOptions,
  getActiveProjectContext,
  loadProjectSources,
  ProjectContext,
  saveActiveProjectContext,
} from 'utils/projectContext';
import styles from '../linear.module.less';

const { TabPanel } = Tabs;

type DistributionRow = {
  key?: string;
  label?: string;
  count?: number;
  model_count?: number;
  question_count?: number;
  models?: string[];
  questions?: string[];
};

const DAY_OPTIONS = [
  { label: '最近 7 天', value: 7 },
  { label: '最近 30 天', value: 30 },
  { label: '最近 90 天', value: 90 },
  { label: '最近 180 天', value: 180 },
  { label: '最近 365 天', value: 365 },
];

const ANCHOR_LABELS = [
  '客户原话',
  '时间节点',
  '使用场景',
  '事实数据',
  '身份信息',
  '执行步骤',
  '选择对比',
  '权威引用',
  '真实案例',
  '持续输出',
];

const safeNumber = (value: unknown) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const metricText = (value: unknown, suffix = '') => {
  const num = safeNumber(value);
  if (num === null) return '--';
  return `${num}${suffix}`;
};

const percentText = (value: unknown) => metricText(value, '%');

const sourceTypeLabel = (value?: unknown) => {
  const key = String(value || '').trim();
  const labels: Record<string, string> = {
    official: '官网',
    zhihu: '知乎',
    xiaohongshu: '小红书',
    wechat: '公众号',
    baike: '百科',
    news: '新闻站',
    website: '普通网站',
    weak_source: '弱来源',
    unknown: '未知',
  };
  return labels[key] || key || '未知';
};

const sourceTypeTheme = (value?: unknown) => {
  const key = String(value || '').trim();
  if (key === 'official') return 'success';
  if (['zhihu', 'wechat', 'xiaohongshu'].includes(key)) return 'primary';
  if (key === 'weak_source') return 'warning';
  return 'default';
};

const verificationStatusLabel = (value?: unknown) => {
  const key = String(value || '').trim();
  const labels: Record<string, string> = {
    verified: '已校验',
    unverified: '未校验',
    unreachable: '不可访问',
    domain_only: '仅域名',
    title_only: '仅标题',
    suspected_hallucination: '疑似编造',
  };
  return labels[key] || key || '未知';
};

const verificationStatusTheme = (value?: unknown) => {
  const key = String(value || '').trim();
  if (key === 'verified') return 'success';
  if (key === 'unreachable' || key === 'suspected_hallucination') return 'danger';
  if (key === 'domain_only' || key === 'title_only') return 'warning';
  return 'default';
};

const anchorSuggestion = (label: string) => {
  if (label === '事实数据') return '补充可验证数据、时间节点和统计口径。';
  if (label === '权威引用') return '补充行业报告、官方标准或专家观点。';
  if (label === '真实案例' || label === '客户原话') return '补充真实场景和反馈，不编造客户名称。';
  if (label === '执行步骤') return '把观点拆成流程、步骤或行动清单。';
  if (label === '选择对比') return '增加选择标准、对比维度和边界。';
  return '保持事实可核验，补充上下文。';
};

const cleanOptions = (items: Array<{ label: string; value: string }>) =>
  items.filter((item, index, arr) => item.value && arr.findIndex((x) => x.value === item.value) === index);

const SourcePreferences: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [profile, setProfile] = useState<SourcePreferenceProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('sources');
  const [sources, setSources] = useState<ProjectContext[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [domain, setDomain] = useState('');
  const [question, setQuestion] = useState('');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [runType, setRunType] = useState('');
  const [verificationStatus, setVerificationStatus] = useState('');
  const [days, setDays] = useState(90);
  const [prompts, setPrompts] = useState<KeywordPromptItem[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [promptProfile, setPromptProfile] = useState<SourcePreferenceProfile | null>(null);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const [tasks, setTasks] = useState<Record<string, unknown>[]>([]);
  const [runs, setRuns] = useState<ModelVisibilityRun[]>([]);
  const [selectedParentRunId, setSelectedParentRunId] = useState(searchParams.get('parent_run_id') || '');
  const [selectedSourceProbeRunId, setSelectedSourceProbeRunId] = useState(searchParams.get('source_probe_run_id') || '');
  const [generateOpen, setGenerateOpen] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [usePreference, setUsePreference] = useState('yes');
  const [publishedUrl, setPublishedUrl] = useState('');
  const [beforeRunId, setBeforeRunId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [report, setReport] = useState<Record<string, any> | null>(null);
  const [trend, setTrend] = useState<Array<Record<string, unknown>>>([]);

  const sourceOptions = useMemo(() => buildProjectSourceOptions(sources), [sources]);
  const promptOptions = useMemo(
    () => cleanOptions(prompts.map((item) => ({ label: item.prompt || item.keyword || item.id, value: item.id }))),
    [prompts],
  );
  const taskOptions = useMemo(
    () =>
      cleanOptions(
        tasks.map((item) => ({
          label: `${String(item.title || '写作任务')} · ${String(item.keyword || '-')}`,
          value: String(item.id || ''),
        })),
      ),
    [tasks],
  );
  const runOptions = useMemo(
    () =>
      cleanOptions(
        runs.map((run) => ({
          label: `${run.project_name} · ${new Date(run.created_at).toLocaleString()} · ${metricText(
            run.summary?.average_score,
            '分',
          )}`,
          value: run.id,
        })),
      ),
    [runs],
  );
  const normalRunOptions = useMemo(
    () =>
      cleanOptions(
        runs
          .filter((run) => (run.run_type || 'normal') === 'normal')
          .map((run) => ({
            label: `${run.project_name} · ${new Date(run.created_at).toLocaleString()} · ${metricText(
              run.summary?.average_score,
              '分',
            )}`,
            value: run.id,
          })),
      ),
    [runs],
  );
  const selectedParentRun = useMemo(
    () => runs.find((run) => run.id === selectedParentRunId),
    [runs, selectedParentRunId],
  );
  const sourceProbeRunOptions = useMemo(
    () =>
      cleanOptions(
        ((profile?.source_probe_runs || []) as Record<string, unknown>[]).map((run) => ({
          label: `${String(run.status || '采集')} · ${new Date(String(run.created_at || '')).toLocaleString()}`,
          value: String(run.id || ''),
        })),
      ),
    [profile?.source_probe_runs],
  );

  const activePreference = promptProfile || profile;
  const summary = profile?.summary || {};
  const parentSummary = ((profile?.parent_run || {}) as Record<string, any>).summary || {};
  const recommendations = activePreference?.recommendations || {};
  const topDomains = ((profile?.top_source_domains || []) as DistributionRow[]).map((item) => ({
    ...item,
    id: item.key || item.label,
  }));
  const sourceTypes = (profile?.source_type_distribution || []) as DistributionRow[];
  const sourceVerifications = (profile?.source_verification_distribution || []) as DistributionRow[];
  const articleTypes = (profile?.article_type_distribution || []) as DistributionRow[];
  const trustAnchorRates = (profile?.trust_anchor_rates || {}) as Record<string, Record<string, unknown>>;
  const averageStructure = (profile?.average_structure || {}) as Record<string, unknown>;

  const loadSources = async () => {
    const nextSources = await loadProjectSources();
    const active = getActiveProjectContext();
    const merged = active ? [active, ...nextSources.filter((item) => item.id !== active.id)] : nextSources;
    setSources(merged);
    if (active) {
      setSelectedSourceId(active.id);
      setProjectName(active.project_name || '');
      setDomain(active.domain || '');
    }
  };

  const loadPrompts = async (brand = projectName, site = domain) => {
    if (!brand.trim() && !site.trim()) {
      setPrompts([]);
      return;
    }
    try {
      const data = await listKeywordPrompts({
        brand_name: brand.trim() || undefined,
        domain: site.trim() || undefined,
        limit: 100,
      });
      setPrompts(data.items || []);
    } catch (err: any) {
      MessagePlugin.warning(`Prompt 读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    }
  };

  const loadAuxiliary = async () => {
    const [taskRows, runRows] = await Promise.all([
      listContentTasksDb({ limit: 100 }),
      listModelVisibilityRuns({ limit: 100 }),
    ]);
    setTasks(taskRows);
    setRuns(runRows);
    const normalRuns = runRows.filter((run) => (run.run_type || 'normal') === 'normal');
    const urlParentRunId = searchParams.get('parent_run_id') || '';
    setBeforeRunId((old) => old || normalRuns[0]?.id || '');
    setSelectedParentRunId((old) => {
      if (urlParentRunId && normalRuns.some((run) => run.id === urlParentRunId)) return urlParentRunId;
      if (old && normalRuns.some((run) => run.id === old)) return old;
      return '';
    });
  };

  const loadProfile = async (overrides: { runType?: string; parentRunId?: string; sourceProbeRunId?: string } = {}) => {
    setLoading(true);
    try {
      const parentRunId = overrides.parentRunId ?? selectedParentRunId;
      const sourceProbeRunId = overrides.sourceProbeRunId ?? selectedSourceProbeRunId;
      const data = await getSourcePreferences({
        parent_run_id: parentRunId || undefined,
        source_probe_run_id: sourceProbeRunId || undefined,
        project_name: projectName.trim() || undefined,
        domain: domain.trim() || undefined,
        question: question.trim() || undefined,
        model: model.trim() || undefined,
        provider: provider.trim() || undefined,
        run_type: parentRunId ? undefined : (overrides.runType ?? runType) || undefined,
        verification_status: verificationStatus || undefined,
        days,
      });
      setProfile(data);
      const effectiveProbeId = String((data.filters || {}).source_probe_run_id || '');
      if (effectiveProbeId) setSelectedSourceProbeRunId(effectiveProbeId);
      setPromptProfile(null);
      setReport(null);
    } catch (err: any) {
      MessagePlugin.error(`引用偏好读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSources();
    loadAuxiliary().catch((err: any) => {
      MessagePlugin.warning(`辅助数据读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    });
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadPrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, domain]);

  const applySource = (value: string) => {
    const source = sources.find((item) => item.id === value);
    setSelectedSourceId(value);
    if (!source) return;
    saveActiveProjectContext(source);
    setProjectName(source.project_name || '');
    setDomain(source.domain || '');
    MessagePlugin.success('已带入客户资产');
  };

  const openPromptDetail = async () => {
    if (!selectedPromptId) {
      MessagePlugin.warning('请先选择 Prompt');
      return;
    }
    setPromptLoading(true);
    setPromptDialogOpen(true);
    try {
      const data = await getPromptSourcePreferences(selectedPromptId, { days });
      setPromptProfile(data);
      setQuestion(String(data.prompt?.prompt || question || ''));
    } catch (err: any) {
      MessagePlugin.error(`Prompt 偏好读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setPromptLoading(false);
    }
  };

  const openGenerate = () => {
    if (!activePreference) {
      MessagePlugin.warning('请先刷新引用偏好');
      return;
    }
    setGenerateOpen(true);
    setSelectedTaskId((old) => old || String(tasks[0]?.id || ''));
  };

  const runSourceProbe = async () => {
    if (!selectedParentRunId) {
      MessagePlugin.warning('请先选择一条普通模型对比任务');
      return;
    }
    setActionLoading('sourceProbe');
    try {
      await createModelVisibilitySourceProbe(selectedParentRunId);
      MessagePlugin.success('来源采集任务完成，正在刷新偏好');
      setRunType('source_probe');
      setSelectedSourceProbeRunId('');
      await loadAuxiliary();
      await loadProfile({ parentRunId: selectedParentRunId });
    } catch (err: any) {
      MessagePlugin.error(`来源采集失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setActionLoading('');
    }
  };

  const changeParentRun = (value: string) => {
    const next = String(value || '');
    setSelectedParentRunId(next);
    setSelectedSourceProbeRunId('');
    if (next) {
      setSearchParams({ parent_run_id: next });
      const run = runs.find((item) => item.id === next);
      if (run) {
        setProjectName(run.project_name || '');
        setDomain(run.domain || '');
        setBeforeRunId(run.id);
      }
    } else {
      setSearchParams({});
    }
  };

  const changeSourceProbeRun = (value: string) => {
    const next = String(value || '');
    setSelectedSourceProbeRunId(next);
    if (selectedParentRunId) {
      setSearchParams(next ? { parent_run_id: selectedParentRunId, source_probe_run_id: next } : { parent_run_id: selectedParentRunId });
    }
    loadProfile({ parentRunId: selectedParentRunId, sourceProbeRunId: next });
  };

  const submitGenerate = async () => {
    if (!selectedTaskId) {
      MessagePlugin.warning('请选择写作任务');
      return;
    }
    setActionLoading('generate');
    try {
      const selectedPrompt = prompts.find((item) => item.id === selectedPromptId);
      const data = await createArticleGenerationRunDb({
        task_id: selectedTaskId,
        client_request_id: `source-pref-${Date.now()}`,
        source_prompt_id: selectedPromptId || undefined,
        source_prompt_text: selectedPrompt?.prompt || question || undefined,
        source_prompt_keyword: selectedPrompt?.keyword || undefined,
        source_prompt_intent: selectedPrompt?.intent || undefined,
        source_prompt_scenario: selectedPrompt?.scenario || undefined,
        prompt_text: selectedPrompt?.prompt || question || undefined,
        use_source_preference: usePreference === 'yes',
        source_preference_profile:
          usePreference === 'yes' ? (activePreference as unknown as Record<string, unknown>) : undefined,
        requested_count: 1,
      });
      setGenerateOpen(false);
      MessagePlugin.success(`文章生成任务已创建：${data.run_id}`);
    } catch (err: any) {
      MessagePlugin.error(`生成任务创建失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setActionLoading('');
    }
  };

  const openCampaign = () => {
    setCampaignOpen(true);
    setBeforeRunId((old) => old || runs[0]?.id || '');
  };

  const submitCampaign = async () => {
    if (!projectName.trim() && !domain.trim()) {
      MessagePlugin.warning('请先填写品牌或域名');
      return;
    }
    setActionLoading('campaign');
    try {
      const selectedPrompt = prompts.find((item) => item.id === selectedPromptId);
      const data = await createContentOptimizationCampaign({
        brand: projectName.trim() || domain.trim(),
        domain: domain.trim() || undefined,
        published_url: publishedUrl.trim() || undefined,
        target_prompts: [selectedPrompt?.prompt || question].filter(Boolean) as string[],
        target_keywords: [selectedPrompt?.keyword].filter(Boolean) as string[],
        before_run_id: beforeRunId || undefined,
      });
      const id = String(data.campaign?.id || '');
      setCampaignId(id);
      setCampaignOpen(false);
      MessagePlugin.success('复测任务已创建');
    } catch (err: any) {
      MessagePlugin.error(`复测任务创建失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setActionLoading('');
    }
  };

  const runRetest = async () => {
    if (!campaignId) {
      MessagePlugin.warning('请先创建复测任务');
      return;
    }
    setActionLoading('retest');
    try {
      const data = await retestContentOptimizationCampaign(campaignId);
      setReport(data.report as Record<string, any>);
      MessagePlugin.success('发布后复测完成');
    } catch (err: any) {
      MessagePlugin.error(`复测失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setActionLoading('');
    }
  };

  const loadReport = async () => {
    if (!campaignId) return;
    setActionLoading('report');
    try {
      const data = await getContentOptimizationReport(campaignId);
      setReport(data.report as Record<string, any>);
    } catch (err: any) {
      MessagePlugin.error(`复盘报告读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setActionLoading('');
    }
  };

  const loadTrend = async () => {
    if (!campaignId) return;
    setActionLoading('trend');
    try {
      const data = await getContentOptimizationTrend(campaignId);
      setTrend(data.trend || []);
    } catch (err: any) {
      MessagePlugin.error(`复测趋势读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setActionLoading('');
    }
  };

  const domainColumns: PrimaryTableCol<DistributionRow>[] = [
    {
      colKey: 'label',
      title: '来源域名 / 标题',
      width: 240,
      cell: ({ row }) => <strong>{row.label || row.key || '未知来源'}</strong>,
    },
    {
      colKey: 'count',
      title: '引用次数',
      width: 100,
      cell: ({ row }) => <span style={{ fontWeight: 700 }}>{row.count || 0}</span>,
    },
    {
      colKey: 'model_count',
      title: '模型数',
      width: 90,
      cell: ({ row }) => row.model_count || 0,
    },
    {
      colKey: 'question_count',
      title: '问题数',
      width: 90,
      cell: ({ row }) => row.question_count || 0,
    },
    {
      colKey: 'questions',
      title: '引用问题',
      ellipsis: true,
      cell: ({ row }) => ((row.questions || []) as string[]).slice(0, 3).join(' / ') || '--',
    },
  ];

  const metricCards = [
    ['AI 回答数', profile?.answer_count],
    ['显式来源回答', profile?.explicit_source_answer_count],
    ['无显式来源占比', summary.no_explicit_source_rate, '%'],
    ['来源总数', profile?.source_count],
    ['已画像文章', profile?.article_profile_count],
    ['已校验来源', profile?.verified_source_count],
    ['异常来源', profile?.suspected_source_count],
    ['品牌提及率', summary.brand_mention_rate, '%'],
    ['推荐率', summary.recommendation_rate, '%'],
    ['首推率', summary.first_rank_rate, '%'],
    ['前三率', summary.top3_rate, '%'],
  ];

  return (
    <div className={styles.page}>
      <Card className={styles.heroCard} bordered={false}>
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <div className={styles.toolbarRow}>
            <div>
              <div className={styles.heroTitle}>模型对比引用偏好分析</div>
              <div className={styles.heroDesc}>
                基于某次模型对比 Run 复用同一批问题和模型采集引用来源，再把来源偏好带入文章生成与发布后复测。
              </div>
            </div>
            <Space>
              <Button variant='outline' icon={<RefreshIcon />} loading={loading} onClick={() => loadProfile()}>
                刷新偏好
              </Button>
              <Button
                variant='outline'
                loading={actionLoading === 'sourceProbe'}
                onClick={runSourceProbe}
              >
                {selectedParentRun?.source_probe_count ? '重新采集引用来源' : '采集引用来源'}
              </Button>
              <Button theme='primary' icon={<SearchIcon />} onClick={openGenerate}>
                生成优化文章
              </Button>
              <Button variant='outline' onClick={openCampaign}>
                创建复测任务
              </Button>
            </Space>
          </div>
          <div className={styles.responsiveFormGrid}>
            <Select
              clearable
              filterable
              loading={loading}
              placeholder='选择模型对比任务'
              value={selectedParentRunId}
              options={normalRunOptions}
              onChange={(value) => changeParentRun(String(value || ''))}
            />
            <Select
              clearable
              filterable
              disabled={!selectedParentRunId}
              placeholder='来源采集批次'
              value={selectedSourceProbeRunId}
              options={sourceProbeRunOptions}
              onChange={(value) => changeSourceProbeRun(String(value || ''))}
            />
            <Select
              clearable
              filterable
              loading={loading}
              placeholder='选择客户资产'
              value={selectedSourceId}
              options={sourceOptions}
              onChange={(value) => applySource(String(value || ''))}
            />
            <Input placeholder='品牌' value={projectName} onChange={(value) => setProjectName(String(value))} />
            <Input placeholder='域名' value={domain} onChange={(value) => setDomain(String(value))} />
            <Select value={days} options={DAY_OPTIONS} onChange={(value) => setDays(Number(value) || 90)} />
            {!selectedParentRunId ? (
              <>
                <Select
                  clearable
                  filterable
                  placeholder='选择 Prompt'
                  value={selectedPromptId}
                  options={promptOptions}
                  onChange={(value) => setSelectedPromptId(String(value || ''))}
                />
                <Input
                  placeholder='Prompt / 问题关键词'
                  value={question}
                  onChange={(value) => setQuestion(String(value))}
                />
              </>
            ) : null}
            <Input placeholder='模型名' value={model} onChange={(value) => setModel(String(value))} />
            <Input placeholder='Provider' value={provider} onChange={(value) => setProvider(String(value))} />
            <Select
              clearable
              placeholder='任务类型'
              value={runType}
              disabled={Boolean(selectedParentRunId)}
              options={[
                { label: '全部任务', value: '' },
                { label: '来源采集', value: 'source_probe' },
                { label: '普通监测', value: 'normal' },
              ]}
              onChange={(value) => setRunType(String(value || ''))}
            />
            <Select
              clearable
              placeholder='来源校验状态'
              value={verificationStatus}
              options={[
                { label: '全部状态', value: '' },
                { label: '已校验', value: 'verified' },
                { label: '未校验', value: 'unverified' },
                { label: '不可访问', value: 'unreachable' },
                { label: '仅域名', value: 'domain_only' },
                { label: '仅标题', value: 'title_only' },
                { label: '疑似编造', value: 'suspected_hallucination' },
              ]}
              onChange={(value) => setVerificationStatus(String(value || ''))}
            />
          </div>
          <Space>
            <Button theme='primary' loading={loading} onClick={() => loadProfile()}>
              应用筛选
            </Button>
            {selectedParentRunId ? (
              <Tag theme='primary' variant='light'>
                当前按模型对比任务收口
              </Tag>
            ) : null}
            {!selectedParentRunId ? (
              <Button variant='outline' loading={promptLoading} onClick={openPromptDetail}>
                查看 Prompt 详情
              </Button>
            ) : null}
          </Space>
        </Space>
      </Card>

      <div className={styles.statsGrid}>
        {metricCards.map(([label, value, suffix]) => (
          <div className={styles.statCard} key={String(label)}>
            <div className={styles.statLabel}>{String(label)}</div>
            <div className={styles.statValue}>{suffix ? percentText(value) : metricText(value)}</div>
          </div>
        ))}
      </div>

      {profile?.parent_run ? (
        <Card className={styles.noticeCard} bordered={false}>
          <Space breakLine>
            <Tag theme='primary' variant='light'>
              基线模型对比
            </Tag>
            <span className={styles.subtleText}>
              {String((profile.parent_run as Record<string, unknown>).project_name || '--')} ·
              品牌提及率 {percentText(parentSummary.brand_mention_rate)} · 推荐率{' '}
              {percentText(parentSummary.recommendation_rate)} · 首推率 {percentText(parentSummary.first_rank_rate)} · 前三率{' '}
              {percentText(parentSummary.top3_rate)} · 域名引用率 {percentText(parentSummary.domain_mention_rate)}
            </span>
          </Space>
        </Card>
      ) : null}

      {profile?.no_explicit_source_answer_count && Number(summary.no_explicit_source_rate || 0) >= 60 ? (
        <Card className={styles.noticeCard} bordered={false}>
          <Tag theme='warning' variant='light'>
            无显式来源占比较高
          </Tag>
          <span className={styles.subtleText} style={{ marginLeft: 10 }}>
            当前样本中大量回答没有明确来源，建议继续积累更多模型回答或优先补齐可被引用的事实型内容。
            也可以使用“采集来源偏好”让模型显式输出参考来源。
          </span>
        </Card>
      ) : null}

      <Card className={styles.sectionCard} bordered={false}>
        <Tabs value={activeTab} onChange={(value) => setActiveTab(String(value))}>
          <TabPanel value='sources' label='来源偏好'>
            <div className={styles.gridAuto}>
              <div className={styles.surfaceInset}>
                <div className={styles.sectionHeader}>
                  <strong>来源类型分布</strong>
                </div>
                <Space breakLine>
                  {sourceTypes.length ? (
                    sourceTypes.map((item) => (
                      <Tag key={item.key} theme={sourceTypeTheme(item.key) as any} variant='light'>
                        {sourceTypeLabel(item.key)} · {item.count || 0}
                      </Tag>
                    ))
                  ) : (
                    <span className={styles.mutedText}>暂无来源类型数据</span>
                  )}
                </Space>
              </div>
              <div className={styles.surfaceInset}>
                <div className={styles.sectionHeader}>
                  <strong>内容补齐建议</strong>
                </div>
                <Space direction='vertical' size={8}>
                  {((recommendations.recommended_content_types || []) as string[]).slice(0, 4).map((item) => (
                    <div key={item} className={styles.subtleText}>
                      {item}
                    </div>
                  ))}
                  {!((recommendations.recommended_content_types || []) as string[]).length ? (
                    <span className={styles.mutedText}>暂无建议，先积累引用来源。</span>
                  ) : null}
                </Space>
              </div>
              <div className={styles.surfaceInset}>
                <div className={styles.sectionHeader}>
                  <strong>来源校验状态</strong>
                </div>
                <Space breakLine>
                  {sourceVerifications.length ? (
                    sourceVerifications.map((item) => (
                      <Tag key={item.key} theme={verificationStatusTheme(item.key) as any} variant='light'>
                        {verificationStatusLabel(item.key)} · {item.count || 0}
                      </Tag>
                    ))
                  ) : (
                    <span className={styles.mutedText}>暂无校验状态数据</span>
                  )}
                </Space>
              </div>
            </div>
            <div className={styles.tableScroll} style={{ marginTop: 12 }}>
              <Table
                rowKey='id'
                loading={loading}
                data={topDomains}
                columns={domainColumns}
                empty='暂无来源数据'
                pagination={{ pageSize: 8, total: topDomains.length }}
              />
            </div>
          </TabPanel>

          <TabPanel value='structure' label='文章结构'>
            <div className={styles.gridAuto}>
              <div className={styles.surfaceInset}>
                <strong>推荐结构</strong>
                <div style={{ marginTop: 10, lineHeight: 1.8 }}>
                  {String(recommendations.recommended_structure || '直接回答 → 判断清单 → 事实锚点 → 行动建议')}
                </div>
                <Space breakLine style={{ marginTop: 12 }}>
                  <Tag theme='primary' variant='light'>
                    {String(recommendations.preferred_article_type || '未形成稳定偏好')}
                  </Tag>
                  {Number(profile?.article_profile_count || 0) < 3 ? (
                    <Tag theme='warning' variant='light'>
                      结构偏好仅供参考
                    </Tag>
                  ) : null}
                </Space>
              </div>
              <div className={styles.surfaceInset}>
                <strong>高频结构特征</strong>
                <div className={styles.gridAuto} style={{ marginTop: 10 }}>
                  {[
                    ['平均标题数', averageStructure.heading_count],
                    ['平均列表数', averageStructure.list_count],
                    ['FAQ 出现', averageStructure.has_faq],
                    ['表格出现', averageStructure.has_table],
                    ['平均正文长度', averageStructure.body_length],
                    ['结构评分', averageStructure.structure_score],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <div className={styles.statLabel}>{String(label)}</div>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>{metricText(value)}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <Space direction='vertical' style={{ width: '100%', marginTop: 12 }}>
              {articleTypes.length ? (
                articleTypes.map((item) => (
                  <div className={styles.surfaceInset} key={item.key}>
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <strong>{item.label || item.key}</strong>
                      <Tag theme='primary' variant='light'>
                        {item.count || 0} 次
                      </Tag>
                    </Space>
                  </div>
                ))
              ) : (
                <div className={styles.emptyState}>暂无文章画像，来源文章抓取成功后会显示结构偏好。</div>
              )}
            </Space>
          </TabPanel>

          <TabPanel value='anchors' label='信任锚点'>
            <div className={styles.gridAuto}>
              {ANCHOR_LABELS.map((label) => {
                const item = trustAnchorRates[label] || {};
                const rate = safeNumber(item.rate) || 0;
                const theme = rate >= 50 ? 'success' : rate < 35 ? 'warning' : 'primary';
                return (
                  <div className={styles.surfaceInset} key={label}>
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <strong>{label}</strong>
                      <Tag theme={theme as any} variant='light'>
                        {rate >= 50 ? '优势项' : rate < 35 ? '缺口项' : '观察项'}
                      </Tag>
                    </Space>
                    <div style={{ marginTop: 10, fontSize: 24, fontWeight: 700 }}>{percentText(rate)}</div>
                    <div className={styles.mutedText}>
                      命中 {metricText(item.hit_count)} / {metricText(item.total)}
                    </div>
                    <div className={styles.subtleText} style={{ marginTop: 10, lineHeight: 1.7 }}>
                      {rate < 35 ? anchorSuggestion(label) : '保持事实密度，并继续用可核验材料支撑表达。'}
                    </div>
                  </div>
                );
              })}
            </div>
          </TabPanel>
        </Tabs>
      </Card>

      {campaignId || report ? (
        <Card className={styles.sectionCard} title='复盘报告' bordered={false}>
          <Space direction='vertical' size={12} style={{ width: '100%' }}>
            <Space>
              <Tag theme='primary' variant='light'>
                任务 {campaignId || '--'}
              </Tag>
              <Button size='small' loading={actionLoading === 'retest'} onClick={runRetest}>
                发布后复测
              </Button>
              <Button size='small' variant='outline' loading={actionLoading === 'report'} onClick={loadReport}>
                查看报告
              </Button>
              <Button size='small' variant='outline' loading={actionLoading === 'trend'} onClick={loadTrend}>
                多轮趋势
              </Button>
            </Space>
            {report ? (
              <>
                <Space breakLine>
                  <Tag theme='success' variant='light'>
                    {String(report.conclusion || '暂无结论')}
                  </Tag>
                  <Tag theme='default' variant='light'>
                    直接引用 {metricText(report.direct_citation_count)}
                  </Tag>
                  <Tag theme='default' variant='light'>
                    域名引用 {metricText(report.domain_citation_count)}
                  </Tag>
                </Space>
                <div className={styles.gridAuto}>
                  {((report.metric_changes || []) as Record<string, unknown>[]).map((item) => (
                    <div className={styles.surfaceInset} key={String(item.key)}>
                      <div className={styles.statLabel}>{String(item.key)}</div>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>
                        {metricText(item.before)} → {metricText(item.after)}
                      </div>
                      <div className={styles.subtleText}>变化 {metricText(item.absolute_change)}</div>
                    </div>
                  ))}
                </div>
                <div className={styles.subtleText}>
                  {String(report.causality_note || '指标变化不等于绝对因果证明。')}
                </div>
              </>
            ) : null}
            {trend.length ? (
              <div className={styles.tableScroll}>
                <Table
                  rowKey='id'
                  data={trend}
                  columns={[
                    {
                      colKey: 'created_at',
                      title: '复测时间',
                      width: 180,
                      cell: ({ row }) => new Date(String(row.created_at || '')).toLocaleString(),
                    },
                    { colKey: 'attribution_result', title: '归因结果', width: 160 },
                    {
                      colKey: 'brand_mention_rate',
                      title: '品牌提及率',
                      width: 120,
                      cell: ({ row }) => percentText(row.brand_mention_rate),
                    },
                    {
                      colKey: 'recommendation_rate',
                      title: '推荐率',
                      width: 100,
                      cell: ({ row }) => percentText(row.recommendation_rate),
                    },
                    {
                      colKey: 'first_rank_rate',
                      title: '首推率',
                      width: 100,
                      cell: ({ row }) => percentText(row.first_rank_rate),
                    },
                    {
                      colKey: 'top3_rate',
                      title: '前三率',
                      width: 100,
                      cell: ({ row }) => percentText(row.top3_rate),
                    },
                    {
                      colKey: 'direct_citation_count',
                      title: '直接引用',
                      width: 100,
                      cell: ({ row }) => metricText(row.direct_citation_count),
                    },
                    {
                      colKey: 'domain_citation_count',
                      title: '域名引用',
                      width: 100,
                      cell: ({ row }) => metricText(row.domain_citation_count),
                    },
                  ]}
                  pagination={{ pageSize: 5, total: trend.length }}
                />
              </div>
            ) : null}
          </Space>
        </Card>
      ) : null}

      <Dialog
        visible={promptDialogOpen}
        header='Prompt 引用偏好详情'
        width={760}
        footer={false}
        onClose={() => setPromptDialogOpen(false)}
      >
        {promptLoading ? (
          <div className={styles.emptyState}>正在读取 Prompt 偏好...</div>
        ) : promptProfile ? (
          <Space direction='vertical' size={12} style={{ width: '100%' }}>
            <div className={styles.surfaceInset}>
              <strong>{String(promptProfile.prompt?.prompt || 'Prompt')}</strong>
              <div className={styles.subtleText} style={{ marginTop: 8 }}>
                关键词：{String(promptProfile.prompt?.keyword || '--')} · 意图：
                {String(promptProfile.prompt?.intent || '--')}
              </div>
            </div>
            <div className={styles.statsGrid}>
              {[
                ['品牌提及率', promptProfile.summary?.brand_mention_rate, '%'],
                ['推荐率', promptProfile.summary?.recommendation_rate, '%'],
                ['首推率', promptProfile.summary?.first_rank_rate, '%'],
                ['前三率', promptProfile.summary?.top3_rate, '%'],
                ['竞品提及率', promptProfile.summary?.competitor_mention_rate, '%'],
              ].map(([label, value, suffix]) => (
                <div className={styles.statCard} key={String(label)}>
                  <div className={styles.statLabel}>{String(label)}</div>
                  <div className={styles.statValue}>{suffix ? percentText(value) : metricText(value)}</div>
                </div>
              ))}
            </div>
            <div className={styles.surfaceInset}>
              <strong>建议结构</strong>
              <div style={{ marginTop: 8 }}>{String(promptProfile.recommendations?.recommended_structure || '--')}</div>
            </div>
            <Space>
              <Button theme='primary' onClick={openGenerate}>
                生成优化文章
              </Button>
              <Button variant='outline' onClick={() => setPromptDialogOpen(false)}>
                关闭
              </Button>
            </Space>
          </Space>
        ) : (
          <div className={styles.emptyState}>暂无 Prompt 偏好数据</div>
        )}
      </Dialog>

      <Dialog
        visible={generateOpen}
        header='生成优化文章'
        onClose={() => setGenerateOpen(false)}
        onCancel={() => setGenerateOpen(false)}
        onConfirm={submitGenerate}
        confirmBtn={{ content: '创建生成任务', loading: actionLoading === 'generate' }}
      >
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <Select
            filterable
            placeholder='选择写作任务'
            value={selectedTaskId}
            options={taskOptions}
            onChange={(value) => setSelectedTaskId(String(value || ''))}
          />
          <Select
            value={usePreference}
            options={[
              { label: '使用 AI 引用偏好', value: 'yes' },
              { label: '不使用引用偏好', value: 'no' },
            ]}
            onChange={(value) => setUsePreference(String(value))}
          />
          <div className={styles.surfaceInset}>
            <div className={styles.statLabel}>将带入的推荐结构</div>
            <div style={{ marginTop: 8 }}>{String(recommendations.recommended_structure || '--')}</div>
          </div>
        </Space>
      </Dialog>

      <Dialog
        visible={campaignOpen}
        header='创建内容优化复测任务'
        onClose={() => setCampaignOpen(false)}
        onCancel={() => setCampaignOpen(false)}
        onConfirm={submitCampaign}
        confirmBtn={{ content: '创建任务', loading: actionLoading === 'campaign' }}
      >
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <Input
            placeholder='发布 URL，可稍后补充'
            value={publishedUrl}
            onChange={(value) => setPublishedUrl(String(value))}
          />
          <Select
            filterable
            placeholder='选择发布前监测 run'
            value={beforeRunId}
            options={runOptions}
            onChange={(value) => setBeforeRunId(String(value || ''))}
          />
          {!publishedUrl.trim() ? (
            <Tag theme='warning' variant='light'>
              发布 URL 为空时无法判断直接引用效果
            </Tag>
          ) : null}
          {!beforeRunId ? (
            <Tag theme='warning' variant='light'>
              没有发布前 run 时，建议先执行基线监测
            </Tag>
          ) : null}
        </Space>
      </Dialog>
    </div>
  );
};

export default SourcePreferences;
