import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Dialog,
  Input,
  InputNumber,
  MessagePlugin,
  Select,
  Space,
  Tag,
  Textarea,
} from 'tdesign-react';
import { ChevronDownIcon, FileCopyIcon, RefreshIcon, RocketIcon } from 'tdesign-icons-react';
import {
  analyzeArticlePlatformIntentsDb,
  checkArticleComplianceDb,
  createArticleDraftDb,
  createArticleGenerationRunDb,
  createContentTaskDb,
  getActiveArticleGenerationRunDb,
  getArticleGenerationRunDb,
  getArticleDraftDb,
  getBillingAccount,
  GenerationLanguage,
  ArticlePlatformIntent,
  KeywordPromptItem,
  Lead,
  listArticleDraftsDb,
  listContentTasksDb,
  listImageGroupsDb,
  listManagedImagesDb,
  listKeywordPrompts,
  listSelectableLeads,
  listModelProviders,
  PlatformRewriteTarget,
  rewriteArticleForPlatformDb,
  rewriteViralArticleDb,
  type ArticleComplianceResult,
  type ArticleGenerationRun,
  type ContentImageGroup,
  type ContentImageRow,
  type ModelProviderRow,
} from 'services/zggeo-api';
import { stripMarkdownForPublish } from 'utils/publishText';
import { scopedStorageKey } from 'utils/scopedStorage';
import {
  loadImageBlobUrl,
  loadProtectedImageUrl,
  readFallbackGroups,
  readFallbackImages,
  StoredImageGroup,
  StoredManagedImage,
} from 'utils/contentImageStore';
import Style from '../linear.module.less';

interface ManagedImage {
  id: string;
  group_id?: string;
  lead_id?: string;
  group_name: string;
  name: string;
  alt: string;
  url: string;
  file_url?: string;
  storage?: 'backend' | 'indexeddb';
  indexeddb_key?: string;
  is_local_only?: boolean;
}

interface ImageGroup {
  id: string;
  lead_id?: string;
  lead_name?: string;
  name: string;
  description?: string;
  usage?: string;
  created_at?: string;
  is_local_only?: boolean;
}

const ACTIVE_GENERATION_RUN_KEY = 'example.com.v1';
const MAX_AUTO_SELECTED_IMAGES = 3;
const RUN_POLL_INTERVAL_MS = 2000;
const RUN_POLL_WARNING_FAILURES = 3;
const RUN_POLL_SUSPEND_FAILURES = 5;
const ARTICLE_GENERATION_UNIT_COST = 50;
const LANGUAGE_OPTIONS: { label: string; value: GenerationLanguage }[] = [
  { label: '中文', value: 'zh' },
  { label: '英文', value: 'en' },
  { label: '粤语', value: 'yue' },
];
type GenerateMode = 'basic' | 'official_rewrite' | 'viral_rewrite';
type BasicStyleKey = 'original' | 'seo_article' | 'customer_qa';
type OfficialRewriteStyleKey = 'zhihu_answer' | 'wechat_article' | 'xiaohongshu_note';
type ViralRewriteStyleKey = 'xiaohongshu_viral' | 'wechat_viral' | 'zhihu_hot_answer';
type GenerationStyleKey = BasicStyleKey | OfficialRewriteStyleKey | ViralRewriteStyleKey;
type GenerationStyleOption = {
  label: string;
  value: GenerationStyleKey;
  desc: string;
  promptHint?: string;
  platform?: PlatformRewriteTarget;
};

const normalizeImageGroups = (groups: ImageGroup[]) =>
  groups.map((group) => ({
    ...group,
    id: String(group.id || ''),
    lead_id: group.lead_id ? String(group.lead_id) : undefined,
    name: String(group.name || '未命名图片组').trim(),
    lead_name: String(group.lead_name || '').trim() || undefined,
  }));

const normalizeManagedImages = (items: ManagedImage[], groups: ImageGroup[]) => {
  const groupMap = new Map(groups.map((group) => [String(group.id || ''), group]));
  return items.map((image) => {
    const group = groupMap.get(String(image.group_id || ''));
    const name = String(image.name || '未命名图片').trim();
    return {
      ...image,
      id: String(image.id || ''),
      group_id: String(image.group_id || ''),
      lead_id: image.lead_id ? String(image.lead_id) : group?.lead_id ? String(group.lead_id) : undefined,
      group_name: String(image.group_name || group?.name || '未分组图片').trim(),
      name,
      alt: String(image.alt || name.replace(/\.[^.]+$/, '') || '文章配图').trim(),
      url: String(image.url || '').trim(),
    };
  });
};

const normalizeFileUrl = (url: unknown) => {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('http') || value.startsWith('blob:') || value.startsWith('data:') || value.startsWith('/')) {
    return value;
  }
  return `/api/zggeo${value.startsWith('/') ? value : `/${value}`}`;
};

const mapBackendImageGroup = (group: ContentImageGroup): ImageGroup => ({
  id: String(group.id || ''),
  lead_id: group.lead_id ? String(group.lead_id) : undefined,
  lead_name: String(group.lead_name || '').trim() || undefined,
  name: String(group.name || '未命名图片组').trim(),
  description: String(group.description || '').trim(),
  usage: group.usage || 'article',
  created_at: String(group.created_at || new Date().toISOString()),
});

const mapBackendManagedImage = (image: ContentImageRow): ManagedImage => ({
  id: String(image.id || ''),
  group_id: String(image.group_id || ''),
  lead_id: image.lead_id ? String(image.lead_id) : undefined,
  group_name: String(image.group_name || '未分组图片').trim(),
  name: String(image.name || '未命名图片').trim(),
  alt: String(image.alt || image.name || '文章配图')
    .replace(/\.[^.]+$/, '')
    .trim(),
  url: normalizeFileUrl(image.file_url),
  file_url: normalizeFileUrl(image.file_url),
  storage: 'backend',
});

const mapFallbackImageGroup = (group: StoredImageGroup): ImageGroup => ({
  id: String(group.id || ''),
  lead_id: group.lead_id ? String(group.lead_id) : undefined,
  lead_name: String(group.lead_name || '').trim() || undefined,
  name: String(group.name || '未命名图片组').trim(),
  description: String(group.description || '').trim(),
  usage: group.usage || 'article',
  created_at: String(group.created_at || new Date().toISOString()),
  is_local_only: true,
});

const GENERATE_MODE_OPTIONS: Array<{ label: string; value: GenerateMode; desc: string }> = [
  { label: '基础生成', value: 'basic', desc: '使用客户资产、Prompt库存、图片素材生成官网文章' },
  { label: '官网改写', value: 'official_rewrite', desc: '读取官网文章 URL，改写成知乎/小红书/公众号等平台内容' },
  { label: '爆款改写', value: 'viral_rewrite', desc: '输入爆文 URL 或粘贴正文，拆解结构后生成平台仿写稿' },
];
const PLATFORM_OPTIONS: Array<{ label: string; value: PlatformRewriteTarget; desc: string }> = [
  { label: '知乎', value: 'zhihu', desc: '问题回答、判断标准、轻量提及品牌' },
  { label: '小红书', value: 'xiaohongshu', desc: '种草笔记、图片顺序、话题标签' },
  { label: '公众号', value: 'wechat', desc: '长图文、完整结构、私域沉淀' },
  { label: '朋友圈', value: 'moments', desc: '短文案、互动引导、熟人转化' },
  { label: '短视频', value: 'video', desc: '口播脚本、分镜、字幕和画面建议' },
];
const BASIC_STYLE_OPTIONS: Array<{ label: string; value: BasicStyleKey; desc: string; promptHint?: string }> = [
  { label: '原始生成', value: 'original', desc: '不额外限定文章风格，沿用当前 Prompt 和系统默认结构。' },
  {
    label: '通用 SEO 文章',
    value: 'seo_article',
    desc: '更适合官网收录、AI 摘要和长尾搜索，强调标题层级、事实锚点和问题覆盖。',
    promptHint: '按通用 SEO 文章组织：标题覆盖检索意图，正文包含事实锚点、判断清单、FAQ 和行动路径；避免平台化表达。',
  },
  {
    label: '客户问答型',
    value: 'customer_qa',
    desc: '围绕客户可能问 AI 的问题回答，适合后续可见度监测和 Prompt 命中。',
    promptHint: '按客户问答型组织：首段直接回答问题，随后说明适合谁、怎么判断、注意事项和下一步行动；FAQ 可按需生成。',
  },
];
const OFFICIAL_REWRITE_STYLE_OPTIONS: Array<{
  label: string;
  value: OfficialRewriteStyleKey;
  platform: PlatformRewriteTarget;
  desc: string;
  promptHint: string;
}> = [
  {
    label: '知乎',
    value: 'zhihu_answer',
    platform: 'zhihu',
    desc: '问题回答、判断标准、轻量提及品牌。',
    promptHint: '改写成知乎回答：先给结论，用判断标准、事实依据和适合人群展开，轻量提及品牌，避免硬广。',
  },
  {
    label: '公众号',
    value: 'wechat_article',
    platform: 'wechat',
    desc: '正式介绍、结构清晰、品牌背书。',
    promptHint: '改写成公众号长图文：结构完整、语气正式可信，保留事实、服务边界和行动引导。',
  },
  {
    label: '小红书',
    value: 'xiaohongshu_note',
    platform: 'xiaohongshu',
    desc: '轻口语、场景化、种草表达。',
    promptHint: '改写成小红书笔记：场景感强、短句分段、表达轻口语，适度加入话题标签和图片占位。',
  },
];
const VIRAL_STYLE_OPTIONS: Array<{ label: string; value: ViralRewriteStyleKey; desc: string; promptHint: string }> = [
  {
    label: '小红书爆款',
    value: 'xiaohongshu_viral',
    desc: '标题钩子、痛点场景、短句种草和互动标签。',
    promptHint: '按小红书爆款结构仿写：标题有钩子，开头直戳痛点，短句分段，场景化种草，结尾给收藏/评论/行动引导。',
  },
  {
    label: '公众号爆款',
    value: 'wechat_viral',
    desc: '强主题、故事化导入、层层递进和转化 CTA。',
    promptHint: '按公众号爆款结构仿写：主题集中，开头用冲突/故事/反常识引入，中段逐层推进，结尾给行动建议和私域转化。',
  },
  {
    label: '知乎高赞回答',
    value: 'zhihu_hot_answer',
    desc: '反常识结论、判断框架、长回答结构。',
    promptHint: '按知乎高赞回答结构仿写：先给反常识结论，再给判断框架、真实场景、可执行清单，语气克制可信。',
  },
];
const DEFAULT_STYLE_BY_MODE: Record<GenerateMode, GenerationStyleKey> = {
  basic: 'original',
  official_rewrite: 'zhihu_answer',
  viral_rewrite: 'xiaohongshu_viral',
};
const getGenerationStyleOptions = (mode: GenerateMode): GenerationStyleOption[] => {
  if (mode === 'official_rewrite') return OFFICIAL_REWRITE_STYLE_OPTIONS;
  if (mode === 'viral_rewrite') return VIRAL_STYLE_OPTIONS;
  return BASIC_STYLE_OPTIONS;
};
const getGenerationStyleOption = (mode: GenerateMode, value: GenerationStyleKey) =>
  getGenerationStyleOptions(mode).find((item) => item.value === value) || getGenerationStyleOptions(mode)[0];

const readLeadList = (value: unknown) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(/[\n,，、]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
};

const createClientRequestId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `article-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const formatElapsed = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const stageLabel = (stage?: string) => {
  const labels: Record<string, string> = {
    queued: '排队中',
    preparing: '准备生成',
    preparing_assets: '准备客户资料',
    reserving_credits: '预占点数',
    calling_model: '正在调用模型',
    inserting_db: '正在写入文章库',
    compliance_check: '正在合规检测',
    completed: '已完成',
    failed: '生成失败',
  };
  return labels[String(stage || '')] || '生成中';
};

const isActiveGenerationRun = (run?: ArticleGenerationRun | null) =>
  Boolean(run && ['queued', 'running'].includes(String(run.status || '')));

const formatLeadLabel = (lead: Lead) => {
  const company = String(lead.company || '').trim();
  const brand = String(lead.brand_name || '').trim();
  const domain = String(lead.domain || '').trim();
  const name = String(lead.name || '').trim();
  const contact = String(lead.contact || '').trim();
  return `${brand || company || name || '未命名客户'}${domain ? ` · ${domain}` : ''}${contact ? ` · ${contact}` : ''}`;
};

const buildCompanyInfoFromLead = (lead: Lead) => {
  const keywords = readLeadList(lead.keywords);
  const competitors = readLeadList(lead.competitors);
  return [
    `客户名称：${lead.company || lead.brand_name || lead.name || '未填写'}`,
    lead.brand_name && `品牌名称：${lead.brand_name}`,
    lead.domain && `官网域名：${lead.domain}`,
    lead.name && `联系人：${lead.name}`,
    lead.contact && `联系方式：${lead.contact}`,
    keywords.length > 0 && `关键词：${keywords.join('、')}`,
    competitors.length > 0 && `竞品：${competitors.join('、')}`,
    lead.needs && `客户需求：${lead.needs}`,
    '写作约束：只能基于以上留资信息、官网信息、品牌知识库和用户选择的高频问题写作；不要编造案例、数据、奖项和客户名称。',
  ]
    .filter(Boolean)
    .join('\n');
};

const Metric: React.FC<{ title: string; value: number; color?: string }> = ({ title, value, color }) => (
  <Card bordered={false} className={Style.statCard}>
    <div className={Style.statLabel}>{title}</div>
    <div className={Style.statValue} style={color ? { color } : undefined}>
      {value}
    </div>
  </Card>
);

const formatTime = (value: unknown) => {
  if (!value) return '未记录';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
};

const platformLabel = (platform: PlatformRewriteTarget) =>
  PLATFORM_OPTIONS.find((item) => item.value === platform)?.label || platform;

const articleTitleFromBody = (body: string, fallback = '官网改写稿') => {
  const line =
    String(body || '')
      .split('\n')
      .map((item) => item.trim())
      .find(Boolean) || fallback;
  return (
    line
      .replace(/^#{1,6}\s*/, '')
      .replace(/[*_`]+/g, '')
      .slice(0, 90) || fallback
  );
};

const normalizeText = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase();

const readTaskOutline = (task: Record<string, any>) => {
  const { outline } = task;
  if (Array.isArray(outline)) return outline.map((item) => String(item || '')).join('\n');
  if (typeof outline === 'string') return outline;
  return '';
};

const textIncludes = (source: unknown, target: unknown) => {
  const a = normalizeText(source);
  const b = normalizeText(target);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
};

const getDeepSeekProviderKey = (providers: ModelProviderRow[]) => {
  const configured = providers.filter((provider) => provider.configured && provider.status === 'configured');
  const match = configured.find((provider) =>
    [provider.key, provider.name, provider.vendor, provider.model]
      .map((item) => normalizeText(item))
      .some((item) => item.includes('deepseek')),
  );
  return match?.key || configured[0]?.key || '';
};

const draftStatusTheme = (status: unknown) => {
  const text = String(status || '');
  if (text.includes('发布')) return 'success' as const;
  if (text.includes('失败')) return 'danger' as const;
  return 'warning' as const;
};

const articleTypeTheme = (type: unknown) => {
  const text = String(type || '');
  if (text.includes('产品') || text.includes('服务')) return 'success' as const;
  if (text.includes('观点') || text.includes('框架')) return 'primary' as const;
  if (text.includes('白皮书') || text.includes('深度')) return 'warning' as const;
  if (text.includes('案例')) return 'default' as const;
  return 'primary' as const;
};

const complianceTheme = (status: unknown) => {
  const text = String(status || '');
  if (text === 'pass') return 'success' as const;
  if (text === 'blocked') return 'danger' as const;
  if (text === 'warning') return 'warning' as const;
  return 'default' as const;
};

const complianceLabel = (status: unknown) => {
  const text = String(status || '');
  if (text === 'pass') return '审核通过';
  if (text === 'blocked') return '阻止分发';
  if (text === 'warning') return '需处理';
  return '未审核';
};

const complianceFromDraft = (row?: Record<string, any> | null): ArticleComplianceResult | null => {
  if (!row) return null;
  if (row.compliance && typeof row.compliance === 'object') return row.compliance as ArticleComplianceResult;
  const status = String(row.compliance_status || '').trim();
  if (!status || status === 'not_checked') return null;
  return {
    platform: String(row.compliance_platform || ''),
    status: status as ArticleComplianceResult['status'],
    summary: String(row.compliance_summary || ''),
    ai_disclosure_required: Boolean(row.ai_disclosure_required),
    source_required: Boolean(row.source_required),
    fiction_disclosure_required: Boolean(row.fiction_disclosure_required),
    human_review_required: Boolean(row.human_review_required),
    issues: Array.isArray(row.compliance_issues) ? row.compliance_issues : [],
  };
};

const resolveArticleImageUrl = (url: string, imageLibrary: ManagedImage[] = []) => {
  const value = String(url || '').trim();
  if (!value.startsWith('zggeo-image://')) return value;
  const imageId = value.replace('zggeo-image://', '');
  return imageLibrary.find((image) => image.id === imageId)?.url || '';
};

const normalizeImageLabel = (value: unknown) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const findImageByLabel = (label: string, imageLibrary: ManagedImage[] = []) => {
  const normalized = normalizeImageLabel(label);
  if (!normalized) return undefined;
  return imageLibrary.find((image) =>
    [image.alt, image.name].some((value) => normalizeImageLabel(value) === normalized),
  );
};

const renderTextMarks = (text: string, keyPrefix: string) => {
  const nodes: React.ReactNode[] = [];
  const strongRe = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match = strongRe.exec(text);
  while (match) {
    if (match.index > lastIndex)
      nodes.push(<span key={`${keyPrefix}-txt-${lastIndex}`}>{text.slice(lastIndex, match.index)}</span>);
    nodes.push(<strong key={`${keyPrefix}-strong-${match.index}`}>{match[1]}</strong>);
    lastIndex = match.index + match[0].length;
    match = strongRe.exec(text);
  }
  if (lastIndex < text.length) nodes.push(<span key={`${keyPrefix}-txt-last`}>{text.slice(lastIndex)}</span>);
  return nodes;
};

const renderInline = (text: string, keyPrefix: string, imageLibrary: ManagedImage[] = []) => {
  const nodes: React.ReactNode[] = [];
  const imageRe = /!\[([^\]]*)\]\(([^)]+)\)|\[图片：([^\]]+)\]/g;
  let lastIndex = 0;
  let match = imageRe.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      nodes.push(...renderTextMarks(text.slice(lastIndex, match.index), `${keyPrefix}-txt-${lastIndex}`));
    }
    const placeholderImage = match[3] ? findImageByLabel(match[3], imageLibrary) : undefined;
    const imageUrl = match[2] ? resolveArticleImageUrl(match[2], imageLibrary) : placeholderImage?.url || '';
    const imageAlt = match[1] || match[3] || placeholderImage?.alt || '文章配图';
    nodes.push(
      imageUrl ? (
        <img
          key={`${keyPrefix}-img-${match.index}`}
          className={Style.finalArticleImage}
          src={imageUrl}
          alt={imageAlt}
        />
      ) : null,
    );
    lastIndex = match.index + match[0].length;
    match = imageRe.exec(text);
  }
  if (lastIndex < text.length) nodes.push(...renderTextMarks(text.slice(lastIndex), `${keyPrefix}-txt-last`));
  return nodes;
};

const extractMarkdownImages = (body: string, imageLibrary: ManagedImage[] = []) => {
  const images: Array<{ alt: string; url: string }> = [];
  const imageRe = /!\[([^\]]*)\]\(([^)]+)\)|\[图片：([^\]]+)\]/g;
  let match = imageRe.exec(body);
  while (match) {
    const placeholderImage = match[3] ? findImageByLabel(match[3], imageLibrary) : undefined;
    const url = match[2] ? resolveArticleImageUrl(match[2], imageLibrary) : placeholderImage?.url || '';
    if (url) images.push({ alt: match[1] || match[3] || placeholderImage?.alt || '文章配图', url });
    match = imageRe.exec(body);
  }
  return images;
};

const extractMarkdownImageTokens = (body: string, imageLibrary: ManagedImage[] = []) => {
  const tokens: Array<{ markdown: string; alt: string; url: string; resolvedUrl: string }> = [];
  const imageRe = /!\[([^\]]*)\]\(([^)]+)\)|\[图片：([^\]]+)\]/g;
  let match = imageRe.exec(String(body || ''));
  while (match) {
    const placeholderImage = match[3] ? findImageByLabel(match[3], imageLibrary) : undefined;
    const alt = match[1] || match[3] || placeholderImage?.alt || '文章配图';
    const url = match[2] || (placeholderImage ? `zggeo-image://${placeholderImage.id}` : '');
    tokens.push({
      markdown: url ? `![${alt}](${url})` : match[0],
      alt,
      url,
      resolvedUrl: url ? resolveArticleImageUrl(url, imageLibrary) : '',
    });
    match = imageRe.exec(String(body || ''));
  }
  return tokens;
};

const stripPlatformPack = (body: string) => {
  const text = String(body || '');
  const match = text.match(
    /(?:^|\n|\s)(公众号摘要|公众号版|知乎回答版|知乎版|小红书图文版|小红书版|短视频口播提纲|短视频版|Platform Publishing|WeChat Summary|Zhihu Answer|Xiaohongshu|Short Video)\s*[>：:]/i,
  );
  return match?.index !== undefined ? text.slice(0, match.index).trim() : text.trim();
};

const normalizeArticleMarkdownLayout = (body: string) => {
  const text = stripPlatformPack(body)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\*\*([^*\n]+?)\s+([：:])\s*\*\*/g, '**$1$2**')
    .replace(/\*\*([^*\n]+?)\s+\*\*/g, '**$1**')
    .replace(/\*\*(?:直接回答|答案)\s*[：:]\s*\*\*\s*/g, '')
    .replace(/(^|\n)\s*(?:直接回答|答案)\s*[：:]\s*/g, '$1')
    .replace(/\s*\|\|\s*/g, ' |\n| ')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\s*[>＞]\s*(?=\*\*?[\w\u4e00-\u9fff])/g, '\n- ')
    .replace(/\s+[—–-]\s+(?=\*\*?[\w\u4e00-\u9fff][^。\n]{0,28}[：:])/g, '\n- ')
    .replace(/\s+[—–-]\s+(?=\*\*?[\w\u4e00-\u9fff][^。\n]{0,36}(?:[：:]|\*\*[：:]))/g, '\n- ')
    .replace(/\s+---\s+(?=#{1,6}\s)/g, '\n\n')
    .replace(/(?<!^)(?<!\n)\s+(#{1,6}\s+)/g, '\n\n$1')
    .replace(/(?<!\n)\s+(\d+\.\s+\*\*)/g, '\n\n$1')
    .replace(/(?<!\n)\s+([-*]\s+\*\*)/g, '\n$1')
    .replace(/(?<!\n)\s+([-*]\s+[A-Z][^.\n]{0,80}:\s)/g, '\n$1')
    .replace(/(?<!\n)\s+(\|[^\n]+\|\s*)/g, '\n$1')
    .replace(/\s+(\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?)/g, '\n$1');
  return text
    .split('\n')
    .flatMap((line) => {
      const heading = line.match(/^(#{2,3}\s+)(.+)$/);
      if (heading) {
        const marker = heading[1];
        const text = heading[2].trim();
        const splitMatch = text.match(/^(.{6,64}?[？?。！!])\s+(.{8,})$/);
        if (splitMatch) return [`${marker}${splitMatch[1].trim()}`, '', splitMatch[2].trim()];
      }
      if (/^##\s+/.test(line) && line.length > 90) {
        const splitAt = [' — ', ' – ', ' - ', '—', '–', '－', '：', ':']
          .map((token) => ({ token, index: line.indexOf(token) }))
          .filter((item) => item.index > 8)
          .sort((a, b) => a.index - b.index)[0];
        if (splitAt) {
          return [line.slice(0, splitAt.index).trimEnd(), '', line.slice(splitAt.index + splitAt.token.length).trim()];
        }
      }
      if (/^#{2,3}\s+/.test(line) && /\s\|\s/.test(line)) {
        const firstPipe = line.indexOf('|');
        if (firstPipe > 8) return [line.slice(0, firstPipe).trimEnd(), '', `|${line.slice(firstPipe + 1).trimStart()}`];
      }
      if (/^#\s+/.test(line) && line.length > 140) {
        const match = line.match(
          /\s+(If you(?:'re| are)?|When users?|For users?|This article|本文|如果你|用戶|用户)\b/,
        );
        if (match?.index && match.index > 40) {
          return [line.slice(0, match.index).trimEnd(), '', line.slice(match.index).trim()];
        }
      }
      return [line];
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const renderMarkdownProduct = (body: string, imageLibrary: ManagedImage[] = []) => {
  if (!body.trim()) return <div className={Style.emptyState}>生成完成后，这里会显示可直接查看的成品文章。</div>;
  const normalizedBody = normalizeArticleMarkdownLayout(body);
  let title = '成品文章预览';
  const content = normalizedBody.replace(/^\s*#\s+(.+?)\s*$/m, (_, value) => {
    title = String(value || title)
      .replace(/[*_`#]+/g, '')
      .trim();
    return '';
  });
  const blocks = content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return (
    <article className={Style.articlePage}>
      <header className={Style.articleHeader}>
        <Tag theme='primary' variant='light'>
          成品预览
        </Tag>
        <h1>{title}</h1>
      </header>
      <div className={Style.articleBody}>
        {blocks.map((block, index) => {
          const key = `block-${index}`;
          const lines = block
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

          const renderLineGroup = (targetLines: string[], groupKey: string) => {
            if (!targetLines.length) return null;
            const firstBulletIndex = targetLines.findIndex((line) => /^[-*]\s+/.test(line));
            if (firstBulletIndex > 0 && targetLines.slice(firstBulletIndex).every((line) => /^[-*]\s+/.test(line))) {
              return (
                <React.Fragment key={groupKey}>
                  <p>
                    {renderInline(targetLines.slice(0, firstBulletIndex).join(' '), `${groupKey}-intro`, imageLibrary)}
                  </p>
                  <ul>
                    {targetLines.slice(firstBulletIndex).map((line, lineIndex) => (
                      <li key={`${groupKey}-li-${lineIndex}`}>
                        {renderInline(line.replace(/^[-*]\s+/, ''), `${groupKey}-${lineIndex}`, imageLibrary)}
                      </li>
                    ))}
                  </ul>
                </React.Fragment>
              );
            }
            if (targetLines.every((line) => /^[-*]\s+/.test(line))) {
              return (
                <ul key={groupKey}>
                  {targetLines.map((line, lineIndex) => (
                    <li key={`${groupKey}-li-${lineIndex}`}>
                      {renderInline(line.replace(/^[-*]\s+/, ''), `${groupKey}-${lineIndex}`, imageLibrary)}
                    </li>
                  ))}
                </ul>
              );
            }
            if (targetLines.every((line) => /^\d+\.\s+/.test(line))) {
              return (
                <ol key={groupKey}>
                  {targetLines.map((line, lineIndex) => (
                    <li key={`${groupKey}-li-${lineIndex}`}>
                      {renderInline(line.replace(/^\d+\.\s+/, ''), `${groupKey}-${lineIndex}`, imageLibrary)}
                    </li>
                  ))}
                </ol>
              );
            }
            if (targetLines.length >= 2 && targetLines.every((line) => /^\|.*\|$/.test(line))) {
              const rows = targetLines
                .filter((line) => !/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|$/.test(line))
                .map((line) =>
                  line
                    .replace(/^\||\|$/g, '')
                    .split('|')
                    .map((cell) => cell.trim()),
                );
              const [head, ...bodyRows] = rows;
              return (
                <div key={groupKey} className={Style.articleTableWrap}>
                  <table className={Style.articleTable}>
                    <thead>
                      <tr>
                        {head.map((cell, cellIndex) => (
                          <th key={`${groupKey}-th-${cellIndex}`}>
                            {renderInline(cell, `${groupKey}-th-${cellIndex}`, imageLibrary)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {bodyRows.map((row, rowIndex) => (
                        <tr key={`${groupKey}-tr-${rowIndex}`}>
                          {row.map((cell, cellIndex) => (
                            <td key={`${groupKey}-td-${rowIndex}-${cellIndex}`}>
                              {renderInline(cell, `${groupKey}-td-${rowIndex}-${cellIndex}`, imageLibrary)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            }
            return (
              <React.Fragment key={groupKey}>
                {targetLines.map((line, lineIndex) => (
                  <p key={`${groupKey}-p-${lineIndex}`}>
                    {renderInline(line, `${groupKey}-${lineIndex}`, imageLibrary)}
                  </p>
                ))}
              </React.Fragment>
            );
          };

          const headingLine = lines[0] || '';
          const restLines = lines.slice(1);
          if (/^###\s+/.test(headingLine)) {
            return (
              <React.Fragment key={key}>
                <h3>{renderInline(headingLine.replace(/^###\s+/, ''), `${key}-heading`, imageLibrary)}</h3>
                {renderLineGroup(restLines, `${key}-rest`)}
              </React.Fragment>
            );
          }
          if (/^##\s+/.test(headingLine)) {
            return (
              <React.Fragment key={key}>
                <h2>{renderInline(headingLine.replace(/^##\s+/, ''), `${key}-heading`, imageLibrary)}</h2>
                {renderLineGroup(restLines, `${key}-rest`)}
              </React.Fragment>
            );
          }
          if (/^#\s+/.test(headingLine)) {
            return (
              <React.Fragment key={key}>
                <h1>{renderInline(headingLine.replace(/^#\s+/, ''), `${key}-heading`, imageLibrary)}</h1>
                {renderLineGroup(restLines, `${key}-rest`)}
              </React.Fragment>
            );
          }
          return renderLineGroup(lines, key);
        })}
      </div>
    </article>
  );
};

const Generate: React.FC = () => {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Record<string, any>[]>([]);
  const [drafts, setDrafts] = useState<Record<string, any>[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [providers, setProviders] = useState<ModelProviderRow[]>([]);
  const [prompts, setPrompts] = useState<KeywordPromptItem[]>([]);
  const activeRunStorageKey = useMemo(() => scopedStorageKey(ACTIVE_GENERATION_RUN_KEY), []);
  const [imageGroups, setImageGroups] = useState<ImageGroup[]>([]);
  const [images, setImages] = useState<ManagedImage[]>([]);
  const [imageMaterialLoading, setImageMaterialLoading] = useState(false);
  const [usingLocalImageFallback, setUsingLocalImageFallback] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState<GenerationLanguage>('zh');
  const [generateCount, setGenerateCount] = useState(1);
  const [generateMode, setGenerateMode] = useState<GenerateMode>('basic');
  const [generationStyle, setGenerationStyle] = useState<GenerationStyleKey>(DEFAULT_STYLE_BY_MODE.basic);
  const [rewriteSourceUrl, setRewriteSourceUrl] = useState('');
  const [rewritePlatform, setRewritePlatform] = useState<PlatformRewriteTarget>('zhihu');
  const [rewriteUserAngle, setRewriteUserAngle] = useState('');
  const [viralSourceUrl, setViralSourceUrl] = useState('');
  const [viralSourceText, setViralSourceText] = useState('');
  const [viralUserAngle, setViralUserAngle] = useState('');
  const [rewriteIntents, setRewriteIntents] = useState<ArticlePlatformIntent[]>([]);
  const [selectedRewriteIntentIds, setSelectedRewriteIntentIds] = useState<string[]>([]);
  const [intentAnalyzing, setIntentAnalyzing] = useState(false);
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [selectedImageGroupId, setSelectedImageGroupId] = useState('');
  const [activeDraftId, setActiveDraftId] = useState('');
  const [companyInfo, setCompanyInfo] = useState('');
  const [draft, setDraft] = useState('');
  const [complianceResult, setComplianceResult] = useState<ArticleComplianceResult | null>(null);
  const [humanReviewed, setHumanReviewed] = useState(false);
  const [complianceChecking, setComplianceChecking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [loadingBilling, setLoadingBilling] = useState(false);
  const [availableCredits, setAvailableCredits] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [activeRun, setActiveRun] = useState<ArticleGenerationRun | null>(null);
  const [pollSuspendedRunId, setPollSuspendedRunId] = useState('');
  const pollFailureCountRef = useRef(0);
  const [elapsedTick, setElapsedTick] = useState(0);
  const [dataLoading, setDataLoading] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [draftListExpanded, setDraftListExpanded] = useState(false);
  const [promptManuallySelected, setPromptManuallySelected] = useState(false);
  const [imagesManuallySelected, setImagesManuallySelected] = useState(false);
  const [providerManuallySelected, setProviderManuallySelected] = useState(false);
  const activeRunPollingSuspended = Boolean(activeRun?.id && pollSuspendedRunId === activeRun.id);
  const generationLocked = loading || (isActiveGenerationRun(activeRun) && !activeRunPollingSuspended);
  const activeRunElapsed = useMemo(() => {
    if (!activeRun?.started_at) return elapsedTick;
    return Math.max(0, Math.floor((Date.now() - new Date(activeRun.started_at).getTime()) / 1000));
  }, [activeRun?.started_at, elapsedTick]);
  const localLoadingElapsed = loadingStartedAt ? Math.max(0, Math.floor((Date.now() - loadingStartedAt) / 1000)) : 0;
  const normalizedGenerateCount = Math.max(1, Math.min(10, Math.round(Number(generateCount) || 1)));
  const articleGenerationCost = ARTICLE_GENERATION_UNIT_COST * (generateMode === 'basic' ? normalizedGenerateCount : 1);
  const hasInsufficientCredits = availableCredits !== null && availableCredits < articleGenerationCost;

  const selectedStyle = useMemo(
    () => getGenerationStyleOption(generateMode, generationStyle),
    [generateMode, generationStyle],
  );
  const styleOptions = useMemo(
    () =>
      getGenerationStyleOptions(generateMode).map((item) => ({
        label: `${item.label} · ${item.desc}`,
        value: item.value,
      })),
    [generateMode],
  );

  const switchGenerateMode = (mode: GenerateMode) => {
    if (generationLocked) return;
    setGenerateMode(mode);
    const nextStyle = DEFAULT_STYLE_BY_MODE[mode];
    setGenerationStyle(nextStyle);
    const rewriteStyle = OFFICIAL_REWRITE_STYLE_OPTIONS.find((item) => item.value === nextStyle);
    if (rewriteStyle) setRewritePlatform(rewriteStyle.platform);
    if (mode === 'viral_rewrite') setRewritePlatform('xiaohongshu');
  };

  const changeGenerationStyle = (value: unknown) => {
    const nextStyle = (String(value || '') || DEFAULT_STYLE_BY_MODE[generateMode]) as GenerationStyleKey;
    setGenerationStyle(nextStyle);
    const rewriteStyle = OFFICIAL_REWRITE_STYLE_OPTIONS.find((item) => item.value === nextStyle);
    if (rewriteStyle) setRewritePlatform(rewriteStyle.platform);
    if (nextStyle === 'xiaohongshu_viral') setRewritePlatform('xiaohongshu');
    if (nextStyle === 'wechat_viral') setRewritePlatform('wechat');
    if (nextStyle === 'zhihu_hot_answer') setRewritePlatform('zhihu');
  };

  const taskBelongsToLead = (task: Record<string, any>, lead?: Lead | null) => {
    if (!lead) return true;
    const brand = String(lead.brand_name || lead.company || lead.name || '').trim();
    const domain = String(lead.domain || '').trim();
    return (
      (brand && textIncludes(task.brand, brand)) || (domain && textIncludes(task.domain, domain)) || (!brand && !domain)
    );
  };

  const taskMatchesPrompt = (task: Record<string, any>, prompt: KeywordPromptItem, lead?: Lead | null) => {
    if (String(task.source_prompt_id || '') === String(prompt.id || '')) return true;
    if (!taskBelongsToLead(task, lead)) return false;
    const promptText = String(prompt.prompt || '').trim();
    const keyword = String(prompt.keyword || '').trim();
    return (
      textIncludes(task.title, promptText) ||
      textIncludes(readTaskOutline(task), promptText) ||
      textIncludes(task.keyword, keyword) ||
      textIncludes(task.title, keyword)
    );
  };
  const taskMatchesPromptExactly = (task: Record<string, any> | undefined, prompt: KeywordPromptItem | undefined) =>
    Boolean(task && prompt && String(task.source_prompt_id || '') === String(prompt.id || ''));

  const groupBelongsToLead = (group: ImageGroup, lead?: Lead | null) => {
    if (!lead) return true;
    const leadId = String(lead.id || '');
    if (group.lead_id) return String(group.lead_id) === leadId;
    const brand = String(lead.brand_name || lead.company || lead.name || '').trim();
    const domain = String(lead.domain || '').trim();
    return (
      (brand && (textIncludes(group.name, brand) || textIncludes(group.lead_name, brand))) ||
      (domain && (textIncludes(group.name, domain) || textIncludes(group.description, domain)))
    );
  };

  const imageBelongsToLead = (image: ManagedImage, lead?: Lead | null) => {
    if (!lead) return true;
    const leadId = String(lead.id || '');
    if (image.lead_id) return String(image.lead_id) === leadId;
    const group = imageGroups.find((item) => item.id === image.group_id);
    if (group) return groupBelongsToLead(group, lead);
    const brand = String(lead.brand_name || lead.company || lead.name || '').trim();
    const domain = String(lead.domain || '').trim();
    return (
      (brand &&
        (textIncludes(image.group_name, brand) || textIncludes(image.name, brand) || textIncludes(image.alt, brand))) ||
      (domain && (textIncludes(image.group_name, domain) || textIncludes(image.name, domain)))
    );
  };

  const getImagesForLeadAndGroup = (groupId: string, lead?: Lead | null) => {
    if (groupId) return images.filter((image) => String(image.group_id || '') === groupId);
    if (lead) return images.filter((image) => imageBelongsToLead(image, lead));
    return images;
  };

  const promptHasGeneratedDraft = (prompt: KeywordPromptItem, lead?: Lead | null) => {
    const matchedTaskIds = new Set(
      tasks.filter((task) => taskMatchesPrompt(task, prompt, lead)).map((task) => String(task.id || '')),
    );
    return drafts.some((item) => {
      if (String(item.source_prompt_id || '') === String(prompt.id || '')) return true;
      const taskId = String(item.task_id || '');
      if (taskId && matchedTaskIds.has(taskId)) return true;
      return textIncludes(item.title, prompt.prompt) || textIncludes(item.body, prompt.prompt);
    });
  };

  const findDefaultPromptId = (items: KeywordPromptItem[], lead?: Lead | null) => {
    const available = items.filter((item) => !promptHasGeneratedDraft(item, lead));
    return String((available[0] || items[0])?.id || '');
  };

  const applyDefaultImagesForLead = (lead?: Lead | null, force = false) => {
    if (!force && imagesManuallySelected) return;
    if (images.length === 0) {
      setSelectedImageIds([]);
      setSelectedImageGroupId('');
      return;
    }
    const matchedGroups = imageGroups.filter((group) => groupBelongsToLead(group, lead));
    const articleGroups = matchedGroups.filter((group) => !group.usage || group.usage === 'article');
    const groupsWithImages = (articleGroups.length > 0 ? articleGroups : matchedGroups)
      .map((group) => ({
        group,
        count: images.filter((image) => String(image.group_id || '') === group.id).length,
      }))
      .sort((a, b) => b.count - a.count);
    const defaultGroup = groupsWithImages[0]?.group || null;
    const matched = getImagesForLeadAndGroup(defaultGroup?.id || '', lead);
    setSelectedImageGroupId(defaultGroup?.id || '');
    setSelectedImageIds(
      (matched.length > 0 ? matched : images.filter((image) => imageBelongsToLead(image, lead)))
        .slice(0, MAX_AUTO_SELECTED_IMAGES)
        .map((image) => image.id),
    );
  };

  const applyDefaultProvider = (providerRows = providers, force = false) => {
    if (!force && providerManuallySelected) return;
    const key = getDeepSeekProviderKey(providerRows);
    setSelectedProvider((old) => (force ? key : old || key));
  };

  const loadPromptInventory = async (leadId?: string, options?: { forceAuto?: boolean }) => {
    const targetLeadId = leadId ?? selectedLeadId;
    setPromptLoading(true);
    try {
      const data = await listKeywordPrompts({ lead_id: targetLeadId || undefined, limit: 100 });
      const items = data.items || [];
      const lead = leads.find((item) => String(item.id) === String(targetLeadId || '')) || null;
      setPrompts(items);
      setSelectedPromptId((old) => {
        if (!options?.forceAuto && promptManuallySelected && items.some((item) => item.id === old)) return old;
        return findDefaultPromptId(items, lead);
      });
    } catch (err: any) {
      MessagePlugin.error(`Prompt库存读取失败：${err?.response?.data?.detail || err?.message || '请检查后端服务'}`);
    } finally {
      setPromptLoading(false);
    }
  };

  const loadImageMaterials = async () => {
    setImageMaterialLoading(true);
    try {
      const [groupRows, imageRows] = await Promise.all([listImageGroupsDb(), listManagedImagesDb()]);
      const nextGroups = normalizeImageGroups(groupRows.map(mapBackendImageGroup));
      const backendImages = await Promise.all(
        imageRows.map(async (row) => {
          const image = mapBackendManagedImage(row);
          return {
            ...image,
            url: (await loadProtectedImageUrl(image.file_url || image.url)) || image.url,
          };
        }),
      );
      setImageGroups(nextGroups);
      setImages(normalizeManagedImages(backendImages, nextGroups));
      setUsingLocalImageFallback(false);
    } catch {
      const fallbackGroups = normalizeImageGroups(readFallbackGroups().map(mapFallbackImageGroup));
      const fallbackImages = await Promise.all(
        readFallbackImages().map(async (image: StoredManagedImage) => ({
          id: String(image.id || ''),
          group_id: String(image.group_id || ''),
          lead_id: image.lead_id ? String(image.lead_id) : undefined,
          group_name: String(image.group_name || '未分组图片'),
          name: String(image.name || '未命名图片'),
          alt: String(image.alt || image.name || '文章配图'),
          url:
            normalizeFileUrl(image.file_url) ||
            (await loadImageBlobUrl(image.indexeddb_key)) ||
            normalizeFileUrl(image.url),
          file_url: normalizeFileUrl(image.file_url),
          storage: image.storage || 'indexeddb',
          indexeddb_key: image.indexeddb_key,
          is_local_only: true,
        })),
      );
      setImageGroups(fallbackGroups);
      setImages(normalizeManagedImages(fallbackImages, fallbackGroups));
      setUsingLocalImageFallback(fallbackGroups.length > 0 || fallbackImages.length > 0);
    } finally {
      setImageMaterialLoading(false);
    }
  };

  const fetchData = async () => {
    setDataLoading(true);
    try {
      const [taskRows, draftRows, leadRows, providerRows, billingRows] = await Promise.allSettled([
        listContentTasksDb({ limit: 50 }),
        listArticleDraftsDb({ limit: 50 }),
        listSelectableLeads(),
        listModelProviders(),
        getBillingAccount(),
      ]);
      if (taskRows.status === 'fulfilled') {
        setTasks(taskRows.value);
        if (!selectedTaskId && taskRows.value[0]?.id) setSelectedTaskId(String(taskRows.value[0].id));
      }
      if (draftRows.status === 'fulfilled') setDrafts(draftRows.value);
      if (leadRows.status === 'fulfilled') setLeads(leadRows.value);
      if (providerRows.status === 'fulfilled') {
        const rows = providerRows.value.providers || [];
        setProviders(rows);
        applyDefaultProvider(rows);
      }
      if (billingRows.status === 'fulfilled') {
        const account = billingRows.value.account || {};
        const tenant = billingRows.value.tenant || {};
        setAvailableCredits(Number(account.available_balance ?? tenant.credit_balance ?? 0));
      }
      if (leadRows.status === 'rejected') {
        MessagePlugin.error(`留资线索加载失败：${leadRows.reason?.message || '请检查后端服务'}`);
      }
    } finally {
      setDataLoading(false);
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

  useEffect(() => {
    fetchData().catch((err) => MessagePlugin.error(`内容数据加载失败：${err?.message || '未知错误'}`));
    loadImageMaterials().catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsedTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getActiveArticleGenerationRunDb()
      .then((run) => {
        if (cancelled || !run) return;
        pollFailureCountRef.current = 0;
        setPollSuspendedRunId('');
        setActiveRun(run);
        setLoading(true);
        setLoadingStartedAt(null);
        window.localStorage.setItem(activeRunStorageKey, run.id);
      })
      .catch(() => {
        const cachedRunId = window.localStorage.getItem(activeRunStorageKey);
        if (!cachedRunId) return;
        getArticleGenerationRunDb(cachedRunId)
          .then((run) => {
            if (cancelled || !isActiveGenerationRun(run)) return;
            pollFailureCountRef.current = 0;
            setPollSuspendedRunId('');
            setActiveRun(run);
            setLoading(true);
            setLoadingStartedAt(null);
          })
          .catch(() => window.localStorage.removeItem(activeRunStorageKey));
      });
    return () => {
      cancelled = true;
    };
  }, [activeRunStorageKey]);

  useEffect(() => {
    if (!activeRun?.id || !isActiveGenerationRun(activeRun) || pollSuspendedRunId === activeRun.id) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await getArticleGenerationRunDb(activeRun.id);
        if (stopped) return;
        pollFailureCountRef.current = 0;
        setActiveRun(next);
        if (isActiveGenerationRun(next)) return;
        setLoading(false);
        setLoadingStartedAt(null);
        setPollSuspendedRunId('');
        window.localStorage.removeItem(activeRunStorageKey);
        setActiveRun(null);
        if (['succeeded', 'succeeded_with_warning'].includes(String(next.status || ''))) {
          await fetchData();
          await loadBilling();
          const latestDraftId = next.draft_ids?.[next.draft_ids.length - 1];
          if (latestDraftId) {
            const detail = await getArticleDraftDb(latestDraftId);
            if (stopped) return;
            const detailCompliance = detail.compliance as ArticleComplianceResult | undefined;
            setDraft(String(detail.body || ''));
            setComplianceResult(detailCompliance || complianceFromDraft(detail));
            setHumanReviewed(Boolean(detail.human_reviewed_at || detailCompliance?.human_reviewed));
            setActiveDraftId(String(detail.id || ''));
            setPreviewCollapsed(false);
          }
          const charged = ARTICLE_GENERATION_UNIT_COST * Number(next.created_count || next.draft_ids?.length || 1);
          MessagePlugin.success(
            `已生成 ${
              next.created_count || next.draft_ids?.length || 1
            } 篇文章，已自动保存到文章库，已扣除 ${charged.toLocaleString('zh-CN')} 积分`,
          );
        } else {
          await loadBilling();
          MessagePlugin.error(`生成失败：${next.error_detail || next.error_type || '未知错误'}`);
        }
      } catch (err: any) {
        if (stopped) return;
        pollFailureCountRef.current += 1;
        const detail = err?.response?.data?.detail || err?.message || '未知错误';
        if (pollFailureCountRef.current === RUN_POLL_WARNING_FAILURES) {
          MessagePlugin.error(`生成状态读取失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
        }
        if (pollFailureCountRef.current >= RUN_POLL_SUSPEND_FAILURES) {
          setLoading(false);
          setLoadingStartedAt(null);
          setPollSuspendedRunId(activeRun.id);
          MessagePlugin.warning(
            `生成状态连续读取失败：${detail}。已暂停页面 loading，请稍后刷新恢复进度或到文章库查看结果。`,
          );
        }
      }
    };
    const timer = window.setInterval(poll, RUN_POLL_INTERVAL_MS);
    poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeRun?.id, activeRun?.status, activeRunStorageKey, pollSuspendedRunId]);

  const selectedTask = useMemo(() => tasks.find((task) => String(task.id) === selectedTaskId), [selectedTaskId, tasks]);
  const selectedLead = useMemo(() => leads.find((lead) => String(lead.id) === selectedLeadId), [leads, selectedLeadId]);
  const selectedPrompt = useMemo(
    () => prompts.find((prompt) => String(prompt.id) === selectedPromptId),
    [prompts, selectedPromptId],
  );
  useEffect(() => {
    if (!selectedLead || imagesManuallySelected) return;
    applyDefaultImagesForLead(selectedLead);
  }, [images, imageGroups, selectedLead, imagesManuallySelected]);
  const availableImageGroups = useMemo(
    () => imageGroups.filter((group) => groupBelongsToLead(group, selectedLead)),
    [imageGroups, selectedLead],
  );
  const activeImageGroup = useMemo(
    () => availableImageGroups.find((group) => group.id === selectedImageGroupId) || null,
    [availableImageGroups, selectedImageGroupId],
  );
  const availableImages = useMemo(() => {
    if (selectedImageGroupId) {
      return images.filter((image) => String(image.group_id || '') === selectedImageGroupId);
    }
    if (selectedLead) return images.filter((image) => imageBelongsToLead(image, selectedLead));
    return images;
  }, [images, selectedImageGroupId, selectedLead]);
  const activeDraft = useMemo(() => drafts.find((item) => String(item.id) === activeDraftId), [activeDraftId, drafts]);
  const selectedDraftForList = activeDraft || drafts[0] || null;
  useEffect(() => {
    const result = complianceFromDraft(activeDraft);
    setComplianceResult(result);
    setHumanReviewed(Boolean(activeDraft?.human_reviewed_at || result?.human_reviewed));
  }, [activeDraft]);
  const selectedImages = useMemo(
    () => images.filter((image) => selectedImageIds.includes(image.id)),
    [images, selectedImageIds],
  );
  const availableImageIdSet = useMemo(() => new Set(availableImages.map((image) => image.id)), [availableImages]);
  const selectedAvailableImageCount = useMemo(
    () => selectedImageIds.filter((id) => availableImageIdSet.has(id)).length,
    [availableImageIdSet, selectedImageIds],
  );
  const selectedRewriteIntents = useMemo(
    () => rewriteIntents.filter((item) => selectedRewriteIntentIds.includes(item.id)),
    [rewriteIntents, selectedRewriteIntentIds],
  );
  const draftImageTokens = useMemo(() => extractMarkdownImageTokens(draft, images), [draft, images]);

  const providerOptions = useMemo(
    () => [
      { label: '默认模型 / 本地兜底', value: '' },
      ...providers.map((provider) => ({
        label: `${provider.name} · ${provider.status}`,
        value: provider.key,
      })),
    ],
    [providers],
  );

  const leadOptions = useMemo(
    () => leads.map((lead) => ({ label: formatLeadLabel(lead), value: String(lead.id) })),
    [leads],
  );

  const promptOptions = useMemo(
    () =>
      prompts.map((prompt) => ({
        label: `${prompt.prompt}${prompt.keyword ? ` · ${prompt.keyword}` : ''}${
          prompt.intent ? `/${prompt.intent}` : ''
        }${prompt.source ? `/${prompt.source}` : ''}`,
        value: prompt.id,
      })),
    [prompts],
  );

  const draftOptions = useMemo(
    () =>
      drafts.map((item) => ({
        label: `${String(item.title || '未命名文章')} · ${formatTime(item.created_at || item.updated_at)}`,
        value: String(item.id || ''),
      })),
    [drafts],
  );

  const analyzeRewriteIntents = async () => {
    const url = rewriteSourceUrl.trim();
    if (!url) {
      MessagePlugin.warning('请先填写官网文章地址');
      return [] as ArticlePlatformIntent[];
    }
    setIntentAnalyzing(true);
    try {
      const data = await analyzeArticlePlatformIntentsDb(url);
      const items = data.intents || [];
      setRewriteIntents(items);
      setSelectedRewriteIntentIds(items.slice(0, 3).map((item) => item.id));
      MessagePlugin.success(`已分析 ${items.length} 个用户问题词 / 搜索意图`);
      return items;
    } catch (err: any) {
      MessagePlugin.error(`分析失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
      return [] as ArticlePlatformIntent[];
    } finally {
      setIntentAnalyzing(false);
    }
  };

  const toggleRewriteIntent = (intentId: string) => {
    setSelectedRewriteIntentIds((prev) =>
      prev.includes(intentId) ? prev.filter((id) => id !== intentId) : [...prev, intentId],
    );
  };

  const selectLead = (value: unknown) => {
    const leadId = String(value || '');
    setSelectedLeadId(leadId);
    setPromptManuallySelected(false);
    setImagesManuallySelected(false);
    setProviderManuallySelected(false);
    const lead = leads.find((item) => String(item.id) === leadId);
    if (lead) {
      setCompanyInfo(buildCompanyInfoFromLead(lead));
      loadPromptInventory(leadId, { forceAuto: true });
      applyDefaultImagesForLead(lead, true);
      applyDefaultProvider(providers, true);
      const matchedTask = tasks.find((task) => {
        const brand = String(lead.brand_name || lead.company || '').trim();
        const domain = String(lead.domain || '').trim();
        return (
          (brand && String(task.brand || '').includes(brand)) || (domain && String(task.domain || '').includes(domain))
        );
      });
      if (matchedTask) setSelectedTaskId(String(matchedTask.id));
    } else {
      setCompanyInfo('');
      applyDefaultImagesForLead(null, true);
    }
  };

  const runOfficialRewrite = async () => {
    const sourceUrl = rewriteSourceUrl.trim();
    if (!sourceUrl) {
      MessagePlugin.warning('请先填写需要改写的官网文章 URL');
      return;
    }
    setLoading(true);
    setLoadingStartedAt(Date.now());
    try {
      let intents = selectedRewriteIntents;
      if (rewriteIntents.length === 0) {
        const analyzed = await analyzeRewriteIntents();
        intents = analyzed.slice(0, 3);
      }
      const imageNotes = [
        selectedStyle?.label ? `改写风格：${selectedStyle.label}。${selectedStyle.desc || ''}` : '',
        rewriteUserAngle.trim() ? `用户补充角度：${rewriteUserAngle.trim()}` : '',
        selectedImages.length
          ? `已选图片素材：${selectedImages
              .map((image) => `${image.group_name}/${image.name}${image.alt ? `（${image.alt}）` : ''}`)
              .join('；')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      const data = await rewriteArticleForPlatformDb({
        source_url: sourceUrl,
        client_request_id: createClientRequestId(),
        platform: rewritePlatform,
        provider: selectedProvider || undefined,
        language: selectedLanguage,
        generation_mode: generateMode,
        style_key: generationStyle,
        user_angle:
          [String((selectedStyle as any)?.promptHint || '').trim(), rewriteUserAngle.trim()]
            .filter(Boolean)
            .join('\n') || undefined,
        image_notes: imageNotes || undefined,
        selected_intents: intents.map((item) => item.description || item.label),
      });
      const body = String(data.body || '').trim();
      if (!body) {
        MessagePlugin.warning('官网改写完成，但模型未返回正文');
        return;
      }
      const title = articleTitleFromBody(body, `${platformLabel(rewritePlatform)}官网改写稿`);
      const record = await createArticleDraftDb({
        title,
        channel: '官网改写',
        article_type: `${platformLabel(rewritePlatform)}官网改写`,
        status: '已生成',
        provider: data.provider || selectedProvider || 'local',
        model: data.model || undefined,
        body,
        compliance_platform: data.compliance?.platform || rewritePlatform,
        compliance_status: data.compliance?.status,
        compliance_summary: data.compliance?.summary,
        compliance_issues: data.compliance?.issues || [],
        ai_disclosure_required: Boolean(data.compliance?.ai_disclosure_required),
        source_required: Boolean(data.compliance?.source_required),
        fiction_disclosure_required: Boolean(data.compliance?.fiction_disclosure_required),
        human_review_required: Boolean(data.compliance?.human_review_required),
      });
      setDraft(body);
      setComplianceResult(data.compliance || null);
      setHumanReviewed(false);
      setActiveDraftId(String(record.id || ''));
      setPreviewCollapsed(false);
      MessagePlugin.success(
        `已生成${platformLabel(
          rewritePlatform,
        )}改写稿，并保存到文章库，已扣除 ${ARTICLE_GENERATION_UNIT_COST.toLocaleString('zh-CN')} 积分`,
      );
      await loadBilling();
      await fetchData();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (detail?.code === 'INSUFFICIENT_CREDITS') {
        setAvailableCredits(Number(detail.available || 0));
        MessagePlugin.error(
          `积分不足：本次生成需要 ${detail.required || ARTICLE_GENERATION_UNIT_COST} 积分，当前可用 ${
            detail.available || 0
          } 积分，请购买相应的权益和积分包`,
        );
      } else {
        MessagePlugin.error(`官网改写失败：${detail || err?.message || '未知错误'}`);
      }
      await loadBilling();
    } finally {
      setLoading(false);
      setLoadingStartedAt(null);
    }
  };

  const runViralRewrite = async () => {
    const sourceUrl = viralSourceUrl.trim();
    const sourceText = viralSourceText.trim();
    const brandContext = companyInfo.trim();
    if (!sourceUrl && !sourceText) {
      MessagePlugin.warning('请输入爆文 URL 或粘贴爆文正文');
      return;
    }
    if (!selectedLeadId) {
      MessagePlugin.warning('请先选择留资线索，系统会按这条客户信息生成爆文仿写');
      return;
    }
    if (!brandContext) {
      MessagePlugin.warning('请先选择留资线索或填写公司信息，爆文仿写会围绕公司信息生成');
      return;
    }
    if (sourceText && sourceText.length < 100) {
      MessagePlugin.warning('粘贴正文太短，至少需要 100 字用于分析爆文结构');
      return;
    }
    setLoading(true);
    setLoadingStartedAt(Date.now());
    try {
      const imageNotes = selectedImages.length
        ? `已选图片素材：${selectedImages
            .map((image) => `${image.group_name}/${image.name}${image.alt ? `（${image.alt}）` : ''}`)
            .join('；')}`
        : '';
      const data = await rewriteViralArticleDb({
        source_url: sourceUrl || undefined,
        source_text: sourceText || undefined,
        client_request_id: createClientRequestId(),
        lead_id: selectedLeadId,
        platform: rewritePlatform,
        provider: selectedProvider || undefined,
        language: selectedLanguage,
        style_key: generationStyle,
        user_angle:
          [String((selectedStyle as any)?.promptHint || '').trim(), viralUserAngle.trim()].filter(Boolean).join('\n') ||
          undefined,
        brand_context: brandContext,
        image_notes: imageNotes || undefined,
      });
      const body = String(data.body || '').trim();
      if (!body) {
        MessagePlugin.warning('爆文仿写完成，但模型未返回正文');
        return;
      }
      setDraft(body);
      setComplianceResult(data.compliance || null);
      setHumanReviewed(false);
      setActiveDraftId(String(data.draft_id || ''));
      setPreviewCollapsed(false);
      const modeText = data.source_mode === 'pasted_text' ? '粘贴正文' : 'URL';
      const lengthText = data.length_policy?.final_chars ? `，约 ${data.length_policy.final_chars} 字` : '';
      MessagePlugin.success(
        `已根据${modeText}生成${platformLabel(
          rewritePlatform,
        )}爆文仿写稿${lengthText}，已扣除 ${ARTICLE_GENERATION_UNIT_COST.toLocaleString('zh-CN')} 积分`,
      );
      await loadBilling();
      await fetchData();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (detail?.code === 'INSUFFICIENT_CREDITS') {
        setAvailableCredits(Number(detail.available || 0));
        MessagePlugin.error(
          `积分不足：本次生成需要 ${detail.required || ARTICLE_GENERATION_UNIT_COST} 积分，当前可用 ${
            detail.available || 0
          } 积分，请购买相应的权益和积分包`,
        );
      } else {
        MessagePlugin.error(`爆文仿写失败：${detail || err?.message || '未知错误'}`);
      }
      await loadBilling();
    } finally {
      setLoading(false);
      setLoadingStartedAt(null);
    }
  };

  const openGenerateConfirm = () => {
    if (generationLocked) return;
    if (hasInsufficientCredits) {
      MessagePlugin.warning(
        `当前可用积分不足，本次生成需要 ${articleGenerationCost.toLocaleString(
          'zh-CN',
        )} 积分，请购买相应的权益和积分包`,
      );
      return;
    }
    setConfirmOpen(true);
  };

  const runGenerate = async () => {
    if (hasInsufficientCredits) {
      MessagePlugin.warning(
        `当前可用积分不足，本次生成需要 ${articleGenerationCost.toLocaleString(
          'zh-CN',
        )} 积分，请购买相应的权益和积分包`,
      );
      setConfirmOpen(false);
      return;
    }
    setConfirmOpen(false);
    if (generateMode === 'official_rewrite') {
      await runOfficialRewrite();
      return;
    }
    if (generateMode === 'viral_rewrite') {
      await runViralRewrite();
      return;
    }
    if (!selectedLead) {
      MessagePlugin.warning('请先选择留资线索，系统会自动带入公司信息');
      return;
    }
    if (!selectedPrompt) {
      MessagePlugin.warning('请先选择高频问题 / Prompt');
      return;
    }
    if (generationLocked) return;
    const selectedImageSet = new Set(selectedImages.map((image) => image.id));
    const missingSelectedImages = selectedImageIds.filter((id) => !selectedImageSet.has(id));
    if (missingSelectedImages.length > 0) {
      MessagePlugin.warning('图片素材尚未加载完成，请刷新素材列表后再生成文章');
      return;
    }
    const nonPersistentImages = selectedImages.filter((image) => {
      const fileUrl = String(image.file_url || '').trim();
      const previewUrl = String(image.url || '').trim();
      const sourceUrl = fileUrl || previewUrl;
      return image.is_local_only || !sourceUrl || sourceUrl.startsWith('blob:') || sourceUrl.startsWith('data:');
    });
    if (nonPersistentImages.length > 0) {
      MessagePlugin.warning('存在未持久化图片，请先重新上传到素材库后再生成文章');
      return;
    }
    setLoading(true);
    setLoadingStartedAt(Date.now());
    pollFailureCountRef.current = 0;
    setPollSuspendedRunId('');
    const count = Math.max(1, Math.min(10, Math.round(Number(generateCount) || 1)));
    try {
      let taskForGeneration = taskMatchesPromptExactly(selectedTask, selectedPrompt)
        ? selectedTask
        : tasks.find((task) => taskMatchesPromptExactly(task, selectedPrompt));
      if (!taskForGeneration) {
        const leadKeywords = readLeadList(selectedLead.keywords);
        const keyword =
          String(selectedPrompt.keyword || '').trim() ||
          leadKeywords[0] ||
          String(selectedLead.brand_name || selectedLead.company || selectedLead.name || '客户文章').trim();
        const title = String(selectedPrompt.prompt || keyword || '客户文章生成任务')
          .trim()
          .slice(0, 80);
        MessagePlugin.info('未找到匹配的内部写作任务，正在自动创建基础任务...');
        taskForGeneration = await createContentTaskDb({
          lead_id: selectedLead.id,
          source_prompt_id: selectedPrompt.id,
          source_prompt_text: selectedPrompt.prompt,
          source_prompt_keyword: selectedPrompt.keyword || undefined,
          source_prompt_intent: selectedPrompt.intent || undefined,
          source_prompt_scenario: selectedPrompt.scenario || undefined,
          title,
          brand: String(selectedLead.brand_name || selectedLead.company || selectedLead.name || '未命名客户'),
          domain: String(selectedLead.domain || ''),
          keyword,
          channel: '官网文章',
          angle: 'Prompt回答型',
          priority: '中',
          outline: [String(selectedPrompt.prompt || title)],
        });
        setTasks((prev) => [taskForGeneration as Record<string, any>, ...prev]);
        setSelectedTaskId(String(taskForGeneration.id || ''));
      }
      const generationTaskId = String(taskForGeneration.id || '');
      if (!generationTaskId) {
        MessagePlugin.error('写作任务缺少有效 ID，无法生成文章');
        setLoading(false);
        setLoadingStartedAt(null);
        return;
      }
      const basePrompt = selectedPrompt?.prompt || String(taskForGeneration.title || '');
      const imageMarkers = selectedImages.map((_, idx) => `[图片${idx + 1}]`).join('、');
      const imageInstruction = selectedImages.length
        ? `\n\n本次已选择 ${selectedImages.length} 张图片。正文必须自然插入 ${imageMarkers} 占位符；图片之间至少间隔 2 个自然段，尽量分散在不同 H2 小节，每个占位符前后要有与图片主题相关的文字，不要把图片集中堆在文末。`
        : '';
      const styleInstruction =
        generateMode === 'basic' && generationStyle !== 'original' && (selectedStyle as any)?.promptHint
          ? `\n\n生成风格：${selectedStyle.label}\n${(selectedStyle as any).promptHint}`
          : '';
      const response = await createArticleGenerationRunDb({
        task_id: generationTaskId,
        client_request_id: createClientRequestId(),
        mode: 'basic',
        requested_count: count,
        source_prompt_id: selectedPrompt.id,
        source_prompt_text: selectedPrompt.prompt,
        source_prompt_keyword: selectedPrompt.keyword || undefined,
        source_prompt_intent: selectedPrompt.intent || undefined,
        source_prompt_scenario: selectedPrompt.scenario || undefined,
        company_info: companyInfo,
        prompt_text: `${basePrompt}${imageInstruction}${styleInstruction}`,
        provider: selectedProvider || undefined,
        language: selectedLanguage,
        generation_mode: generateMode,
        style_key: generationStyle,
        platform: rewritePlatform,
        compliance_mode: 'standard',
        images: selectedImages.map((image) => ({
          id: image.id,
          name: image.name,
          group: image.group_name,
          alt: image.alt,
          file_url: image.file_url,
        })),
      });
      pollFailureCountRef.current = 0;
      setPollSuspendedRunId('');
      setActiveRun(response.run);
      window.localStorage.setItem(activeRunStorageKey, response.run_id);
      if (response.active_existing) {
        MessagePlugin.info('已有文章生成正在进行，已恢复当前任务进度');
      } else if (response.reused_existing) {
        MessagePlugin.info('该生成请求已在处理中，已恢复当前任务进度');
      } else {
        MessagePlugin.success(
          selectedImages.length
            ? `文章生成已开始，已带入 ${selectedImages.length} 张图片素材`
            : '文章生成已开始，后台会自动保存到文章库',
        );
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (detail?.code === 'INSUFFICIENT_CREDITS') {
        setAvailableCredits(Number(detail.available || 0));
        MessagePlugin.error(
          `积分不足：本次生成需要 ${detail.required || articleGenerationCost} 积分，当前可用 ${
            detail.available || 0
          } 积分，请购买相应的权益和积分包`,
        );
      } else {
        MessagePlugin.error(`生成启动失败：${typeof detail === 'string' ? detail : err?.message || '未知错误'}`);
      }
      await loadBilling();
      setLoading(false);
      setLoadingStartedAt(null);
    }
  };

  const toggleImage = (imageId: string) => {
    setImagesManuallySelected(true);
    setSelectedImageIds((prev) => (prev.includes(imageId) ? prev.filter((id) => id !== imageId) : [...prev, imageId]));
  };

  const clearImageSelection = () => {
    setImagesManuallySelected(true);
    setSelectedImageIds([]);
    MessagePlugin.success('已清空图片选择，本次生成不会插入图片');
  };

  const selectImageGroup = (value: unknown) => {
    const groupId = String(value || '');
    const nextImages = getImagesForLeadAndGroup(groupId, selectedLead);
    setSelectedImageGroupId(groupId);
    setImagesManuallySelected(true);
    setSelectedImageIds(nextImages.slice(0, MAX_AUTO_SELECTED_IMAGES).map((image) => image.id));
  };

  const copyDraft = async () => {
    if (!draft.trim()) return;
    await navigator.clipboard.writeText(stripMarkdownForPublish(draft));
    MessagePlugin.success('已复制发布正文');
  };

  const ensureDraftBody = async (row: Record<string, any>) => {
    if (row.body !== undefined && row.body !== null) return row;
    const detail = await getArticleDraftDb(String(row.id || ''));
    setDrafts((items) =>
      items.map((item) => (String(item.id || '') === String(row.id || '') ? { ...item, ...detail } : item)),
    );
    return { ...row, ...detail };
  };

  const copyDraftRow = async (row: Record<string, any>) => {
    const detail = await ensureDraftBody(row);
    const body = String(detail.body || '');
    if (!body.trim()) {
      MessagePlugin.warning('该文章正文为空');
      return;
    }
    await navigator.clipboard.writeText(stripMarkdownForPublish(body));
    MessagePlugin.success('已复制发布正文');
  };

  const rerunComplianceCheck = async () => {
    const body = draft.trim();
    if (!body) {
      MessagePlugin.warning('请先生成或载入文章正文');
      return;
    }
    setComplianceChecking(true);
    try {
      const result = await checkArticleComplianceDb({
        platform: rewritePlatform,
        title: String(activeDraft?.title || articleTitleFromBody(body, '成品文章')),
        body,
        generation_mode: generateMode,
        source_text: generateMode === 'viral_rewrite' ? viralSourceText.trim() || undefined : undefined,
        human_reviewed: humanReviewed,
      });
      setComplianceResult(result);
      MessagePlugin.success('发布审核已刷新');
    } catch (err: any) {
      MessagePlugin.error(`发布审核失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setComplianceChecking(false);
    }
  };

  const viewDraft = async (row: Record<string, any>) => {
    try {
      const detail = await ensureDraftBody(row);
      setDraft(String(detail.body || ''));
      setActiveDraftId(String(detail.id || ''));
      if (detail.task_id) setSelectedTaskId(String(detail.task_id));
      setPreviewCollapsed(false);
      MessagePlugin.success('已载入文章内容');
    } catch (err: any) {
      MessagePlugin.error(`文章正文加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    }
  };

  const generateButtonText = () => {
    const currentRun = activeRun;
    if (currentRun && isActiveGenerationRun(currentRun)) {
      if (activeRunPollingSuspended) return '状态读取失败，可重新发起生成';
      const progress =
        Number(currentRun.requested_count || 1) > 1
          ? ` · ${Number(currentRun.created_count || 0)}/${Number(currentRun.requested_count || 1)}`
          : '';
      return `${stageLabel(currentRun.stage)} ${formatElapsed(activeRunElapsed)}${progress}`;
    }
    if (loading)
      return `${
        generateMode === 'official_rewrite' ? '改写中' : generateMode === 'viral_rewrite' ? '仿写中' : '生成中'
      } ${formatElapsed(localLoadingElapsed)}`;
    if (generateMode === 'official_rewrite') return `开始${platformLabel(rewritePlatform)}官网改写`;
    if (generateMode === 'viral_rewrite') return `开始${platformLabel(rewritePlatform)}爆文仿写`;
    if (generateCount > 1) return `开始写 ${generateCount} 篇文章`;
    return '开始写文章';
  };

  const renderCompliancePanel = () => {
    const result = complianceResult || complianceFromDraft(activeDraft);
    if (!draft.trim() && !result) return null;
    const issues = result?.issues || [];
    return (
      <div className={Style.compliancePanel}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} breakLine>
          <Space size={8} breakLine>
            <Tag theme={complianceTheme(result?.status)} variant='light'>
              {complianceLabel(result?.status)}
            </Tag>
            <Tag theme='primary' variant='light'>
              {result?.platform_name || platformLabel(rewritePlatform)}
            </Tag>
          </Space>
          <Button size='small' variant='outline' loading={complianceChecking} onClick={rerunComplianceCheck}>
            重新审核
          </Button>
        </Space>
        <div className={Style.complianceSummary}>
          {result?.summary || '当前文章尚未执行发布审核，建议发布或分发前先审核。'}
        </div>
        <div className={Style.complianceChecks}>
          <Tag theme={result?.ai_disclosure_required ? 'warning' : 'default'} variant='light'>
            AI标识{result?.ai_disclosure_required ? '：需要' : '：未要求'}
          </Tag>
          <Tag theme={result?.source_required ? 'warning' : 'default'} variant='light'>
            来源标注{result?.source_required ? '：需要' : '：未要求'}
          </Tag>
          <Tag theme={result?.fiction_disclosure_required ? 'warning' : 'default'} variant='light'>
            虚构标注{result?.fiction_disclosure_required ? '：需要' : '：未要求'}
          </Tag>
        </div>
        {result?.human_review_required ? (
          <Checkbox checked={humanReviewed} onChange={(checked) => setHumanReviewed(Boolean(checked))}>
            已人工审核并编辑确认，内容不是全自动替代真人创作
          </Checkbox>
        ) : null}
        {issues.length > 0 ? (
          <div className={Style.complianceIssueList}>
            {issues.map((issue, index) => (
              <div key={`${issue.code}-${index}`} className={Style.complianceIssue}>
                <Tag theme={complianceTheme(issue.level)} variant='light'>
                  {issue.level === 'blocked' ? '阻止' : '提醒'}
                </Tag>
                <div>
                  <strong>{issue.message}</strong>
                  {issue.suggestion ? <p>{issue.suggestion}</p> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
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
              公司信息 + 高频问题 + 图片 + AI
            </Tag>
          </Space>
          <div className={Style.heroTitle}>文章生成</div>
          <div className={Style.heroDesc}>选择留资线索、高频问题、图片素材和可用 AI，生成可直接查看的成品文章。</div>
        </Space>
      </Card>

      <div className={Style.statsGrid}>
        <Metric title='留资线索' value={leads.length} color='#5E6AD2' />
        <Metric title='Prompt库存' value={prompts.length} color='#ED7B2F' />
        <Metric title='图片素材' value={images.length} color='#00A870' />
        <Metric title='成品文章' value={drafts.length} color='#0EA5E9' />
      </div>

      {isActiveGenerationRun(activeRun) ? (
        <Card bordered={false} className={Style.sectionCard}>
          <Space size={8} breakLine>
            <Tag theme='warning' variant='light'>
              {stageLabel(activeRun?.stage)}
            </Tag>
            <Tag theme='primary' variant='light'>
              耗时 {formatElapsed(activeRunElapsed)}
            </Tag>
            <Tag theme='success' variant='light'>
              {Number(activeRun?.created_count || 0)}/{Number(activeRun?.requested_count || 1)} 篇
            </Tag>
            {activeRunPollingSuspended ? (
              <Tag theme='danger' variant='light'>
                状态读取已暂停
              </Tag>
            ) : null}
          </Space>
        </Card>
      ) : null}

      <div className={Style.splitLayout}>
        <Card bordered={false} className={Style.sectionCard} title='生成配置'>
          <Space direction='vertical' style={{ width: '100%' }}>
            <div>
              <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                生成模式
              </div>
              <div className={Style.modeSwitch}>
                {GENERATE_MODE_OPTIONS.map((item) => (
                  <button
                    key={item.value}
                    type='button'
                    className={`${Style.modeButton} ${generateMode === item.value ? Style.modeButtonActive : ''}`}
                    onClick={() => switchGenerateMode(item.value)}
                  >
                    <strong>{item.label}</strong>
                    <span>{item.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                生成风格
              </div>
              <Select
                value={generationStyle}
                options={styleOptions}
                onChange={changeGenerationStyle}
                style={{ width: '100%' }}
              />
              <div className={Style.subtleText} style={{ marginTop: 8 }}>
                {selectedStyle?.desc}
              </div>
            </div>

            <div>
              <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                发布平台审核
              </div>
              <Select
                value={rewritePlatform}
                options={PLATFORM_OPTIONS.map((item) => ({
                  label: `${item.label} · ${item.desc}`,
                  value: item.value,
                }))}
                onChange={(value) => setRewritePlatform((value || 'zhihu') as PlatformRewriteTarget)}
                style={{ width: '100%' }}
              />
              <div className={Style.subtleText} style={{ marginTop: 8 }}>
                生成和预览会按所选平台执行 AI 标识、来源标注和人工审核检查。
              </div>
            </div>

            <div>
              <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
                <div className={Style.itemTitle}>留资线索</div>
                <Button size='small' variant='text' icon={<RefreshIcon />} loading={dataLoading} onClick={fetchData}>
                  刷新
                </Button>
              </Space>
              <Select
                value={selectedLeadId}
                options={leadOptions}
                onChange={selectLead}
                filterable
                clearable
                loading={dataLoading}
                placeholder='选择已保存的留资信息，自动带入公司信息'
                style={{ width: '100%' }}
              />
              {selectedLead ? (
                <div className={Style.subtleText} style={{ marginTop: 8 }}>
                  已选择：{formatLeadLabel(selectedLead)}
                </div>
              ) : null}
              {!selectedLead && leads.length === 0 ? (
                <div className={Style.subtleText} style={{ marginTop: 8 }}>
                  暂无可选留资。请先到“客户与预诊 / 留资线索”或“客户资产”新增客户，再点击刷新。
                </div>
              ) : null}
            </div>

            <div>
              <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                公司信息
              </div>
              <Textarea
                value={companyInfo}
                onChange={(value) => setCompanyInfo(String(value))}
                placeholder='选择留资线索后自动填写公司介绍、业务范围、服务对象、优势和事实边界，也可以补充'
                autosize={{ minRows: 5, maxRows: 9 }}
              />
            </div>

            {generateMode === 'basic' ? (
              <div>
                <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                  高频问题 / Prompt
                </div>
                <div className={Style.promptPickerPanel}>
                  <div className={Style.promptPickerStatusRow}>
                    <Tag theme='success' variant='light' className={Style.promptSourceTag}>
                      来源：目标关键词系统 / Prompt库存
                    </Tag>
                    <Tag theme={promptManuallySelected ? 'warning' : 'primary'} variant='light'>
                      {promptManuallySelected ? '手动选择' : '自动默认'}
                    </Tag>
                  </div>
                  <div className={Style.promptPickerActionRow}>
                    <Button size='small' variant='text' loading={promptLoading} onClick={() => loadPromptInventory()}>
                      刷新库存
                    </Button>
                    <Button
                      size='small'
                      variant='text'
                      disabled={!selectedLeadId || prompts.length === 0}
                      onClick={() => {
                        setPromptManuallySelected(false);
                        setSelectedPromptId(findDefaultPromptId(prompts, selectedLead));
                      }}
                    >
                      恢复自动
                    </Button>
                  </div>
                </div>
                <Select
                  value={selectedPromptId}
                  options={promptOptions}
                  onChange={(value) => {
                    setPromptManuallySelected(true);
                    setSelectedPromptId(String(value || ''));
                  }}
                  filterable
                  clearable
                  loading={promptLoading}
                  placeholder='选择要回答的高频问题'
                  style={{ width: '100%' }}
                />
                {selectedPrompt ? (
                  <div className={Style.monoBlock} style={{ marginTop: 8, maxHeight: 120 }}>
                    {selectedPrompt.prompt}
                  </div>
                ) : null}
                {!selectedPrompt && prompts.length === 0 ? (
                  <div className={Style.subtleText} style={{ marginTop: 8 }}>
                    当前暂无可选 Prompt。请先到“目标关键词系统 / Prompt库存”为客户生成并入库。
                  </div>
                ) : null}
              </div>
            ) : null}

            {generateMode === 'official_rewrite' ? (
              <div>
                <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                  官网改写参数
                </div>
                <Space direction='vertical' style={{ width: '100%' }}>
                  <Input
                    value={rewriteSourceUrl}
                    onChange={(value) => setRewriteSourceUrl(String(value || ''))}
                    placeholder='请输入需要改写的官网文章 URL，例如：https://www.example.com/news/article'
                  />
                  <Tag theme='primary' variant='light'>
                    当前平台：{platformLabel(rewritePlatform)}
                  </Tag>
                  <Textarea
                    value={rewriteUserAngle}
                    onChange={(value) => setRewriteUserAngle(String(value || ''))}
                    placeholder='可选：补充本次改写角度，例如重点强调到店路线、价格判断、合作流程等'
                    autosize={{ minRows: 2, maxRows: 4 }}
                  />
                  <Space size={8} breakLine>
                    <Button size='small' variant='outline' loading={intentAnalyzing} onClick={analyzeRewriteIntents}>
                      分析问题词
                    </Button>
                    <Tag theme='primary' variant='light'>
                      已选 {selectedRewriteIntentIds.length} 个意图
                    </Tag>
                  </Space>
                  {rewriteIntents.length > 0 ? (
                    <div className={Style.intentGrid}>
                      {rewriteIntents.map((intent) => {
                        const active = selectedRewriteIntentIds.includes(intent.id);
                        return (
                          <button
                            key={intent.id}
                            type='button'
                            className={`${Style.intentChip} ${active ? Style.intentChipActive : ''}`}
                            onClick={() => toggleRewriteIntent(intent.id)}
                          >
                            <strong>{intent.label}</strong>
                            {intent.description ? <span>{intent.description}</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className={Style.subtleText}>
                      填入官网文章地址后可先分析问题词；不分析也可以直接改写，系统会按官网正文自动判断。
                    </div>
                  )}
                </Space>
              </div>
            ) : null}

            {generateMode === 'viral_rewrite' ? (
              <div>
                <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                  爆文仿写参数
                </div>
                <Space direction='vertical' style={{ width: '100%' }}>
                  <Input
                    value={viralSourceUrl}
                    onChange={(value) => setViralSourceUrl(String(value || ''))}
                    placeholder='可选：输入爆文 URL，系统会自动抓取正文'
                  />
                  <Textarea
                    value={viralSourceText}
                    onChange={(value) => setViralSourceText(String(value || ''))}
                    placeholder='可选：直接粘贴爆文正文。URL 和正文至少填一个；同时填写时优先使用粘贴正文。'
                    autosize={{ minRows: 6, maxRows: 12 }}
                  />
                  <Select
                    value={rewritePlatform}
                    options={PLATFORM_OPTIONS.map((item) => ({
                      label: `${item.label} · ${item.desc}`,
                      value: item.value,
                    }))}
                    onChange={(value) => setRewritePlatform((value || 'xiaohongshu') as PlatformRewriteTarget)}
                    style={{ width: '100%' }}
                  />
                  <Textarea
                    value={viralUserAngle}
                    onChange={(value) => setViralUserAngle(String(value || ''))}
                    placeholder='可选：补充仿写角度和品类边界，例如主营皮具护理、湿纸巾，不写家具/家装/收纳架'
                    autosize={{ minRows: 2, maxRows: 4 }}
                  />
                  <div className={Style.subtleText}>
                    爆文只作为结构模板；正文主题会绑定已选留资线索和上方公司信息，不会沿用原文行业、案例或数据。
                  </div>
                </Space>
              </div>
            ) : null}

            <div>
              <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                图片素材
              </div>
              {images.length === 0 ? (
                <div className={Style.emptyState} style={{ padding: '24px 12px' }}>
                  暂无图片素材，请先到“图片管理”创建组并导入图片。
                </div>
              ) : selectedLead && availableImageGroups.length === 0 ? (
                <div className={Style.emptyState} style={{ padding: '24px 12px' }}>
                  当前客户资产暂无绑定图片组，请先到“素材图片”创建组并导入图片。
                </div>
              ) : (
                <div className={Style.imagePickerPanel}>
                  <div className={Style.imagePickerStatusRow}>
                    {imageMaterialLoading ? (
                      <Tag theme='primary' variant='light'>
                        图片读取中
                      </Tag>
                    ) : null}
                    <Tag theme='primary' variant='light'>
                      已选 {selectedAvailableImageCount} 张
                    </Tag>
                    <Tag theme='success' variant='light'>
                      当前{activeImageGroup ? '组' : selectedLead ? '客户' : '范围'}共 {availableImages.length} 张
                    </Tag>
                    {activeImageGroup ? <Tag variant='light'>{activeImageGroup.name}</Tag> : null}
                    <Tag theme={imagesManuallySelected ? 'warning' : 'primary'} variant='light'>
                      {imagesManuallySelected ? '手动选择' : '自动默认'}
                    </Tag>
                    {usingLocalImageFallback ? (
                      <Tag theme='warning' variant='light'>
                        本机兜底图片
                      </Tag>
                    ) : null}
                  </div>
                  <div className={Style.imagePickerActionRow}>
                    <Button
                      size='small'
                      variant='text'
                      disabled={selectedImageIds.length === 0}
                      onClick={clearImageSelection}
                    >
                      清空选择
                    </Button>
                    <Button
                      size='small'
                      variant='text'
                      disabled={!selectedLead}
                      onClick={() => {
                        setImagesManuallySelected(false);
                        applyDefaultImagesForLead(selectedLead, true);
                      }}
                    >
                      恢复自动
                    </Button>
                  </div>
                  <Select
                    value={selectedImageGroupId}
                    options={[
                      { label: '全部可用图片', value: '' },
                      ...availableImageGroups.map((group) => ({
                        label: `${group.name}${group.lead_name ? ` · ${group.lead_name}` : ''}`,
                        value: group.id,
                      })),
                    ]}
                    placeholder='选择图片组'
                    clearable
                    onChange={selectImageGroup}
                    className={Style.imageGroupSelect}
                  />
                  {selectedImageIds.length === 0 ? (
                    <Alert
                      className={Style.imageSelectionAlert}
                      theme='info'
                      title='当前未选择图片'
                      message='下方仍展示可选图片，点击图片卡片即可重新加入本次文章生成。'
                    />
                  ) : null}
                  {availableImages.length === 0 ? (
                    <div className={Style.emptyState} style={{ padding: '24px 12px' }}>
                      当前图片组暂无图片，请先导入图片。
                    </div>
                  ) : (
                    <div className={Style.pickImageGrid}>
                      {availableImages.map((image) => {
                        const active = selectedImageIds.includes(image.id);
                        return (
                          <button
                            key={image.id}
                            type='button'
                            className={`${Style.pickImageCard} ${active ? Style.pickImageCardActive : ''}`}
                            onClick={() => toggleImage(image.id)}
                          >
                            <img src={image.url} alt={image.alt || image.name} />
                            <Tag
                              className={Style.pickImageState}
                              theme={active ? 'primary' : 'default'}
                              variant='light'
                            >
                              {active ? '已选入本次生成' : '未选择'}
                            </Tag>
                            {image.is_local_only ? (
                              <Tag theme='warning' variant='light'>
                                本机保存
                              </Tag>
                            ) : null}
                            <span>{image.group_name}</span>
                            <strong>{image.name}</strong>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                可用 AI
              </div>
              <Select
                value={selectedProvider}
                options={providerOptions}
                onChange={(value) => {
                  setProviderManuallySelected(true);
                  setSelectedProvider(String(value || ''));
                }}
                style={{ width: '100%' }}
              />
              <Space size={8} style={{ marginTop: 8 }}>
                <Tag theme={providerManuallySelected ? 'warning' : 'primary'} variant='light'>
                  {providerManuallySelected ? '手动选择' : '默认 DeepSeek'}
                </Tag>
                <Button
                  size='small'
                  variant='text'
                  onClick={() => {
                    setProviderManuallySelected(false);
                    setSelectedProvider(getDeepSeekProviderKey(providers));
                  }}
                >
                  恢复 DeepSeek
                </Button>
              </Space>
            </div>

            <div>
              <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                生成语言
              </div>
              <Select
                value={selectedLanguage}
                options={LANGUAGE_OPTIONS}
                onChange={(value) => setSelectedLanguage((value || 'zh') as GenerationLanguage)}
                style={{ width: '100%' }}
              />
              <div className={Style.subtleText} style={{ marginTop: 8 }}>
                影响文章正文、标题、FAQ 和平台改写包的输出语言。
              </div>
            </div>

            {generateMode === 'basic' ? (
              <div>
                <div className={Style.itemTitle} style={{ marginBottom: 8 }}>
                  生成篇数
                </div>
                <InputNumber
                  value={generateCount}
                  min={1}
                  max={10}
                  step={1}
                  theme='normal'
                  style={{ width: '100%' }}
                  onChange={(value) => setGenerateCount(Math.max(1, Math.min(10, Math.round(Number(value) || 1))))}
                />
                <div className={Style.subtleText} style={{ marginTop: 8 }}>
                  多篇会逐篇生成并保存到文章库；本页只展示生成结果，编辑和发布请到文章库处理。
                </div>
              </div>
            ) : null}

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
                本次生成将消耗 {articleGenerationCost.toLocaleString('zh-CN')} 积分
              </Tag>
              <Tag theme='success' variant='light'>
                {generateMode === 'basic' ? `预计生成：${normalizedGenerateCount} 篇` : '预计生成：1 篇'}
              </Tag>
            </Space>

            {hasInsufficientCredits ? (
              <Alert
                theme='warning'
                title='积分不足，暂不能生成文章'
                message={`当前可用积分 ${availableCredits?.toLocaleString(
                  'zh-CN',
                )}，本次生成需要 ${articleGenerationCost.toLocaleString(
                  'zh-CN',
                )} 积分。请购买相应的权益和积分包后再生成文章。`}
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

            <Button
              theme='primary'
              icon={<RocketIcon />}
              loading={loading}
              disabled={generationLocked || hasInsufficientCredits}
              block
              onClick={openGenerateConfirm}
            >
              {generateButtonText()}
            </Button>
          </Space>
        </Card>

        <Card
          bordered={false}
          className={Style.sectionCard}
          title={`本次/历史生成文章（${drafts.length}）`}
          actions={
            drafts.length > 0 ? (
              <Button
                size='small'
                variant='text'
                icon={<ChevronDownIcon className={draftListExpanded ? Style.rotateIcon : undefined} />}
                onClick={() => setDraftListExpanded((prev) => !prev)}
              >
                {draftListExpanded ? '收起列表' : '展开列表'}
              </Button>
            ) : null
          }
        >
          {drafts.length === 0 ? (
            <div className={Style.emptyState}>暂无生成文章，生成成功后会自动保存到文章库。</div>
          ) : (
            <Space direction='vertical' style={{ width: '100%' }}>
              <Select
                value={String(selectedDraftForList?.id || '')}
                options={draftOptions}
                filterable
                placeholder='选择成品文章'
                style={{ width: '100%' }}
                onChange={(value) => {
                  const row = drafts.find((item) => String(item.id || '') === String(value || ''));
                  if (row) viewDraft(row);
                }}
              />

              {selectedDraftForList ? (
                <Card
                  bordered={false}
                  className={`${Style.compactDraftCard} ${
                    String(selectedDraftForList.id || '') === activeDraftId ? Style.activeCompactDraftCard : ''
                  }`}
                >
                  <div className={Style.compactDraftContent}>
                    <div className={Style.compactDraftMeta}>
                      <div className={Style.itemTitle}>{String(selectedDraftForList.title || '未命名文章')}</div>
                      <div className={Style.subtleText}>
                        生成时间：{formatTime(selectedDraftForList.created_at || selectedDraftForList.updated_at)} ·
                        模型：
                        {selectedDraftForList.provider || 'provider'} / {selectedDraftForList.model || 'model'}
                      </div>
                      <Space size={6} style={{ marginTop: 8 }}>
                        {selectedDraftForList.article_type ? (
                          <Tag theme={articleTypeTheme(selectedDraftForList.article_type)} variant='light'>
                            类型：{String(selectedDraftForList.article_type)}
                          </Tag>
                        ) : null}
                        <Tag theme={draftStatusTheme(selectedDraftForList.status)} variant='light'>
                          {String(selectedDraftForList.status || '草稿')}
                        </Tag>
                        {String(selectedDraftForList.id || '') === activeDraftId ? (
                          <Tag theme='primary' variant='light'>
                            正在预览
                          </Tag>
                        ) : null}
                      </Space>
                    </div>
                    <Space size={8} breakLine className={Style.compactDraftActions}>
                      <Button size='small' variant='outline' onClick={() => viewDraft(selectedDraftForList)}>
                        查看
                      </Button>
                      <Button
                        size='small'
                        variant='outline'
                        icon={<FileCopyIcon />}
                        onClick={() => copyDraftRow(selectedDraftForList)}
                      >
                        复制
                      </Button>
                      <Button size='small' variant='outline' onClick={() => navigate('/content-generation/articles')}>
                        去文章库管理
                      </Button>
                    </Space>
                  </div>
                </Card>
              ) : null}

              {draftListExpanded ? (
                <div className={Style.draftDropdownList}>
                  {drafts.map((item) => {
                    const isActive = String(item.id || '') === activeDraftId;
                    return (
                      <button
                        key={String(item.id)}
                        type='button'
                        className={`${Style.draftDropdownItem} ${isActive ? Style.draftDropdownItemActive : ''}`}
                        onClick={() => viewDraft(item)}
                      >
                        <span>{String(item.title || '未命名文章')}</span>
                        <em>{formatTime(item.created_at || item.updated_at)}</em>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </Space>
          )}
        </Card>
      </div>

      {activeDraft ? (
        <Card
          bordered={false}
          className={Style.sectionCard}
          title={`生成结果预览：${String(activeDraft.title || '未命名文章')}`}
          actions={
            <Space>
              <Tag theme='success' variant='light'>
                已入库
              </Tag>
              <Button size='small' variant='outline' onClick={() => setPreviewCollapsed((prev) => !prev)}>
                {previewCollapsed ? '展开实时预览' : '收起实时预览'}
              </Button>
              <Button size='small' theme='primary' onClick={() => navigate('/content-generation/articles')}>
                去文章库编辑/发布
              </Button>
            </Space>
          }
        >
          <div className={Style.workbenchGrid}>
            <div className={Style.workbenchMain}>
              <Space direction='vertical' style={{ width: '100%' }}>
                <div>
                  <div className={Style.itemTitle}>当前文章：{String(activeDraft.title || '未命名文章')}</div>
                  <div className={Style.subtleText} style={{ marginTop: 6 }}>
                    本页只展示生成结果；文章已保存到文章库，后续编辑、发布和删除统一在文章库完成。
                  </div>
                  {activeDraft.article_type ? (
                    <Tag theme={articleTypeTheme(activeDraft.article_type)} variant='light' style={{ marginTop: 10 }}>
                      文章类型：{String(activeDraft.article_type)}
                    </Tag>
                  ) : null}
                </div>

                {draftImageTokens.length > 0 ? (
                  <div className={Style.editorImageGallery}>
                    {draftImageTokens.map((image, imageIndex) => (
                      <figure key={`${image.url}-${imageIndex}`} className={Style.editorImageCard}>
                        {image.resolvedUrl ? (
                          <img src={image.resolvedUrl} alt={image.alt} />
                        ) : (
                          <div className={Style.editorImageMissing}>图片未找到</div>
                        )}
                        <figcaption>{image.alt}</figcaption>
                      </figure>
                    ))}
                  </div>
                ) : null}

                <Space size={8} breakLine>
                  <Button icon={<FileCopyIcon />} disabled={!draft.trim()} onClick={copyDraft}>
                    复制正文
                  </Button>
                  <Button
                    variant='outline'
                    loading={complianceChecking}
                    disabled={!draft.trim()}
                    onClick={rerunComplianceCheck}
                  >
                    发布前审核
                  </Button>
                  <Button theme='primary' onClick={() => navigate('/content-generation/articles')}>
                    去文章库编辑/发布
                  </Button>
                </Space>
                {renderCompliancePanel()}
              </Space>
            </div>

            {previewCollapsed ? (
              <div className={Style.collapsedHint}>实时预览已收起，点击“展开实时预览”查看渲染效果。</div>
            ) : (
              <div className={Style.finalArticlePreview}>{renderMarkdownProduct(draft, images)}</div>
            )}
          </div>
        </Card>
      ) : (
        <Card bordered={false} className={Style.sectionCard}>
          <div className={Style.collapsedHint}>请选择一篇成品文章，进入当前文章工作台。</div>
        </Card>
      )}

      <Dialog
        visible={confirmOpen}
        header='确认生成文章'
        onClose={() => !loading && setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={runGenerate}
        closeBtn={!loading}
        closeOnEscKeydown={!loading}
        closeOnOverlayClick={!loading}
        confirmBtn={{
          content: `确认扣除 ${articleGenerationCost.toLocaleString('zh-CN')} 积分并生成`,
          loading,
        }}
        cancelBtn={{ content: '取消', disabled: loading }}
      >
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <div style={{ color: 'var(--td-text-color-primary)', lineHeight: 1.7 }}>
            本次将执行「{GENERATE_MODE_OPTIONS.find((item) => item.value === generateMode)?.label || '文章生成'}
            」并保存文章结果， 成功后扣除 <strong>{articleGenerationCost.toLocaleString('zh-CN')} 积分</strong>。
          </div>
          <Space size={8} breakLine>
            <Tag theme='primary' variant='light'>
              当前可用积分：
              {availableCredits === null ? '未知' : availableCredits.toLocaleString('zh-CN')}
            </Tag>
            <Tag theme='warning' variant='light'>
              本次消耗：{articleGenerationCost.toLocaleString('zh-CN')} 积分
            </Tag>
            <Tag theme='success' variant='light'>
              预计生成：{generateMode === 'basic' ? normalizedGenerateCount : 1} 篇
            </Tag>
          </Space>
          <div style={{ color: 'var(--td-text-color-secondary)', fontSize: 12, lineHeight: 1.7 }}>
            如果生成失败，系统会释放预占积分；基础生成会按实际成功入库篇数结算。
          </div>
        </Space>
      </Dialog>
    </div>
  );
};

export default Generate;
