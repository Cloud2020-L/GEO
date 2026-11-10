import React, { useEffect, useMemo, useState } from 'react';
import { Card, Tag, Button, Space, MessagePlugin, Select } from 'tdesign-react';
import {
  createQuestionSummary,
  listQuestionGeoReports,
  listQuestionSummaries,
  listModelVisibilityRuns,
  listModelProviders,
  ModelProviderRow,
} from 'services/zggeo-api';
import {
  buildProjectSourceOptions,
  getActiveProjectContext,
  loadProjectSources,
  normalizeDomain,
  ProjectContext,
  saveActiveProjectContext,
} from 'utils/projectContext';
import styles from '../linear.module.less';

/**
 * 问题库 AI 总结
 * 汇总 GEO 报告与模型可见度报告，生成后续问题机会和优化建议。
 */

const sourceLeadId = (source?: ProjectContext | null) => (source?.id?.startsWith('lead:') ? source.id.slice(5) : '');

const sameText = (a?: unknown, b?: unknown) => String(a || '').trim() === String(b || '').trim();

const reportBelongsToSource = (report: Record<string, unknown>, source?: ProjectContext | null) => {
  if (!source) return true;
  const leadId = sourceLeadId(source);
  const reportLeadId = String(report.lead_id || '').trim();
  if (leadId && reportLeadId) return leadId === reportLeadId;

  const sourceDomain = normalizeDomain(source.domain || '');
  const reportDomain = normalizeDomain(String(report.domain || ''));
  const sourceName = source.project_name || source.domain;
  const reportName = report.project_name;
  return Boolean(sourceDomain && reportDomain && sourceDomain === reportDomain && sameText(reportName, sourceName));
};

const Questions: React.FC = () => {
  const [sources, setSources] = useState<ProjectContext[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  const [geoReports, setGeoReports] = useState<Record<string, unknown>[]>([]);
  const [modelReports, setModelReports] = useState<Record<string, unknown>[]>([]);
  const [summaryReports, setSummaryReports] = useState<Record<string, unknown>[]>([]);
  const [selectedGeoReportId, setSelectedGeoReportId] = useState('');
  const [selectedModelReportId, setSelectedModelReportId] = useState('');
  const [currentSummary, setCurrentSummary] = useState<Record<string, any> | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [providers, setProviders] = useState<ModelProviderRow[]>([]);
  const [providerLoading, setProviderLoading] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState('');

  const sourceOptions = useMemo(() => buildProjectSourceOptions(sources), [sources]);
  const selectedSource = useMemo(
    () => sources.find((item) => item.id === selectedSourceId) || getActiveProjectContext(),
    [sources, selectedSourceId],
  );

  const geoReportOptions = useMemo(
    () =>
      geoReports.map((item) => ({
        label: `${String(item.title || 'GEO报告')} · ${
          item.created_at ? new Date(String(item.created_at)).toLocaleString() : ''
        }`,
        value: String(item.id || ''),
      })),
    [geoReports],
  );

  const modelReportOptions = useMemo(
    () =>
      modelReports.map((item) => {
        const summary = (item.summary_json || item.summary || {}) as Record<string, unknown>;
        return {
          label: `模型对比 · 平均分 ${String(summary.average_score ?? '-')} · ${
            item.created_at ? new Date(String(item.created_at)).toLocaleString() : ''
          }`,
          value: String(item.id || ''),
        };
      }),
    [modelReports],
  );

  const providerOptions = useMemo(
    () => [
      { label: '默认模型', value: '' },
      ...providers
        .filter((provider) => provider.configured)
        .map((provider) => ({
          label: provider.model ? `${provider.name} · ${provider.model}` : provider.name,
          value: provider.key,
        })),
    ],
    [providers],
  );

  const loadProviders = async () => {
    setProviderLoading(true);
    try {
      const data = await listModelProviders();
      setProviders(data.providers);
      const configured = data.providers.filter((provider) => provider.configured);
      setSelectedProvider((old) => old || configured[0]?.key || '');
    } catch (err: any) {
      MessagePlugin.warning(`模型列表读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setProviderLoading(false);
    }
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
    } finally {
      setSourceLoading(false);
    }
  };

  useEffect(() => {
    loadSources();
    loadProviders();
  }, []);

  const loadReportRecords = async (source?: ProjectContext | null) => {
    const target = source || selectedSource;
    const domain = normalizeDomain(target?.domain || '');
    setReportLoading(true);
    try {
      const params = domain ? { domain, limit: 50 } : { limit: 50 };
      const [nextGeoReports, allModelRuns, nextSummaries] = await Promise.all([
        listQuestionGeoReports(params),
        listModelVisibilityRuns({ limit: 100 }),
        listQuestionSummaries(params),
      ]);
      const matchedGeoReports = nextGeoReports.filter((item) => reportBelongsToSource(item, target));
      const matchedModelReports = allModelRuns.filter((item) =>
        reportBelongsToSource(item as unknown as Record<string, unknown>, target),
      );
      const matchedSummaries = nextSummaries.filter((item) => reportBelongsToSource(item, target));
      setGeoReports(matchedGeoReports);
      setModelReports(matchedModelReports as unknown as Record<string, unknown>[]);
      setSummaryReports(matchedSummaries);
      setSelectedGeoReportId((old) =>
        matchedGeoReports.some((item) => String(item.id || '') === old) ? old : String(matchedGeoReports[0]?.id || ''),
      );
      setSelectedModelReportId((old) =>
        matchedModelReports.some((item) => String(item.id || '') === old)
          ? old
          : String(matchedModelReports[0]?.id || ''),
      );
      setCurrentSummary((matchedSummaries[0]?.summary_json as Record<string, any>) || null);
    } catch (err: any) {
      MessagePlugin.error(`报告记录读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setReportLoading(false);
    }
  };

  const fillProject = (source: ProjectContext) => {
    setSelectedSourceId(source.id);
    saveActiveProjectContext(source);
    setSelectedGeoReportId('');
    setSelectedModelReportId('');
    setCurrentSummary(null);
    loadReportRecords(source);
  };

  useEffect(() => {
    const active = getActiveProjectContext();
    if (active) {
      setSelectedSourceId(active.id);
      loadReportRecords(active);
    } else {
      loadReportRecords(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGenerateSummary = async () => {
    const source = selectedSource;
    if (!source) {
      MessagePlugin.warning('请先选择资产');
      return;
    }
    if (!selectedGeoReportId && !selectedModelReportId) {
      MessagePlugin.warning('请至少选择一份 GEO 报告或模型对比报告');
      return;
    }
    setSummaryLoading(true);
    try {
      const data = await createQuestionSummary({
        asset: {
          id: source.id,
          lead_id: source.id.startsWith('lead:') ? source.id.slice(5) : undefined,
          origin: source.origin,
          project_name: source.project_name,
          domain: normalizeDomain(source.domain),
          description: source.description,
          keywords: source.keywords,
          competitors: source.competitors,
          urls: source.urls,
          notes: source.notes,
        },
        geo_report_id: selectedGeoReportId || null,
        model_report_id: selectedModelReportId || null,
        provider: selectedProvider || null,
      });
      setCurrentSummary((data.summary || null) as Record<string, any> | null);
      MessagePlugin.success('问题总结已生成并保存到数据库');
      await loadReportRecords(source);
    } catch (err: any) {
      MessagePlugin.error(`生成失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setSummaryLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <Card bordered={false} className={styles.sectionCard}>
        <Space direction='vertical' size={16} style={{ width: '100%' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>问题库 AI 总结</div>
            <div style={{ color: 'var(--td-text-color-secondary)', marginTop: 4, lineHeight: 1.7 }}>
              选择资产，再选择该资产在 GEO监测系统导出的报告和模型对比报告，生成问题总结与下一步建议；总结结果会保存到
              PostgreSQL。
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(220px, 1fr))', gap: 12 }}>
            <Select
              value={selectedSourceId}
              options={sourceOptions}
              loading={sourceLoading}
              filterable
              placeholder='选择资产'
              onChange={(v) => {
                const source = sources.find((item) => item.id === String(v || ''));
                if (source) fillProject(source);
              }}
            />
            <Select
              value={selectedGeoReportId}
              options={geoReportOptions}
              loading={reportLoading}
              clearable
              placeholder='选择 GEO监测系统导出的报告'
              empty='暂无 GEO 报告，请先去 GEO监测系统NEW 导出报告'
              onChange={(v) => setSelectedGeoReportId(String(v || ''))}
            />
            <Select
              value={selectedModelReportId}
              options={modelReportOptions}
              loading={reportLoading}
              clearable
              placeholder='选择模型对比报告'
              empty='暂无模型对比报告，请先运行模型对比NEW'
              onChange={(v) => setSelectedModelReportId(String(v || ''))}
            />
            <Select
              value={selectedProvider}
              options={providerOptions}
              loading={providerLoading}
              filterable
              placeholder='选择 AI 总结模型'
              empty='暂无已配置模型'
              onChange={(v) => setSelectedProvider(String(v || ''))}
            />
          </div>
          <Space>
            <Button variant='outline' loading={reportLoading} onClick={() => loadReportRecords(selectedSource)}>
              刷新报告记录
            </Button>
            <Button theme='primary' loading={summaryLoading} onClick={handleGenerateSummary}>
              AI 总结生成问题总结 + 下一步建议
            </Button>
          </Space>
          {currentSummary && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(220px, 1fr))', gap: 12 }}>
              <SummaryPanel title='问题总结' items={(currentSummary.summary || []) as string[]} />
              <SummaryPanel title='核心问题' items={(currentSummary.core_issues || []) as string[]} />
              <SummaryPanel title='下一步建议' items={(currentSummary.next_actions || []) as string[]} />
            </div>
          )}
          {currentSummary?.question_opportunities && (
            <div style={{ padding: 14, borderRadius: 12, background: 'var(--td-bg-color-container-hover)' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>建议纳入问题库测试的问题</div>
              <Space size={8} style={{ flexWrap: 'wrap' }}>
                {((currentSummary.question_opportunities || []) as string[]).map((item) => (
                  <Tag key={item} theme='primary' variant='light'>
                    {item}
                  </Tag>
                ))}
              </Space>
            </div>
          )}
          {summaryReports.length > 0 && (
            <div style={{ color: 'var(--td-text-color-secondary)', fontSize: 12 }}>
              当前资产已有 {summaryReports.length} 条历史总结，默认展示最新一条。
            </div>
          )}
        </Space>
      </Card>
    </div>
  );
};

const SummaryPanel: React.FC<{ title: string; items: string[] }> = ({ title, items }) => (
  <div style={{ padding: 14, borderRadius: 12, background: 'var(--td-bg-color-container-hover)', minHeight: 140 }}>
    <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
    {items.length === 0 ? (
      <div style={{ color: 'var(--td-text-color-placeholder)' }}>暂无</div>
    ) : (
      <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ol>
    )}
  </div>
);

export default Questions;
