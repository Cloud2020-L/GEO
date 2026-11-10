import React, { useEffect, useMemo, useState } from 'react';
import { Card, Tag, Button, Space, Select, Skeleton, MessagePlugin } from 'tdesign-react';
import {
  RefreshIcon,
  CodeIcon,
  SearchIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  LoadingIcon,
  TimeFilledIcon,
} from 'tdesign-icons-react';
import AgentShell, { AgentMeta, AgentStatus } from 'components/AgentShell';
import { listTasks, getTaskLogs, AnalysisTaskRow } from 'services/zggeo-api';
import Style from '../linear.module.less';

/**
 * 星图 · 执行 Agent
 * 职责：监测抓取 / 内容生成 / 日志回传。展示选中任务的实时执行日志
 */

const META: AgentMeta = {
  key: 'explorer',
  name: '星图',
  title: '执行',
  emoji: '🛰️',
  tagline: '真正动手干活的 Agent —— 抓取 / 生成 / 评分都由它落地',
  description:
    '星图是 n8n workflow 的实际执行层，对接 AI 模型 API、品牌页面抓取器、报告生成器。每个任务在它这里留下完整的日志链路，方便追溯为什么某条分析失败、哪一步变慢。',
  color: '#10B981',
  gradient: ['#10B981', '#059669'],
  apis: ['GET /tasks', 'GET /logs/{task_id}'],
};

type LogLevel = 'info' | 'warn' | 'error' | 'debug' | string;

const LEVEL_COLOR: Record<string, string> = {
  info: '#3B82F6',
  warn: '#F59E0B',
  warning: '#F59E0B',
  error: '#EF4444',
  debug: '#94A3B8',
  success: '#10B981',
};

const STATUS_ICON: Record<string, React.ReactNode> = {
  completed: <CheckCircleFilledIcon style={{ color: '#10B981' }} />,
  running: <LoadingIcon style={{ color: '#3B82F6' }} />,
  pending: <TimeFilledIcon style={{ color: '#F59E0B' }} />,
  failed: <CloseCircleFilledIcon style={{ color: '#EF4444' }} />,
};

const Explorer: React.FC = () => {
  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, unknown>[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [filter, setFilter] = useState('');

  const fetchTasks = async () => {
    setTasksLoading(true);
    try {
      const d = await listTasks({ latest_only: false });
      setTasks(d);
      if (!selectedTaskId && d.length > 0) setSelectedTaskId(d[0].id);
    } catch {
      MessagePlugin.error('拉取任务列表失败');
    } finally {
      setTasksLoading(false);
    }
  };

  const fetchLogs = async (taskId: string) => {
    setLogsLoading(true);
    try {
      const data = await getTaskLogs(taskId);
      setLogs(data || []);
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  useEffect(() => {
    if (selectedTaskId) fetchLogs(selectedTaskId);
  }, [selectedTaskId]);

  const selected = useMemo(() => tasks.find((t) => t.id === selectedTaskId) || null, [tasks, selectedTaskId]);

  const filteredLogs = useMemo(() => {
    if (!filter.trim()) return logs;
    const k = filter.toLowerCase();
    return logs.filter((l) => JSON.stringify(l).toLowerCase().includes(k));
  }, [logs, filter]);

  // Agent 指标
  const stats = useMemo(() => {
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const running = tasks.filter((t) => t.status === 'running').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const total = tasks.length;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // 健康度按成功率算
    let health = successRate;
    if (running > 0) health = Math.min(100, health + 5);
    let agentStatus: AgentStatus = 'running';
    if (failed > 0 && successRate < 60) agentStatus = 'error';
    else if (running === 0) agentStatus = 'idle';

    return { completed, running, failed, total, successRate, health, agentStatus };
  }, [tasks]);

  return (
    <AgentShell
      meta={META}
      status={stats.agentStatus}
      health={stats.health}
      variant='linear'
      metrics={[
        { label: '已完成任务', value: stats.completed },
        { label: '执行中', value: stats.running },
        { label: '历史失败', value: stats.failed },
        { label: '成功率', value: `${stats.successRate}%` },
      ]}
    >
      {/* 任务选择栏 */}
      <div className={Style.page}>
        <Card bordered={false} className={`${Style.toolbarCard} ${Style.ghostButton}`} style={{ marginBottom: 16 }}>
          <div className={Style.toolbar} style={{ flexWrap: 'wrap' }}>
            <CodeIcon style={{ color: META.color }} />
            <span className={Style.toolbarTitle}>日志查看</span>
            <Select
              value={selectedTaskId || undefined}
              onChange={(v) => setSelectedTaskId(v as string)}
              options={tasks.map((t) => ({
                label: `${t.project_name} · ${t.task_type}${t.status === 'failed' ? ' · ❌失败' : ''}`,
                value: t.id,
              }))}
              placeholder='选一个任务看日志'
              filterable
              style={{ width: 320 }}
              className={Style.ghostButton}
            />
            {selected && (
              <Space size={4}>
                {STATUS_ICON[selected.status]}
                <Tag size='small' theme='default' variant='light'>
                  {selected.task_type}
                </Tag>
                <span style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>
                  {selected.created_at ? new Date(selected.created_at).toLocaleString('zh-CN') : '-'}
                </span>
              </Space>
            )}
            <div className={Style.spacer} />
            <div style={{ position: 'relative' }}>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder='过滤日志文本'
                style={{
                  width: 200,
                  padding: '6px 10px 6px 28px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 14,
                  fontSize: 12,
                  outline: 'none',
                  background: '#141517',
                  color: '#f8fafc',
                }}
              />
              <SearchIcon style={{ position: 'absolute', left: 8, top: 7, color: '#94A3B8', fontSize: 14 }} />
            </div>
            <Button
              size='small'
              icon={<RefreshIcon />}
              onClick={() => {
                fetchTasks();
                if (selectedTaskId) fetchLogs(selectedTaskId);
              }}
              loading={tasksLoading || logsLoading}
            >
              刷新
            </Button>
          </div>
        </Card>

        {/* 日志流 */}
        <Card bordered={false} className={Style.panelCard}>
          {logsLoading ? (
            <Skeleton
              animation='gradient'
              theme='paragraph'
              loading
              rowCol={[
                { width: '100%', height: '16px' },
                { width: '95%', height: '16px' },
                { width: '88%', height: '16px' },
                { width: '96%', height: '16px' },
                { width: '70%', height: '16px' },
                { width: '90%', height: '16px' },
                { width: '82%', height: '16px' },
                { width: '75%', height: '16px' },
              ]}
            />
          ) : !selectedTaskId ? (
            <div className={Style.emptyState}>选一个任务开始看日志</div>
          ) : filteredLogs.length === 0 ? (
            <div className={Style.emptyState}>
              {logs.length === 0
                ? '后端 /logs/{task_id} 返回空 —— 可能还没记录，或该任务类型不产生事件日志'
                : '没有匹配过滤条件的日志行'}
            </div>
          ) : (
            <div className={Style.monoBox}>
              {filteredLogs.map((log, i) => (
                <LogRow key={i} log={log} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </AgentShell>
  );
};

const LogRow: React.FC<{ log: Record<string, unknown> }> = ({ log }) => {
  const level = String(log.level || log.severity || 'info').toLowerCase();
  const color = LEVEL_COLOR[level] || '#94A3B8';
  const ts = (log.ts || log.timestamp || log.time || log.created_at) as string | number | undefined;
  const tsStr = ts ? new Date(typeof ts === 'number' ? ts : ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  const msg = (log.message || log.msg || log.event || '') as string;
  const hasMsg = !!msg && typeof msg === 'string';

  return (
    <div
      style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '2px 0', borderBottom: '1px solid #1E293B' }}
    >
      {tsStr && <span style={{ color: '#64748B', minWidth: 80 }}>{tsStr}</span>}
      <span
        style={{
          color,
          fontWeight: 700,
          minWidth: 52,
          textTransform: 'uppercase',
          fontSize: 11,
          letterSpacing: 1,
        }}
      >
        {level}
      </span>
      <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
        {hasMsg ? <span>{msg}</span> : <span style={{ color: '#94A3B8' }}>{JSON.stringify(log)}</span>}
      </div>
    </div>
  );
};

export default Explorer;
