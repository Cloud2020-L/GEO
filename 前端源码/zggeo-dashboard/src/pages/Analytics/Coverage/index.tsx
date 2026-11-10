import React, { useEffect, useMemo, useState } from 'react';
import { Card, Checkbox, Col, Loading, Progress, Row, Space, Tag } from 'tdesign-react';
import { getReportsBatch, listTasks, ReportResponse } from 'services/zggeo-api';

const COLORS = ['#2563EB', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#0891B2'];

type TrendPoint = {
  domain: string;
  reportId: string;
  date: string;
  score: number;
  geo: number;
};

const Coverage: React.FC = () => {
  const [reports, setReports] = useState<ReportResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const tasks = await listTasks({ latest_only: false });
      const ids = tasks.map((t) => t.report_id).filter(Boolean) as string[];
      setReports(await getReportsBatch(ids.slice(0, 40)));
      setLoading(false);
    })();
  }, []);

  const domains = useMemo(() => {
    const counts = reports.reduce<Record<string, number>>((acc, report) => {
      acc[report.domain] = (acc[report.domain] || 0) + 1;
      return acc;
    }, {});
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  }, [reports]);

  useEffect(() => {
    if (!selectedDomains.length && domains.length) {
      setSelectedDomains(domains.slice(0, 6));
    }
  }, [domains, selectedDomains.length]);

  const stats = useMemo(() => {
    const total = reports.length || 1;
    const avg = Math.round(reports.reduce((sum, r) => sum + r.total_score, 0) / total);
    const geo = Math.round(
      reports.reduce((sum, r) => sum + Number(r.report_json?.geo_enhancement?.overall_score || 0), 0) / total,
    );
    const schemaReady = reports.filter(
      (r) => Number(r.report_json?.geo_enhancement?.schema_readiness_score || 0) >= 60,
    ).length;
    return { total: reports.length, avg, geo, schemaRate: Math.round((schemaReady / total) * 100) };
  }, [reports]);

  const selectedReports = useMemo(
    () =>
      reports
        .filter((report) => selectedDomains.includes(report.domain))
        .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)),
    [reports, selectedDomains],
  );

  const trendPoints = useMemo<TrendPoint[]>(
    () =>
      selectedReports.map((report) => ({
        domain: report.domain,
        reportId: report.report_id,
        date: report.created_at,
        score: report.total_score,
        geo: Number(report.report_json?.geo_enhancement?.overall_score || 0),
      })),
    [selectedReports],
  );

  const domainMetrics = useMemo(() => {
    return selectedDomains.map((domain) => {
      const rows = selectedReports.filter((report) => report.domain === domain);
      const first = rows[0];
      const last = rows[rows.length - 1];
      const delta = (last?.total_score || 0) - (first?.total_score || 0);
      return {
        domain,
        latest: last?.total_score || 0,
        delta,
        reportCount: rows.length,
      };
    });
  }, [selectedDomains, selectedReports]);

  if (loading)
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <Loading text='加载覆盖率趋势...' />
      </div>
    );

  return (
    <div style={{ padding: 16 }}>
      <Header title='覆盖率趋势' desc='聚合历史诊断报告，观察品牌 AI 可见度、GEO 增强、Schema 覆盖等趋势。' />
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={3}>
          <Metric title='报告样本' value={stats.total} suffix='份' />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='平均综合分' value={stats.avg} suffix='分' />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='平均 GEO 分' value={stats.geo} suffix='分' />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='Schema 覆盖' value={stats.schemaRate} suffix='%' />
        </Col>
      </Row>
      <Card bordered title='多品牌趋势对比'>
        <Space direction='vertical' style={{ width: '100%' }} size='large'>
          <Checkbox.Group
            value={selectedDomains}
            onChange={(value) => setSelectedDomains(value.map(String).slice(0, 6))}
          >
            <Space breakLine>
              {domains.slice(0, 12).map((domain) => (
                <Checkbox key={domain} value={domain}>
                  {domain}
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>
          <TrendChart points={trendPoints} domains={selectedDomains} />
          <Row gutter={[16, 16]}>
            {domainMetrics.map((item, index) => (
              <Col xs={12} sm={6} lg={3} key={item.domain}>
                <Card bordered bodyStyle={{ padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{ width: 10, height: 10, borderRadius: 5, background: COLORS[index % COLORS.length] }}
                    />
                    <span
                      style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {item.domain}
                    </span>
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 800, marginTop: 12 }}>
                    {item.latest}
                    <span style={{ fontSize: 14 }}>分</span>
                  </div>
                  <div style={{ color: item.delta >= 0 ? '#059669' : '#DC2626' }}>
                    {item.delta >= 0 ? '+' : ''}
                    {item.delta} 分 · {item.reportCount} 份报告
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        </Space>
      </Card>
      <Card bordered title='覆盖率拆解' style={{ marginTop: 16 }}>
        <Row gutter={[16, 16]}>
          {[
            ['AI 可见度覆盖', stats.avg],
            ['GEO 增强覆盖', stats.geo],
            ['Schema 覆盖', stats.schemaRate],
            ['回测闭环覆盖', Math.min(stats.total * 12, 100)],
          ].map(([name, value]) => (
            <Col xs={12} lg={3} key={name}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>{name}</div>
              <Progress percentage={Number(value)} theme='circle' />
            </Col>
          ))}
        </Row>
      </Card>
      <Card bordered title='最近报告' style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'end', gap: 12, minHeight: 220 }}>
          {selectedReports.slice(-10).map((report) => (
            <div key={report.report_id} style={{ flex: 1, textAlign: 'center', minWidth: 0 }}>
              <div
                style={{
                  height: Math.max(20, report.total_score * 1.8),
                  background: '#2563EB',
                  borderRadius: '8px 8px 0 0',
                }}
              />
              <div style={{ marginTop: 8, fontWeight: 700 }}>{report.total_score}</div>
              <div
                style={{
                  fontSize: 12,
                  color: '#999',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {report.domain}
              </div>
              <div style={{ fontSize: 12, color: '#999' }}>
                {new Date(report.created_at).toLocaleDateString('zh-CN')}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

const Header: React.FC<{ title: string; desc: string }> = ({ title, desc }) => (
  <Card bordered={false} style={{ marginBottom: 16 }}>
    <Space direction='vertical'>
      <Space>
        <Tag theme='primary' variant='light'>
          数据分析
        </Tag>
        <Tag theme='success' variant='light'>
          趋势
        </Tag>
      </Space>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{title}</div>
      <div style={{ color: 'var(--td-text-color-secondary)' }}>{desc}</div>
    </Space>
  </Card>
);
const Metric: React.FC<{ title: string; value: number; suffix: string }> = ({ title, value, suffix }) => (
  <Card bordered>
    <div style={{ color: '#999' }}>{title}</div>
    <div style={{ fontSize: 32, fontWeight: 800 }}>
      {value}
      {suffix}
    </div>
  </Card>
);

const TrendChart: React.FC<{ points: TrendPoint[]; domains: string[] }> = ({ points, domains }) => {
  const width = 920;
  const height = 280;
  const padding = { top: 24, right: 24, bottom: 36, left: 36 };
  const usableWidth = width - padding.left - padding.right;
  const usableHeight = height - padding.top - padding.bottom;
  const times = points.map((point) => +new Date(point.date));
  const minTime = Math.min(...times, Date.now());
  const maxTime = Math.max(...times, Date.now());
  const rangeTime = Math.max(maxTime - minTime, 1);

  const xFor = (date: string) => padding.left + ((+new Date(date) - minTime) / rangeTime) * usableWidth;
  const yFor = (score: number) => padding.top + (1 - score / 100) * usableHeight;

  if (!points.length) {
    return <div style={{ minHeight: 280, display: 'grid', placeItems: 'center', color: '#999' }}>暂无可对比报告</div>;
  }

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', minWidth: 680, height: 280 }}>
        {[0, 25, 50, 75, 100].map((score) => (
          <g key={score}>
            <line x1={padding.left} x2={width - padding.right} y1={yFor(score)} y2={yFor(score)} stroke='#E5E7EB' />
            <text x={8} y={yFor(score) + 4} fill='#6B7280' fontSize='12'>
              {score}
            </text>
          </g>
        ))}
        {domains.map((domain, index) => {
          const rows = points.filter((point) => point.domain === domain);
          const path = rows
            .map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${xFor(point.date)} ${yFor(point.score)}`)
            .join(' ');
          const color = COLORS[index % COLORS.length];
          return (
            <g key={domain}>
              <path d={path} fill='none' stroke={color} strokeWidth='3' strokeLinecap='round' strokeLinejoin='round' />
              {rows.map((point) => (
                <circle key={point.reportId} cx={xFor(point.date)} cy={yFor(point.score)} r='4' fill={color}>
                  <title>{`${domain} · ${point.score}分 · ${new Date(point.date).toLocaleDateString('zh-CN')}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
};
export default Coverage;
