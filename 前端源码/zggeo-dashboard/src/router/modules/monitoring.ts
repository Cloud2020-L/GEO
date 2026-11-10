import { lazy } from 'react';
import { SearchIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const monitoring: IRouter[] = [
  {
    path: '/monitoring',
    meta: {
      title: '监测诊断',
      Icon: SearchIcon,
    },
    children: [
      {
        path: 'brands',
        Component: lazy(() => import('pages/Monitoring/Brands')),
        meta: {
          title: '品牌词管理',
        },
      },
      {
        path: 'questions',
        Component: lazy(() => import('pages/Monitoring/Questions')),
        meta: {
          title: '问题库管理',
        },
      },
      {
        path: 'tasks',
        Component: lazy(() => import('pages/Monitoring/Tasks')),
        meta: {
          title: '监测任务',
        },
      },
      {
        path: 'geo-assets',
        Component: lazy(() => import('pages/Monitoring/GeoAssets')),
        meta: {
          title: 'GEO资产生成',
        },
      },
      {
        path: 'contact-governance',
        Component: lazy(() => import('pages/Monitoring/ContactGovernance')),
        meta: {
          title: '联系方式治理',
        },
      },
      {
        path: 'compare',
        Component: lazy(() => import('pages/Monitoring/Compare')),
        meta: {
          title: '8 模型对比',
        },
      },
      {
        path: 'calibration',
        Component: lazy(() => import('pages/Monitoring/Calibration')),
        meta: {
          title: 'A/B 校准',
        },
      },
      {
        path: 'history',
        Component: lazy(() => import('pages/Monitoring/History')),
        meta: {
          title: '历史任务',
        },
      },
    ],
  },
];

export default monitoring;
