import { lazy } from 'react';
import { ChartIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const analytics: IRouter[] = [
  {
    path: '/analytics',
    meta: {
      title: '数据分析',
      Icon: ChartIcon,
    },
    children: [
      {
        path: 'coverage',
        Component: lazy(() => import('pages/Analytics/Coverage')),
        meta: {
          title: '覆盖率趋势',
        },
      },
      {
        path: 'ranking',
        Component: lazy(() => import('pages/Analytics/Ranking')),
        meta: {
          title: '竞品排名',
        },
      },
      {
        path: 'export',
        Component: lazy(() => import('pages/Analytics/Export')),
        meta: {
          title: '数据导出',
        },
      },
    ],
  },
];

export default analytics;
