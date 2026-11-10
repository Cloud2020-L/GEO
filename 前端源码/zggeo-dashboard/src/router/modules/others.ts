import { lazy } from 'react';
import { IRouter } from '../index';

const otherRoutes: IRouter[] = [
  {
    path: '/preview/agent-ui',
    Component: lazy(() => import('pages/Preview/AgentUI')),
    isFullPage: true,
    meta: {
      title: 'Agent UI 预览',
      hidden: true,
    },
  },
  {
    path: '/preview/overview-live',
    Component: lazy(() => import('pages/Preview/OverviewLive')),
    isFullPage: true,
    meta: {
      title: '首页真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/autopilot-live',
    Component: lazy(() => import('pages/Preview/AutopilotWorkbenchLive')),
    isFullPage: true,
    meta: {
      title: '自动运作中心真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/autopilot-panel-live',
    Component: lazy(() => import('pages/Preview/AutopilotLive')),
    isFullPage: true,
    meta: {
      title: '自动运作中心面板预览',
      hidden: true,
    },
  },
  {
    path: '/preview/autopilot-workbench-live',
    Component: lazy(() => import('pages/Preview/AutopilotWorkbenchLive')),
    isFullPage: true,
    meta: {
      title: '自动运作中心带壳预览',
      hidden: true,
    },
  },
  {
    path: '/preview/market-live',
    Component: lazy(() => import('pages/Preview/MarketLive')),
    isFullPage: true,
    meta: {
      title: '媒体市场真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/distribution-accounts-live',
    Component: lazy(() => import('pages/Preview/DistributionAccountsLive')),
    isFullPage: true,
    meta: {
      title: '自媒体号池真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/distribution-history-live',
    Component: lazy(() => import('pages/Preview/DistributionHistoryLive')),
    isFullPage: true,
    meta: {
      title: '发稿记录真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/distribution-personal-live',
    Component: lazy(() => import('pages/Preview/DistributionPersonalLive')),
    isFullPage: true,
    meta: {
      title: '个人自媒体真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/distribution-providers-live',
    Component: lazy(() => import('pages/Preview/DistributionProvidersLive')),
    isFullPage: true,
    meta: {
      title: '第三方平台配置真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/distribution-wechat-live',
    Component: lazy(() => import('pages/Preview/DistributionWechatLive')),
    isFullPage: true,
    meta: {
      title: '公众号发稿真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/content-tasks-live',
    Component: lazy(() => import('pages/Preview/ContentTasksLive')),
    isFullPage: true,
    meta: {
      title: '写作任务池真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/content-generate-live',
    Component: lazy(() => import('pages/Preview/ContentGenerateLive')),
    isFullPage: true,
    meta: {
      title: 'AI文章生成真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/content-knowledge-live',
    Component: lazy(() => import('pages/Preview/ContentKnowledgeLive')),
    isFullPage: true,
    meta: {
      title: '品牌知识库真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/content-prompts-live',
    Component: lazy(() => import('pages/Preview/ContentPromptsLive')),
    isFullPage: true,
    meta: {
      title: 'Prompt库真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/reports-scoring-live',
    Component: lazy(() => import('pages/Preview/ReportsScoringLive')),
    isFullPage: true,
    meta: {
      title: '评分报告真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/reports-grades-live',
    Component: lazy(() => import('pages/Preview/ReportsGradesLive')),
    isFullPage: true,
    meta: {
      title: '等级分布真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/reports-suggestions-live',
    Component: lazy(() => import('pages/Preview/ReportsSuggestionsLive')),
    isFullPage: true,
    meta: {
      title: '改进建议真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/reports-export-live',
    Component: lazy(() => import('pages/Preview/ReportsExportLive')),
    isFullPage: true,
    meta: {
      title: '报告导出真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/monitoring-brands-live',
    Component: lazy(() => import('pages/Preview/MonitoringBrandsLive')),
    isFullPage: true,
    meta: {
      title: '品牌词管理真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/monitoring-questions-live',
    Component: lazy(() => import('pages/Preview/MonitoringQuestionsLive')),
    isFullPage: true,
    meta: {
      title: '问题库管理真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/monitoring-tasks-live',
    Component: lazy(() => import('pages/Preview/MonitoringTasksLive')),
    isFullPage: true,
    meta: {
      title: '监测任务真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/monitoring-geo-assets-live',
    Component: lazy(() => import('pages/Preview/MonitoringGeoAssetsLive')),
    isFullPage: true,
    meta: {
      title: 'GEO资产生成真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/monitoring-compare-live',
    Component: lazy(() => import('pages/Preview/MonitoringCompareLive')),
    isFullPage: true,
    meta: {
      title: '横向对比真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/monitoring-calibration-live',
    Component: lazy(() => import('pages/Preview/MonitoringCalibrationLive')),
    isFullPage: true,
    meta: {
      title: 'A/B校准真实预览',
      hidden: true,
    },
  },
  {
    path: '/preview/monitoring-history-live',
    Component: lazy(() => import('pages/Preview/MonitoringHistoryLive')),
    isFullPage: true,
    meta: {
      title: '历史任务真实预览',
      hidden: true,
    },
  },
  {
    path: '/403',
    Component: lazy(() => import('pages/Result/403')),
  },
  {
    path: '/500',
    Component: lazy(() => import('pages/Result/500')),
  },
  {
    path: '*',
    Component: lazy(() => import('pages/Result/404')),
  },
];

export default otherRoutes;
