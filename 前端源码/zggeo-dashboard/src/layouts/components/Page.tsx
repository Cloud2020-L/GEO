import React, { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../../modules/store';
import { selectGlobal, switchFullPage } from '../../modules/global';
import { logout } from '../../modules/user';
import { Layout, Breadcrumb } from 'tdesign-react';
import { Navigate, useLocation } from 'react-router-dom';
import { isClientPortal } from 'configs/portal';
import { isClientNavigationPath, resolveNavigationBreadcrumbs } from '../navigation';
import Style from './Page.module.less';

const { Content } = Layout;
const { BreadcrumbItem } = Breadcrumb;

const Page = ({
  children,
  isFullPage,
  breadcrumbs,
}: React.PropsWithChildren<{ isFullPage?: boolean; breadcrumbs?: string[] }>) => {
  const globalState = useAppSelector(selectGlobal);
  const token = useAppSelector((state) => state.user.token);
  const userInfo = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const dispatch = useAppDispatch();
  const location = useLocation();
  const navBreadcrumbs = resolveNavigationBreadcrumbs(location.pathname, breadcrumbs);
  useEffect(() => {
    dispatch(switchFullPage(isFullPage));
  }, [isFullPage]);

  useEffect(() => {
    if (isClientPortal && token && userInfo?.role && userInfo.role !== 'client') {
      dispatch(logout());
    }
    if (!isClientPortal && token && userInfo?.role === 'client') {
      dispatch(logout());
    }
  }, [dispatch, token, userInfo?.role]);

  if (isFullPage) {
    return <>{children}</>;
  }

  if (!token || token === 'main_token') {
    return <Navigate to='/login' replace />;
  }

  if (isClientPortal && userInfo?.role && userInfo.role !== 'client') {
    return <Navigate to='/login' replace />;
  }

  if (!isClientPortal && userInfo?.role === 'client') {
    return <Navigate to='/login' replace />;
  }

  if (isClientPortal && !isClientNavigationPath(location.pathname)) {
    return <Navigate to='/overview/index' replace />;
  }

  return (
    <Content className={Style.panel}>
      {globalState.showBreadcrumbs && (
        <Breadcrumb className={Style.breadcrumb}>
          {navBreadcrumbs?.map((item, index) => (
            <BreadcrumbItem key={index}>{item}</BreadcrumbItem>
          ))}
        </Breadcrumb>
      )}
      {children}
    </Content>
  );
};

export default React.memo(Page);
