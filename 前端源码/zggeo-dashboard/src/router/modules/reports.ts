import { lazy } from 'react';
import { FileCopyIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const reports: IRouter[] = [
  {
    path: '/reports',
    meta: {
      title: '产品化报告',
      Icon: FileCopyIcon,
    },
    children: [
      {
        path: 'scoring',
        Component: lazy(() => import('pages/Reports/Detail')),
        meta: {
          title: '评分报告',
        },
      },
      {
        path: 'grades',
        Component: lazy(() => import('pages/Reports/Grades')),
        meta: {
          title: '等级分布',
        },
      },
      {
        path: 'suggestions',
        Component: lazy(() => import('pages/Reports/Suggestions')),
        meta: {
          title: '改进建议',
        },
      },
      {
        path: 'export',
        Component: lazy(() => import('pages/Reports/Export')),
        meta: {
          title: '报告导出',
        },
      },
    ],
  },
];

export default reports;
