import React, { useEffect, useMemo, useState } from 'react';
import { Card, Tag, Button, MessagePlugin, Skeleton } from 'tdesign-react';
import {
  RefreshIcon,
  SettingIcon,
  CheckCircleFilledIcon,
  ThunderIcon,
  LockOnIcon,
  InfoCircleFilledIcon,
} from 'tdesign-icons-react';
import { useNavigate } from 'react-router-dom';
import AgentShell, { AgentMeta, AgentStatus } from 'components/AgentShell';
import {
  listTasks,
  getReportsBatch,
  listModelProviders,
  AnalysisTaskRow,
  ModelProviderRow,
  ReportResponse,
} from 'services/zggeo-api';

/**
 * 星穹 · 校准 Agent
 * 职责：跨模型一致性 / 维度权重校准 / 漂移告警
 *
 * 说明：codex 后端模型网关已上线，
 * 这里先展示：
 *   1) /models/providers 真实配置状态
 *   2) 基于真实 reports 计算"维度失衡"作为漂移代理指标
 *   3) 推荐需要重新校准的项目
 */

const META: AgentMeta = {
  key: 'calibrator',
  name: '星穹',
  title: '校准',
  emoji: '🧭',
  tagline: '盯 8 大模型的评分一致性，漂移了就拉回来',
  description:
    '星穹负责评分体系的质量控制：监测多个 AI 模型返回结果是否在同一尺度上、各维度权重是否合理，一旦某类项目出现异常维度失衡就触发重校准。当前已接入 codex 模型网关，页面显示真实模型配置和报告漂移代理指标。',
  color: '#F59E0B',
  gradient: ['#F59E0B', '#D97706'],
  apis: ['GET /models/providers', 'POST /models/regression', 'GET /tasks?latest_only=true', 'GET /reports/{id}'],
};

const STATUS_CFG: Record<string, { label: string; color: string; icon: React.ReactElement }> = {
  configured: { label: '已配置', color: '#10B981', icon: <CheckCircleFilledIcon /> },
  unconfigured: { label: '未配置', color: '#EF4444', icon: <ThunderIcon /> },
  planned: { label: '待适配', color: '#94A3B8', icon: <LockOnIcon /> },
};

const DIM_KEYS: (keyof ReportResponse)[] = [
  'visibility_score',
  'structure_score',
  'trust_score',
  'content_coverage_score',
];

const Calibrator: React.FC = () => {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [reports, setReports] = useState<ReportResponse[]>([]);
  const [providers, setProviders] = useState<ModelProviderRow[]>([]);
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
      const modelData = await listModelProviders();
      setProviders(modelData.providers);
    } catch {
      MessagePlugin.error('拉取校准数据失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    fetchData();
  }, []);

  // 漂移检测：每份报告 4 维分数的最大差值 > 30 视为"维度失衡"
  const driftList = useMemo(() => {
    return reports
      .map((r) => {
        const vals = DIM_KEYS.map((k) => Number(r[k] || 0));
        const max = Math.max(...vals);
        const min = Math.min(...vals);
        const spread = max - min;
        return { report: r, spread, max, min };
      })
      .filter((x) => x.spread >= 30)
      .sort((a, b) => b.spread - a.spread)
      .slice(0, 8);
  }, [reports]);

  const stats = useMemo(() => {
    const configured = providers.filter((m) => m.configured).length;
    const unconfigured = providers.filter((m) => m.status === 'unconfigured').length;
    const planned = providers.filter((m) => m.status === 'planned').length;

    // 覆盖率
    const coverage = providers.length > 0 ? Math.round((configured / providers.length) * 100) : 0;

    // 全局维度标准差：各维度在所有报告里的标准差越大 = 项目间越不一致
    const dimStd: Record<string, number> = {};
    DIM_KEYS.forEach((k) => {
      const vals = reports.map((r) => Number(r[k] || 0));
      if (vals.length === 0) {
        dimStd[k] = 0;
        return;
      }
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
      dimStd[k] = Math.round(Math.sqrt(variance));
    });

    // 健康度：接入率权重 60 + (100 - 平均维度失衡率) 权重 40
    const driftRatio = reports.length > 0 ? driftList.length / reports.length : 0;
    const health = Math.round(coverage * 0.6 + (1 - driftRatio) * 100 * 0.4);

    let agentStatus: AgentStatus = 'running';
    if (configured === 0) agentStatus = 'error';
    else if (configured === providers.length) agentStatus = 'running';
    else agentStatus = 'beta';

    return { configured, unconfigured, planned, coverage, dimStd, driftRatio, health, agentStatus };
  }, [reports, driftList, providers]);

  return (
    <AgentShell
      meta={META}
      status={stats.agentStatus}
      health={stats.health}
      metrics={[
        { label: '模型配置率', value: `${stats.coverage}%`, hint: `${stats.configured} / ${providers.length} 已配置` },
        { label: '未配置', value: stats.unconfigured, hint: '缺 Key/模型 ID' },
        { label: '漂移报告', value: driftList.length, hint: '维度差 ≥ 30' },
        { label: '参考样本', value: reports.length, hint: '纳入统计的报告' },
      ]}
    >
      {/* 说明条 */}
      <Card
        bordered={false}
        style={{
          background: 'linear-gradient(135deg, #FEF3C7 0%, #FDE68A 100%)',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <InfoCircleFilledIcon style={{ color: '#B45309', fontSize: 20, marginTop: 2 }} />
          <div style={{ flex: 1, fontSize: 13, color: '#78350F', lineHeight: 1.7 }}>
            模型网关已上线：这里读取 <code>/models/providers</code> 的真实配置状态，并继续用
            "维度失衡"（单份报告里最高维 − 最低维 ≥ 30 分）作为校准漂移代理指标。 需要真实跑多模型时，到 A/B 校准页触发{' '}
            <code>/models/regression</code>。
          </div>
          <Button size='small' theme='warning' variant='outline' onClick={() => navigate('/monitoring/calibration')}>
            查看完整基准
          </Button>
        </div>
      </Card>

      {/* 模型接入 */}
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <SettingIcon style={{ color: META.color, marginRight: 8 }} />
          <span style={{ fontWeight: 600 }}>模型网关接入状态</span>
          <div style={{ flex: 1 }} />
          <Button size='small' icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {providers.map((m) => {
            const s = STATUS_CFG[m.status] || STATUS_CFG.unconfigured;
            return (
              <div
                key={m.key}
                style={{
                  padding: 12,
                  background: '#fff',
                  borderRadius: 8,
                  border: `1px solid ${s.color}33`,
                  borderLeft: `3px solid ${s.color}`,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{m.name}</div>
                <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)', marginBottom: 8 }}>
                  {m.vendor} · 权重 {(m.weight * 100).toFixed(0)}%
                </div>
                <Tag
                  size='small'
                  variant='light'
                  style={{ background: `${s.color}22`, color: s.color, border: 'none' }}
                  icon={s.icon}
                >
                  {s.label}
                </Tag>
              </div>
            );
          })}
        </div>
      </Card>

      {/* 全局维度标准差 + 漂移项目 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 16 }}>
        <Card bordered={false}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>维度稳定性（跨项目标准差）</div>
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
            <div style={{ padding: 20, color: 'var(--td-text-color-placeholder)', textAlign: 'center' }}>
              暂无报告样本
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {DIM_KEYS.map((k) => {
                const labelMap: Record<string, { label: string; color: string }> = {
                  visibility_score: { label: '可见度', color: '#6366F1' },
                  structure_score: { label: '结构', color: '#10B981' },
                  trust_score: { label: '信任', color: '#F59E0B' },
                  content_coverage_score: { label: '内容覆盖', color: '#EF4444' },
                };
                const m = labelMap[k];
                const v = stats.dimStd[k] || 0;
                // 标准差直观化：0 = 全对齐, 30+ = 明显漂移
                const pct = Math.min(100, (v / 30) * 100);
                return (
                  <div key={k}>
                    <div style={{ display: 'flex', alignItems: 'center', fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: m.color, fontWeight: 600 }}>{m.label}</span>
                      <div style={{ flex: 1 }} />
                      <span style={{ color: v >= 20 ? '#EF4444' : v >= 10 ? '#F59E0B' : '#10B981', fontWeight: 700 }}>
                        σ {v}
                      </span>
                    </div>
                    <div style={{ height: 8, background: '#F3F4F6', borderRadius: 4, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${pct}%`,
                          height: '100%',
                          background: v >= 20 ? '#EF4444' : v >= 10 ? '#F59E0B' : '#10B981',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div
            style={{
              marginTop: 12,
              padding: 10,
              background: '#F9FAFB',
              borderRadius: 6,
              fontSize: 11,
              color: 'var(--td-text-color-secondary)',
              lineHeight: 1.6,
            }}
          >
            σ &lt; 10 表示模型在该维度打分稳定；σ ≥ 20 说明不同项目间波动大，可能需要对该维度重新校准阈值。
          </div>
        </Card>

        <Card bordered={false}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>
            🧭 建议重新校准
            <Tag size='small' theme='warning' variant='light' style={{ marginLeft: 8 }}>
              {driftList.length} 项漂移
            </Tag>
          </div>
          {loading && driftList.length === 0 ? (
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
          ) : driftList.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--td-text-color-placeholder)', fontSize: 13 }}>
              ✅ 暂无维度失衡的项目，校准体系稳定
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {driftList.map(({ report, spread, max, min }) => (
                <div
                  key={report.report_id}
                  onClick={() => navigate(`/reports/scoring?report_id=${report.report_id}`)}
                  style={{
                    padding: 10,
                    background: '#fff',
                    borderRadius: 6,
                    borderLeft: `3px solid ${spread >= 50 ? '#EF4444' : '#F59E0B'}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    border: '1px solid #E5E7EB',
                    borderLeftWidth: 3,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 500,
                        fontSize: 13,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {report.project_name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>{report.domain}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>
                      {min} ~ {max}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: spread >= 50 ? '#DC2626' : '#D97706',
                      }}
                    >
                      Δ {spread}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* 下一步规划 */}
      <Card bordered={false} style={{ marginTop: 16, background: '#F8FAFC' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>🔭 即将接入</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <PlanCell title='一键重校准' desc='按项目 / 时间段批量跑 8 模型回归' eta='Q2' />
          <PlanCell title='权重自动学习' desc='根据客户反馈动态调 4 维权重' eta='Q3' />
          <PlanCell title='漂移日志入 Qdrant' desc='历史校准轨迹可检索' eta='Q3' />
        </div>
      </Card>
    </AgentShell>
  );
};

const PlanCell: React.FC<{ title: string; desc: string; eta: string }> = ({ title, desc, eta }) => (
  <div style={{ padding: 10, background: '#fff', borderRadius: 6, border: '1px dashed #CBD5E1' }}>
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
      <div style={{ flex: 1 }} />
      <Tag size='small' theme='primary' variant='light'>
        {eta}
      </Tag>
    </div>
    <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)', lineHeight: 1.6 }}>{desc}</div>
  </div>
);

export default Calibrator;
