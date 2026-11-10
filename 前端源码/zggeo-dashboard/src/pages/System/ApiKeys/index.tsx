import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Dialog, Form, Input, MessagePlugin, Select, Space, Table, Tag } from 'tdesign-react';
import { AddIcon, RefreshIcon } from 'tdesign-icons-react';
import { createSystemApiKey, listSystemApiKeys } from 'services/zggeo-api';

const { FormItem } = Form;

const ApiKeys: React.FC = () => {
  const [keys, setKeys] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [plainKey, setPlainKey] = useState('');
  const [form, setForm] = useState({ name: '', scope: 'reports:read' });

  const fetchData = async () => {
    setLoading(true);
    try {
      setKeys(await listSystemApiKeys());
    } catch (err: any) {
      MessagePlugin.error(`密钥加载失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    fetchData();
  }, []);

  const create = async () => {
    if (!form.name) {
      MessagePlugin.warning('请填写密钥名称');
      return;
    }
    try {
      const row = await createSystemApiKey(form);
      setPlainKey(String(row.plain_key || ''));
      setOpen(false);
      fetchData();
      MessagePlugin.success('API 密钥已创建并写入数据库');
    } catch (err: any) {
      MessagePlugin.error(`创建失败：${err?.message || '未知错误'}`);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <Header title='API 密钥' desc='真实数据库版：完整密钥只在创建后显示一次，数据库仅保存哈希和预览值。' />
      {plainKey && <Alert theme='success' title='请保存完整密钥' message={plainKey} style={{ marginBottom: 16 }} />}
      <Card
        bordered
        title='密钥列表'
        actions={
          <Space>
            <Button icon={<RefreshIcon />} onClick={fetchData}>
              刷新
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={() => setOpen(true)}>
              创建密钥
            </Button>
          </Space>
        }
      >
        <Table
          loading={loading}
          rowKey='id'
          data={keys}
          columns={[
            { colKey: 'name', title: '名称' },
            { colKey: 'key_preview', title: '密钥预览' },
            {
              colKey: 'scope',
              title: '权限范围',
              cell: ({ row }) => (
                <Tag theme='primary' variant='light'>
                  {row.scope}
                </Tag>
              ),
            },
            {
              colKey: 'status',
              title: '状态',
              cell: ({ row }) => (
                <Tag theme={row.status === 'active' ? 'success' : 'warning'} variant='light'>
                  {row.status}
                </Tag>
              ),
            },
            {
              colKey: 'created_at',
              title: '创建时间',
              cell: ({ row }) => new Date(row.created_at).toLocaleString('zh-CN'),
            },
            {
              colKey: 'last_used_at',
              title: '最近使用',
              cell: ({ row }) => (row.last_used_at ? new Date(row.last_used_at).toLocaleString('zh-CN') : '-'),
            },
          ]}
        />
      </Card>
      <Dialog visible={open} header='创建 API 密钥' onClose={() => setOpen(false)} onConfirm={create}>
        <Form layout='vertical'>
          <FormItem label='密钥名称'>
            <Input value={form.name} onChange={(v) => setForm({ ...form, name: String(v) })} />
          </FormItem>
          <FormItem label='权限范围'>
            <Select
              value={form.scope}
              onChange={(v) => setForm({ ...form, scope: String(v) })}
              options={['reports:read', 'tasks:write', 'distribution:write', 'admin:all'].map((x) => ({
                label: x,
                value: x,
              }))}
            />
          </FormItem>
        </Form>
      </Dialog>
    </div>
  );
};

const Header: React.FC<{ title: string; desc: string }> = ({ title, desc }) => (
  <Card bordered={false} style={{ marginBottom: 16 }}>
    <Space direction='vertical'>
      <Space>
        <Tag theme='primary' variant='light'>
          系统管理
        </Tag>
        <Tag theme='danger' variant='light'>
          API
        </Tag>
      </Space>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{title}</div>
      <div style={{ color: 'var(--td-text-color-secondary)' }}>{desc}</div>
    </Space>
  </Card>
);
export default ApiKeys;
