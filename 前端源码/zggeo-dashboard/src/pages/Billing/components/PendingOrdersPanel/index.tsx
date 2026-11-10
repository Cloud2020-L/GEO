import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, MessagePlugin, Select, Table, Tabs, Tag } from 'tdesign-react';
import { useAppSelector } from 'modules/store';
import {
  BillingOrder,
  cancelAdminBillingOrder,
  cancelBillingOrder,
  getAdminBillingAccounts,
  getAdminBillingOrderSummary,
  getAdminBillingOrdersPage,
  getBillingOrderSummary,
  getBillingOrdersPage,
  markBillingOrderPaid,
} from 'services/zggeo-api';

import styles from './index.module.less';

const { TabPanel } = Tabs;

export type PendingOrderType = 'all' | 'credit_pack' | 'plan_subscription' | 'manual_contract';

type PendingOrdersPanelProps = {
  title?: string;
  orders?: BillingOrder[];
  defaultType?: PendingOrderType;
  showTypeTabs?: boolean;
  showTenantFilter?: boolean;
  scope?: 'currentTenant' | 'allTenants';
  showConfirmPayment?: boolean;
  className?: string;
  refreshKey?: number;
  onChanged?: () => Promise<void> | void;
};

const ORDER_TYPE_OPTIONS: Array<{ value: PendingOrderType; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'credit_pack', label: '点数包订单' },
  { value: 'plan_subscription', label: '套餐权益订单' },
  { value: 'manual_contract', label: '线下合同订单' },
];

const ORDER_TYPE_LABEL: Record<string, string> = {
  credit_pack: '点数包订单',
  plan_subscription: '套餐权益订单',
  manual_contract: '线下合同订单',
};

const PendingOrdersPanel: React.FC<PendingOrdersPanelProps> = ({
  title = '待支付订单',
  orders,
  defaultType = 'all',
  showTypeTabs = true,
  showTenantFilter = false,
  scope = 'currentTenant',
  showConfirmPayment = false,
  className,
  refreshKey = 0,
  onChanged,
}) => {
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || 'client').toLowerCase();
  const canManageBilling = ['admin', 'operator'].includes(role);
  const canCancel = ['client', 'admin', 'operator'].includes(role);
  const canConfirm = canManageBilling && showConfirmPayment;
  const useAdminApi = scope === 'allTenants' && canManageBilling;
  const [activeType, setActiveType] = useState<PendingOrderType>(defaultType);
  const [tenantId, setTenantId] = useState('');
  const [accounts, setAccounts] = useState<Array<Record<string, any>>>([]);
  const [remoteOrders, setRemoteOrders] = useState<BillingOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionOrderId, setActionOrderId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [remoteCounts, setRemoteCounts] = useState<Record<PendingOrderType, number>>({
    all: 0,
    credit_pack: 0,
    plan_subscription: 0,
    manual_contract: 0,
  });

  const controlledOrders = orders !== undefined;

  const loadOrders = async (params: {
    status: string;
    page: number;
    page_size: number;
    order_type?: string;
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

  const fetchOrders = async () => {
    if (controlledOrders) return;
    setLoading(true);
    try {
      const params = {
        status: 'pending',
        page,
        page_size: pageSize,
        order_type: activeType === 'all' ? undefined : activeType,
        tenant_id: useAdminApi && tenantId ? tenantId : undefined,
      };
      const result = await loadOrders(params);
      setRemoteOrders(result.items || []);
      setTotal(Number(result.total || 0));
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '待支付订单加载失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchSummary = async () => {
    if (controlledOrders) return;
    try {
      const summary = await loadSummary({ tenant_id: useAdminApi && tenantId ? tenantId : undefined });
      const pendingTypeCounts = summary.pending_type_counts || {};
      setRemoteCounts({
        all: Number(pendingTypeCounts.all ?? summary.pending ?? 0),
        credit_pack: Number(pendingTypeCounts.credit_pack || 0),
        plan_subscription: Number(pendingTypeCounts.plan_subscription || 0),
        manual_contract: Number(pendingTypeCounts.manual_contract || 0),
      });
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '待支付订单统计加载失败');
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

  useEffect(() => {
    setActiveType(defaultType);
  }, [defaultType]);

  useEffect(() => {
    fetchAccounts();
  }, [showTenantFilter, canManageBilling]);

  useEffect(() => {
    fetchOrders();
  }, [controlledOrders, useAdminApi, tenantId, activeType, page, pageSize, refreshKey]);

  useEffect(() => {
    fetchSummary();
  }, [controlledOrders, useAdminApi, tenantId, refreshKey]);

  const sourceOrders = useMemo(
    () => (controlledOrders ? orders || [] : remoteOrders).filter((order) => order.status === 'pending'),
    [controlledOrders, orders, remoteOrders],
  );

  const counts = useMemo(() => {
    const result: Record<PendingOrderType, number> = {
      all: sourceOrders.length,
      credit_pack: 0,
      plan_subscription: 0,
      manual_contract: 0,
    };
    sourceOrders.forEach((order) => {
      const type = order.order_type as PendingOrderType;
      if (type in result) result[type] += 1;
    });
    return result;
  }, [sourceOrders]);

  const effectiveCounts = controlledOrders ? counts : remoteCounts;

  const filteredOrders = useMemo(() => {
    if (!controlledOrders) return sourceOrders;
    return sourceOrders.filter((order) => activeType === 'all' || order.order_type === activeType);
  }, [controlledOrders, sourceOrders, activeType]);

  const pageTotal = controlledOrders ? filteredOrders.length : total;

  const refresh = async () => {
    if (!controlledOrders) {
      await Promise.all([fetchOrders(), fetchSummary()]);
    }
    await onChanged?.();
  };

  const cancelOrder = async (order: BillingOrder) => {
    if (!canCancel) return;
    if (!window.confirm(`确认取消待支付订单「${order.order_no}」？取消后不会入账。`)) return;
    setActionOrderId(order.id);
    try {
      if (useAdminApi) {
        await cancelAdminBillingOrder(order.id);
      } else {
        await cancelBillingOrder(order.id);
      }
      MessagePlugin.success('已取消订单');
      await refresh();
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '取消订单失败');
    } finally {
      setActionOrderId('');
    }
  };

  const confirmPaid = async (order: BillingOrder) => {
    if (!canConfirm) return;
    if (!window.confirm(`确认订单「${order.order_no}」已到账？`)) return;
    setActionOrderId(order.id);
    try {
      await markBillingOrderPaid(order.id);
      MessagePlugin.success('已确认到账');
      await refresh();
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '确认到账失败');
    } finally {
      setActionOrderId('');
    }
  };

  return (
    <Card bordered title={title} className={`${styles.panel} ${className || ''}`}>
      <div className={styles.toolbar}>
        {showTypeTabs ? (
          <Tabs
            value={activeType}
            onChange={(value) => {
              setActiveType(String(value) as PendingOrderType);
              setPage(1);
            }}
            className={styles.typeTabs}
          >
            {ORDER_TYPE_OPTIONS.map((item) => (
              <TabPanel value={item.value} label={`${item.label} ${effectiveCounts[item.value]}`} key={item.value} />
            ))}
          </Tabs>
        ) : null}
        {showTenantFilter && canManageBilling ? (
          <Select
            className={styles.tenantFilter}
            value={tenantId}
            clearable
            filterable
            placeholder='全部租户'
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
      {filteredOrders.length === 0 ? (
        <div className={styles.empty}>暂无待支付订单</div>
      ) : (
        <Table
          rowKey='id'
          data={filteredOrders}
          loading={loading}
          pagination={
            controlledOrders
              ? undefined
              : {
                  current: page,
                  pageSize,
                  total: pageTotal,
                  showJumper: true,
                  pageSizeOptions: [10, 20, 50, 100],
                  onCurrentChange(current) {
                    setPage(current);
                  },
                  onPageSizeChange(size) {
                    setPageSize(size);
                    setPage(1);
                  },
                }
          }
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
              colKey: 'credits',
              title: '点数/权益',
              width: 130,
              cell: ({ row }) => formatOrderBenefit(row),
            },
            {
              colKey: 'amount_yuan',
              title: '金额',
              width: 120,
              cell: ({ row }) => `￥${Number(row.amount_yuan || 0).toLocaleString('zh-CN')}`,
            },
            {
              colKey: 'status',
              title: '状态',
              width: 100,
              cell: () => <Tag theme='warning'>待支付</Tag>,
            },
            {
              colKey: 'operation',
              title: '操作',
              width: canConfirm ? 210 : 130,
              cell: ({ row }) => (
                <div className={styles.actions}>
                  {canConfirm ? (
                    <Button
                      size='small'
                      variant='outline'
                      loading={actionOrderId === row.id}
                      onClick={() => confirmPaid(row)}
                    >
                      确认到账
                    </Button>
                  ) : null}
                  {canCancel ? (
                    <Button
                      theme='danger'
                      variant='outline'
                      size='small'
                      loading={actionOrderId === row.id}
                      onClick={() => cancelOrder(row)}
                    >
                      取消订单
                    </Button>
                  ) : (
                    '-'
                  )}
                </div>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
};

const formatOrderBenefit = (order: BillingOrder) => {
  if (order.order_type === 'plan_subscription') {
    return order.plan_code
      ? `${order.plan_code} · ${Number(order.credits || 0).toLocaleString()} 点`
      : `${Number(order.credits || 0).toLocaleString()} 点`;
  }
  if (order.order_type === 'manual_contract') {
    return `${Number(order.credits || 0).toLocaleString()} 点`;
  }
  return `${Number(order.credits || 0).toLocaleString()} 点`;
};

export default PendingOrdersPanel;
