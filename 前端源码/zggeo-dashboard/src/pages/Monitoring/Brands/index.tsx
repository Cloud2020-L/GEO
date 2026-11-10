import React, { useMemo, useState } from 'react';
import {
  Card,
  Tag,
  Button,
  Space,
  Input,
  Table,
  PrimaryTableCol,
  MessagePlugin,
  Dialog,
  Form,
  Textarea,
  Popconfirm,
  Select,
} from 'tdesign-react';
import { AddIcon, EditIcon, DeleteIcon, SearchIcon, DownloadIcon, UploadIcon } from 'tdesign-icons-react';
import { useLocalStorage } from 'hooks/useLocalStorage';
import { listSelectableLeads, Lead } from 'services/zggeo-api';
import { scopedStorageKey } from 'utils/scopedStorage';
import styles from '../linear.module.less';

/**
 * L3 监测诊断 · 品牌词管理
 * 后端 codex /brands 接口暂未开放，这里先用 localStorage 存
 * 数据格式之后接通后端时直接 POST 过去
 */

interface Brand {
  id: string;
  name: string; // 品牌名 / 项目名
  domain: string;
  keywords: string[]; // 监测关键词
  competitors: string[]; // 竞品
  notes?: string;
  created_at: string;
  updated_at: string;
}

interface ImportForm {
  name: string;
  domain: string;
  keywords: string;
  competitors: string;
  notes: string;
}

const STORAGE_KEY = 'example.com.v1';

const uid = () => `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const { FormItem } = Form;

const emptyImportForm: ImportForm = {
  name: '',
  domain: '',
  keywords: '',
  competitors: '',
  notes: '',
};

const normalizeDomain = (raw: string) =>
  raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();

const extractDomain = (raw: string) => {
  const urlMatch = raw.match(/https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?:[/?#\s]|$)/i);
  if (urlMatch?.[1]) return normalizeDomain(urlMatch[1]);

  const domainMatch = raw.match(/\b(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  if (domainMatch?.[1]) return normalizeDomain(domainMatch[1]);

  return '';
};

const readLeadList = (value: unknown) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(/[\n,，、]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
};

const buildDefaultKeywords = (brandName: string) => {
  const brand = brandName.trim();
  if (!brand) return [];
  return [brand, `${brand} 官网`, `${brand} AI 搜索`, `${brand} GEO`];
};

const extractLabeledList = (raw: string, labels: string[]) => {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`^\\s*(?:${escaped})\\s*[:：]\\s*(.+)$`, 'i');
  const matched = raw
    .split('\n')
    .map((line) => line.match(re)?.[1] || '')
    .filter(Boolean);
  return readLeadList(matched.join('\n'));
};

const buildImportForm = (lead: Lead): ImportForm => {
  const name = String(lead.brand_name || lead.company || lead.name || '').trim();
  const needs = String(lead.needs || '').trim();
  const contact = String(lead.contact || '').trim();
  const domain =
    normalizeDomain(String(lead.domain || '')) ||
    extractDomain([lead.company, lead.brand_name, needs, contact].filter(Boolean).join('\n'));
  const keywords = readLeadList(lead.keywords);
  const needsKeywords = extractLabeledList(needs, ['关键词', '监测关键词', '品牌词', 'GEO关键词', 'SEO关键词']);
  const competitors = readLeadList(lead.competitors);
  const needsCompetitors = extractLabeledList(needs, ['竞品', '竞争对手', '竞品品牌', '竞品公司']);

  return {
    name,
    domain,
    keywords: (keywords.length > 0
      ? keywords
      : needsKeywords.length > 0
      ? needsKeywords
      : buildDefaultKeywords(name)
    ).join('\n'),
    competitors: (competitors.length > 0 ? competitors : needsCompetitors).join('\n'),
    notes: [
      `来自客户资产：${lead.name || '未留姓名'} / ${contact || '未留联系方式'}`,
      lead.company && `公司名称：${lead.company}`,
      needs && `客户需求：${needs}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
};

const Brands: React.FC = () => {
  const brandStorageKey = useMemo(() => scopedStorageKey(STORAGE_KEY), []);
  const [brands, setBrands] = useLocalStorage<Brand[]>(brandStorageKey, []);
  const [keyword, setKeyword] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Brand | null>(null);
  const [form, setForm] = useState<{
    name: string;
    domain: string;
    keywords: string;
    competitors: string;
    notes: string;
  }>({
    name: '',
    domain: '',
    keywords: '',
    competitors: '',
    notes: '',
  });
  const [leadDialogOpen, setLeadDialogOpen] = useState(false);
  const [leadLoading, setLeadLoading] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [dialogSelectedLeadId, setDialogSelectedLeadId] = useState('');
  const [importForm, setImportForm] = useState<ImportForm>(emptyImportForm);

  const filtered = useMemo(() => {
    if (!keyword.trim()) return brands;
    const k = keyword.toLowerCase();
    return brands.filter(
      (b) =>
        b.name.toLowerCase().includes(k) ||
        b.domain.toLowerCase().includes(k) ||
        b.keywords.some((x) => x.toLowerCase().includes(k)),
    );
  }, [brands, keyword]);

  const leadOptions = useMemo(
    () =>
      leads.map((lead) => {
        const company = String(lead.company || '').trim();
        const brandName = String(lead.brand_name || '').trim();
        const domain = String(lead.domain || '').trim();
        const name = String(lead.name || '').trim();
        const contact = String(lead.contact || '').trim();
        return {
          label: `${brandName || company || name || '未命名客户'}${domain ? ` · ${domain}` : ''}${
            company && brandName !== company ? ` / ${company}` : ''
          }${contact ? ` · ${contact}` : ''}`,
          value: lead.id,
        };
      }),
    [leads],
  );

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', domain: '', keywords: '', competitors: '', notes: '' });
    setDialogSelectedLeadId('');
    setDialogOpen(true);
    loadLeadAssets({ silent: true }).catch(() => undefined);
  };

  const openEdit = (b: Brand) => {
    setEditing(b);
    setForm({
      name: b.name,
      domain: b.domain,
      keywords: b.keywords.join('\n'),
      competitors: b.competitors.join('\n'),
      notes: b.notes || '',
    });
    setDialogSelectedLeadId('');
    setDialogOpen(true);
    loadLeadAssets({ silent: true }).catch(() => undefined);
  };

  const parseList = (raw: string) =>
    raw
      .split(/[\n,，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const loadLeadAssets = async (options?: { silent?: boolean }) => {
    setLeadLoading(true);
    try {
      const rows = await listSelectableLeads();
      setLeads(rows);
      if (!options?.silent && rows.length === 0) {
        MessagePlugin.warning('客户资产里还没有客户，先去登记一个客户');
      }
      return rows;
    } catch (e: any) {
      if (!options?.silent) MessagePlugin.error(e?.response?.data?.detail || '拉取客户资产失败');
      return [];
    } finally {
      setLeadLoading(false);
    }
  };

  const openLeadImport = async () => {
    setLeadDialogOpen(true);
    setSelectedLeadId('');
    setImportForm(emptyImportForm);
    await loadLeadAssets();
  };

  const resolveLeadId = (value: unknown, context?: any) => {
    const optionValue = context?.selectedOptions?.[0]?.value ?? context?.selectedOption?.value;
    const raw = optionValue ?? (typeof value === 'object' && value !== null ? (value as any).value : value);
    return String(raw || '');
  };

  const applyLeadToImportForm = (lead: Lead, options?: { silent?: boolean }) => {
    setSelectedLeadId(lead.id);
    setImportForm(buildImportForm(lead));
    if (!options?.silent) {
      MessagePlugin.success('已带入品牌名、官网域名、关键词、竞品和备注');
    }
  };

  const applyLeadToBrandForm = (lead: Lead) => {
    const next = buildImportForm(lead);
    setDialogSelectedLeadId(lead.id);
    setForm({
      name: next.name,
      domain: next.domain,
      keywords: next.keywords,
      competitors: next.competitors,
      notes: next.notes,
    });
    MessagePlugin.success('已从客户资产覆盖下面表单，确认后点保存');
  };

  const findLeadBySelectValue = (value: unknown, context?: any) => {
    const id = resolveLeadId(value, context);
    if (!id) return null;
    return leads.find((item) => item.id === id) || null;
  };

  const selectLead = (value: unknown, context?: any) => {
    const lead = findLeadBySelectValue(value, context);
    if (!lead) {
      const id = resolveLeadId(value, context);
      setSelectedLeadId(id);
      MessagePlugin.warning('没有找到这条客户资料，请点刷新后重试');
      return;
    }
    applyLeadToImportForm(lead);
  };

  const selectLeadForBrandForm = (value: unknown, context?: any) => {
    const lead = findLeadBySelectValue(value, context);
    if (!lead) {
      const id = resolveLeadId(value, context);
      setDialogSelectedLeadId(id);
      MessagePlugin.warning('没有找到这条客户资料，请点刷新后重试');
      return;
    }
    applyLeadToBrandForm(lead);
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      MessagePlugin.warning('请填写品牌/项目名');
      return;
    }
    if (!form.domain.trim()) {
      MessagePlugin.warning('请填写域名');
      return;
    }
    const now = new Date().toISOString();
    if (editing) {
      setBrands((prev) =>
        prev.map((b) =>
          b.id === editing.id
            ? {
                ...b,
                name: form.name.trim(),
                domain: form.domain.trim(),
                keywords: parseList(form.keywords),
                competitors: parseList(form.competitors),
                notes: form.notes.trim() || undefined,
                updated_at: now,
              }
            : b,
        ),
      );
      MessagePlugin.success('已更新');
    } else {
      setBrands((prev) => [
        {
          id: uid(),
          name: form.name.trim(),
          domain: form.domain.trim(),
          keywords: parseList(form.keywords),
          competitors: parseList(form.competitors),
          notes: form.notes.trim() || undefined,
          created_at: now,
          updated_at: now,
        },
        ...prev,
      ]);
      MessagePlugin.success('已添加');
    }
    setDialogOpen(false);
  };

  const handleImportLead = () => {
    if (!selectedLeadId) {
      MessagePlugin.warning('请选择一个客户资产');
      return;
    }
    if (!importForm.name.trim()) {
      MessagePlugin.warning('请确认品牌/项目名');
      return;
    }
    if (!importForm.domain.trim()) {
      MessagePlugin.warning('请补充客户官网域名，后续诊断需要用到');
      return;
    }

    const now = new Date().toISOString();
    const nextBrand: Brand = {
      id: uid(),
      name: importForm.name.trim(),
      domain: normalizeDomain(importForm.domain),
      keywords: parseList(importForm.keywords),
      competitors: parseList(importForm.competitors),
      notes: importForm.notes.trim() || undefined,
      created_at: now,
      updated_at: now,
    };
    const existingIndex = brands.findIndex(
      (brand) =>
        normalizeDomain(brand.domain) === nextBrand.domain ||
        brand.name.trim().toLowerCase() === nextBrand.name.toLowerCase(),
    );

    setBrands((prev) => {
      const index = prev.findIndex(
        (brand) =>
          normalizeDomain(brand.domain) === nextBrand.domain ||
          brand.name.trim().toLowerCase() === nextBrand.name.toLowerCase(),
      );
      if (index < 0) return [nextBrand, ...prev];

      return prev.map((brand, idx) =>
        idx === index
          ? {
              ...brand,
              name: nextBrand.name,
              domain: nextBrand.domain,
              keywords: nextBrand.keywords,
              competitors: nextBrand.competitors,
              notes: nextBrand.notes,
              updated_at: now,
            }
          : brand,
      );
    });

    MessagePlugin.success(existingIndex >= 0 ? '已用客户资产更新品牌池' : '已从客户资产导入品牌池');
    setLeadDialogOpen(false);
  };

  const handleDelete = (id: string) => {
    setBrands((prev) => prev.filter((b) => b.id !== id));
    MessagePlugin.success('已删除');
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(brands, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zggeo-brands-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const arr = JSON.parse(text);
        if (!Array.isArray(arr)) throw new Error('不是数组');
        setBrands(arr);
        MessagePlugin.success(`已导入 ${arr.length} 条`);
      } catch (e: any) {
        MessagePlugin.error(`导入失败：${e?.message || 'JSON 格式错'}`);
      }
    };
    input.click();
  };

  const columns: PrimaryTableCol<Brand>[] = [
    {
      colKey: 'name',
      title: '品牌 / 项目',
      width: 200,
      cell: ({ row }) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.name}</div>
          <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>{row.domain}</div>
        </div>
      ),
    },
    {
      colKey: 'keywords',
      title: '监测关键词',
      minWidth: 240,
      cell: ({ row }) => (
        <Space size={4} style={{ flexWrap: 'wrap' }}>
          {row.keywords.slice(0, 8).map((k) => (
            <Tag key={k} size='small' theme='primary' variant='light'>
              {k}
            </Tag>
          ))}
          {row.keywords.length > 8 && (
            <Tag size='small' theme='default' variant='light'>
              +{row.keywords.length - 8}
            </Tag>
          )}
          {row.keywords.length === 0 && (
            <span style={{ color: 'var(--td-text-color-placeholder)', fontSize: 12 }}>—</span>
          )}
        </Space>
      ),
    },
    {
      colKey: 'competitors',
      title: '竞品',
      width: 200,
      cell: ({ row }) => (
        <Space size={4} style={{ flexWrap: 'wrap' }}>
          {row.competitors.slice(0, 3).map((k) => (
            <Tag key={k} size='small' theme='warning' variant='light'>
              {k}
            </Tag>
          ))}
          {row.competitors.length > 3 && (
            <Tag size='small' theme='default' variant='light'>
              +{row.competitors.length - 3}
            </Tag>
          )}
          {row.competitors.length === 0 && (
            <span style={{ color: 'var(--td-text-color-placeholder)', fontSize: 12 }}>—</span>
          )}
        </Space>
      ),
    },
    {
      colKey: 'updated_at',
      title: '最近修改',
      width: 160,
      cell: ({ row }) => new Date(row.updated_at).toLocaleString('zh-CN'),
    },
    {
      colKey: 'action',
      title: '操作',
      width: 150,
      fixed: 'right',
      cell: ({ row }) => (
        <Space size='small'>
          <Button size='small' variant='text' icon={<EditIcon />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm content='确认删除？' onConfirm={() => handleDelete(row.id)}>
            <Button size='small' variant='text' theme='danger' icon={<DeleteIcon />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className={styles.page}>
      {/* 顶部说明 */}
      <Card bordered={false} className={styles.heroCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>品牌词库（本机私有）</div>
            <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>
              暂存在浏览器里，后端 codex 未来会提供 <code>/brands</code>。届时会自动迁移。 导出 JSON 方便迁移 / 备份。
            </div>
          </div>
          <Space>
            <Button variant='outline' icon={<UploadIcon />} onClick={openLeadImport}>
              从客户资产导入
            </Button>
            <Button variant='outline' icon={<UploadIcon />} onClick={handleImport}>
              导入 JSON
            </Button>
            <Button variant='outline' icon={<DownloadIcon />} disabled={brands.length === 0} onClick={handleExport}>
              导出
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={openCreate}>
              新增品牌
            </Button>
          </Space>
        </div>
      </Card>

      {/* 搜索栏 */}
      <Card bordered={false} className={styles.toolbarCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Input
            prefixIcon={<SearchIcon />}
            placeholder='搜品牌 / 域名 / 关键词'
            value={keyword}
            onChange={(v) => setKeyword(v as string)}
            style={{ width: 320 }}
            clearable
          />
          <div style={{ flex: 1 }} />
          <Tag theme='success' variant='light'>
            共 {brands.length} 个品牌 · 命中 {filtered.length}
          </Tag>
        </div>
      </Card>

      <Card bordered={false} className={styles.sectionCard}>
        <Table
          data={filtered}
          columns={columns}
          rowKey='id'
          size='medium'
          stripe
          hover
          empty={brands.length === 0 ? '还没有品牌，点右上角"新增品牌"开始' : '没有命中关键词的品牌'}
        />
      </Card>

      <Dialog
        header={editing ? '编辑品牌' : '新增品牌'}
        visible={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConfirm={handleSave}
        confirmBtn={
          <Button theme='primary' onClick={handleSave}>
            {editing ? '保存' : '创建'}
          </Button>
        }
        width={600}
        destroyOnClose
      >
        <Form labelWidth={100}>
          <FormItem
            label='客户资产带入'
            help='选择后会把客户资产里的品牌名、官网域名、关键词、竞品和需求备注一次性填到下面'
          >
            <Space style={{ width: '100%' }}>
              <Select
                loading={leadLoading}
                value={dialogSelectedLeadId}
                options={leadOptions}
                placeholder='可选：从客户资产一键覆盖下面表单'
                filterable
                clearable
                style={{ width: 380 }}
                onChange={selectLeadForBrandForm}
              />
              <Button variant='outline' onClick={() => loadLeadAssets()}>
                刷新客户
              </Button>
            </Space>
          </FormItem>
          <FormItem label='品牌名 / 项目'>
            <Input
              placeholder='例如：智改 GEO'
              value={form.name}
              onChange={(v) => setForm((f) => ({ ...f, name: v as string }))}
            />
          </FormItem>
          <FormItem label='域名'>
            <Input
              placeholder='example.com'
              value={form.domain}
              onChange={(v) => setForm((f) => ({ ...f, domain: v as string }))}
            />
          </FormItem>
          <FormItem label='监测关键词' help='每行一个，或用逗号 / 空格分隔'>
            <Textarea
              placeholder={'AI 可见度优化\nGEO 是什么\n企业知识检索'}
              value={form.keywords}
              onChange={(v) => setForm((f) => ({ ...f, keywords: v as string }))}
              autosize={{ minRows: 3, maxRows: 8 }}
            />
          </FormItem>
          <FormItem label='竞品' help='可选'>
            <Textarea
              placeholder={'竞品 A\n竞品 B'}
              value={form.competitors}
              onChange={(v) => setForm((f) => ({ ...f, competitors: v as string }))}
              autosize={{ minRows: 2, maxRows: 4 }}
            />
          </FormItem>
          <FormItem label='备注'>
            <Textarea
              value={form.notes}
              onChange={(v) => setForm((f) => ({ ...f, notes: v as string }))}
              autosize={{ minRows: 2, maxRows: 4 }}
            />
          </FormItem>
        </Form>
      </Dialog>

      <Dialog
        header='从客户资产导入品牌'
        visible={leadDialogOpen}
        onClose={() => setLeadDialogOpen(false)}
        onConfirm={handleImportLead}
        confirmBtn={
          <Button theme='primary' onClick={handleImportLead}>
            导入品牌池
          </Button>
        }
        width={680}
        destroyOnClose
      >
        <Form labelWidth={100}>
          <FormItem label='选择客户'>
            <Select
              loading={leadLoading}
              value={selectedLeadId}
              options={leadOptions}
              placeholder='从客户资产里选择一家公司 / 联系人'
              filterable
              onChange={selectLead}
            />
          </FormItem>
          <FormItem label='品牌名 / 项目'>
            <Input
              value={importForm.name}
              placeholder='自动取客户资产里的品牌/项目名'
              onChange={(v) => setImportForm((f) => ({ ...f, name: String(v) }))}
            />
          </FormItem>
          <FormItem label='官网域名' help='优先读取客户资产里的官网域名'>
            <Input
              value={importForm.domain}
              placeholder='example.com'
              onChange={(v) => setImportForm((f) => ({ ...f, domain: String(v) }))}
            />
          </FormItem>
          <FormItem label='监测关键词' help='优先读取客户资产里的关键词；没有填写时自动生成基础品牌词'>
            <Textarea
              value={importForm.keywords}
              onChange={(v) => setImportForm((f) => ({ ...f, keywords: String(v) }))}
              autosize={{ minRows: 3, maxRows: 8 }}
            />
          </FormItem>
          <FormItem label='竞品'>
            <Textarea
              value={importForm.competitors}
              placeholder='可选，每行一个'
              onChange={(v) => setImportForm((f) => ({ ...f, competitors: String(v) }))}
              autosize={{ minRows: 2, maxRows: 4 }}
            />
          </FormItem>
          <FormItem label='备注'>
            <Textarea
              value={importForm.notes}
              onChange={(v) => setImportForm((f) => ({ ...f, notes: String(v) }))}
              autosize={{ minRows: 3, maxRows: 6 }}
            />
          </FormItem>
        </Form>
      </Dialog>
    </div>
  );
};

export default Brands;
