import React, { memo, useState } from 'react';
import { NavigateFunction, useNavigate, useLocation } from 'react-router-dom';
import { Menu, MenuValue } from 'tdesign-react';
import router, { IRouter } from 'router';
import { resolve } from 'utils/path';
import { useAppSelector } from 'modules/store';
import { selectGlobal } from 'modules/global';
import { isClientPortal } from 'configs/portal';
import { isClientNavigationPath, isVisibleInPortal, SIDEBAR_NAVIGATION } from '../navigation';
import MenuLogo from './MenuLogo';
import Style from './Menu.module.less';

const { SubMenu, MenuItem, HeadMenu } = Menu;

interface IMenuProps {
  showLogo?: boolean;
  showOperation?: boolean;
}

interface SidebarNodeItem {
  type: 'item';
  title: string;
  path: string;
  Icon?: React.FC;
  clientOnly?: boolean;
  adminOnly?: boolean;
  allowedRoles?: string[];
}

interface SidebarNodeGroup {
  type: 'group';
  title: string;
  Icon?: React.FC;
  items: SidebarChildNode[];
  clientOnly?: boolean;
  adminOnly?: boolean;
  allowedRoles?: string[];
}

type SidebarChildNode =
  | { title: string; path: string; clientOnly?: boolean; adminOnly?: boolean; allowedRoles?: string[] }
  | { title: string; items: SidebarChildNode[]; clientOnly?: boolean; adminOnly?: boolean; allowedRoles?: string[] };

const renderSidebarItems = (
  items: Array<SidebarNodeItem | SidebarNodeGroup>,
  navigate: NavigateFunction,
  role?: string,
) => {
  const isClient = isClientPortal;
  const portalScope = isClient ? 'client' : 'admin';

  const renderChildren = (children: SidebarChildNode[], parentKey: string): React.ReactNode[] =>
    children
      .map((child) => {
        if (!isVisibleInPortal(child, portalScope, role)) return null;
        if ('path' in child) {
          return (
            <MenuItem key={child.path} value={child.path} onClick={() => navigate(child.path)}>
              {child.title}
            </MenuItem>
          );
        }

        const childItems = renderChildren(child.items, `${parentKey}/${child.title}`).filter(Boolean);
        if (childItems.length === 0) return null;

        return (
          <SubMenu key={`${parentKey}/${child.title}`} value={`${parentKey}/${child.title}`} title={child.title}>
            {childItems}
          </SubMenu>
        );
      })
      .filter(Boolean);

  return items
    .map((item) => {
      if (!isVisibleInPortal(item, portalScope, role)) return null;
      if (item.type === 'item') {
        return (
          <MenuItem
            key={item.path}
            value={item.path}
            icon={item.Icon ? <item.Icon /> : undefined}
            onClick={() => navigate(item.path)}
          >
            {item.title}
          </MenuItem>
        );
      }

      const childItems = renderChildren(item.items, item.title);

      if (childItems.length === 0) return null;

      return (
        <SubMenu key={item.title} value={item.title} title={item.title} icon={item.Icon ? <item.Icon /> : undefined}>
          {childItems}
        </SubMenu>
      );
    })
    .filter(Boolean);
};

const renderMenuItems = (menu: IRouter[], navigate: NavigateFunction, parentPath = '') => {
  return menu.map((item) => {
    const { children, meta, path } = item;

    if (!meta || meta?.hidden === true) {
      // 无meta信息 或 hidden == true，路由不显示为菜单
      return null;
    }

    const { Icon, title, single } = meta;
    const routerPath = resolve(parentPath, path);
    const isClient = isClientPortal;

    if (!children || children.length === 0) {
      if (isClient && !isClientNavigationPath(routerPath)) return null;
      return (
        <MenuItem
          key={routerPath}
          value={routerPath}
          icon={Icon ? <Icon /> : undefined}
          onClick={() => navigate(routerPath)}
        >
          {title}
        </MenuItem>
      );
    }

    if (single && children?.length > 0) {
      const firstChild = children[0];
      if (firstChild?.meta && !firstChild?.meta?.hidden) {
        const { Icon, title } = meta;
        const singlePath = resolve(resolve(parentPath, path), firstChild.path);
        if (isClient && !isClientNavigationPath(singlePath)) return null;
        return (
          <MenuItem
            key={singlePath}
            value={singlePath}
            icon={Icon ? <Icon /> : undefined}
            onClick={() => navigate(singlePath)}
          >
            {title}
          </MenuItem>
        );
      }
    }

    const childItems = renderMenuItems(children, navigate, routerPath).filter(Boolean);
    if (isClient && childItems.length === 0) return null;

    return (
      <SubMenu key={routerPath} value={routerPath} title={title} icon={Icon ? <Icon /> : undefined}>
        {childItems}
      </SubMenu>
    );
  });
};

/**
 * 顶部菜单
 */
export const HeaderMenu = memo(() => {
  const globalState = useAppSelector(selectGlobal);
  const location = useLocation();
  const navigate = useNavigate();
  const [active, setActive] = useState<MenuValue>(location.pathname); // todo

  return (
    <HeadMenu
      expandType='popup'
      style={{ marginBottom: 20 }}
      value={active}
      theme={globalState.theme}
      onChange={(v) => setActive(v)}
    >
      {renderMenuItems(router, navigate)}
    </HeadMenu>
  );
});

/**
 * 左侧菜单
 */
export default memo((props: IMenuProps) => {
  const location = useLocation();
  const navigate = useNavigate();
  const globalState = useAppSelector(selectGlobal);
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || '').toLowerCase();

  const { version } = globalState;
  const bottomText = globalState.collapsed ? version : `智改GEO ${version}`;

  return (
    <Menu
      width={['232px', '76px']}
      style={{ flexShrink: 0, height: '100%' }}
      className={[Style.menuPanel2, globalState.collapsed ? Style.menuCollapsed : ''].filter(Boolean).join(' ')}
      value={location.pathname}
      theme={globalState.theme}
      collapsed={globalState.collapsed}
      operations={props.showOperation ? <div className={Style.menuTip}>{bottomText}</div> : undefined}
      logo={props.showLogo ? <MenuLogo collapsed={globalState.collapsed} /> : undefined}
    >
      {renderSidebarItems(SIDEBAR_NAVIGATION as Array<SidebarNodeItem | SidebarNodeGroup>, navigate, role)}
    </Menu>
  );
});
