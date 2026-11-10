import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Checkbox,
  Form,
  type FormInstanceFunctions,
  Input,
  MessagePlugin,
  type SubmitContext,
  Tag,
} from 'tdesign-react';
import { BrowseIcon, BrowseOffIcon, LockOnIcon, UserIcon } from 'tdesign-icons-react';
import { useAppDispatch } from 'modules/store';
import { login, logout } from 'modules/user';
import { isClientPortal } from 'configs/portal';

import Style from './index.module.less';

const { FormItem } = Form;

export type LoginAudience = 'staff' | 'client';

const ROLE_LABEL: Record<string, string> = {
  admin: '超级管理员',
  delivery: '交付运营',
  sales: '销售顾问',
  client: '客户会员',
};

export default function Login() {
  const audience: LoginAudience = isClientPortal ? 'client' : 'staff';
  const [showPsw, toggleShowPsw] = useState(false);
  const formRef = useRef<FormInstanceFunctions>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();

  const onSubmit = async (e: SubmitContext) => {
    if (e.validateResult !== true) return;
    const formValue = formRef.current?.getFieldsValue?.(true) || {};
    try {
      const action = await dispatch(login(formValue)).unwrap();
      const user = (action.user || {}) as Record<string, any>;
      const role = String(user.role || 'client');

      if (audience === 'staff' && role === 'client') {
        dispatch(logout());
        MessagePlugin.warning('这是客户会员账号，请切换到“客户会员登录”入口');
        return;
      }

      if (audience === 'client' && role !== 'client') {
        dispatch(logout());
        MessagePlugin.warning('这是内部员工账号，请切换到“内部员工登录”入口');
        return;
      }

      MessagePlugin.success(`登录成功：${ROLE_LABEL[role] || role}`);

      navigate('/overview/index');
    } catch (err: any) {
      // login thunk 用 rejectWithValue 透出的字符串会直接作为 err
      // 未走 rejectWithValue 的兜底再尝试从 axios 响应里取 detail / message
      const msg =
        (typeof err === 'string' && err) || err?.message || err?.response?.data?.detail || '登录失败，请检查账号和密码';
      // eslint-disable-next-line no-console
      console.error('[login] failed:', err);
      MessagePlugin.error(msg);
    }
  };

  return (
    <div className={`${Style.loginShell} ${audience === 'staff' ? Style.staffLoginShell : ''}`}>
      <div className={Style.loginNotice}>
        <Tag theme={audience === 'staff' ? 'primary' : 'success'} variant='light'>
          {audience === 'staff' ? '员工后台' : '客户空间'}
        </Tag>
        <span>
          {audience === 'staff'
            ? '员工账号由系统管理创建，用于客户资产、监测诊断、内容生产和交付管理。'
            : '客户会员账号由员工开通，用于查看自己的项目资料、诊断报告和交付结果。'}
        </span>
      </div>
      <Form ref={formRef} className={Style.itemContainer} labelWidth={0} onSubmit={onSubmit}>
        <FormItem name='username' rules={[{ required: true, message: '用户名必填', type: 'error' }]}>
          <Input
            size='large'
            placeholder={audience === 'staff' ? '员工用户名，例如：admin 或 线上管理员' : '客户会员用户名'}
            prefixIcon={<UserIcon />}
          />
        </FormItem>
        <FormItem name='password' rules={[{ required: true, message: '密码必填', type: 'error' }]}>
          <Input
            size='large'
            type={showPsw ? 'text' : 'password'}
            clearable
            placeholder={audience === 'staff' ? '员工账号密码' : '客户会员初始密码 / 已设置密码'}
            prefixIcon={<LockOnIcon />}
            suffixIcon={
              showPsw ? (
                <BrowseIcon onClick={() => toggleShowPsw((current) => !current)} />
              ) : (
                <BrowseOffIcon onClick={() => toggleShowPsw((current) => !current)} />
              )
            }
          />
        </FormItem>
        <div className={`${Style.checkContainer} ${Style.rememberPwd}`}>
          <Checkbox>记住账号</Checkbox>
          <span className={Style.checkContainerTip}>忘记密码请联系管理员重置</span>
        </div>

        <FormItem className={Style.btnContainer}>
          <Button block size='large' type='submit'>
            {audience === 'staff' ? '进入运营后台' : '进入客户空间'}
          </Button>
        </FormItem>
      </Form>
    </div>
  );
}
