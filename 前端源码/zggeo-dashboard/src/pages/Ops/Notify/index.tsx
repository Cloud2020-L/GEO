import React, { useState } from 'react';
import { Button, Card, Col, Form, Input, MessagePlugin, Row, Space, Switch, Table, Tag, Textarea } from 'tdesign-react';

const { FormItem } = Form;

const rules = [
  {
    id: 1,
    event: '新留资',
    channel: '企业微信群',
    status: '启用',
    template: '客户 {{name}} 提交咨询，需求：{{needs}}',
  },
  {
    id: 2,
    event: '任务完成',
    channel: '企业微信群',
    status: '启用',
    template: '监测任务 {{project}} 已完成，总分 {{score}}',
  },
  {
    id: 3,
    event: '异常告警',
    channel: '企业微信群 + 邮件',
    status: '启用',
    template: '服务 {{service}} 出现异常：{{error}}',
  },
  { id: 4, event: '点数不足', channel: '企业微信群', status: '暂停', template: '租户 {{tenant}} 点数余额低于阈值' },
];

const logs = [
  { id: 1, time: '2026-04-22 14:20', event: '新留资', target: '销售群', status: '成功', message: '已推送新咨询客户' },
  {
    id: 2,
    time: '2026-04-22 13:48',
    event: '任务完成',
    target: '交付群',
    status: '成功',
    message: 'ZGEO 智改诊断完成',
  },
  {
    id: 3,
    time: '2026-04-22 12:05',
    event: '异常告警',
    target: '运维群',
    status: '成功',
    message: 'ai-service health ok',
  },
];

const Notify: React.FC = () => {
  const [webhook, setWebhook] = useState('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...');
  return (
    <div style={{ padding: 16 }}>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              运营交付
            </Tag>
            <Tag theme='success' variant='light'>
              企微通知
            </Tag>
          </Space>
          <div style={{ fontSize: 24, fontWeight: 800 }}>企微通知中心</div>
          <div style={{ color: 'var(--td-text-color-secondary)' }}>
            通过企业微信群机器人 / ntfy 将新留资、任务完成、异常告警、点数不足等事件推送给运营和交付团队。
          </div>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={5}>
          <Card bordered title='通知通道配置'>
            <Form layout='vertical'>
              <FormItem label='企业微信 Webhook'>
                <Input value={webhook} onChange={(v) => setWebhook(String(v))} />
              </FormItem>
              <FormItem label='ntfy Topic'>
                <Input value='zggeo-events' />
              </FormItem>
              <FormItem label='默认通知模板'>
                <Textarea autosize={{ minRows: 4, maxRows: 8 }} value='【ZGEO】{{event}}：{{message}}' />
              </FormItem>
              <Button theme='primary' onClick={() => MessagePlugin.success('通知配置已保存（模拟）')}>
                保存配置
              </Button>
            </Form>
          </Card>
        </Col>
        <Col xs={12} lg={7}>
          <Card bordered title='触发规则'>
            <Table
              rowKey='id'
              data={rules}
              columns={[
                { colKey: 'event', title: '事件' },
                { colKey: 'channel', title: '通道' },
                {
                  colKey: 'status',
                  title: '状态',
                  cell: ({ row }) => <Switch value={row.status === '启用'} label={['启用', '暂停']} />,
                },
                { colKey: 'template', title: '模板' },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card bordered title='通知日志' style={{ marginTop: 16 }}>
        <Table
          rowKey='id'
          data={logs}
          columns={[
            { colKey: 'time', title: '时间' },
            { colKey: 'event', title: '事件' },
            { colKey: 'target', title: '目标' },
            {
              colKey: 'status',
              title: '状态',
              cell: ({ row }) => (
                <Tag theme='success' variant='light'>
                  {row.status}
                </Tag>
              ),
            },
            { colKey: 'message', title: '消息' },
          ]}
        />
      </Card>
    </div>
  );
};

export default Notify;
