import React, { lazy } from 'react';
import { BrowserRouterProps } from 'react-router-dom';
import overview from './modules/overview';
import keyword from './modules/keyword';
import visibility from './modules/visibility';
import funnel from './modules/funnel';
import monitoring from './modules/monitoring';
import reports from './modules/reports';
import content from './modules/content';
import contentGeneration from './modules/contentGeneration';
import distribution from './modules/distribution';
import recheck from './modules/recheck';
import agents from './modules/agents';
import billing from './modules/billing';
import ops from './modules/ops';
import analytics from './modules/analytics';
import system from './modules/system';
import user from './modules/user';
import login from './modules/login';
import otherRoutes from './modules/others';

export interface IRouter {
  path: string;
  redirect?: string;
  Component?: React.FC<BrowserRouterProps> | (() => any);
  /**
   * 当前路由是否全屏显示
   */
  isFullPage?: boolean;
  /**
   * meta未赋值 路由不显示到菜单中
   */
  meta?: {
    title?: string;
    Icon?: React.FC;
    /**
     * 侧边栏隐藏该路由
     */
    hidden?: boolean;
    /**
     * 单层路由
     */
    single?: boolean;
  };
  children?: IRouter[];
}

const routes: IRouter[] = [
  // 旧链接兼容：/login 仍可直接访问（login.ts 注册的是 /login/index）
  {
    path: '/login',
    Component: lazy(() => import('pages/Login')),
    isFullPage: true,
    meta: {
      hidden: true,
    },
  },
  {
    path: '/',
    redirect: '/overview/index',
  },
];

const allRoutes = [
  ...routes,
  ...overview,
  ...keyword,
  ...visibility,
  ...funnel,
  ...monitoring,
  ...reports,
  ...content,
  ...contentGeneration,
  ...distribution,
  ...recheck,
  ...agents,
  ...billing,
  ...ops,
  ...analytics,
  ...system,
  ...user, // /user/index 个人中心
  ...login, // /login/index 登录中心（模板老链接兼容）
  ...otherRoutes, // 注意：otherRoutes 里有 path: '*' 的 404 兜底，必须放最后
];

export default allRoutes;
