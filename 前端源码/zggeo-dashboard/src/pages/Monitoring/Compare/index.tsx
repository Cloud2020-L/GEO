import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Input,
  MessagePlugin,
  PrimaryTableCol,
  Select,
  Space,
  Table,
  Tag,
  Textarea,
} from 'tdesign-react';
import { CheckCircleFilledIcon, CloseCircleFilledIcon, RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import {
  createModelVisibilityRun,
  createModelVisibilitySourceProbe,
  deleteModelVisibilityRun,
  getModelVisibilityRun,
  KeywordPromptItem,
  listKeywordPrompts,
  listModelProviders,
  listModelVisibilityRuns,
  ModelProviderRow,
  ModelVisibilityResult,
  ModelVisibilityRun,
  ModelVisibilityRunResponse,
} from 'services/zggeo-api';
import {
  buildProjectSourceOptions,
  getActiveProjectContext,
  loadProjectSources,
  ProjectContext,
  saveActiveProjectContext,
} from 'utils/projectContext';
import styles from '../linear.module.less';

const DEFAULT_QUESTIONS = `这个品牌是做什么的？
它适合哪些客户？
如果我要选择相关服务，你会推荐它吗？`;

const sourceSearchText = (source: ProjectContext) =>
  [
    source.origin,
    source.project_name,
    source.domain,
    source.description,
    source.keywords.join(' '),
    source.competitors.join(' '),
    source.urls.join(' '),
  ]
    .join(' ')
    .toLowerCase();

const buildQuestions = (source: ProjectContext) => {
  const brand = source.project_name || source.domain || '这个品牌';
  const keywords = source.keywords.slice(0, 5);
  const base = [
    `${brand}是做什么的？`,
    `${brand}适合哪些客户？`,
    `如果我要选择${keywords[0] || '相关服务'}，你会推荐${brand}吗？`,
  ];
  const keywordQuestions = keywords.slice(1, 4).map((keyword) => `${keyword}有哪些值得推荐的品牌或服务商？`);
  return [...base, ...keywordQuestions].join('\n');
};

const leadIdFromSource = (sourceId: string) => (sourceId.startsWith('lead:') ? sourceId.slice(5) : undefined);

const metricText = (value: number | null | undefined, suffix = '%') =>
  value === null || value === undefined ? '-' : `${value}${suffix}`;

const resultKey = (row: ModelVisibilityResult) => row.id || `${row.provider}-${row.question}`;

const Compare: React.FC = () => {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ModelProviderRow[]>([]);
  const [sources, setSources] = useState<ProjectContext[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [domain, setDomain] = useState('');
  const [competitors, setCompetitors] = useState('');
  const [questions, setQuestions] = useState(DEFAULT_QUESTIONS);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [runs, setRuns] = useState<ModelVisibilityRun[]>([]);
  const [current, setCurrent] = useState<ModelVisibilityRunResponse | null>(null);
  const [promptInventory, setPromptInventory] = useState<KeywordPromptItem[]>([]);
  const [selectedPromptIds, setSelectedPromptIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState('');
  const [sourceProbeRunId, setSourceProbeRunId] = useState('');
  const [expandedAnswerKeys, setExpandedAnswerKeys] = useState<string[]>([]);
  const [resultsCollapsed, setResultsCollapsed] = useState(false);

  const configuredProviders = useMemo(() => providers.filter((provider) => provider.configured), [providers]);

  const sourceOptions = useMemo(
    () =>
      buildProjectSourceOptions(sources).map((option) => {
        const source = sources.find((item) => item.id === option.value);
        return {
          ...option,
          searchText: source ? sourceSearchText(source) : String(option.label || '').toLowerCase(),
        };
      }),
    [sources],
  );

  const providerOptions = useMemo(
    () =>
      configuredProviders.map((provider) => ({
        label: provider.name,
        value: provider.key,
      })),
    [configuredProviders],
  );

  const selectedPromptItems = useMemo(
    () => promptInventory.filter((item) => selectedPromptIds.includes(item.id)),
    [promptInventory, selectedPromptIds],
  );

  const loadProviders = async () => {
    const data = await listModelProviders();
    setProviders(data.providers);
    const configured = data.providers.filter((provider) => provider.configured).map((provider) => provider.key);
    setSelectedProviders((old) =>
      old.length > 0 ? old.filter((key) => configured.includes(key)) : configured.slice(0, 4),
    );
  };

  const loadSources = async () => {
    setSourceLoading(true);
    try {
      let nextSources = await loadProjectSources();
      const active = getActiveProjectContext();
      if (active) nextSources = [active, ...nextSources.filter((item) => item.id !== active.id)];
      setSources(nextSources);
    } catch (err: any) {
      MessagePlugin.error(`客户资产读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setSourceLoading(false);
    }
  };

  const loadRuns = async () => {
    const data = await listModelVisibilityRuns({ limit: 30 });
    setRuns(data);
  };

  const loadPromptInventory = async (source?: ProjectContext) => {
    const sourceId = source?.id || selectedSourceId;
    const leadId = leadIdFromSource(sourceId);
    const brandName = source?.project_name || projectName;
    const sourceDomain = source?.domain || domain;
    if (!leadId && !brandName.trim() && !sourceDomain.trim()) {
      setPromptInventory([]);
      setSelectedPromptIds([]);
      return;
    }
    setPromptLoading(true);
    try {
      const cleanDomain = sourceDomain.trim();
      const data = await listKeywordPrompts({
        lead_id: leadId,
        brand_name: leadId || cleanDomain ? undefined : brandName.trim(),
        domain: cleanDomain || undefined,
        limit: 120,
      });
      const items = data.items || [];
      setPromptInventory(items);
      setSelectedPromptIds((old) => old.filter((id) => items.some((item) => item.id === id)));
    } catch (err: any) {
      MessagePlugin.error(`Prompt库存读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setPromptLoading(false);
    }
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      await Promise.all([loadProviders(), loadSources(), loadRuns()]);
    } catch (err: any) {
      MessagePlugin.error(`数据读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const applySource = (source: ProjectContext) => {
    setSelectedSourceId(source.id);
    setProjectName(source.project_name || source.domain || '');
    setDomain(source.domain || '');
    setCompetitors(source.competitors.join('\n'));
    setQuestions(buildQuestions(source));
    setSelectedPromptIds([]);
    saveActiveProjectContext(source);
    loadPromptInventory(source);
    MessagePlugin.success('已带入客户资产信息');
  };

  const selectAllProviders = () => {
    setSelectedProviders(configuredProviders.map((provider) => provider.key));
  };

  const clearProviders = () => {
    setSelectedProviders([]);
  };

  const togglePrompt = (promptId: string) => {
    setSelectedPromptIds((old) => (old.includes(promptId) ? old.filter((id) => id !== promptId) : [...old, promptId]));
  };

  const selectAllPrompts = () => {
    setSelectedPromptIds(promptInventory.map((item) => item.id));
  };

  const clearPromptSelection = () => {
    setSelectedPromptIds([]);
  };

  const promptLines = () => selectedPromptItems.map((item) => item.prompt.trim()).filter(Boolean);

  const appendSelectedPrompts = () => {
    const nextPrompts = promptLines();
    if (nextPrompts.length === 0) {
      MessagePlugin.warning('请先选择 Prompt库存中的问题');
      return;
    }
    const existing = questions
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
    const seen = new Set(existing.map((item) => item.toLowerCase()));
    const merged = [...existing];
    nextPrompts.forEach((prompt) => {
      const key = prompt.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(prompt);
      }
    });
    setQuestions(merged.join('\n'));
    MessagePlugin.success(`已追加 ${nextPrompts.length} 条 Prompt`);
  };

  const replaceWithSelectedPrompts = () => {
    const nextPrompts = promptLines();
    if (nextPrompts.length === 0) {
      MessagePlugin.warning('请先选择 Prompt库存中的问题');
      return;
    }
    setQuestions(nextPrompts.join('\n'));
    MessagePlugin.success(`已用 ${nextPrompts.length} 条 Prompt 覆盖监测问题`);
  };

  const runVisibility = async () => {
    if (!projectName.trim()) {
      MessagePlugin.warning('请先选择客户资产或填写品牌/项目');
      return;
    }
    if (selectedProviders.length === 0) {
      MessagePlugin.warning('请至少选择一个已配置模型');
      return;
    }
    const questionList = questions
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
    if (questionList.length === 0) {
      MessagePlugin.warning('请填写至少一个用户问题');
      return;
    }

    setRunning(true);
    try {
      const data = await createModelVisibilityRun({
        lead_id: leadIdFromSource(selectedSourceId),
        project_name: projectName.trim(),
        domain: domain.trim(),
        competitors: competitors
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        questions: questionList,
        providers: selectedProviders,
      });
      setCurrent(data);
      setExpandedAnswerKeys([]);
      setResultsCollapsed(false);
      await loadRuns();
      MessagePlugin.success('AI 可见度监测完成并已入库');
    } catch (err: any) {
      MessagePlugin.error(`AI 可见度监测失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setRunning(false);
    }
  };

  const openRun = async (runId: string) => {
    setLoading(true);
    try {
      const data = await getModelVisibilityRun(runId);
      setCurrent(data);
      setExpandedAnswerKeys([]);
      setResultsCollapsed(false);
    } catch (err: any) {
      MessagePlugin.error(`历史结果读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoading(false);
    }
  };

  const deleteRun = async (row: ModelVisibilityRun) => {
    if (!window.confirm(`确认删除「${row.project_name}」这次历史监测记录？删除后不可恢复。`)) return;
    setDeletingRunId(row.id);
    try {
      await deleteModelVisibilityRun(row.id);
      setRuns((old) => old.filter((item) => item.id !== row.id));
      if (current?.run.id === row.id) setCurrent(null);
      MessagePlugin.success('已删除历史监测记录');
    } catch (err: any) {
      MessagePlugin.error(`删除失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setDeletingRunId('');
    }
  };

  const collectSourceProbe = async (run: ModelVisibilityRun) => {
    if ((run.run_type || 'normal') !== 'normal') {
      MessagePlugin.warning('请基于普通模型对比结果采集引用来源');
      return;
    }
    setSourceProbeRunId(run.id);
    try {
      await createModelVisibilitySourceProbe(run.id);
      await loadRuns();
      if (current?.run.id === run.id) {
        const nextCurrent = await getModelVisibilityRun(run.id);
        setCurrent(nextCurrent);
      }
      MessagePlugin.success('引用来源采集完成，可查看引用偏好');
    } catch (err: any) {
      MessagePlugin.error(`引用来源采集失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setSourceProbeRunId('');
    }
  };

  const viewSourcePreferences = (run: ModelVisibilityRun) => {
    const parentRunId = run.run_type === 'source_probe' && run.parent_run_id ? run.parent_run_id : run.id;
    navigate(`/visibility-monitoring/source-preferences?parent_run_id=${parentRunId}`);
  };

  const summary = current?.run.summary;
  const currentResults = current?.results || [];

  const toggleAnswer = (key: string) => {
    setExpandedAnswerKeys((old) => (old.includes(key) ? old.filter((item) => item !== key) : [...old, key]));
  };

  const expandAllAnswers = () => {
    setExpandedAnswerKeys(currentResults.map(resultKey));
  };

  const collapseAllAnswers = () => {
    setExpandedAnswerKeys([]);
  };

  const resultColumns: PrimaryTableCol<ModelVisibilityResult>[] = [
    {
      colKey: 'provider_name',
      title: '模型',
      width: 220,
      cell: ({ row }) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.provider_name || row.provider}</div>
          <div style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)' }}>{row.model}</div>
        </div>
      ),
    },
    {
      colKey: 'question',
      title: '用户问题',
      width: 260,
    },
    {
      colKey: 'metrics',
      title: '可见度判断',
      width: 260,
      cell: ({ row }) => (
        <Space breakLine size={6}>
          <Tag theme={row.brand_mentioned ? 'success' : 'danger'} variant='light'>
            品牌{row.brand_mentioned ? '已提及' : '未提及'}
          </Tag>
          <Tag theme={row.recommended ? 'success' : 'default'} variant='light'>
            {row.recommended ? '有推荐倾向' : '未推荐'}
          </Tag>
          <Tag theme={row.domain_mentioned ? 'primary' : 'default'} variant='light'>
            域名{row.domain_mentioned ? '已引用' : '未引用'}
          </Tag>
          {row.brand_rank ? (
            <Tag theme='warning' variant='light'>
              排名 {row.brand_rank}
            </Tag>
          ) : null}
        </Space>
      ),
    },
    {
      colKey: 'answer',
      title: '模型回答',
      ellipsis: true,
      cell: ({ row }) => (
        <div className={styles.answerCell}>
          <div className={expandedAnswerKeys.includes(resultKey(row)) ? styles.answerExpanded : styles.answerCollapsed}>
            {row.answer || row.error || '暂无回答'}
          </div>
          {(row.answer || row.error || '').length > 120 ? (
            <Button size='small' variant='text' theme='primary' onClick={() => toggleAnswer(resultKey(row))}>
              {expandedAnswerKeys.includes(resultKey(row)) ? '收起' : '展开'}
            </Button>
          ) : null}
        </div>
      ),
    },
    {
      colKey: 'score',
      title: '分数',
      width: 90,
      cell: ({ row }) => <span style={{ color: '#6366F1', fontWeight: 700 }}>{row.score || 0}</span>,
    },
  ];

  const runColumns: PrimaryTableCol<ModelVisibilityRun>[] = [
    {
      colKey: 'created_at',
      title: '监测时间',
      width: 180,
      cell: ({ row }) => new Date(row.created_at).toLocaleString(),
    },
    {
      colKey: 'project_name',
      title: '客户 / 域名',
      width: 220,
      cell: ({ row }) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.project_name}</div>
          <div style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)' }}>{row.domain || '-'}</div>
        </div>
      ),
    },
    {
      colKey: 'summary',
      title: '核心指标',
      cell: ({ row }) => (
        <Space breakLine size={6}>
          <Tag theme={row.run_type === 'source_probe' ? 'warning' : 'primary'} variant='light'>
            {row.run_type === 'source_probe' ? '来源采集' : '普通监测'}
          </Tag>
          <Tag theme='success' variant='light'>
            提及率 {metricText(row.summary?.brand_mention_rate)}
          </Tag>
          <Tag theme='warning' variant='light'>
            推荐率 {metricText(row.summary?.recommendation_rate)}
          </Tag>
          <Tag theme='primary' variant='light'>
            域名率 {metricText(row.summary?.domain_mention_rate)}
          </Tag>
          <Tag variant='light'>平均排名 {metricText(row.summary?.average_rank, '')}</Tag>
        </Space>
      ),
    },
    {
      colKey: 'action',
      title: '操作',
      width: 260,
      cell: ({ row }) => (
        <Space size={8}>
          <Button variant='text' theme='primary' onClick={() => openRun(row.id)}>
            查看
          </Button>
          {(row.run_type || 'normal') === 'normal' ? (
            <Button
              variant='text'
              theme='primary'
              loading={sourceProbeRunId === row.id}
              onClick={() => collectSourceProbe(row)}
            >
              {Number(row.source_probe_count || 0) > 0 ? '重新采集' : '采集来源'}
            </Button>
          ) : null}
          <Button variant='text' theme='primary' onClick={() => viewSourcePreferences(row)}>
            引用偏好
          </Button>
          <Button variant='text' theme='danger' loading={deletingRunId === row.id} onClick={() => deleteRun(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className={styles.page}>
      <Card bordered={false} className={styles.heroCard}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#f8fafc', marginBottom: 6 }}>AI 可见度持久化监测</div>
            <div style={{ color: 'var(--td-text-color-secondary)', fontSize: 13, lineHeight: 1.7 }}>
              对同一批客户问题调用多个模型，保存品牌提及率、推荐率、域名引用率和平均排名，用于判断客户现在在 AI
              回答里是否被看见。
            </div>
          </div>
          <Button icon={<RefreshIcon />} loading={loading} onClick={loadAll}>
            刷新
          </Button>
        </div>
      </Card>

      <Card bordered={false} title='创建一次可见度监测' className={styles.sectionCard}>
        <div style={{ display: 'grid', gap: 12 }}>
          <Space className={styles.responsiveToolbar} style={{ width: '100%' }} align='center'>
            <Select
              value={selectedSourceId}
              options={sourceOptions}
              loading={sourceLoading}
              clearable
              filterable
              prefixIcon={<SearchIcon />}
              placeholder='选择客户资产；可输入品牌、公司、域名、关键词搜索'
              style={{ flex: 1 }}
              empty='暂无客户资产'
              filter={(filterWords, option: any) => {
                const keyword = String(filterWords || '')
                  .trim()
                  .toLowerCase();
                if (!keyword) return true;
                return String(option?.searchText || option?.label || '')
                  .toLowerCase()
                  .includes(keyword);
              }}
              onChange={(value) => {
                const id = String(value || '');
                setSelectedSourceId(id);
                const source = sources.find((item) => item.id === id);
                if (source) applySource(source);
              }}
            />
            <Button variant='outline' loading={sourceLoading} onClick={loadSources}>
              刷新客户资产
            </Button>
          </Space>

          <div className={styles.responsiveFormGrid}>
            <Input label='品牌' value={projectName} onChange={(value) => setProjectName(String(value))} />
            <Input label='官网域名' value={domain} onChange={(value) => setDomain(String(value))} />
            <Input
              label='竞品'
              value={competitors.replace(/\n/g, '、')}
              onChange={(value) =>
                setCompetitors(
                  String(value)
                    .split(/[、,，]/)
                    .join('\n'),
                )
              }
            />
          </div>

          <div>
            <div className={styles.sectionHeader}>
              <span style={{ fontWeight: 600 }}>选择模型</span>
              <Space>
                <Button size='small' variant='outline' icon={<CheckCircleFilledIcon />} onClick={selectAllProviders}>
                  一键勾选
                </Button>
                <Button size='small' variant='outline' icon={<CloseCircleFilledIcon />} onClick={clearProviders}>
                  取消勾选
                </Button>
              </Space>
            </div>
            <Space breakLine>
              {providerOptions.map((option) => {
                const active = selectedProviders.includes(String(option.value));
                return (
                  <Button
                    key={String(option.value)}
                    size='small'
                    theme={active ? 'primary' : 'default'}
                    variant={active ? 'base' : 'outline'}
                    onClick={() => {
                      const key = String(option.value);
                      setSelectedProviders((old) =>
                        old.includes(key) ? old.filter((item) => item !== key) : [...old, key],
                      );
                    }}
                  >
                    {option.label}
                  </Button>
                );
              })}
              {providerOptions.length === 0 && (
                <Tag theme='warning' variant='light'>
                  暂无已配置模型
                </Tag>
              )}
            </Space>
          </div>

          <div>
            <div className={styles.sectionHeader}>
              <div>
                <span style={{ fontWeight: 600 }}>从 Prompt库存选择监测问题</span>
                <Tag theme='primary' variant='light' style={{ marginLeft: 8 }}>
                  已选 {selectedPromptIds.length} 条
                </Tag>
              </div>
              <Space>
                <Button size='small' variant='outline' loading={promptLoading} onClick={() => loadPromptInventory()}>
                  刷新库存
                </Button>
                <Button
                  size='small'
                  variant='outline'
                  disabled={promptInventory.length === 0 || selectedPromptIds.length === promptInventory.length}
                  onClick={selectAllPrompts}
                >
                  全选
                </Button>
                <Button
                  size='small'
                  variant='outline'
                  disabled={selectedPromptIds.length === 0}
                  onClick={clearPromptSelection}
                >
                  清空选择
                </Button>
                <Button
                  size='small'
                  variant='outline'
                  disabled={selectedPromptIds.length === 0}
                  onClick={appendSelectedPrompts}
                >
                  追加到问题
                </Button>
                <Button
                  size='small'
                  theme='primary'
                  disabled={selectedPromptIds.length === 0}
                  onClick={replaceWithSelectedPrompts}
                >
                  覆盖问题
                </Button>
              </Space>
            </div>
            <div
              style={{
                display: 'grid',
                gap: 8,
                maxHeight: 210,
                overflow: 'auto',
                padding: 10,
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              {promptInventory.length > 0 ? (
                promptInventory.map((item) => {
                  const active = selectedPromptIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type='button'
                      onClick={() => togglePrompt(item.id)}
                      style={{
                        textAlign: 'left',
                        border: `1px solid ${active ? '#6366F1' : 'rgba(255,255,255,0.08)'}`,
                        background: active ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.03)',
                        color: '#e5e7eb',
                        borderRadius: 8,
                        padding: '10px 12px',
                        cursor: 'pointer',
                        lineHeight: 1.6,
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{item.prompt}</div>
                      <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {item.keyword ? (
                          <Tag size='small' variant='light'>
                            {item.keyword}
                          </Tag>
                        ) : null}
                        <Tag size='small' theme='primary' variant='light'>
                          {item.intent || 'AI问答'}
                        </Tag>
                        {item.scenario ? (
                          <Tag size='small' variant='light'>
                            {item.scenario}
                          </Tag>
                        ) : null}
                      </div>
                    </button>
                  );
                })
              ) : (
                <div style={{ color: 'var(--td-text-color-secondary)', fontSize: 13, padding: 8 }}>
                  {selectedSourceId || projectName
                    ? '当前客户暂无 Prompt库存；可先到“目标关键词系统 / Prompt库存”生成并入库。'
                    : '请先选择客户资产，系统会读取该客户已入库的 Prompt。'}
                </div>
              )}
            </div>
          </div>

          <Textarea
            label='监测问题'
            autosize={{ minRows: 5, maxRows: 8 }}
            value={questions}
            onChange={(value) => setQuestions(String(value))}
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button theme='primary' loading={running} onClick={runVisibility}>
              开始监测并入库
            </Button>
          </div>
        </div>
      </Card>

      <div className={styles.statsGrid}>
        <MetricCard label='品牌提及率' value={metricText(summary?.brand_mention_rate)} color='#10B981' />
        <MetricCard label='推荐率' value={metricText(summary?.recommendation_rate)} color='#F59E0B' />
        <MetricCard label='域名引用率' value={metricText(summary?.domain_mention_rate)} color='#6366F1' />
        <MetricCard label='平均排名' value={metricText(summary?.average_rank, '')} color='#3B82F6' />
      </div>

      <Card bordered={false} className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc' }}>本次 / 历史监测结果</div>
          <Space size={8}>
            {current?.run ? (
              <>
                {(current.run.run_type || 'normal') === 'normal' ? (
                  <Button
                    size='small'
                    variant='outline'
                    loading={sourceProbeRunId === current.run.id}
                    onClick={() => collectSourceProbe(current.run)}
                  >
                    {Number(current.run.source_probe_count || 0) > 0 ? '重新采集引用来源' : '采集引用来源'}
                  </Button>
                ) : null}
                <Button size='small' variant='outline' onClick={() => viewSourcePreferences(current.run)}>
                  查看引用偏好
                </Button>
              </>
            ) : null}
            <Button size='small' variant='outline' onClick={() => setResultsCollapsed((value) => !value)}>
              {resultsCollapsed ? '展开结果' : '收起结果'}
            </Button>
            {!resultsCollapsed ? (
              <>
                <Button
                  size='small'
                  variant='outline'
                  disabled={currentResults.length === 0}
                  onClick={expandAllAnswers}
                >
                  全部展开回答
                </Button>
                <Button
                  size='small'
                  variant='outline'
                  disabled={expandedAnswerKeys.length === 0}
                  onClick={collapseAllAnswers}
                >
                  全部收起回答
                </Button>
              </>
            ) : null}
          </Space>
        </div>
        {resultsCollapsed ? (
          <div className={styles.surfaceInset}>
            <span className={styles.mutedText}>结果表已收起，共 {currentResults.length} 条监测结果。</span>
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <Table
              data={currentResults}
              columns={resultColumns}
              rowKey='id'
              size='medium'
              hover
              stripe
              empty='暂无本次结果，请先运行一次监测或从历史记录查看'
            />
          </div>
        )}
      </Card>

      <Card bordered={false} title='历史监测记录' className={styles.sectionCard}>
        <div className={styles.tableScroll}>
          <Table
            data={runs}
            columns={runColumns}
            rowKey='id'
            size='medium'
            hover
            stripe
            loading={loading}
            empty='暂无历史记录'
          />
        </div>
      </Card>
    </div>
  );
};

const MetricCard: React.FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <Card bordered={false} className={styles.statCard}>
    <div className={styles.statLabel}>{label}</div>
    <div className={styles.statValue} style={{ color }}>
      {value}
    </div>
  </Card>
);

export default Compare;
