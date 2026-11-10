import React, { useEffect, useMemo, useState } from 'react';
import { Card, Loading, Space, Table, Tag } from 'tdesign-react';
import { getReportsBatch, listTasks, ReportResponse } from 'services/zggeo-api';

const Ranking: React.FC = () => {
  const [reports, setReports] = useState<ReportResponse[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      const tasks = await listTasks({ latest_only: false });
      setReports(await getReportsBatch((tasks.map((t) => t.report_id).filter(Boolean) as string[]).slice(0, 50)));
      setLoading(false);
    })();
  }, []);
  const rows = useMemo(() => {
    const latest = Object.values(
      reports.reduce<Record<string, ReportResponse>>((acc, r) => {
        if (!acc[r.domain] || +new Date(r.created_at) > +new Date(acc[r.domain].created_at)) acc[r.domain] = r;
        return acc;
      }, {}),
    );
    return latest
      .sort((a, b) => b.total_score - a.total_score)
      .map((r, index) => ({
        rank: index + 1,
        project: r.project_name,
        domain: r.domain,
        score: r.total_score,
        geo: r.report_json?.geo_enhancement?.overall_score || 0,
        grade: r.grade,
        visibility: r.visibility_score,
        trust: r.trust_score,
      }));
  }, [reports]);

  if (loading)
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <Loading text='生成竞品排名...' />
      </div>
    );
  return (
    <div style={{ padding: 16 }}>
      <Header title='竞品排名' desc='按最新报告聚合品牌/竞品排名，便于查看 AI 可见度和 GEO 增强的相对位置。' />
      <Card bordered title='排名榜'>
        <Table
          rowKey='domain'
          data={rows}
          columns={[
            {
              colKey: 'rank',
              title: '排名',
              cell: ({ row }) => (
                <Tag theme={row.rank === 1 ? 'success' : 'default'} variant='light'>
                  #{row.rank}
                </Tag>
              ),
            },
            { colKey: 'project', title: '品牌 / 项目' },
            { colKey: 'domain', title: '域名' },
            { colKey: 'score', title: '综合分' },
            { colKey: 'geo', title: 'GEO 分' },
            { colKey: 'visibility', title: '可见度' },
            { colKey: 'trust', title: '信任' },
            { colKey: 'grade', title: '等级' },
          ]}
        />
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
        <Tag theme='warning' variant='light'>
          竞品
        </Tag>
      </Space>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{title}</div>
      <div style={{ color: 'var(--td-text-color-secondary)' }}>{desc}</div>
    </Space>
  </Card>
);
export default Ranking;
