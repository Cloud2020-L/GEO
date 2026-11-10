import React from 'react';
import { Card, Tag } from 'tdesign-react';

import styles from './index.module.less';

const BankTransferInfo: React.FC<{ className?: string }> = ({ className }) => (
  <Card bordered title='对公转账信息' className={`${styles.card} ${className || ''}`}>
    <div className={styles.infoList}>
      <Info label='账户名称' value='请配置公司主体' />
      <Info label='开户银行' value='请配置开户行' />
      <Info label='银行账号' value='请配置对公账号' />
      <Info label='转账备注' value='订单号 / 客户名称' />
      <Tag theme='warning' variant='light'>
        微信与支付宝商户参数接入后可切换为自动回调入账
      </Tag>
    </div>
  </Card>
);

const Info: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className={styles.infoItem}>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

export default BankTransferInfo;
