import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Dialog,
  Form,
  Input,
  MessagePlugin,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'tdesign-react';
import { AddIcon, EditIcon, RefreshIcon } from 'tdesign-icons-react';
import { useAppSelector } from 'modules/store';
import {
  createSystemUser,
  deleteSystemUser,
  listSystemCustomerAssetOptions,
  listSystemUsers,
  resetSystemUserPassword,
  updateSystemUser,
} from 'services/zggeo-api';

const { FormItem } = Form;

type AccountKind = 'staff' | 'client';
type AccountStatus = 'active' | 'disabled';
type AccountForm = {
  account_type: AccountKind;
  username: string;
  name: string;
  email: string;
  tenant_name: string;
  lead_id: string;
  role: string;
  password: string;
  status: AccountStatus;
};

const STAFF_ROLES = [
  { label: '超级管理员', value: 'admin' },
  { label: '交付运营', value: 'delivery' },
  { label: '销售顾问', value: 'sales' },
];

const CLIENT_ROLE = { label: '客户会员', value: 'client' };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[\u4e00-\u9fffA-Za-z0-9_-]{2,32}$/;

const defaultForm: AccountForm = {
  account_type: 'staff',
  username: '',
  name: '',
  email: '',
  tenant_name: 'ZGEO 智改',
  lead_id: '',
  role: 'delivery',
  password: 'zggeo123',
  status: 'active',
};

const createDefaultForm = (accountType: AccountKind = 'staff'): AccountForm => ({
  ...defaultForm,
  account_type: accountType,
  role: accountType === 'client' ? 'client' : 'delivery',
  tenant_name: accountType === 'client' ? '' : 'ZGEO 智改',
  lead_id: '',
});

const normalizeRole = (raw: unknown) => {
  const role = String(raw || '').trim();
  return STAFF_ROLES.some((item) => item.value === role) ? role : 'delivery';
};

const accountTypeFromRow = (row: Record<string, any>): AccountKind => {
  const explicitType = String(row.account_type || row.user_type || '').toLowerCase();
  if (explicitType === 'client' || explicitType === 'customer') return 'client';
  if (explicitType === 'staff' || explicitType === 'employee') return 'staff';
  return row.role === 'client' ? 'client' : 'staff';
};

const formFromRow = (row: Record<string, any>): AccountForm => {
  const accountType = accountTypeFromRow(row);
  return {
    account_type: accountType,
    username: String(row.username || row.account || row.email || ''),
    name: String(row.name || row.contact_name || ''),
    email: String(row.email || row.contact_email || ''),
    tenant_name: String(row.tenant_name || row.tenant || row.company || row.organization || ''),
    lead_id: String(row.bound_lead_id || row.lead_id || ''),
    role: accountType === 'client' ? 'client' : normalizeRole(row.role),
    password: '',
    status: row.status === 'disabled' ? 'disabled' : 'active',
  };
};

const Users: React.FC = () => {
  const currentUser = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const [users, setUsers] = useState<Record<string, any>[]>([]);
  const [customerAssets, setCustomerAssets] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [activeUser, setActiveUser] = useState<Record<string, any> | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<AccountForm>(() => createDefaultForm());
  const [createDialogKey, setCreateDialogKey] = useState(0);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [nextUsers, nextAssets] = await Promise.all([listSystemUsers(), listSystemCustomerAssetOptions()]);
      setUsers(nextUsers);
      setCustomerAssets(nextAssets);
    } catch (err: any) {
      MessagePlugin.error(`成员加载失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const stats = useMemo(
    () => ({
      total: users.length,
      staff: users.filter((u) => u.role !== 'client').length,
      clients: users.filter((u) => u.role === 'client').length,
      tenants: new Set(users.map((u) => u.tenant)).size,
      active: users.filter((u) => u.status === 'active').length,
    }),
    [users],
  );
  const customerAssetOptions = useMemo(
    () =>
      customerAssets.map((asset) => ({
        label: String(asset.label || asset.company || asset.brand_name || asset.name || asset.lead_id || ''),
        value: String(asset.lead_id || asset.value || ''),
      })),
    [customerAssets],
  );

  const openCreate = (accountType: AccountKind) => {
    setActiveUser(null);
    setTemporaryPassword('');
    setForm(createDefaultForm(accountType));
    setCreateDialogKey((key) => key + 1);
    setOpen(true);
  };

  const closeCreate = () => {
    setOpen(false);
    setSaving(false);
    setForm(createDefaultForm());
    setCreateDialogKey((key) => key + 1);
  };

  const switchAccountType = (accountType: AccountKind) => {
    setForm({
      ...form,
      account_type: accountType,
      role: accountType === 'client' ? 'client' : 'delivery',
      tenant_name: accountType === 'client' ? '' : 'ZGEO 智改',
      lead_id: '',
    });
  };

  const applyCustomerAsset = (leadId: string) => {
    const asset = customerAssets.find((item) => String(item.lead_id || item.value || '') === leadId);
    setForm({
      ...form,
      lead_id: leadId,
      tenant_name: String(asset?.tenant_name || asset?.company || form.tenant_name || ''),
    });
  };

  const addUser = async () => {
    if (saving) return;
    if (!form.username || !form.name || !form.password) {
      MessagePlugin.warning('请填写用户名、姓名和初始密码');
      return;
    }
    if (form.password.length < 6) {
      MessagePlugin.warning('密码至少 6 位');
      return;
    }
    if (!USERNAME_PATTERN.test(form.username.trim()) || form.username.includes('@')) {
      MessagePlugin.warning('用户名支持中文、字母、数字、下划线和短横线，长度 2-32 位');
      return;
    }
    if (form.email.trim() && !EMAIL_PATTERN.test(form.email.trim())) {
      MessagePlugin.warning('联系邮箱格式不正确');
      return;
    }
    if (form.password.trim() && form.password.trim().length < 6) {
      MessagePlugin.warning('新密码至少 6 位');
      return;
    }
    if (form.account_type === 'client' && !form.lead_id) {
      MessagePlugin.warning('请选择要绑定的客户资产');
      return;
    }
    setSaving(true);
    try {
      await createSystemUser({
        username: form.username.trim(),
        name: form.name.trim(),
        email: form.email.trim() || undefined,
        tenant_name: form.account_type === 'client' ? form.tenant_name.trim() : 'ZGEO 智改',
        lead_id: form.account_type === 'client' ? form.lead_id : undefined,
        role: form.account_type === 'client' ? 'client' : form.role,
        password: form.password,
      });
      MessagePlugin.success(form.account_type === 'client' ? '客户会员账号已开通' : '内部员工账号已创建');
      setForm(createDefaultForm(form.account_type));
      setCreateDialogKey((key) => key + 1);
      closeCreate();
      fetchData();
    } catch (err: any) {
      MessagePlugin.error(`创建失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (row: Record<string, any>) => {
    setActiveUser(row);
    setForm(formFromRow(row));
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!activeUser) return;
    if (!form.username || !form.name || (form.account_type !== 'client' && !form.tenant_name)) {
      MessagePlugin.warning('请填写用户名、姓名和所属组织');
      return;
    }
    if (form.account_type === 'client' && !form.lead_id) {
      MessagePlugin.warning('请选择要绑定的客户资产');
      return;
    }
    if (!USERNAME_PATTERN.test(form.username.trim()) || form.username.includes('@')) {
      MessagePlugin.warning('用户名支持中文、字母、数字、下划线和短横线，长度 2-32 位');
      return;
    }
    if (form.email.trim() && !EMAIL_PATTERN.test(form.email.trim())) {
      MessagePlugin.warning('联系邮箱格式不正确');
      return;
    }
    setSaving(true);
    try {
      const body = {
        username: form.username.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
        tenant_name: form.tenant_name.trim(),
        lead_id: form.account_type === 'client' ? form.lead_id : undefined,
        role: form.account_type === 'client' ? 'client' : form.role,
        status: form.status,
      };
      if (form.password.trim()) {
        Object.assign(body, { password: form.password.trim() });
      }
      await updateSystemUser(String(activeUser.id), body);
      MessagePlugin.success('账号信息已更新');
      setEditOpen(false);
      setActiveUser(null);
      fetchData();
    } catch (err: any) {
      MessagePlugin.error(`更新失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  const removeUser = async (row: Record<string, any>) => {
    setSaving(true);
    try {
      await deleteSystemUser(String(row.id));
      MessagePlugin.success('账号已删除');
      fetchData();
    } catch (err: any) {
      MessagePlugin.error(`删除失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  const openResetPassword = (row: Record<string, any>) => {
    setActiveUser(row);
    setTemporaryPassword('');
    setResetOpen(true);
  };

  const resetPassword = async () => {
    if (!activeUser) return;
    setSaving(true);
    try {
      const row = await resetSystemUserPassword(String(activeUser.id));
      setTemporaryPassword(String(row.temporary_password || ''));
      MessagePlugin.success('临时密码已生成，仅本次显示');
      fetchData();
    } catch (err: any) {
      MessagePlugin.error(`重置失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  const isCurrentUser = (row: Record<string, any>) => String(row.id) === String(currentUser?.id || '');

  return (
    <div style={{ padding: 16 }}>
      <Header
        title='账号与权限'
        desc='真实账号入口：内部员工账号进入运营后台，客户会员账号用于查看项目资产、报告和交付进度。账号数据写入 PostgreSQL。'
      />
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={3}>
          <Metric title='总账号' value={stats.total} />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='内部员工' value={stats.staff} />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='客户会员' value={stats.clients} />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='启用账号' value={stats.active} />
        </Col>
      </Row>
      <Card
        bordered
        title='账号列表'
        actions={
          <Space>
            <Button icon={<RefreshIcon />} onClick={fetchData}>
              刷新
            </Button>
            <Button variant='outline' icon={<AddIcon />} onClick={() => openCreate('client')}>
              开通客户会员
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={() => openCreate('staff')}>
              新增内部员工
            </Button>
          </Space>
        }
      >
        <Table
          loading={loading}
          rowKey='id'
          data={users}
          columns={[
            { colKey: 'name', title: '姓名' },
            { colKey: 'username', title: '用户名' },
            { colKey: 'email', title: '联系邮箱' },
            { colKey: 'tenant', title: '所属组织 / 客户' },
            {
              colKey: 'role',
              title: '账号类型',
              cell: ({ row }) => (
                <Tag theme={row.role === 'client' ? 'success' : 'primary'} variant='light'>
                  {roleLabel(row.role)}
                </Tag>
              ),
            },
            {
              colKey: 'status',
              title: '状态',
              cell: ({ row }) => (
                <Tag theme={row.status === 'active' ? 'success' : 'warning'} variant='light'>
                  {statusLabel(row.status)}
                </Tag>
              ),
            },
            {
              colKey: 'last_login_at',
              title: '最近登录',
              cell: ({ row }) => (row.last_login_at ? new Date(row.last_login_at).toLocaleString('zh-CN') : '-'),
            },
            {
              colKey: 'operation',
              title: '操作',
              width: 260,
              cell: ({ row }) => (
                <Space size='small'>
                  <Button size='small' variant='outline' onClick={() => openResetPassword(row)}>
                    密码
                  </Button>
                  <Button size='small' variant='text' icon={<EditIcon />} onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Button
                    size='small'
                    variant='text'
                    onClick={() =>
                      updateSystemUser(String(row.id), { status: row.status === 'active' ? 'disabled' : 'active' })
                        .then(() => {
                          MessagePlugin.success(row.status === 'active' ? '账号已停用' : '账号已启用');
                          fetchData();
                        })
                        .catch((err: any) =>
                          MessagePlugin.error(
                            `状态更新失败：${err?.response?.data?.detail || err?.message || '未知错误'}`,
                          ),
                        )
                    }
                    disabled={isCurrentUser(row)}
                  >
                    {row.status === 'active' ? '停用' : '启用'}
                  </Button>
                  <Popconfirm
                    content={
                      isCurrentUser(row)
                        ? '不能删除当前登录账号'
                        : `确认删除「${row.name || row.username}」？删除后不可恢复。`
                    }
                    onConfirm={() => removeUser(row)}
                  >
                    <Button size='small' variant='text' theme='danger' disabled={isCurrentUser(row)} loading={saving}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {open ? (
        <Dialog
          key={createDialogKey}
          visible={open}
          destroyOnClose
          header={form.account_type === 'client' ? '开通客户会员' : '新增内部员工'}
          onClose={closeCreate}
          confirmBtn={
            <Button theme='primary' loading={saving} onClick={addUser}>
              {form.account_type === 'client' ? '开通账号' : '创建账号'}
            </Button>
          }
          cancelBtn={
            <Button variant='outline' onClick={closeCreate}>
              取消
            </Button>
          }
        >
          <Form key={`create-form-${createDialogKey}`} layout='vertical'>
            <FormItem label='账号类型'>
              <Space>
                <Button
                  theme={form.account_type === 'staff' ? 'primary' : 'default'}
                  variant={form.account_type === 'staff' ? 'base' : 'outline'}
                  onClick={() => switchAccountType('staff')}
                >
                  内部员工
                </Button>
                <Button
                  theme={form.account_type === 'client' ? 'success' : 'default'}
                  variant={form.account_type === 'client' ? 'base' : 'outline'}
                  onClick={() => switchAccountType('client')}
                >
                  客户会员
                </Button>
              </Space>
            </FormItem>
            <FormItem label='用户名'>
              <Input
                value={form.username}
                placeholder='支持中文、字母、数字、下划线和短横线'
                onChange={(v) => setForm({ ...form, username: String(v) })}
              />
            </FormItem>
            <FormItem label={form.account_type === 'client' ? '客户联系人姓名' : '员工姓名'}>
              <Input value={form.name} onChange={(v) => setForm({ ...form, name: String(v) })} />
            </FormItem>
            <FormItem label='联系邮箱'>
              <Input value={form.email} onChange={(v) => setForm({ ...form, email: String(v) })} />
            </FormItem>
            {form.account_type === 'client' ? (
              <FormItem label='绑定客户资产' help='客户会员只能访问所选客户资产所在客户空间的数据'>
                <Select
                  value={form.lead_id}
                  placeholder='请选择客户资产'
                  options={customerAssetOptions}
                  filterable
                  onChange={(v) => applyCustomerAsset(String(v))}
                />
              </FormItem>
            ) : (
              <FormItem label='所属组织'>
                <Input
                  value={form.tenant_name}
                  placeholder='ZGEO 智改'
                  disabled
                  onChange={(v) => setForm({ ...form, tenant_name: String(v) })}
                />
              </FormItem>
            )}
            <FormItem label='角色权限'>
              <Select
                value={form.role}
                disabled={form.account_type === 'client'}
                onChange={(v) => setForm({ ...form, role: String(v) })}
                options={form.account_type === 'client' ? [CLIENT_ROLE] : STAFF_ROLES}
              />
            </FormItem>
            <FormItem label='初始密码'>
              <Input value={form.password} onChange={(v) => setForm({ ...form, password: String(v) })} />
            </FormItem>
          </Form>
        </Dialog>
      ) : null}
      <Dialog
        visible={editOpen}
        header='编辑账号'
        onClose={() => {
          setEditOpen(false);
          setActiveUser(null);
        }}
        onConfirm={saveEdit}
        confirmBtn={
          <Button theme='primary' loading={saving} onClick={saveEdit}>
            保存
          </Button>
        }
      >
        <Space direction='vertical' style={{ width: '100%' }} size='large'>
          <EditField label='账号类型'>
            <Select
              value={form.account_type}
              onChange={(v) => switchAccountType(String(v) as AccountKind)}
              options={[
                { label: '内部员工', value: 'staff' },
                { label: '客户会员', value: 'client' },
              ]}
            />
          </EditField>
          <EditField label='用户名'>
            <Input
              value={form.username}
              placeholder='支持中文、字母、数字、下划线和短横线'
              onChange={(v) => setForm({ ...form, username: String(v) })}
            />
          </EditField>
          <EditField label={form.account_type === 'client' ? '客户联系人姓名' : '员工姓名'}>
            <Input value={form.name} onChange={(v) => setForm({ ...form, name: String(v) })} />
          </EditField>
          <EditField label='联系邮箱'>
            <Input value={form.email} onChange={(v) => setForm({ ...form, email: String(v) })} />
          </EditField>
          <EditField label={form.account_type === 'client' ? '绑定客户资产' : '所属组织'}>
            {form.account_type === 'client' ? (
              <Select
                value={form.lead_id}
                placeholder='请选择客户资产'
                options={customerAssetOptions}
                filterable
                onChange={(v) => applyCustomerAsset(String(v))}
              />
            ) : (
              <Input value={form.tenant_name} onChange={(v) => setForm({ ...form, tenant_name: String(v) })} />
            )}
          </EditField>
          <EditField label='角色权限'>
            <Select
              value={form.account_type === 'client' ? 'client' : form.role}
              disabled={form.account_type === 'client'}
              onChange={(v) => setForm({ ...form, role: String(v) })}
              options={form.account_type === 'client' ? [CLIENT_ROLE] : STAFF_ROLES}
            />
          </EditField>
          <EditField label='状态'>
            <Select
              value={form.status}
              disabled={activeUser ? isCurrentUser(activeUser) : false}
              onChange={(v) => setForm({ ...form, status: String(v) === 'disabled' ? 'disabled' : 'active' })}
              options={[
                { label: '启用', value: 'active' },
                { label: '停用', value: 'disabled' },
              ]}
            />
          </EditField>
          <EditField label='新密码'>
            <Input
              type='password'
              value={form.password}
              placeholder='不填写则保持原密码'
              onChange={(v) => setForm({ ...form, password: String(v) })}
            />
          </EditField>
        </Space>
      </Dialog>
      <Dialog
        visible={resetOpen}
        header='账号密码'
        onClose={() => setResetOpen(false)}
        confirmBtn={
          <Button theme='primary' loading={saving} onClick={resetPassword}>
            重置临时密码
          </Button>
        }
        cancelBtn='关闭'
      >
        <Space direction='vertical' style={{ width: '100%' }}>
          <Alert
            theme='warning'
            title='原密码不可查看'
            message='系统只保存密码哈希。管理员可重置临时密码，临时密码仅本次显示，账号下次登录后应修改密码。'
          />
          <div>
            <strong>{activeUser?.name || activeUser?.email}</strong>
            <div style={{ color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
              {activeUser?.username || activeUser?.email}
            </div>
          </div>
          {temporaryPassword && <Alert theme='success' title='新的临时密码' message={temporaryPassword} />}
        </Space>
      </Dialog>
    </div>
  );
};

const roleLabel = (role: string) =>
  ({ admin: '超级管理员', delivery: '交付运营', sales: '销售顾问', client: '客户会员' }[role] || role);
const statusLabel = (status: string) => ({ active: '启用', disabled: '停用' }[status] || status);
const EditField: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 16 }}>
    <div style={{ textAlign: 'right', color: 'var(--td-text-color-primary)', fontWeight: 500 }}>{label}</div>
    <div>{children}</div>
  </div>
);
const Header: React.FC<{ title: string; desc: string }> = ({ title, desc }) => (
  <Card bordered={false} style={{ marginBottom: 16 }}>
    <Space direction='vertical'>
      <Space>
        <Tag theme='primary' variant='light'>
          系统管理
        </Tag>
        <Tag theme='success' variant='light'>
          真实账号
        </Tag>
      </Space>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{title}</div>
      <div style={{ color: 'var(--td-text-color-secondary)' }}>{desc}</div>
    </Space>
  </Card>
);
const Metric: React.FC<{ title: string; value: number }> = ({ title, value }) => (
  <Card bordered>
    <div style={{ color: 'var(--td-text-color-secondary)' }}>{title}</div>
    <div style={{ fontSize: 32, fontWeight: 800 }}>{value}</div>
  </Card>
);
export default Users;
