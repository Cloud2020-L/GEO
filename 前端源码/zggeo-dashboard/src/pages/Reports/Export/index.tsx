import React, { useEffect, useMemo, useState } from 'react';
/* eslint-disable no-use-before-define */
import {
  Button,
  Card,
  Checkbox,
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
import { DownloadIcon, FileCopyIcon, FileIcon, PrintIcon, RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import {
  AgentWorkflowReports,
  AgentWorkflowRun,
  AnalysisTaskRow,
  ReportResponse,
  exportAgentWorkflowReport,
  getAgentWorkflowReports,
  getReport,
  listAgentWorkflows,
  listArticleDraftsDb,
  listContentTasksDb,
  listTasks,
} from 'services/zggeo-api';
import Style from '../linear.module.less';

const { TabPanel } = Tabs;

type ExportFormat = 'markdown' | 'json' | 'html';
type ExportItemKind = 'workflow' | 'analysis';
type ReportType = 'geo' | 'model' | 'summary' | 'analysis' | 'customer' | 'articles';

interface ArticleExportRow {
  id: string;
  task_id?: string;
  title: string;
  body: string;
  status?: string;
  channel?: string;
  provider?: string;
  model?: string;
  created_at?: string;
}

interface ExportItem {
  id: string;
  kind: ExportItemKind;
  project_name: string;
  domain?: string | null;
  status?: string;
  created_at?: string;
  score?: number;
  grade?: string;
  workflow?: AgentWorkflowRun;
  task?: AnalysisTaskRow;
  reports?: AgentWorkflowReports['reports'];
  articles: ArticleExportRow[];
  includeArticles: boolean;
}

const GRADE_COLOR: Record<string, string> = {
  S: '#10B981',
  A: '#10B981',
  B: '#3B82F6',
  C: '#F59E0B',
  D: '#EF4444',
  E: '#EF4444',
};

const REPORT_LABELS: Record<ReportType, string> = {
  geo: 'GEO 报告',
  model: '模型可见度',
  summary: '问题总结',
  analysis: '基础诊断',
  customer: '客户交付',
  articles: '文章',
};

const downloadFile = (filename: string, content: string, mime: string) => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const sanitizeFilename = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 90);

const cleanDomain = (value?: unknown) =>
  String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();

const toArray = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return [String(value)].filter(Boolean);
};

const formatDate = (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '-');

const itemReportTypes = (item: ExportItem): ReportType[] => {
  const reports = item.reports || {};
  const types: ReportType[] = [];
  if (reports.geo_report) types.push('geo');
  if (reports.model_report) types.push('model');
  if (reports.summary_report) types.push('summary');
  if (reports.analysis_report || item.task?.report_id) types.push('analysis');
  if (item.workflow?.exported_report) types.push('customer');
  if (item.articles.length) types.push('articles');
  return types;
};

const findArticlesForWorkflow = (
  workflow: AgentWorkflowRun,
  tasks: Record<string, unknown>[],
  drafts: Record<string, unknown>[],
): ArticleExportRow[] => {
  const domain = cleanDomain(workflow.domain);
  const project = String(workflow.project_name || '')
    .trim()
    .toLowerCase();
  const matchedTaskIds = new Set(
    tasks
      .filter((task) => {
        const taskDomain = cleanDomain(task.domain);
        const taskBrand = String(task.brand || task.project_name || '')
          .trim()
          .toLowerCase();
        return Boolean(domain && taskDomain === domain) || Boolean(project && taskBrand === project);
      })
      .map((task) => String(task.id)),
  );

  const rows = drafts
    .filter((draft) => matchedTaskIds.has(String(draft.task_id || '')))
    .map((draft) => ({
      id: String(draft.id),
      task_id: draft.task_id ? String(draft.task_id) : undefined,
      title: String(draft.title || '未命名文章'),
      body: String(draft.body || draft.body_preview || ''),
      status: draft.status ? String(draft.status) : undefined,
      channel: draft.channel ? String(draft.channel) : undefined,
      provider: draft.provider ? String(draft.provider) : undefined,
      model: draft.model ? String(draft.model) : undefined,
      created_at: draft.created_at ? String(draft.created_at) : undefined,
    }));

  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
};

const workflowMarkdown = (item: ExportItem, exportedReport?: Record<string, unknown>) => {
  const reports = item.reports || {};
  const articles = item.includeArticles ? item.articles : [];
  const lines: string[] = [
    `# ${item.project_name} · 自动流程交付报告`,
    '',
    `- 域名：${item.domain || '-'}`,
    `- 流程 ID：${item.workflow?.id || '-'}`,
    `- 状态：${item.status || '-'}`,
    `- 生成时间：${formatDate(item.created_at)}`,
    '',
  ];

  if (reports.geo_report) {
    lines.push('## GEO 报告', '');
    lines.push(`- 标题：${reports.geo_report.title || '-'}`);
    lines.push(`- 评分：${reports.geo_report.score ?? '-'} / ${reports.geo_report.grade || '-'}`);
    lines.push(...toArray(reports.geo_report.issues).map((issue, index) => `${index + 1}. ${issue}`), '');
  }
  if (reports.model_report) {
    lines.push('## 模型可见度', '');
    lines.push(`- 平均分：${reports.model_report.avg_score ?? '-'}`);
    lines.push(`- 品牌提及率：${reports.model_report.brand_rate ?? '-'}`);
    lines.push(`- 推荐率：${reports.model_report.recommend_rate ?? '-'}`);
    lines.push(`- 模型数：${reports.model_report.model_count ?? '-'}`);
    lines.push(`- 问题数：${reports.model_report.question_count ?? '-'}`, '');
  }
  if (reports.summary_report) {
    lines.push('## 问题总结', '');
    lines.push('### 总结');
    lines.push(...toArray(reports.summary_report.summary).map((s) => `- ${s}`), '');
    lines.push('### 核心问题');
    lines.push(...toArray(reports.summary_report.core_issues).map((s) => `- ${s}`), '');
    lines.push('### 下一步动作');
    lines.push(...toArray(reports.summary_report.next_actions).map((s) => `- ${s}`), '');
  }
  if (reports.analysis_report) {
    lines.push('## 基础诊断', '');
    lines.push(`- 评分：${reports.analysis_report.score ?? '-'} / ${reports.analysis_report.grade || '-'}`);
    lines.push(`- 摘要：${reports.analysis_report.summary || '-'}`, '');
  }
  if (exportedReport || item.workflow?.exported_report) {
    lines.push('## 客户交付数据', '');
    lines.push('```json');
    lines.push(JSON.stringify(exportedReport || item.workflow?.exported_report, null, 2));
    lines.push('```', '');
  }
  if (articles.length) {
    lines.push('## 文章', '');
    articles.forEach((article, index) => {
      lines.push(`### ${index + 1}. ${article.title}`, '');
      lines.push(article.body || '（空）', '');
    });
  }
  return lines.join('\n');
};

const analysisMarkdown = (r: ReportResponse): string => {
  const rj = r.report_json || ({} as any);
  const issues = (rj.top_issues || r.top_issues || []) as string[];
  const fixes = (rj.top_fixes || r.top_fixes || []) as string[];
  return `# ${r.project_name} · ZGEO 评分报告

**域名**：${r.domain}
**报告版本**：${r.report_version}
**生成时间**：${formatDate(r.created_at)}

## 总体评分

- 综合评分：${r.total_score} 分 / ${r.grade}
- 可见度：${r.visibility_score}
- 结构：${r.structure_score}
- 信任：${r.trust_score}
- 内容覆盖：${r.content_coverage_score}

## 执行摘要

${r.summary_text || '—'}

## 核心问题

${issues.length ? issues.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（无）'}

## 优先建议

${fixes.length ? fixes.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（无）'}
`;
};

const markdownToPrintableHTML = (title: string, md: string): string => {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = escape(md);
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(?:<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/\n\n+/g, '</p><p>');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; color: #1f2937; max-width: 920px; margin: 0 auto; padding: 40px; line-height: 1.72; font-size: 14px; }
  h1 { font-size: 26px; color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
  h2 { font-size: 20px; margin-top: 32px; border-left: 4px solid #2563eb; padding-left: 12px; }
  h3 { font-size: 16px; margin-top: 20px; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; }
  pre { background: #f8fafc; padding: 12px; overflow: auto; }
  strong { color: #2563eb; }
  @media print { body { padding: 20px; } h2 { page-break-after: avoid; } }
</style>
</head>
<body><p>${html}</p></body>
</html>`;
};

const Export: React.FC = () => {
  const [items, setItems] = useState<ExportItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ReportType>('all');
  const [selectedIds, setSelectedIds] = useState<Array<string | number>>([]);
  const [exporting, setExporting] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [includeArticles, setIncludeArticles] = useState(true);
  const [previewItem, setPreviewItem] = useState<ExportItem | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [workflows, contentTasks, articleDrafts, analysisTasks] = await Promise.all([
        listAgentWorkflows({ limit: 100 }),
        listContentTasksDb({ limit: 100 }),
        listArticleDraftsDb({ limit: 100 }),
        listTasks({ latest_only: true }),
      ]);
      const reportPairs = await Promise.all(
        workflows.map(async (workflow) => {
          try {
            return [workflow.id, (await getAgentWorkflowReports(workflow.id)).reports] as const;
          } catch {
            return [workflow.id, {}] as const;
          }
        }),
      );
      const reportMap = new Map(reportPairs);
      const workflowItems: ExportItem[] = workflows
        .map((workflow) => {
          const reports = reportMap.get(workflow.id) || {};
          const articles = findArticlesForWorkflow(workflow, contentTasks, articleDrafts);
          const item: ExportItem = {
            id: `workflow:${workflow.id}`,
            kind: 'workflow',
            project_name: workflow.project_name,
            domain: workflow.domain,
            status: workflow.status,
            created_at: workflow.finished_at || workflow.updated_at || workflow.created_at,
            score: reports.geo_report?.score ?? reports.analysis_report?.score,
            grade: reports.geo_report?.grade ?? reports.analysis_report?.grade,
            workflow,
            reports,
            articles,
            includeArticles,
          };
          return item;
        })
        .filter((item) => itemReportTypes(item).length > 0 || item.status === 'completed' || item.status === 'partial');

      const analysisItems: ExportItem[] = analysisTasks
        .filter((task) => task.status === 'completed' && task.report_id)
        .map((task) => ({
          id: `analysis:${task.id}`,
          kind: 'analysis',
          project_name: task.project_name,
          domain: task.domain,
          status: task.status,
          created_at: task.finished_at || task.created_at,
          score: task.total_score,
          grade: task.grade,
          task,
          articles: [],
          includeArticles: false,
        }));

      setItems([...workflowItems, ...analysisItems]);
    } catch {
      MessagePlugin.error('拉取报告导出数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const effectiveItems = useMemo(
    () => items.map((item) => (item.kind === 'workflow' ? { ...item, includeArticles } : item)),
    [includeArticles, items],
  );

  const filteredItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return effectiveItems.filter((item) => {
      const matchedKeyword =
        !kw || item.project_name?.toLowerCase().includes(kw) || cleanDomain(item.domain).includes(kw);
      const matchedType = typeFilter === 'all' || itemReportTypes(item).includes(typeFilter);
      return matchedKeyword && matchedType;
    });
  }, [effectiveItems, keyword, typeFilter]);

  const workflowCount = effectiveItems.filter((item) => item.kind === 'workflow').length;
  const articleCount = effectiveItems.reduce(
    (sum, item) => sum + (item.kind === 'workflow' && item.includeArticles ? item.articles.length : 0),
    0,
  );

  const exportItem = async (item: ExportItem, fmt: ExportFormat) => {
    setExporting(true);
    try {
      const base = sanitizeFilename(`${item.project_name}_${item.domain || 'report'}_${item.kind}`);
      if (item.kind === 'analysis') {
        if (!item.task?.report_id) return;
        const report = await getReport(item.task.report_id);
        const md = analysisMarkdown(report);
        if (fmt === 'json') {
          downloadFile(`${base}.json`, JSON.stringify(report, null, 2), 'application/json');
        } else if (fmt === 'html') {
          const html = markdownToPrintableHTML(`${item.project_name} · 评分报告`, md);
          downloadFile(`${base}.html`, html, 'text/html;charset=utf-8');
          const win = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })), '_blank');
          setTimeout(() => win?.print(), 300);
        } else {
          downloadFile(`${base}.md`, md, 'text/markdown;charset=utf-8');
        }
        MessagePlugin.success('导出成功');
        return;
      }

      const exportedReport = item.workflow ? await exportAgentWorkflowReport(item.workflow.id) : undefined;
      const bundle = { ...item, exported_report: exportedReport, articles: item.includeArticles ? item.articles : [] };
      const md = workflowMarkdown(item, exportedReport);
      if (fmt === 'json') {
        downloadFile(`${base}.json`, JSON.stringify(bundle, null, 2), 'application/json');
      } else if (fmt === 'html') {
        const html = markdownToPrintableHTML(`${item.project_name} · 自动流程交付报告`, md);
        downloadFile(`${base}.html`, html, 'text/html;charset=utf-8');
        const win = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })), '_blank');
        setTimeout(() => win?.print(), 300);
      } else {
        downloadFile(`${base}.md`, md, 'text/markdown;charset=utf-8');
      }
      MessagePlugin.success('导出成功');
    } catch {
      MessagePlugin.error('导出失败');
    } finally {
      setExporting(false);
    }
  };

  const handleBatchExport = async () => {
    if (selectedIds.length === 0) {
      MessagePlugin.warning('请先选择报告');
      return;
    }
    const selected = effectiveItems.filter((item) => selectedIds.includes(item.id));
    await selected.reduce(async (previous, item) => {
      await previous;
      await exportItem(item, format);
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }, Promise.resolve());
  };

  const columns: PrimaryTableCol<ExportItem>[] = [
    { colKey: 'row-select', type: 'multiple', width: 50, fixed: 'left' },
    {
      colKey: 'project_name',
      title: '项目 / 域名',
      ellipsis: true,
      cell: ({ row }) => (
        <div>
          <Space size={6} align='center'>
            <span style={{ fontWeight: 700 }}>{row.project_name}</span>
            <Tag size='small' theme={row.kind === 'workflow' ? 'primary' : 'default'} variant='light'>
              {row.kind === 'workflow' ? '自动流程' : '基础报告'}
            </Tag>
          </Space>
          <div style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginTop: 4 }}>
            {row.domain || '-'}
          </div>
        </div>
      ),
    },
    {
      colKey: 'reports',
      title: '报告类型',
      minWidth: 230,
      cell: ({ row }) => (
        <Space size={4} style={{ flexWrap: 'wrap' }}>
          {itemReportTypes(row).map((type) => (
            <Tag key={type} size='small' variant='light' theme={type === 'articles' ? 'success' : 'primary'}>
              {REPORT_LABELS[type]}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      colKey: 'score',
      title: '评分',
      width: 120,
      cell: ({ row }) =>
        row.score !== undefined ? (
          <Space size={6} align='center'>
            <span style={{ fontSize: 16, fontWeight: 700, color: GRADE_COLOR[row.grade || 'C'] }}>{row.score}</span>
            <span style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>分</span>
            {row.grade ? (
              <Tag size='small' style={{ background: GRADE_COLOR[row.grade], color: '#fff', border: 'none' }}>
                {row.grade}
              </Tag>
            ) : null}
          </Space>
        ) : (
          '-'
        ),
    },
    {
      colKey: 'created_at',
      title: '生成时间',
      width: 170,
      cell: ({ row }) => (
        <span style={{ color: 'var(--td-text-color-secondary)', fontSize: 12 }}>{formatDate(row.created_at)}</span>
      ),
    },
    {
      colKey: 'action',
      title: '操作',
      width: 310,
      fixed: 'right',
      cell: ({ row }) => (
        <Space size={4}>
          <Button size='small' variant='outline' onClick={() => setPreviewItem(row)}>
            查看
          </Button>
          <Button
            size='small'
            variant='text'
            theme='primary'
            icon={<FileIcon />}
            onClick={() => exportItem(row, 'markdown')}
            disabled={exporting}
          >
            MD
          </Button>
          <Button
            size='small'
            variant='text'
            theme='primary'
            icon={<FileCopyIcon />}
            onClick={() => exportItem(row, 'json')}
            disabled={exporting}
          >
            JSON
          </Button>
          <Button
            size='small'
            variant='text'
            theme='primary'
            icon={<PrintIcon />}
            onClick={() => exportItem(row, 'html')}
            disabled={exporting}
          >
            打印
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard} bodyStyle={{ padding: 24 }}>
        <Space size={8} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <Tag theme='primary' variant='light'>
            自动流程报告
          </Tag>
          <Tag theme='success' variant='light'>
            文章默认包含
          </Tag>
        </Space>
        <div className={Style.heroTitle}>报告导出</div>
        <div className={Style.heroDesc}>
          汇总自动流程产生的 GEO、模型可见度、问题总结、客户交付报告和文章；同时兼容旧版基础评分报告。
        </div>
      </Card>

      <div className={Style.statsGrid}>
        <Card bordered={false} className={Style.statCard}>
          <div className={Style.statLabel}>可导出项目</div>
          <div className={Style.statValue}>{effectiveItems.length}</div>
        </Card>
        <Card bordered={false} className={Style.statCard}>
          <div className={Style.statLabel}>自动流程</div>
          <div className={Style.statValue} style={{ color: '#8b9cf9' }}>
            {workflowCount}
          </div>
        </Card>
        <Card bordered={false} className={Style.statCard}>
          <div className={Style.statLabel}>随报告导出文章</div>
          <div className={Style.statValue} style={{ color: '#34d399' }}>
            {articleCount}
          </div>
        </Card>
      </div>

      <Card bordered={false} className={Style.sectionCard} style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
          <FormatCard
            icon={<FileIcon />}
            name='Markdown'
            color='#2563EB'
            desc='适合客户交付前二次编辑，自动流程报告会按章节合并。'
          />
          <FormatCard
            icon={<FileCopyIcon />}
            name='JSON'
            color='#D97706'
            desc='保留 workflow、reports、articles 和导出 payload，便于研发复核。'
          />
          <FormatCard
            icon={<PrintIcon />}
            name='可打印 HTML'
            color='#059669'
            desc='打开浏览器打印，可另存 PDF；同时下载一份 HTML。'
          />
        </div>
      </Card>

      <Card bordered={false} className={Style.sectionCard} style={{ marginBottom: 16 }}>
        <div className={Style.toolbarRow}>
          <Input
            prefixIcon={<SearchIcon />}
            placeholder='搜项目 / 域名'
            value={keyword}
            onChange={(v) => setKeyword(v as string)}
            style={{ width: 240 }}
          />
          <Select
            value={typeFilter}
            options={[
              { label: '全部报告', value: 'all' },
              { label: 'GEO 报告', value: 'geo' },
              { label: '模型可见度', value: 'model' },
              { label: '问题总结', value: 'summary' },
              { label: '基础诊断', value: 'analysis' },
              { label: '文章', value: 'articles' },
            ]}
            onChange={(v) => setTypeFilter(v as 'all' | ReportType)}
            style={{ width: 150 }}
          />
          <Select
            value={format}
            options={[
              { label: '批量导出为 Markdown', value: 'markdown' },
              { label: '批量导出为 JSON', value: 'json' },
              { label: '批量导出为 HTML', value: 'html' },
            ]}
            onChange={(v) => setFormat(v as ExportFormat)}
            style={{ width: 190 }}
          />
          <Checkbox checked={includeArticles} onChange={(checked) => setIncludeArticles(Boolean(checked))}>
            包含文章（默认全部）
          </Checkbox>
          <Button
            theme='primary'
            icon={<DownloadIcon />}
            onClick={handleBatchExport}
            loading={exporting}
            disabled={selectedIds.length === 0}
          >
            批量导出 ({selectedIds.length})
          </Button>
          <div style={{ flex: 1 }} />
          <Tag theme='success' variant='light'>
            筛选结果：{filteredItems.length} 份
          </Tag>
          <Button icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </div>
      </Card>

      <Card bordered={false} className={Style.sectionCard}>
        <Table
          data={filteredItems}
          columns={columns}
          rowKey='id'
          loading={loading}
          size='medium'
          stripe
          hover
          selectedRowKeys={selectedIds}
          onSelectChange={(keys) => setSelectedIds(keys as Array<string | number>)}
          empty='暂无可导出的自动流程报告或基础报告'
        />
      </Card>

      <ReportPreviewDialog item={previewItem} onClose={() => setPreviewItem(null)} />
    </div>
  );
};

function ReportPreviewDialog({ item, onClose }: { item: ExportItem | null; onClose: () => void }) {
  const reports = item?.reports || {};
  const types = item ? itemReportTypes(item) : [];
  const defaultValue = types[0] || 'articles';
  return (
    <Dialog
      visible={Boolean(item)}
      header={item ? `${item.project_name} · 报告预览` : '报告预览'}
      width='860px'
      footer={false}
      onClose={onClose}
    >
      {item ? (
        <Tabs defaultValue={defaultValue}>
          {reports.geo_report ? (
            <TabPanel value='geo' label='GEO 报告'>
              <PreviewBlock data={reports.geo_report} />
            </TabPanel>
          ) : null}
          {reports.model_report ? (
            <TabPanel value='model' label='模型可见度'>
              <PreviewBlock data={reports.model_report} />
            </TabPanel>
          ) : null}
          {reports.summary_report ? (
            <TabPanel value='summary' label='问题总结'>
              <PreviewBlock data={reports.summary_report} />
            </TabPanel>
          ) : null}
          {reports.analysis_report || item.task ? (
            <TabPanel value='analysis' label='基础诊断'>
              <PreviewBlock data={reports.analysis_report || item.task} />
            </TabPanel>
          ) : null}
          {item.workflow?.exported_report ? (
            <TabPanel value='customer' label='客户交付'>
              <PreviewBlock data={item.workflow.exported_report} />
            </TabPanel>
          ) : null}
          {item.articles.length ? (
            <TabPanel value='articles' label={`文章 (${item.articles.length})`}>
              <div style={{ display: 'grid', gap: 12 }}>
                {item.articles.map((article) => (
                  <Card key={article.id} bordered bodyStyle={{ padding: 16 }}>
                    <Space size={6} style={{ flexWrap: 'wrap' }}>
                      <strong>{article.title}</strong>
                      {article.status ? (
                        <Tag size='small' variant='light'>
                          {article.status}
                        </Tag>
                      ) : null}
                      {article.channel ? (
                        <Tag size='small' variant='light' theme='success'>
                          {article.channel}
                        </Tag>
                      ) : null}
                    </Space>
                    <div
                      style={{
                        marginTop: 8,
                        color: 'var(--td-text-color-secondary)',
                        whiteSpace: 'pre-wrap',
                        maxHeight: 220,
                        overflow: 'auto',
                      }}
                    >
                      {article.body || '（空）'}
                    </div>
                  </Card>
                ))}
              </div>
            </TabPanel>
          ) : null}
        </Tabs>
      ) : null}
    </Dialog>
  );
}

function PreviewBlock({ data }: { data: unknown }) {
  return (
    <pre
      style={{
        margin: 0,
        maxHeight: 520,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        color: 'var(--td-text-color-secondary)',
      }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function FormatCard({ icon, name, color, desc }: { icon: React.ReactNode; name: string; color: string; desc: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'start' }}>
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 8,
          background: color,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#f8fafc' }}>{name}</div>
        <div style={{ fontSize: 12, color: 'rgba(203,213,225,0.72)', marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </div>
    </div>
  );
}

export default Export;
