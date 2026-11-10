import React, { memo, useState } from 'react';
import { Button, Card, Input, MessagePlugin, Space, Tag } from 'tdesign-react';
import { BrowserRouterProps, useNavigate } from 'react-router-dom';
import { useAppSelector } from 'modules/store';
import { authChangePassword } from 'services/zggeo-api';
import { setStoredUser } from 'utils/scopedStorage';
import styles from './index.module.less';

const ROLE_LABEL: Record<string, string> = {
  admin: '超级管理员',
  delivery: '交付运营',
  sales: '销售顾问',
  client: '客户会员',
};

const ROLE_DESC: Record<string, string> = {
  admin: '管理成员、配置权限、查看全部客户项目和系统日志。',
  delivery: '负责客户诊断、GEO 资产生成、内容交付和复测闭环。',
  sales: '负责留资跟进、客户资产补齐、报告查看和商务推进。',
  client: '查看自己的项目资料、诊断报告、部署资产和交付进度。',
};

const User: React.FC<BrowserRouterProps> = () => {
  const navigate = useNavigate();
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || 'client');
  const isClient = role === 'client';
  const name = String(user?.name || user?.email || '未命名账号');
  const tenantName = String(user?.tenant_name || user?.tenant || (isClient ? '客户空间' : 'ZGEO 智改'));
  const plan = String(user?.plan || (isClient ? 'member' : 'standard'));
  const credits = Number(user?.credit_balance ?? 0);
  const initial = name.slice(0, 1).toUpperCase();
  const [mustChangePassword, setMustChangePassword] = useState(Boolean(user?.must_change_password));
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [changingPassword, setChangingPassword] = useState(false);

  const submitPasswordChange = async () => {
    if (!passwordForm.current_password || !passwordForm.new_password) {
      MessagePlugin.warning('请填写当前密码和新密码');
      return;
    }
    if (passwordForm.new_password.length < 8) {
      MessagePlugin.warning('新密码至少 8 位');
      return;
    }
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      MessagePlugin.warning('两次输入的新密码不一致');
      return;
    }
    setChangingPassword(true);
    try {
      await authChangePassword({
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password,
      });
      const nextUser = { ...user, must_change_password: false };
      setStoredUser(nextUser);
      setMustChangePassword(false);
      setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
      MessagePlugin.success('密码已修改');
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      MessagePlugin.error(typeof detail === 'string' ? detail : err?.message || '修改密码失败');
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.heroMain}>
          <Space size={10}>
            <Tag theme={isClient ? 'success' : 'primary'} variant='light'>
              {ROLE_LABEL[role] || role}
            </Tag>
            <Tag variant='light'>{tenantName}</Tag>
          </Space>
          <div className={styles.title}>你好，{name}</div>
          <div className={styles.desc}>{ROLE_DESC[role] || '登录后可访问授权范围内的 ZGEO 功能。'}</div>
          <div className={styles.heroActions}>
            <Button theme='primary' onClick={() => navigate(isClient ? '/reports/export' : '/funnel/customers')}>
              {isClient ? '查看交付报告' : '进入客户资产'}
            </Button>
            <Button variant='outline' onClick={() => navigate('/monitoring/geo-assets')}>
              GEO 资产生成
            </Button>
          </div>
        </div>

        <div className={styles.profileCard}>
          <div className={styles.avatar}>{initial}</div>
          <div className={styles.profileName}>{name}</div>
          <div className={styles.profileMeta}>{tenantName}</div>
          <div className={styles.creditBox}>
            <span>账户点数</span>
            <strong>{credits.toLocaleString('zh-CN')}</strong>
          </div>
        </div>
      </div>

      {mustChangePassword && (
        <Card bordered={false} title='安全提醒' className={styles.securityCard}>
          <div className={styles.securityNotice}>
            当前账号仍在使用初始密码或管理员要求改密。上线前必须修改密码，避免默认账号被直接撞库登录。
          </div>
        </Card>
      )}

      <div className={styles.grid}>
        <Card bordered={false} title='账号信息' className={styles.section}>
          <div className={styles.infoGrid}>
            <Info label='登录邮箱' value={String(user?.email || '-')} />
            <Info label='账号类型' value={ROLE_LABEL[role] || role} />
            <Info label='所属租户 / 客户' value={tenantName} />
            <Info label='套餐 / 权益' value={plan} />
            <Info label='状态' value={String(user?.status || 'active')} />
            <Info
              label='最近登录'
              value={user?.last_login_at ? new Date(String(user.last_login_at)).toLocaleString('zh-CN') : '本次登录'}
            />
          </div>
        </Card>

        <Card bordered={false} title='可访问能力' className={styles.section}>
          <div className={styles.scopeList}>
            <div className={styles.scopeItem}>监测任务、报告、资产、内容、分发在同一后台连续流转</div>
            <div className={styles.scopeItem}>
              {isClient ? '客户可查看自己的报告、资产和交付进度' : '员工可进入客户资产、Agent 自动运作和系统配置'}
            </div>
            <div className={styles.scopeItem}>统一角色权限分流，避免员工与客户入口混用</div>
          </div>
        </Card>

        <Card bordered={false} title={isClient ? '客户常用入口' : '员工常用入口'} className={styles.section}>
          <Space direction='vertical' className={styles.linkList}>
            <Button variant='text' onClick={() => navigate('/monitoring/tasks')}>
              监测任务
            </Button>
            <Button variant='text' onClick={() => navigate('/monitoring/geo-assets')}>
              GEO 资产生成
            </Button>
            <Button variant='text' onClick={() => navigate('/reports/export')}>
              报告导出
            </Button>
            {!isClient && (
              <Button variant='text' onClick={() => navigate('/system/users')}>
                成员管理
              </Button>
            )}
          </Space>
        </Card>

        <Card bordered={false} title='修改登录密码' className={styles.section}>
          <Space direction='vertical' className={styles.passwordForm}>
            <Input
              type='password'
              value={passwordForm.current_password}
              placeholder='当前密码'
              onChange={(value) => setPasswordForm({ ...passwordForm, current_password: String(value) })}
            />
            <Input
              type='password'
              value={passwordForm.new_password}
              placeholder='新密码，至少 8 位'
              onChange={(value) => setPasswordForm({ ...passwordForm, new_password: String(value) })}
            />
            <Input
              type='password'
              value={passwordForm.confirm_password}
              placeholder='再次输入新密码'
              onChange={(value) => setPasswordForm({ ...passwordForm, confirm_password: String(value) })}
            />
            <Button theme='primary' loading={changingPassword} onClick={submitPasswordChange}>
              保存新密码
            </Button>
          </Space>
        </Card>
      </div>
    </div>
  );
};

const Info: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className={styles.infoItem}>
    <div className={styles.label}>{label}</div>
    <div className={styles.value}>{value}</div>
  </div>
);

export default memo(User);
