import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Checkbox,
  Form,
  type FormInstanceFunctions,
  Input,
  MessagePlugin,
  type SubmitContext,
} from 'tdesign-react';
import { BrowseIcon, BrowseOffIcon, CodeIcon, LockOnIcon, MobileIcon, UserIcon } from 'tdesign-icons-react';
import { useAppDispatch } from 'modules/store';
import { registerClient } from 'modules/user';
import { authSendRegisterCode } from 'services/zggeo-api';

import Style from './index.module.less';

const { FormItem } = Form;

export default function Register() {
  const [showPsw, toggleShowPsw] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const formRef = useRef<FormInstanceFunctions>();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(value - 1, 0)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const normalizePhone = (raw: unknown) => String(raw || '').replace(/\D+/g, '');

  const sendCode = async () => {
    const values = formRef.current?.getFieldsValue?.(true) as { phone?: string };
    const phone = normalizePhone(values?.phone);
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      MessagePlugin.warning('请输入正确的手机号');
      return;
    }
    setSendingCode(true);
    try {
      const res = await authSendRegisterCode({ phone });
      if (res?.debug_code) {
        console.info('[ZGEO mock sms] 注册验证码:', res.debug_code);
      }
      setCountdown(Number(res?.resend_after || 60));
      MessagePlugin.success('验证码已发送');
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '验证码发送失败');
    } finally {
      setSendingCode(false);
    }
  };

  const onSubmit = async (e: SubmitContext) => {
    if (e.validateResult !== true) return;
    const values = formRef.current?.getFieldsValue?.(true) as {
      name?: string;
      phone?: string;
      verification_code?: string;
      password?: string;
      company?: string;
      checked?: boolean;
    };
    if (!values?.checked) {
      MessagePlugin.warning('请先确认客户空间数据使用说明');
      return;
    }
    setRegistering(true);
    try {
      await dispatch(
        registerClient({
          name: String(values.name || '').trim(),
          phone: normalizePhone(values.phone),
          verification_code: String(values.verification_code || '').trim(),
          password: String(values.password || ''),
          company: String(values.company || '').trim() || undefined,
        }),
      ).unwrap();
      MessagePlugin.success('客户空间已创建');
      navigate('/overview/index');
    } catch (err: any) {
      MessagePlugin.error((typeof err === 'string' && err) || err?.message || '注册失败');
    } finally {
      setRegistering(false);
    }
  };

  return (
    <Form ref={formRef} className={Style.itemContainer} labelWidth={0} onSubmit={onSubmit}>
      <div className={Style.fieldRow}>
        <FormItem name='name' rules={[{ required: true, message: '联系人姓名必填', type: 'error' }]}>
          <Input size='large' placeholder='联系人姓名' prefixIcon={<UserIcon />} />
        </FormItem>
        <FormItem name='company'>
          <Input size='large' placeholder='公司 / 项目，可选' prefixIcon={<UserIcon />} />
        </FormItem>
      </div>
      <FormItem
        name='phone'
        rules={[
          { required: true, message: '手机号必填', type: 'error' },
          { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号', type: 'warning' },
        ]}
      >
        <Input size='large' placeholder='手机号，作为登录账号' prefixIcon={<MobileIcon />} />
      </FormItem>
      <div className={Style.codeRow}>
        <FormItem
          className={Style.codeInputItem}
          name='verification_code'
          rules={[
            { required: true, message: '验证码必填', type: 'error' },
            { pattern: /^\d{4,8}$/, message: '请输入短信验证码', type: 'warning' },
          ]}
        >
          <Input size='large' placeholder='短信验证码' prefixIcon={<CodeIcon />} />
        </FormItem>
        <Button variant='outline' type='button' disabled={countdown > 0} loading={sendingCode} onClick={sendCode}>
          {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
        </Button>
      </div>
      <FormItem name='password' rules={[{ required: true, message: '密码至少 6 位', type: 'error', min: 6 }]}>
        <Input
          size='large'
          type={showPsw ? 'text' : 'password'}
          clearable
          placeholder='设置客户空间密码'
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
      <FormItem className={Style.checkContainer} name='checked' initialData={false}>
        <Checkbox>我确认该账号仅用于查看和管理本客户自己的资产、关键词、文章与监测结果</Checkbox>
      </FormItem>
      <FormItem>
        <Button block size='large' type='submit' loading={registering} disabled={registering}>
          注册并进入客户空间
        </Button>
      </FormItem>
    </Form>
  );
}
