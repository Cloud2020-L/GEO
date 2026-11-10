import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Dialog, Form, Input, MessagePlugin, Select, Space, Table, Tag, Textarea } from 'tdesign-react';
import { AddIcon, FileCopyIcon, RefreshIcon } from 'tdesign-icons-react';
import { createBrandKnowledgeDb, listBrandKnowledgeDb } from 'services/zggeo-api';
import Style from '../linear.module.less';

const { FormItem } = Form;
const typeOptions = ['品牌定位', '产品卖点', '客户案例', '禁用表达', 'FAQ', '证据素材'];

const Knowledge: React.FC = () => {
  const [items, setItems] = useState<Record<string, any>[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', type: '产品卖点', content: '', tags: '' });

  const fetchData = async () => {
    try {
      setItems(await listBrandKnowledgeDb());
    } catch (err: any) {
      MessagePlugin.error(`知识库加载失败：${err?.message || '未知错误'}`);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const stats = useMemo(
    () => ({
      total: items.length,
      cases: items.filter((item) => item.type === '客户案例').length,
      faq: items.filter((item) => item.type === 'FAQ').length,
      compliance: items.filter((item) => item.type === '禁用表达').length,
    }),
    [items],
  );

  const submit = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      MessagePlugin.warning('请填写标题和素材内容');
      return;
    }
    await createBrandKnowledgeDb({
      title: form.title,
      type: form.type,
      content: form.content,
      tags: form.tags
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    });
    setOpen(false);
    MessagePlugin.success('品牌素材已写入数据库');
    fetchData();
  };

  const copyAll = async () => {
    await navigator.clipboard.writeText(
      items.map((item) => `【${item.type}】${item.title}\n${item.content}`).join('\n\n'),
    );
    MessagePlugin.success('已复制全部品牌知识');
  };

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              内容生产
            </Tag>
            <Tag theme='success' variant='light'>
              数据库知识库
            </Tag>
          </Space>
          <div className={Style.heroTitle}>品牌知识库</div>
          <div className={Style.heroDesc}>
            品牌定位、卖点、案例、FAQ 和禁用表达已接数据库，AI 生成时后端会读取这些素材，作为内容生成和校准的知识底座。
          </div>
        </Space>
      </Card>

      <div className={Style.statsGrid}>
        <Metric title='素材总数' value={stats.total} />
        <Metric title='客户案例' value={stats.cases} color='#00A870' />
        <Metric title='FAQ' value={stats.faq} color='#366EF4' />
        <Metric title='合规规则' value={stats.compliance} color='#E34D59' />
      </div>

      <Card
        bordered={false}
        className={Style.sectionCard}
        title='知识条目'
        actions={
          <Space>
            <Button icon={<RefreshIcon />} onClick={fetchData}>
              刷新
            </Button>
            <Button icon={<FileCopyIcon />} onClick={copyAll}>
              复制给 AI
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={() => setOpen(true)}>
              新增素材
            </Button>
          </Space>
        }
      >
        <Table
          rowKey='id'
          data={items}
          columns={[
            {
              colKey: 'title',
              title: '标题',
              width: 220,
              cell: ({ row }) => <div className={Style.itemTitle}>{row.title}</div>,
            },
            {
              colKey: 'type',
              title: '类型',
              cell: ({ row }) => (
                <Tag theme='primary' variant='light'>
                  {row.type}
                </Tag>
              ),
            },
            { colKey: 'content', title: '内容', ellipsis: true },
            {
              colKey: 'tags',
              title: '标签',
              cell: ({ row }) => (
                <Space>
                  {(row.tags || []).map((tag: string) => (
                    <Tag key={tag} size='small'>
                      #{tag}
                    </Tag>
                  ))}
                </Space>
              ),
            },
            {
              colKey: 'updated_at',
              title: '更新时间',
              cell: ({ row }) => new Date(row.updated_at).toLocaleString('zh-CN'),
            },
          ]}
        />
      </Card>

      <Dialog
        visible={open}
        header='新增品牌素材'
        width={680}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        confirmBtn='入库'
      >
        <Form layout='vertical'>
          <FormItem label='标题'>
            <Input value={form.title} onChange={(v) => setForm({ ...form, title: String(v) })} />
          </FormItem>
          <FormItem label='类型'>
            <Select
              value={form.type}
              options={typeOptions.map((item) => ({ label: item, value: item }))}
              onChange={(v) => setForm({ ...form, type: String(v) })}
            />
          </FormItem>
          <FormItem label='内容'>
            <Textarea
              value={form.content}
              onChange={(v) => setForm({ ...form, content: String(v) })}
              autosize={{ minRows: 5, maxRows: 12 }}
            />
          </FormItem>
          <FormItem label='标签'>
            <Input
              value={form.tags}
              onChange={(v) => setForm({ ...form, tags: String(v) })}
              placeholder='GEO, 案例, 官网'
            />
          </FormItem>
        </Form>
      </Dialog>
    </div>
  );
};

const Metric: React.FC<{ title: string; value: number; color?: string }> = ({ title, value, color }) => (
  <Card bordered={false} className={Style.statCard}>
    <div className={Style.statLabel}>{title}</div>
    <div className={Style.statValue} style={color ? { color } : undefined}>
      {value}
    </div>
  </Card>
);

export default Knowledge;
