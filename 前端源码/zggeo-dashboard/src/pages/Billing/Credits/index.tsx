import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  Form,
  InputNumber,
  MessagePlugin,
  Progress,
  Space,
  Table,
  Tag,
  Textarea,
  Tabs,
} from 'tdesign-react';
import { useAppSelector } from 'modules/store';
import { BillingAdjustmentsPanel } from 'pages/Billing/Adjustments';
import PendingOrdersPanel from 'pages/Billing/components/PendingOrdersPanel';
import {
  adjustCredits,
  BillingAccountResponse,
  createBillingOrder,
  CreditPack,
  getBillingAccount,
} from 'services/zggeo-api';

import styles from './index.module.less';

const { FormItem } = Form;
const { TabPanel } = Tabs;

const Credits: React.FC = () => {
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || 'client').toLowerCase();
  const canAdjust = ['admin', 'operator'].includes(role);
  const [account, setAccount] = useState<BillingAccountResponse>({});
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(1000);
  const [reason, setReason] = useState('');
  const [refreshExpiry, setRefreshExpiry] = useState(true);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('ledger');

  const fetchData = async () => {
    try {
      setAccount(await getBillingAccount());
    } catch (err: any) {
      MessagePlugin.error(`计费数据加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const tenant = account.tenant || {};
  const creditAccount = account.account || {};
  const packs = (account.credit_packs || []) as CreditPack[];
  const transactions = account.transactions || [];
  const available = Number(creditAccount.available_balance ?? tenant.credit_balance ?? 0);
  const held = Number(creditAccount.held_balance ?? 0);
  const lifetimeConsumed = Number(creditAccount.lifetime_consumed ?? 0);
  const lifetimeCredited = Number(creditAccount.lifetime_credited ?? 0);
  const threshold = Number(creditAccount.low_balance_threshold ?? 500);
  const expiresAt = creditAccount.expires_at ? new Date(String(creditAccount.expires_at)) : null;
  const expiresInSeconds =
    typeof creditAccount.expires_in_seconds === 'number'
      ? Number(creditAccount.expires_in_seconds)
      : expiresAt
      ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
      : null;
  const isExpired = Boolean(creditAccount.is_expired);
  const expiryText = expiresAt
    ? isExpired
      ? '点数已到期并清零'
      : `有效期至 ${formatDateTime(expiresAt)}`
    : '点数永不过期';
  const expiryHint = expiresAt && !isExpired ? formatRemaining(expiresInSeconds ?? 0) : expiryText;
  const progressBase = Math.max(available + lifetimeConsumed, 1);
  const usagePercentage = Math.min(100, Math.round((lifetimeConsumed / progressBase) * 100));
  const tenantName = String(tenant.name || user?.tenant_name || '-');
  const planName = String(tenant.plan || user?.plan || 'standard');

  const pendingOrders = useMemo(
    () => (account.orders || []).filter((order) => order.status === 'pending'),
    [account.orders],
  );

  const buy = async (pack: CreditPack) => {
    setLoading(true);
    try {
      await createBillingOrder({
        order_type: 'credit_pack',
        payment_method: 'bank',
        credit_pack_code: pack.code,
      });
      MessagePlugin.success('已创建点数包订单，请到支付中心完成支付或对公确认');
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '订单创建失败');
    } finally {
      setLoading(false);
    }
  };

  const adjust = async () => {
    const cleanReason = reason.trim();
    if (!cleanReason) {
      MessagePlugin.warning('请填写调整原因');
      return;
    }
    const confirmTenantName = String(tenant.name || user?.tenant_name || '当前租户');
    if (!window.confirm(`确认给「${confirmTenantName}」增加 ${amount.toLocaleString()} 点？`)) return;
    setLoading(true);
    try {
      await adjustCredits({ amount, description: cleanReason, refresh_expiry: refreshExpiry });
      MessagePlugin.success(`已内部入账 ${amount} 点`);
      setOpen(false);
      setReason('');
      setRefreshExpiry(true);
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '内部加点失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <Card bordered={false} className={styles.hero}>
        <div className={styles.heroMain}>
          <div className={styles.heroCopy}>
            <Space className={styles.heroTags}>
              <Tag theme='primary' variant='light'>
                点数账户
              </Tag>
              <Tag theme={available <= threshold ? 'warning' : 'success'} variant='light'>
                {available <= threshold ? '余额偏低' : '账户正常'}
              </Tag>
              <Tag theme={isExpired ? 'danger' : expiresAt ? 'warning' : 'success'} variant='light'>
                {expiryHint}
              </Tag>
            </Space>
            <h1 className={styles.heroTitle}>点数账户</h1>
            <div className={styles.heroSubtitle}>
              租户：{tenantName} · 套餐：{planName}
            </div>
          </div>
          <div className={styles.heroMetrics}>
            <Metric label='可用点数' value={available.toLocaleString()} suffix='点' tone='primary' />
            <Metric label='冻结点数' value={held.toLocaleString()} suffix='点' />
            <Metric label='累计消耗' value={lifetimeConsumed.toLocaleString()} suffix='点' tone='danger' />
            <Metric label='待支付订单' value={pendingOrders.length.toLocaleString()} suffix='笔' tone='warning' />
          </div>
        </div>
      </Card>

      <div className={styles.topGrid}>
        <Card bordered title='当前账户' className={styles.accountCard}>
          <div className={styles.balanceLabel}>可用点数</div>
          <div className={styles.balanceValue}>
            {available.toLocaleString()}
            <span>点</span>
          </div>
          <div className={styles.secondaryBalance}>
            <span>冻结点数</span>
            <b>{held.toLocaleString()} 点</b>
          </div>
          <Progress percentage={usagePercentage} label='累计消耗占比' className={styles.progress} />
          <div className={styles.infoRows}>
            <Info label='累计充值' value={`${lifetimeCredited.toLocaleString()} 点`} />
            <Info label='累计消耗' value={`${lifetimeConsumed.toLocaleString()} 点`} />
            <Info label='提醒阈值' value={`${threshold.toLocaleString()} 点`} />
            <Info label='点数有效期' value={expiryText} />
          </div>
          {canAdjust && (
            <div className={styles.accountActions}>
              <Button theme='primary' onClick={() => setOpen(true)}>
                给当前租户加点
              </Button>
              <div className={styles.actionHint}>只影响当前登录账号绑定租户；跨客户调账请切换到下方“运营调账”。</div>
            </div>
          )}
        </Card>

        <Card bordered title='点数包订阅' className={styles.packAreaCard}>
          <div className={styles.packBody}>
            <div className={styles.packHint}>
              创建订单后进入支付中心完成付款或对公确认；成功购买任一点数包后，账户内全部未消耗点数将统一续期。
            </div>
            <div className={styles.packGrid}>
              {packs.map((pack) => (
                <div className={styles.packCard} key={pack.code}>
                  <div className={styles.packName}>{pack.name}</div>
                  <div className={styles.packCredits}>
                    {Number(pack.credits).toLocaleString()}
                    <span>点</span>
                  </div>
                  <div className={styles.packDescription}>{pack.description}</div>
                  <div className={styles.packFooter}>
                    <Tag theme='danger' variant='light'>
                      ￥{Number(pack.price_yuan ?? pack.price_cents / 100).toLocaleString('zh-CN')}
                    </Tag>
                    <Button theme='primary' loading={loading} onClick={() => buy(pack)}>
                      创建订单
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <PendingOrdersPanel
        orders={account.orders || []}
        defaultType='credit_pack'
        showTypeTabs
        className={styles.pendingOrdersCard}
        onChanged={fetchData}
      />

      <Card bordered title='账户明细' className={styles.sectionCard}>
        <Tabs value={activeTab} onChange={(v) => setActiveTab(String(v))} className={styles.tabs}>
          <TabPanel value='ledger' label='当前租户流水' destroyOnHide={false}>
            <div className={styles.tableWrap}>
              <Table
                rowKey='id'
                data={transactions}
                columns={[
                  {
                    colKey: 'created_at',
                    title: '时间',
                    cell: ({ row }) => (row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : '-'),
                  },
                  { colKey: 'module', title: '模块' },
                  { colKey: 'description', title: '说明', ellipsis: true },
                  {
                    colKey: 'amount',
                    title: '点数',
                    cell: ({ row }) => (
                      <b className={Number(row.amount) < 0 ? styles.amountNegative : styles.amountPositive}>
                        {Number(row.amount) > 0 ? '+' : ''}
                        {row.amount}
                      </b>
                    ),
                  },
                  { colKey: 'entry_type', title: '类型' },
                ]}
              />
            </div>
          </TabPanel>
          {canAdjust && (
            <TabPanel value='adjustments' label='运营调账' destroyOnHide={false}>
              {activeTab === 'adjustments' && <BillingAdjustmentsPanel embedded />}
            </TabPanel>
          )}
        </Tabs>
      </Card>

      <Dialog
        visible={open}
        header='给当前租户加点'
        width={640}
        placement='center'
        dialogClassName={styles.adjustDialog}
        onClose={() => setOpen(false)}
        onCancel={() => setOpen(false)}
        onConfirm={adjust}
        cancelBtn='取消'
        confirmBtn={{ content: '确认加点', loading }}
      >
        <div className={styles.adjustDialogBody}>
          <div className={styles.targetPanel}>
            <div className={styles.targetLabel}>目标租户</div>
            <div className={styles.targetContent}>
              <strong>{tenant.name || user?.tenant_name || '当前租户'}</strong>
              <p>本操作只会调整当前登录账号绑定的租户。给其他客户加点请使用下方“运营调账”。</p>
            </div>
          </div>
          <Form layout='vertical' className={styles.adjustForm}>
            <FormItem label='加点数量'>
              <div className={styles.amountInput}>
                <InputNumber value={amount} min={1} onChange={(v) => setAmount(Number(v))} />
                <span>点</span>
              </div>
            </FormItem>
            <FormItem label='调整原因'>
              <Textarea
                value={reason}
                autosize={{ minRows: 4, maxRows: 6 }}
                placeholder='例如：测试环境补点、线下合同赠送、客户补偿'
                onChange={(v) => setReason(String(v))}
              />
            </FormItem>
            <FormItem label='有效期'>
              <Checkbox checked={refreshExpiry} onChange={(checked) => setRefreshExpiry(Boolean(checked))}>
                同步刷新客户点数有效期
              </Checkbox>
            </FormItem>
          </Form>
        </div>
      </Dialog>
    </div>
  );
};

const formatDateTime = (date: Date) =>
  date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

const formatRemaining = (seconds: number) => {
  if (seconds <= 0) return '点数已到期并清零';
  if (seconds < 60) return `还有 ${seconds} 秒到期`;
  if (seconds < 3600) return `还有 ${Math.ceil(seconds / 60)} 分钟到期`;
  if (seconds < 86400) return `还有 ${Math.ceil(seconds / 3600)} 小时到期`;
  return `还有 ${Math.ceil(seconds / 86400)} 天到期`;
};

const Info: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className={styles.infoRow}>
    <span>{label}</span>
    <b>{value}</b>
  </div>
);

const Metric: React.FC<{ label: string; value: string; suffix: string; tone?: 'primary' | 'danger' | 'warning' }> = ({
  label,
  value,
  suffix,
  tone,
}) => (
  <div className={`${styles.metric} ${tone ? styles[`metric_${tone}`] : ''}`}>
    <span>{label}</span>
    <b>
      {value}
      <em>{suffix}</em>
    </b>
  </div>
);

export default Credits;
