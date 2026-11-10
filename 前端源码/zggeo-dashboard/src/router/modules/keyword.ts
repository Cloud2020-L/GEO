import { lazy } from 'react';
import { SearchIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const keyword: IRouter[] = [
  {
    path: '/keyword-system',
    meta: {
      title: '目标关键词系统',
      Icon: SearchIcon,
    },
    children: [
      {
        path: 'leads-new',
        Component: lazy(() => import('pages/Funnel/Leads')),
        meta: {
          title: '留资线索NEW',
        },
      },
      {
        path: 'customer-assets-new',
        Component: lazy(() => import('pages/Funnel/Customers')),
        meta: {
          title: '客户资产NEW',
        },
      },
      {
        path: 'keyword-expansion',
        Component: lazy(() => import('pages/Keyword/Expansion')),
        meta: {
          title: '拓展关键词',
        },
      },
      {
        path: 'prompt-inventory',
        Component: lazy(() => import('pages/Keyword/Prompts')),
        meta: {
          title: 'Prompt库存',
        },
      },
    ],
  },
];

export default keyword;
