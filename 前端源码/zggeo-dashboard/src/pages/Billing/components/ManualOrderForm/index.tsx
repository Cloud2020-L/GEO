import React, { useEffect, useState } from 'react';
import { Button, Card, Form, Input, InputNumber, MessagePlugin, Radio, Select } from 'tdesign-react';
import { createBillingOrder, getAdminBillingAccounts } from 'services/zggeo-api';

import styles from './index.module.less';

const { FormItem } = Form;

type ManualOrderFormProps = {
  className?: string;
  onCreated?: () => Promise<void> | void;
};

const ManualOrderForm: React.FC<ManualOrderFormProps> = ({ className, onCreated }) => {
  const [tenantId, setTenantId] = useState('');
  const [accounts, setAccounts] = useState<Array<Record<string, any>>>([]);
  const [method, setMethod] = useState<'wechat' | 'alipay' | 'bank'>('bank');
  const [amount, setAmount] = useState(999);
  const [credits, setCredits] = useState(8000);
  const [description, setDescription] = useState('线下合同 / 自定义点数入账');
  const [loading, setLoading] = useState(false);

  const fetchAccounts = async () => {
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
    fetchAccounts();
  }, []);

  const createManualOrder = async () => {
    const cleanDescription = description.trim();
    if (!tenantId) {
      MessagePlugin.warning('请选择客户租户');
      return;
    }
    if (!cleanDescription) {
      MessagePlugin.warning('请填写订单说明');
      return;
    }
    setLoading(true);
    try {
      await createBillingOrder({
        tenant_id: tenantId,
        order_type: 'manual_contract',
        payment_method: method,
        amount_cents: Math.round(Number(amount || 0) * 100),
        credits: Number(credits || 0),
        description: cleanDescription,
      });
      MessagePlugin.success('已创建线下合同订单');
      await onCreated?.();
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '创建订单失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card bordered title='创建自定义订单' className={`${styles.card} ${className || ''}`}>
      <Form layout='vertical' className={styles.form}>
        <FormItem label='客户租户'>
          <Select
            value={tenantId}
            filterable
            placeholder='请选择客户租户'
            options={accounts.map((item) => ({
              label: `${item.tenant_name || item.tenant_id} · ${Number(
                item.available_balance || 0,
              ).toLocaleString()} 点`,
              value: item.tenant_id,
            }))}
            onChange={(value) => setTenantId(String(value || ''))}
          />
        </FormItem>
        <FormItem label='订单说明'>
          <Input value={description} placeholder='请输入' onChange={(value) => setDescription(String(value || ''))} />
        </FormItem>
        <div className={styles.twoCol}>
          <FormItem label='支付金额'>
            <InputNumber value={amount} min={0} onChange={(value) => setAmount(Number(value))} suffix='元' />
          </FormItem>
          <FormItem label='入账点数'>
            <InputNumber value={credits} min={0} onChange={(value) => setCredits(Number(value))} suffix='点' />
          </FormItem>
        </div>
        <FormItem label='支付方式'>
          <Radio.Group value={method} onChange={(value) => setMethod(String(value) as typeof method)}>
            <Radio.Button value='bank'>对公转账</Radio.Button>
            <Radio.Button value='wechat'>微信支付</Radio.Button>
            <Radio.Button value='alipay'>支付宝</Radio.Button>
          </Radio.Group>
        </FormItem>
        <div className={styles.actions}>
          <Button theme='primary' loading={loading} onClick={createManualOrder}>
            创建支付订单
          </Button>
        </div>
      </Form>
    </Card>
  );
};

export default ManualOrderForm;
