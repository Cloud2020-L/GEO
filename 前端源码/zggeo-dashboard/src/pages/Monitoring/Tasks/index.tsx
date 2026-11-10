import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Table,
  Tag,
  Button,
  Space,
  Card,
  Input,
  Select,
  MessagePlugin,
  Tooltip,
  PrimaryTableCol,
  Switch,
  Dialog,
  Input as TInput,
  Textarea,
} from 'tdesign-react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector } from 'modules/store';
import {
  RefreshIcon,
  SearchIcon,
  AddIcon,
  FileIcon,
  LoadingIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  TimeFilledIcon,
} from 'tdesign-icons-react';
import { listTasks, createTask, AnalysisTaskRow, TaskCreateRequest } from 'services/zggeo-api';
import TaskDetailDrawer from 'components/TaskDetailDrawer';
import {
  buildProjectSourceOptions,
  defaultKeywordsFor,
  defaultUrlsFor,
  getActiveProjectContext,
  loadProjectSources,
  normalizeDomain,
  parseList,
  ProjectContext,
  readStringList,
  saveActiveProjectContext,
} from 'utils/projectContext';
import styles from '../linear.module.less';

/**
 * L3 监测诊断 · 监测任务
 * 数据源：codex GET /tasks + POST /tasks
 */

interface TaskFormState {
  project_name: string;
  domain: string;
  keywords: string;
  urls: string;
  pasted_text: string;
}

const emptyTaskForm: TaskFormState = {
  project_name: '',
  domain: '',
  keywords: '',
  urls: '',
  pasted_text: '',
};

const sourceToTaskForm = (source: ProjectContext): TaskFormState => {
  const domain = normalizeDomain(source.domain);
  const projectName = source.project_name || domain;
  const sourceKeywords = readStringList(source.keywords);
  const sourceUrls = readStringList(source.urls);
  const keywords = sourceKeywords.length > 0 ? sourceKeywords : defaultKeywordsFor(projectName);
  const urls = sourceUrls.length > 0 ? sourceUrls : defaultUrlsFor(domain);
  return {
    project_name: projectName,
    domain,
    keywords: keywords.join('\n'),
    urls: urls.join('\n'),
    pasted_text: source.notes || source.description || '',
  };
};

const TaskFieldRow: React.FC<{
  label: string;
  help?: string;
  required?: boolean;
  children: React.ReactNode;
}> = ({ label, help, required, children }) => (
  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 22 }}>
    <div
      style={{
        width: 116,
        flex: '0 0 116px',
        paddingTop: 8,
        textAlign: 'right',
        fontSize: 15,
        color: 'var(--td-text-color-primary)',
      }}
    >
      {required && <span style={{ color: 'var(--td-error-color)', marginRight: 6 }}>*</span>}
      {label}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      {children}
      {help && (
        <div style={{ marginTop: 4, color: 'var(--td-text-color-placeholder)', fontSize: 12, lineHeight: 1.6 }}>
          {help}
        </div>
      )}
    </div>
  </div>
);

// ---------- 状态配置 ----------
const STATUS_CONFIG: Record<
  string,
  { label: string; theme: 'success' | 'primary' | 'warning' | 'danger' | 'default'; icon: React.ReactNode }
> = {
  completed: { label: '已完成', theme: 'success', icon: <CheckCircleFilledIcon /> },
  running: { label: '分析中', theme: 'primary', icon: <LoadingIcon /> },
  pending: { label: '排队中', theme: 'warning', icon: <TimeFilledIcon /> },
  failed: { label: '失败', theme: 'danger', icon: <CloseCircleFilledIcon /> },
};

// 成绩等级颜色
const GRADE_COLOR: Record<string, string> = {
  S: '#10B981',
  A: '#10B981',
  B: '#3B82F6',
  C: '#F59E0B',
  D: '#EF4444',
  E: '#EF4444',
};

const Tasks: React.FC = () => {
  const navigate = useNavigate();
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || '').toLowerCase();
  const isClient = role === 'client';
  const canManualEditDiagnosis = !isClient;
  const canViewInternalReport = ['admin', 'operator'].includes(role);

  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [latestOnly, setLatestOnly] = useState(true);

  // 新建任务 Dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [taskForm, setTaskForm] = useState<TaskFormState>(emptyTaskForm);
  const [sources, setSources] = useState<ProjectContext[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState('');

  // 任务详情 Drawer
  const [detailOpen, setDetailOpen] = useState(false);
  const [currentTask, setCurrentTask] = useState<AnalysisTaskRow | null>(null);

  const fetchData = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoading(true);
      try {
        const data = await listTasks({ latest_only: latestOnly });
        setTasks(data);
      } catch (err: any) {
        MessagePlugin.error(`拉取任务失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [latestOnly],
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const hasActiveTask = useMemo(
    () => tasks.some((task) => task.status === 'running' || task.status === 'pending'),
    [tasks],
  );

  useEffect(() => {
    if (!hasActiveTask) return undefined;
    const timer = window.setInterval(() => {
      fetchData(false);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [fetchData, hasActiveTask]);

  // 统计面板
  const stats = useMemo(() => {
    const s = { total: tasks.length, completed: 0, running: 0, failed: 0, avg_score: 0 };
    let scoreSum = 0;
    let scoreCount = 0;
    tasks.forEach((t) => {
      if (t.status === 'completed') s.completed += 1;
      else if (t.status === 'running' || t.status === 'pending') s.running += 1;
      else if (t.status === 'failed') s.failed += 1;
      if (typeof t.total_score === 'number') {
        scoreSum += t.total_score;
        scoreCount += 1;
      }
    });
    s.avg_score = scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0;
    return s;
  }, [tasks]);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (!keyword) return true;
      const k = keyword.toLowerCase();
      return (
        (t.project_name || '').toLowerCase().includes(k) ||
        (t.domain || '').toLowerCase().includes(k) ||
        (t.task_type || '').toLowerCase().includes(k)
      );
    });
  }, [tasks, keyword, statusFilter]);

  const sourceOptions = useMemo(() => buildProjectSourceOptions(sources), [sources]);
  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) || null,
    [selectedSourceId, sources],
  );
  const canCreateTask = useMemo(() => {
    const hasRequiredFields = !!taskForm.project_name.trim() && !!normalizeDomain(taskForm.domain);
    if (!hasRequiredFields) return false;
    if (isClient) return !!selectedSource?.source_lead_id;
    return true;
  }, [isClient, selectedSource?.source_lead_id, taskForm.domain, taskForm.project_name]);

  const applySourceRecord = (source: ProjectContext, silent = false) => {
    try {
      const nextForm = sourceToTaskForm(source);
      setSelectedSourceId(source.id);
      setTaskForm(nextForm);
      saveActiveProjectContext({
        ...source,
        domain: nextForm.domain,
        urls: parseList(nextForm.urls),
        keywords: parseList(nextForm.keywords),
        notes: nextForm.pasted_text,
      });

      if (!silent) {
        if (!nextForm.domain) {
          MessagePlugin.warning('这条客户资产还缺官网域名，已先带入项目和关键词，请补一下域名再创建任务');
        } else {
          MessagePlugin.success('已带入项目名称、域名、关键词、核心 URL 和客户需求');
        }
      }
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[monitoring/tasks] apply source failed', source, err);
      MessagePlugin.error(`资料带入失败：${err?.message || '资料结构异常'}`);
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

  const loadTaskSources = async () => {
    setSourceLoading(true);
    try {
      let nextSources: ProjectContext[] = [];
      try {
        nextSources = await loadProjectSources();
      } catch (err: any) {
        MessagePlugin.warning(`客户资产读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
      }

      const activeSource = getActiveProjectContext();
      if (isClient) {
        nextSources = nextSources.filter((source) => !!source.source_lead_id);
      }
      if (activeSource && (!isClient || activeSource.source_lead_id)) {
        nextSources = [activeSource, ...nextSources.filter((item) => item.id !== activeSource.id)];
      }
      setSources(nextSources);

      if (nextSources.length === 0) {
        MessagePlugin.warning(
          isClient
            ? '暂无可导入客户资产，请联系管理员维护资料'
            : '品牌池/客户资产里还没有可导入资料，请先新增客户或品牌',
        );
      } else {
        const preferred = nextSources.find((source) => source.domain && source.project_name) || nextSources[0];
        if (preferred) applySourceRecord(preferred, true);
      }
    } finally {
      setSourceLoading(false);
    }
  };

  const openCreateDialog = () => {
    setTaskForm(emptyTaskForm);
    setSelectedSourceId('');
    setCreateOpen(true);
    loadTaskSources();
  };

  const applySource = (value: unknown, context?: any) => {
    if (!value) {
      setSelectedSourceId('');
      if (!isClient) setTaskForm(emptyTaskForm);
      return;
    }
    const source = findSourceBySelectValue(value, context);
    if (!source) {
      setSelectedSourceId(String(value || ''));
      MessagePlugin.warning('没有找到这条资料，请点“刷新资料”后再试');
      return;
    }
    applySourceRecord(source);
  };

  const applySelectedSource = () => {
    const source = findSourceBySelectValue(selectedSourceId) || sources[0];
    if (!source) {
      MessagePlugin.warning('暂无可带入资料，请先刷新资料');
      return;
    }
    applySourceRecord(source);
  };

  useEffect(() => {
    if (!createOpen || !selectedSourceId) return;
    const source = findSourceBySelectValue(selectedSourceId);
    if (!source) return;
    setTaskForm((prev) => {
      const hasValue = prev.project_name || prev.domain || prev.keywords || prev.urls || prev.pasted_text;
      return hasValue ? prev : sourceToTaskForm(source);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createOpen, selectedSourceId, sources]);

  const handleCreate = async () => {
    const source = findSourceBySelectValue(selectedSourceId);
    if (isClient && !source?.source_lead_id) {
      MessagePlugin.warning('客户会员请先从已有资料导入');
      return;
    }

    const projectName = taskForm.project_name.trim();
    const domain = normalizeDomain(taskForm.domain);

    if (!projectName) {
      MessagePlugin.warning('请先选择资料或填写项目名称');
      return;
    }

    if (!domain) {
      MessagePlugin.warning('请先选择资料或填写品牌域名');
      return;
    }

    const body: TaskCreateRequest = {
      project_name: projectName,
      domain,
      keywords: parseList(taskForm.keywords),
      urls: parseList(taskForm.urls),
      pasted_text: taskForm.pasted_text.trim() || undefined,
      source_lead_id: source?.source_lead_id || undefined,
    };
    saveActiveProjectContext({
      id: 'task-form:latest',
      origin: '最近使用',
      project_name: projectName,
      domain,
      description: taskForm.pasted_text.trim(),
      keywords: body.keywords || [],
      competitors: [],
      urls: body.urls || defaultUrlsFor(domain),
      notes: taskForm.pasted_text.trim(),
      source_lead_id: source?.source_lead_id,
    });

    setCreating(true);
    try {
      const res = await createTask(body);
      MessagePlugin.success(`任务已创建，ID：${res.task_id.slice(0, 8)}...`);
      setCreateOpen(false);
      setTaskForm(emptyTaskForm);
      setSelectedSourceId('');
      // 稍后刷新，留时间给后端入库
      setTimeout(() => fetchData(false), 500);
    } catch (err: any) {
      MessagePlugin.error(`创建失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setCreating(false);
    }
  };

  const columns: PrimaryTableCol<AnalysisTaskRow>[] = [
    {
      colKey: 'created_at',
      title: '创建时间',
      width: 155,
      cell: ({ row }) => (row.created_at ? new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }) : '-'),
    },
    {
      colKey: 'project_name',
      title: '项目',
      width: 180,
      cell: ({ row }) => (
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{row.project_name || '-'}</div>
          <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)', marginTop: 2 }}>{row.domain}</div>
        </div>
      ),
    },
    {
      colKey: 'task_type',
      title: '任务类型',
      width: 140,
      cell: ({ row }) => (
        <Tag theme='default' variant='outline' size='small'>
          {row.task_type || '-'}
        </Tag>
      ),
    },
    {
      colKey: 'status',
      title: '状态',
      width: 100,
      cell: ({ row }) => {
        const cfg = STATUS_CONFIG[row.status] || {
          label: row.status,
          theme: 'default' as const,
          icon: null,
        };
        return (
          <Tag theme={cfg.theme as any} variant='light' icon={cfg.icon as any}>
            {cfg.label}
          </Tag>
        );
      },
    },
    {
      colKey: 'total_score',
      title: '综合评分',
      width: 120,
      cell: ({ row }) => {
        if (typeof row.total_score !== 'number') {
          return <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>;
        }
        const color = GRADE_COLOR[row.grade || ''] || '#6366F1';
        return (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 20, fontWeight: 600, color, lineHeight: 1 }}>{row.total_score}</span>
            <span style={{ fontSize: 11, color: 'var(--td-text-color-secondary)' }}>分</span>
            {row.grade && (
              <Tag
                size='small'
                theme='default'
                variant='light'
                style={{ marginLeft: 4, background: color, color: '#fff', border: 'none' }}
              >
                {row.grade}
              </Tag>
            )}
          </div>
        );
      },
    },
    {
      colKey: 'summary_text',
      title: '摘要',
      minWidth: 240,
      cell: ({ row }) =>
        row.summary_text ? (
          <Tooltip content={row.summary_text} placement='top'>
            <div
              style={{
                maxWidth: 280,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 12,
                color: 'var(--td-text-color-secondary)',
              }}
            >
              {row.summary_text}
            </div>
          </Tooltip>
        ) : (
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>
        ),
    },
    {
      colKey: 'is_latest_report',
      title: '版本',
      width: 90,
      cell: ({ row }) => (
        <Space size={4} direction='vertical'>
          {row.is_latest_report && (
            <Tag size='small' theme='success' variant='light'>
              最新
            </Tag>
          )}
          {row.is_productized_report && (
            <Tag size='small' theme='primary' variant='light'>
              产品化
            </Tag>
          )}
          {row.is_legacy_report && (
            <Tag size='small' theme='default' variant='light'>
              旧版
            </Tag>
          )}
        </Space>
      ),
    },
    {
      colKey: 'actions',
      title: '操作',
      width: 180,
      cell: ({ row }) => (
        <Space size='small'>
          <Button
            variant='text'
            theme='primary'
            size='small'
            onClick={() => {
              setCurrentTask(row);
              setDetailOpen(true);
            }}
          >
            详情
          </Button>
          {row.report_id ? (
            <Button
              variant='text'
              theme='primary'
              size='small'
              icon={<FileIcon />}
              onClick={() => navigate(`/visibility-monitoring/diagnosis/report?report_id=${row.report_id}`)}
            >
              报告
            </Button>
          ) : (
            <span style={{ color: 'var(--td-text-color-placeholder)', fontSize: 12 }}>无报告</span>
          )}
          {row.report_id && canViewInternalReport && (
            <Button
              variant='text'
              theme='primary'
              size='small'
              onClick={() => navigate(`/reports/scoring?report_id=${row.report_id}`)}
            >
              内部分析
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const STATUS_FILTER_OPTIONS = [
    { label: '全部状态', value: 'all' },
    { label: '已完成', value: 'completed' },
    { label: '分析中', value: 'running' },
    { label: '排队中', value: 'pending' },
    { label: '失败', value: 'failed' },
  ];

  return (
    <div className={styles.page}>
      {/* 统计卡 */}
      <Card bordered className={styles.sectionCard} bodyStyle={{ padding: '20px 24px' }}>
        <div className={styles.statsGrid}>
          <StatItem label='全部任务' value={stats.total} color='#6366F1' highlight />
          <StatItem label='已完成' value={stats.completed} color='#10B981' />
          <StatItem label='分析中 / 排队' value={stats.running} color='#F59E0B' />
          <StatItem label='失败' value={stats.failed} color='#EF4444' />
          <StatItem label='平均评分' value={stats.avg_score} color='#6366F1' unit={stats.avg_score > 0 ? '分' : ''} />
        </div>
      </Card>

      {/* 工具栏 + 表格 */}
      <Card bordered className={styles.sectionCard} bodyStyle={{ padding: 16 }}>
        <Space className={styles.toolbarRow} style={{ marginBottom: 16, width: '100%' }}>
          <Space className={styles.responsiveToolbar}>
            <Input
              placeholder='搜项目名 / 域名 / 任务类型'
              value={keyword}
              onChange={setKeyword}
              prefixIcon={<SearchIcon />}
              style={{ width: 280 }}
              clearable
            />
            <Select
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as string)}
              options={STATUS_FILTER_OPTIONS}
              style={{ width: 140 }}
            />
            <Space size='small'>
              <span style={{ fontSize: 13, color: 'var(--td-text-color-secondary)' }}>仅看每个项目最新</span>
              <Switch value={latestOnly} onChange={(v) => setLatestOnly(!!v)} />
            </Space>
          </Space>
          <Space className={styles.responsiveToolbar}>
            <Tag theme='success' variant='light'>
              来源：codex GET /tasks
            </Tag>
            <Button
              theme='default'
              variant='outline'
              icon={<RefreshIcon />}
              loading={loading}
              onClick={() => fetchData()}
            >
              刷新
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={openCreateDialog}>
              新建监测任务
            </Button>
          </Space>
        </Space>

        <div className={styles.tableScroll}>
          <Table
            data={filtered}
            columns={columns}
            rowKey='id'
            loading={loading}
            bordered
            stripe
            hover
            size='medium'
            empty={tasks.length === 0 ? '尚无任务，点右上角"新建监测任务"创建第一个' : '没有符合条件的任务'}
            pagination={{
              defaultCurrent: 1,
              defaultPageSize: 20,
              total: filtered.length,
              showJumper: true,
            }}
          />
        </div>
      </Card>

      {/* 新建任务 Dialog */}
      <Dialog
        header='新建监测任务'
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onConfirm={handleCreate}
        confirmBtn={
          <Button theme='primary' loading={creating} disabled={!canCreateTask} onClick={handleCreate}>
            创建并开始分析
          </Button>
        }
        width={760}
        destroyOnClose
      >
        <div
          className={styles.surfaceInset}
          style={{ marginBottom: 16, fontSize: 12, color: 'var(--td-text-color-secondary)', lineHeight: 1.7 }}
        >
          可从品牌池或客户资产导入，自动带入项目名称、品牌域名、目标关键词和首页 URL。 创建后 codex 会自动启动 n8n
          workflow，预计 1-3 分钟出报告。
        </div>
        <div>
          <TaskFieldRow
            label='从已有资料导入'
            help={
              isClient
                ? '客户会员仅可使用已绑定客户资产资料创建基础诊断'
                : '优先读取品牌池；客户资产里有品牌名和官网域名的资料也会显示'
            }
          >
            <Space className={styles.responsiveToolbar} style={{ width: '100%' }}>
              <Select
                value={selectedSourceId}
                onChange={applySource}
                options={sourceOptions}
                loading={sourceLoading}
                filterable
                clearable={!isClient}
                placeholder='选择品牌池 / 客户资产里的项目'
                style={{ width: 430 }}
                empty='暂无可导入资料'
              />
              <Button
                variant='outline'
                theme='primary'
                disabled={!selectedSourceId && sources.length === 0}
                onClick={applySelectedSource}
              >
                带入资料
              </Button>
              <Button variant='outline' icon={<RefreshIcon />} loading={sourceLoading} onClick={loadTaskSources}>
                刷新资料
              </Button>
            </Space>
          </TaskFieldRow>
          <TaskFieldRow label='项目名称' required>
            <TInput
              value={taskForm.project_name}
              onChange={(v) => setTaskForm((prev) => ({ ...prev, project_name: String(v) }))}
              disabled={!canManualEditDiagnosis}
              placeholder='例如：XX 教育 Q2 品牌监测'
            />
          </TaskFieldRow>
          <TaskFieldRow label='品牌域名' required>
            <TInput
              value={taskForm.domain}
              onChange={(v) => setTaskForm((prev) => ({ ...prev, domain: String(v) }))}
              disabled={!canManualEditDiagnosis}
              placeholder='例如：example.com（不带 http://）'
            />
          </TaskFieldRow>
          <TaskFieldRow label='目标关键词' help='每行一个，或用英文逗号分隔'>
            <Textarea
              value={taskForm.keywords}
              onChange={(v) => setTaskForm((prev) => ({ ...prev, keywords: String(v) }))}
              disabled={!canManualEditDiagnosis}
              placeholder={'AI 可见度优化\nGEO 是什么\n企业知识检索'}
              autosize={{ minRows: 3, maxRows: 6 }}
            />
          </TaskFieldRow>
          <TaskFieldRow label='监测 URL' help='可选，每行一个；导入后默认带首页 URL'>
            <Textarea
              value={taskForm.urls}
              onChange={(v) => setTaskForm((prev) => ({ ...prev, urls: String(v) }))}
              disabled={!canManualEditDiagnosis}
              placeholder={'https://example.com/\nhttps://example.com/product'}
              autosize={{ minRows: 2, maxRows: 4 }}
            />
          </TaskFieldRow>
          <TaskFieldRow label='补充说明' help='可选，导入客户资产时会带入客户需求，方便报告上下文'>
            <Textarea
              value={taskForm.pasted_text}
              onChange={(v) => setTaskForm((prev) => ({ ...prev, pasted_text: String(v) }))}
              disabled={!canManualEditDiagnosis}
              placeholder='（可选）直接粘贴正文'
              autosize={{ minRows: 2, maxRows: 6 }}
            />
          </TaskFieldRow>
        </div>
      </Dialog>

      {/* 任务详情 Drawer */}
      <TaskDetailDrawer
        visible={detailOpen}
        task={currentTask}
        onClose={() => setDetailOpen(false)}
        onReran={fetchData}
      />
    </div>
  );
};

// ---------- 小组件 ----------
interface StatItemProps {
  label: string;
  value: number;
  color: string;
  highlight?: boolean;
  unit?: string;
}
const StatItem: React.FC<StatItemProps> = ({ label, value, color, highlight, unit }) => (
  <Card bordered={false} className={styles.statCard}>
    <div className={styles.statLabel}>{label}</div>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
      <span
        style={{
          fontSize: highlight ? 28 : 22,
          fontWeight: 600,
          color,
          lineHeight: 1,
          marginTop: 6,
        }}
      >
        {value}
      </span>
      {unit && <span style={{ fontSize: 12, color, marginLeft: 2 }}>{unit}</span>}
    </div>
  </Card>
);

export default Tasks;
