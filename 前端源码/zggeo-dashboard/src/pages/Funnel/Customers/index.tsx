import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Dialog,
  Form,
  Input,
  MessagePlugin,
  Popconfirm,
  PrimaryTableCol,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Textarea,
} from 'tdesign-react';
import { AddIcon, Edit1Icon, RefreshIcon, SearchIcon, UserIcon } from 'tdesign-icons-react';
import {
  createConsultationLead,
  deleteLead,
  listLeads,
  listSystemCustomerAssetOptions,
  Lead,
  FollowupStatus,
} from 'services/zggeo-api';
import LeadDetailDrawer from 'components/LeadDetailDrawer';
import { useAppSelector } from 'modules/store';
import {
  leadToProjectContext,
  removeDeletedLeadProjectCache,
  saveActiveProjectContext,
  upsertBrandFromProjectContext,
} from 'utils/projectContext';

/**
 * L2 销售漏斗 · 客户资产
 * 以 company + brand_name + domain 聚合留资，展示每个客户资产的联络人、最新动向、状态分布。
 * company 为空时按品牌/域名继续分组，避免不同资产都被归到“未登记公司”。
 */

interface CompanyBucket {
  key: string;
  company: string;
  assetName: string;
  leads: Lead[];
  total: number;
  byStatus: Record<FollowupStatus, number>;
  lastContact: string;
  hasReport: boolean;
}

interface CustomerForm {
  tenantName: string;
  company: string;
  brandName: string;
  domain: string;
  keywords: string;
  competitors: string;
  name: string;
  contact: string;
  needs: string;
}

const { FormItem } = Form;

const STATUS_LABEL: Record<FollowupStatus, string> = {
  new: '新',
  contacted: '已联系',
  in_progress: '跟进中',
  closed: '关闭',
};
const STATUS_COLOR: Record<FollowupStatus, string> = {
  new: '#F59E0B',
  contacted: '#3B82F6',
  in_progress: '#6366F1',
  closed: '#94A3B8',
};

const UNKNOWN = '未登记公司';

const cleanValue = (value: unknown) => String(value || '').trim();

const normalizeDomain = (raw: string) =>
  raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();

const makeAssetBucketKey = (lead: Lead) => {
  const tenant = cleanValue(lead.tenant_id);
  const company = cleanValue(lead.company).toLowerCase();
  const brand = cleanValue(lead.brand_name).toLowerCase();
  const domain = normalizeDomain(cleanValue(lead.domain));
  const stableParts = [tenant, company, brand, domain].filter(Boolean);
  return stableParts.length > 0 ? stableParts.join('::') : `lead::${lead.id}`;
};

const leadAssetName = (lead: Lead) =>
  cleanValue(lead.company) || cleanValue(lead.brand_name) || cleanValue(lead.domain) || UNKNOWN;

const parseList = (raw: string) =>
  raw
    .split(/[\n,，、]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const defaultKeywordsFor = (brandName: string) => {
  const brand = brandName.trim();
  if (!brand) return [];
  return [brand, `${brand} 官网`, `${brand} AI 搜索`, `${brand} GEO`];
};

const initialCustomerForm: CustomerForm = {
  tenantName: '',
  company: '',
  brandName: '',
  domain: '',
  keywords: '',
  competitors: '',
  name: '',
  contact: '',
  needs: '',
};

const Customers: React.FC = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [customerAssets, setCustomerAssets] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [currentLead, setCurrentLead] = useState<Lead | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createFormKey, setCreateFormKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [form, setForm] = useState<CustomerForm>(initialCustomerForm);
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const userRole = String(user?.role || '').toLowerCase();
  const isClientMember = userRole === 'client';
  const isAdmin = userRole === 'admin';

  const fetchData = async () => {
    setLoading(true);
    try {
      const nextLeads = await listLeads();
      setLeads(nextLeads);
      if (isAdmin) {
        setCustomerAssets(await listSystemCustomerAssetOptions());
      }
    } catch (e: any) {
      MessagePlugin.error('拉取失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    fetchData();
  }, []);

  const openCreate = () => {
    setForm(initialCustomerForm);
    setCreateFormKey((prev) => prev + 1);
    setCreateOpen(true);
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setForm(initialCustomerForm);
    setCreateFormKey((prev) => prev + 1);
  };

  const submitCustomer = async () => {
    const company = form.company.trim();
    const brandName = form.brandName.trim() || company;
    const domain = normalizeDomain(form.domain);
    const keywords = parseList(form.keywords);
    const competitors = parseList(form.competitors);
    const name = form.name.trim();
    const contact = form.contact.trim();
    const needs = form.needs.trim();

    if (!brandName || !name || !contact || !needs) {
      MessagePlugin.warning('请填写品牌/项目、联系人、联系方式和客户需求');
      return;
    }

    setCreating(true);
    try {
      const created = await createConsultationLead({
        company: company || undefined,
        tenant_name: form.tenantName.trim() || company || brandName,
        brand_name: brandName,
        domain: domain || undefined,
        keywords: keywords.length > 0 ? keywords : defaultKeywordsFor(brandName),
        competitors,
        name,
        contact,
        needs,
        source_page: '/funnel/customers',
      });
      const createdLead = {
        id: created.lead_id,
        company: company || undefined,
        brand_name: brandName,
        domain: domain || undefined,
        keywords: keywords.length > 0 ? keywords : defaultKeywordsFor(brandName),
        competitors,
        name,
        contact,
        needs,
        source_page: '/funnel/customers',
        followup_status: 'new',
      } as Lead;
      const context = leadToProjectContext(createdLead);
      if (context) {
        saveActiveProjectContext(context);
        upsertBrandFromProjectContext(context);
      }
      MessagePlugin.success('客户已登记，并设为当前项目');
      closeCreate();
      await fetchData();
    } catch (e: any) {
      MessagePlugin.error(e?.response?.data?.detail || '登记失败');
    } finally {
      setCreating(false);
    }
  };

  const removeDeletedLeads = (ids: string[]) => {
    setLeads((prev) => prev.filter((item) => !ids.includes(item.id)));
    if (currentLead && ids.includes(currentLead.id)) {
      setCurrentLead(null);
      setDetailOpen(false);
    }
  };

  const handleDeleteLead = async (lead: Lead) => {
    setDeletingId(lead.id);
    try {
      await deleteLead(lead.id);
      removeDeletedLeadProjectCache([lead]);
      removeDeletedLeads([lead.id]);
      MessagePlugin.success('客户登记已删除');
    } catch (e: any) {
      MessagePlugin.error(e?.response?.data?.detail || e?.message || '删除失败');
    } finally {
      setDeletingId('');
    }
  };

  const handleDeleteBucket = async (bucket: CompanyBucket) => {
    const ids = bucket.leads.map((item) => item.id);
    if (ids.length === 0) return;
    setDeletingId(ids[0]);
    try {
      await Promise.all(ids.map((id) => deleteLead(id)));
      removeDeletedLeadProjectCache(bucket.leads);
      removeDeletedLeads(ids);
      MessagePlugin.success(`已删除 ${ids.length} 条客户登记`);
    } catch (e: any) {
      MessagePlugin.error(e?.response?.data?.detail || e?.message || '删除失败');
      await fetchData();
    } finally {
      setDeletingId('');
    }
  };

  const buckets = useMemo<CompanyBucket[]>(() => {
    const map: Record<string, CompanyBucket> = {};
    leads.forEach((l) => {
      const key = makeAssetBucketKey(l);
      if (!map[key]) {
        map[key] = {
          key,
          company: cleanValue(l.company) || UNKNOWN,
          assetName: leadAssetName(l),
          leads: [],
          total: 0,
          byStatus: { new: 0, contacted: 0, in_progress: 0, closed: 0 },
          lastContact: '',
          hasReport: false,
        };
      }
      const b = map[key];
      b.leads.push(l);
      b.total += 1;
      const s = (l.followup_status || 'new') as FollowupStatus;
      b.byStatus[s] = (b.byStatus[s] || 0) + 1;
      if (l.created_at && l.created_at > b.lastContact) b.lastContact = l.created_at;
      if (l.report_id) b.hasReport = true;
    });
    return Object.values(map).sort((a, b) => {
      if (b.lastContact !== a.lastContact) return b.lastContact.localeCompare(a.lastContact);
      return b.total - a.total;
    });
  }, [leads]);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return buckets;
    return buckets.filter(
      (b) =>
        b.company.toLowerCase().includes(k) ||
        b.assetName.toLowerCase().includes(k) ||
        b.leads.some(
          (l) =>
            (l.name || '').toLowerCase().includes(k) ||
            (l.contact || '').toLowerCase().includes(k) ||
            (l.brand_name || '').toLowerCase().includes(k) ||
            (l.domain || '').toLowerCase().includes(k),
        ),
    );
  }, [buckets, keyword]);

  const columns: PrimaryTableCol<CompanyBucket>[] = [
    {
      colKey: 'company',
      title: '客户资产',
      width: 280,
      cell: ({ row }) => (
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {row.assetName === UNKNOWN ? (
              <span style={{ color: 'var(--td-text-color-placeholder)' }}>{UNKNOWN}</span>
            ) : (
              <>{row.assetName}</>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)', marginTop: 2 }}>
            {row.total} 位联络人
            {row.hasReport && (
              <Tag size='small' theme='primary' variant='light' style={{ marginLeft: 6 }}>
                含报告
              </Tag>
            )}
          </div>
          {(row.company !== UNKNOWN || row.leads[0]?.brand_name || row.leads[0]?.domain) && (
            <div style={{ fontSize: 11, color: 'var(--td-text-color-secondary)', marginTop: 2 }}>
              {row.company !== UNKNOWN ? `公司：${row.company}` : '公司未登记'}
              {row.leads[0]?.brand_name ? ` · 品牌：${row.leads[0].brand_name}` : ''}
              {row.leads[0].domain ? ` · ${row.leads[0].domain}` : ''}
            </div>
          )}
        </div>
      ),
    },
    {
      colKey: 'status',
      title: '跟进分布',
      cell: ({ row }) => (
        <Space size={4} style={{ flexWrap: 'wrap' }}>
          {(Object.keys(row.byStatus) as FollowupStatus[]).map((s) =>
            row.byStatus[s] > 0 ? (
              <Tag
                key={s}
                size='small'
                variant='light'
                style={{ background: `${STATUS_COLOR[s]}22`, color: STATUS_COLOR[s], border: 'none' }}
              >
                {STATUS_LABEL[s]} {row.byStatus[s]}
              </Tag>
            ) : null,
          )}
        </Space>
      ),
    },
    {
      colKey: 'lastContact',
      title: '最近留资',
      width: 180,
      cell: ({ row }) => (row.lastContact ? new Date(row.lastContact).toLocaleString('zh-CN') : '-'),
    },
    {
      colKey: 'expand',
      title: '联系人',
      width: 120,
      cell: ({ row }) => (
        <span style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>
          {row.leads
            .slice(0, 3)
            .map((l) => l.name || '匿名')
            .join(' / ')}
          {row.leads.length > 3 && ` +${row.leads.length - 3}`}
        </span>
      ),
    },
    {
      colKey: 'actions',
      title: '操作',
      width: 150,
      fixed: 'right',
      cell: ({ row }) => {
        const firstLead = row.leads[0];
        const deleting = row.leads.some((item) => item.id === deletingId);
        return (
          <Space size={8}>
            <Button
              size='small'
              variant='text'
              theme='primary'
              disabled={!firstLead}
              onClick={(event) => {
                event.stopPropagation();
                if (!firstLead) return;
                setCurrentLead(firstLead);
                setDetailOpen(true);
              }}
            >
              详情
            </Button>
            {!isClientMember && (
              <span onClick={(event) => event.stopPropagation()}>
                <Popconfirm
                  content={
                    row.total > 1
                      ? `确认永久删除“${row.assetName}”下 ${row.total} 条客户登记？相关 Prompt、报告和自动流程记录也会一并清理。`
                      : '确认永久删除这条客户登记？相关 Prompt、报告和自动流程记录也会一并清理。'
                  }
                  onConfirm={() => {
                    if (!firstLead) return;
                    if (row.total > 1) {
                      handleDeleteBucket(row);
                      return;
                    }
                    handleDeleteLead(firstLead);
                  }}
                  placement='top-right'
                >
                  <Button size='small' variant='text' theme='danger' loading={deleting} disabled={!firstLead}>
                    删除
                  </Button>
                </Popconfirm>
              </span>
            )}
          </Space>
        );
      },
    },
  ];

  // 子表：每个客户资产下的留资/联络人记录
  const expandedRow = ({ row }: { row: CompanyBucket }) => (
    <div style={{ padding: '8px 12px', background: '#FAFAFA' }}>
      <div style={{ display: 'grid', gap: 6 }}>
        {row.leads.map((l) => (
          <div
            key={l.id}
            onClick={() => {
              setCurrentLead(l);
              setDetailOpen(true);
            }}
            style={{
              padding: 10,
              background: '#fff',
              borderRadius: 6,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              border: '1px solid #E5E7EB',
            }}
          >
            <UserIcon style={{ color: STATUS_COLOR[(l.followup_status || 'new') as FollowupStatus] }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {l.name || '（未留姓名）'}
                <span style={{ marginLeft: 8, fontFamily: 'monospace', color: 'var(--td-text-color-secondary)' }}>
                  {l.contact || '—'}
                </span>
              </div>
              {(l.brand_name || l.domain) && (
                <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 2 }}>
                  品牌/项目：{l.brand_name || l.company || '—'}
                  {l.domain ? ` · ${l.domain}` : ''}
                </div>
              )}
              {!l.domain && (
                <Tag size='small' theme='danger' variant='light' style={{ marginTop: 4 }}>
                  缺官网，点右侧编辑补充
                </Tag>
              )}
              {Array.isArray(l.keywords) && l.keywords.length > 0 && (
                <Space size={4} style={{ flexWrap: 'wrap', marginTop: 4 }}>
                  {l.keywords.slice(0, 5).map((item) => (
                    <Tag key={item} size='small' theme='primary' variant='light'>
                      {item}
                    </Tag>
                  ))}
                  {l.keywords.length > 5 && (
                    <Tag size='small' variant='light'>
                      +{l.keywords.length - 5}
                    </Tag>
                  )}
                </Space>
              )}
              {l.needs && (
                <div style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginTop: 2, lineHeight: 1.5 }}>
                  {l.needs}
                </div>
              )}
            </div>
            <Tag
              size='small'
              variant='light'
              style={{
                background: `${STATUS_COLOR[(l.followup_status || 'new') as FollowupStatus]}22`,
                color: STATUS_COLOR[(l.followup_status || 'new') as FollowupStatus],
                border: 'none',
              }}
            >
              {STATUS_LABEL[(l.followup_status || 'new') as FollowupStatus]}
            </Tag>
            <Button
              size='small'
              variant='outline'
              icon={<Edit1Icon />}
              onClick={(event) => {
                event.stopPropagation();
                setCurrentLead(l);
                setDetailOpen(true);
              }}
            >
              {isClientMember ? '查看/改关键词' : '编辑/补官网'}
            </Button>
            {!isClientMember && (
              <span onClick={(event) => event.stopPropagation()}>
                <Popconfirm
                  content='确认永久删除这条客户登记？相关 Prompt、报告和自动流程记录也会一并清理。'
                  onConfirm={() => handleDeleteLead(l)}
                  placement='top-right'
                >
                  <Button size='small' variant='text' theme='danger' loading={deletingId === l.id}>
                    删除
                  </Button>
                </Popconfirm>
              </span>
            )}
            <span style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)', width: 100, textAlign: 'right' }}>
              {l.created_at ? new Date(l.created_at).toLocaleDateString('zh-CN') : '-'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  const summary = useMemo(
    () => ({
      assets: buckets.length,
      namelessLeads: buckets.filter((b) => b.company === UNKNOWN).reduce((total, bucket) => total + bucket.total, 0),
      withReport: buckets.filter((b) => b.hasReport).length,
      totalLeads: leads.length,
    }),
    [buckets, leads],
  );
  const tenantOptions = useMemo(() => {
    const map = new Map<string, string>();
    customerAssets.forEach((asset) => {
      const tenantName = String(asset.tenant_name || '').trim();
      if (!tenantName || map.has(tenantName)) return;
      const label = [tenantName, asset.company || asset.brand_name].filter(Boolean).join(' · ');
      map.set(tenantName, label);
    });
    return Array.from(map, ([value, label]) => ({ label, value }));
  }, [customerAssets]);

  return (
    <div style={{ padding: 16 }}>
      {/* 顶部汇总 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
        <StatCard label='留资总数' value={summary.totalLeads} color='#6366F1' />
        <StatCard label='客户资产数' value={summary.assets} color='#10B981' />
        <StatCard label='含报告客户数' value={summary.withReport} color='#3B82F6' />
        <StatCard label='未填公司登记' value={summary.namelessLeads} color='#F59E0B' />
      </div>

      <Card bordered={false} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Input
            prefixIcon={<SearchIcon />}
            placeholder='搜资产 / 公司 / 姓名 / 联系方式'
            value={keyword}
            onChange={(v) => setKeyword(v as string)}
            style={{ width: 320 }}
            clearable
          />
          <div style={{ flex: 1 }} />
          <Tag theme='success' variant='light'>
            {filtered.length} 个资产
          </Tag>
          <Button icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
          {!isClientMember && (
            <Button theme='primary' icon={<AddIcon />} onClick={openCreate}>
              新增客户
            </Button>
          )}
        </div>
      </Card>

      <Card bordered={false}>
        {loading && leads.length === 0 ? (
          <Skeleton
            animation='gradient'
            theme='paragraph'
            loading
            rowCol={[
              { width: '100%', height: 'px' },
              { width: '100%', height: 'px' },
              { width: '100%', height: 'px' },
              { width: '100%', height: 'px' },
              { width: '100%', height: 'px' },
            ]}
          />
        ) : (
          <Table
            data={filtered}
            columns={columns}
            rowKey='key'
            expandedRow={expandedRow}
            expandOnRowClick
            size='medium'
            stripe
            empty='暂无客户数据'
          />
        )}
      </Card>

      <LeadDetailDrawer
        visible={detailOpen}
        lead={currentLead}
        onClose={() => setDetailOpen(false)}
        onUpdated={(next) => {
          setLeads((prev) => prev.map((l) => (l.id === next.id ? { ...l, ...next } : l)));
          setCurrentLead(next);
        }}
      />

      <Dialog
        visible={createOpen}
        header='新增客户登记'
        width={760}
        onClose={closeCreate}
        onConfirm={submitCustomer}
        confirmBtn={
          <Button theme='primary' loading={creating} onClick={submitCustomer}>
            保存客户
          </Button>
        }
      >
        <Form key={createFormKey} layout='vertical'>
          {isAdmin && (
            <FormItem label='所属客户空间' help='可选择已有客户空间，也可以直接输入新客户空间名称'>
              <Select
                value={form.tenantName}
                placeholder='例如：青创美居客户空间'
                options={tenantOptions}
                filterable
                creatable
                onChange={(v) => setForm((prev) => ({ ...prev, tenantName: String(v) }))}
              />
            </FormItem>
          )}
          <FormItem label='公司名称' help='可选；不填会归入“未登记公司”'>
            <Input
              value={form.company}
              placeholder='例如：深圳某某科技有限公司'
              onChange={(v) => {
                const company = String(v);
                setForm((prev) => ({
                  ...prev,
                  company,
                  brandName: prev.brandName || company,
                  tenantName: prev.tenantName || company,
                }));
              }}
            />
          </FormItem>
          <FormItem label='品牌/项目' requiredMark>
            <Input
              value={form.brandName}
              placeholder='例如：智改 GEO / 客户品牌名 / 项目名'
              onChange={(v) => setForm((prev) => ({ ...prev, brandName: String(v) }))}
            />
          </FormItem>
          <FormItem label='官网域名' help='可选；填写后，品牌池导入会自动带过去'>
            <Input
              value={form.domain}
              placeholder='例如：example.com'
              onChange={(v) => setForm((prev) => ({ ...prev, domain: String(v) }))}
            />
          </FormItem>
          <FormItem label='监测关键词' help='每行一个；不填会按品牌名自动生成基础关键词'>
            <Textarea
              value={form.keywords}
              placeholder={'品牌名\n品牌名 官网\n品牌名 AI 搜索\n品牌名 GEO'}
              autosize={{ minRows: 3, maxRows: 6 }}
              onChange={(v) => setForm((prev) => ({ ...prev, keywords: String(v) }))}
            />
          </FormItem>
          <FormItem label='竞品' help='可选，每行一个'>
            <Textarea
              value={form.competitors}
              placeholder={'竞品 A\n竞品 B'}
              autosize={{ minRows: 2, maxRows: 5 }}
              onChange={(v) => setForm((prev) => ({ ...prev, competitors: String(v) }))}
            />
          </FormItem>
          <FormItem label='联系人' requiredMark>
            <Input
              value={form.name}
              placeholder='客户姓名 / 对接人'
              onChange={(v) => setForm((prev) => ({ ...prev, name: String(v) }))}
            />
          </FormItem>
          <FormItem label='联系方式' requiredMark>
            <Input
              value={form.contact}
              placeholder='手机号 / 微信 / 邮箱'
              onChange={(v) => setForm((prev) => ({ ...prev, contact: String(v) }))}
            />
          </FormItem>
          <FormItem label='客户需求' requiredMark>
            <Textarea
              value={form.needs}
              placeholder='例如：想做官网 GEO 诊断，提升在 ChatGPT / 豆包里的品牌可见性'
              autosize={{ minRows: 4, maxRows: 8 }}
              onChange={(v) => setForm((prev) => ({ ...prev, needs: String(v) }))}
            />
          </FormItem>
        </Form>
      </Dialog>
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <Card bordered={false} style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
    <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>{label}</div>
    <div style={{ fontSize: 28, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
  </Card>
);

export default Customers;
