import { lazy } from 'react';
import { MoneyIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const billing: IRouter[] = [
  {
    path: '/billing',
    meta: {
      title: '商业化',
      Icon: MoneyIcon,
    },
    children: [
      {
        path: 'plans',
        Component: lazy(() => import('pages/Billing/Plans')),
        meta: {
          title: '套餐 / 权益',
        },
      },
      {
        path: 'credits',
        Component: lazy(() => import('pages/Billing/Credits')),
        meta: {
          title: '点数账户',
        },
      },
      {
        path: 'pay',
        Component: lazy(() => import('pages/Billing/Pay')),
        meta: {
          title: '支付中心',
        },
      },
      {
        path: 'consumption',
        Component: lazy(() => import('pages/Billing/Consumption')),
        meta: {
          title: '消耗明细',
        },
      },
    ],
  },
];

export default billing;
