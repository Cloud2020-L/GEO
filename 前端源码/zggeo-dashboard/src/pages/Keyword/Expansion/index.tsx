import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Dialog, MessagePlugin, PrimaryTableCol, Select, Space, Table, Tag } from 'tdesign-react';
import { RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import { useLocalStorage } from 'hooks/useLocalStorage';
import { scopedStorageKey } from 'utils/scopedStorage';
import {
  createKeywordGenerationRun,
  GenerationLanguage,
  getActiveKeywordGenerationRun,
  getBillingAccount,
  getKeywordGenerationRun,
  KeywordExpansionItem,
  KeywordExpansionRequest,
  KeywordExpansionResponse,
  KeywordGenerationRun,
  Lead,
  listSelectableLeads,
  listModelProviders,
  ModelProviderRow,
  updateLead,
} from 'services/zggeo-api';
import styles from './index.module.less';

const DRAFT_STORAGE_KEY = 'zgeo.keyword-expansion.current-result.v1';
const ACTIVE_RUN_STORAGE_KEY = 'zgeo.keyword-expansion.active-run.v1';
const KEYWORD_EXPANSION_UNIT_COST = 5;
const RUN_POLL_INTERVAL_MS = 2000;

interface KeywordExpansionDraft {
  selectedLeadId: string;
  selectedProvider: string;
  selectedLanguage: GenerationLanguage;
  count: number;
  manualBrand: string;
  manualDomain: string;
  result: KeywordExpansionResponse | null;
  savedAt: string;
}

const cleanDomain = (raw?: string | null) =>
  String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();

const leadBrand = (lead?: Lead | null) => String(lead?.brand_name || lead?.company || lead?.name || '').trim();

const uniqueList = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const item = value.trim();
    const marker = item.toLowerCase();
    if (!item || seen.has(marker)) return;
    seen.add(marker);
    result.push(item);
  });
  return result;
};

const isValidGeneratedResult = (value: KeywordExpansionResponse | null): value is KeywordExpansionResponse =>
  Boolean(value && Array.isArray(value.keywords)) &&
  value?.source_status !== 'failed' &&
  !value?.source_error &&
  !value?.model_error;

const suspiciousKeywordBlocks: Record<string, string[]> = {
  geo_ai: ['产业园', '园区', '招商', '办公室出租', '写字楼', '企业孵化基地', '公寓租赁'],
  audio: ['产业园', '园区', '招商中心', '企业孵化基地', 'GEO优化', 'AI可见性', 'AI搜索'],
  industrial_park: ['KTV', '电影院', '影院', '家庭影院', '音响', '音箱', '麦克风', '功放', '卡拉OK'],
  home_furnishing: ['产业园', '园区', '招商中心', '企业孵化基地'],
};

const isSuspiciousKeyword = (keyword: string, vertical?: string) =>
  (suspiciousKeywordBlocks[String(vertical || '')] || []).some((block) => keyword.includes(block));

const keywordTypeLabel = (type?: string) =>
  ({
    brand: '品牌词',
    category: '品类词',
    scenario: '场景词',
    question: '问题词',
    competitor: '竞品词',
  }[String(type || '')] || '待分类');

const keywordTypeTheme = (type?: string): 'default' | 'primary' | 'success' | 'warning' =>
  (({
    brand: 'primary',
    category: 'success',
    scenario: 'success',
    question: 'warning',
    competitor: 'warning',
  }[String(type || '')] as 'default' | 'primary' | 'success' | 'warning') || 'default');

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

const createClientRequestId = () => {
  const randomUUID = typeof crypto !== 'undefined' ? crypto.randomUUID?.bind(crypto) : undefined;
  return randomUUID ? randomUUID() : `keyword-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const Expansion: React.FC = () => {
  const navigate = useNavigate();
  const restoredDraftRef = useRef(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [loadingBilling, setLoadingBilling] = useState(false);
  const [availableCredits, setAvailableCredits] = useState<number | null>(null);
  const [providers, setProviders] = useState<ModelProviderRow[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState<GenerationLanguage>('zh');
  const [generating, setGenerating] = useState(false);
  const [activeRun, setActiveRun] = useState<KeywordGenerationRun | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [count, setCount] = useState(20);
  const [manualBrand, setManualBrand] = useState('');
  const [manualDomain, setManualDomain] = useState('');
  const [result, setResult] = useState<KeywordExpansionResponse | null>(null);
  const draftStorageKey = useMemo(() => scopedStorageKey(DRAFT_STORAGE_KEY), []);
  const activeRunStorageKey = useMemo(() => scopedStorageKey(ACTIVE_RUN_STORAGE_KEY), []);
  const [draft, setDraft, removeDraft] = useLocalStorage<KeywordExpansionDraft | null>(draftStorageKey, null);

  const selectedLead = useMemo(() => leads.find((lead) => lead.id === selectedLeadId) || null, [leads, selectedLeadId]);

  const brandName = manualBrand || leadBrand(selectedLead);
  const domain = cleanDomain(manualDomain || selectedLead?.domain);
  const existingKeywords = selectedLead?.keywords || [];
  const configuredProviders = useMemo(() => providers.filter((provider) => provider.configured), [providers]);
  const estimatedCost = count * KEYWORD_EXPANSION_UNIT_COST;
  const hasInsufficientCredits = availableCredits !== null && availableCredits < estimatedCost;
  const resultGroups = useMemo(() => {
    const visibleItems = (items: KeywordExpansionItem[]) =>
      items.filter((item) => !isSuspiciousKeyword(item.keyword, result?.business_vertical));
    const brandKeywords = visibleItems(result?.brand_keywords || []);
    const nonBrandKeywords = visibleItems(result?.non_brand_keywords || []);
    if (brandKeywords.length || nonBrandKeywords.length) {
      return { brandKeywords, nonBrandKeywords };
    }
    return { brandKeywords: visibleItems(result?.keywords || []), nonBrandKeywords: [] };
  }, [result]);
  const suspiciousKeywords = useMemo(
    () =>
      [
        ...(result?.brand_keywords || []),
        ...(result?.non_brand_keywords || []),
        ...(!(result?.brand_keywords?.length || result?.non_brand_keywords?.length) ? result?.keywords || [] : []),
      ]
        .filter((item) => isSuspiciousKeyword(item.keyword, result?.business_vertical))
        .map((item) => item.keyword),
    [result],
  );
  const resultSourceMeta = useMemo(() => {
    if (!result) return { theme: 'default' as const, label: '' };
    if (result.source_status === 'ok') return { theme: 'success' as const, label: '官网读取：成功' };
    if (result.source_status === 'search_suggest') return { theme: 'primary' as const, label: '全网搜索：已补充' };
    if (result.source_status === 'skipped') return { theme: 'warning' as const, label: '官网未填：已跳过' };
    return { theme: 'warning' as const, label: '官网读取：失败' };
  }, [result]);

  const leadOptions = useMemo(
    () =>
      leads.map((lead) => {
        const brand = leadBrand(lead) || '未命名客户';
        const d = cleanDomain(lead.domain);
        const label = `${brand}${d ? ` · ${d}` : ''}`;
        return {
          label,
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
      if (!selectedLeadId && data.length > 0) {
        const firstWithoutKeywords = data.find((lead) => !(lead.keywords || []).length);
        setSelectedLeadId((firstWithoutKeywords || data[0]).id);
      }
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

  const restoreRunSettings = (run: KeywordGenerationRun) => {
    const payload = (run.payload || {}) as Partial<KeywordExpansionRequest>;
    if (payload.lead_id) setSelectedLeadId(String(payload.lead_id));
    if (payload.provider) setSelectedProvider(String(payload.provider));
    if (payload.language) setSelectedLanguage(payload.language as GenerationLanguage);
    if (payload.count) setCount(Number(payload.count) || 20);
    if (payload.brand_name) setManualBrand(String(payload.brand_name));
    if (payload.domain) setManualDomain(cleanDomain(String(payload.domain)));
  };

  const applyCompletedRun = (run: KeywordGenerationRun) => {
    const runResult = run.result_json as KeywordExpansionResponse | null;
    if (!isValidGeneratedResult(runResult)) return false;
    const payload = (run.payload || {}) as Partial<KeywordExpansionRequest>;
    const nextSelectedLeadId = String(payload.lead_id || run.lead_id || selectedLeadId || '');
    const nextProvider = String(payload.provider || selectedProvider || '');
    const nextLanguage = (payload.language || selectedLanguage || 'zh') as GenerationLanguage;
    const nextCount = Number(payload.count || run.requested_count || count || 20);
    const nextBrand = String(payload.brand_name || run.brand_name || runResult.brand_name || manualBrand || '');
    const nextDomain = cleanDomain(String(payload.domain || run.domain || runResult.domain || manualDomain || ''));
    setSelectedLeadId(nextSelectedLeadId);
    setSelectedProvider(nextProvider);
    setSelectedLanguage(nextLanguage);
    setCount(nextCount);
    setManualBrand(nextBrand);
    setManualDomain(nextDomain);
    setResult(runResult);
    setDraft({
      selectedLeadId: nextSelectedLeadId,
      selectedProvider: nextProvider,
      selectedLanguage: nextLanguage,
      count: nextCount,
      manualBrand: nextBrand,
      manualDomain: nextDomain,
      result: runResult,
      savedAt: run.finished_at || new Date().toISOString(),
    });
    return true;
  };

  useEffect(() => {
    loadLeads();
    loadProviders();
    loadBilling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    const restoreCachedRun = () => {
      const cachedRunId = window.localStorage.getItem(activeRunStorageKey);
      if (!cachedRunId) return;
      getKeywordGenerationRun(cachedRunId)
        .then((run) => {
          if (cancelled) return;
          if (['queued', 'running'].includes(String(run.status || ''))) {
            setActiveRun(run);
            restoreRunSettings(run);
            setGenerating(true);
            return;
          }
          if (String(run.status || '') === 'succeeded' && applyCompletedRun(run)) {
            const runResult = run.result_json as KeywordExpansionResponse | null;
            const charged =
              (runResult?.keywords?.length || Number(run.requested_count || count || 20)) * KEYWORD_EXPANSION_UNIT_COST;
            MessagePlugin.success(`生成成功，已扣除 ${charged.toLocaleString('zh-CN')} 积分`);
          }
          window.localStorage.removeItem(activeRunStorageKey);
        })
        .catch(() => window.localStorage.removeItem(activeRunStorageKey));
    };
    getActiveKeywordGenerationRun()
      .then((run) => {
        if (cancelled) return;
        if (!run) {
          restoreCachedRun();
          return;
        }
        setActiveRun(run);
        restoreRunSettings(run);
        setGenerating(true);
        window.localStorage.setItem(activeRunStorageKey, run.id);
        MessagePlugin.info('已恢复进行中的关键词生成任务');
      })
      .catch(restoreCachedRun);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunStorageKey]);

  useEffect(() => {
    if (!activeRun?.id || !['queued', 'running'].includes(String(activeRun.status || ''))) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await getKeywordGenerationRun(activeRun.id);
        if (stopped) return;
        setActiveRun(next);
        if (['queued', 'running'].includes(String(next.status || ''))) return;
        setGenerating(false);
        setConfirmOpen(false);
        window.localStorage.removeItem(activeRunStorageKey);
        setActiveRun(null);
        if (String(next.status || '') === 'succeeded' && applyCompletedRun(next)) {
          await loadBilling();
          const nextResult = next.result_json as KeywordExpansionResponse | null;
          const charged =
            (nextResult?.keywords?.length || Number(next.requested_count || count || 20)) * KEYWORD_EXPANSION_UNIT_COST;
          MessagePlugin.success(
            `生成成功，已扣除 ${charged.toLocaleString('zh-CN')} 积分，生成 ${
              next.result_json?.keywords?.length || 0
            } 个拓展关键词`,
          );
        } else {
          await loadBilling();
          const insufficient = String(next.error_type || '') === 'insufficient_credits';
          MessagePlugin.error(
            insufficient
              ? `积分不足，未扣除积分：${next.error_detail || '请购买相应的权益和积分包'}`
              : `生成失败，积分已退回：${next.error_detail || next.error_type || '未知错误'}`,
          );
        }
      } catch (err: any) {
        if (!stopped)
          MessagePlugin.error(`生成状态读取失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
      }
    };
    const timer = window.setInterval(poll, RUN_POLL_INTERVAL_MS);
    poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, activeRun?.status, activeRunStorageKey]);

  useEffect(() => {
    if (!draft || restoredDraftRef.current) return;
    restoredDraftRef.current = true;
    setSelectedLeadId(draft.selectedLeadId || '');
    setSelectedProvider(draft.selectedProvider || '');
    setSelectedLanguage(draft.selectedLanguage || 'zh');
    setCount(draft.count || 20);
    setManualBrand(draft.manualBrand || '');
    setManualDomain(draft.manualDomain || '');
    if (isValidGeneratedResult(draft.result)) {
      setResult(draft.result || null);
    } else {
      removeDraft();
      setResult(null);
    }
  }, [draft]);

  useEffect(() => {
    if (!selectedLead) return;
    if (draft?.selectedLeadId === selectedLead.id && result) return;
    setManualBrand(leadBrand(selectedLead));
    setManualDomain(cleanDomain(selectedLead.domain));
  }, [draft?.selectedLeadId, result, selectedLead]);

  const saveDraft = (nextResult: KeywordExpansionResponse | null = result, silent = false) => {
    if (!isValidGeneratedResult(nextResult)) {
      if (!silent) MessagePlugin.warning('当前结果包含官网读取或模型错误，不能暂存');
      return;
    }
    const nextDraft: KeywordExpansionDraft = {
      selectedLeadId,
      selectedProvider,
      selectedLanguage,
      count,
      manualBrand,
      manualDomain,
      result: nextResult,
      savedAt: new Date().toISOString(),
    };
    setDraft(nextDraft);
    if (!silent) MessagePlugin.success('已暂存当前生成结果，刷新或切页后可恢复');
  };

  const clearDraft = () => {
    removeDraft();
    setResult(null);
    MessagePlugin.success('已清空暂存结果');
  };

  const openGenerateConfirm = () => {
    const cleanBrand = brandName.trim();
    if (!cleanBrand) {
      MessagePlugin.warning('请先选择客户，或填写品牌/项目');
      return;
    }
    if (hasInsufficientCredits) {
      MessagePlugin.warning(`当前可用积分不足，本次生成需要 ${estimatedCost} 积分，请购买相应的权益和积分包`);
      return;
    }
    setConfirmOpen(true);
  };

  const handleGenerate = async () => {
    const cleanBrand = brandName.trim();
    const cleanSite = cleanDomain(domain);
    if (!cleanBrand) {
      MessagePlugin.warning('请先选择客户，或填写品牌/项目');
      setConfirmOpen(false);
      return;
    }
    if (hasInsufficientCredits) {
      MessagePlugin.warning(`当前可用积分不足，本次生成需要 ${estimatedCost} 积分，请购买相应的权益和积分包`);
      setConfirmOpen(false);
      return;
    }
    setGenerating(true);
    let runStarted = false;
    try {
      const response = await createKeywordGenerationRun({
        lead_id: selectedLead?.id || undefined,
        brand_name: cleanBrand,
        domain: cleanSite || undefined,
        company: selectedLead?.company,
        existing_keywords: uniqueList([...existingKeywords, ...(result?.keywords || []).map((item) => item.keyword)]),
        competitors: selectedLead?.competitors || [],
        count,
        provider: selectedProvider || undefined,
        language: selectedLanguage,
        client_request_id: createClientRequestId(),
      });
      setActiveRun(response.run);
      window.localStorage.setItem(activeRunStorageKey, response.run_id);
      runStarted = true;
      setConfirmOpen(false);
      if (response.active_existing) {
        MessagePlugin.info('当前已有关键词生成任务进行中，已恢复任务进度');
      } else if (response.reused_existing) {
        MessagePlugin.info('该关键词生成请求已在处理中，已恢复任务进度');
      } else {
        MessagePlugin.success('关键词生成已开始，刷新页面后会自动恢复进度');
      }
    } catch (err: any) {
      setResult(null);
      removeDraft();
      const detail = err?.response?.data?.detail;
      if (detail?.code === 'INSUFFICIENT_CREDITS') {
        setAvailableCredits(Number(detail.available || 0));
        MessagePlugin.error(
          `积分不足：本次生成需要 ${detail.required || estimatedCost} 积分，当前可用 ${
            detail.available || 0
          } 积分，请购买相应的权益和积分包`,
        );
      } else {
        MessagePlugin.error(`生成失败：${getApiErrorMessage(err)}`);
      }
    } finally {
      if (!runStarted) setGenerating(false);
      setConfirmOpen(false);
    }
  };

  const saveKeywords = async (mode: 'append' | 'replace') => {
    if (!selectedLead) {
      MessagePlugin.warning('请先选择要写回的客户资产');
      return;
    }
    if (!isValidGeneratedResult(result)) {
      MessagePlugin.warning('当前结果包含官网读取或模型错误，不能写回客户资产');
      return;
    }
    if (suspiciousKeywords.length > 0) {
      MessagePlugin.warning(`已排除疑似跨行业关键词，不会写回客户资产：${suspiciousKeywords.slice(0, 5).join('、')}`);
    }
    const generated = (result.keywords || [])
      .filter((item) => !isSuspiciousKeyword(item.keyword, result.business_vertical))
      .map((item) => item.keyword);
    if (!generated.length) {
      MessagePlugin.warning('当前结果没有可写回客户资产的关键词');
      return;
    }
    if (result.partial) {
      MessagePlugin.warning('当前结果为部分成功，仅写回已通过过滤的有效关键词。');
    }
    const nextKeywords =
      mode === 'append' ? uniqueList([...(selectedLead.keywords || []), ...generated]) : uniqueList(generated);
    setSaving(true);
    try {
      const updated = await updateLead(selectedLead.id, {
        keywords: nextKeywords,
        action_source: 'keyword_expansion_writeback',
        keyword_writeback_mode: mode,
      });
      setLeads((prev) => prev.map((lead) => (lead.id === selectedLead.id ? { ...lead, ...updated } : lead)));
      MessagePlugin.success(mode === 'append' ? '已追加写回客户资产' : '已覆盖写回客户资产');
    } catch (err: any) {
      MessagePlugin.error(`写回失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setSaving(false);
    }
  };

  const columns: PrimaryTableCol<KeywordExpansionItem>[] = [
    {
      colKey: 'keyword',
      title: '关键词',
      width: 220,
      cell: ({ row }) => (
        <Space size={6}>
          <strong>{row.keyword}</strong>
          {isSuspiciousKeyword(row.keyword, result?.business_vertical) ? (
            <Tag theme='warning' variant='light'>
              疑似异常
            </Tag>
          ) : null}
        </Space>
      ),
    },
    {
      colKey: 'keyword_type',
      title: '类型',
      width: 110,
      cell: ({ row }) => (
        <Tag theme={keywordTypeTheme(row.keyword_type)} variant='light'>
          {keywordTypeLabel(row.keyword_type)}
        </Tag>
      ),
    },
    {
      colKey: 'intent',
      title: '搜索意图',
      width: 180,
      cell: ({ row }) => row.intent || '待确认',
    },
    {
      colKey: 'reason',
      title: '生成理由',
      cell: ({ row }) => row.reason || '由官网内容、品牌信息和已有关键词推导。',
    },
  ];

  const renderKeywordGroup = (title: string, items: KeywordExpansionItem[], theme: 'primary' | 'success') => (
    <div className={styles.keywordGroup}>
      <div className={styles.keywordGroupHeader}>
        <strong>{title}</strong>
        <Tag theme={theme} variant='light'>
          {items.length} 个
        </Tag>
      </div>
      {items.length > 0 ? (
        <Table rowKey='keyword' columns={columns} data={items} pagination={undefined} />
      ) : (
        <div style={{ padding: '20px 0', color: 'var(--td-text-color-secondary)' }}>当前批次暂无{title}</div>
      )}
    </div>
  );

  return (
    <div className={styles.page}>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <div className={styles.hero}>
          <div className={styles.heroContent}>
            <Tag theme='primary' variant='light'>
              目标关键词系统
            </Tag>
            <h2 className={styles.heroTitle}>拓展关键词</h2>
            <div className={styles.heroDesc}>
              当客户录入时没有填写监测关键词，或只填了基础品牌词，这里会读取品牌、官网域名、已有关键词和官网正文，调用已配置模型生成真实用户会搜索的获客关键词。
            </div>
          </div>
          <Button
            className={styles.heroAction}
            variant='outline'
            icon={<RefreshIcon />}
            loading={loadingLeads}
            onClick={loadLeads}
          >
            刷新客户资产
          </Button>
        </div>
      </Card>

      <Card bordered={false} title='生成设置' style={{ marginBottom: 16 }}>
        <Space direction='vertical' style={{ width: '100%' }} size={16}>
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
            onChange={(value) => {
              const nextLeadId = String(value || '');
              setSelectedLeadId(nextLeadId);
              if (nextLeadId !== selectedLeadId) setResult(null);
            }}
          />

          {selectedLead ? (
            <div className={styles.assetPanel}>
              <Space direction='vertical' size={10} style={{ width: '100%' }}>
                <Space className={styles.tagWrap} size={8} breakLine>
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
                <div className={styles.assetHint}>
                  系统会从客户资产自动读取品牌、官网、公司信息和已有关键词参与生成，不需要在这里重复填写品牌和域名。
                </div>
              </Space>
            </div>
          ) : (
            <div className={styles.emptyAssetPanel}>
              请先选择客户资产，系统会自动读取品牌、官网、公司信息和已有关键词。
            </div>
          )}

          <div className={styles.settingsGrid}>
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
              options={[5, 8, 10, 15, 20, 30, 50].map((value) => ({ label: `${value} 个`, value }))}
              onChange={(value) => setCount(Number(value) || 20)}
            />
            <Button
              className={styles.generateButton}
              theme='primary'
              icon={<SearchIcon />}
              loading={generating}
              disabled={hasInsufficientCredits}
              onClick={openGenerateConfirm}
            >
              生成关键词
            </Button>
          </div>

          <div className={styles.metaRow}>
            <Space className={styles.metaTags} size={8} breakLine>
              <Tag theme={hasInsufficientCredits ? 'warning' : 'primary'} variant='light'>
                可用积分：
                {loadingBilling
                  ? '读取中'
                  : availableCredits === null
                  ? '未知'
                  : availableCredits.toLocaleString('zh-CN')}
              </Tag>
              <Tag theme='warning' variant='light'>
                本次生成将消耗 {estimatedCost.toLocaleString('zh-CN')} 积分
              </Tag>
              <Tag theme={selectedProvider ? 'success' : 'warning'} variant='light'>
                当前模型：
                {selectedProvider
                  ? providerOptions.find((option) => option.value === selectedProvider)?.label || selectedProvider
                  : '未选择，将使用后端默认模型'}
              </Tag>
              <Tag variant='light'>已配置模型：{configuredProviders.length}</Tag>
            </Space>
            <Button
              className={styles.refreshModelButton}
              variant='text'
              size='small'
              icon={<RefreshIcon />}
              loading={loadingProviders}
              onClick={loadProviders}
            >
              刷新模型列表
            </Button>
          </div>

          {hasInsufficientCredits ? (
            <Alert
              theme='warning'
              title='积分不足，暂不能生成关键词'
              message={`当前可用积分 ${availableCredits?.toLocaleString(
                'zh-CN',
              )}，本次生成需要 ${estimatedCost.toLocaleString('zh-CN')} 积分。请购买相应的权益和积分包后再生成关键词。`}
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

          {activeRun && ['queued', 'running'].includes(String(activeRun.status || '')) ? (
            <Alert
              theme='info'
              title='关键词生成任务进行中'
              message='当前任务已在后台执行，刷新页面后会自动恢复进度；生成成功后会展示结果并结算积分。'
            />
          ) : null}

          <div>
            <div className={styles.sectionLabel}>当前已有监测关键词</div>
            <Space className={styles.tagWrap} size={6} breakLine>
              {existingKeywords.length > 0 ? (
                existingKeywords.map((item) => (
                  <Tag key={item} variant='light'>
                    {item}
                  </Tag>
                ))
              ) : (
                <Tag theme='warning' variant='light'>
                  未填写，建议先生成
                </Tag>
              )}
            </Space>
          </div>
        </Space>
      </Card>

      <Card
        bordered={false}
        title='生成结果'
        actions={
          isValidGeneratedResult(result) ? (
            <Space className={styles.resultActions}>
              <Button variant='outline' onClick={() => saveDraft()}>
                保存当前结果
              </Button>
              <Button variant='text' onClick={clearDraft}>
                清空暂存
              </Button>
              <Button variant='outline' loading={saving} onClick={() => saveKeywords('append')}>
                追加写回客户资产
              </Button>
              <Button theme='primary' loading={saving} onClick={() => saveKeywords('replace')}>
                覆盖写回客户资产
              </Button>
            </Space>
          ) : null
        }
      >
        {result ? (
          <Space direction='vertical' style={{ width: '100%' }} size={12}>
            <Space className={styles.tagWrap} size={8} breakLine>
              <Tag theme={resultSourceMeta.theme} variant='light'>
                {resultSourceMeta.label}
              </Tag>
              <Tag theme={result.provider === 'local' ? 'warning' : 'primary'} variant='light'>
                模型：{result.provider} / {result.model}
              </Tag>
              {result.homepage_url ? <Tag variant='light'>来源：{result.homepage_url}</Tag> : null}
              {draft?.result ? (
                <Tag theme='success' variant='light'>
                  已暂存：{new Date(draft.savedAt).toLocaleString()}
                </Tag>
              ) : null}
              <Tag theme={result.partial ? 'warning' : 'success'} variant='light'>
                {result.partial ? '部分成功' : '生成成功'}
              </Tag>
              <Tag variant='light'>请求：{result.requested_count ?? count} 个</Tag>
              <Tag variant='light'>实际保留：{result.generated_count ?? result.keywords.length} 个</Tag>
              <Tag variant='light'>已过滤：{result.filtered_count ?? 0} 个</Tag>
              {result.partial ? (
                <Tag theme='warning' variant='light'>
                  未强行补足
                </Tag>
              ) : null}
            </Space>
            {(result.source_error || result.model_error) && (
              <div style={{ color: 'var(--td-warning-color)', fontSize: 12, lineHeight: 1.6 }}>
                {result.source_error ? `官网读取提示：${result.source_error}` : ''}
                {result.model_error ? ` 模型提示：${result.model_error}` : ''}
              </div>
            )}
            {suspiciousKeywords.length > 0 && (
              <Alert
                theme='warning'
                message={`检测到疑似跨行业关键词，请检查官网资料或重新生成：${suspiciousKeywords
                  .slice(0, 8)
                  .join('、')}`}
              />
            )}
            {(result.quality_note || (result.quality_warnings || []).length > 0) && (
              <Alert
                theme={result.partial ? 'warning' : 'success'}
                message={
                  <div style={{ lineHeight: 1.7 }}>
                    <div>{result.quality_note || '已完成关键词质量过滤'}</div>
                    {(result.quality_warnings || []).length > 0 ? (
                      <div style={{ fontSize: 12, marginTop: 4 }}>{(result.quality_warnings || []).join('；')}</div>
                    ) : null}
                  </div>
                }
              />
            )}
            {renderKeywordGroup('品牌关键词', resultGroups.brandKeywords, 'primary')}
            {renderKeywordGroup('非品牌关键词', resultGroups.nonBrandKeywords, 'success')}
          </Space>
        ) : (
          <div style={{ padding: 36, textAlign: 'center', color: 'var(--td-text-color-secondary)' }}>
            选择客户资产，系统会自动读取资产信息；设置模型、语言和数量后点击“生成关键词”。
          </div>
        )}
      </Card>

      <Dialog
        visible={confirmOpen}
        header='确认生成关键词'
        onClose={() => !generating && setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleGenerate}
        closeBtn={!generating}
        closeOnEscKeydown={!generating}
        closeOnOverlayClick={!generating}
        confirmBtn={{
          content: `确认扣除 ${estimatedCost.toLocaleString('zh-CN')} 积分并生成`,
          loading: generating,
        }}
        cancelBtn={{ content: '取消', disabled: generating }}
      >
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <div style={{ color: 'var(--td-text-color-primary)', lineHeight: 1.7 }}>
            本次将为「{brandName || '当前客户资产'}」生成拓展关键词，生成成功后会扣除{' '}
            <strong>{estimatedCost.toLocaleString('zh-CN')} 积分</strong>。
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
              预计生成：{count} 个
            </Tag>
          </Space>
          <div style={{ color: 'var(--td-text-color-secondary)', fontSize: 12, lineHeight: 1.7 }}>
            如果生成失败，系统会释放预占积分；只有生成成功才会正式扣除。
          </div>
        </Space>
      </Dialog>
    </div>
  );
};

export default Expansion;
