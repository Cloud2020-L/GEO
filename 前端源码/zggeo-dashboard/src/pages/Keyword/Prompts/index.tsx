import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Dialog, MessagePlugin, PrimaryTableCol, Select, Space, Table, Tag } from 'tdesign-react';
import { RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  deleteKeywordPrompt,
  deleteKeywordPrompts,
  generateKeywordPrompts,
  GenerationLanguage,
  getBillingAccount,
  KeywordInventoryItem,
  KeywordPromptItem,
  Lead,
  listKeywordPrompts,
  listSelectableLeads,
  listModelProviders,
  listNonBrandKeywords,
  ModelProviderRow,
} from 'services/zggeo-api';
import styles from './index.module.less';

const cleanDomain = (raw?: string | null) =>
  String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();

const leadBrand = (lead?: Lead | null) => String(lead?.brand_name || lead?.company || lead?.name || '').trim();

const keywordMarker = (value?: string | null) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();

const keywordSourceMeta = (source?: string | null) => {
  if (source === 'non_brand') return { label: '非品牌关键词', theme: 'success' as const };
  if (source === 'brand') return { label: '品牌关键词', theme: 'primary' as const };
  return { label: '未标记', theme: 'default' as const };
};

const KEYWORD_PROMPT_UNIT_COST = 10;

const createClientRequestId = () => {
  const randomUUID = typeof crypto !== 'undefined' ? crypto.randomUUID?.bind(crypto) : undefined;
  return randomUUID ? randomUUID() : `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

type KeywordSelectOption = {
  label: string;
  value: string;
  searchText: string;
  lead_id?: string | null;
  brand_name: string;
  company?: string | null;
  domain?: string | null;
  keyword: string;
  source: 'brand' | 'non_brand';
};

const getApiErrorMessage = (err: any) => {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail === 'object') return detail.message || JSON.stringify(detail);
  const data = err?.response?.data;
  if (typeof data === 'string' && data.trim()) return data;
  if (data && typeof data === 'object') return data.message || JSON.stringify(data);
  if (err?.message) return err.message;
  return '请检查后端、官网读取和模型配置';
};

const PromptInventory: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlPromptId = searchParams.get('prompt_id') || '';
  const [leads, setLeads] = useState<Lead[]>([]);
  const [prompts, setPrompts] = useState<KeywordPromptItem[]>([]);
  const [providers, setProviders] = useState<ModelProviderRow[]>([]);
  const [nonBrandKeywords, setNonBrandKeywords] = useState<KeywordSelectOption[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [selectedBrandKeyword, setSelectedBrandKeyword] = useState('');
  const [selectedNonBrandKeyword, setSelectedNonBrandKeyword] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState<GenerationLanguage>('zh');
  const [count, setCount] = useState(20);
  const [manualBrand, setManualBrand] = useState('');
  const [manualDomain, setManualDomain] = useState('');
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [loadingNonBrandKeywords, setLoadingNonBrandKeywords] = useState(false);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [loadingPrompts, setLoadingPrompts] = useState(false);
  const [loadingBilling, setLoadingBilling] = useState(false);
  const [availableCredits, setAvailableCredits] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [batchDeleting, setBatchDeleting] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<(string | number)[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [lastModelError, setLastModelError] = useState('');

  const selectedLead = useMemo(() => leads.find((lead) => lead.id === selectedLeadId) || null, [leads, selectedLeadId]);

  const brandName = manualBrand || leadBrand(selectedLead);
  const domain = cleanDomain(manualDomain || selectedLead?.domain);
  const nonBrandKeywordMarkers = useMemo(
    () => new Set(nonBrandKeywords.map((item) => keywordMarker(item.keyword)).filter(Boolean)),
    [nonBrandKeywords],
  );
  const brandKeywordOptions = useMemo<KeywordSelectOption[]>(() => {
    if (!selectedLead) return [];
    const brand = leadBrand(selectedLead) || '未命名客户';
    const d = cleanDomain(selectedLead.domain);
    return (selectedLead.keywords || [])
      .filter((keyword) => {
        const marker = keywordMarker(keyword);
        return marker && !nonBrandKeywordMarkers.has(marker);
      })
      .map((keyword, index) => ({
        label: `${keyword}${brand ? ` · ${brand}` : ''}${d ? ` · ${d}` : ''}`,
        value: `brand:${selectedLead.id}:${index}:${keyword}`,
        searchText: [keyword, brand, selectedLead.company, selectedLead.name, selectedLead.domain]
          .filter(Boolean)
          .join(' '),
        lead_id: selectedLead.id,
        brand_name: brand,
        company: selectedLead.company,
        domain: d,
        keyword,
        source: 'brand',
      }));
  }, [selectedLead, nonBrandKeywordMarkers]);
  const selectedKeyword = useMemo(
    () =>
      brandKeywordOptions.find((option) => option.value === selectedBrandKeyword) ||
      nonBrandKeywords.find((option) => option.value === selectedNonBrandKeyword) ||
      null,
    [brandKeywordOptions, nonBrandKeywords, selectedBrandKeyword, selectedNonBrandKeyword],
  );
  const currentPagePrompts = useMemo(
    () => prompts.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [currentPage, pageSize, prompts],
  );
  const configuredProviders = useMemo(() => providers.filter((provider) => provider.configured), [providers]);
  const estimatedCost = count * KEYWORD_PROMPT_UNIT_COST;
  const hasInsufficientCredits = availableCredits !== null && availableCredits < estimatedCost;

  const leadOptions = useMemo(
    () =>
      leads.map((lead) => {
        const brand = leadBrand(lead) || '未命名客户';
        const d = cleanDomain(lead.domain);
        return {
          label: `${brand}${d ? ` · ${d}` : ''}`,
          value: lead.id,
          searchText: [brand, lead.company, lead.name, lead.contact, lead.domain, ...(lead.keywords || [])]
            .filter(Boolean)
            .join(' '),
        };
      }),
    [leads],
  );

  const providerOptions = useMemo(
    () =>
      configuredProviders.map((provider) => ({
        label: `${provider.name}${provider.model ? ` · ${provider.model}` : ''}`,
        value: provider.key,
        searchText: [provider.name, provider.vendor, provider.key, provider.model, provider.endpoint, provider.protocol]
          .filter(Boolean)
          .join(' '),
      })),
    [configuredProviders],
  );

  const loadLeads = async () => {
    setLoadingLeads(true);
    try {
      const data = await listSelectableLeads();
      setLeads(data);
      if (!urlPromptId && !selectedLeadId && data.length > 0) setSelectedLeadId(data[0].id);
    } catch (err: any) {
      MessagePlugin.error(`客户资产读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoadingLeads(false);
    }
  };

  const loadProviders = async () => {
    setLoadingProviders(true);
    try {
      const data = await listModelProviders();
      const configured = data.providers.filter((provider) => provider.configured);
      const preferred = configured.find((provider) => provider.key !== 'openai') || configured[0];
      setProviders(data.providers);
      setSelectedProvider((current) => {
        if (current && configured.some((provider) => provider.key === current)) return current;
        return preferred?.key || '';
      });
    } catch (err: any) {
      MessagePlugin.error(`模型列表读取失败：${err?.response?.data?.detail || err?.message || '请检查后端服务'}`);
    } finally {
      setLoadingProviders(false);
    }
  };

  const loadBilling = async () => {
    setLoadingBilling(true);
    try {
      const data = await getBillingAccount();
      const account = data.account || {};
      const tenant = data.tenant || {};
      setAvailableCredits(Number(account.available_balance ?? tenant.credit_balance ?? 0));
    } catch (err: any) {
      MessagePlugin.warning(`积分账户读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoadingBilling(false);
    }
  };

  const loadNonBrandKeywordOptions = async (leadId = selectedLeadId) => {
    setLoadingNonBrandKeywords(true);
    try {
      const data = await listNonBrandKeywords({ lead_id: leadId || undefined, limit: 1000 });
      setNonBrandKeywords(
        data.items.map((item: KeywordInventoryItem, index: number) => ({
          label: `${item.keyword}${item.brand_name ? ` · ${item.brand_name}` : ''}${
            item.domain ? ` · ${cleanDomain(item.domain)}` : ''
          }`,
          value: `non_brand:${item.id || index}:${item.keyword}`,
          searchText: [item.keyword, item.intent, item.brand_name, item.company, item.domain].filter(Boolean).join(' '),
          lead_id: item.lead_id,
          brand_name: item.brand_name,
          company: item.company,
          domain: cleanDomain(item.domain),
          keyword: item.keyword,
          source: 'non_brand',
        })),
      );
    } catch (err: any) {
      MessagePlugin.error(`非品牌关键词读取失败：${err?.response?.data?.detail || err?.message || '请检查后端服务'}`);
    } finally {
      setLoadingNonBrandKeywords(false);
    }
  };

  const loadPrompts = async (leadId = selectedLeadId, promptId = '') => {
    setLoadingPrompts(true);
    try {
      const data = await listKeywordPrompts({
        prompt_id: promptId || undefined,
        lead_id: promptId ? undefined : leadId || undefined,
        limit: 200,
      });
      setPrompts(data.items);
      setSelectedRowKeys([]);
      setCurrentPage(1);
    } catch (err: any) {
      MessagePlugin.error(`Prompt库存读取失败：${err?.response?.data?.detail || err?.message || '请检查后端服务'}`);
    } finally {
      setLoadingPrompts(false);
    }
  };

  useEffect(() => {
    loadLeads();
    loadProviders();
    loadBilling();
    loadPrompts('', urlPromptId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (urlPromptId) return;
    if (!selectedLead) return;
    setSelectedBrandKeyword('');
    setSelectedNonBrandKeyword('');
    setNonBrandKeywords([]);
    setManualBrand(leadBrand(selectedLead));
    setManualDomain(cleanDomain(selectedLead.domain));
    loadPrompts(selectedLead.id);
    loadNonBrandKeywordOptions(selectedLead.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLead]);

  useEffect(() => {
    if (!urlPromptId) return;
    setSelectedLeadId('');
    loadPrompts('', urlPromptId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlPromptId]);

  useEffect(() => {
    if (!selectedBrandKeyword) return;
    if (!brandKeywordOptions.some((option) => option.value === selectedBrandKeyword)) {
      setSelectedBrandKeyword('');
    }
  }, [brandKeywordOptions, selectedBrandKeyword]);

  const openGenerateConfirm = () => {
    if (!selectedKeyword) {
      MessagePlugin.warning('请先选择品牌关键词或非品牌关键词');
      return;
    }
    const cleanBrand = selectedKeyword.brand_name.trim();
    if (!cleanBrand) {
      MessagePlugin.warning('当前关键词缺少品牌信息，请重新选择');
      return;
    }
    if (hasInsufficientCredits) {
      MessagePlugin.warning(
        `当前可用积分不足，本次生成并入库需要 ${estimatedCost.toLocaleString('zh-CN')} 积分，请购买相应的权益和积分包`,
      );
      return;
    }
    setConfirmOpen(true);
  };

  const handleGenerate = async () => {
    if (!selectedKeyword) {
      MessagePlugin.warning('请先选择品牌关键词或非品牌关键词');
      setConfirmOpen(false);
      return;
    }
    const cleanBrand = selectedKeyword.brand_name.trim();
    const cleanSite = cleanDomain(selectedKeyword.domain);
    if (!cleanBrand) {
      MessagePlugin.warning('当前关键词缺少品牌信息，请重新选择');
      setConfirmOpen(false);
      return;
    }
    if (hasInsufficientCredits) {
      MessagePlugin.warning(
        `当前可用积分不足，本次生成并入库需要 ${estimatedCost.toLocaleString('zh-CN')} 积分，请购买相应的权益和积分包`,
      );
      setConfirmOpen(false);
      return;
    }
    setConfirmOpen(false);
    setGenerating(true);
    setLastModelError('');
    try {
      const data = await generateKeywordPrompts({
        lead_id: selectedKeyword.lead_id || selectedLeadId || undefined,
        brand_name: cleanBrand,
        domain: cleanSite || undefined,
        company: selectedKeyword.company || selectedLead?.company,
        needs: selectedLead?.needs,
        keywords: [selectedKeyword.keyword],
        keyword_source: selectedKeyword.source,
        count,
        provider: selectedProvider || undefined,
        language: selectedLanguage,
        client_request_id: createClientRequestId(),
      });
      setLastModelError(data.model_error || '');
      setPrompts((prev) => [...data.items, ...prev]);
      setCurrentPage(1);
      await loadBilling();
      setConfirmOpen(false);
      MessagePlugin.success(
        `已生成并入库 ${data.items.length} 条 Prompt，已扣除 ${(
          data.items.length * KEYWORD_PROMPT_UNIT_COST
        ).toLocaleString('zh-CN')} 积分`,
      );
    } catch (err: any) {
      const message = getApiErrorMessage(err);
      const detail = err?.response?.data?.detail;
      if (detail?.code === 'INSUFFICIENT_CREDITS') {
        setAvailableCredits(Number(detail.available || 0));
        MessagePlugin.error(
          `积分不足：本次生成并入库需要 ${detail.required || estimatedCost} 积分，当前可用 ${
            detail.available || 0
          } 积分，请购买相应的权益和积分包`,
        );
      } else {
        MessagePlugin.error(`生成失败：${message}`);
      }
      setLastModelError(message);
      await loadBilling();
    } finally {
      setGenerating(false);
      setConfirmOpen(false);
    }
  };

  const handleDelete = async (row: KeywordPromptItem) => {
    setDeletingId(row.id);
    try {
      await deleteKeywordPrompt(row.id);
      setPrompts((prev) => prev.filter((item) => item.id !== row.id));
      setSelectedRowKeys((prev) => prev.filter((key) => key !== row.id));
      MessagePlugin.success('已删除该条 Prompt');
    } catch (err: any) {
      MessagePlugin.error(`删除失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setDeletingId('');
    }
  };

  const handleBatchDeleteIds = async (ids: string[], label: string) => {
    const cleanIds = Array.from(new Set(ids.filter(Boolean)));
    if (!cleanIds.length) {
      MessagePlugin.warning('请先选择要删除的 Prompt');
      return;
    }
    if (!window.confirm(`确认删除${label}的 ${cleanIds.length} 条 Prompt？删除后不可恢复。`)) return;
    setBatchDeleting(label);
    try {
      const data = await deleteKeywordPrompts({ ids: cleanIds, scope: 'ids' });
      const deletedIds = new Set(data.ids);
      setPrompts((prev) => prev.filter((item) => !deletedIds.has(item.id)));
      setSelectedRowKeys((prev) => prev.filter((key) => !deletedIds.has(String(key))));
      MessagePlugin.success(`已删除 ${data.deleted} 条 Prompt`);
    } catch (err: any) {
      MessagePlugin.error(`批量删除失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setBatchDeleting('');
    }
  };

  const handleDeleteSelected = () => {
    handleBatchDeleteIds(selectedRowKeys.map(String), '选中');
  };

  const handleDeleteCurrentPage = () => {
    handleBatchDeleteIds(
      currentPagePrompts.map((item) => item.id),
      '当前页',
    );
  };

  const handleDeleteAll = async () => {
    const scopeText = selectedLeadId ? '当前客户全部' : '当前列表全部';
    if (!prompts.length) {
      MessagePlugin.warning('暂无可删除的 Prompt');
      return;
    }
    if (!window.confirm(`确认删除${scopeText}的 Prompt？删除后不可恢复。`)) return;
    setBatchDeleting('全部');
    try {
      const data = selectedLeadId
        ? await deleteKeywordPrompts({ scope: 'all', lead_id: selectedLeadId })
        : await deleteKeywordPrompts({ ids: prompts.map((item) => item.id), scope: 'ids' });
      const deletedIds = new Set(data.ids);
      setPrompts((prev) => prev.filter((item) => !deletedIds.has(item.id)));
      setSelectedRowKeys([]);
      setCurrentPage(1);
      MessagePlugin.success(`已删除 ${data.deleted} 条 Prompt`);
    } catch (err: any) {
      MessagePlugin.error(`批量删除失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setBatchDeleting('');
    }
  };

  const columns: PrimaryTableCol<KeywordPromptItem>[] = [
    {
      colKey: 'row-select',
      type: 'multiple',
      width: 56,
    },
    {
      colKey: 'prompt',
      title: '客户可能问 AI 的提示词',
      minWidth: 360,
      cell: ({ row }) => <strong>{row.prompt}</strong>,
    },
    {
      colKey: 'keyword',
      title: '关联关键词',
      width: 190,
      cell: ({ row }) => {
        const meta = keywordSourceMeta(row.keyword_source);
        return row.keyword ? (
          <Space size={6} breakLine>
            <Tag variant='light'>{row.keyword}</Tag>
            <Tag theme={meta.theme} variant='light'>
              {meta.label}
            </Tag>
          </Space>
        ) : (
          '未指定'
        );
      },
    },
    {
      colKey: 'intent',
      title: '意图',
      width: 140,
    },
    {
      colKey: 'scenario',
      title: '场景',
      width: 150,
    },
    {
      colKey: 'model',
      title: '模型',
      width: 180,
      cell: ({ row }) => `${row.provider}${row.model ? ` / ${row.model}` : ''}`,
    },
    {
      colKey: 'article_count',
      title: '已生成文章',
      width: 160,
      cell: ({ row }) => (
        <Space size={6}>
          <Tag theme={Number(row.article_count || 0) > 0 ? 'success' : 'default'} variant='light'>
            {Number(row.article_count || 0)} 篇
          </Tag>
          {row.latest_article_at ? (
            <span style={{ color: 'var(--td-text-color-secondary)' }}>
              {new Date(row.latest_article_at).toLocaleDateString()}
            </span>
          ) : null}
        </Space>
      ),
    },
    {
      colKey: 'created_at',
      title: '入库时间',
      width: 190,
      cell: ({ row }) => (row.created_at ? new Date(row.created_at).toLocaleString() : '-'),
    },
    {
      colKey: 'operation',
      title: '操作',
      width: 190,
      cell: ({ row }) => (
        <Space size={6}>
          <Button
            variant='text'
            disabled={!Number(row.article_count || 0)}
            onClick={() => navigate(`/content-generation/articles?prompt_id=${row.id}`)}
          >
            查看文章
          </Button>
          <Button theme='danger' variant='text' loading={deletingId === row.id} onClick={() => handleDelete(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className={styles.page}>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <div className={styles.heroHeader}>
          <div>
            <Tag theme='primary' variant='light'>
              目标关键词系统
            </Tag>
            <h2 style={{ margin: '12px 0 8px', fontSize: 24 }}>Prompt库存</h2>
            <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.7 }}>
              根据客户资产里的品牌、官网和监测关键词，生成客户可能向 AI 提问的
              Prompt，并保存到数据库，后续可用于模型对比、A/B 校验和 GEO 优化验证。
            </div>
          </div>
          <Button variant='outline' icon={<RefreshIcon />} loading={loadingPrompts} onClick={() => loadPrompts()}>
            刷新库存
          </Button>
        </div>
      </Card>

      <Card bordered={false} title='生成设置' style={{ marginBottom: 16 }}>
        <Space direction='vertical' size={16} style={{ width: '100%' }}>
          <Select
            value={selectedLeadId}
            options={leadOptions}
            loading={loadingLeads}
            filterable
            clearable
            placeholder='选择客户资产；可输入品牌、公司、域名、联系人、关键词搜索'
            empty='暂无客户资产，请先录入客户'
            filter={(filterWords, option: any) => {
              const keyword = String(filterWords || '')
                .trim()
                .toLowerCase();
              if (!keyword) return true;
              return String(option?.searchText || option?.label || '')
                .toLowerCase()
                .includes(keyword);
            }}
            onChange={(value) => setSelectedLeadId(String(value || ''))}
          />

          {selectedLead ? (
            <div
              style={{
                border: '1px solid var(--td-component-border)',
                borderRadius: 8,
                background: 'var(--td-bg-color-container-hover)',
                padding: 14,
              }}
            >
              <Space direction='vertical' size={10} style={{ width: '100%' }}>
                <Space size={8} breakLine>
                  <Tag theme='primary' variant='light'>
                    当前资产：{brandName || '未命名客户'}
                  </Tag>
                  {domain ? (
                    <Tag variant='light'>官网：{domain}</Tag>
                  ) : (
                    <Tag theme='warning' variant='light'>
                      未填写官网
                    </Tag>
                  )}
                  {selectedLead.company ? <Tag variant='light'>公司：{selectedLead.company}</Tag> : null}
                  {selectedLead.name ? <Tag variant='light'>联系人：{selectedLead.name}</Tag> : null}
                </Space>
                <div style={{ color: 'var(--td-text-color-secondary)', fontSize: 12, lineHeight: 1.7 }}>
                  系统会从客户资产自动读取品牌、官网、公司信息和关键词，用来生成客户可能会问 AI 的 Prompt。
                </div>
              </Space>
            </div>
          ) : (
            <div
              style={{
                border: '1px dashed var(--td-component-border)',
                borderRadius: 8,
                color: 'var(--td-text-color-secondary)',
                padding: 14,
              }}
            >
              请先选择客户资产，系统会自动读取品牌、官网、公司信息和关键词。
            </div>
          )}

          <div className={styles.settingsGrid}>
            <Select
              label='品牌关键词'
              value={selectedBrandKeyword}
              options={brandKeywordOptions}
              loading={loadingLeads}
              filterable
              clearable
              disabled={!selectedLeadId}
              placeholder='选择或搜索品牌关键词'
              empty={selectedLeadId ? '当前资产暂无品牌关键词，请先拓展品牌关键词' : '请先选择客户资产'}
              filter={(filterWords, option: any) => {
                const keyword = String(filterWords || '')
                  .trim()
                  .toLowerCase();
                if (!keyword) return true;
                return String(option?.searchText || option?.label || '')
                  .toLowerCase()
                  .includes(keyword);
              }}
              onChange={(value) => {
                const nextValue = String(value || '');
                setSelectedBrandKeyword(nextValue);
                if (nextValue) setSelectedNonBrandKeyword('');
              }}
            />
            <Select
              label='非品牌关键词'
              value={selectedNonBrandKeyword}
              options={nonBrandKeywords}
              loading={loadingNonBrandKeywords}
              filterable
              clearable
              disabled={!selectedLeadId}
              placeholder='选择或搜索非品牌关键词'
              empty={selectedLeadId ? '当前资产暂无非品牌关键词，请先生成拓展关键词' : '请先选择客户资产'}
              filter={(filterWords, option: any) => {
                const keyword = String(filterWords || '')
                  .trim()
                  .toLowerCase();
                if (!keyword) return true;
                return String(option?.searchText || option?.label || '')
                  .toLowerCase()
                  .includes(keyword);
              }}
              onChange={(value) => {
                const nextValue = String(value || '');
                setSelectedNonBrandKeyword(nextValue);
                if (nextValue) setSelectedBrandKeyword('');
              }}
            />
            <Select
              label='生成模型'
              value={selectedProvider}
              options={providerOptions}
              loading={loadingProviders}
              filterable
              clearable
              placeholder='选择已配置模型'
              empty='暂无已配置模型'
              filter={(filterWords, option: any) => {
                const keyword = String(filterWords || '')
                  .trim()
                  .toLowerCase();
                if (!keyword) return true;
                return String(option?.searchText || option?.label || '')
                  .toLowerCase()
                  .includes(keyword);
              }}
              onChange={(value) => setSelectedProvider(String(value || ''))}
            />
            <Select
              label='生成语言'
              value={selectedLanguage}
              options={[
                { label: '中文', value: 'zh' },
                { label: '英文', value: 'en' },
                { label: '粤语', value: 'yue' },
              ]}
              onChange={(value) => setSelectedLanguage((value || 'zh') as GenerationLanguage)}
            />
            <Select
              label='生成数量'
              value={count}
              options={[5, 8, 10, 15, 20, 30, 50].map((value) => ({ label: `${value} 条`, value }))}
              onChange={(value) => setCount(Number(value) || 20)}
            />
            <Button
              theme='primary'
              icon={<SearchIcon />}
              loading={generating}
              disabled={hasInsufficientCredits}
              onClick={openGenerateConfirm}
            >
              生成并入库
            </Button>
          </div>

          <Space size={8} breakLine>
            <Tag theme={hasInsufficientCredits ? 'warning' : 'primary'} variant='light'>
              可用积分：
              {loadingBilling
                ? '读取中'
                : availableCredits === null
                ? '未知'
                : availableCredits.toLocaleString('zh-CN')}
            </Tag>
            <Tag theme='warning' variant='light'>
              本次生成并入库将消耗 {estimatedCost.toLocaleString('zh-CN')} 积分
            </Tag>
            <Tag theme={selectedProvider ? 'success' : 'warning'} variant='light'>
              当前模型：
              {selectedProvider
                ? providerOptions.find((option) => option.value === selectedProvider)?.label || selectedProvider
                : '未选择，将使用后端默认模型'}
            </Tag>
            <Tag variant='light'>已配置模型：{configuredProviders.length}</Tag>
            <Tag variant='light'>品牌关键词：{brandKeywordOptions.length}</Tag>
            <Tag variant='light'>非品牌关键词：{nonBrandKeywords.length}</Tag>
            {selectedKeyword ? (
              <Tag theme='primary' variant='light'>
                当前关键词：{selectedKeyword.keyword}
              </Tag>
            ) : null}
            {lastModelError ? (
              <Tag theme='warning' variant='light'>
                模型提示：已使用兜底
              </Tag>
            ) : null}
          </Space>

          {hasInsufficientCredits ? (
            <Alert
              theme='warning'
              title='积分不足，暂不能生成并入库'
              message={`当前可用积分 ${availableCredits?.toLocaleString(
                'zh-CN',
              )}，本次生成并入库需要 ${estimatedCost.toLocaleString('zh-CN')} 积分。请购买相应的权益和积分包后再操作。`}
              operation={
                <Space size={8}>
                  <Button size='small' variant='outline' onClick={() => navigate('/billing/credits')}>
                    购买积分包
                  </Button>
                  <Button size='small' theme='primary' onClick={() => navigate('/billing/plans')}>
                    升级套餐权益
                  </Button>
                </Space>
              }
            />
          ) : null}
        </Space>
      </Card>

      <Card
        bordered={false}
        title='Prompt库存'
        actions={
          <div className={styles.cardActions}>
            <Tag variant='light'>已选 {selectedRowKeys.length} 条</Tag>
            <Button
              variant='outline'
              theme='danger'
              loading={batchDeleting === '选中'}
              disabled={!selectedRowKeys.length}
              onClick={handleDeleteSelected}
            >
              删除选中
            </Button>
            <Button
              variant='outline'
              theme='danger'
              loading={batchDeleting === '当前页'}
              disabled={!currentPagePrompts.length}
              onClick={handleDeleteCurrentPage}
            >
              删除本页
            </Button>
            <Button
              theme='danger'
              loading={batchDeleting === '全部'}
              disabled={!prompts.length}
              onClick={handleDeleteAll}
            >
              {selectedLeadId ? '删除当前客户全部' : '删除当前列表全部'}
            </Button>
          </div>
        }
      >
        {lastModelError ? (
          <div style={{ color: 'var(--td-warning-color)', fontSize: 12, lineHeight: 1.6, marginBottom: 12 }}>
            模型提示：{lastModelError}
          </div>
        ) : null}
        <div className={styles.tableScroll}>
          <Table
            rowKey='id'
            columns={columns}
            data={prompts}
            loading={loadingPrompts}
            selectedRowKeys={selectedRowKeys}
            onSelectChange={(keys) => setSelectedRowKeys(keys)}
            pagination={{
              current: currentPage,
              pageSize,
              total: prompts.length,
              showJumper: true,
              pageSizeOptions: [10, 20, 50, 100],
              onCurrentChange(current) {
                setCurrentPage(current);
              },
              onPageSizeChange(size) {
                setPageSize(size);
                setCurrentPage(1);
              },
            }}
          />
        </div>
      </Card>

      <Dialog
        visible={confirmOpen}
        header='确认生成并入库'
        onClose={() => !generating && setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleGenerate}
        closeBtn={!generating}
        closeOnEscKeydown={!generating}
        closeOnOverlayClick={!generating}
        confirmBtn={{
          content: `确认扣除 ${estimatedCost.toLocaleString('zh-CN')} 积分并入库`,
          loading: generating,
        }}
        cancelBtn={{ content: '取消', disabled: generating }}
      >
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <div style={{ color: 'var(--td-text-color-primary)', lineHeight: 1.7 }}>
            本次将基于「{selectedKeyword?.keyword || '当前关键词'}」为「{brandName || '当前客户资产'}」生成 Prompt
            并保存入库，成功后扣除 <strong>{estimatedCost.toLocaleString('zh-CN')} 积分</strong>。
          </div>
          <Space size={8} breakLine>
            <Tag theme='primary' variant='light'>
              当前可用积分：
              {availableCredits === null ? '未知' : availableCredits.toLocaleString('zh-CN')}
            </Tag>
            <Tag theme='warning' variant='light'>
              本次消耗：{estimatedCost.toLocaleString('zh-CN')} 积分
            </Tag>
            <Tag theme='success' variant='light'>
              预计入库：{count} 条
            </Tag>
          </Space>
          <div style={{ color: 'var(--td-text-color-secondary)', fontSize: 12, lineHeight: 1.7 }}>
            如果生成失败或没有新 Prompt 入库，系统会释放预占积分；只有成功入库后才会正式扣除。
          </div>
        </Space>
      </Dialog>
    </div>
  );
};

export default PromptInventory;
