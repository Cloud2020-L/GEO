import React, { useEffect, useState } from 'react';
import { Button, Card, Dialog, Form, Input, MessagePlugin, Popconfirm, Select, Space, Table, Tag } from 'tdesign-react';
import { AddIcon, RefreshIcon } from 'tdesign-icons-react';
import {
  createPublishingAccount,
  deletePublishingAccount,
  listPublishingAccounts,
  updatePublishingAccount,
  type PublishingAccountCreateRequest,
  type PublishingAccountRow,
} from 'services/zggeo-api';
import Style from '../linear.module.less';

const { FormItem } = Form;

const PLATFORM_OPTIONS = ['小红书', '知乎', '微信公众号', '官网 CMS', 'B站', '微博', '抖音', '视频号'];
const AUTH_OPTIONS = [
  { label: '手动发布', value: 'manual_only' },
  { label: '已登记', value: 'registered' },
  { label: '需确认', value: 'needs_check' },
  { label: '不可用', value: 'unsupported' },
];
const ACCOUNT_TYPE_OPTIONS = [
  { label: '个人号', value: 'personal' },
  { label: '企业号', value: 'enterprise' },
  { label: '机构号', value: 'organization' },
];
const AUTH_METHOD_OPTIONS = [
  { label: '手动发布', value: 'manual' },
  { label: 'OAuth / API 预留', value: 'oauth' },
  { label: 'API Key 预留', value: 'api_key' },
];
const MODE_OPTIONS = [
  { label: '手动复制发布', value: 'manual_copy' },
  { label: 'API 发布（二期）', value: 'api_publish' },
  { label: '媒体市场下单（二期）', value: 'media_market_order' },
  { label: '媒介盒子下单（二期）', value: 'media_box_order' },
];

const emptyForm: PublishingAccountCreateRequest = {
  platform: '小红书',
  account_name: '',
  account_home_url: '',
  account_type: 'personal',
  subject_name: '',
  auth_method: 'manual',
  auth_status: 'manual_only',
  publish_mode: 'manual_copy',
  remark: '',
};

const normalizeFormValues = (values: Partial<PublishingAccountCreateRequest> = {}): PublishingAccountCreateRequest => ({
  platform: String(values.platform || emptyForm.platform),
  account_name: String(values.account_name || ''),
  account_home_url: String(values.account_home_url || ''),
  account_type: (values.account_type || emptyForm.account_type) as PublishingAccountCreateRequest['account_type'],
  subject_name: String(values.subject_name || ''),
  auth_method: (values.auth_method || emptyForm.auth_method) as PublishingAccountCreateRequest['auth_method'],
  auth_status: String(values.auth_status || emptyForm.auth_status),
  publish_mode: String(values.publish_mode || emptyForm.publish_mode),
  remark: String(values.remark || ''),
});

const accountToFormValues = (row: PublishingAccountRow): PublishingAccountCreateRequest =>
  normalizeFormValues({
    platform: row.platform,
    account_name: row.account_name,
    account_home_url: row.account_home_url || '',
    account_type: (row.account_type as PublishingAccountCreateRequest['account_type']) || emptyForm.account_type,
    subject_name: row.subject_name || '',
    auth_method: (row.auth_method as PublishingAccountCreateRequest['auth_method']) || emptyForm.auth_method,
    auth_status: row.auth_status || emptyForm.auth_status,
    publish_mode: row.publish_mode || emptyForm.publish_mode,
    remark: row.remark || '',
  });

const Accounts: React.FC = () => {
  const [formInstance] = Form.useForm();
  const [rows, setRows] = useState<PublishingAccountRow[]>([]);
  const [active, setActive] = useState<PublishingAccountRow | null>(null);
  const [form, setForm] = useState<PublishingAccountCreateRequest>(() => normalizeFormValues(emptyForm));
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      setRows(await listPublishingAccounts());
    } catch (err: any) {
      MessagePlugin.error(`账号池加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const openCreate = () => {
    const nextForm = normalizeFormValues(emptyForm);
    setActive(null);
    setForm(nextForm);
    formInstance.setFieldsValue(nextForm);
    formInstance.clearValidate?.();
    setOpen(true);
  };

  const openEdit = (row: PublishingAccountRow) => {
    const nextForm = accountToFormValues(row);
    setActive(row);
    setForm(nextForm);
    formInstance.setFieldsValue(nextForm);
    formInstance.clearValidate?.();
    setOpen(true);
  };

  const submit = async () => {
    const currentForm = normalizeFormValues({
      ...form,
      ...((formInstance.getFieldsValue?.(true) as Partial<PublishingAccountCreateRequest>) || {}),
    });

    if (!currentForm.platform || !currentForm.account_name?.trim()) {
      MessagePlugin.warning('请填写平台和账号昵称');
      return;
    }
    try {
      if (active) {
        await updatePublishingAccount(active.id, currentForm);
        MessagePlugin.success('发布账号已更新');
      } else {
        await createPublishingAccount(currentForm);
        MessagePlugin.success('发布账号已新增');
      }
      setOpen(false);
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(`保存失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    }
  };

  const remove = async (row: PublishingAccountRow) => {
    try {
      await deletePublishingAccount(row.id);
      MessagePlugin.success('发布账号已删除');
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(`删除失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    }
  };

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              账号池
            </Tag>
            <Tag theme='warning' variant='light'>
              不托管密码/Cookie
            </Tag>
          </Space>
          <div className={Style.heroTitle}>自媒体号池</div>
          <div className={Style.heroDesc}>
            登记发布平台、账号昵称、账号类型、主页链接和发布方式。这里只管理发布任务所需的非敏感信息，不保存平台密码、Cookie
            或验证码状态；手动复制发布不需要 AppID、Secret 或 Token。
          </div>
        </Space>
      </Card>

      <Card
        bordered={false}
        className={Style.sectionCard}
        title='账号列表'
        actions={
          <Space>
            <Button icon={<RefreshIcon />} loading={loading} onClick={fetchData}>
              刷新
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={openCreate}>
              新增账号
            </Button>
          </Space>
        }
      >
        <Table
          loading={loading}
          rowKey='id'
          data={rows}
          columns={[
            {
              colKey: 'platform',
              title: '平台',
              width: 140,
              cell: ({ row }) => (
                <Tag theme='primary' variant='light'>
                  {row.platform}
                </Tag>
              ),
            },
            { colKey: 'account_name', title: '账号昵称', minWidth: 180 },
            {
              colKey: 'account_type',
              title: '账号类型',
              width: 120,
              cell: ({ row }) =>
                ACCOUNT_TYPE_OPTIONS.find((item) => item.value === row.account_type)?.label ||
                row.account_type ||
                '个人号',
            },
            { colKey: 'subject_name', title: '主体名称', minWidth: 160, cell: ({ row }) => row.subject_name || '-' },
            {
              colKey: 'account_home_url',
              title: '主页链接',
              minWidth: 220,
              cell: ({ row }) =>
                row.account_home_url ? (
                  <a href={row.account_home_url} target='_blank' rel='noreferrer noopener'>
                    {row.account_home_url}
                  </a>
                ) : (
                  '-'
                ),
            },
            { colKey: 'auth_status', title: '授权状态', width: 140 },
            { colKey: 'publish_mode', title: '发布方式', width: 160 },
            { colKey: 'remark', title: '备注', minWidth: 180, cell: ({ row }) => row.remark || '-' },
            {
              colKey: 'action',
              title: '操作',
              fixed: 'right',
              width: 150,
              cell: ({ row }) => (
                <Space>
                  <Button size='small' variant='outline' onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Popconfirm content='确认删除这个账号？' onConfirm={() => remove(row)}>
                    <Button size='small' variant='text' theme='danger'>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Dialog
        visible={open}
        header={active ? '编辑发布账号' : '新增发布账号'}
        width='640px'
        onClose={() => setOpen(false)}
        onCancel={() => setOpen(false)}
        onConfirm={submit}
      >
        <Form
          form={formInstance}
          initialData={form}
          layout='vertical'
          onValuesChange={(_, allValues) =>
            setForm(normalizeFormValues(allValues as Partial<PublishingAccountCreateRequest>))
          }
        >
          <FormItem label='平台' name='platform'>
            <Select options={PLATFORM_OPTIONS.map((item) => ({ label: item, value: item }))} />
          </FormItem>
          <FormItem label='账号昵称' name='account_name'>
            <Input />
          </FormItem>
          <FormItem label='主页链接' name='account_home_url'>
            <Input placeholder='https://...' />
          </FormItem>
          <FormItem label='账号类型' name='account_type'>
            <Select options={ACCOUNT_TYPE_OPTIONS} />
          </FormItem>
          <FormItem label='主体名称' name='subject_name'>
            <Input placeholder='企业号可填写公司主体，个人号可留空' />
          </FormItem>
          <FormItem label='授权方式' name='auth_method'>
            <Select options={AUTH_METHOD_OPTIONS} />
          </FormItem>
          <FormItem label='授权状态' name='auth_status'>
            <Select options={AUTH_OPTIONS} />
          </FormItem>
          <FormItem label='发布方式' name='publish_mode'>
            <Select options={MODE_OPTIONS} />
          </FormItem>
          <FormItem label='备注' name='remark'>
            <Input />
          </FormItem>
        </Form>
      </Dialog>
    </div>
  );
};

export default Accounts;
