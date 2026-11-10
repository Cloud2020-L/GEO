import type { FC } from 'react';
import {
  AppIcon,
  ChartIcon,
  DashboardIcon,
  EditIcon,
  MoneyIcon,
  SearchIcon,
  SendIcon,
  SettingIcon,
  UsergroupIcon,
} from 'tdesign-icons-react';

export interface SidebarNavLeaf {
  title: string;
  path: string;
  clientOnly?: boolean;
  adminOnly?: boolean;
  allowedRoles?: string[];
}

export interface SidebarNavSubGroup {
  title: string;
  items: SidebarNavLeaf[];
  clientOnly?: boolean;
  adminOnly?: boolean;
  allowedRoles?: string[];
}

export interface SidebarNavGroup {
  title: string;
  Icon?: FC;
  items: Array<SidebarNavLeaf | SidebarNavSubGroup>;
  clientOnly?: boolean;
  adminOnly?: boolean;
}

export type SidebarNavNode =
  | {
      type: 'item';
      title: string;
      path: string;
      Icon?: FC;
      clientOnly?: boolean;
      adminOnly?: boolean;
      allowedRoles?: string[];
    }
  | {
      type: 'group';
      title: string;
      Icon?: FC;
      items: Array<SidebarNavLeaf | SidebarNavSubGroup>;
      clientOnly?: boolean;
      adminOnly?: boolean;
      allowedRoles?: string[];
    };

export const SIDEBAR_NAVIGATION: SidebarNavNode[] = [
  { type: 'item', title: '首页', path: '/overview/index', Icon: DashboardIcon },
  {
    type: 'group',
    title: 'Agent 矩阵引擎',
    Icon: AppIcon,
    items: [
      { title: '星链 · 自动运作中心', path: '/agents/autopilot' },
      { title: '星枢 · 调度', path: '/agents/scheduler' },
      { title: '星图 · 执行', path: '/agents/explorer' },
      { title: '星核 · 评分', path: '/agents/scorer' },
      { title: '星穹 · 校准', path: '/agents/calibrator' },
    ],
  },
  {
    type: 'group',
    title: '目标关键词系统',
    Icon: SearchIcon,
    items: [
      { title: '客户资产NEW', path: '/keyword-system/customer-assets-new' },
      { title: '留资线索NEW', path: '/keyword-system/leads-new' },
      { title: '拓展关键词', path: '/keyword-system/keyword-expansion' },
      { title: 'Prompt库存', path: '/keyword-system/prompt-inventory' },
    ],
  },
  {
    type: 'group',
    title: '可见度监测系统',
    Icon: ChartIcon,
    items: [
      { title: '基础诊断', path: '/visibility-monitoring/diagnosis' },
      {
        title: 'GEO监测系统NEW',
        items: [
          { title: '导入资料', path: '/visibility-monitoring/geo-assets-new/import' },
          { title: '生成基础资料', path: '/visibility-monitoring/geo-assets-new/base' },
          { title: '体检与抓取', path: '/visibility-monitoring/geo-assets-new/audit' },
          { title: '竞品对比', path: '/visibility-monitoring/geo-assets-new/competitors' },
          { title: '导出报告', path: '/visibility-monitoring/geo-assets-new/report' },
          { title: '生成部署包', path: '/visibility-monitoring/geo-assets-new/deployment' },
          { title: '持久监控', path: '/visibility-monitoring/geo-assets-new/monitoring' },
          { title: '联系方式治理', path: '/visibility-monitoring/geo-assets-new/contact-governance' },
        ],
      },
      { title: '模型对比NEW', path: '/visibility-monitoring/model-visibility' },
      { title: '问题库NEW', path: '/visibility-monitoring/questions' },
      { title: 'AI引用偏好NEW', path: '/visibility-monitoring/source-preferences' },
    ],
  },
  {
    type: 'group',
    title: '客户与预诊（旧）',
    Icon: UsergroupIcon,
    adminOnly: true,
    items: [
      { title: '留资线索', path: '/funnel/leads' },
      { title: '线索通知', path: '/funnel/notify' },
      { title: '跟进看板', path: '/funnel/kanban' },
      { title: '客户资产', path: '/funnel/customers' },
      { title: '品牌资料', path: '/monitoring/brands' },
      { title: '问题库', path: '/monitoring/questions' },
    ],
  },
  {
    type: 'group',
    title: '客户自动交付（旧）',
    Icon: SearchIcon,
    adminOnly: true,
    items: [
      { title: '诊断任务', path: '/monitoring/tasks' },
      { title: 'GEO 资产', path: '/monitoring/geo-assets' },
      { title: '模型对比', path: '/monitoring/compare' },
      { title: 'A/B 校验', path: '/monitoring/calibration' },
      { title: '运行历史', path: '/monitoring/history' },
    ],
  },
  {
    type: 'group',
    title: '内容自动化（旧）',
    Icon: EditIcon,
    adminOnly: true,
    items: [
      { title: '品牌知识库', path: '/content/knowledge' },
      { title: 'Prompt 库', path: '/content/prompts' },
      { title: '内容任务', path: '/content/tasks' },
      { title: '图片管理', path: '/content/images' },
      { title: '文章生成', path: '/content/generate' },
      { title: '发布任务台', path: '/distribution/publishing-tasks' },
      { title: '渠道设置', path: '/distribution/providers' },
      { title: '账号池', path: '/distribution/accounts' },
      { title: '媒体市场', path: '/distribution/market' },
      { title: '自媒体发布', path: '/distribution/personal' },
      { title: '公众号发布', path: '/distribution/wechat' },
      { title: '发布记录', path: '/distribution/history' },
    ],
  },
  {
    type: 'group',
    title: '内容生成',
    Icon: EditIcon,
    items: [
      { title: '素材图片', path: '/content-generation/images' },
      { title: '文章生成NEW', path: '/content-generation/articles-new' },
      { title: '文章库', path: '/content-generation/articles' },
    ],
  },
  {
    type: 'group',
    title: '内容分发',
    Icon: SendIcon,
    items: [
      { title: '渠道设置', path: '/distribution/providers', adminOnly: true },
      { title: '账号池', path: '/distribution/accounts', adminOnly: true },
      { title: '发布任务台', path: '/distribution/publishing-tasks', adminOnly: true },
      { title: '媒体市场', path: '/distribution/market' },
      { title: '媒介盒子', path: '/distribution/media-box', adminOnly: true },
      { title: '自媒体发布', path: '/distribution/personal', adminOnly: true },
      { title: '公众号发布', path: '/distribution/wechat', adminOnly: true },
      { title: '发布记录', path: '/distribution/history', adminOnly: true },
    ],
  },
  {
    type: 'group',
    title: '交付与分析',
    Icon: ChartIcon,
    items: [
      { title: '评分报告', path: '/reports/scoring', adminOnly: true },
      { title: '等级分布', path: '/reports/grades', adminOnly: true },
      { title: '改进建议', path: '/reports/suggestions', adminOnly: true },
      { title: '报告导出', path: '/reports/export' },
      { title: '回测任务', path: '/recheck/tasks', adminOnly: true },
      { title: '效果曲线', path: '/recheck/curve', adminOnly: true },
      { title: '前后对比', path: '/recheck/compare', adminOnly: true },
      { title: '归因分析', path: '/recheck/attribution', adminOnly: true },
      { title: '数据分析', path: '/analytics/coverage', adminOnly: true },
      { title: '交付通知', path: '/ops/notify', adminOnly: true },
      { title: '部署记录', path: '/ops/deploy', adminOnly: true },
    ],
  },
  {
    type: 'group',
    title: '商业中心',
    Icon: MoneyIcon,
    items: [
      { title: '套餐 / 权益', path: '/billing/plans' },
      { title: '点数账户', path: '/billing/credits' },
      { title: '支付中心', path: '/billing/pay' },
      { title: '消耗明细', path: '/billing/consumption' },
    ],
  },
  {
    type: 'group',
    title: '系统治理',
    Icon: SettingIcon,
    adminOnly: true,
    items: [
      { title: '模型网关', path: '/system/model-gateway' },
      { title: '成员管理', path: '/system/users' },
      { title: '角色权限', path: '/system/permissions' },
      { title: 'API 密钥', path: '/system/apikeys' },
      { title: '审计日志', path: '/system/logs' },
      { title: '客户操作监控', path: '/system/observability' },
      { title: '系统健康', path: '/system/health' },
    ],
  },
];

type PortalScope = 'admin' | 'client';
type AccessNode = { clientOnly?: boolean; adminOnly?: boolean; allowedRoles?: string[] };
type NavigationChild = SidebarNavLeaf | SidebarNavSubGroup;

export const isVisibleInPortal = (node: AccessNode, scope: PortalScope, role?: string) => {
  if (scope === 'client') return !node.adminOnly;
  if (node.allowedRoles?.length) return node.allowedRoles.includes(String(role || '').toLowerCase());
  return !node.clientOnly;
};

const collectNavigationPaths = (
  children: Array<SidebarNavNode | NavigationChild>,
  scope: PortalScope,
  parentVisible = true,
): string[] =>
  children.flatMap((node) => {
    const visible = parentVisible && isVisibleInPortal(node, scope);
    if (!visible) return [];
    if ('path' in node) return [node.path];
    return collectNavigationPaths(node.items, scope, visible);
  });

export const getNavigationPaths = (scope: PortalScope) => collectNavigationPaths(SIDEBAR_NAVIGATION, scope);

export const CLIENT_NAVIGATION_PATHS = getNavigationPaths('client');

const CLIENT_EXTRA_ACCESS_PATHS = ['/reports/scoring'];

export const isClientNavigationPath = (pathname: string) =>
  [...CLIENT_NAVIGATION_PATHS, ...CLIENT_EXTRA_ACCESS_PATHS].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );

const BREADCRUMB_OVERRIDES: Array<{ prefix: string; items: string[] }> = [
  { prefix: '/overview', items: ['首页'] },
  { prefix: '/keyword-system/leads-new', items: ['目标关键词系统', '留资线索NEW'] },
  { prefix: '/keyword-system/customer-assets-new', items: ['目标关键词系统', '客户资产NEW'] },
  { prefix: '/keyword-system/keyword-expansion', items: ['目标关键词系统', '拓展关键词'] },
  { prefix: '/keyword-system/prompt-inventory', items: ['目标关键词系统', 'Prompt库存'] },
  { prefix: '/visibility-monitoring/diagnosis/report', items: ['可见度监测系统', '基础诊断', '报告'] },
  { prefix: '/visibility-monitoring/diagnosis', items: ['可见度监测系统', '基础诊断'] },
  { prefix: '/visibility-monitoring/questions', items: ['可见度监测系统', '问题库NEW'] },
  { prefix: '/visibility-monitoring/source-preferences', items: ['可见度监测系统', 'AI引用偏好NEW'] },
  { prefix: '/visibility-monitoring/geo-assets-new/import', items: ['可见度监测系统', 'GEO监测系统NEW', '导入资料'] },
  { prefix: '/visibility-monitoring/geo-assets-new/base', items: ['可见度监测系统', 'GEO监测系统NEW', '生成基础资料'] },
  { prefix: '/visibility-monitoring/geo-assets-new/audit', items: ['可见度监测系统', 'GEO监测系统NEW', '体检与抓取'] },
  {
    prefix: '/visibility-monitoring/geo-assets-new/competitors',
    items: ['可见度监测系统', 'GEO监测系统NEW', '竞品对比'],
  },
  { prefix: '/visibility-monitoring/geo-assets-new/report', items: ['可见度监测系统', 'GEO监测系统NEW', '导出报告'] },
  {
    prefix: '/visibility-monitoring/geo-assets-new/deployment',
    items: ['可见度监测系统', 'GEO监测系统NEW', '生成部署包'],
  },
  {
    prefix: '/visibility-monitoring/geo-assets-new/monitoring',
    items: ['可见度监测系统', 'GEO监测系统NEW', '持久监控'],
  },
  {
    prefix: '/visibility-monitoring/geo-assets-new/contact-governance',
    items: ['可见度监测系统', 'GEO监测系统NEW', '联系方式治理'],
  },
  { prefix: '/visibility-monitoring/geo-assets-new', items: ['可见度监测系统', 'GEO监测系统NEW'] },
  {
    prefix: '/visibility-monitoring/model-visibility',
    items: ['可见度监测系统', '模型对比NEW'],
  },
  { prefix: '/funnel/leads', items: ['客户与预诊', '留资线索'] },
  { prefix: '/funnel/kanban', items: ['客户与预诊', '跟进看板'] },
  { prefix: '/funnel/customers', items: ['客户与预诊', '客户资产'] },
  { prefix: '/funnel/notify', items: ['客户与预诊', '线索通知'] },
  { prefix: '/monitoring/brands', items: ['客户与预诊', '品牌资料'] },
  { prefix: '/monitoring/questions', items: ['客户与预诊', '问题库'] },
  { prefix: '/monitoring/tasks', items: ['客户自动交付', '诊断任务'] },
  { prefix: '/monitoring/geo-assets', items: ['客户自动交付', 'GEO 资产'] },
  { prefix: '/monitoring/compare', items: ['客户自动交付', '模型对比'] },
  { prefix: '/monitoring/calibration', items: ['客户自动交付', 'A/B 校验'] },
  { prefix: '/monitoring/history', items: ['客户自动交付', '运行历史'] },
  { prefix: '/content/tasks', items: ['内容自动化', '内容任务'] },
  { prefix: '/content/prompts', items: ['内容自动化', 'Prompt 库'] },
  { prefix: '/content/knowledge', items: ['内容自动化', '品牌知识库'] },
  { prefix: '/content/images', items: ['内容自动化', '图片管理'] },
  { prefix: '/content/generate', items: ['内容自动化', '文章生成'] },
  { prefix: '/content-generation/images', items: ['内容生成', '素材图片'] },
  { prefix: '/content-generation/articles-new', items: ['内容生成', '文章生成NEW'] },
  { prefix: '/content-generation/articles', items: ['内容生成', '文章库'] },
  { prefix: '/distribution/publishing-tasks', items: ['内容分发', '发布任务台'] },
  { prefix: '/distribution/market', items: ['内容分发', '媒体市场'] },
  { prefix: '/distribution/media-box', items: ['内容分发', '媒介盒子'] },
  { prefix: '/distribution/accounts', items: ['内容分发', '账号池'] },
  { prefix: '/distribution/personal', items: ['内容分发', '自媒体发布'] },
  { prefix: '/distribution/wechat', items: ['内容分发', '公众号发布'] },
  { prefix: '/distribution/providers', items: ['内容分发', '渠道设置'] },
  { prefix: '/distribution/history', items: ['内容分发', '发布记录'] },
  { prefix: '/agents/autopilot', items: ['Agent 矩阵引擎', '星链 · 自动运作中心'] },
  { prefix: '/agents/scheduler', items: ['Agent 矩阵引擎', '星枢 · 调度'] },
  { prefix: '/agents/explorer', items: ['Agent 矩阵引擎', '星图 · 执行'] },
  { prefix: '/agents/scorer', items: ['Agent 矩阵引擎', '星核 · 评分'] },
  { prefix: '/agents/calibrator', items: ['Agent 矩阵引擎', '星穹 · 校准'] },
  { prefix: '/reports/scoring', items: ['交付与分析', '评分报告'] },
  { prefix: '/reports/grades', items: ['交付与分析', '等级分布'] },
  { prefix: '/reports/suggestions', items: ['交付与分析', '改进建议'] },
  { prefix: '/reports/export', items: ['交付与分析', '报告导出'] },
  { prefix: '/recheck/tasks', items: ['交付与分析', '回测任务'] },
  { prefix: '/recheck/curve', items: ['交付与分析', '效果曲线'] },
  { prefix: '/recheck/compare', items: ['交付与分析', '前后对比'] },
  { prefix: '/recheck/attribution', items: ['交付与分析', '归因分析'] },
  { prefix: '/analytics/coverage', items: ['交付与分析', '数据分析'] },
  { prefix: '/analytics/ranking', items: ['交付与分析', '数据分析'] },
  { prefix: '/analytics/export', items: ['交付与分析', '数据分析'] },
  { prefix: '/ops/notify', items: ['交付与分析', '交付通知'] },
  { prefix: '/ops/deploy', items: ['交付与分析', '部署记录'] },
  { prefix: '/billing/plans', items: ['商业中心', '套餐 / 权益'] },
  { prefix: '/billing/credits', items: ['商业中心', '点数账户'] },
  { prefix: '/billing/pay', items: ['商业中心', '支付中心'] },
  { prefix: '/billing/consumption', items: ['商业中心', '消耗明细'] },
  { prefix: '/system/model-gateway', items: ['系统治理', '模型网关'] },
  { prefix: '/system/users', items: ['系统治理', '成员管理'] },
  { prefix: '/system/permissions', items: ['系统治理', '角色权限'] },
  { prefix: '/system/apikeys', items: ['系统治理', 'API 密钥'] },
  { prefix: '/system/logs', items: ['系统治理', '审计日志'] },
  { prefix: '/system/observability', items: ['系统治理', '客户操作监控'] },
  { prefix: '/system/health', items: ['系统治理', '系统健康'] },
  { prefix: '/user', items: ['个人中心'] },
];

export const resolveNavigationBreadcrumbs = (pathname: string, fallback?: string[]) => {
  const match = [...BREADCRUMB_OVERRIDES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((item) => pathname.startsWith(item.prefix));

  return match?.items || fallback || [];
};
