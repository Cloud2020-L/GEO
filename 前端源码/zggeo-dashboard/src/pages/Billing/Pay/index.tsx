import React, { useEffect, useState } from 'react';
import { Card, MessagePlugin, Tag } from 'tdesign-react';
import { useAppSelector } from 'modules/store';
import BankTransferInfo from 'pages/Billing/components/BankTransferInfo';
import ManualOrderForm from 'pages/Billing/components/ManualOrderForm';
import OrderHistoryPanel from 'pages/Billing/components/OrderHistoryPanel';
import PendingOrdersPanel from 'pages/Billing/components/PendingOrdersPanel';
import { BillingOrderSummary, getAdminBillingOrderSummary, getBillingOrderSummary } from 'services/zggeo-api';

import styles from './index.module.less';

const EMPTY_SUMMARY: BillingOrderSummary = {
  total: 0,
  pending: 0,
  paid: 0,
  cancelled: 0,
  expired: 0,
  failed: 0,
  paid_amount_cents: 0,
  pending_amount_cents: 0,
  paid_amount_yuan: 0,
  pending_amount_yuan: 0,
};

const Pay: React.FC = () => {
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || 'client').toLowerCase();
  const canManageBilling = ['admin', 'operator'].includes(role);
  const [summary, setSummary] = useState<BillingOrderSummary>(EMPTY_SUMMARY);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadSummary = async () => {
    if (!canManageBilling) return getBillingOrderSummary();
    try {
      return await getAdminBillingOrderSummary();
    } catch (err: any) {
      if (err?.response?.status === 404) {
        return getBillingOrderSummary();
      }
      throw err;
    }
  };

  const fetchSummary = async () => {
    try {
      setSummary(await loadSummary());
    } catch (err: any) {
      MessagePlugin.error(`订单统计加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    }
  };

  useEffect(() => {
    fetchSummary();
  }, [canManageBilling]);

  const refreshAll = async () => {
    setRefreshKey((value) => value + 1);
    await fetchSummary();
  };

  return (
    <div className={styles.page}>
      <Card bordered={false} className={styles.hero}>
        <div className={styles.heroMain}>
          <div>
            <div className={styles.tags}>
              <Tag theme='primary' variant='light'>
                订单 / 支付
              </Tag>
              <Tag theme='success' variant='light'>
                对公优先
              </Tag>
            </div>
            <h1>支付中心</h1>
            <p>
              {canManageBilling
                ? '统一处理全部租户商业订单、对公确认和履约追踪。'
                : '查看自己的订单、取消待支付订单，并按订单号完成对公转账。'}
            </p>
          </div>
          <div className={styles.summaryGrid}>
            <Metric label='待支付' value={`${summary.pending.toLocaleString()} 笔`} tone='warning' />
            <Metric label='已支付' value={`${summary.paid.toLocaleString()} 笔`} tone='success' />
            <Metric label='已取消' value={`${summary.cancelled.toLocaleString()} 笔`} />
            <Metric
              label='已确认金额'
              value={`￥${Number(summary.paid_amount_yuan || 0).toLocaleString('zh-CN')}`}
              tone='primary'
            />
            <Metric
              label='待确认金额'
              value={`￥${Number(summary.pending_amount_yuan || 0).toLocaleString('zh-CN')}`}
              tone='warning'
            />
          </div>
        </div>
      </Card>

      <PendingOrdersPanel
        defaultType='all'
        showTypeTabs
        showTenantFilter={canManageBilling}
        scope={canManageBilling ? 'allTenants' : 'currentTenant'}
        showConfirmPayment={canManageBilling}
        refreshKey={refreshKey}
        onChanged={refreshAll}
      />

      <div className={canManageBilling ? styles.opsGrid : styles.singleGrid}>
        {canManageBilling ? <ManualOrderForm onCreated={refreshAll} /> : null}
        <BankTransferInfo />
      </div>

      <OrderHistoryPanel
        scope={canManageBilling ? 'allTenants' : 'currentTenant'}
        showTenantFilter={canManageBilling}
        refreshKey={refreshKey}
      />
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string; tone?: 'primary' | 'success' | 'warning' }> = ({
  label,
  value,
  tone,
}) => (
  <div className={`${styles.metric} ${tone ? styles[`metric_${tone}`] : ''}`}>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

export default Pay;
