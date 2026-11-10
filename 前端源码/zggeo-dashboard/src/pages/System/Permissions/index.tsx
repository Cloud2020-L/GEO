import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, MessagePlugin, Space, Switch, Table, Tag } from 'tdesign-react';
import { RefreshIcon } from 'tdesign-icons-react';
import { listSystemPermissions, updateSystemPermission } from 'services/zggeo-api';

const Permissions: React.FC = () => {
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState('');
  const tableRows = useMemo<Array<Record<string, any> & { row_key: string }>>(
    () => rows.map((row) => ({ ...row, row_key: `${row.role}-${row.module}` })),
    [rows],
  );

  const fetchData = async () => {
    setLoading(true);
    try {
      setRows(await listSystemPermissions());
    } catch (err: any) {
      MessagePlugin.error(`权限加载失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const patchPermission = async (row: Record<string, any>, patch: { can_view?: boolean; can_edit?: boolean }) => {
    const key = `${row.role}-${row.module}`;
    const previousRows = rows;
    const currentCanView = Boolean(row.can_view);
    const currentCanEdit = Boolean(row.can_edit);
    let nextCanView = patch.can_view ?? currentCanView;
    let nextCanEdit = patch.can_edit ?? currentCanEdit;
    if (nextCanEdit) nextCanView = true;
    if (!nextCanView) nextCanEdit = false;

    setSavingKey(key);
    setRows((items) =>
      items.map((item) =>
        item.role === row.role && item.module === row.module
          ? { ...item, can_view: nextCanView, can_edit: nextCanEdit }
          : item,
      ),
    );
    try {
      const saved = await updateSystemPermission(String(row.role), String(row.module), patch);
      setRows((items) =>
        items.map((item) => (item.role === row.role && item.module === row.module ? { ...item, ...saved } : item)),
      );
      MessagePlugin.success('权限已保存');
    } catch (err: any) {
      setRows(previousRows);
      MessagePlugin.error(`权限保存失败：${err?.response?.data?.detail || err?.message || '请重试'}`);
    } finally {
      setSavingKey('');
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <Header title='角色权限' desc='真实数据库版 RBAC 权限矩阵，超级管理员可直接编辑并保存到数据库。' />
      <Card
        bordered
        title='权限矩阵'
        actions={
          <Button icon={<RefreshIcon />} onClick={fetchData}>
            刷新
          </Button>
        }
      >
        <Table
          loading={loading}
          rowKey='row_key'
          data={tableRows}
          columns={[
            {
              colKey: 'role',
              title: '角色',
              cell: ({ row }) => (
                <Tag theme='primary' variant='light'>
                  {roleLabel(row.role)}
                </Tag>
              ),
            },
            { colKey: 'module', title: '模块' },
            {
              colKey: 'can_view',
              title: '可查看',
              cell: ({ row }) => (
                <Switch
                  value={Boolean(row.can_view)}
                  loading={savingKey === row.row_key}
                  onChange={(value) => patchPermission(row, { can_view: Boolean(value) })}
                />
              ),
            },
            {
              colKey: 'can_edit',
              title: '可编辑',
              cell: ({ row }) => (
                <Switch
                  value={Boolean(row.can_edit)}
                  loading={savingKey === row.row_key}
                  onChange={(value) => patchPermission(row, { can_edit: Boolean(value) })}
                />
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

const roleLabel = (role: string) =>
  ({ admin: '超级管理员', delivery: '交付运营', sales: '销售顾问', client: '客户查看者' }[role] || role);
const Header: React.FC<{ title: string; desc: string }> = ({ title, desc }) => (
  <Card bordered={false} style={{ marginBottom: 16 }}>
    <Space direction='vertical'>
      <Space>
        <Tag theme='primary' variant='light'>
          系统管理
        </Tag>
        <Tag theme='warning' variant='light'>
          RBAC
        </Tag>
      </Space>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{title}</div>
      <div style={{ color: 'var(--td-text-color-secondary)' }}>{desc}</div>
    </Space>
  </Card>
);
export default Permissions;
