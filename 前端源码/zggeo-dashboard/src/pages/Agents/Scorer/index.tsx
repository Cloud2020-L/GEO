import React, { useEffect, useMemo, useState } from 'react';
import { Card, Tag, Button, MessagePlugin, Skeleton } from 'tdesign-react';
import { RefreshIcon, ChartIcon } from 'tdesign-icons-react';
import { useNavigate } from 'react-router-dom';
import AgentShell, { AgentMeta, AgentStatus } from 'components/AgentShell';
import { listTasks, getReportsBatch, AnalysisTaskRow, ReportResponse } from 'services/zggeo-api';
import Style from '../linear.module.less';

/**
 * 星核 · 评分 Agent
 * 职责：综合评分 + 等级划分 + 维度分布
 */

const META: AgentMeta = {
  key: 'scorer',
  name: '星核',
  title: '评分',
  emoji: '🎯',
  tagline: '用 4 维 × 权重把 AI 回答量化成 0-100 分',
  description:
    '星核把每一份报告按「可见度 / 内容覆盖 / 结构 / 信任」4 维打分，乘以权重得综合分，再根据综合分划 S/A/B/C/D 等级。评分引擎的稳定性直接决定智改 GEO 的核心 SLA。',
  color: '#EF4444',
  gradient: ['#F43F5E', '#EF4444'],
  apis: ['GET /tasks?latest_only=true', 'GET /reports/{report_id}'],
};

const GRADE_ORDER = ['S', 'A', 'B', 'C', 'D', 'E'];
const GRADE_COLOR: Record<string, string> = {
  S: '#059669',
  A: '#10B981',
  B: '#3B82F6',
  C: '#F59E0B',
  D: '#EF4444',
  E: '#DC2626',
};

const DIMENSIONS = [
  { key: 'visibility_score', label: '可见度', color: '#6366F1' },
  { key: 'structure_score', label: '结构', color: '#10B981' },
  { key: 'trust_score', label: '信任', color: '#F59E0B' },
  { key: 'content_coverage_score', label: '内容覆盖', color: '#EF4444' },
];

const Scorer: React.FC = () => {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [reports, setReports] = useState<ReportResponse[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const t = await listTasks({ latest_only: true });
      setTasks(t);
      const ids = t.filter((x) => x.status === 'completed' && x.report_id).map((x) => x.report_id as string);
      if (ids.length > 0) {
        const rs = await getReportsBatch(ids);
        setReports(rs);
      } else {
        setReports([]);
      }
    } catch {
      MessagePlugin.error('拉取评分数据失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    fetchData();
  }, []);

  const stats = useMemo(() => {
    const completed = tasks.filter((t) => t.status === 'completed' && typeof t.total_score === 'number');
    const scores = completed.map((t) => t.total_score as number);
    const total = completed.length;
    const avg = total > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / total) : 0;
    const max = total > 0 ? Math.max(...scores) : 0;
    const min = total > 0 ? Math.min(...scores) : 0;
    const passed = scores.filter((s) => s >= 60).length;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    const excellent = scores.filter((s) => s >= 80).length;

    // 等级分布
    const gradeDist: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0, E: 0 };
    completed.forEach((t) => {
      const g = (t.grade || 'C').toUpperCase();
      if (gradeDist[g] !== undefined) gradeDist[g] += 1;
    });

    // 维度均值（基于 reports）
    const dimAvg: Record<string, number> = {};
    DIMENSIONS.forEach((d) => {
      const vals = reports.map((r: any) => r[d.key]).filter((v) => typeof v === 'number');
      dimAvg[d.key] = vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    });

    // 健康度：平均分 + 通过率
    const health = Math.round((avg + passRate) / 2);
    let agentStatus: AgentStatus = 'running';
    if (total === 0) agentStatus = 'idle';
    else if (passRate < 40) agentStatus = 'error';

    return {
      total,
      avg,
      max,
      min,
      passed,
      passRate,
      excellent,
      gradeDist,
      dimAvg,
      health,
      agentStatus,
    };
  }, [tasks, reports]);

  return (
    <AgentShell
      meta={META}
      status={stats.agentStatus}
      health={stats.health}
      variant='linear'
      metrics={[
        { label: '已评分项目', value: stats.total },
        { label: '平均分', value: stats.avg, hint: `最高 ${stats.max} / 最低 ${stats.min}` },
        { label: '达标率 (≥60)', value: `${stats.passRate}%`, hint: `${stats.passed} 个及格` },
        { label: '优秀数 (≥80)', value: stats.excellent },
      ]}
    >
      {/* 工具条 */}
      <div className={Style.page}>
        <Card bordered={false} className={`${Style.toolbarCard} ${Style.ghostButton}`} style={{ marginBottom: 16 }}>
          <div className={Style.toolbar}>
            <ChartIcon style={{ color: META.color }} />
            <span className={Style.toolbarTitle}>评分引擎运行时</span>
            <Tag theme='default' variant='light'>
              {reports.length} 份报告参与统计
            </Tag>
            <div className={Style.spacer} />
            <Button size='small' icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
              刷新
            </Button>
            <Button size='small' variant='outline' theme='primary' onClick={() => navigate('/reports/grades')}>
              去等级分布大图
            </Button>
          </div>
        </Card>

        {/* 两栏：左等级分布，右维度均值 */}
        <div className={Style.grid2} style={{ marginBottom: 16 }}>
          <Card bordered={false} className={Style.panelCard}>
            <div className={Style.sectionTitle} style={{ marginTop: 0, fontSize: 16, marginBottom: 12 }}>
              等级分布
            </div>
            {loading && stats.total === 0 ? (
              <Skeleton
                animation='gradient'
                theme='paragraph'
                loading
                rowCol={[
                  { width: '100%', height: 'px' },
                  { width: '100%', height: 'px' },
                  { width: '100%', height: 'px' },
                  { width: '100%', height: 'px' },
                  { width: '100%', height: 'px' },
                ]}
              />
            ) : stats.total === 0 ? (
              <div className={Style.emptyState}>暂无评分数据</div>
            ) : (
              <div className={Style.bars}>
                {GRADE_ORDER.map((g) => {
                  const n = stats.gradeDist[g] || 0;
                  const pct = stats.total > 0 ? (n / stats.total) * 100 : 0;
                  return (
                    <div key={g} className={Style.barRow}>
                      <div className={Style.barHead}>
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 8,
                            background: GRADE_COLOR[g],
                            color: '#fff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 700,
                          }}
                        >
                          {g}
                        </div>
                        <div className={Style.spacer} />
                        <div style={{ color: GRADE_COLOR[g], fontWeight: 700 }}>{n}</div>
                        <div style={{ color: 'rgba(243,244,246,0.42)' }}>{pct.toFixed(0)}%</div>
                      </div>
                      <div className={Style.barTrack}>
                        <div
                          className={Style.barFill}
                          style={{
                            width: `${pct}%`,
                            background: `linear-gradient(90deg, ${GRADE_COLOR[g]}, ${GRADE_COLOR[g]}99)`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card bordered={false} className={Style.panelCard}>
            <div className={Style.sectionTitle} style={{ marginTop: 0, fontSize: 16, marginBottom: 12 }}>
              维度均分
            </div>
            {loading && reports.length === 0 ? (
              <Skeleton
                animation='gradient'
                theme='paragraph'
                loading
                rowCol={[
                  { width: '100%', height: 'px' },
                  { width: '100%', height: 'px' },
                  { width: '100%', height: 'px' },
                  { width: '100%', height: 'px' },
                ]}
              />
            ) : reports.length === 0 ? (
              <div className={Style.emptyState}>暂无维度数据</div>
            ) : (
              <div className={Style.bars}>
                {DIMENSIONS.map((d) => {
                  const v = stats.dimAvg[d.key] || 0;
                  return (
                    <div key={d.key} className={Style.barRow}>
                      <div className={Style.barHead}>
                        <span style={{ color: d.color, fontWeight: 600 }}>{d.label}</span>
                        <div className={Style.spacer} />
                        <span style={{ fontWeight: 700, color: d.color }}>{v}</span>
                        <span style={{ color: 'rgba(243,244,246,0.42)', marginLeft: 2 }}>/100</span>
                      </div>
                      <div className={Style.barTrack}>
                        <div
                          className={Style.barFill}
                          style={{
                            width: `${v}%`,
                            background: `linear-gradient(90deg, ${d.color}, ${d.color}AA)`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Top / Bottom 报告 */}
        <div className={Style.grid2}>
          <Card bordered={false} className={Style.panelCard}>
            <div className={Style.sectionTitle} style={{ marginTop: 0, fontSize: 16, marginBottom: 10 }}>
              Top 5 项目
            </div>
            <TopList tasks={tasks} order='desc' onClick={(id) => navigate(`/reports/scoring?report_id=${id}`)} />
          </Card>
          <Card bordered={false} className={Style.panelCard}>
            <div className={Style.sectionTitle} style={{ marginTop: 0, fontSize: 16, marginBottom: 10 }}>
              待改进 5 项
            </div>
            <TopList tasks={tasks} order='asc' onClick={(id) => navigate(`/reports/scoring?report_id=${id}`)} />
          </Card>
        </div>
      </div>
    </AgentShell>
  );
};

const TopList: React.FC<{
  tasks: AnalysisTaskRow[];
  order: 'asc' | 'desc';
  onClick: (reportId: string) => void;
}> = ({ tasks, order, onClick }) => {
  const items = tasks
    .filter((t) => t.status === 'completed' && typeof t.total_score === 'number' && t.report_id)
    .sort((a, b) => (order === 'desc' ? b.total_score! - a.total_score! : a.total_score! - b.total_score!))
    .slice(0, 5);

  if (items.length === 0) {
    return <div className={Style.emptyState}>暂无数据</div>;
  }
  return (
    <div className={Style.listGrid}>
      {items.map((t) => (
        <div key={t.id} onClick={() => onClick(t.report_id!)} className={Style.listItem} style={{ cursor: 'pointer' }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: GRADE_COLOR[t.grade || 'C'],
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 14,
            }}
          >
            {t.total_score}
          </div>
          <div className={Style.listItemCol}>
            <div
              className={Style.itemTitle}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {t.project_name}
            </div>
            <div className={Style.itemSub}>{t.domain}</div>
          </div>
          <Tag size='small' style={{ background: GRADE_COLOR[t.grade || 'C'], color: '#fff', border: 'none' }}>
            {t.grade || 'C'}
          </Tag>
        </div>
      ))}
    </div>
  );
};

export default Scorer;
