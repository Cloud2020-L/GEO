import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, MessagePlugin, Row, Select, Space, Table, Tag } from 'tdesign-react';
import { BillingTransaction, getBillingAccount, getBillingTransactions } from 'services/zggeo-api';

const MODULE_OPTIONS = [
  { label: '全部模块', value: '' },
  { label: '商业化', value: '商业化' },
  { label: '内容生产', value: '内容生产' },
  { label: '分发执行', value: '分发执行' },
  { label: 'Agent 自动运作', value: 'Agent 自动运作' },
];

const TYPE_OPTIONS = [
  { label: '全部类型', value: '' },
  { label: '充值', value: 'recharge' },
  { label: '消耗', value: 'consume' },
  { label: '调整', value: 'adjust' },
  { label: '释放', value: 'release' },
  { label: '预占', value: 'hold' },
];

const ENTRY_LABEL: Record<string, string> = {
  recharge: '充值',
  consume: '消耗',
  adjust: '调整',
  release: '释放',
  hold: '预占',
};

const Consumption: React.FC = () => {
  const [rows, setRows] = useState<BillingTransaction[]>([]);
  const [account, setAccount] = useState<Record<string, any>>({});
  const [module, setModule] = useState('');
  const [entryType, setEntryType] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [accountData, transactionData] = await Promise.all([
        getBillingAccount(),
        getBillingTransactions({
          limit: 300,
          module: module || undefined,
          entry_type: entryType || undefined,
        }),
      ]);
      setAccount(accountData.account || {});
      setRows(transactionData);
    } catch (err: any) {
      MessagePlugin.error(`消耗明细加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [module, entryType]);

  const stats = useMemo(() => {
    const consumed = rows
      .filter((row) => row.entry_type === 'consume')
      .reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
    const credited = rows
      .filter((row) => ['recharge', 'adjust', 'release'].includes(row.entry_type) && Number(row.amount) > 0)
      .reduce((sum, row) => sum + Number(row.amount), 0);
    return {
      available: Number(account.available_balance || 0),
      held: Number(account.held_balance || 0),
      consumed,
      credited,
    };
  }, [rows, account]);

  const exportCsv = () => {
    const header = ['时间', '模块', '类型', '说明', '点数变化', '余额', '状态', '关联类型', '关联 ID'];
    const body = rows.map((row) => [
      row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : '',
      row.module || '',
      ENTRY_LABEL[row.entry_type] || row.entry_type || '',
      row.description || '',
      String(row.amount ?? ''),
      String(row.balance_after ?? ''),
      row.status || '',
      row.ref_type || '',
      row.ref_id || '',
    ]);
    const csv = [header, ...body]
      .map((line) => line.map((item) => `"${String(item).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `billing-transactions-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: 16 }}>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              消耗账单
            </Tag>
            <Tag theme='success' variant='light'>
              真实账本
            </Tag>
          </Space>
          <div style={{ fontSize: 24, fontWeight: 800 }}>消耗明细</div>
          <div style={{ color: 'var(--td-text-color-secondary)' }}>
            点数充值、消耗、预占释放和人工调整都在这里追溯。
          </div>
        </Space>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={3}>
          <Metric title='当前余额' value={stats.available} suffix='点' />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='冻结点数' value={stats.held} suffix='点' />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='筛选内消耗' value={stats.consumed} suffix='点' danger />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='筛选内入账' value={stats.credited} suffix='点' />
        </Col>
      </Row>

      <Card
        bordered
        title='明细账单'
        actions={
          <Space>
            <Select
              value={module}
              options={MODULE_OPTIONS}
              style={{ width: 150 }}
              onChange={(v) => setModule(String(v))}
            />
            <Select
              value={entryType}
              options={TYPE_OPTIONS}
              style={{ width: 130 }}
              onChange={(v) => setEntryType(String(v))}
            />
            <Button variant='outline' onClick={exportCsv}>
              导出账单
            </Button>
          </Space>
        }
      >
        <Table
          rowKey='id'
          data={rows}
          loading={loading}
          columns={[
            {
              colKey: 'created_at',
              title: '时间',
              width: 180,
              cell: ({ row }) => (row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : '-'),
            },
            { colKey: 'module', title: '模块', width: 120 },
            {
              colKey: 'entry_type',
              title: '类型',
              width: 100,
              cell: ({ row }) => <Tag variant='light'>{ENTRY_LABEL[row.entry_type] || row.entry_type}</Tag>,
            },
            { colKey: 'description', title: '说明', ellipsis: true },
            {
              colKey: 'amount',
              title: '点数变化',
              width: 120,
              cell: ({ row }) => (
                <span style={{ color: Number(row.amount) >= 0 ? '#10B981' : '#EF4444', fontWeight: 700 }}>
                  {Number(row.amount) > 0 ? '+' : ''}
                  {row.amount}
                </span>
              ),
            },
            { colKey: 'balance_after', title: '余额', width: 100 },
            { colKey: 'status', title: '状态', width: 100 },
            { colKey: 'ref_id', title: '关联单号', ellipsis: true },
          ]}
        />
      </Card>
    </div>
  );
};

const Metric: React.FC<{ title: string; value: number; suffix: string; danger?: boolean }> = ({
  title,
  value,
  suffix,
  danger,
}) => (
  <Card bordered>
    <div style={{ color: 'var(--td-text-color-secondary)' }}>{title}</div>
    <div style={{ fontSize: 28, fontWeight: 800, color: danger ? '#EF4444' : '#111827' }}>
      {value.toLocaleString()}
      {suffix}
    </div>
  </Card>
);

export default Consumption;
