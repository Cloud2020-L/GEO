import { lazy } from 'react';
import { SettingIcon } from 'tdesign-icons-react';
import { IRouter } from '../index';

const system: IRouter[] = [
  {
    path: '/system',
    meta: {
      title: '系统治理',
      Icon: SettingIcon,
    },
    children: [
      {
        path: 'model-gateway',
        Component: lazy(() => import('pages/Monitoring/Calibration')),
        meta: {
          title: '模型网关',
        },
      },
      {
        path: 'users',
        Component: lazy(() => import('pages/System/Users')),
        meta: {
          title: '成员管理',
        },
      },
      {
        path: 'permissions',
        Component: lazy(() => import('pages/System/Permissions')),
        meta: {
          title: '角色权限',
        },
      },
      {
        path: 'apikeys',
        Component: lazy(() => import('pages/System/ApiKeys')),
        meta: {
          title: 'API 密钥',
        },
      },
      {
        path: 'logs',
        Component: lazy(() => import('pages/System/Logs')),
        meta: {
          title: '审计日志',
        },
      },
      {
        path: 'observability',
        Component: lazy(() => import('pages/System/Observability')),
        meta: {
          title: '客户操作监控',
        },
      },
      {
        path: 'health',
        Component: lazy(() => import('pages/System/Health')),
        meta: {
          title: '系统健康',
        },
      },
    ],
  },
];

export default system;
