import React from 'react';
import { Button } from 'tdesign-react';
import { HelpCircleIcon, SettingIcon } from 'tdesign-icons-react';
import { useAppDispatch } from 'modules/store';
import { toggleSetting } from 'modules/global';

import Style from './index.module.less';

export default function Header() {
  const dispatch = useAppDispatch();

  const navToHelper = () => {
    window.open('https://example.com');
  };

  const toggleSettingPanel = () => {
    dispatch(toggleSetting());
  };

  return (
    <div>
      <header className={Style.loginHeader}>
        <div className={Style.logo}>
          <span>Z</span>GEO <em>智改</em>
        </div>
        <div className={Style.operationsContainer}>
          <Button
            className={Style.operationsButton}
            theme='default'
            shape='square'
            variant='text'
            onClick={navToHelper}
          >
            <HelpCircleIcon className={Style.icon} />
          </Button>
          <Button
            className={Style.operationsButton}
            theme='default'
            shape='square'
            variant='text'
            onClick={toggleSettingPanel}
          >
            <SettingIcon className={Style.icon} />
          </Button>
        </div>
      </header>
    </div>
  );
}
