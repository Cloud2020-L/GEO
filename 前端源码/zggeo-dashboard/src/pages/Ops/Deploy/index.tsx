import React from 'react';
import { Button, Card, Col, Row, Space, Table, Tag, Timeline } from 'tdesign-react';

const deploys = [
  {
    id: 1,
    version: 'v0.9.8',
    time: '2026-04-22 14:30',
    module: '运营交付',
    operator: 'Codex',
    status: '成功',
    desc: '上线企微通知、部署记录页面',
  },
  {
    id: 2,
    version: 'v0.9.7',
    time: '2026-04-22 13:10',
    module: '商业化',
    operator: 'Codex',
    status: '成功',
    desc: '上线套餐、点数、支付、消耗明细',
  },
  {
    id: 3,
    version: 'v0.9.6',
    time: '2026-04-22 11:40',
    module: '回测闭环',
    operator: 'Codex',
    status: '成功',
    desc: '上线复测任务、效果曲线、前后对比、归因分析',
  },
];

const Deploy: React.FC = () => (
  <div style={{ padding: 16 }}>
    <Card bordered={false} style={{ marginBottom: 16 }}>
      <Space direction='vertical'>
        <Space>
          <Tag theme='primary' variant='light'>
            运营交付
          </Tag>
          <Tag theme='success' variant='light'>
            部署记录
          </Tag>
        </Space>
        <div style={{ fontSize: 24, fontWeight: 800 }}>部署记录</div>
        <div style={{ color: 'var(--td-text-color-secondary)' }}>
          记录功能上线、配置变更、服务重启、API 对接、客户交付版本，方便回溯和审计。
        </div>
      </Space>
    </Card>

    <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
      <Col xs={12} lg={4}>
        <Metric title='上线版本' value='3' />
      </Col>
      <Col xs={12} lg={4}>
        <Metric title='成功率' value='100%' />
      </Col>
      <Col xs={12} lg={4}>
        <Metric title='最近部署' value='v0.9.8' />
      </Col>
    </Row>

    <Row gutter={[16, 16]}>
      <Col xs={12} lg={7}>
        <Card bordered title='部署台账' actions={<Button variant='outline'>导出记录</Button>}>
          <Table
            rowKey='id'
            data={deploys}
            columns={[
              { colKey: 'version', title: '版本' },
              { colKey: 'time', title: '时间' },
              { colKey: 'module', title: '模块' },
              { colKey: 'operator', title: '操作人' },
              {
                colKey: 'status',
                title: '状态',
                cell: ({ row }) => (
                  <Tag theme='success' variant='light'>
                    {row.status}
                  </Tag>
                ),
              },
              { colKey: 'desc', title: '说明' },
            ]}
          />
        </Card>
      </Col>
      <Col xs={12} lg={5}>
        <Card bordered title='上线时间线'>
          <Timeline mode='same'>
            {deploys.map((item) => (
              <Timeline.Item key={item.id} label={item.time}>
                <b>
                  {item.version} · {item.module}
                </b>
                <div style={{ color: 'var(--td-text-color-secondary)' }}>{item.desc}</div>
              </Timeline.Item>
            ))}
          </Timeline>
        </Card>
      </Col>
    </Row>
  </div>
);

const Metric: React.FC<{ title: string; value: string }> = ({ title, value }) => (
  <Card bordered>
    <div style={{ color: 'var(--td-text-color-secondary)' }}>{title}</div>
    <div style={{ fontSize: 32, fontWeight: 800 }}>{value}</div>
  </Card>
);

export default Deploy;
