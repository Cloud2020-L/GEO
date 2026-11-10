import { lazy } from 'react';
import { SendIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const distribution: IRouter[] = [
  {
    path: '/distribution',
    meta: {
      title: '分发执行',
      Icon: SendIcon,
    },
    children: [
      {
        path: 'publishing-tasks',
        Component: lazy(() => import('pages/Distribution/PublishingTasks')),
        meta: {
          title: '发布任务台',
        },
      },
      {
        path: 'market',
        Component: lazy(() => import('pages/Distribution/Market')),
        meta: {
          title: '媒体市场',
        },
      },
      {
        path: 'media-box',
        Component: lazy(() => import('pages/Placeholder')),
        meta: {
          title: '媒介盒子',
        },
      },
      {
        path: 'accounts',
        Component: lazy(() => import('pages/Distribution/Accounts')),
        meta: {
          title: '自媒体号池',
        },
      },
      {
        path: 'personal',
        Component: lazy(() => import('pages/Distribution/Personal')),
        meta: {
          title: '个人自媒体',
        },
      },
      {
        path: 'wechat',
        Component: lazy(() => import('pages/Distribution/Wechat')),
        meta: {
          title: '公众号发稿',
        },
      },
      {
        path: 'providers',
        Component: lazy(() => import('pages/Distribution/Providers')),
        meta: {
          title: '平台配置',
        },
      },
      {
        path: 'history',
        Component: lazy(() => import('pages/Distribution/History')),
        meta: {
          title: '发稿记录',
        },
      },
    ],
  },
];

export default distribution;
