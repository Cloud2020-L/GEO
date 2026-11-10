import React, { useEffect, useMemo, useState } from 'react';
import { Card, Table, Tag, Input, Select, Button, Space, PrimaryTableCol, MessagePlugin } from 'tdesign-react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector } from 'modules/store';
import {
  RefreshIcon,
  SearchIcon,
  ChartIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  LoadingIcon,
  TimeFilledIcon,
} from 'tdesign-icons-react';
import { listTasks, AnalysisTaskRow } from 'services/zggeo-api';
import TaskDetailDrawer from 'components/TaskDetailDrawer';
import styles from '../linear.module.less';

/**
 * L3 监测诊断 · 历史任务
 * 数据源：codex GET /tasks (latest_only=false) —— 包含同一项目所有历史评分
 * 视角：
 *   - 表格视图：按时间倒序全量
 *   - 时间线视图：按项目/域名分组，看评分走势
 */

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

const VIEW_OPTIONS = [
  { label: '表格视图', value: 'table' },
  { label: '项目时间线', value: 'timeline' },
];

// -------------------- 迷你折线（纯 SVG）--------------------
const ScoreSparkline: React.FC<{
  scores: number[];
  width?: number;
  height?: number;
}> = ({ scores, width = 140, height = 36 }) => {
  if (scores.length === 0) return null;
  const pad = 4;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const max = 100;
  const min = 0;

  const points = scores
    .map((s, i) => {
      const x = scores.length === 1 ? w / 2 : (i / (scores.length - 1)) * w;
      const y = h - ((s - min) / (max - min)) * h;
      return `${(x + pad).toFixed(1)},${(y + pad).toFixed(1)}`;
    })
    .join(' ');

  const last = scores[scores.length - 1];
  const strokeColor = last >= 80 ? '#10B981' : last >= 60 ? '#3B82F6' : last >= 40 ? '#F59E0B' : '#EF4444';

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={points} fill='none' stroke={strokeColor} strokeWidth={1.5} strokeLinejoin='round' />
      {scores.map((s, i) => {
        const x = scores.length === 1 ? w / 2 : (i / (scores.length - 1)) * w;
        const y = h - ((s - min) / (max - min)) * h;
        return <circle key={i} cx={x + pad} cy={y + pad} r={1.8} fill={strokeColor} />;
      })}
    </svg>
  );
};

const History: React.FC = () => {
  const navigate = useNavigate();
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || '').toLowerCase();
  const canViewInternalReport = ['admin', 'operator'].includes(role);
  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [view, setView] = useState<'table' | 'timeline'>('table');

  // 任务详情 Drawer
  const [detailOpen, setDetailOpen] = useState(false);
  const [currentTask, setCurrentTask] = useState<AnalysisTaskRow | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await listTasks({ latest_only: false });
      setTasks(data);
    } catch (e) {
      MessagePlugin.error('拉取历史任务失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const filteredTasks = useMemo(() => {
    if (!keyword.trim()) return tasks;
    const kw = keyword.trim().toLowerCase();
    return tasks.filter(
      (t) =>
        t.project_name?.toLowerCase().includes(kw) ||
        t.domain?.toLowerCase().includes(kw) ||
        t.task_type?.toLowerCase().includes(kw),
    );
  }, [tasks, keyword]);

  // 按项目分组 + 时间正序，方便画走势
  const groups = useMemo(() => {
    const g: Record<string, AnalysisTaskRow[]> = {};
    filteredTasks.forEach((t) => {
      const k = `${t.project_name}||${t.domain}`;
      if (!g[k]) g[k] = [];
      g[k].push(t);
    });
    return Object.entries(g)
      .map(([k, rows]) => {
        const [name, domain] = k.split('||');
        const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
        const scores = sorted.map((r) => r.total_score || 0);
        const latest = sorted[sorted.length - 1];
        const delta = scores.length > 1 ? scores[scores.length - 1] - scores[0] : 0;
        return { project_name: name, domain, runs: sorted, scores, latest, delta };
      })
      .sort((a, b) => (b.latest?.created_at || '').localeCompare(a.latest?.created_at || ''));
  }, [filteredTasks]);

  const columns: PrimaryTableCol<AnalysisTaskRow>[] = [
    {
      colKey: 'created_at',
      title: '执行时间',
      width: 180,
      cell: ({ row }) => (
        <span style={{ color: 'var(--td-text-color-secondary)' }}>
          {row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : '-'}
        </span>
      ),
    },
    {
      colKey: 'project_name',
      title: '项目 / 域名',
      ellipsis: true,
      cell: ({ row }) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.project_name}</div>
          <div style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)' }}>{row.domain}</div>
        </div>
      ),
    },
    {
      colKey: 'task_type',
      title: '任务类型',
      width: 180,
      cell: ({ row }) => (
        <Tag theme='primary' variant='light'>
          {row.task_type}
        </Tag>
      ),
    },
    {
      colKey: 'status',
      title: '状态',
      width: 110,
      cell: ({ row }) => {
        const c = STATUS_CONFIG[row.status] || STATUS_CONFIG.pending;
        return (
          <Tag theme={c.theme} variant='light' icon={c.icon}>
            {c.label}
          </Tag>
        );
      },
    },
    {
      colKey: 'total_score',
      title: '综合评分',
      width: 130,
      cell: ({ row }) => {
        if (!row.total_score) return <span style={{ color: 'var(--td-text-color-placeholder)' }}>-</span>;
        return (
          <Space size={6} align='center'>
            <span style={{ fontSize: 16, fontWeight: 700, color: GRADE_COLOR[row.grade || 'C'] }}>
              {row.total_score}
            </span>
            <span style={{ color: 'var(--td-text-color-placeholder)', fontSize: 11 }}>分</span>
            {row.grade && (
              <Tag size='small' style={{ background: GRADE_COLOR[row.grade], color: '#fff', border: 'none' }}>
                {row.grade}
              </Tag>
            )}
          </Space>
        );
      },
    },
    {
      colKey: 'is_latest_report',
      title: '标记',
      width: 130,
      cell: ({ row }) => (
        <Space size={4} direction='vertical' style={{ gap: 2 }}>
          {row.is_latest_report && (
            <Tag size='small' theme='success' variant='light'>
              最新
            </Tag>
          )}
          {row.is_legacy_report && (
            <Tag size='small' theme='default' variant='light'>
              历史版本
            </Tag>
          )}
        </Space>
      ),
    },
    {
      colKey: 'action',
      title: '操作',
      width: 160,
      cell: ({ row }) => (
        <Space size={2}>
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
          {row.report_id ? (
            <>
              <Button
                size='small'
                variant='text'
                theme='primary'
                onClick={() => navigate(`/visibility-monitoring/diagnosis/report?report_id=${row.report_id}`)}
              >
                报告
              </Button>
              {canViewInternalReport && (
                <Button
                  size='small'
                  variant='text'
                  theme='primary'
                  onClick={() => navigate(`/reports/scoring?report_id=${row.report_id}`)}
                >
                  内部分析
                </Button>
              )}
            </>
          ) : null}
        </Space>
      ),
    },
  ];

  // -------------------- 汇总指标 --------------------
  const summary = useMemo(() => {
    const completed = tasks.filter((t) => t.status === 'completed');
    const projectSet = new Set(tasks.map((t) => `${t.project_name}||${t.domain}`));
    const legacy = tasks.filter((t) => t.is_legacy_report).length;
    return {
      total: tasks.length,
      completed: completed.length,
      projects: projectSet.size,
      legacy,
    };
  }, [tasks]);

  return (
    <div className={styles.page}>
      {/* 顶部汇总 */}
      <Card bordered={false} className={styles.sectionCard}>
        <div className={styles.statsGrid}>
          <StatItem label='历史任务总数' value={summary.total} color='#6366F1' />
          <StatItem label='已完成' value={summary.completed} color='#10B981' />
          <StatItem label='覆盖项目' value={summary.projects} color='#3B82F6' />
          <StatItem label='历史版本' value={summary.legacy} color='#F59E0B' suffix='条' />
        </div>
      </Card>

      {/* 操作栏 */}
      <Card bordered={false} className={styles.toolbarCard}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input
            prefixIcon={<SearchIcon />}
            placeholder='搜项目 / 域名 / 类型'
            value={keyword}
            onChange={(v) => setKeyword(v as string)}
            style={{ width: 280 }}
          />
          <Select
            value={view}
            options={VIEW_OPTIONS}
            onChange={(v) => setView(v as 'table' | 'timeline')}
            style={{ width: 160 }}
          />
          <div style={{ flex: 1 }} />
          <Tag theme='success' variant='light'>
            来源：codex GET /tasks
          </Tag>
          <Button icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </div>
      </Card>

      {/* 主体 */}
      {view === 'table' ? (
        <Card bordered={false} className={styles.sectionCard}>
          <div className={styles.tableScroll}>
            <Table
              data={filteredTasks}
              columns={columns}
              rowKey='id'
              loading={loading}
              size='medium'
              stripe
              hover
              empty='暂无历史任务'
            />
          </div>
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {groups.length === 0 && (
            <Card
              bordered={false}
              className={styles.sectionCard}
              style={{ padding: 48, textAlign: 'center', color: 'var(--td-text-color-placeholder)' }}
            >
              暂无数据
            </Card>
          )}
          {groups.map((g) => (
            <Card key={g.project_name + g.domain} bordered={false} className={styles.itemCard} hoverShadow>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{g.project_name}</div>
                  <div style={{ color: 'var(--td-text-color-placeholder)', fontSize: 12 }}>{g.domain}</div>
                </div>
                <div style={{ width: 160 }}>
                  <ScoreSparkline scores={g.scores} />
                  <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)', marginTop: 2 }}>
                    {g.runs.length} 次评分 · 跨度 {g.scores[0]} → {g.scores[g.scores.length - 1]}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: GRADE_COLOR[g.latest?.grade || 'C'] }}>
                    {g.latest?.total_score ?? '-'}
                    <span style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginLeft: 4 }}>分</span>
                  </div>
                  <div style={{ fontSize: 11 }}>
                    {g.delta > 0 ? (
                      <span style={{ color: '#10B981' }}>↑ +{g.delta}</span>
                    ) : g.delta < 0 ? (
                      <span style={{ color: '#EF4444' }}>↓ {g.delta}</span>
                    ) : (
                      <span style={{ color: 'var(--td-text-color-placeholder)' }}>持平</span>
                    )}
                  </div>
                </div>
                <Button
                  size='small'
                  theme='primary'
                  variant='outline'
                  icon={<ChartIcon />}
                  onClick={() =>
                    g.latest?.report_id &&
                    navigate(`/visibility-monitoring/diagnosis/report?report_id=${g.latest.report_id}`)
                  }
                  disabled={!g.latest?.report_id}
                >
                  最新报告
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

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

// -------------------- 小组件 --------------------
const StatItem: React.FC<{ label: string; value: number | string; color: string; suffix?: string }> = ({
  label,
  value,
  color,
  suffix,
}) => (
  <Card bordered={false} className={styles.statCard}>
    <div className={styles.statLabel}>{label}</div>
    <div>
      <span className={styles.statValue} style={{ color, marginTop: 4 }}>
        {value}
      </span>
      {suffix && (
        <span style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginLeft: 4 }}>{suffix}</span>
      )}
    </div>
  </Card>
);

export default History;
