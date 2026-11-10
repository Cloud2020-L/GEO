import React, { useEffect, useState } from 'react';
import { Drawer, Tag, Button, Space, Divider, MessagePlugin, Loading, Tabs } from 'tdesign-react';
import {
  FileCopyIcon,
  RefreshIcon,
  ChartIcon,
  LinkIcon,
  TimeFilledIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  LoadingIcon,
  PlayCircleIcon,
} from 'tdesign-icons-react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector } from 'modules/store';
import { AnalysisTaskRow, createTask, getTaskLogs } from 'services/zggeo-api';

/**
 * 通用 · 任务详情 Drawer
 * 所有任务列表页点击"详情"都可以复用
 */

interface Props {
  visible: boolean;
  task: AnalysisTaskRow | null;
  onClose: () => void;
  onReran?: () => void; // 重跑成功回调，让父页面刷新列表
}

const STATUS_CONFIG: Record<
  string,
  { label: string; theme: 'success' | 'primary' | 'warning' | 'danger' | 'default'; icon: React.ReactElement }
> = {
  completed: { label: '已完成', theme: 'success', icon: <CheckCircleFilledIcon /> },
  running: { label: '分析中', theme: 'primary', icon: <LoadingIcon /> },
  pending: { label: '排队中', theme: 'warning', icon: <TimeFilledIcon /> },
  failed: { label: '失败', theme: 'danger', icon: <CloseCircleFilledIcon /> },
};

const GRADE_COLOR: Record<string, string> = {
  S: '#10B981',
  A: '#10B981',
  B: '#3B82F6',
  C: '#F59E0B',
  D: '#EF4444',
  E: '#EF4444',
};

const TaskDetailDrawer: React.FC<Props> = ({ visible, task, onClose, onReran }) => {
  const navigate = useNavigate();
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || '').toLowerCase();
  const canViewInternalReport = ['admin', 'operator'].includes(role);
  const [tab, setTab] = useState<'overview' | 'json' | 'logs'>('overview');
  const [logs, setLogs] = useState<Record<string, unknown>[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  useEffect(() => {
    if (!visible || !task) {
      setTab('overview');
      setLogs([]);
    }
    // 切到 logs tab 时懒加载
  }, [visible, task]);

  const fetchLogs = async () => {
    if (!task) return;
    setLogsLoading(true);
    try {
      const data = await getTaskLogs(task.id);
      setLogs(data || []);
    } catch (e) {
      // 后端可能还没实现，或者任务没日志，不吓唬用户
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  };

  const handleTabChange = (key: string) => {
    setTab(key as 'overview' | 'json' | 'logs');
    if (key === 'logs' && logs.length === 0) fetchLogs();
  };

  const handleCopy = async (text: string, label = '内容') => {
    try {
      await navigator.clipboard.writeText(text);
      MessagePlugin.success(`${label}已复制`);
    } catch {
      MessagePlugin.error('复制失败');
    }
  };

  const handleRerun = async () => {
    if (!task) return;
    setRerunning(true);
    try {
      const resp = await createTask({
        project_name: task.project_name,
        domain: task.domain,
        task_type: task.task_type,
        // 原任务的 keywords/urls 列表接口返回里没有，这里用域名占位
        // 后端会自动触发 fetcher 抓取
        urls: [`https://${task.domain}`],
      });
      MessagePlugin.success(`已创建新任务 ${resp.task_id.slice(0, 8)}...`);
      onReran?.();
      onClose();
    } catch (e) {
      MessagePlugin.error('重跑失败，后端拒绝了请求');
    } finally {
      setRerunning(false);
    }
  };

  if (!task) return null;

  const statusCfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const gradeColor = GRADE_COLOR[task.grade || 'C'];

  return (
    <Drawer
      visible={visible}
      onClose={onClose}
      header={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>监测任务详情</span>
          <Tag theme={statusCfg.theme} variant='light' icon={statusCfg.icon}>
            {statusCfg.label}
          </Tag>
        </div>
      }
      size='560px'
      footer={
        <Space>
          {task.report_id && (
            <Button
              icon={<ChartIcon />}
              onClick={() => {
                navigate(`/visibility-monitoring/diagnosis/report?report_id=${task.report_id}`);
                onClose();
              }}
            >
              查看报告
            </Button>
          )}
          {task.report_id && canViewInternalReport && (
            <Button
              variant='outline'
              icon={<ChartIcon />}
              onClick={() => {
                navigate(`/reports/scoring?report_id=${task.report_id}`);
                onClose();
              }}
            >
              内部分析
            </Button>
          )}
          <Button theme='primary' icon={<PlayCircleIcon />} loading={rerunning} onClick={handleRerun}>
            按相同配置重跑
          </Button>
        </Space>
      }
    >
      {/* 顶部卡片 */}
      <div
        style={{
          background: 'linear-gradient(135deg, #EEF2FF 0%, #F3E8FF 100%)',
          padding: 16,
          borderRadius: 10,
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 12, color: '#4B5563' }}>项目</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1F2937', marginTop: 4 }}>{task.project_name}</div>
        <div style={{ fontSize: 13, color: '#6B7280', marginTop: 2 }}>
          <LinkIcon style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {task.domain}
        </div>
        {task.total_score !== undefined && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 36, fontWeight: 800, color: gradeColor }}>{task.total_score}</span>
            <span style={{ fontSize: 12, color: '#6B7280' }}>分</span>
            {task.grade && (
              <Tag
                style={{
                  background: gradeColor,
                  color: '#fff',
                  border: 'none',
                  fontWeight: 700,
                  marginLeft: 8,
                }}
              >
                {task.grade} 级
              </Tag>
            )}
          </div>
        )}
      </div>

      {/* Tab 切换 */}
      <Tabs value={tab} onChange={(v) => handleTabChange(v as string)} theme='card'>
        <Tabs.TabPanel value='overview' label='概览' />
        <Tabs.TabPanel value='json' label='原始 JSON' />
        <Tabs.TabPanel value='logs' label='执行日志' />
      </Tabs>

      <div style={{ marginTop: 12 }}>
        {tab === 'overview' && <OverviewTab task={task} onCopy={handleCopy} />}
        {tab === 'json' && <JsonTab task={task} onCopy={handleCopy} />}
        {tab === 'logs' && <LogsTab logs={logs} loading={logsLoading} />}
      </div>
    </Drawer>
  );
};

// -------------------- 概览 Tab --------------------
const OverviewTab: React.FC<{
  task: AnalysisTaskRow;
  onCopy: (text: string, label?: string) => void;
}> = ({ task, onCopy }) => (
  <div>
    <KV label='任务 ID'>
      <code style={{ fontSize: 12 }}>{task.id}</code>
      <Button size='small' variant='text' icon={<FileCopyIcon />} onClick={() => onCopy(task.id, '任务 ID')} />
    </KV>
    <KV label='任务类型'>
      <Tag theme='primary' variant='light'>
        {task.task_type}
      </Tag>
    </KV>
    <KV label='创建时间'>{task.created_at ? new Date(task.created_at).toLocaleString('zh-CN') : '-'}</KV>
    <KV label='完成时间'>{task.finished_at ? new Date(task.finished_at).toLocaleString('zh-CN') : '—'}</KV>
    {task.report_id && (
      <KV label='报告 ID'>
        <code style={{ fontSize: 12 }}>{task.report_id}</code>
        <Button
          size='small'
          variant='text'
          icon={<FileCopyIcon />}
          onClick={() => onCopy(task.report_id as string, '报告 ID')}
        />
      </KV>
    )}
    {task.report_version && <KV label='报告版本'>{task.report_version}</KV>}

    <Divider />

    {/* 标记 */}
    <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginBottom: 8 }}>标记</div>
    <Space>
      {task.is_latest_report && (
        <Tag theme='success' variant='light'>
          最新版本
        </Tag>
      )}
      {task.is_legacy_report && (
        <Tag theme='default' variant='light'>
          历史版本
        </Tag>
      )}
      {task.is_productized_report && (
        <Tag theme='primary' variant='light'>
          产品化报告
        </Tag>
      )}
      {!task.is_latest_report && !task.is_legacy_report && !task.is_productized_report && (
        <span style={{ color: 'var(--td-text-color-placeholder)' }}>无</span>
      )}
    </Space>

    {task.summary_text && (
      <>
        <Divider />
        <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginBottom: 8 }}>执行摘要</div>
        <div
          style={{
            padding: 12,
            background: '#FAFAFA',
            borderRadius: 6,
            fontSize: 13,
            lineHeight: 1.7,
            color: '#374151',
          }}
        >
          {task.summary_text}
        </div>
      </>
    )}
  </div>
);

// -------------------- JSON Tab --------------------
const JsonTab: React.FC<{
  task: AnalysisTaskRow;
  onCopy: (text: string, label?: string) => void;
}> = ({ task, onCopy }) => {
  const jsonStr = JSON.stringify(task, null, 2);
  return (
    <div>
      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end' }}>
        <Button size='small' variant='outline' icon={<FileCopyIcon />} onClick={() => onCopy(jsonStr, '任务 JSON')}>
          复制全文
        </Button>
      </div>
      <pre
        style={{
          background: '#1F2937',
          color: '#F9FAFB',
          padding: 14,
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.6,
          overflow: 'auto',
          maxHeight: 460,
          margin: 0,
          fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace',
        }}
      >
        {jsonStr}
      </pre>
    </div>
  );
};

// -------------------- 日志 Tab --------------------
const LogsTab: React.FC<{ logs: Record<string, unknown>[]; loading: boolean }> = ({ logs, loading }) => {
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 32 }}>
        <Loading />
        <div style={{ marginTop: 8, color: 'var(--td-text-color-secondary)', fontSize: 12 }}>拉取日志中...</div>
      </div>
    );
  }
  if (logs.length === 0) {
    return (
      <div
        style={{
          textAlign: 'center',
          padding: 32,
          color: 'var(--td-text-color-placeholder)',
          fontSize: 13,
        }}
      >
        暂无日志（后端 /logs/{'{task_id}'} 尚未记录本任务事件）
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {logs.map((log, i) => (
        <div
          key={i}
          style={{
            padding: 10,
            background: '#FAFAFA',
            borderRadius: 6,
            fontSize: 12,
            fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace',
          }}
        >
          {JSON.stringify(log)}
        </div>
      ))}
    </div>
  );
};

// -------------------- 小组件 --------------------
const KV: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div
    style={{
      display: 'flex',
      gap: 12,
      alignItems: 'center',
      padding: '6px 0',
      fontSize: 13,
    }}
  >
    <div style={{ minWidth: 90, color: 'var(--td-text-color-secondary)' }}>{label}</div>
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>{children}</div>
  </div>
);

export default TaskDetailDrawer;
