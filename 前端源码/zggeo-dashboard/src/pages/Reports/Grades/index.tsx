import React, { useEffect, useMemo, useState } from 'react';
import { Card, Table, Tag, Button, Space, PrimaryTableCol, MessagePlugin } from 'tdesign-react';
import { RefreshIcon, ChartIcon } from 'tdesign-icons-react';
import { useNavigate } from 'react-router-dom';
import { listTasks, AnalysisTaskRow } from 'services/zggeo-api';
import Style from '../linear.module.less';

/**
 * L4 产品化报告 · 等级分布
 * 数据源：GET /tasks?latest_only=true （每个项目最新一次评分）
 * 渲染：
 *   - 环形图（纯 SVG）按 grade 分布
 *   - 右侧指标卡：总体平均分 / 总数 / 及格率 / 优秀率
 *   - 下面表格：按等级分组的明细
 */

const GRADES = ['S', 'A', 'B', 'C', 'D', 'E'] as const;
type Grade = (typeof GRADES)[number];

const GRADE_META: Record<Grade, { color: string; label: string; range: string }> = {
  S: { color: '#059669', label: '卓越', range: '95-100' },
  A: { color: '#10B981', label: '优秀', range: '80-94' },
  B: { color: '#3B82F6', label: '良好', range: '70-79' },
  C: { color: '#F59E0B', label: '及格', range: '60-69' },
  D: { color: '#EF4444', label: '不及格', range: '40-59' },
  E: { color: '#991B1B', label: '严重不足', range: '0-39' },
};

// -------------------- 环形图（纯 SVG） --------------------
interface DonutSlice {
  grade: Grade;
  value: number;
  color: string;
}

const GradeDonut: React.FC<{ slices: DonutSlice[]; size?: number }> = ({ slices, size = 220 }) => {
  const total = slices.reduce((acc, s) => acc + s.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  const innerR = size * 0.24;

  if (total === 0) {
    return (
      <svg width={size} height={size}>
        <circle cx={cx} cy={cy} r={r} fill='none' stroke='#E5E7EB' strokeWidth={size * 0.14} />
        <text
          x={cx}
          y={cy}
          fontSize={14}
          fill='var(--td-text-color-placeholder)'
          textAnchor='middle'
          dominantBaseline='middle'
        >
          暂无数据
        </text>
      </svg>
    );
  }

  let accAngle = -90; // 从顶部开始
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const angle = (s.value / total) * 360;
      const startAngle = accAngle;
      const endAngle = accAngle + angle;
      accAngle = endAngle;

      const rad = (deg: number) => (deg * Math.PI) / 180;
      const x1 = cx + Math.cos(rad(startAngle)) * r;
      const y1 = cy + Math.sin(rad(startAngle)) * r;
      const x2 = cx + Math.cos(rad(endAngle)) * r;
      const y2 = cy + Math.sin(rad(endAngle)) * r;
      const largeArc = angle > 180 ? 1 : 0;

      const x3 = cx + Math.cos(rad(endAngle)) * innerR;
      const y3 = cy + Math.sin(rad(endAngle)) * innerR;
      const x4 = cx + Math.cos(rad(startAngle)) * innerR;
      const y4 = cy + Math.sin(rad(startAngle)) * innerR;

      const d = [
        `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
        `A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
        `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
        `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
        'Z',
      ].join(' ');

      // 标签位置（扇区中间，略外扩）
      const midAngle = (startAngle + endAngle) / 2;
      const labelR = (r + innerR) / 2;
      const lx = cx + Math.cos(rad(midAngle)) * labelR;
      const ly = cy + Math.sin(rad(midAngle)) * labelR;

      return { d, color: s.color, grade: s.grade, value: s.value, pct: s.value / total, lx, ly };
    });

  return (
    <svg width={size} height={size}>
      {arcs.map((a, i) => (
        <g key={i}>
          <path d={a.d} fill={a.color} stroke='#fff' strokeWidth={2} />
          {a.pct > 0.06 && (
            <text
              x={a.lx}
              y={a.ly}
              fontSize={13}
              fontWeight={700}
              fill='#fff'
              textAnchor='middle'
              dominantBaseline='middle'
            >
              {a.grade}
            </text>
          )}
        </g>
      ))}
      <text x={cx} y={cy - 6} fontSize={11} fill='var(--td-text-color-secondary)' textAnchor='middle'>
        参评项目
      </text>
      <text x={cx} y={cy + 14} fontSize={24} fontWeight={700} fill='var(--td-text-color-primary)' textAnchor='middle'>
        {total}
      </text>
    </svg>
  );
};

const Grades: React.FC = () => {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await listTasks({ latest_only: true });
      // 只看已完成 且 有评分的
      setTasks(data.filter((t) => t.status === 'completed' && typeof t.total_score === 'number'));
    } catch (e) {
      MessagePlugin.error('拉取等级分布数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const buckets = useMemo(() => {
    const map: Record<Grade, AnalysisTaskRow[]> = {
      S: [],
      A: [],
      B: [],
      C: [],
      D: [],
      E: [],
    };
    tasks.forEach((t) => {
      const g = (t.grade as Grade) || 'D';
      if (map[g]) map[g].push(t);
      else map.D.push(t);
    });
    return map;
  }, [tasks]);

  const metrics = useMemo(() => {
    const total = tasks.length;
    const scores = tasks.map((t) => t.total_score || 0);
    const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const passed = scores.filter((s) => s >= 60).length;
    const excellent = scores.filter((s) => s >= 80).length;
    return {
      total,
      avg,
      passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
      excellentRate: total > 0 ? Math.round((excellent / total) * 100) : 0,
    };
  }, [tasks]);

  const slices: DonutSlice[] = GRADES.map((g) => ({
    grade: g,
    value: buckets[g].length,
    color: GRADE_META[g].color,
  }));

  // 表格：展平 + 带 grade
  const tableData = useMemo(() => {
    const all: (AnalysisTaskRow & { _grade: Grade })[] = [];
    GRADES.forEach((g) => {
      buckets[g].forEach((t) => all.push({ ...t, _grade: g }));
    });
    return all;
  }, [buckets]);

  const columns: PrimaryTableCol<AnalysisTaskRow & { _grade: Grade }>[] = [
    {
      colKey: '_grade',
      title: '等级',
      width: 90,
      cell: ({ row }) => (
        <Tag
          style={{
            background: GRADE_META[row._grade].color,
            color: '#fff',
            border: 'none',
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          {row._grade}
        </Tag>
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
      colKey: 'total_score',
      title: '综合评分',
      width: 120,
      cell: ({ row }) => (
        <div style={{ fontSize: 18, fontWeight: 700, color: GRADE_META[row._grade].color }}>
          {row.total_score}
          <span style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginLeft: 4 }}>分</span>
        </div>
      ),
    },
    {
      colKey: 'summary_text',
      title: '摘要',
      ellipsis: true,
      cell: ({ row }) => (
        <span style={{ color: 'var(--td-text-color-secondary)', fontSize: 12 }}>{row.summary_text || '-'}</span>
      ),
    },
    {
      colKey: 'action',
      title: '操作',
      width: 100,
      fixed: 'right',
      cell: ({ row }) =>
        row.report_id ? (
          <Button
            size='small'
            variant='text'
            theme='primary'
            icon={<ChartIcon />}
            onClick={() => navigate(`/reports/scoring?report_id=${row.report_id}`)}
          >
            查看
          </Button>
        ) : (
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>-</span>
        ),
    },
  ];

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard} bodyStyle={{ padding: 24 }}>
        <Space size={8} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <Tag theme='primary' variant='light'>
            产品化报告
          </Tag>
          <Tag theme='success' variant='light'>
            等级分布
          </Tag>
        </Space>
        <div className={Style.heroTitle}>等级分布</div>
        <div className={Style.heroDesc}>
          汇总所有最新已完成评分，查看等级结构、均值、及格率和优秀率，帮助我们快速判断当前项目组合的总体健康度。
        </div>
      </Card>

      <div className={Style.statsGrid}>
        <Card bordered={false} className={Style.statCard}>
          <div className={Style.statLabel}>参评项目</div>
          <div className={Style.statValue}>{metrics.total}</div>
        </Card>
        <Card bordered={false} className={Style.statCard}>
          <div className={Style.statLabel}>综合平均分</div>
          <div className={Style.statValue} style={{ color: '#8b9cf9' }}>
            {metrics.avg}
          </div>
        </Card>
        <Card bordered={false} className={Style.statCard}>
          <div className={Style.statLabel}>及格率</div>
          <div className={Style.statValue} style={{ color: '#60a5fa' }}>
            {metrics.passRate}%
          </div>
        </Card>
        <Card bordered={false} className={Style.statCard}>
          <div className={Style.statLabel}>优秀率</div>
          <div className={Style.statValue} style={{ color: '#34d399' }}>
            {metrics.excellentRate}%
          </div>
        </Card>
      </div>

      <Card bordered={false} className={Style.sectionCard} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 32, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* 环形图 */}
          <div style={{ textAlign: 'center' }}>
            <GradeDonut slices={slices} />
          </div>

          {/* 等级图例 */}
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>等级明细</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
              {GRADES.map((g) => {
                const meta = GRADE_META[g];
                const count = buckets[g].length;
                const pct = metrics.total > 0 ? Math.round((count / metrics.total) * 100) : 0;
                return (
                  <div
                    key={g}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      background: 'rgba(255,255,255,0.03)',
                      borderRadius: 6,
                      borderLeft: `3px solid ${meta.color}`,
                    }}
                  >
                    <div
                      style={{
                        minWidth: 28,
                        height: 28,
                        borderRadius: 6,
                        background: meta.color,
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                      }}
                    >
                      {g}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{meta.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>{meta.range} 分</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: meta.color }}>{count}</div>
                      <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>{pct}%</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 聚合指标 */}
          <div style={{ minWidth: 200 }}>
            <div style={{ display: 'grid', gap: 16 }}>
              <MetricCard label='综合平均分' value={metrics.avg} suffix='分' color='#6366F1' />
              <MetricCard label='及格率 (≥60)' value={metrics.passRate} suffix='%' color='#3B82F6' />
              <MetricCard label='优秀率 (≥80)' value={metrics.excellentRate} suffix='%' color='#10B981' />
            </div>
          </div>
        </div>
      </Card>

      {/* 操作栏 */}
      <Card bordered={false} className={Style.sectionCard} style={{ marginBottom: 16 }}>
        <div className={Style.toolbarRow}>
          <Tag theme='success' variant='light'>
            来源：codex GET /tasks（每项目最新）
          </Tag>
          <Button icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </div>
      </Card>

      {/* 明细表 */}
      <Card bordered={false} className={Style.sectionCard}>
        <Table
          data={tableData}
          columns={columns}
          rowKey='id'
          loading={loading}
          size='medium'
          stripe
          hover
          empty='暂无已完成的评分任务'
        />
      </Card>
    </div>
  );
};

const MetricCard: React.FC<{ label: string; value: number; suffix: string; color: string }> = ({
  label,
  value,
  suffix,
  color,
}) => (
  <div
    style={{
      padding: '12px 16px',
      background: `${color}12`,
      borderRadius: 8,
      borderLeft: `3px solid ${color}`,
    }}
  >
    <div style={{ fontSize: 11, color: 'var(--td-text-color-secondary)', marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 700, color }}>
      {value}
      <span style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginLeft: 4 }}>{suffix}</span>
    </div>
  </div>
);

export default Grades;
