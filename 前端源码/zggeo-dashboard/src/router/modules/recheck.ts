import { lazy } from 'react';
import { RefreshIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const recheck: IRouter[] = [
  {
    path: '/recheck',
    meta: {
      title: '回测闭环',
      Icon: RefreshIcon,
    },
    children: [
      {
        path: 'tasks',
        Component: lazy(() => import('pages/Recheck/Tasks')),
        meta: {
          title: '复测任务',
        },
      },
      {
        path: 'curve',
        Component: lazy(() => import('pages/Recheck/Curve')),
        meta: {
          title: '效果曲线',
        },
      },
      {
        path: 'compare',
        Component: lazy(() => import('pages/Recheck/Compare')),
        meta: {
          title: '前后对比',
        },
      },
      {
        path: 'attribution',
        Component: lazy(() => import('pages/Recheck/Attribution')),
        meta: {
          title: '归因分析',
        },
      },
    ],
  },
];

export default recheck;
