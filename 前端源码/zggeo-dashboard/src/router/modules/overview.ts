import { lazy } from 'react';
import { DashboardIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const overview: IRouter[] = [
  {
    path: '/overview',
    meta: {
      title: '首页',
      Icon: DashboardIcon,
      single: true,
    },
    children: [
      {
        path: 'index',
        Component: lazy(() => import('pages/Overview')),
        meta: {
          title: '首页',
        },
      },
    ],
  },
];

export default overview;
