import React, { useEffect, useMemo, useState } from 'react';
import { Card, Tag, Button, Space, Table, PrimaryTableCol, MessagePlugin, Select, Skeleton } from 'tdesign-react';
import {
  RefreshIcon,
  PlayCircleIcon,
  TimeFilledIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  LoadingIcon,
  RocketIcon,
} from 'tdesign-icons-react';
import { useNavigate } from 'react-router-dom';
import AgentShell, { AgentMeta, AgentStatus } from 'components/AgentShell';
import {
  AnalysisTaskRow,
  autoStartContentAgentRuns,
  ContentAgentRun,
  listContentAgentRuns,
  listModelProviders,
  ModelProviderRow,
  listTasks,
  retryContentAgentRun,
} from 'services/zggeo-api';
import TaskDetailDrawer from 'components/TaskDetailDrawer';
import Style from '../linear.module.less';

/**
 * 星枢 · 调度 Agent
 * 职责：任务编排、资源调度。实际数据源是 codex GET /tasks 的实时队列
 */

const META: AgentMeta = {
  key: 'scheduler',
  name: '星枢',
  title: '调度',
  emoji: '✨',
  tagline: '实时盯着任务队列，决定谁先跑、谁后跑、谁重试',
  description:
    '星枢负责把用户提交的监测任务排进 n8n workflow，根据优先级、资源余量、失败重试次数决定执行顺序。当检测到队列堆积或失败率升高时主动告警。',
  color: '#6366F1',
  gradient: ['#6366F1', '#8B5CF6'],
  apis: ['GET /tasks', 'POST /tasks'],
};

const STATUS_CFG: Record<
  string,
  { label: string; theme: 'success' | 'primary' | 'warning' | 'danger' | 'default'; icon: React.ReactElement }
> = {
  completed: { label: '已完成', theme: 'success', icon: <CheckCircleFilledIcon /> },
  running: { label: '分析中', theme: 'primary', icon: <LoadingIcon /> },
  pending: { label: '排队中', theme: 'warning', icon: <TimeFilledIcon /> },
  failed: { label: '失败', theme: 'danger', icon: <CloseCircleFilledIcon /> },
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

const Scheduler: React.FC = () => {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [contentRuns, setContentRuns] = useState<ContentAgentRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [contentActionLoading, setContentActionLoading] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [currentTask, setCurrentTask] = useState<AnalysisTaskRow | null>(null);
  const [providers, setProviders] = useState<ModelProviderRow[]>([]);
  const [contentProvider, setContentProvider] = useState('deepseek');

  const fetchData = async () => {
    setLoading(true);
    try {
      // 全量拿，不是只最新，这样能算吞吐
      const [data, contentData] = await Promise.all([
        listTasks({ latest_only: false }),
        listContentAgentRuns({ limit: 20 }),
      ]);
      setTasks(data);
      setContentRuns(contentData);
    } catch {
      MessagePlugin.error('拉取任务失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    listModelProviders()
      .then((data) => setProviders(data.providers || []))
      .catch(() => {});
    const t = setInterval(fetchData, 15_000); // 15s 轮询
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, []);

  const stats = useMemo(() => {
    const pending = tasks.filter((t) => t.status === 'pending').length;
    const running = tasks.filter((t) => t.status === 'running').length;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const contentPending = contentRuns.filter((run) => run.status === 'pending').length;
    const contentRunning = contentRuns.filter((run) => run.status === 'running').length;
    const contentFailed = contentRuns.filter((run) => run.status === 'failed').length;
    const total = tasks.length + contentRuns.length;

    // 吞吐：最近 24 小时完成的任务
    const oneDayAgo = Date.now() - 86400_000;
    const recent = tasks.filter((t) => t.finished_at && new Date(t.finished_at).getTime() > oneDayAgo).length;

    const failRate = total > 0 ? Math.round(((failed + contentFailed) / total) * 100) : 0;

    // 健康度：没 pending/failed 是 100，每有 5% fail 扣 10 分，堆积任务多再扣
    let health = 100;
    health -= failRate * 2;
    health -= Math.min(20, pending + contentPending);
    health = Math.max(0, Math.min(100, health));

    let agentStatus: AgentStatus = 'running';
    if (failed + contentFailed > 0 && failRate > 30) agentStatus = 'error';
    else if (running + contentRunning === 0 && pending + contentPending === 0) agentStatus = 'idle';

    return {
      pending,
      running,
      completed,
      failed,
      total,
      recent,
      failRate,
      health,
      agentStatus,
      contentPending,
      contentRunning,
      contentFailed,
    };
  }, [tasks, contentRuns]);

  // 活跃任务：pending + running，按状态优先级 + 时间倒序
  const activeTasks = useMemo(() => {
    const order: Record<string, number> = { running: 0, pending: 1 };
    return tasks
      .filter((t) => t.status === 'running' || t.status === 'pending')
      .sort((a, b) => {
        const oa = order[a.status] ?? 9;
        const ob = order[b.status] ?? 9;
        if (oa !== ob) return oa - ob;
        return (b.created_at || '').localeCompare(a.created_at || '');
      });
  }, [tasks]);

  // 最近失败：最近 7 天内失败的
  const recentFailed = useMemo(() => {
    const cutoff = Date.now() - 7 * 86400_000;
    return tasks
      .filter((t) => t.status === 'failed' && t.created_at && new Date(t.created_at).getTime() > cutoff)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 10);
  }, [tasks]);

  const columns: PrimaryTableCol<AnalysisTaskRow>[] = [
    {
      colKey: 'status',
      title: '状态',
      width: 100,
      cell: ({ row }) => {
        const c = STATUS_CFG[row.status] || STATUS_CFG.pending;
        return (
          <Tag theme={c.theme} variant='light' icon={c.icon}>
            {c.label}
          </Tag>
        );
      },
    },
    {
      colKey: 'project_name',
      title: '项目',
      cell: ({ row }) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.project_name}</div>
          <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>{row.domain}</div>
        </div>
      ),
    },
    {
      colKey: 'task_type',
      title: '任务类型',
      width: 180,
      cell: ({ row }) => (
        <Tag size='small' theme='primary' variant='light'>
          {row.task_type}
        </Tag>
      ),
    },
    {
      colKey: 'created_at',
      title: '入队时间',
      width: 160,
      cell: ({ row }) => (row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : '-'),
    },
    {
      colKey: 'action',
      title: '操作',
      width: 90,
      fixed: 'right',
      cell: ({ row }) => (
        <Button
          size='small'
          variant='text'
          theme='primary'
          onClick={() => {
            setCurrentTask(row);
            setDetailOpen(true);
          }}
        >
          详情
        </Button>
      ),
    },
  ];

  const contentColumns: PrimaryTableCol<ContentAgentRun>[] = [
    {
      colKey: 'status',
      title: '状态',
      width: 110,
      cell: ({ row }) => {
        const theme =
          row.status === 'completed'
            ? 'success'
            : row.status === 'failed'
            ? 'danger'
            : row.status === 'running'
            ? 'primary'
            : 'warning';
        return (
          <Tag theme={theme} variant='light'>
            {CONTENT_STAGE_LABELS[row.stage] || row.stage || row.status}
          </Tag>
        );
      },
    },
    {
      colKey: 'title',
      title: '内容任务',
      cell: ({ row }) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.title}</div>
          <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>
            {row.brand || '-'} · {row.domain || '-'} · {row.keyword || '-'}
          </div>
        </div>
      ),
    },
    {
      colKey: 'agent_key',
      title: '路由Agent',
      width: 130,
      cell: ({ row }) => (
        <Tag theme='primary' variant='light'>
          {row.agent_key}
        </Tag>
      ),
    },
    {
      colKey: 'geo_score',
      title: 'GEO分',
      width: 90,
      cell: ({ row }) =>
        row.geo_score ? (
          <Tag theme='success' variant='light'>
            {row.geo_score}
          </Tag>
        ) : (
          '-'
        ),
    },
    {
      colKey: 'action',
      title: '操作',
      width: 100,
      cell: ({ row }) =>
        row.status === 'failed' ? (
          <Button
            size='small'
            variant='text'
            loading={contentActionLoading === row.id}
            onClick={async () => {
              setContentActionLoading(row.id);
              try {
                await retryContentAgentRun(row.id);
                MessagePlugin.success('内容Agent已重试');
                await fetchData();
              } finally {
                setContentActionLoading('');
              }
            }}
          >
            重试
          </Button>
        ) : (
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>自动</span>
        ),
    },
  ];

  const handleAutoStartContent = async () => {
    setContentActionLoading('auto-start');
    try {
      const data = await autoStartContentAgentRuns({ limit: 10, provider: contentProvider || undefined });
      MessagePlugin.success(`已把 ${Number(data.queued || 0)} 条内容任务加入采集与文章生成队列`);
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '自动扫描失败');
    } finally {
      setContentActionLoading('');
    }
  };

  return (
    <AgentShell
      meta={META}
      status={stats.agentStatus}
      health={stats.health}
      variant='linear'
      metrics={[
        { label: '执行中', value: stats.running + stats.contentRunning, hint: '监测 + 内容Agent' },
        { label: '排队中', value: stats.pending + stats.contentPending, hint: '等待调度' },
        { label: '24h 吞吐', value: stats.recent, hint: '最近一天完成' },
        { label: '失败率', value: `${stats.failRate}%`, hint: `${stats.failed} 失败 / ${stats.total} 总数` },
      ]}
    >
      {/* 工具条 */}
      <div className={Style.page}>
        <Card bordered={false} className={`${Style.toolbarCard} ${Style.ghostButton}`} style={{ marginBottom: 16 }}>
          <div className={Style.toolbar}>
            <PlayCircleIcon style={{ color: META.color, fontSize: 16 }} />
            <span className={Style.toolbarTitle}>活跃队列</span>
            <Tag theme='default' variant='light'>
              {activeTasks.length}
            </Tag>
            <div className={Style.spacer} />
            <span className={Style.toolbarMeta}>自动每 15s 刷新</span>
            <Button size='small' icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
              刷新
            </Button>
            <Button size='small' variant='outline' theme='primary' onClick={() => navigate('/monitoring/tasks')}>
              新建任务
            </Button>
          </div>
        </Card>

        <Card
          bordered={false}
          className={`${Style.panelCard} ${Style.tableCard} ${Style.ghostButton}`}
          style={{ marginBottom: 16 }}
        >
          <div className={Style.toolbar} style={{ marginBottom: 12 }}>
            <RocketIcon style={{ color: '#ED7B2F', fontSize: 16 }} />
            <span className={Style.toolbarTitle}>内容 Agent 自动化队列</span>
            <Tag theme='primary' variant='light'>
              {contentRuns.length}
            </Tag>
            <div className={Style.spacer} />
            <Select
              size='small'
              value={contentProvider || '__default__'}
              style={{ width: 150 }}
              options={[
                { label: '默认模型', value: '__default__' },
                ...providers
                  .filter((p) => p.configured)
                  .map((p) => ({ label: p.name.split('·')[0].trim(), value: p.key })),
              ]}
              onChange={(value) => setContentProvider(String(value) === '__default__' ? '' : String(value))}
            />
            <Button
              size='small'
              theme='primary'
              variant='outline'
              loading={contentActionLoading === 'auto-start'}
              onClick={handleAutoStartContent}
            >
              采集并生成
            </Button>
          </div>
          {contentRuns.length === 0 ? (
            <div className={Style.emptyState}>暂无内容 Agent 流水线，先在写作任务池创建任务，或点击“采集并生成”</div>
          ) : (
            <Table data={contentRuns.slice(0, 8)} columns={contentColumns} rowKey='id' size='small' stripe hover />
          )}
        </Card>

        {/* 活跃任务表 */}
        <Card bordered={false} className={`${Style.panelCard} ${Style.tableCard}`}>
          {loading && tasks.length === 0 ? (
            <Skeleton
              animation='gradient'
              theme='paragraph'
              loading
              rowCol={[
                { width: '100%', height: 'px' },
                { width: '100%', height: 'px' },
                { width: '100%', height: 'px' },
              ]}
            />
          ) : activeTasks.length === 0 ? (
            <div className={Style.emptyState}>🎉 队列当前空闲，没有任务在跑</div>
          ) : (
            <Table data={activeTasks} columns={columns} rowKey='id' size='small' stripe hover />
          )}
        </Card>

        {/* 最近失败 */}
        {recentFailed.length > 0 && (
          <Card bordered={false} className={Style.alertCard}>
            <div className={Style.toolbar} style={{ marginBottom: 10 }}>
              <CloseCircleFilledIcon style={{ color: '#DC2626' }} />
              <span className={Style.toolbarTitle}>7 天内失败任务</span>
              <Tag theme='danger' variant='light'>
                {recentFailed.length}
              </Tag>
              <div className={Style.spacer} />
              <span className={Style.toolbarMeta}>建议检查后端 codex worker 日志</span>
            </div>
            <div className={Style.listGrid}>
              {recentFailed.map((t) => (
                <div
                  key={t.id}
                  className={Style.listItem}
                  style={{ borderLeft: '3px solid #DC2626', cursor: 'pointer' }}
                  onClick={() => {
                    setCurrentTask(t);
                    setDetailOpen(true);
                  }}
                >
                  <div className={Style.listItemCol}>
                    <div className={Style.itemTitle}>{t.project_name}</div>
                    <div className={Style.itemSub}>
                      {t.domain} · {t.task_type}
                    </div>
                  </div>
                  <Tag size='small' theme='default' variant='light'>
                    {t.task_type}
                  </Tag>
                  <span className={Style.itemSub}>
                    {t.created_at ? new Date(t.created_at).toLocaleString('zh-CN') : '-'}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      <TaskDetailDrawer
        visible={detailOpen}
        task={currentTask}
        onClose={() => setDetailOpen(false)}
        onReran={fetchData}
      />
    </AgentShell>
  );
};

export default Scheduler;
