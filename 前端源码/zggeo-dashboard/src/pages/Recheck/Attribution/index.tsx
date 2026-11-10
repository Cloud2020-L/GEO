import React, { useEffect, useMemo, useState } from 'react';
import { Card, Col, Loading, Progress, Row, Select, Space, Tag } from 'tdesign-react';
import { getReportsBatch, listTasks, ReportResponse } from 'services/zggeo-api';
import { groupByDomain, scoreDelta } from '../common';

const Attribution: React.FC = () => {
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
  const factors = [
    {
      name: '内容覆盖提升',
      delta: scoreDelta(after?.content_coverage_score, before?.content_coverage_score),
      desc: '行业场景、FAQ、答案块、案例内容变化。',
    },
    {
      name: '结构优化',
      delta: scoreDelta(after?.structure_score, before?.structure_score),
      desc: '标题层级、H1/H2、段落结构、Schema 线索。',
    },
    {
      name: '信任信号',
      delta: scoreDelta(after?.trust_score, before?.trust_score),
      desc: '案例、数据、团队、资质、第三方来源。',
    },
    {
      name: 'AI 可见度',
      delta: scoreDelta(after?.visibility_score, before?.visibility_score),
      desc: '关键词覆盖、检索召回、AI 摘要友好度。',
    },
    {
      name: 'GEO 增强资产',
      delta: scoreDelta(
        after?.report_json?.geo_enhancement?.overall_score,
        before?.report_json?.geo_enhancement?.overall_score,
      ),
      desc: 'llms.txt、Schema、AI crawler、可引用答案块。',
    },
  ];
  const total = factors.reduce((sum, f) => sum + Math.abs(f.delta), 0) || 1;

  if (loading)
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <Loading text='生成归因分析...' />
      </div>
    );

  return (
    <div style={{ padding: 16 }}>
      <Header title='归因分析' desc='把复测前后的变化拆成可解释原因：内容、结构、信任、可见度、GEO资产。' />
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
        {factors.map((factor) => {
          const pct = Math.round((Math.abs(factor.delta) / total) * 100);
          return (
            <Col xs={12} lg={6} key={factor.name}>
              <Card bordered>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <b>{factor.name}</b>
                  <Tag theme={factor.delta >= 0 ? 'success' : 'danger'} variant='light'>
                    {factor.delta >= 0 ? '+' : ''}
                    {factor.delta}
                  </Tag>
                </Space>
                <Progress percentage={pct} label={`${pct}%`} style={{ marginTop: 12 }} />
                <div style={{ color: 'var(--td-text-color-secondary)', marginTop: 8 }}>{factor.desc}</div>
              </Card>
            </Col>
          );
        })}
      </Row>
      <Card bordered title='归因结论' style={{ marginTop: 16 }}>
        <ol style={{ lineHeight: 1.9 }}>
          <li>如果内容覆盖和结构分上升，说明发布后的页面内容和答案块正在改善 AI 可读性。</li>
          <li>如果信任分没有变化，下一轮应该补客户案例、第三方来源、品牌实体和公开媒体链接。</li>
          <li>如果 GEO 增强资产仍低，优先部署 llms.txt、Schema JSON-LD、sitemap 和 robots AI crawler 策略。</li>
        </ol>
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
        <Tag theme='danger' variant='light'>
          归因分析
        </Tag>
      </Space>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{title}</div>
      <div style={{ color: '#999' }}>{desc}</div>
    </Space>
  </Card>
);
export default Attribution;
