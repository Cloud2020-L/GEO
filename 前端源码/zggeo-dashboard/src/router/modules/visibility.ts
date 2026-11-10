import { lazy } from 'react';
import { ChartIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const visibility: IRouter[] = [
  {
    path: '/visibility-monitoring',
    meta: {
      title: '可见度监测系统',
      Icon: ChartIcon,
    },
    children: [
      {
        path: 'diagnosis',
        Component: lazy(() => import('pages/Monitoring/Tasks')),
        meta: {
          title: '基础诊断',
        },
      },
      {
        path: 'diagnosis/report',
        Component: lazy(() => import('pages/Reports/Detail')),
        meta: {
          title: '基础诊断报告',
          hidden: true,
        },
      },
      {
        path: 'model-visibility',
        Component: lazy(() => import('pages/Monitoring/Compare')),
        meta: {
          title: '模型对比NEW',
        },
      },
      {
        path: 'geo-assets-new',
        Component: lazy(() => import('pages/Monitoring/GeoAssets')),
        meta: {
          title: 'GEO监测系统NEW - 导入资料',
          hidden: true,
        },
      },
      {
        path: 'geo-assets-new/import',
        Component: lazy(() => import('pages/Monitoring/GeoAssets')),
        meta: {
          title: 'GEO监测系统NEW - 导入资料',
        },
      },
      {
        path: 'geo-assets-new/base',
        Component: lazy(() => import('pages/Monitoring/GeoAssets')),
        meta: {
          title: 'GEO监测系统NEW - 生成基础资料',
        },
      },
      {
        path: 'geo-assets-new/audit',
        Component: lazy(() => import('pages/Monitoring/GeoAssets')),
        meta: {
          title: 'GEO监测系统NEW - 体检与抓取',
        },
      },
      {
        path: 'geo-assets-new/competitors',
        Component: lazy(() => import('pages/Monitoring/GeoAssets')),
        meta: {
          title: 'GEO监测系统NEW - 竞品对比',
        },
      },
      {
        path: 'geo-assets-new/report',
        Component: lazy(() => import('pages/Monitoring/GeoAssets')),
        meta: {
          title: 'GEO监测系统NEW - 导出报告',
        },
      },
      {
        path: 'geo-assets-new/deployment',
        Component: lazy(() => import('pages/Monitoring/GeoAssets')),
        meta: {
          title: 'GEO监测系统NEW - 生成部署包',
        },
      },
      {
        path: 'geo-assets-new/monitoring',
        Component: lazy(() => import('pages/Monitoring/GeoAssets')),
        meta: {
          title: 'GEO监测系统NEW - 持久监控',
        },
      },
      {
        path: 'geo-assets-new/contact-governance',
        Component: lazy(() => import('pages/Monitoring/ContactGovernance')),
        meta: {
          title: 'GEO监测系统NEW - 联系方式治理',
        },
      },
      {
        path: 'questions',
        Component: lazy(() => import('pages/Monitoring/Questions')),
        meta: {
          title: '问题库NEW',
        },
      },
      {
        path: 'source-preferences',
        Component: lazy(() => import('pages/Monitoring/SourcePreferences')),
        meta: {
          title: 'AI引用偏好NEW',
        },
      },
    ],
  },
];

export default visibility;
