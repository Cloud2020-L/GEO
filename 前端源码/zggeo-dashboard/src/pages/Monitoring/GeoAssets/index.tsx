import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Col,
  Divider,
  Input,
  MessagePlugin,
  Progress,
  Row,
  Select,
  Space,
  Tag,
  Textarea,
} from 'tdesign-react';
import { FileCopyIcon, RefreshIcon } from 'tdesign-icons-react';
import {
  analyzeGeoSitemap,
  auditGeoAssets,
  auditTechnicalGeoSeo,
  generateLlmsTxt,
  generateLlmsFullTxt,
  generateSchemaJsonld,
  generateDeploymentPackage,
  getBrandVisibility,
  GeoAssetRequest,
  monitorGeoDrift,
  listDriftSchedules,
  listDriftSnapshots,
  scanBrandSources,
  compareGeoCompetitors,
  configureDriftSchedule,
  downloadDeploymentPackageArchive,
  exportCustomerReport,
  listTasks,
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
import { scopedStorageKey } from 'utils/scopedStorage';
import styles from '../linear.module.less';

const stringify = (value: unknown) => JSON.stringify(value, null, 2);

const GEO_NEW_BASE_PATH = '/visibility-monitoring/geo-assets-new';

const deploymentPackageErrorMessage = (err: any) => {
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;
  if (status === 404) return '未找到可用诊断报告，请先完成基础诊断';
  if (status === 403) return '当前账号无权使用该诊断报告生成部署包';
  if (status === 500) return '部署包生成失败，请稍后重试或联系运营';
  if (typeof detail === 'string' && detail.trim()) return detail;
  return err?.message || '未知错误';
};

const GEO_NEW_SECTIONS = [
  { key: 'import', path: `${GEO_NEW_BASE_PATH}/import`, label: '导入资料' },
  { key: 'base', path: `${GEO_NEW_BASE_PATH}/base`, label: '生成基础资料' },
  { key: 'audit', path: `${GEO_NEW_BASE_PATH}/audit`, label: '体检与抓取' },
  { key: 'competitors', path: `${GEO_NEW_BASE_PATH}/competitors`, label: '竞品对比' },
  { key: 'report', path: `${GEO_NEW_BASE_PATH}/report`, label: '导出报告' },
  { key: 'deployment', path: `${GEO_NEW_BASE_PATH}/deployment`, label: '生成部署包' },
  { key: 'monitoring', path: `${GEO_NEW_BASE_PATH}/monitoring`, label: '持久监控' },
] as const;

type GeoNewSectionKey = (typeof GEO_NEW_SECTIONS)[number]['key'];

const SCHEMA_OPTIONS = [
  { label: '企业 / 组织', value: 'Organization' },
  { label: '专业服务机构', value: 'ProfessionalService' },
  { label: '本地商家 / 门店', value: 'LocalBusiness' },
];

const statusText = (status: string) => {
  const map: Record<string, string> = {
    found: '已找到',
    search_ready: '可搜索',
    missing: '未找到',
    unreachable: '不可达',
    unknown: '未知',
    partial: '部分完成',
    completed: '已完成',
    none: '无变化',
    weekly: '每周',
    enabled: '已启用',
    disabled: '已暂停',
    sitemap: '站点地图',
    sitemap_xml: '站点地图',
    homepage_links: '首页内链',
    robots_txt: 'robots 声明',
  };
  return map[status] || status || '未知';
};

const isLikelyDomain = (value: string) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(normalizeDomain(value));

const leadIdFromSource = (sourceId: string) => (sourceId.startsWith('lead:') ? sourceId.slice(5) : undefined);

const normalizeCompetitorDomains = (values: string[]) =>
  Array.from(new Set(values.map((item) => normalizeDomain(item)).filter((item) => item && isLikelyDomain(item))));

const FieldRow: React.FC<{
  label: string;
  help?: string;
  children: React.ReactNode;
}> = ({ label, help, children }) => (
  <div style={{ marginBottom: 18 }}>
    <div
      style={{
        marginBottom: 8,
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--td-text-color-primary)',
      }}
    >
      {label}
    </div>
    {children}
    {help && (
      <div style={{ marginTop: 6, color: 'var(--td-text-color-placeholder)', fontSize: 12, lineHeight: 1.6 }}>
        {help}
      </div>
    )}
  </div>
);

const StepTitle: React.FC<{ no: string; title: string; desc?: string }> = ({ no, title, desc }) => (
  <Space size={10} align='center' breakLine>
    <Tag theme='primary' variant='light'>
      {no}
    </Tag>
    <span>{title}</span>
    {desc && (
      <span
        style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', fontWeight: 400, overflowWrap: 'anywhere' }}
      >
        {desc}
      </span>
    )}
  </Space>
);

const GEO_STEPS = [
  { no: '01', title: '导入资料', desc: '选择客户资产或品牌池，确认品牌名、域名、关键词、核心页面。' },
  { no: '02', title: '生成基础资产', desc: '生成 llms.txt、llms-full.txt 和 Schema JSON-LD。' },
  { no: '03', title: '体检与抓取', desc: '检查 GEO 资产、技术 SEO/GEO、sitemap 和公开品牌源。' },
  { no: '04', title: '生成部署包', desc: '汇总 P0/P1 清单、可复制代码和 robots AI 爬虫策略。' },
  { no: '05', title: '导出报告', desc: '把结果整理成客户可查看、可打印的交付报告。' },
];

const GeoAssets: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const isGeoNew = location.pathname.startsWith(GEO_NEW_BASE_PATH);
  const pathSection = location.pathname.replace(GEO_NEW_BASE_PATH, '').split('/').filter(Boolean)[0] as
    | GeoNewSectionKey
    | undefined;
  const activeSection: GeoNewSectionKey | 'all' = isGeoNew
    ? GEO_NEW_SECTIONS.some((item) => item.key === pathSection)
      ? (pathSection as GeoNewSectionKey)
      : 'import'
    : 'all';
  const showSection = (section: GeoNewSectionKey) => activeSection === 'all' || activeSection === section;

  const [projectName, setProjectName] = useState('ZGEO 智改');
  const [domain, setDomain] = useState('example.com');
  const [description, setDescription] = useState('ZGEO 提供企业官网 GEO 评分、AI 搜索优化、品牌可见性监控和转化报告。');
  const [keywords, setKeywords] = useState('GEO\nAI搜索优化\n生成引擎优化\n品牌可见性');
  const [urls, setUrls] = useState(
    'https://example.com/\nhttps://example.com/product\nhttps://example.com/cases\nhttps://example.com/contact',
  );
  const [schemaType, setSchemaType] = useState('Organization');
  const [competitors, setCompetitors] = useState('');
  const [sources, setSources] = useState<ProjectContext[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);

  const [llmsTxt, setLlmsTxt] = useState('');
  const [llmsFullTxt, setLlmsFullTxt] = useState('');
  const [schemaJson, setSchemaJson] = useState('');
  const [visibility, setVisibility] = useState<Record<string, any> | null>(null);
  const [assetAudit, setAssetAudit] = useState<Record<string, any> | null>(null);
  const [technicalAudit, setTechnicalAudit] = useState<Record<string, any> | null>(null);
  const [sitemapAudit, setSitemapAudit] = useState<Record<string, any> | null>(null);
  const [driftAudit, setDriftAudit] = useState<Record<string, any> | null>(null);
  const [deploymentPackage, setDeploymentPackage] = useState<Record<string, any> | null>(null);
  const [brandSources, setBrandSources] = useState<Record<string, any> | null>(null);
  const [competitorCompare, setCompetitorCompare] = useState<Record<string, any> | null>(null);
  const [driftSchedule, setDriftSchedule] = useState<Record<string, any> | null>(null);
  const [driftHistory, setDriftHistory] = useState<Record<string, any>[]>([]);
  const [exportedReport, setExportedReport] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState('');

  const sourceOptions = useMemo(() => buildProjectSourceOptions(sources), [sources]);
  const reportStorageKey = useMemo(() => {
    const safeDomain = normalizeDomain(domain) || 'default';
    return scopedStorageKey(`example.com-report.v1.${safeDomain}`);
  }, [domain]);
  const competitorStorageKey = useMemo(() => {
    const safeDomain = normalizeDomain(domain) || 'default';
    return scopedStorageKey(`example.com-compare.v1.${safeDomain}`);
  }, [domain]);

  const sourceToGeoForm = (source: ProjectContext) => {
    const domainValue = normalizeDomain(source.domain);
    const nameValue = source.project_name || domainValue;
    const urlsValue = source.urls.length > 0 ? source.urls : defaultUrlsFor(domainValue);
    const keywordsValue = source.keywords.length > 0 ? source.keywords : defaultKeywordsFor(nameValue);

    return {
      projectName: nameValue,
      domain: domainValue,
      description: source.description || defaultDescriptionFor(nameValue, source.notes),
      keywords: keywordsValue.join('\n'),
      urls: urlsValue.join('\n'),
      competitors: normalizeCompetitorDomains(source.competitors).join('\n'),
      urlsValue,
      keywordsValue,
    };
  };

  const applyProjectSource = (source: ProjectContext, options?: { silent?: boolean }) => {
    const nextForm = sourceToGeoForm(source);

    setSelectedSourceId(source.id);
    setProjectName(nextForm.projectName);
    setDomain(nextForm.domain);
    setDescription(nextForm.description);
    setKeywords(nextForm.keywords);
    setUrls(nextForm.urls);
    setCompetitors(nextForm.competitors);
    saveActiveProjectContext({
      ...source,
      project_name: nextForm.projectName,
      domain: nextForm.domain,
      description: nextForm.description,
      keywords: nextForm.keywordsValue,
      urls: nextForm.urlsValue,
    });
    if (nextForm.domain) {
      loadDriftState(nextForm.domain);
    }

    if (!options?.silent) {
      if (!nextForm.domain) {
        MessagePlugin.warning('这条资料还缺官网域名，已先带入项目和关键词，请补一下域名');
      } else {
        MessagePlugin.success('已带入项目、域名、关键词、竞品、核心页面和描述');
      }
    }
  };

  const findSourceBySelectValue = (value: unknown, context?: any) => {
    const rawCandidates = [
      Array.isArray(value) ? value[0] : value,
      context?.value,
      context?.selectedOptions?.[0]?.value,
      context?.selectedOption?.value,
      context?.option?.value,
      context?.selectedOptions?.[0]?.label,
      context?.selectedOption?.label,
      context?.option?.label,
    ]
      .filter((item) => item !== undefined && item !== null)
      .map((item) => (typeof item === 'object' ? (item as any).value || (item as any).label : item))
      .map((item) => String(item || '').trim())
      .filter(Boolean);

    const matched = rawCandidates
      .map((raw) => {
        const exact = sources.find((item) => item.id === raw);
        if (exact) return exact;

        const labelLike = raw.toLowerCase();
        return sources.find(
          (item) =>
            (!!item.project_name && labelLike.includes(item.project_name.toLowerCase())) ||
            (!!item.domain && labelLike.includes(item.domain.toLowerCase())) ||
            (!!item.id && labelLike.includes(item.id.toLowerCase())),
        );
      })
      .find(Boolean);

    return matched || null;
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
      if (preferred) applyProjectSource(preferred, { silent: true });
    } catch (err: any) {
      MessagePlugin.warning(`项目资料读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setSourceLoading(false);
    }
  };

  const loadDriftState = async (targetDomain?: string) => {
    const normalized = normalizeDomain(targetDomain || domain);
    if (!normalized) return;
    try {
      const [schedules, snapshots] = await Promise.all([
        listDriftSchedules(),
        listDriftSnapshots({ domain: normalized, limit: 20 }),
      ]);
      const matchedSchedule = schedules.find((item) => String(item.domain || '').includes(normalized));
      setDriftSchedule(matchedSchedule ? { schedule: matchedSchedule } : null);
      setDriftHistory(snapshots);
    } catch (err: any) {
      MessagePlugin.warning(`漂移监控记录读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    }
  };

  useEffect(() => {
    loadSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const cached = window.localStorage.getItem(reportStorageKey);
      setExportedReport(cached ? JSON.parse(cached) : null);
    } catch {
      setExportedReport(null);
    }
  }, [reportStorageKey]);

  useEffect(() => {
    try {
      const cached = window.localStorage.getItem(competitorStorageKey);
      setCompetitorCompare(cached ? JSON.parse(cached) : null);
    } catch {
      setCompetitorCompare(null);
    }
  }, [competitorStorageKey]);

  const handleSourceChange = (value: unknown, context?: any) => {
    const source = findSourceBySelectValue(value, context);
    if (!source) {
      setSelectedSourceId(String(value || ''));
      MessagePlugin.warning('没有找到这条项目资料，请点“刷新资料”后再试');
      return;
    }
    applyProjectSource(source);
  };

  const applySelectedSource = () => {
    const source = findSourceBySelectValue(selectedSourceId) || sources[0];
    if (!source) {
      MessagePlugin.warning('暂无可带入资料，请先刷新资料');
      return;
    }
    applyProjectSource(source);
  };

  const buildPayload = (): GeoAssetRequest => ({
    project_name: projectName.trim(),
    domain: normalizeDomain(domain),
    description: description.trim(),
    keywords: parseList(keywords),
    urls: parseList(urls),
    schema_type: schemaType,
  });

  const validate = () => {
    if (!projectName.trim()) {
      MessagePlugin.warning('请填写项目名');
      return false;
    }
    const normalized = normalizeDomain(domain);
    if (!normalized) {
      MessagePlugin.warning('请填写域名');
      return false;
    }
    saveActiveProjectContext({
      id: 'geo-assets-form:latest',
      origin: '最近使用',
      project_name: projectName.trim(),
      domain: normalized,
      description: description.trim(),
      keywords: parseList(keywords),
      competitors: parseList(competitors),
      urls: parseList(urls).length > 0 ? parseList(urls) : defaultUrlsFor(normalized),
    });
    return true;
  };

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    MessagePlugin.success(`已复制${label}`);
  };

  const handleLlms = async () => {
    if (!validate()) return;
    setLoading('llms');
    try {
      const data = await generateLlmsTxt(buildPayload());
      setLlmsTxt(String(data.content || ''));
      MessagePlugin.success('llms.txt 已生成');
    } catch (err: any) {
      MessagePlugin.error(`生成失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleSchema = async () => {
    if (!validate()) return;
    setLoading('schema');
    try {
      const data = await generateSchemaJsonld(buildPayload());
      setSchemaJson(stringify(data.schemas || data));
      MessagePlugin.success('Schema JSON-LD 已生成');
    } catch (err: any) {
      MessagePlugin.error(`生成失败：${deploymentPackageErrorMessage(err)}`);
    } finally {
      setLoading('');
    }
  };

  const handleVisibility = async () => {
    if (!validate()) return;
    setLoading('visibility');
    try {
      const data = await getBrandVisibility({ project_name: projectName.trim(), domain: normalizeDomain(domain) });
      setVisibility(data);
      MessagePlugin.success('品牌可见性已刷新');
    } catch (err: any) {
      MessagePlugin.error(`刷新失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleAssetAudit = async () => {
    if (!validate()) return;
    setLoading('audit');
    try {
      const data = await auditGeoAssets({ domain: normalizeDomain(domain) });
      setAssetAudit(data);
      MessagePlugin.success('GEO 资产体检完成');
    } catch (err: any) {
      MessagePlugin.error(`体检失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleTechnicalAudit = async () => {
    if (!validate()) return;
    setLoading('technical');
    try {
      const data = await auditTechnicalGeoSeo({ domain: normalizeDomain(domain) });
      setTechnicalAudit(data);
      MessagePlugin.success('网站技术 GEO/SEO 体检完成');
    } catch (err: any) {
      MessagePlugin.error(`体检失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleSitemap = async () => {
    if (!validate()) return;
    setLoading('sitemap');
    try {
      const data = await analyzeGeoSitemap({ domain: normalizeDomain(domain), max_pages: 20 });
      setSitemapAudit(data);
      MessagePlugin.success('sitemap 与页面抓取完成');
    } catch (err: any) {
      MessagePlugin.error(`抓取失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleLlmsFull = async () => {
    if (!validate()) return;
    setLoading('llmsFull');
    try {
      const data = await generateLlmsFullTxt({
        project_name: projectName.trim(),
        domain: normalizeDomain(domain),
        description: description.trim(),
        max_pages: 12,
      });
      setLlmsFullTxt(String(data.content || ''));
      if (Array.isArray(data.pages)) {
        setSitemapAudit(
          (prev) => prev || { pages: data.pages, page_count: data.page_count, source: data.source, score: 0 },
        );
      }
      MessagePlugin.success('llms-full.txt 已生成');
    } catch (err: any) {
      MessagePlugin.error(`生成失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleDrift = async () => {
    if (!validate()) return;
    setLoading('drift');
    try {
      const data = await monitorGeoDrift({ domain: normalizeDomain(domain), save_snapshot: true });
      setDriftAudit(data);
      await loadDriftState(domain);
      MessagePlugin.success('SEO/GEO 漂移监控已记录');
    } catch (err: any) {
      MessagePlugin.error(`监控失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const resolveLatestDiagnosisReportId = async (targetDomain: string) => {
    const normalized = normalizeDomain(targetDomain);
    if (!normalized) return undefined;
    try {
      const taskRows = await listTasks({ latest_only: true });
      const matched = taskRows.find(
        (task) => task.report_id && task.status === 'completed' && normalizeDomain(task.domain) === normalized,
      );
      return matched?.report_id || undefined;
    } catch (err: any) {
      MessagePlugin.warning(`诊断报告读取失败，部署包将按当前资料生成：${err?.message || '未知错误'}`);
      return undefined;
    }
  };

  const handleDeploymentPackage = async () => {
    if (!validate()) return;
    setLoading('deployment');
    try {
      const payload = buildPayload();
      const reportId = await resolveLatestDiagnosisReportId(payload.domain);
      const data = await generateDeploymentPackage({
        ...payload,
        max_pages: 12,
        report_id: reportId,
      });
      setDeploymentPackage(data);
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        MessagePlugin.warning(`部署建议包已生成，${data.warnings.length} 个检测项可稍后重试`);
      } else {
        MessagePlugin.success(reportId ? '已根据基础诊断报告生成部署建议包' : '一键部署建议包已生成');
      }
    } catch (err: any) {
      MessagePlugin.error(`生成失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleDownloadDeploymentPackage = async () => {
    if (!deploymentPackage) {
      MessagePlugin.warning('请先生成部署包');
      return;
    }
    setLoading('deploymentDownload');
    try {
      const blob = await downloadDeploymentPackageArchive(deploymentPackage);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeDomain = normalizeDomain(domain).replace(/[^a-zA-Z0-9.-]+/g, '-') || 'site';
      a.href = url;
      a.download = `zggeo-deployment-${safeDomain}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      MessagePlugin.success('部署包已开始下载');
    } catch (err: any) {
      MessagePlugin.error(`下载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleGenerateAll = async () => {
    if (!validate()) return;
    setLoading('all');
    const payload = buildPayload();
    const normalized = payload.domain;
    const reportId = await resolveLatestDiagnosisReportId(normalized);
    const failures: string[] = [];

    const runStep = async (label: string, runner: () => Promise<void>) => {
      try {
        await runner();
      } catch (err: any) {
        failures.push(`${label}：${err?.response?.data?.detail || err?.message || '失败'}`);
      }
    };

    await runStep('llms.txt', async () => {
      const data = await generateLlmsTxt(payload);
      setLlmsTxt(String(data.content || ''));
    });
    await runStep('Schema JSON-LD', async () => {
      const data = await generateSchemaJsonld(payload);
      setSchemaJson(stringify(data.schemas || data));
    });
    await runStep('llms-full.txt', async () => {
      const data = await generateLlmsFullTxt({
        project_name: payload.project_name,
        domain: normalized,
        description: payload.description || '',
        max_pages: 12,
      });
      setLlmsFullTxt(String(data.content || ''));
      if (Array.isArray(data.pages)) {
        setSitemapAudit(
          (prev) => prev || { pages: data.pages, page_count: data.page_count, source: data.source, score: 0 },
        );
      }
    });
    await runStep('GEO 资产体检', async () => {
      setAssetAudit(await auditGeoAssets({ domain: normalized }));
    });
    await runStep('技术体检', async () => {
      setTechnicalAudit(await auditTechnicalGeoSeo({ domain: normalized }));
    });
    await runStep('sitemap 分析', async () => {
      setSitemapAudit(await analyzeGeoSitemap({ domain: normalized, max_pages: 20 }));
    });
    await runStep('品牌公开源', async () => {
      setBrandSources(await scanBrandSources({ project_name: payload.project_name, domain: normalized }));
    });
    await runStep('AI 可见性', async () => {
      setVisibility(await getBrandVisibility({ project_name: payload.project_name, domain: normalized }));
    });
    await runStep('部署建议包', async () => {
      setDeploymentPackage(await generateDeploymentPackage({ ...payload, max_pages: 12, report_id: reportId }));
    });

    setLoading('');
    if (failures.length > 0) {
      MessagePlugin.warning(`已完成部分生成，${failures.length} 项失败，可单独重试`);
    } else {
      MessagePlugin.success('全部 GEO 资产与诊断已生成');
    }
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

  const viewExportedReport = () => {
    const html = String(exportedReport?.html || '');
    if (!html) {
      MessagePlugin.warning('请先导出报告');
      return;
    }
    openPrintableHtml(html);
  };

  const downloadExportedReport = () => {
    const html = String(exportedReport?.html || '');
    if (!html) {
      MessagePlugin.warning('请先导出报告');
      return;
    }
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeDomain = normalizeDomain(domain).replace(/[^a-zA-Z0-9.-]+/g, '-') || 'site';
    a.href = url;
    a.download = `zggeo-report-${safeDomain}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    MessagePlugin.success('报告 HTML 已开始下载');
  };

  const handleReportExport = async () => {
    if (!validate()) return;
    if (!deploymentPackage) {
      MessagePlugin.warning('请先生成部署建议包，再导出客户报告');
      return;
    }
    setLoading('export');
    try {
      const data: Record<string, any> = await exportCustomerReport({
        lead_id: leadIdFromSource(selectedSourceId),
        report: {
          project_name: projectName,
          domain: normalizeDomain(domain),
          summary_text: description,
          total_score: deploymentPackage.overall_score || 0,
          grade:
            Number(deploymentPackage.overall_score || 0) >= 80
              ? 'A'
              : Number(deploymentPackage.overall_score || 0) >= 60
              ? 'B'
              : 'C',
          visibility_score: visibility?.average_geo_score || 0,
          structure_score: technicalAudit?.score || 0,
          trust_score: brandSources?.overall_score || 0,
          top_issues: [
            ...(deploymentPackage.asset_summary?.issues || []),
            ...(deploymentPackage.technical_summary?.issues || []),
          ].slice(0, 6),
          top_fixes: [
            ...(deploymentPackage.asset_summary?.fixes || []),
            ...(deploymentPackage.technical_summary?.fixes || []),
          ].slice(0, 6),
          competitor_domains: normalizeCompetitorDomains(parseList(competitors)),
          competitor_compare: competitorCompare,
        },
        deployment: deploymentPackage,
      });
      const report: Record<string, any> = { ...data, generated_at: new Date().toISOString() };
      setExportedReport(report);
      window.localStorage.setItem(reportStorageKey, JSON.stringify(report));
      openPrintableHtml(String(report.html || ''));
      MessagePlugin.success('客户报告已生成，可在本模块查看或下载');
    } catch (err: any) {
      MessagePlugin.error(`导出失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleBrandSources = async () => {
    if (!validate()) return;
    setLoading('brandSources');
    try {
      const data = await scanBrandSources({ project_name: projectName.trim(), domain: normalizeDomain(domain) });
      setBrandSources(data);
      if (data.partial) {
        MessagePlugin.warning('品牌公开源扫描完成，部分外部源当前不可达');
      } else {
        MessagePlugin.success('品牌公开源扫描完成');
      }
    } catch (err: any) {
      MessagePlugin.error(`扫描失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleCompetitorCompare = async () => {
    if (!validate()) return;
    const rawCompetitors = parseList(competitors);
    const competitorDomains = normalizeCompetitorDomains(rawCompetitors)
      .filter((item) => item !== normalizeDomain(domain))
      .slice(0, 3);
    const invalidItems = rawCompetitors.filter((item) => !isLikelyDomain(item)).slice(0, 3);
    if (invalidItems.length > 0) {
      MessagePlugin.warning(`竞品 GEO 对比只填官网域名，不要填关键词或问题：${invalidItems.join('、')}`);
      setCompetitors(competitorDomains.join('\n'));
      return;
    }
    if (competitorDomains.length < 1) {
      MessagePlugin.warning('请先在竞品 GEO 对比卡片里填写 1-3 个竞品官网域名，例如 example.com');
      return;
    }
    setCompetitors(competitorDomains.join('\n'));
    setLoading('competitors');
    try {
      const data = await compareGeoCompetitors({
        primary_domain: normalizeDomain(domain),
        competitor_domains: competitorDomains,
      });
      setCompetitorCompare(data);
      window.localStorage.setItem(competitorStorageKey, JSON.stringify(data));
      if (data.status === 'partial') {
        MessagePlugin.warning('竞品 GEO 对比已部分完成，慢站点或不可达源已降级处理');
      } else {
        MessagePlugin.success('竞品 GEO 对比完成');
      }
    } catch (err: any) {
      MessagePlugin.error(`对比失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const handleDriftSchedule = async (enabled = true) => {
    if (!validate()) return;
    setLoading('schedule');
    try {
      const normalized = normalizeDomain(domain);
      const data = await configureDriftSchedule({ domain: normalized, frequency: 'weekly', enabled });
      setDriftSchedule(data);
      if (enabled) {
        const audit = await monitorGeoDrift({ domain: normalized, save_snapshot: true });
        setDriftAudit(audit);
      }
      await loadDriftState(normalized);
      MessagePlugin.success(enabled ? '定时漂移监控已配置' : '定时漂移监控已暂停');
    } catch (err: any) {
      MessagePlugin.error(`配置失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading('');
    }
  };

  const platforms = (visibility?.platforms || []) as Array<Record<string, any>>;
  const auditChecks = assetAudit
    ? [
        { key: 'llms_txt', title: 'llms.txt', data: assetAudit.llms_txt, desc: 'AI 内容索引与重点页面导航' },
        { key: 'schema', title: 'Schema JSON-LD', data: assetAudit.schema, desc: '结构化数据与实体理解' },
        { key: 'robots', title: 'robots.txt / AI 爬虫', data: assetAudit.robots, desc: 'AI 爬虫访问策略' },
      ]
    : [];

  return (
    <div className={styles.page}>
      <Card bordered={false} className={styles.heroCard}>
        <Space direction='vertical' size={8} style={{ width: '100%' }}>
          <Space breakLine>
            <Tag theme='success' variant='light'>
              GEO 核心资产
            </Tag>
            <Tag theme='primary' variant='light'>
              llms.txt
            </Tag>
            <Tag theme='warning' variant='light'>
              Schema JSON-LD
            </Tag>
            <Tag theme='danger' variant='light'>
              资产体检
            </Tag>
            <Tag theme='default' variant='light'>
              AI 可见性监控
            </Tag>
          </Space>
          <div className={styles.heroTitle} style={{ fontSize: 20 }}>
            GEO 资产生成与品牌 AI 可见性监控
          </div>
          <div className={styles.heroDesc} style={{ maxWidth: 'none' }}>
            基于已接入的 GEO/SEO 开源思路，生成可部署资产，并用历史报告评估 ChatGPT、Claude、Perplexity、Gemini
            的品牌可见性准备度。
          </div>
          {isGeoNew && (
            <Space breakLine>
              {GEO_NEW_SECTIONS.map((item) => (
                <Button
                  key={item.key}
                  size='small'
                  theme={activeSection === item.key ? 'primary' : 'default'}
                  variant={activeSection === item.key ? 'base' : 'outline'}
                  onClick={() => navigate(item.path)}
                >
                  {item.label}
                </Button>
              ))}
            </Space>
          )}
          <Space breakLine>
            <Button theme='primary' loading={loading === 'all'} onClick={handleGenerateAll}>
              一键生成全部资产
            </Button>
            <Button variant='outline' loading={sourceLoading} onClick={loadSources}>
              刷新项目资料
            </Button>
          </Space>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        {showSection('import') && (
          <Col xs={12} lg={activeSection === 'import' ? 12 : 4}>
            <Card
              bordered
              title={<StepTitle no='01' title='导入 / 确认基础资料' />}
              className={styles.sectionCard}
              bodyStyle={{ padding: 20 }}
            >
              <div>
                <FieldRow label='导入项目资料' help='从品牌池、客户资产或最近使用项目带入，不需要每个页面重填'>
                  <Space style={{ width: '100%' }} direction='vertical'>
                    <Select
                      value={selectedSourceId}
                      options={sourceOptions}
                      loading={sourceLoading}
                      filterable
                      clearable
                      placeholder='选择客户资产 / 品牌池里的项目'
                      empty='暂无可导入资料'
                      onChange={handleSourceChange}
                    />
                    <Space>
                      <Button
                        variant='outline'
                        theme='primary'
                        size='small'
                        disabled={!selectedSourceId && sources.length === 0}
                        onClick={applySelectedSource}
                      >
                        带入资料
                      </Button>
                      <Button variant='outline' size='small' loading={sourceLoading} onClick={loadSources}>
                        刷新资料
                      </Button>
                    </Space>
                  </Space>
                </FieldRow>
                <FieldRow label='项目 / 品牌名'>
                  <Input value={projectName} onChange={(v) => setProjectName(String(v))} />
                </FieldRow>
                <FieldRow label='域名'>
                  <Input value={domain} onChange={(v) => setDomain(String(v))} />
                </FieldRow>
                <FieldRow label='一句话描述'>
                  <Textarea
                    autosize={{ minRows: 3, maxRows: 5 }}
                    value={description}
                    onChange={(v) => setDescription(String(v))}
                  />
                </FieldRow>
                <FieldRow label='关键词'>
                  <Textarea
                    autosize={{ minRows: 4, maxRows: 8 }}
                    value={keywords}
                    onChange={(v) => setKeywords(String(v))}
                  />
                </FieldRow>
                <FieldRow label='核心页面 URL'>
                  <Textarea autosize={{ minRows: 5, maxRows: 10 }} value={urls} onChange={(v) => setUrls(String(v))} />
                </FieldRow>
                <FieldRow label='Schema 类型'>
                  <Select value={schemaType} onChange={(v) => setSchemaType(String(v))} options={SCHEMA_OPTIONS} />
                </FieldRow>
              </div>
            </Card>
          </Col>
        )}

        {activeSection !== 'import' && (
          <Col xs={12} lg={activeSection === 'all' ? 8 : 12}>
            <Row gutter={[16, 16]}>
              {showSection('import') && (
                <Col xs={12} style={{ order: 10 }}>
                  <Card bordered title='推荐生成顺序' className={styles.sectionCard}>
                    <div
                      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}
                    >
                      {GEO_STEPS.map((step) => (
                        <div key={step.no} className={styles.surfaceInset}>
                          <Space direction='vertical' size={6}>
                            <Tag theme='primary' variant='light'>
                              {step.no}
                            </Tag>
                            <div style={{ fontWeight: 700 }}>{step.title}</div>
                            <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', lineHeight: 1.6 }}>
                              {step.desc}
                            </div>
                          </Space>
                        </div>
                      ))}
                    </div>
                    <Divider />
                    <Space breakLine>
                      <Button theme='primary' loading={loading === 'all'} onClick={handleGenerateAll}>
                        按 02-04 一键生成
                      </Button>
                      <Button variant='outline' loading={sourceLoading} onClick={loadSources}>
                        刷新 01 项目资料
                      </Button>
                    </Space>
                  </Card>
                </Col>
              )}

              {showSection('audit') && (
                <Col xs={12} style={{ order: 33 }}>
                  <Card
                    bordered
                    title={<StepTitle no='03' title='品牌公开源可见性扫描' desc='补充外部实体信号' />}
                    className={styles.sectionCard}
                    actions={
                      <Button theme='primary' loading={loading === 'brandSources'} onClick={handleBrandSources}>
                        开始扫描
                      </Button>
                    }
                  >
                    {!brandSources ? (
                      <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                        检测 Wikipedia、Wikidata，并生成 Reddit、LinkedIn、YouTube 公开搜索入口，判断品牌外部实体信号。
                      </div>
                    ) : (
                      <>
                        <Metric title='公开源得分' value={brandSources.overall_score || 0} suffix='分' />
                        <Divider />
                        <div style={{ display: 'grid', gap: 10 }}>
                          {((brandSources.sources || []) as Array<Record<string, any>>).map((source) => (
                            <div
                              key={source.name}
                              style={{
                                padding: 12,
                                borderRadius: 10,
                                background: 'var(--td-bg-color-container-hover)',
                              }}
                            >
                              <Space breakLine style={{ width: '100%', justifyContent: 'space-between' }}>
                                <Space>
                                  <Tag
                                    theme={
                                      source.status === 'found'
                                        ? 'success'
                                        : source.status === 'search_ready'
                                        ? 'primary'
                                        : 'warning'
                                    }
                                    variant='light'
                                  >
                                    {statusText(String(source.status || 'unknown'))}
                                  </Tag>
                                  <b>{source.name}</b>
                                </Space>
                                <a href={source.url} target='_blank' rel='noreferrer'>
                                  打开
                                </a>
                              </Space>
                              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 6 }}>
                                {source.evidence}
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </Card>
                </Col>
              )}

              {showSection('competitors') && (
                <Col xs={12} style={{ order: 35 }}>
                  <Card
                    bordered
                    title={<StepTitle no='03' title='竞品 GEO 对比' desc='横向判断客户站点短板' />}
                    className={styles.sectionCard}
                    actions={
                      <Button theme='primary' loading={loading === 'competitors'} onClick={handleCompetitorCompare}>
                        开始对比
                      </Button>
                    }
                  >
                    <div style={{ marginBottom: 12 }}>
                      <FieldRow label='竞品域名（每行一个，最多 3 个）'>
                        <Textarea
                          autosize={{ minRows: 3, maxRows: 6 }}
                          placeholder={'例如：\nsanag.cn\nsagasai.com\nexample.com'}
                          value={competitors}
                          onChange={(v) => setCompetitors(String(v))}
                        />
                      </FieldRow>
                    </div>
                    {!competitorCompare ? (
                      <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                        先在上方输入 1-3 个竞品域名，再点击“开始对比”。系统会横向比较技术分、Schema、llms、sitemap、AI
                        价值页面数和品牌公开源信号。
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gap: 10 }}>
                        {((competitorCompare.ranked || []) as Array<Record<string, any>>).map((row, index) => (
                          <div
                            key={row.domain}
                            style={{
                              padding: 12,
                              borderRadius: 10,
                              background: index === 0 ? 'rgba(16,185,129,.08)' : 'var(--td-bg-color-container-hover)',
                            }}
                          >
                            <Space breakLine style={{ width: '100%', justifyContent: 'space-between' }}>
                              <Space>
                                <Tag theme={row.role === '自己' ? 'success' : 'default'} variant='light'>
                                  {row.role}
                                </Tag>
                                <b>{row.domain}</b>
                              </Space>
                              <b>{row.overall_score} 分</b>
                            </Space>
                            <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 6 }}>
                              技术 {row.technical_score} · 资产 {row.asset_score} · sitemap {row.sitemap_score} · 品牌源{' '}
                              {row.brand_source_score} · AI 价值页 {row.ai_value_page_count}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </Col>
              )}

              {showSection('monitoring') && (
                <Col xs={12} style={{ order: 51 }}>
                  <Card
                    bordered
                    title={<StepTitle no='05' title='定时漂移监控' desc='交付后的持续复测' />}
                    className={styles.sectionCard}
                    actions={
                      <Space breakLine>
                        <Button variant='outline' onClick={() => loadDriftState(domain)}>
                          刷新状态
                        </Button>
                        <Button
                          variant='outline'
                          loading={loading === 'schedule'}
                          disabled={!driftSchedule}
                          onClick={() => handleDriftSchedule(false)}
                        >
                          暂停监控
                        </Button>
                        <Button
                          theme='primary'
                          loading={loading === 'schedule'}
                          onClick={() => handleDriftSchedule(true)}
                        >
                          配置每周监控
                        </Button>
                      </Space>
                    }
                  >
                    {!driftSchedule ? (
                      <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                        保存每周漂移监控计划到 PostgreSQL，并立即记录一次基线快照。后续可让 cron/n8n
                        调用到期任务接口自动运行。
                      </div>
                    ) : (
                      <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                        已配置：{(driftSchedule.schedule as any)?.domain} ·{' '}
                        {statusText(String((driftSchedule.schedule as any)?.frequency || 'weekly'))} ·{' '}
                        {(driftSchedule.schedule as any)?.enabled ? '启用' : '暂停'}
                        <br />
                        下次应运行：
                        {(driftSchedule.schedule as any)?.next_run_at
                          ? new Date(String((driftSchedule.schedule as any).next_run_at)).toLocaleString('zh-CN')
                          : '未设置'}
                        <br />
                        持久化：PostgreSQL geo_drift_schedules；基线与后续快照保存到 geo_drift_snapshots
                      </div>
                    )}
                  </Card>
                </Col>
              )}

              {showSection('deployment') && (
                <Col xs={12} style={{ order: 40 }}>
                  <Card
                    bordered
                    title={<StepTitle no='04' title='一键生成部署建议包' desc='生成技术落地清单和可复制文件' />}
                    className={styles.sectionCard}
                    actions={
                      <Space breakLine>
                        <Button
                          variant='outline'
                          loading={loading === 'deploymentDownload'}
                          disabled={!deploymentPackage}
                          onClick={handleDownloadDeploymentPackage}
                        >
                          下载部署包
                        </Button>
                        <Button theme='primary' loading={loading === 'deployment'} onClick={handleDeploymentPackage}>
                          生成部署包
                        </Button>
                      </Space>
                    }
                  >
                    {!deploymentPackage ? (
                      <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                        一次性生成 /llms.txt、/llms-full.txt、Schema JSON-LD、robots.txt AI 爬虫建议和 P0/P1
                        部署清单，方便直接交给技术人员落地。
                      </div>
                    ) : (
                      <>
                        <Row gutter={[16, 16]}>
                          <Col xs={12} lg={4}>
                            <Metric title='部署准备分' value={deploymentPackage.overall_score || 0} suffix='分' />
                          </Col>
                          <Col xs={12} lg={4}>
                            <Metric title='已就绪' value={deploymentPackage.ready_count || 0} suffix='项' />
                          </Col>
                          <Col xs={12} lg={4}>
                            <Metric title='待部署' value={deploymentPackage.todo_count || 0} suffix='项' />
                          </Col>
                        </Row>
                        <Divider />
                        {Array.isArray(deploymentPackage.warnings) && deploymentPackage.warnings.length > 0 && (
                          <>
                            <div style={{ fontWeight: 600, marginBottom: 8 }}>生成提示</div>
                            <ol
                              style={{
                                margin: 0,
                                paddingLeft: 18,
                                lineHeight: 1.8,
                                color: 'var(--td-text-color-secondary)',
                              }}
                            >
                              {(deploymentPackage.warnings as string[]).map((item, index) => (
                                <li key={`${item}-${index}`}>{item}</li>
                              ))}
                            </ol>
                            <Divider />
                          </>
                        )}
                        <div style={{ display: 'grid', gap: 10 }}>
                          {((deploymentPackage.checklist || []) as Array<Record<string, any>>).map((item) => (
                            <div
                              key={item.title}
                              style={{
                                padding: 12,
                                borderRadius: 10,
                                background: 'var(--td-bg-color-container-hover)',
                              }}
                            >
                              <Space breakLine style={{ width: '100%', justifyContent: 'space-between' }}>
                                <Space>
                                  <Tag theme={item.status === 'done' ? 'success' : 'warning'} variant='light'>
                                    {item.status === 'done' ? '已就绪' : '待部署'}
                                  </Tag>
                                  <Tag theme={item.priority === 'P0' ? 'danger' : 'primary'} variant='light'>
                                    {item.priority}
                                  </Tag>
                                  <b>{item.title}</b>
                                </Space>
                                <span style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>
                                  {item.owner}
                                </span>
                              </Space>
                              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 6 }}>
                                {item.detail}
                              </div>
                            </div>
                          ))}
                        </div>
                        <Divider />
                        <Row gutter={[16, 16]}>
                          {((deploymentPackage.files || []) as Array<Record<string, any>>).map((file) => (
                            <Col xs={12} lg={6} key={file.path}>
                              <Card
                                size='small'
                                bordered
                                title={file.path}
                                actions={
                                  <Button
                                    size='small'
                                    variant='outline'
                                    onClick={() => copy(String(file.content || ''), ` ${file.path}`)}
                                  >
                                    复制
                                  </Button>
                                }
                              >
                                <Textarea
                                  readonly
                                  autosize={{ minRows: 5, maxRows: 8 }}
                                  value={String(file.content || '')}
                                />
                              </Card>
                            </Col>
                          ))}
                        </Row>
                      </>
                    )}
                  </Card>
                </Col>
              )}

              {showSection('audit') && (
                <Col xs={12} style={{ order: 31 }}>
                  <Card
                    bordered
                    title={<StepTitle no='03' title='网站技术 GEO/SEO 体检' desc='检查首页结构和可抽取性' />}
                    className={styles.sectionCard}
                    actions={
                      <Button theme='primary' loading={loading === 'technical'} onClick={handleTechnicalAudit}>
                        开始体检
                      </Button>
                    }
                  >
                    {!technicalAudit ? (
                      <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                        检测首页可访问性、title、description、H1/H2、canonical、noindex、JSON-LD、OG、正文量、问答意图和可信信号。
                      </div>
                    ) : (
                      <>
                        <Row gutter={[16, 16]}>
                          <Col xs={12} lg={3}>
                            <Metric title='技术体检分' value={technicalAudit.score || 0} suffix='分' />
                          </Col>
                          <Col xs={12} lg={3}>
                            <Metric title='正文词块' value={technicalAudit.word_count || 0} />
                          </Col>
                          <Col xs={12} lg={3}>
                            <Metric title='JSON-LD' value={technicalAudit.jsonld_count || 0} suffix='个' />
                          </Col>
                          <Col xs={12} lg={3}>
                            <Metric title='内链' value={technicalAudit.internal_link_count || 0} suffix='条' />
                          </Col>
                        </Row>
                        <Divider />
                        <div style={{ lineHeight: 1.8 }}>
                          <div>
                            <b>Title：</b>
                            {technicalAudit.title || '未检测到'}
                          </div>
                          <div>
                            <b>Description：</b>
                            {technicalAudit.meta_description || '未检测到'}
                          </div>
                          <div>
                            <b>H1：</b>
                            {((technicalAudit.h1 || []) as string[]).join(' / ') || '未检测到'}
                          </div>
                        </div>
                        <Divider />
                        <Row gutter={16}>
                          <Col xs={12} lg={6}>
                            <div style={{ fontWeight: 600, marginBottom: 8 }}>未通过项</div>
                            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                              {((technicalAudit.issues || []) as string[]).map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                            </ol>
                          </Col>
                          <Col xs={12} lg={6}>
                            <div style={{ fontWeight: 600, marginBottom: 8 }}>修复建议</div>
                            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                              {((technicalAudit.fixes || []) as string[]).map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                            </ol>
                          </Col>
                        </Row>
                      </>
                    )}
                  </Card>
                </Col>
              )}

              {showSection('audit') && (
                <Col xs={12} style={{ order: 32 }}>
                  <Card
                    bordered
                    title={<StepTitle no='03' title='sitemap + 页面抓取分析' desc='找出适合写入 llms-full 的页面' />}
                    className={styles.sectionCard}
                    actions={
                      <Button theme='primary' loading={loading === 'sitemap'} onClick={handleSitemap}>
                        抓取分析
                      </Button>
                    }
                  >
                    {!sitemapAudit ? (
                      <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                        优先读取 robots.txt 声明的 sitemap；如果没有 sitemap，会退回首页内链抓取，并给每个页面计算 AI
                        价值分。
                      </div>
                    ) : (
                      <>
                        <Row gutter={[16, 16]}>
                          <Col xs={12} lg={4}>
                            <Metric title='sitemap 分' value={sitemapAudit.score || 0} suffix='分' />
                          </Col>
                          <Col xs={12} lg={4}>
                            <Metric title='页面数' value={sitemapAudit.page_count || 0} suffix='页' />
                          </Col>
                          <Col xs={12} lg={4}>
                            <Metric title='来源' value={statusText(String(sitemapAudit.source || 'unknown'))} />
                          </Col>
                        </Row>
                        <Divider />
                        <div style={{ display: 'grid', gap: 10 }}>
                          {((sitemapAudit.pages || []) as Array<Record<string, any>>).slice(0, 10).map((p) => (
                            <div
                              key={p.url}
                              style={{
                                padding: 12,
                                borderRadius: 10,
                                background: 'var(--td-bg-color-container-hover)',
                              }}
                            >
                              <Space breakLine style={{ width: '100%', justifyContent: 'space-between' }}>
                                <b>{p.title || p.url}</b>
                                <Tag
                                  theme={Number(p.ai_value_score || 0) >= 70 ? 'success' : 'warning'}
                                  variant='light'
                                >
                                  AI 价值 {p.ai_value_score || 0}
                                </Tag>
                              </Space>
                              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
                                {p.url}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
                                {p.word_count || 0} 词块 · JSON-LD {p.jsonld_count || 0} 个
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </Card>
                </Col>
              )}

              {showSection('base') && (
                <Col xs={12} style={{ order: 22 }}>
                  <Card
                    bordered
                    title={<StepTitle no='02' title='llms-full.txt 自动生成' desc='完整站点上下文' />}
                    className={styles.sectionCard}
                    actions={
                      <Space breakLine>
                        <Button
                          theme='primary'
                          icon={<RefreshIcon />}
                          loading={loading === 'llmsFull'}
                          onClick={handleLlmsFull}
                        >
                          生成
                        </Button>
                        <Button
                          variant='outline'
                          icon={<FileCopyIcon />}
                          disabled={!llmsFullTxt}
                          onClick={() => copy(llmsFullTxt, ' llms-full.txt')}
                        >
                          复制
                        </Button>
                      </Space>
                    }
                  >
                    <Textarea
                      readonly
                      autosize={{ minRows: 10, maxRows: 18 }}
                      value={
                        llmsFullTxt ||
                        '点击“生成”后，系统会抓取 sitemap / 首页内链，输出包含页面摘要的 /llms-full.txt。'
                      }
                    />
                  </Card>
                </Col>
              )}

              {showSection('monitoring') && (
                <Col xs={12} style={{ order: 52 }}>
                  <Card
                    bordered
                    title={<StepTitle no='05' title='SEO/GEO 漂移监控' desc='记录交付后的变更快照' />}
                    className={styles.sectionCard}
                    actions={
                      <Space breakLine>
                        <Button variant='outline' loading={loading === 'drift'} onClick={() => loadDriftState(domain)}>
                          刷新历史
                        </Button>
                        <Button theme='primary' loading={loading === 'drift'} onClick={handleDrift}>
                          记录快照
                        </Button>
                      </Space>
                    }
                  >
                    <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                      每次记录都会保存当前技术分、资产分、sitemap 分、title、description、H1、JSON-LD、llms.txt
                      状态；快照会入库到 PostgreSQL geo_drift_snapshots，下次运行自动比较变化。
                    </div>
                    {driftAudit && (
                      <>
                        <Divider />
                        <Row gutter={[16, 16]}>
                          <Col xs={12} lg={3}>
                            <Metric title='漂移级别' value={statusText(String(driftAudit.severity || 'none'))} />
                          </Col>
                          <Col xs={12} lg={3}>
                            <Metric
                              title='历史快照'
                              value={driftAudit.history_count || driftHistory.length || 0}
                              suffix='次'
                            />
                          </Col>
                          <Col xs={12} lg={3}>
                            <Metric
                              title='技术分'
                              value={(driftAudit.snapshot as any)?.technical_score || 0}
                              suffix='分'
                            />
                          </Col>
                          <Col xs={12} lg={3}>
                            <Metric title='资产分' value={(driftAudit.snapshot as any)?.asset_score || 0} suffix='分' />
                          </Col>
                        </Row>
                        <Divider />
                        {((driftAudit.changes || []) as Array<Record<string, any>>).length === 0 ? (
                          <div style={{ color: 'var(--td-text-color-secondary)' }}>
                            暂无变化。第一次记录后，下次会显示字段级漂移。
                          </div>
                        ) : (
                          <div style={{ display: 'grid', gap: 10 }}>
                            {((driftAudit.changes || []) as Array<Record<string, any>>).map((c, i) => (
                              <div
                                key={`${c.field}-${i}`}
                                style={{
                                  padding: 12,
                                  borderRadius: 10,
                                  background: 'var(--td-bg-color-container-hover)',
                                }}
                              >
                                <b>{c.field}</b>
                                <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
                                  变更前：{stringify(c.before)}
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
                                  变更后：{stringify(c.after)}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    <Divider />
                    <Space breakLine style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
                      <div style={{ fontWeight: 600 }}>历史快照</div>
                      <Tag theme='primary' variant='light'>
                        {driftHistory.length} 条
                      </Tag>
                    </Space>
                    {driftHistory.length === 0 ? (
                      <div style={{ color: 'var(--td-text-color-secondary)' }}>
                        暂无历史快照，点击“记录快照”或“配置每周监控”后会生成第一条。
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {driftHistory.slice(0, 10).map((item) => {
                          const snap = (item.snapshot || {}) as Record<string, any>;
                          return (
                            <div
                              key={String(item.id)}
                              style={{
                                padding: 12,
                                borderRadius: 10,
                                background: 'var(--td-bg-color-container-hover)',
                              }}
                            >
                              <Space breakLine style={{ width: '100%', justifyContent: 'space-between' }}>
                                <b>
                                  {item.captured_at
                                    ? new Date(String(item.captured_at)).toLocaleString('zh-CN')
                                    : '未知时间'}
                                </b>
                                <Tag
                                  theme={
                                    String(item.severity) === 'high'
                                      ? 'danger'
                                      : String(item.severity) === 'medium'
                                      ? 'warning'
                                      : 'success'
                                  }
                                  variant='light'
                                >
                                  {statusText(String(item.severity || 'none'))}
                                </Tag>
                              </Space>
                              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
                                技术分 {snap.technical_score ?? '-'} · 资产分 {snap.asset_score ?? '-'} · sitemap{' '}
                                {snap.sitemap_score ?? '-'} · llms.txt {snap.llms_exists ? '存在' : '缺失'}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
                                Title：{snap.title || '-'} · H1：{snap.h1 || '-'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Card>
                </Col>
              )}

              {showSection('audit') && (
                <Col xs={12} style={{ order: 30 }}>
                  <Card
                    bordered
                    title={<StepTitle no='03' title='GEO 资产一键体检' desc='检查 llms、Schema 和 AI crawler 策略' />}
                    className={styles.sectionCard}
                    actions={
                      <Button theme='primary' loading={loading === 'audit'} onClick={handleAssetAudit}>
                        开始体检
                      </Button>
                    }
                  >
                    {!assetAudit ? (
                      <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                        自动检测当前网站是否部署了 /llms.txt、Schema JSON-LD、robots.txt AI
                        爬虫策略，并输出优先修复清单。
                      </div>
                    ) : (
                      <>
                        <Row gutter={[16, 16]} align='middle'>
                          <Col xs={12} lg={3}>
                            <div
                              style={{
                                textAlign: 'center',
                                padding: 18,
                                borderRadius: 12,
                                background: 'rgba(15,118,110,.08)',
                              }}
                            >
                              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>总体资产分</div>
                              <div style={{ fontSize: 44, fontWeight: 800, color: '#0F766E' }}>
                                {assetAudit.overall_score || 0}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>
                                {assetAudit.base_url}
                              </div>
                            </div>
                          </Col>
                          <Col xs={12} lg={9}>
                            {auditChecks.map((item) => (
                              <AuditLine key={item.key} title={item.title} desc={item.desc} data={item.data || {}} />
                            ))}
                          </Col>
                        </Row>
                        <Divider />
                        <Row gutter={16}>
                          <Col xs={12} lg={6}>
                            <div style={{ fontWeight: 600, marginBottom: 8 }}>发现的问题</div>
                            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                              {((assetAudit.issues || []) as string[]).map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                            </ol>
                          </Col>
                          <Col xs={12} lg={6}>
                            <div style={{ fontWeight: 600, marginBottom: 8 }}>优先修复</div>
                            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                              {((assetAudit.fixes || []) as string[]).map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                            </ol>
                          </Col>
                        </Row>
                      </>
                    )}
                  </Card>
                </Col>
              )}

              {showSection('base') && (
                <Col xs={12} style={{ order: 20 }}>
                  <Card
                    bordered
                    title={<StepTitle no='02' title='llms.txt 自动生成' desc='AI 内容索引入口' />}
                    className={styles.sectionCard}
                    actions={
                      <Space breakLine>
                        <Button
                          theme='primary'
                          icon={<RefreshIcon />}
                          loading={loading === 'llms'}
                          onClick={handleLlms}
                        >
                          生成
                        </Button>
                        <Button
                          variant='outline'
                          icon={<FileCopyIcon />}
                          disabled={!llmsTxt}
                          onClick={() => copy(llmsTxt, ' llms.txt')}
                        >
                          复制
                        </Button>
                      </Space>
                    }
                  >
                    <Textarea
                      readonly
                      autosize={{ minRows: 10, maxRows: 18 }}
                      value={llmsTxt || '点击“生成”后，这里会输出可部署到网站根目录 /llms.txt 的内容。'}
                    />
                  </Card>
                </Col>
              )}

              {showSection('base') && (
                <Col xs={12} style={{ order: 21 }}>
                  <Card
                    bordered
                    title={<StepTitle no='02' title='Schema JSON-LD 自动生成' desc='结构化实体识别' />}
                    className={styles.sectionCard}
                    actions={
                      <Space breakLine>
                        <Button
                          theme='primary'
                          icon={<RefreshIcon />}
                          loading={loading === 'schema'}
                          onClick={handleSchema}
                        >
                          生成
                        </Button>
                        <Button
                          variant='outline'
                          icon={<FileCopyIcon />}
                          disabled={!schemaJson}
                          onClick={() => copy(schemaJson, ' Schema JSON-LD')}
                        >
                          复制
                        </Button>
                      </Space>
                    }
                  >
                    <Textarea
                      readonly
                      autosize={{ minRows: 10, maxRows: 18 }}
                      value={schemaJson || '点击“生成”后，这里会输出企业/组织、网站、常见问题三类结构化数据代码。'}
                    />
                  </Card>
                </Col>
              )}

              {showSection('audit') && (
                <Col xs={12} style={{ order: 34 }}>
                  <Card
                    bordered
                    title={<StepTitle no='03' title='品牌 / AI 可见性监控' desc='聚合历史报告准备度' />}
                    className={styles.sectionCard}
                    actions={
                      <Button theme='primary' loading={loading === 'visibility'} onClick={handleVisibility}>
                        刷新监控
                      </Button>
                    }
                  >
                    {!visibility ? (
                      <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                        点击“刷新监控”，系统会聚合同域名历史报告，输出品牌在 AI 搜索中的准备度、平台侧重点和下一步动作。
                      </div>
                    ) : (
                      <>
                        <Row gutter={[16, 16]}>
                          <Col xs={12} sm={4}>
                            <Metric title='历史报告' value={visibility.report_count || 0} suffix='份' />
                          </Col>
                          <Col xs={12} sm={4}>
                            <Metric title='平均 GEO 分' value={visibility.average_geo_score || 0} suffix='分' />
                          </Col>
                          <Col xs={12} sm={4}>
                            <Metric title='状态' value={statusText(String(visibility.status || 'unknown'))} />
                          </Col>
                        </Row>
                        <Divider />
                        {platforms.map((p) => (
                          <div key={p.name} style={{ marginBottom: 14 }}>
                            <Space breakLine style={{ width: '100%', justifyContent: 'space-between' }}>
                              <span style={{ fontWeight: 600 }}>{p.name}</span>
                              <span>{p.readiness || 0} 分</span>
                            </Space>
                            <Progress percentage={Number(p.readiness || 0)} theme='plump' label={false} />
                            <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
                              {p.focus}
                            </div>
                          </div>
                        ))}
                        <Divider />
                        <Row gutter={16}>
                          <Col xs={12} lg={6}>
                            <div style={{ fontWeight: 600, marginBottom: 8 }}>主要问题</div>
                            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                              {((visibility.top_issues || []) as string[]).map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                            </ol>
                          </Col>
                          <Col xs={12} lg={6}>
                            <div style={{ fontWeight: 600, marginBottom: 8 }}>下一步动作</div>
                            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                              {((visibility.next_actions || []) as string[]).map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                            </ol>
                          </Col>
                        </Row>
                      </>
                    )}
                  </Card>
                </Col>
              )}

              {showSection('report') && (
                <Col xs={12} style={{ order: 50 }}>
                  <Card
                    bordered
                    title={<StepTitle no='05' title='客户报告导出（网页 / PDF）' desc='最终交付给客户' />}
                    className={styles.sectionCard}
                    actions={
                      <Space breakLine>
                        <Button variant='outline' disabled={!exportedReport?.html} onClick={viewExportedReport}>
                          查看报告
                        </Button>
                        <Button variant='outline' disabled={!exportedReport?.html} onClick={downloadExportedReport}>
                          下载 HTML
                        </Button>
                        <Button theme='primary' loading={loading === 'export'} onClick={handleReportExport}>
                          导出网页 / PDF
                        </Button>
                      </Space>
                    }
                  >
                    <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                      先完成 04“部署建议包”，再导出可交付客户报告。打开后点击“打印 / 另存为
                      PDF”，包含总分、问题、修复优先级、竞品对比、部署代码和页面清单。
                    </div>
                    {parseList(competitors).length > 0 && !competitorCompare && (
                      <div style={{ marginTop: 10, color: 'var(--td-warning-color)', lineHeight: 1.8 }}>
                        当前填写了竞品域名，但尚未执行竞品对比；导出的报告会标注未生成竞品 GEO 对比章节。
                      </div>
                    )}
                    {exportedReport?.html && (
                      <>
                        <Divider />
                        <Row gutter={[16, 16]}>
                          <Col xs={12} lg={3}>
                            <Metric title='报告状态' value='已生成' />
                          </Col>
                          <Col xs={12} lg={3}>
                            <Metric title='报告格式' value={String(exportedReport.format || 'HTML')} />
                          </Col>
                          <Col xs={12} lg={3}>
                            <Metric
                              title='竞品对比'
                              value={
                                competitorCompare ? '已完成' : parseList(competitors).length > 0 ? '未执行' : '未提供'
                              }
                            />
                          </Col>
                          <Col xs={12} lg={3}>
                            <Metric
                              title='生成时间'
                              value={
                                exportedReport.generated_at
                                  ? new Date(String(exportedReport.generated_at)).toLocaleString()
                                  : '-'
                              }
                            />
                          </Col>
                        </Row>
                        <div style={{ marginTop: 14, color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
                          当前报告：{String(exportedReport.title || `${projectName} GEO 客户诊断报告`)}
                          。可直接查看网页报告，或下载 HTML 后交付/打印为 PDF。
                        </div>
                      </>
                    )}
                  </Card>
                </Col>
              )}
            </Row>
          </Col>
        )}
      </Row>
    </div>
  );
};

const Metric: React.FC<{ title: string; value: string | number; suffix?: string }> = ({ title, value, suffix }) => (
  <div style={{ padding: 14, borderRadius: 10, background: 'var(--td-bg-color-container-hover)' }}>
    <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>{title}</div>
    <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>
      {value}
      {suffix || ''}
    </div>
  </div>
);

const AuditLine: React.FC<{ title: string; desc: string; data: Record<string, any> }> = ({ title, desc, data }) => {
  const score = Number(data.score || 0);
  const ok = data.exists === true || data.format_valid === true || score >= 70;
  const color = score >= 80 ? '#10B981' : score >= 60 ? '#3B82F6' : score >= 40 ? '#F59E0B' : '#EF4444';
  return (
    <div style={{ marginBottom: 14 }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space size={8}>
          <Tag size='small' theme={ok ? 'success' : 'warning'} variant='light'>
            {ok ? '通过' : '待优化'}
          </Tag>
          <span style={{ fontWeight: 600 }}>{title}</span>
          <span style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>{desc}</span>
        </Space>
        <span style={{ fontWeight: 700, color }}>{score} 分</span>
      </Space>
      <Progress percentage={score} color={color} size='small' label={false} />
      {(data.issues || []).length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
          {(data.issues || []).join('；')}
        </div>
      )}
    </div>
  );
};

export default GeoAssets;
