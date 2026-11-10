import React, { useEffect, useMemo, useState } from 'react';
import { Card, Col, Loading, Row, Select, Space, Tag } from 'tdesign-react';
import type { EChartOption } from 'echarts';
import ReactEcharts from 'echarts-for-react';
import { getReportsBatch, listTasks, ReportResponse } from 'services/zggeo-api';
import { gradeColor, groupByDomain } from '../common';

const formatAxisTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '-';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
};

const getGeoScore = (report: ReportResponse) => Number(report.report_json?.geo_enhancement?.overall_score || 0);

const buildLineOptions = (reports: ReportResponse[]): EChartOption => {
  const xAxis = reports.map((report) => formatAxisTime(report.created_at));
  const totalScores = reports.map((report) => Number(report.total_score || 0));
  const geoScores = reports.map(getGeoScore);

  return {
    color: ['#2563EB', '#10B981'],
    tooltip: {
      trigger: 'axis',
      formatter(params: any) {
        const items = Array.isArray(params) ? params : [params];
        const index = Number(items[0]?.dataIndex || 0);
        const report = reports[index];
        const time = report?.created_at ? new Date(report.created_at).toLocaleString('zh-CN') : '-';
        const lines = items.map((item: any) => `${item.marker}${item.seriesName}：${item.value} 分`);
        return [`${report?.project_name || ''}`, `时间：${time}`, ...lines].filter(Boolean).join('<br/>');
      },
    },
    legend: {
      top: 4,
      right: 12,
      data: ['综合分', 'GEO增强分'],
    },
    grid: {
      left: 48,
      right: 28,
      top: 54,
      bottom: 58,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: xAxis,
      name: '时间',
      nameLocation: 'middle',
      nameGap: 38,
      axisLabel: {
        color: '#8B949E',
        rotate: reports.length > 6 ? 28 : 0,
      },
      axisLine: { lineStyle: { color: '#D8DEE9' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      name: '分数',
      splitLine: { lineStyle: { color: '#EEF2F7' } },
      axisLabel: { color: '#8B949E' },
    },
    series: [
      {
        name: '综合分',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 8,
        data: totalScores,
        lineStyle: { width: 3 },
        areaStyle: { opacity: 0.08 },
      },
      {
        name: 'GEO增强分',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 8,
        data: geoScores,
        lineStyle: { width: 3 },
        areaStyle: { opacity: 0.06 },
      },
    ],
  };
};

const Curve: React.FC = () => {
  const [reports, setReports] = useState<ReportResponse[]>([]);
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const tasks = await listTasks({ latest_only: false });
      const ids = tasks.map((t) => t.report_id).filter(Boolean) as string[];
      const data = await getReportsBatch(ids.slice(0, 30));
      setReports(data);
      setDomain(data[0]?.domain || '');
      setLoading(false);
    })();
  }, []);

  const grouped = useMemo(() => groupByDomain(reports), [reports]);
  const current = useMemo(
    () => (grouped[domain] || []).sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)),
    [grouped, domain],
  );
  const min = current[0]?.total_score || 0;
  const latest = current[current.length - 1]?.total_score || 0;
  const latestGeo = current.length ? getGeoScore(current[current.length - 1]) : 0;
  const chartOptions = useMemo(() => buildLineOptions(current), [current]);

  if (loading)
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <Loading text='生成效果曲线...' />
      </div>
    );

  return (
    <div style={{ padding: 16 }}>
      <Header title='效果曲线' desc='按域名聚合历史报告，观察 14/30/90 天复测后的综合分、GEO 增强分变化。' />
      <Card bordered style={{ marginBottom: 16 }}>
        <Space>
          <span>选择域名：</span>
          <Select
            style={{ width: 280 }}
            value={domain}
            onChange={(v) => setDomain(String(v))}
            options={Object.keys(grouped).map((d) => ({ label: d, value: d }))}
          />
        </Space>
      </Card>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={4}>
          <Metric title='起始分' value={min} />
        </Col>
        <Col xs={12} lg={4}>
          <Metric title='最新分' value={latest} color={gradeColor(latest)} />
        </Col>
        <Col xs={12} lg={4}>
          <Metric title='净变化' value={latest - min} color={latest - min >= 0 ? '#10B981' : '#EF4444'} />
        </Col>
      </Row>
      <Card
        bordered
        title='趋势曲线'
        actions={
          <Space>
            <Tag theme='primary' variant='light'>
              最新综合分 {latest}
            </Tag>
            <Tag theme='success' variant='light'>
              最新GEO增强 {latestGeo}
            </Tag>
          </Space>
        }
      >
        {current.length === 0 ? (
          <div
            style={{ minHeight: 260, display: 'grid', placeItems: 'center', color: 'var(--td-text-color-secondary)' }}
          >
            暂无该域名的历史报告
          </div>
        ) : (
          <ReactEcharts option={chartOptions} notMerge lazyUpdate style={{ height: 360, width: '100%' }} />
        )}
      </Card>
    </div>
  );
};

const Header: React.FC<{ title: string; desc: string }> = ({ title, desc }) => (
  <Card bordered={false} style={{ marginBottom: 16 }}>
    <Space direction='vertical'>
      <Space>
        <Tag theme='primary' variant='light'>
          L7 回测闭环
        </Tag>
        <Tag theme='success' variant='light'>
          效果追踪
        </Tag>
      </Space>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{title}</div>
      <div style={{ color: 'var(--td-text-color-secondary)' }}>{desc}</div>
    </Space>
  </Card>
);
const Metric: React.FC<{ title: string; value: number; color?: string }> = ({ title, value, color }) => (
  <Card bordered>
    <div style={{ color: '#999' }}>{title}</div>
    <div style={{ fontSize: 32, fontWeight: 700, color }}>{value}</div>
  </Card>
);
export default Curve;
