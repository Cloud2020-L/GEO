import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  MessagePlugin,
  Radio,
  Select,
  Table,
  Tag,
  Textarea,
} from 'tdesign-react';
import { useAppSelector } from 'modules/store';
import {
  adminAdjustCredits,
  BillingTransaction,
  getAdminBillingAccounts,
  getBillingTransactions,
} from 'services/zggeo-api';

import styles from './index.module.less';

const { FormItem } = Form;

type BillingAccountRow = {
  id: string;
  tenant_id: string;
  tenant_name?: string;
  plan?: string;
  available_balance?: number;
  held_balance?: number;
  lifetime_credited?: number;
  lifetime_consumed?: number;
  expires_at?: string | null;
  expiry_policy?: string;
  updated_at?: string;
};

export const BillingAdjustmentsPanel: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || '').toLowerCase();
  const canAdjust = ['admin', 'operator'].includes(role);
  const [accounts, setAccounts] = useState<BillingAccountRow[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [mode, setMode] = useState<'add' | 'subtract'>('add');
  const [amount, setAmount] = useState(1000);
  const [reason, setReason] = useState('');
  const [refId, setRefId] = useState('');
  const [refreshExpiry, setRefreshExpiry] = useState(true);
  const [transactions, setTransactions] = useState<BillingTransaction[]>([]);
  const [loading, setLoading] = useState(false);

  const selected = useMemo(
    () => accounts.find((item) => String(item.tenant_id) === selectedTenantId),
    [accounts, selectedTenantId],
  );

  const signedAmount = mode === 'add' ? Math.abs(amount) : -Math.abs(amount);
  const beforeBalance = Number(selected?.available_balance || 0);
  const afterBalance = beforeBalance + signedAmount;
  const selectedExpiryText = selected?.expires_at
    ? new Date(selected.expires_at).toLocaleString('zh-CN')
    : '点数永不过期';

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const rows = (await getAdminBillingAccounts()) as BillingAccountRow[];
      setAccounts(rows);
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '租户账户加载失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchTransactions = async (tenantId: string) => {
    if (!tenantId) return;
    try {
      setTransactions(await getBillingTransactions({ tenant_id: tenantId, entry_type: 'adjust', limit: 50 }));
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '调账流水加载失败');
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  useEffect(() => {
    fetchTransactions(selectedTenantId);
  }, [selectedTenantId]);

  const submit = async () => {
    if (!canAdjust) {
      MessagePlugin.error('当前账号无运营调账权限');
      return;
    }
    if (!selected) {
      MessagePlugin.warning('请选择客户租户');
      return;
    }
    if (!amount || amount <= 0) {
      MessagePlugin.warning('请输入大于 0 的调整点数');
      return;
    }
    const cleanReason = reason.trim();
    if (!cleanReason) {
      MessagePlugin.warning('请填写调整原因');
      return;
    }
    if (afterBalance < 0) {
      MessagePlugin.error(
        `点数不足：当前 ${beforeBalance.toLocaleString()} 点，不能扣减 ${Math.abs(amount).toLocaleString()} 点`,
      );
      return;
    }
    const tenantName = selected.tenant_name || selected.tenant_id;
    const confirmText = `确认给「${tenantName}」${mode === 'add' ? '增加' : '扣减'} ${Math.abs(
      amount,
    ).toLocaleString()} 点？\n余额：${beforeBalance.toLocaleString()} → ${afterBalance.toLocaleString()}\n原因：${cleanReason}`;
    if (!window.confirm(confirmText)) return;

    setLoading(true);
    try {
      await adminAdjustCredits({
        tenant_id: selected.tenant_id,
        amount: signedAmount,
        description: refId.trim() ? `${cleanReason}（关联单据：${refId.trim()}）` : cleanReason,
        refresh_expiry: mode === 'add' ? refreshExpiry : false,
      });
      MessagePlugin.success('调账成功');
      setReason('');
      setRefId('');
      setRefreshExpiry(true);
      await fetchAccounts();
      await fetchTransactions(selected.tenant_id);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (detail?.code === 'INSUFFICIENT_CREDITS') {
        MessagePlugin.error(`点数不足：需要 ${detail.required} 点，当前可用 ${detail.available} 点`);
      } else {
        MessagePlugin.error(typeof detail === 'string' ? detail : err?.message || '调账失败');
      }
    } finally {
      setLoading(false);
    }
  };

  if (!canAdjust) {
    return (
      <div className={embedded ? styles.embeddedRoot : styles.page}>
        <Card bordered={false} className={styles.permissionCard}>
          <div className={styles.permissionContent}>
            <Tag theme='danger' variant='light'>
              无权限
            </Tag>
            <h2>运营调账</h2>
            <p>当前账号无运营调账权限。</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className={embedded ? styles.embeddedRoot : styles.page}>
      {!embedded && (
        <Card bordered={false} className={styles.pageHero}>
          <div className={styles.heroContent}>
            <div className={styles.heroCopy}>
              <div className={styles.tags}>
                <Tag theme='primary' variant='light'>
                  运营调账
                </Tag>
                <Tag theme='warning' variant='light'>
                  需审计
                </Tag>
              </div>
              <h1>运营调账</h1>
              <p>选择目标客户租户后再调整点数。当前租户加点请回到“点数账户”。</p>
            </div>
          </div>
        </Card>
      )}

      {embedded && (
        <div className={styles.inlineHero}>
          <div>
            <div className={styles.tags}>
              <Tag theme='primary' variant='light'>
                运营调账
              </Tag>
              <Tag theme='warning' variant='light'>
                需审计
              </Tag>
            </div>
            <h2>为指定客户租户加点或扣点</h2>
            <p>运营调账只操作你显式选择的客户租户，不会默认调整当前登录租户。</p>
          </div>
          <div className={styles.auditBadge}>全量审计留痕</div>
        </div>
      )}

      <div className={styles.adjustmentGrid}>
        <Card bordered title='调账表单' className={styles.formCard}>
          <Form layout='vertical' className={styles.adjustForm}>
            <div className={styles.formGrid}>
              <FormItem label='客户租户'>
                <Select
                  value={selectedTenantId}
                  className={styles.fullControl}
                  filterable
                  placeholder='请选择客户租户'
                  options={accounts.map((item) => ({
                    label: `${item.tenant_name || item.tenant_id} · ${Number(
                      item.available_balance || 0,
                    ).toLocaleString()} 点`,
                    value: item.tenant_id,
                  }))}
                  onChange={(v) => setSelectedTenantId(String(v))}
                />
              </FormItem>
              <FormItem label='调整类型'>
                <Radio.Group value={mode} onChange={(v) => setMode(String(v) as 'add' | 'subtract')}>
                  <Radio.Button value='add'>加点</Radio.Button>
                  <Radio.Button value='subtract'>扣点</Radio.Button>
                </Radio.Group>
              </FormItem>
              <FormItem label='调整点数'>
                <div className={styles.amountControl}>
                  <InputNumber value={amount} min={1} onChange={(v) => setAmount(Number(v))} />
                  <span>点</span>
                </div>
              </FormItem>
              <FormItem label='调整原因'>
                <Textarea
                  value={reason}
                  autosize={{ minRows: 4, maxRows: 6 }}
                  placeholder='例如：线下合同赠送、错误入账冲正、运营补偿'
                  onChange={(v) => setReason(String(v))}
                />
              </FormItem>
              <FormItem label='关联单据'>
                <Input
                  value={refId}
                  placeholder='合同号 / 工单号 / 支付订单号，可选'
                  onChange={(v) => setRefId(String(v))}
                />
              </FormItem>
              {mode === 'add' && (
                <FormItem label='有效期'>
                  <Checkbox checked={refreshExpiry} onChange={(checked) => setRefreshExpiry(Boolean(checked))}>
                    同步刷新客户点数有效期
                  </Checkbox>
                </FormItem>
              )}
            </div>
            <div className={styles.formActions}>
              <Button theme='primary' loading={loading} onClick={submit}>
                确认调账
              </Button>
            </div>
          </Form>
        </Card>

        <Card bordered title='目标账户' className={styles.accountCard}>
          <div className={styles.balancePreview}>
            <div>
              <span>当前余额</span>
              <strong>{beforeBalance.toLocaleString()} 点</strong>
            </div>
            <div className={mode === 'add' ? styles.changePositive : styles.changeNegative}>
              {mode === 'add' ? '+' : '-'}
              {Math.abs(amount || 0).toLocaleString()} 点
            </div>
            <div>
              <span>调整后余额</span>
              <strong className={afterBalance < 0 ? styles.dangerText : undefined}>
                {afterBalance.toLocaleString()} 点
              </strong>
            </div>
          </div>
          <div className={styles.metricGrid}>
            <Metric title='租户' value={selected?.tenant_name || '-'} wide />
            <Metric title='套餐' value={selected?.plan || '-'} />
            <Metric title='冻结点数' value={`${Number(selected?.held_balance || 0).toLocaleString()} 点`} />
            <Metric title='累计充值' value={`${Number(selected?.lifetime_credited || 0).toLocaleString()} 点`} />
            <Metric title='累计消耗' value={`${Number(selected?.lifetime_consumed || 0).toLocaleString()} 点`} />
            <Metric title='点数有效期' value={selectedExpiryText} wide />
          </div>
        </Card>
      </div>

      <Card bordered title='最近调账流水' className={styles.ledgerCard}>
        <Table
          rowKey='id'
          data={transactions}
          loading={loading}
          columns={[
            {
              colKey: 'created_at',
              title: '时间',
              width: 180,
              cell: ({ row }) => (row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : '-'),
            },
            { colKey: 'description', title: '说明', ellipsis: true },
            {
              colKey: 'amount',
              title: '点数变化',
              width: 120,
              cell: ({ row }) => (
                <b className={Number(row.amount) >= 0 ? styles.amountPositive : styles.amountNegative}>
                  {Number(row.amount) > 0 ? '+' : ''}
                  {row.amount}
                </b>
              ),
            },
            { colKey: 'balance_after', title: '变更后余额', width: 120 },
            { colKey: 'status', title: '状态', width: 100 },
          ]}
        />
      </Card>
    </div>
  );
};

const Metric: React.FC<{ title: string; value: string; wide?: boolean }> = ({ title, value, wide }) => (
  <div className={`${styles.metricTile} ${wide ? styles.metricTileWide : ''}`}>
    <span>{title}</span>
    <strong>{value}</strong>
  </div>
);

export default BillingAdjustmentsPanel;
