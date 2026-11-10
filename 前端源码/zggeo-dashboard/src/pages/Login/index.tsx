import React, { memo } from 'react';
import classNames from 'classnames';
import { Tabs } from 'tdesign-react';
import Login from './components/Login';
import Register from './components/Register';
import LoginHeader from './components/Header';
import { useAppSelector } from 'modules/store';
import { selectGlobal } from 'modules/global';
import { isClientPortal } from 'configs/portal';

import Style from './index.module.less';

const { TabPanel } = Tabs;

export default memo(() => {
  const globalState = useAppSelector(selectGlobal);
  const { theme } = globalState;

  return (
    <div
      className={classNames(Style.loginWrapper, { [Style.light]: theme === 'light', [Style.dark]: theme !== 'light' })}
    >
      <LoginHeader />
      <div className={Style.loginContainer}>
        <div className={Style.authPanel}>
          <div className={Style.authEyebrow}>Secure Access</div>
          <div className={Style.authTitle}>{isClientPortal ? '客户注册 / 登录' : '超级管理员登录'}</div>
          <div className={Style.authDesc}>
            {isClientPortal
              ? '新客户可注册独立客户空间；已有客户直接登录。'
              : '仅内部管理员和员工使用，客户账号请使用客户前端。'}
          </div>
          {isClientPortal ? (
            <Tabs defaultValue='login' className={Style.authTabs}>
              <TabPanel value='login' label='客户登录'>
                <Login />
              </TabPanel>
              <TabPanel value='register' label='客户注册'>
                <Register />
              </TabPanel>
            </Tabs>
          ) : (
            <Login />
          )}
        </div>
      </div>
      <footer className={Style.copyright}>Copyright © 2026-{new Date().getFullYear()} 智改GEO</footer>
    </div>
  );
});
