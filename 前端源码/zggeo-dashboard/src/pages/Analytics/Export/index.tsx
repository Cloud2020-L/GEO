import React, { useEffect, useState } from 'react';
import { Button, Card, Checkbox, Col, Loading, MessagePlugin, Row, Space, Table, Tag } from 'tdesign-react';
import { getReportsBatch, listTasks, ReportResponse } from 'services/zggeo-api';
import { DownloadIcon } from 'tdesign-icons-react';

const Export: React.FC = () => {
  const [reports, setReports] = useState<ReportResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [fields, setFields] = useState([
    'project_name',
    'domain',
    'total_score',
    'grade',
    'visibility_score',
    'structure_score',
    'trust_score',
    'content_coverage_score',
  ]);

  useEffect(() => {
    (async () => {
      const tasks = await listTasks({ latest_only: false });
      setReports(await getReportsBatch((tasks.map((t) => t.report_id).filter(Boolean) as string[]).slice(0, 80)));
      setLoading(false);
    })();
  }, []);

  const download = (type: 'csv' | 'json') => {
    const data = reports.map((r) => ({
      project_name: r.project_name,
      domain: r.domain,
      total_score: r.total_score,
      grade: r.grade,
      visibility_score: r.visibility_score,
      structure_score: r.structure_score,
      trust_score: r.trust_score,
      content_coverage_score: r.content_coverage_score,
      geo_score: r.report_json?.geo_enhancement?.overall_score || 0,
      created_at: r.created_at,
    }));
    let content = '';
    let mime = 'application/json';
    if (type === 'json') {
      content = JSON.stringify(data, null, 2);
    } else {
      const header = fields.join(',');
      const lines = data.map((row: any) => fields.map((f) => JSON.stringify(row[f] ?? '')).join(','));
      content = [header, ...lines].join('\n');
      mime = 'text/csv';
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zggeo-analytics-${Date.now()}.${type}`;
    a.click();
    URL.revokeObjectURL(url);
    MessagePlugin.success(`已导出 ${type.toUpperCase()}`);
  };

  if (loading)
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <Loading text='准备导出数据...' />
      </div>
    );

  return (
    <div style={{ padding: 16 }}>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              数据分析
            </Tag>
            <Tag theme='success' variant='light'>
              导出
            </Tag>
          </Space>
          <div style={{ fontSize: 24, fontWeight: 800 }}>数据导出</div>
          <div style={{ color: 'var(--td-text-color-secondary)' }}>
            导出报告、覆盖率、竞品排名和 GEO 指标，用于客户汇报、BI 分析或交付归档。
          </div>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={5}>
          <Card bordered title='导出字段'>
            <Checkbox.Group value={fields} onChange={(v) => setFields(v.map(String))}>
              <Space direction='vertical'>
                {[
                  ['project_name', '项目名'],
                  ['domain', '域名'],
                  ['total_score', '综合分'],
                  ['grade', '等级'],
                  ['visibility_score', '可见度'],
                  ['structure_score', '结构'],
                  ['trust_score', '信任'],
                  ['content_coverage_score', '内容覆盖'],
                ].map(([value, label]) => (
                  <Checkbox key={value} value={value}>
                    {label}
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
            <Space style={{ marginTop: 16 }}>
              <Button theme='primary' icon={<DownloadIcon />} onClick={() => download('csv')}>
                导出 CSV
              </Button>
              <Button variant='outline' icon={<DownloadIcon />} onClick={() => download('json')}>
                导出 JSON
              </Button>
            </Space>
          </Card>
        </Col>
        <Col xs={12} lg={7}>
          <Card bordered title='导出预览'>
            <Table
              rowKey='report_id'
              data={reports.slice(0, 8)}
              columns={[
                { colKey: 'project_name', title: '项目' },
                { colKey: 'domain', title: '域名' },
                { colKey: 'total_score', title: '综合分' },
                { colKey: 'grade', title: '等级' },
                {
                  colKey: 'created_at',
                  title: '时间',
                  cell: ({ row }) => new Date(row.created_at).toLocaleString('zh-CN'),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Export;
