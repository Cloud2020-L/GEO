import React, { useEffect, useMemo, useState } from 'react';
import { Card, Col, MessagePlugin, Row, Space, Table, Tag } from 'tdesign-react';
import { listSystemLogs } from 'services/zggeo-api';

const Logs: React.FC = () => {
  const [logs, setLogs] = useState<Record<string, any>[]>([]);
  useEffect(() => {
    listSystemLogs()
      .then(setLogs)
      .catch((err) => MessagePlugin.error(`日志加载失败：${err?.message || '未知错误'}`));
  }, []);
  const stats = useMemo(
    () => ({
      total: logs.length,
      success: logs.filter((x) => x.result === 'success').length,
      risk: logs.filter((x) => String(x.result).includes('fail')).length,
    }),
    [logs],
  );
  return (
    <div style={{ padding: 16 }}>
      <Header title='操作日志' desc='真实数据库版：记录关键操作、模块、用户、结果和详情，用于客户交付审计。' />
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={3}>
          <Metric title='最近操作' value={String(stats.total)} />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='成功操作' value={String(stats.success)} />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='风险操作' value={String(stats.risk)} />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='审计保留' value='180天' />
        </Col>
      </Row>
      <Card bordered title='审计日志'>
        <Table
          rowKey='id'
          data={logs}
          columns={[
            {
              colKey: 'created_at',
              title: '时间',
              cell: ({ row }) => new Date(row.created_at).toLocaleString('zh-CN'),
            },
            { colKey: 'actor', title: '用户' },
            { colKey: 'action', title: '操作' },
            {
              colKey: 'module',
              title: '模块',
              cell: ({ row }) => (
                <Tag theme='primary' variant='light'>
                  {row.module}
                </Tag>
              ),
            },
            { colKey: 'ip', title: 'IP' },
            {
              colKey: 'result',
              title: '结果',
              cell: ({ row }) => (
                <Tag theme={row.result === 'success' ? 'success' : 'danger'} variant='light'>
                  {row.result}
                </Tag>
              ),
            },
            { colKey: 'detail', title: '详情' },
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
          系统管理
        </Tag>
        <Tag theme='success' variant='light'>
          审计
        </Tag>
      </Space>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{title}</div>
      <div style={{ color: 'var(--td-text-color-secondary)' }}>{desc}</div>
    </Space>
  </Card>
);
const Metric: React.FC<{ title: string; value: string }> = ({ title, value }) => (
  <Card bordered>
    <div style={{ color: 'var(--td-text-color-secondary)' }}>{title}</div>
    <div style={{ fontSize: 32, fontWeight: 800 }}>{value}</div>
  </Card>
);
export default Logs;
