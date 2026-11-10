import { lazy } from 'react';
import { UsergroupIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const funnel: IRouter[] = [
  {
    path: '/funnel',
    meta: {
      title: '客户与预诊',
      Icon: UsergroupIcon,
    },
    children: [
      {
        path: 'leads',
        Component: lazy(() => import('pages/Funnel/Leads')),
        meta: {
          title: '留资线索',
        },
      },
      {
        path: 'kanban',
        Component: lazy(() => import('pages/Funnel/Kanban')),
        meta: {
          title: '跟进看板',
        },
      },
      {
        path: 'customers',
        Component: lazy(() => import('pages/Funnel/Customers')),
        meta: {
          title: '客户资产',
        },
      },
      {
        path: 'notify',
        Component: lazy(() => import('pages/Funnel/Notify')),
        meta: {
          title: '线索通知',
        },
      },
    ],
  },
];

export default funnel;
