import { lazy } from 'react';
import { NotificationIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const ops: IRouter[] = [
  {
    path: '/ops',
    meta: {
      title: '运营交付',
      Icon: NotificationIcon,
    },
    children: [
      {
        path: 'notify',
        Component: lazy(() => import('pages/Ops/Notify')),
        meta: {
          title: '企微通知',
        },
      },
      {
        path: 'deploy',
        Component: lazy(() => import('pages/Ops/Deploy')),
        meta: {
          title: '部署记录',
        },
      },
    ],
  },
];

export default ops;
