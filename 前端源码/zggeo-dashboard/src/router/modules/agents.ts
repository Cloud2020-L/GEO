import { lazy } from 'react';
import { AppIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const agents: IRouter[] = [
  {
    path: '/agents',
    meta: {
      title: 'Agent 矩阵引擎',
      Icon: AppIcon,
    },
    children: [
      {
        path: 'autopilot',
        Component: lazy(() => import('pages/Agents/Autopilot')),
        meta: {
          title: '星链 · 自动运作中心',
        },
      },
      {
        path: 'scheduler',
        Component: lazy(() => import('pages/Agents/Scheduler')),
        meta: {
          title: '星枢 · 调度',
        },
      },
      {
        path: 'explorer',
        Component: lazy(() => import('pages/Agents/Explorer')),
        meta: {
          title: '星图 · 执行',
        },
      },
      {
        path: 'scorer',
        Component: lazy(() => import('pages/Agents/Scorer')),
        meta: {
          title: '星核 · 评分',
        },
      },
      {
        path: 'calibrator',
        Component: lazy(() => import('pages/Agents/Calibrator')),
        meta: {
          title: '星穹 · 校准',
        },
      },
    ],
  },
];

export default agents;
