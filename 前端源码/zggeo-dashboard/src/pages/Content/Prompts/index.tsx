import React, { useMemo, useState } from 'react';
import {
  Card,
  Tag,
  Button,
  Space,
  Input,
  MessagePlugin,
  Dialog,
  Form,
  Textarea,
  Select,
  Popconfirm,
} from 'tdesign-react';
import {
  AddIcon,
  EditIcon,
  DeleteIcon,
  SearchIcon,
  DownloadIcon,
  UploadIcon,
  FileCopyIcon,
  StarIcon,
  StarFilledIcon,
} from 'tdesign-icons-react';
import { useLocalStorage } from 'hooks/useLocalStorage';
import { scopedStorageKey } from 'utils/scopedStorage';
import Style from '../linear.module.less';

interface PromptItem {
  id: string;
  title: string;
  category: string;
  body: string;
  variables: string[];
  tags: string[];
  favorite: boolean;
  created_at: string;
  updated_at: string;
}

const STORAGE_KEY = 'example.com.v1';

const CATEGORY_OPTIONS = [
  { label: 'SEO · 内容优化', value: 'seo' },
  { label: 'GEO · 生成引擎', value: 'geo' },
  { label: '标题生成', value: 'title' },
  { label: '问答结构化', value: 'qa' },
  { label: '品牌故事', value: 'brand' },
  { label: '通用', value: 'general' },
];

const CATEGORY_COLOR: Record<string, string> = {
  seo: '#F59E0B',
  geo: '#6366F1',
  title: '#EC4899',
  qa: '#10B981',
  brand: '#EF4444',
  general: '#94A3B8',
};
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORY_OPTIONS.map((o) => [o.value, o.label]));

const uid = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const extractVariables = (body: string): string[] => {
  const re = /\{\{\s*([\w\u4e00-\u9fa5-]+)\s*\}\}/g;
  const set = new Set<string>();
  let m = re.exec(body);
  while (m) {
    set.add(m[1]);
    m = re.exec(body);
  }
  return [...set];
};

const { FormItem } = Form;

const Prompts: React.FC = () => {
  const promptStorageKey = useMemo(() => scopedStorageKey(STORAGE_KEY), []);
  const [prompts, setPrompts] = useLocalStorage<PromptItem[]>(promptStorageKey, []);
  const [keyword, setKeyword] = useState('');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [onlyFav, setOnlyFav] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PromptItem | null>(null);
  const [form, setForm] = useState<{ title: string; category: string; body: string; tags: string }>({
    title: '',
    category: 'seo',
    body: '',
    tags: '',
  });

  const filtered = useMemo(() => {
    return prompts.filter((p) => {
      if (catFilter !== 'all' && p.category !== catFilter) return false;
      if (onlyFav && !p.favorite) return false;
      if (!keyword.trim()) return true;
      const k = keyword.toLowerCase();
      return (
        p.title.toLowerCase().includes(k) ||
        p.body.toLowerCase().includes(k) ||
        p.tags.some((t) => t.toLowerCase().includes(k))
      );
    });
  }, [prompts, keyword, catFilter, onlyFav]);

  const openCreate = () => {
    setEditing(null);
    setForm({ title: '', category: 'seo', body: '', tags: '' });
    setDialogOpen(true);
  };
  const openEdit = (p: PromptItem) => {
    setEditing(p);
    setForm({ title: p.title, category: p.category, body: p.body, tags: p.tags.join(', ') });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!form.title.trim()) {
      MessagePlugin.warning('请写模板名');
      return;
    }
    if (!form.body.trim()) {
      MessagePlugin.warning('请写 Prompt 正文');
      return;
    }
    const now = new Date().toISOString();
    const variables = extractVariables(form.body);
    const tags = form.tags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (editing) {
      setPrompts((prev) =>
        prev.map((p) =>
          p.id === editing.id
            ? {
                ...p,
                title: form.title.trim(),
                category: form.category,
                body: form.body,
                variables,
                tags,
                updated_at: now,
              }
            : p,
        ),
      );
      MessagePlugin.success('已更新');
    } else {
      setPrompts((prev) => [
        {
          id: uid(),
          title: form.title.trim(),
          category: form.category,
          body: form.body,
          variables,
          tags,
          favorite: false,
          created_at: now,
          updated_at: now,
        },
        ...prev,
      ]);
      MessagePlugin.success('已添加');
    }
    setDialogOpen(false);
  };

  const handleDelete = (id: string) => {
    setPrompts((prev) => prev.filter((p) => p.id !== id));
    MessagePlugin.success('已删除');
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      MessagePlugin.success('已复制到剪贴板');
    } catch {
      MessagePlugin.error('复制失败');
    }
  };

  const toggleFav = (id: string) => {
    setPrompts((prev) => prev.map((p) => (p.id === id ? { ...p, favorite: !p.favorite } : p)));
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(prompts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zggeo-prompts-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const arr = JSON.parse(await f.text());
        if (!Array.isArray(arr)) throw new Error('不是数组');
        setPrompts(arr);
        MessagePlugin.success(`已导入 ${arr.length} 条`);
      } catch (e: any) {
        MessagePlugin.error(`导入失败：${e?.message}`);
      }
    };
    input.click();
  };

  const stats = useMemo(
    () => ({
      total: prompts.length,
      fav: prompts.filter((p) => p.favorite).length,
      byCat: CATEGORY_OPTIONS.reduce((acc, c) => {
        acc[c.value] = prompts.filter((p) => p.category === c.value).length;
        return acc;
      }, {} as Record<string, number>),
    }),
    [prompts],
  );

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <div className={Style.toolbarRow}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Space style={{ marginBottom: 8 }}>
              <Tag theme='primary' variant='light'>
                内容生产
              </Tag>
              <Tag theme='warning' variant='light'>
                Prompt 模板库（本机私有）
              </Tag>
            </Space>
            <div className={Style.heroTitle}>Prompt 库</div>
            <div className={Style.heroDesc}>
              支持 <code>{'{{变量名}}'}</code> 占位。复制后到 ChatGPT / Claude / 豆包 随处粘贴。
            </div>
          </div>
          <Space>
            <Button variant='outline' icon={<UploadIcon />} onClick={handleImport}>
              导入
            </Button>
            <Button variant='outline' icon={<DownloadIcon />} disabled={prompts.length === 0} onClick={handleExport}>
              导出
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={openCreate}>
              新增 Prompt
            </Button>
          </Space>
        </div>
      </Card>

      <div className={Style.statsGrid}>
        <Metric title='模板总数' value={stats.total} />
        <Metric title='已收藏' value={stats.fav} color='#ED7B2F' />
        <Metric title='SEO 模板' value={stats.byCat.seo || 0} color='#5E6AD2' />
        <Metric title='GEO 模板' value={stats.byCat.geo || 0} color='#00A870' />
      </div>

      <Card bordered={false} className={Style.toolbarCard} style={{ marginBottom: 16 }}>
        <div className={Style.toolbarRow}>
          <Input
            prefixIcon={<SearchIcon />}
            placeholder='搜标题 / 正文 / 标签'
            value={keyword}
            onChange={(v) => setKeyword(v as string)}
            style={{ width: 280 }}
            clearable
          />
          <Select
            value={catFilter}
            options={[{ label: '全部分类', value: 'all' }, ...CATEGORY_OPTIONS]}
            onChange={(v) => setCatFilter(v as string)}
            style={{ width: 180 }}
          />
          <Button
            variant={onlyFav ? 'base' : 'outline'}
            theme={onlyFav ? 'warning' : 'default'}
            icon={onlyFav ? <StarFilledIcon /> : <StarIcon />}
            onClick={() => setOnlyFav((v) => !v)}
          >
            仅看收藏
          </Button>
          <div style={{ flex: 1 }} />
          <Tag theme='success' variant='light'>
            共 {stats.total} · 收藏 {stats.fav} · 命中 {filtered.length}
          </Tag>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card bordered={false} className={Style.sectionCard}>
          <div className={Style.emptyState}>
            {prompts.length === 0 ? '还没有 Prompt，点“新增 Prompt”开始。' : '没有命中关键词的模板。'}
          </div>
        </Card>
      ) : (
        <div className={Style.gridAuto}>
          {filtered.map((p) => (
            <Card key={p.id} bordered={false} className={Style.promptCard} hoverShadow>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Tag
                  size='small'
                  variant='light'
                  style={{
                    background: `${CATEGORY_COLOR[p.category]}22`,
                    color: CATEGORY_COLOR[p.category],
                    border: 'none',
                  }}
                >
                  {CATEGORY_LABEL[p.category] || p.category}
                </Tag>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 14,
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {p.title}
                </div>
                <Button
                  size='small'
                  variant='text'
                  shape='square'
                  icon={p.favorite ? <StarFilledIcon style={{ color: '#F59E0B' }} /> : <StarIcon />}
                  onClick={() => toggleFav(p.id)}
                />
              </div>

              <div className={`${Style.monoBlock} ${Style.promptBody}`}>{p.body}</div>

              {p.variables.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {p.variables.map((v) => (
                    <Tag key={v} size='small' theme='primary' variant='light'>{`{{${v}}}`}</Tag>
                  ))}
                </div>
              )}
              {p.tags.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {p.tags.map((t) => (
                    <Tag key={t} size='small' variant='outline'>
                      #{t}
                    </Tag>
                  ))}
                </div>
              )}

              <Space style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                <Button size='small' variant='text' icon={<FileCopyIcon />} onClick={() => handleCopy(p.body)}>
                  复制
                </Button>
                <Button size='small' variant='text' icon={<EditIcon />} onClick={() => openEdit(p)}>
                  编辑
                </Button>
                <Popconfirm content='确认删除？' onConfirm={() => handleDelete(p.id)}>
                  <Button size='small' variant='text' theme='danger' icon={<DeleteIcon />} />
                </Popconfirm>
              </Space>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        header={editing ? '编辑 Prompt' : '新增 Prompt'}
        visible={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConfirm={handleSave}
        confirmBtn={
          <Button theme='primary' onClick={handleSave}>
            {editing ? '保存' : '创建'}
          </Button>
        }
        width={680}
        destroyOnClose
      >
        <Form labelWidth={100}>
          <FormItem label='模板名'>
            <Input
              placeholder='例如：SEO 标题生成 - H1 版'
              value={form.title}
              onChange={(v) => setForm((f) => ({ ...f, title: v as string }))}
            />
          </FormItem>
          <FormItem label='分类'>
            <Select
              value={form.category}
              options={CATEGORY_OPTIONS}
              onChange={(v) => setForm((f) => ({ ...f, category: v as string }))}
            />
          </FormItem>
          <FormItem label='Prompt 正文' help='支持占位符，形如 {{关键词}} {{品牌}}'>
            <Textarea
              placeholder='请根据下面的关键词 {{关键词}} 为 {{品牌}} 生成 3 个 SEO 友好的 H1 标题...'
              value={form.body}
              onChange={(v) => setForm((f) => ({ ...f, body: v as string }))}
              autosize={{ minRows: 6, maxRows: 16 }}
            />
          </FormItem>
          <FormItem label='标签' help='逗号或空格分隔，方便搜索'>
            <Input
              placeholder='标题, seo, 标题党'
              value={form.tags}
              onChange={(v) => setForm((f) => ({ ...f, tags: v as string }))}
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

export default Prompts;
