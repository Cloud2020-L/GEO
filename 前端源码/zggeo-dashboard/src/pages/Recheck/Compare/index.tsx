import React, { useEffect, useMemo, useState } from 'react';
import { Card, Col, Loading, Row, Select, Space, Tag } from 'tdesign-react';
import { getReportsBatch, listTasks, ReportResponse } from 'services/zggeo-api';
import { gradeColor, groupByDomain, scoreDelta } from '../common';

const Compare: React.FC = () => {
  const [reports, setReports] = useState<ReportResponse[]>([]);
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const tasks = await listTasks({ latest_only: false });
      const data = await getReportsBatch((tasks.map((t) => t.report_id).filter(Boolean) as string[]).slice(0, 30));
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
  const before = current[0];
  const after = current[current.length - 1];
  const rows = [
    ['综合分', before?.total_score, after?.total_score],
    ['可见度', before?.visibility_score, after?.visibility_score],
    ['结构', before?.structure_score, after?.structure_score],
    ['信任', before?.trust_score, after?.trust_score],
    ['内容覆盖', before?.content_coverage_score, after?.content_coverage_score],
    [
      'GEO增强',
      before?.report_json?.geo_enhancement?.overall_score,
      after?.report_json?.geo_enhancement?.overall_score,
    ],
  ];

  if (loading)
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <Loading text='生成前后对比...' />
      </div>
    );

  return (
    <div style={{ padding: 16 }}>
      <Header title='前后对比' desc='选同一域名的最早报告和最新报告，对比分数、问题和修复动作。' />
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
      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <ReportCard title='复测前' report={before} />
        </Col>
        <Col xs={12} lg={6}>
          <ReportCard title='复测后' report={after} />
        </Col>
      </Row>
      <Card bordered title='指标变化' style={{ marginTop: 16 }}>
        <div style={{ display: 'grid', gap: 10 }}>
          {rows.map(([name, b, a]) => {
            const delta = scoreDelta(Number(a || 0), Number(b || 0));
            return (
              <div
                key={String(name)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 120px 120px 120px',
                  alignItems: 'center',
                  padding: 12,
                  borderRadius: 10,
                  background: 'var(--td-bg-color-container-hover)',
                }}
              >
                <b>{name}</b>
                <span>{b ?? '-'}</span>
                <span>{a ?? '-'}</span>
                <Tag theme={delta >= 0 ? 'success' : 'danger'} variant='light'>
                  {delta >= 0 ? '+' : ''}
                  {delta}
                </Tag>
              </div>
            );
          })}
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
          L7 回测闭环
        </Tag>
        <Tag theme='warning' variant='light'>
          前后对比
        </Tag>
      </Space>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{title}</div>
      <div style={{ color: '#999' }}>{desc}</div>
    </Space>
  </Card>
);
const ReportCard: React.FC<{ title: string; report?: ReportResponse }> = ({ title, report }) => (
  <Card bordered title={title}>
    <div style={{ fontSize: 40, fontWeight: 700, color: gradeColor(report?.total_score) }}>
      {report?.total_score ?? '-'}
    </div>
    <div>{report?.project_name || '-'}</div>
    <div style={{ color: '#999' }}>{report ? new Date(report.created_at).toLocaleString('zh-CN') : '-'}</div>
  </Card>
);
export default Compare;
