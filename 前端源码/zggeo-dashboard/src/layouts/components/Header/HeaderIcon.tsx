import React, { memo, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Popup, Badge, Dropdown, Space, Tag } from 'tdesign-react';
import { Icon, MailIcon, HelpCircleIcon, SettingIcon, PoweroffIcon, UserCircleIcon } from 'tdesign-icons-react';
import { useAppDispatch, useAppSelector } from 'modules/store';
import { toggleSetting } from 'modules/global';
import { logout } from 'modules/user';
import { listLeads } from 'services/zggeo-api';
import Style from './HeaderIcon.module.less';

const { DropdownMenu, DropdownItem } = Dropdown;

const ROLE_LABEL: Record<string, string> = {
  admin: '超级管理员',
  delivery: '交付运营',
  sales: '销售顾问',
  client: '客户会员',
};

export default memo(() => {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  // 从 Redux 读真实登录用户（没登录则显示"未登录"）
  const userInfo = useAppSelector((s) => s.user.userInfo) as Record<string, any>;
  const token = useAppSelector((s) => s.user.token);
  const displayName = userInfo?.name || userInfo?.email || '未登录';
  const role = String(userInfo?.role || '');
  const isLoggedIn = Boolean(token && token !== 'main_token');
  const [notifyCount, setNotifyCount] = useState(0);

  useEffect(() => {
    if (!isLoggedIn) {
      setNotifyCount(0);
      return undefined;
    }
    let mounted = true;
    listLeads()
      .then((leads) => {
        if (!mounted) return;
        const count = leads.filter((lead) => {
          const status = lead.notify_status || 'pending';
          return status === 'pending' || status === 'failed';
        }).length;
        setNotifyCount(count);
      })
      .catch(() => {
        if (mounted) setNotifyCount(0);
      });
    return () => {
      mounted = false;
    };
  }, [isLoggedIn]);

  const gotoWiki = () => {
    navigate('/overview/index');
  };

  const clickHandler = (data: any) => {
    if (data.value === 'profile') {
      navigate(isLoggedIn ? '/user/index' : '/login');
    }
  };
  const handleLogout = async () => {
    await dispatch(logout());
    // 路由表里只有 /login，没有 /login/index；别手滑
    navigate('/login');
  };

  return (
    <Space align='center'>
      <Popup content='线索通知' placement='bottom' showArrow destroyOnClose>
        <Badge
          className={Style.badge}
          count={notifyCount}
          dot={false}
          maxCount={99}
          shape='circle'
          showZero={false}
          size='medium'
        >
          <Button
            className={Style.menuIcon}
            shape='square'
            size='large'
            variant='text'
            onClick={() => navigate('/funnel/notify')}
            icon={<MailIcon />}
          />
        </Badge>
      </Popup>
      <Popup content='帮助文档' placement='bottom' showArrow destroyOnClose>
        <Button
          className={Style.menuIcon}
          shape='square'
          size='large'
          variant='text'
          onClick={gotoWiki}
          icon={<HelpCircleIcon />}
        />
      </Popup>
      <Dropdown trigger={'click'} onClick={clickHandler}>
        <Button variant='text' className={Style.dropdown}>
          <Icon name='user-circle' className={Style.icon} />
          <span className={Style.text}>{displayName}</span>
          {isLoggedIn && role && (
            <Tag size='small' variant='light'>
              {ROLE_LABEL[role] || role}
            </Tag>
          )}
          <Icon name='chevron-down' className={Style.icon} />
        </Button>
        <DropdownMenu>
          <DropdownItem value='profile'>
            <div className={Style.dropItem}>
              <UserCircleIcon />
              <span>个人中心</span>
            </div>
          </DropdownItem>
          {isLoggedIn ? (
            <DropdownItem value='logout' onClick={handleLogout}>
              <div className={Style.dropItem}>
                <PoweroffIcon />
                <span>退出登录</span>
              </div>
            </DropdownItem>
          ) : (
            <DropdownItem value='login' onClick={() => navigate('/login')}>
              <div className={Style.dropItem}>
                <PoweroffIcon />
                <span>去登录</span>
              </div>
            </DropdownItem>
          )}
        </DropdownMenu>
      </Dropdown>
      <Popup content='页面设置' placement='bottom' showArrow destroyOnClose>
        <Button
          className={Style.menuIcon}
          shape='square'
          size='large'
          variant='text'
          onClick={() => dispatch(toggleSetting())}
          icon={<SettingIcon />}
        />
      </Popup>
    </Space>
  );
});
