import { ReportResponse } from 'services/zggeo-api';

export interface WritingTask {
  id: string;
  title: string;
  brand: string;
  domain: string;
  keyword: string;
  channel: string;
  angle: string;
  priority: '高' | '中' | '低';
  status: '待生成' | '已生成' | '待审核' | '可分发';
  source: string;
  outline: string[];
  created_at: string;
  updated_at: string;
}

export interface BrandKnowledgeItem {
  id: string;
  title: string;
  type: '品牌定位' | '产品卖点' | '客户案例' | '禁用表达' | 'FAQ' | '证据素材';
  content: string;
  tags: string[];
  updated_at: string;
}

export interface ArticleDraft {
  id: string;
  task_id?: string;
  title: string;
  channel: string;
  body: string;
  status: '草稿' | '待审核' | '可分发';
  created_at: string;
}

export const WRITING_TASKS_KEY = 'example.com.v1';
export const BRAND_KNOWLEDGE_KEY = 'example.com.v1';
export const ARTICLE_DRAFTS_KEY = 'example.com.v1';

export const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export const channels = ['官网文章', '公众号', '今日头条', '百家号', '知乎专栏', '小红书', '媒体通稿'];

export const defaultKnowledge: BrandKnowledgeItem[] = [
  {
    id: 'bk_position',
    title: 'ZGEO 智改定位',
    type: '品牌定位',
    content: 'ZGEO 智改是面向企业的 AI 可见度管理后台，帮助品牌完成诊断、内容生产、分发执行、回测闭环和商业化交付。',
    tags: ['品牌', '定位', 'GEO'],
    updated_at: new Date().toISOString(),
  },
  {
    id: 'bk_selling_points',
    title: '核心卖点',
    type: '产品卖点',
    content:
      '一键诊断 AI 可见度、自动生成 llms.txt/Schema、输出客户报告、沉淀内容任务、对接媒体分发，并用复测闭环证明优化效果。',
    tags: ['卖点', '诊断', '交付'],
    updated_at: new Date().toISOString(),
  },
  {
    id: 'bk_forbidden',
    title: '内容合规边界',
    type: '禁用表达',
    content:
      '不要承诺绝对排名、不要伪造专家背书、不要写虚假案例、不要宣称百分百被 AI 引用。优先使用“提升概率、增强可读性、完善实体信号”等表达。',
    tags: ['合规', '禁用'],
    updated_at: new Date().toISOString(),
  },
];

export function buildTasksFromReports(reports: ReportResponse[]): WritingTask[] {
  return reports.slice(0, 12).flatMap((report, reportIndex) => {
    const gaps = report.top_issues?.length ? report.top_issues : report.report_json?.content_gap || [];
    const fixes = report.top_fixes?.length ? report.top_fixes : report.report_json?.quick_fix_suggestions || [];
    const keywords = report.keywords?.length ? report.keywords : ['AI 可见度', 'GEO 优化', report.project_name];
    return gaps.slice(0, 2).map((gap, index) => {
      const keyword = keywords[(reportIndex + index) % keywords.length] || report.project_name;
      const title = `${report.project_name}：围绕“${keyword}”补齐 AI 可见度内容缺口`;
      return {
        id: `report_${report.report_id}_${index}`,
        title,
        brand: report.project_name,
        domain: report.domain,
        keyword,
        channel: index % 2 === 0 ? '官网文章' : '公众号',
        angle: String(gap),
        priority: report.total_score < 60 ? '高' : report.total_score < 80 ? '中' : '低',
        status: '待生成',
        source: `诊断报告 ${report.report_id.slice(0, 8)}`,
        outline: [
          `开头解释用户为什么会搜索“${keyword}”`,
          `指出当前内容缺口：${gap}`,
          `给出修复方向：${fixes[index] || '补充结构化 FAQ、证据和清晰结论'}`,
          '加入品牌可信证据、适用场景和行动建议',
        ],
        created_at: report.created_at,
        updated_at: new Date().toISOString(),
      } as WritingTask;
    });
  });
}

export function generateArticle(task: WritingTask, knowledge: BrandKnowledgeItem[]) {
  const brandFacts = knowledge.filter((item) => item.type !== '禁用表达').slice(0, 4);
  const compliance = knowledge.find((item) => item.type === '禁用表达');
  const facts = brandFacts.map((item) => `- ${item.title}：${item.content}`).join('\n');
  const outline = task.outline.map((item, index) => `${index + 1}. ${item}`).join('\n');

  return `# ${task.title}

## 导语
当用户在搜索引擎或 AI 问答里询问“${task.keyword}”时，AI 更倾向引用结构清晰、证据完整、结论明确的页面。${
    task.brand
  } 需要把这类内容从普通介绍升级为可被 AI 理解、引用和复述的专题内容。

## 内容机会
当前优先处理的缺口是：${task.angle}。这类问题会影响页面被搜索引擎抓取、被大模型理解，以及被潜在客户信任的概率。

## 建议写作结构
${outline}

## 品牌与证据素材
${facts || '- 暂无品牌素材，请先到品牌知识库补充定位、卖点、案例和 FAQ。'}

## 推荐正文
${task.brand} 可以围绕“${
    task.keyword
  }”建立一篇可交付文章。文章第一段先直接回答用户最关心的问题，第二段解释为什么这个问题会影响 AI 可见度，第三段给出可执行方法，最后用 FAQ 和结构化数据增强机器可读性。

在官网文章场景里，建议加入清晰的 H2/H3、FAQ、案例证据和服务入口；在公众号或自媒体场景里，建议用更强的场景化标题、痛点开头和行动清单。这样既能服务真人阅读，也能让 AI 抓到稳定的实体、关键词、解决方案和品牌信号。

## FAQ
### 什么是 ${task.keyword} 的内容优化重点？
重点不是堆关键词，而是让页面拥有明确答案、可信证据、结构化标题和可复用的结论。

### 为什么要和 GEO 诊断配合？
诊断负责发现缺口，内容生产负责补齐缺口，复测闭环负责证明优化是否带来可见度变化。

### 发布前要注意什么？
${compliance?.content || '避免夸大承诺，确保案例、数据和品牌背书真实可验证。'}
`;
}
