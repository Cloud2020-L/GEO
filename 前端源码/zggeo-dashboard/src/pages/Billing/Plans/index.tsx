import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, MessagePlugin, Table, Tag } from 'tdesign-react';
import PendingOrdersPanel from 'pages/Billing/components/PendingOrdersPanel';
import { BillingOrder, BillingPlan, createBillingOrder, getBillingAccount, getBillingPlans } from 'services/zggeo-api';

import styles from './index.module.less';

const Plans: React.FC = () => {
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [currentPlan, setCurrentPlan] = useState('standard');
  const [loadingCode, setLoadingCode] = useState('');

  const fetchData = async () => {
    try {
      const [planRows, account] = await Promise.all([getBillingPlans(), getBillingAccount()]);
      setPlans(planRows);
      setOrders(account.orders || []);
      setCurrentPlan(String(account.tenant?.plan || 'standard'));
    } catch (err: any) {
      MessagePlugin.error(`套餐数据加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const matrix = useMemo(
    () =>
      plans.map((plan) => ({
        code: plan.code,
        name: plan.name,
        price: priceText(plan),
        credits: plan.monthly_credits ? `${Number(plan.monthly_credits).toLocaleString()} 点/月` : '商务确认',
        projects: plan.max_projects ? `${plan.max_projects} 个` : '不限/定制',
        users: plan.max_users ? `${plan.max_users} 人` : '不限/定制',
      })),
    [plans],
  );

  const choosePlan = async (plan: BillingPlan) => {
    if (plan.code === currentPlan) return;
    setLoadingCode(plan.code);
    try {
      await createBillingOrder({
        order_type: 'plan_subscription',
        payment_method: 'bank',
        plan_code: plan.code,
      });
      MessagePlugin.success('已创建套餐订阅订单，请到支付中心完成确认');
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '套餐订单创建失败');
    } finally {
      setLoadingCode('');
    }
  };

  return (
    <div className={styles.page}>
      <Card bordered={false} className={styles.hero}>
        <div className={styles.heroContent}>
          <div className={styles.tags}>
            <Tag theme='primary' variant='light'>
              套餐权益
            </Tag>
            <Tag theme='success' variant='light'>
              当前套餐：{currentPlan}
            </Tag>
          </div>
          <h1>套餐 / 权益</h1>
          <p>套餐决定周期点数、项目数量、团队席位和模块权限。</p>
        </div>
      </Card>

      <div className={styles.planGrid}>
        {plans.map((plan) => {
          const active = plan.code === currentPlan;
          return (
            <Card bordered className={`${styles.planCard} ${active ? styles.activePlanCard : ''}`} key={plan.code}>
              <div className={styles.planContent}>
                <div className={styles.planHeader}>
                  <h2>{plan.name}</h2>
                  {active && (
                    <Tag theme='primary' variant='light'>
                      当前
                    </Tag>
                  )}
                </div>
                <div className={styles.price}>{priceText(plan)}</div>
                <div className={styles.quotaRows}>
                  <Info
                    label='月赠点数'
                    value={plan.monthly_credits ? `${plan.monthly_credits.toLocaleString()} 点` : '商务确认'}
                  />
                  <Info label='品牌项目' value={plan.max_projects ? `${plan.max_projects} 个` : '不限/定制'} />
                  <Info label='团队席位' value={plan.max_users ? `${plan.max_users} 人` : '不限/定制'} />
                </div>
                <div className={styles.planAction}>
                  <Button
                    theme={active ? 'default' : 'primary'}
                    disabled={active}
                    loading={loadingCode === plan.code}
                    onClick={() => choosePlan(plan)}
                  >
                    {active ? '当前套餐' : '选择套餐'}
                  </Button>
                </div>
                <div className={styles.planSection}>
                  <h3>包含权益</h3>
                  <ul>
                    {(plan.features || []).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className={`${styles.planSection} ${styles.limitSection}`}>
                  <h3>限制说明</h3>
                  <ul>
                    {(plan.limits || []).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <PendingOrdersPanel
        orders={orders}
        defaultType='plan_subscription'
        showTypeTabs
        className={styles.pendingOrdersCard}
        onChanged={fetchData}
      />

      <Card bordered title='权益矩阵' className={styles.matrixCard}>
        <Table
          rowKey='code'
          data={matrix}
          columns={[
            { colKey: 'name', title: '套餐' },
            { colKey: 'price', title: '月费' },
            { colKey: 'credits', title: '月赠点数' },
            { colKey: 'projects', title: '品牌项目' },
            { colKey: 'users', title: '团队席位' },
          ]}
        />
      </Card>
    </div>
  );
};

const priceText = (plan: BillingPlan) => {
  if (!plan.price_monthly) return plan.code === 'enterprise' ? '商务定制' : '￥0/月';
  return `￥${Number(plan.price_monthly_yuan ?? plan.price_monthly / 100).toLocaleString('zh-CN')}/月`;
};

const Info: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className={styles.infoRow}>
    <span>{label}</span>
    <b>{value}</b>
  </div>
);

export default Plans;
