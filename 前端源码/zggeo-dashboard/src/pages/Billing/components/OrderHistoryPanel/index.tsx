import React, { useEffect, useState } from 'react';
import { Card, MessagePlugin, Select, Table, Tabs, Tag } from 'tdesign-react';
import { useAppSelector } from 'modules/store';
import {
  BillingOrder,
  getAdminBillingAccounts,
  getAdminBillingOrderSummary,
  getAdminBillingOrdersPage,
  getBillingOrderSummary,
  getBillingOrdersPage,
} from 'services/zggeo-api';

import styles from './index.module.less';

const { TabPanel } = Tabs;

type StatusFilter = 'all' | 'pending' | 'paid' | 'cancelled' | 'expired' | 'failed';
type TypeFilter = 'all' | 'credit_pack' | 'plan_subscription' | 'manual_contract';

type OrderHistoryPanelProps = {
  scope?: 'currentTenant' | 'allTenants';
  showTenantFilter?: boolean;
  refreshKey?: number;
};

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待支付' },
  { value: 'paid', label: '已支付' },
  { value: 'cancelled', label: '已取消' },
  { value: 'expired', label: '已过期' },
  { value: 'failed', label: '支付失败' },
];

const TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'credit_pack', label: '点数包订单' },
  { value: 'plan_subscription', label: '套餐权益订单' },
  { value: 'manual_contract', label: '线下合同订单' },
];

const ORDER_TYPE_LABEL: Record<string, string> = {
  credit_pack: '点数包订单',
  plan_subscription: '套餐权益订单',
  manual_contract: '线下合同订单',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  cancelled: '已取消',
  expired: '已过期',
  failed: '支付失败',
};

const STATUS_THEME: Record<string, 'default' | 'primary' | 'warning' | 'danger' | 'success'> = {
  pending: 'warning',
  paid: 'success',
  cancelled: 'default',
  expired: 'default',
  failed: 'danger',
};

const PAYMENT_LABEL: Record<string, string> = {
  wechat: '微信支付',
  alipay: '支付宝',
  bank: '对公转账',
};

const OrderHistoryPanel: React.FC<OrderHistoryPanelProps> = ({
  scope = 'currentTenant',
  showTenantFilter = false,
  refreshKey = 0,
}) => {
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || 'client').toLowerCase();
  const canManageBilling = ['admin', 'operator'].includes(role);
  const useAdminApi = scope === 'allTenants' && canManageBilling;
  const [status, setStatus] = useState<StatusFilter>('all');
  const [orderType, setOrderType] = useState<TypeFilter>('all');
  const [tenantId, setTenantId] = useState('');
  const [accounts, setAccounts] = useState<Array<Record<string, any>>>([]);
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<StatusFilter, number>>({
    all: 0,
    pending: 0,
    paid: 0,
    cancelled: 0,
    expired: 0,
    failed: 0,
  });

  const loadOrders = async (params: {
    page: number;
    page_size: number;
    status?: StatusFilter;
    order_type?: TypeFilter;
    tenant_id?: string;
  }) => {
    if (!useAdminApi) return getBillingOrdersPage(params);
    try {
      return await getAdminBillingOrdersPage(params);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        return getBillingOrdersPage(params);
      }
      throw err;
    }
  };

  const loadSummary = async (params?: { tenant_id?: string }) => {
    if (!useAdminApi) return getBillingOrderSummary();
    try {
      return await getAdminBillingOrderSummary(params);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        return getBillingOrderSummary();
      }
      throw err;
    }
  };

  const fetchAccounts = async () => {
    if (!showTenantFilter || !canManageBilling) return;
    try {
      setAccounts(await getAdminBillingAccounts());
    } catch (err: any) {
      if (err?.response?.status === 404) {
        setAccounts([]);
        return;
      }
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '租户列表加载失败');
    }
  };

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const params = {
        page,
        page_size: pageSize,
        status: status === 'all' ? undefined : status,
        order_type: orderType === 'all' ? undefined : orderType,
        tenant_id: useAdminApi && tenantId ? tenantId : undefined,
      };
      const result = await loadOrders(params);
      setOrders(result.items || []);
      setTotal(Number(result.total || 0));
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '订单历史加载失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchSummary = async () => {
    try {
      const summary = await loadSummary({ tenant_id: useAdminApi && tenantId ? tenantId : undefined });
      setStatusCounts({
        all: Number(summary.total || 0),
        pending: Number(summary.pending || 0),
        paid: Number(summary.paid || 0),
        cancelled: Number(summary.cancelled || 0),
        expired: Number(summary.expired || 0),
        failed: Number(summary.failed || 0),
      });
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '订单统计加载失败');
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, [showTenantFilter, canManageBilling]);

  useEffect(() => {
    fetchOrders();
  }, [status, orderType, tenantId, useAdminApi, page, pageSize, refreshKey]);

  useEffect(() => {
    fetchSummary();
  }, [tenantId, useAdminApi, refreshKey]);

  return (
    <Card bordered title='订单历史' className={styles.card}>
      <div className={styles.toolbar}>
        <Tabs
          value={status}
          onChange={(value) => {
            setStatus(String(value) as StatusFilter);
            setPage(1);
          }}
          className={styles.statusTabs}
        >
          {STATUS_OPTIONS.map((item) => (
            <TabPanel value={item.value} label={`${item.label} ${statusCounts[item.value]}`} key={item.value} />
          ))}
        </Tabs>
        <div className={styles.filters}>
          <Select
            value={orderType}
            options={TYPE_OPTIONS}
            className={styles.typeFilter}
            onChange={(value) => {
              setOrderType(String(value) as TypeFilter);
              setPage(1);
            }}
          />
          {showTenantFilter && canManageBilling ? (
            <Select
              value={tenantId}
              clearable
              filterable
              placeholder='全部租户'
              className={styles.tenantFilter}
              options={accounts.map((item) => ({
                label: item.tenant_name || item.tenant_id,
                value: item.tenant_id,
              }))}
              onChange={(value) => {
                setTenantId(String(value || ''));
                setPage(1);
              }}
            />
          ) : null}
        </div>
      </div>
      {orders.length === 0 ? (
        <div className={styles.empty}>暂无订单记录</div>
      ) : (
        <Table
          rowKey='id'
          data={orders}
          loading={loading}
          pagination={{
            current: page,
            pageSize,
            total,
            showJumper: true,
            pageSizeOptions: [10, 20, 50, 100],
            onCurrentChange(current) {
              setPage(current);
            },
            onPageSizeChange(size) {
              setPageSize(size);
              setPage(1);
            },
          }}
          columns={[
            { colKey: 'order_no', title: '订单号', ellipsis: true, width: 220 },
            {
              colKey: 'order_type',
              title: '类型',
              width: 130,
              cell: ({ row }) => ORDER_TYPE_LABEL[row.order_type] || row.order_type,
            },
            ...(useAdminApi
              ? [
                  {
                    colKey: 'tenant_name',
                    title: '租户',
                    width: 160,
                    ellipsis: true,
                    cell: ({ row }: { row: BillingOrder }) => row.tenant_name || row.tenant_id || '-',
                  },
                ]
              : []),
            { colKey: 'description', title: '说明', ellipsis: true },
            {
              colKey: 'amount_yuan',
              title: '金额',
              width: 120,
              cell: ({ row }) => `￥${Number(row.amount_yuan || 0).toLocaleString('zh-CN')}`,
            },
            {
              colKey: 'credits',
              title: '点数',
              width: 120,
              cell: ({ row }) => `${Number(row.credits || 0).toLocaleString()} 点`,
            },
            {
              colKey: 'payment_method',
              title: '支付方式',
              width: 120,
              cell: ({ row }) => PAYMENT_LABEL[row.payment_method || 'bank'] || row.payment_method || '-',
            },
            {
              colKey: 'status',
              title: '状态',
              width: 110,
              cell: ({ row }) => (
                <Tag theme={STATUS_THEME[row.status] || 'default'}>{STATUS_LABEL[row.status] || row.status}</Tag>
              ),
            },
            {
              colKey: 'created_at',
              title: '创建时间',
              width: 180,
              cell: ({ row }) => (row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : '-'),
            },
            {
              colKey: 'paid_at',
              title: '支付时间',
              width: 180,
              cell: ({ row }) => (row.paid_at ? new Date(row.paid_at).toLocaleString('zh-CN') : '-'),
            },
          ]}
        />
      )}
    </Card>
  );
};

export default OrderHistoryPanel;
