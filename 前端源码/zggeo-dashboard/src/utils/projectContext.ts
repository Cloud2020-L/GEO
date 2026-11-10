import { listSelectableLeads, Lead } from 'services/zggeo-api';
import { getScopedStorageItem, removeScopedStorageItem, setScopedStorageItem } from './scopedStorage';

export const BRAND_STORAGE_KEY = 'example.com.v1';
export const ACTIVE_PROJECT_STORAGE_KEY = 'example.com-project.v1';

export interface BrandStorageRecord {
  id?: string;
  source_lead_id?: string;
  name?: string;
  domain?: string;
  keywords?: string[] | string;
  competitors?: string[] | string;
  notes?: string;
}

export interface ProjectContext {
  id: string;
  origin: '品牌池' | '客户资产' | '最近使用';
  project_name: string;
  domain: string;
  description: string;
  keywords: string[];
  competitors: string[];
  urls: string[];
  notes?: string;
  source_lead_id?: string;
}

export const normalizeDomain = (raw: string) =>
  raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();

export const parseList = (raw: string) =>
  raw
    .split(/[\n,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

export const readStringList = (value: unknown) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return parseList(value);
  return [];
};

export const extractDomain = (raw: string) => {
  const urlMatch = raw.match(/https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?:[/?#\s]|$)/i);
  if (urlMatch?.[1]) return normalizeDomain(urlMatch[1]);

  const domainMatch = raw.match(/\b(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  if (domainMatch?.[1]) return normalizeDomain(domainMatch[1]);

  return '';
};

export const extractLabeledList = (raw: string, labels: string[]) => {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`^\\s*(?:${escaped})\\s*[:：]\\s*(.+)$`, 'i');
  const matched = raw
    .split('\n')
    .map((line) => line.match(re)?.[1] || '')
    .filter(Boolean);
  return parseList(matched.join('\n'));
};

export const defaultKeywordsFor = (brandName: string) => {
  const brand = brandName.trim();
  if (!brand) return [];
  return [brand, `${brand} 官网`, `${brand} AI 搜索`, `${brand} GEO`];
};

export const defaultUrlsFor = (domain: string) => {
  const d = normalizeDomain(domain);
  if (!d) return [];
  return [`https://${d}/`, `https://${d}/product`, `https://${d}/cases`, `https://${d}/contact`];
};

export const defaultDescriptionFor = (projectName: string, notes?: string) => {
  const firstNeedLine = String(notes || '')
    .split('\n')
    .map((line) => line.replace(/^客户需求[:：]\s*/, '').trim())
    .find(Boolean);

  if (firstNeedLine && firstNeedLine.length <= 80) return firstNeedLine;
  const name = projectName.trim();
  return name ? `${name} 官网与品牌内容，用于 AI 搜索可见性、GEO 资产生成和客户诊断。` : '';
};

export const readBrandSources = (): ProjectContext[] => {
  try {
    const raw = getScopedStorageItem(BRAND_STORAGE_KEY);
    const rows = raw ? (JSON.parse(raw) as BrandStorageRecord[]) : [];
    if (!Array.isArray(rows)) return [];

    return rows
      .map((brand, index) => {
        const projectName = String(brand.name || '').trim();
        const domain = normalizeDomain(String(brand.domain || ''));
        if (!projectName && !domain) return null;

        const keywords = readStringList(brand.keywords);
        const competitors = readStringList(brand.competitors);
        const notes = String(brand.notes || '').trim();

        return {
          id: `brand:${brand.id || `${domain}:${index}`}`,
          origin: '品牌池' as const,
          project_name: projectName || domain,
          domain,
          description: defaultDescriptionFor(projectName || domain, notes),
          keywords: keywords.length > 0 ? keywords : defaultKeywordsFor(projectName || domain),
          competitors,
          urls: defaultUrlsFor(domain),
          notes,
        };
      })
      .filter(Boolean) as ProjectContext[];
  } catch {
    return [];
  }
};

export const leadToProjectContext = (lead: Lead): ProjectContext | null => {
  const projectName = String(lead.brand_name || lead.company || lead.name || '').trim();
  const needs = String(lead.needs || '').trim();
  const contact = String(lead.contact || '').trim();
  const domain =
    normalizeDomain(String(lead.domain || '')) ||
    extractDomain([lead.company, lead.brand_name, needs, contact].filter(Boolean).join('\n'));

  if (!projectName && !domain) return null;

  const keywords = readStringList(lead.keywords);
  const needsKeywords = extractLabeledList(needs, ['关键词', '监测关键词', '品牌词', 'GEO关键词', 'SEO关键词']);
  const competitors = readStringList(lead.competitors);
  const needsCompetitors = extractLabeledList(needs, ['竞品', '竞争对手', '竞品品牌', '竞品公司']);
  const notes = [
    `来自客户资产：${lead.name || '未留姓名'} / ${contact || '未留联系方式'}`,
    lead.company && `公司名称：${lead.company}`,
    needs && `客户需求：${needs}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    id: `lead:${lead.id}`,
    origin: '客户资产',
    source_lead_id: String(lead.id),
    project_name: projectName || domain,
    domain,
    description: defaultDescriptionFor(projectName || domain, needs || notes),
    keywords:
      keywords.length > 0
        ? keywords
        : needsKeywords.length > 0
        ? needsKeywords
        : defaultKeywordsFor(projectName || domain),
    competitors: competitors.length > 0 ? competitors : needsCompetitors,
    urls: defaultUrlsFor(domain),
    notes,
  };
};

export const mergeProjectSources = (sources: ProjectContext[]) => {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.domain || source.id}::${source.project_name}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const loadProjectSources = async () => {
  let leadSources: ProjectContext[] = [];
  let leads: Lead[] = [];
  try {
    leads = await listSelectableLeads();
    pruneDeletedLeadProjectCache(leads);
    leadSources = leads.map(leadToProjectContext).filter(Boolean) as ProjectContext[];
  } catch {
    leadSources = [];
  }
  const brandSources = readBrandSources();
  return mergeProjectSources([...brandSources, ...leadSources]);
};

export const saveActiveProjectContext = (source: ProjectContext) => {
  try {
    setScopedStorageItem(
      ACTIVE_PROJECT_STORAGE_KEY,
      JSON.stringify({ ...source, id: 'active:latest', origin: '最近使用' }),
    );
  } catch {
    // ignore storage failures
  }
};

export const upsertBrandFromProjectContext = (source: ProjectContext) => {
  try {
    const projectName = String(source.project_name || source.domain || '').trim();
    const domain = normalizeDomain(source.domain || '');
    if (!projectName && !domain) return;

    const raw = getScopedStorageItem(BRAND_STORAGE_KEY);
    const rows = raw ? (JSON.parse(raw) as BrandStorageRecord[]) : [];
    const safeRows = Array.isArray(rows) ? rows : [];
    const now = new Date().toISOString();
    const nextRecord = {
      id: source.id.replace(/[^a-z0-9_-]/gi, '_') || `brand_${Date.now()}`,
      source_lead_id: source.source_lead_id,
      name: projectName || domain,
      domain,
      keywords: source.keywords,
      competitors: source.competitors,
      notes: source.notes,
      created_at: now,
      updated_at: now,
    };

    const existingIndex = safeRows.findIndex((brand) => {
      const brandDomain = normalizeDomain(String(brand.domain || ''));
      const brandName = String(brand.name || '')
        .trim()
        .toLowerCase();
      return (!!domain && brandDomain === domain) || (!!projectName && brandName === projectName.toLowerCase());
    });

    const nextRows =
      existingIndex >= 0
        ? safeRows.map((brand, index) =>
            index === existingIndex
              ? {
                  ...brand,
                  ...nextRecord,
                  id: brand.id || nextRecord.id,
                  created_at: (brand as any).created_at || now,
                }
              : brand,
          )
        : [nextRecord, ...safeRows];

    setScopedStorageItem(BRAND_STORAGE_KEY, JSON.stringify(nextRows));
  } catch {
    // ignore storage failures
  }
};

export const removeDeletedLeadProjectCache = (deletedLeads: Lead[]) => {
  if (deletedLeads.length === 0) return;
  try {
    const deletedKeys = deletedLeads.map((lead) => deletedLeadCacheKey(lead));
    const deletedIds = new Set(deletedLeads.map((lead) => String(lead.id)));

    const raw = getScopedStorageItem(BRAND_STORAGE_KEY);
    const rows = raw ? (JSON.parse(raw) as BrandStorageRecord[]) : [];
    if (Array.isArray(rows)) {
      const nextRows = rows.filter((row) => {
        if (row.source_lead_id && deletedIds.has(String(row.source_lead_id))) return false;
        if (row.id && deletedIds.has(String(row.id).replace(/^lead[_:]/, ''))) return false;
        const rowKey = brandCacheKey(row);
        const isLeadDerived =
          String(row.notes || '').includes('来自客户资产') || String(row.id || '').startsWith('lead_');
        return !(isLeadDerived && deletedKeys.includes(rowKey));
      });
      setScopedStorageItem(BRAND_STORAGE_KEY, JSON.stringify(nextRows));
    }

    const activeRaw = getScopedStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
    if (activeRaw) {
      const active = JSON.parse(activeRaw) as ProjectContext;
      const activeSourceLeadId = String(active.source_lead_id || '').trim();
      const activeLeadId = activeProjectLeadId(active);
      const activeKey = projectCacheKey(active);
      if (
        (activeSourceLeadId && deletedIds.has(activeSourceLeadId)) ||
        (activeLeadId && deletedIds.has(activeLeadId)) ||
        deletedKeys.includes(activeKey)
      ) {
        removeScopedStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
      }
    }
  } catch {
    // ignore cache cleanup failures
  }
};

const pruneDeletedLeadProjectCache = (currentLeads: Lead[]) => {
  try {
    const activeLeadIds = new Set(currentLeads.map((lead) => String(lead.id)));
    const activeKeys = new Set(currentLeads.map(deletedLeadCacheKey));

    const raw = getScopedStorageItem(BRAND_STORAGE_KEY);
    const rows = raw ? (JSON.parse(raw) as BrandStorageRecord[]) : [];
    if (Array.isArray(rows)) {
      const nextRows = rows.filter((row) => {
        if (row.source_lead_id) return activeLeadIds.has(String(row.source_lead_id));
        const rowId = String(row.id || '');
        if (rowId.startsWith('lead_') || rowId.startsWith('lead:')) {
          return activeLeadIds.has(rowId.replace(/^lead[_:]/, ''));
        }
        if (String(row.notes || '').includes('来自客户资产')) {
          return activeKeys.has(brandCacheKey(row));
        }
        return true;
      });
      if (nextRows.length !== rows.length) {
        setScopedStorageItem(BRAND_STORAGE_KEY, JSON.stringify(nextRows));
      }
    }

    const activeRaw = getScopedStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
    if (activeRaw) {
      const active = JSON.parse(activeRaw) as ProjectContext;
      const sourceLeadId = String(active.source_lead_id || '').trim();
      const leadId = activeProjectLeadId(active);
      if ((sourceLeadId && !activeLeadIds.has(sourceLeadId)) || (leadId && !activeLeadIds.has(leadId))) {
        removeScopedStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
      }
    }
  } catch {
    // ignore cache cleanup failures
  }
};

const deletedLeadCacheKey = (lead: Lead) => {
  const projectName = String(lead.brand_name || lead.company || lead.name || '')
    .trim()
    .toLowerCase();
  const domain = normalizeDomain(String(lead.domain || ''));
  return `${domain}::${projectName}`;
};

const brandCacheKey = (brand: BrandStorageRecord) => {
  const projectName = String(brand.name || '')
    .trim()
    .toLowerCase();
  const domain = normalizeDomain(String(brand.domain || ''));
  return `${domain}::${projectName}`;
};

const projectCacheKey = (source: ProjectContext) => {
  const projectName = String(source.project_name || '')
    .trim()
    .toLowerCase();
  const domain = normalizeDomain(String(source.domain || ''));
  return `${domain}::${projectName}`;
};

const activeProjectLeadId = (source: ProjectContext) => {
  const id = String(source.id || '');
  if (!id.startsWith('lead:') && !id.startsWith('lead_')) return '';
  return id.replace(/^lead[_:]/, '');
};

export const getActiveProjectContext = (): ProjectContext | null => {
  try {
    const raw = getScopedStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
    if (!raw) return null;
    const source = JSON.parse(raw) as ProjectContext;
    if (!source?.project_name && !source?.domain) return null;
    return {
      ...source,
      id: 'active:latest',
      origin: '最近使用',
      keywords: readStringList(source.keywords),
      competitors: readStringList(source.competitors),
      urls: readStringList(source.urls).length > 0 ? readStringList(source.urls) : defaultUrlsFor(source.domain),
    };
  } catch {
    return null;
  }
};

export const buildProjectSourceOptions = (sources: ProjectContext[]) =>
  sources.map((source) => ({
    label: `${source.origin} · ${source.project_name || source.domain} · ${source.domain || '缺官网域名'}`,
    value: source.id,
  }));
