import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Input, MessagePlugin, Select, Space, Tag, Textarea } from 'tdesign-react';
import {
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  InfoCircleFilledIcon,
  LockOnIcon,
  RefreshIcon,
  ThunderIcon,
} from 'tdesign-icons-react';
import {
  listModelProviders,
  ModelProviderRow,
  ModelTestResponse,
  runModelRegression,
  testModelProvider,
} from 'services/zggeo-api';
import {
  buildProjectSourceOptions,
  getActiveProjectContext,
  loadProjectSources,
  ProjectContext,
  saveActiveProjectContext,
} from 'utils/projectContext';
import styles from '../linear.module.less';

const STATUS_CFG: Record<string, { label: string; color: string; icon: React.ReactElement }> = {
  configured: { label: '已配置', color: '#10B981', icon: <CheckCircleFilledIcon /> },
  unconfigured: { label: '未配置', color: '#EF4444', icon: <ThunderIcon /> },
  planned: { label: '待适配', color: '#94A3B8', icon: <LockOnIcon /> },
};

const DIMENSIONS = [
  { key: 'visibility', label: '可见度', color: '#6366F1', desc: '品牌在回答中被提及的频次与位置', weight: 0.3 },
  { key: 'content', label: '内容覆盖', color: '#EF4444', desc: '关键问题是否被完整覆盖', weight: 0.28 },
  { key: 'structure', label: '结构化', color: '#10B981', desc: '回答的段落 / 列表 / 引用结构', weight: 0.22 },
  { key: 'trust', label: '信任度', color: '#F59E0B', desc: '引用权威来源 / 一致性 / 避免幻觉', weight: 0.2 },
];

const DEFAULT_QUESTIONS = `这个品牌是做什么的？
它适合哪些客户？
如果我要做 GEO / AI 搜索优化，你会推荐它吗？`;

const buildSourceSearchText = (source: ProjectContext) =>
  [
    source.origin,
    source.project_name,
    source.domain,
    source.description,
    source.keywords.join(' '),
    source.competitors.join(' '),
    source.urls.join(' '),
    source.notes || '',
  ]
    .join(' ')
    .toLowerCase();

const buildRegressionQuestions = (source: ProjectContext) => {
  const brand = source.project_name || source.domain || '这个品牌';
  const mainKeyword = source.keywords[0] || 'GEO / AI 搜索优化';
  return `${brand}是做什么的？
${brand}适合哪些客户？
如果我要做 ${mainKeyword}，你会推荐${brand}吗？`;
};

const Calibration: React.FC = () => {
  const [providers, setProviders] = useState<ModelProviderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState('');
  const [tests, setTests] = useState<Record<string, ModelTestResponse>>({});
  const [projectName, setProjectName] = useState('ZGEO 智改');
  const [domain, setDomain] = useState('example.com');
  const [questions, setQuestions] = useState(DEFAULT_QUESTIONS);
  const [selected, setSelected] = useState<string[]>([]);
  const [regressionLoading, setRegressionLoading] = useState(false);
  const [regression, setRegression] = useState<Record<string, any> | null>(null);
  const [sources, setSources] = useState<ProjectContext[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);

  const sourceOptions = useMemo(
    () =>
      buildProjectSourceOptions(sources).map((option) => {
        const source = sources.find((item) => item.id === option.value);
        return {
          ...option,
          searchText: source ? buildSourceSearchText(source) : String(option.label || '').toLowerCase(),
        };
      }),
    [sources],
  );

  const fetchProviders = async () => {
    setLoading(true);
    try {
      const data = await listModelProviders();
      setProviders(data.providers);
      const configured = data.providers.filter((item) => item.configured).map((item) => item.key);
      setSelected((old) =>
        old.length > 0 ? old.filter((key) => data.providers.some((p) => p.key === key)) : configured,
      );
    } catch (err: any) {
      MessagePlugin.error(`模型网关读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoading(false);
    }
  };

  const applyProjectSource = (source: ProjectContext) => {
    setSelectedSourceId(source.id);
    setProjectName(source.project_name || source.domain || '');
    setDomain(source.domain || '');
    setQuestions(buildRegressionQuestions(source));
    saveActiveProjectContext(source);
    MessagePlugin.success('已带入客户资产信息');
  };

  const loadSources = async () => {
    setSourceLoading(true);
    try {
      let nextSources = await loadProjectSources();
      const active = getActiveProjectContext();
      if (active) {
        nextSources = [active, ...nextSources.filter((item) => item.id !== active.id)];
      }
      setSources(nextSources);
    } catch (err: any) {
      MessagePlugin.error(`客户资产读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setSourceLoading(false);
    }
  };

  useEffect(() => {
    fetchProviders();
  }, []);
  useEffect(() => {
    loadSources();
  }, []);

  const stats = useMemo(() => {
    const configured = providers.filter((m) => m.configured).length;
    const unconfigured = providers.filter((m) => m.status === 'unconfigured').length;
    const planned = providers.filter((m) => m.status === 'planned').length;
    return { total: providers.length, configured, unconfigured, planned };
  }, [providers]);

  const configuredProviderKeys = useMemo(() => providers.filter((m) => m.configured).map((m) => m.key), [providers]);

  const toggleProvider = (key: string) => {
    setSelected((old) => (old.includes(key) ? old.filter((item) => item !== key) : [...old, key]));
  };

  const selectAllConfigured = () => {
    setSelected(configuredProviderKeys);
  };

  const clearSelectedProviders = () => {
    setSelected([]);
  };

  const handleTest = async (key: string) => {
    setTesting(key);
    try {
      const result = await testModelProvider(key);
      setTests((old) => ({ ...old, [key]: result }));
      if (result.ok) MessagePlugin.success(`${result.name} 探活成功`);
      else MessagePlugin.warning(result.message || `${result.name} 暂不可用`);
    } catch (err: any) {
      MessagePlugin.error(`探活失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setTesting('');
    }
  };

  const handleRegression = async () => {
    const providerKeys = selected.filter((key) => providers.find((p) => p.key === key)?.configured);
    if (!projectName.trim()) {
      MessagePlugin.warning('请填写项目 / 品牌名');
      return;
    }
    if (providerKeys.length === 0) {
      MessagePlugin.warning('请先配置并选择至少一个可调用模型');
      return;
    }
    setRegressionLoading(true);
    try {
      const data = await runModelRegression({
        project_name: projectName.trim(),
        domain: domain.trim(),
        questions: questions
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        providers: providerKeys,
      });
      setRegression(data);
      MessagePlugin.success('模型回归完成');
    } catch (err: any) {
      MessagePlugin.error(`模型回归失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setRegressionLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <Card bordered={false} className={styles.heroCard}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 8,
              background: 'rgba(94, 106, 210, 0.18)',
              color: '#a5b4fc',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
            }}
          >
            <InfoCircleFilledIcon />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#f8fafc', marginBottom: 4 }}>ZGEO 模型网关</div>
            <div style={{ fontSize: 13, color: 'var(--td-text-color-secondary)', lineHeight: 1.7 }}>
              后端统一通过 /models/providers、/models/test、/models/generate、/models/regression 管理大模型。
              以后新增模型只需要补环境变量和一个 adapter，不再每个页面重复接。
            </div>
          </div>
          <Button icon={<RefreshIcon />} loading={loading} onClick={fetchProviders}>
            刷新模型
          </Button>
        </div>
      </Card>

      <div className={styles.statsGrid}>
        <StatCell label='模型总数' value={`${stats.total}`} hint='网关登记' color='#6366F1' />
        <StatCell label='已配置' value={`${stats.configured}`} hint='可探活调用' color='#10B981' />
        <StatCell label='未配置' value={`${stats.unconfigured}`} hint='缺 API Key/模型 ID' color='#EF4444' />
        <StatCell label='待适配' value={`${stats.planned}`} hint='P2 原生接口' color='#94A3B8' />
      </div>

      <Card bordered={false} className={styles.sectionCard}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>综合评分 · 4 维权重</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {DIMENSIONS.map((d) => (
            <div key={d.key} className={styles.dimensionRow}>
              <div style={{ minWidth: 80, fontWeight: 600, color: d.color }}>{d.label}</div>
              <div
                style={{
                  flex: 1,
                  height: 14,
                  background: 'rgba(255,255,255,0.08)',
                  borderRadius: 7,
                  overflow: 'hidden',
                }}
              >
                <div style={{ width: `${d.weight * 100}%`, height: '100%', background: d.color }} />
              </div>
              <div style={{ width: 60, textAlign: 'right', fontWeight: 600, color: d.color }}>
                {(d.weight * 100).toFixed(0)}%
              </div>
              <div style={{ flex: 2, fontSize: 12, color: 'var(--td-text-color-secondary)' }}>{d.desc}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card bordered={false} title='模型接入状态' className={styles.sectionCard}>
        <div style={{ display: 'grid', gap: 8 }}>
          <div className={styles.sectionHeader} style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>
              已选择 {selected.length} / {configuredProviderKeys.length} 个可调用模型
            </div>
            <Space>
              <Button
                size='small'
                variant='outline'
                icon={<CheckCircleFilledIcon />}
                disabled={configuredProviderKeys.length === 0 || selected.length === configuredProviderKeys.length}
                onClick={selectAllConfigured}
              >
                一键勾选
              </Button>
              <Button
                size='small'
                variant='outline'
                icon={<CloseCircleFilledIcon />}
                disabled={selected.length === 0}
                onClick={clearSelectedProviders}
              >
                取消勾选
              </Button>
            </Space>
          </div>
          {providers.map((m) => {
            const s = STATUS_CFG[m.status] || STATUS_CFG.unconfigured;
            const test = tests[m.key];
            return (
              <div key={m.key} className={styles.providerRow}>
                <input
                  type='checkbox'
                  checked={selected.includes(m.key)}
                  disabled={!m.configured}
                  onChange={() => toggleProvider(m.key)}
                  aria-label={`选择 ${m.name}`}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>
                    {m.vendor} · 权重 {(m.weight * 100).toFixed(0)}%
                  </div>
                </div>
                <div
                  className={styles.providerEndpoint}
                  style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--td-text-color-secondary)' }}
                >
                  {m.endpoint}
                </div>
                <Tag
                  size='small'
                  variant='light'
                  style={{ background: `${s.color}22`, color: s.color, border: 'none' }}
                  icon={s.icon}
                >
                  {s.label}
                </Tag>
                <div className={styles.truncateText}>
                  <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>{m.note}</div>
                  {test && (
                    <div style={{ fontSize: 11, color: test.ok ? '#059669' : '#DC2626', marginTop: 4 }}>
                      探活：{test.ok ? '成功' : '失败'}
                      {test.latency_ms ? ` · ${test.latency_ms}ms` : ''} · {test.message}
                    </div>
                  )}
                </div>
                <Space>
                  <Tag size='small' theme='primary' variant='light'>
                    {m.dim}
                  </Tag>
                  <Button
                    size='small'
                    variant='outline'
                    disabled={!m.testable}
                    loading={testing === m.key}
                    onClick={() => handleTest(m.key)}
                  >
                    测试
                  </Button>
                </Space>
              </div>
            );
          })}
          {providers.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--td-text-color-placeholder)' }}>
              暂无模型配置，请确认后端 /models/providers 是否已上线
            </div>
          )}
        </div>
      </Card>

      <Card bordered={false} title='运行一次品牌模型回归' className={styles.sectionCard}>
        <div style={{ marginBottom: 12 }}>
          <Space className={styles.responsiveToolbar} style={{ width: '100%' }} align='center'>
            <Select
              value={selectedSourceId}
              options={sourceOptions}
              loading={sourceLoading}
              clearable
              filterable
              placeholder='选择客户资产 / 品牌池；可输入品牌、公司、域名、关键词搜索'
              style={{ flex: 1 }}
              empty='暂无客户资产，请先到客户资产中新建'
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
                if (source) applyProjectSource(source);
              }}
            />
            <Button variant='outline' loading={sourceLoading} onClick={loadSources}>
              刷新客户资产
            </Button>
          </Space>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--td-text-color-secondary)' }}>
            选择后会自动填入品牌、官网域名，并按监测关键词生成回归问题；仍可手动修改。
          </div>
        </div>
        <div className={styles.responsiveFormGrid}>
          <Input label='品牌' value={projectName} onChange={(v) => setProjectName(String(v))} />
          <Input label='域名' value={domain} onChange={(v) => setDomain(String(v))} />
          <Textarea autosize={{ minRows: 3, maxRows: 5 }} value={questions} onChange={(v) => setQuestions(String(v))} />
          <Button theme='primary' loading={regressionLoading} onClick={handleRegression}>
            开始回归
          </Button>
        </div>

        {regression && (
          <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
            <Space>
              <Tag theme='primary' variant='light'>
                平均分：{regression.summary?.average_score ?? 0}
              </Tag>
              <Tag theme='success' variant='light'>
                品牌提及率：{regression.summary?.brand_mention_rate ?? 0}%
              </Tag>
              <Tag theme='warning' variant='light'>
                域名提及率：{regression.summary?.domain_mention_rate ?? 0}%
              </Tag>
              <Tag theme='default' variant='light'>
                成功：{regression.summary?.success_runs ?? 0} / {regression.summary?.total_runs ?? 0}
              </Tag>
            </Space>
            <div style={{ display: 'grid', gap: 8 }}>
              {(regression.results || []).slice(0, 8).map((row: any, index: number) => (
                <div
                  key={`${row.provider}-${row.question}-${index}`}
                  className={styles.surfaceInset}
                  style={{ padding: 12, borderRadius: 12 }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                    <Tag theme={row.status === 'success' ? 'success' : 'danger'} variant='light'>
                      {row.provider_name || row.provider}
                    </Tag>
                    <span style={{ fontWeight: 600 }}>{row.question}</span>
                    <span style={{ marginLeft: 'auto', color: '#6366F1', fontWeight: 600 }}>评分 {row.score ?? 0}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', lineHeight: 1.7 }}>
                    {row.answer || row.error || '暂无回答'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

const StatCell: React.FC<{ label: string; value: string; hint: string; color: string }> = ({
  label,
  value,
  hint,
  color,
}) => (
  <Card bordered={false} className={styles.statCard}>
    <div className={styles.statLabel}>{label}</div>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
      <span className={styles.statValue} style={{ fontSize: 32, marginTop: 0, color, lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)' }}>{hint}</span>
    </div>
  </Card>
);

export default Calibration;
