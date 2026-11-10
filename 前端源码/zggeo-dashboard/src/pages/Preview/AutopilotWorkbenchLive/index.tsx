import React, { useEffect } from 'react';
import { Breadcrumb, Layout } from 'tdesign-react';

import { useAppDispatch } from 'modules/store';
import { toggleMenu } from 'modules/global';
import Header from 'layouts/components/Header';
import Menu from 'layouts/components/Menu';
import Footer from 'layouts/components/Footer';
import Autopilot from 'pages/Agents/Autopilot';
import ShellStyle from 'layouts/components/AppLayout.module.less';
import PageStyle from 'layouts/components/Page.module.less';

const { Content } = Layout;
const { BreadcrumbItem } = Breadcrumb;

const AutopilotWorkbenchLive: React.FC = () => {
  const dispatch = useAppDispatch();

  useEffect(() => {
    dispatch(toggleMenu(false));
  }, [dispatch]);

  return (
    <Layout className={ShellStyle.sidePanel}>
      <Menu showLogo showOperation />
      <Layout className={ShellStyle.sideContainer}>
        <Header />
        <Content className={PageStyle.panel}>
          <Breadcrumb className={PageStyle.breadcrumb}>
            <BreadcrumbItem>Agent 矩阵引擎</BreadcrumbItem>
            <BreadcrumbItem>星链 · 自动运作中心</BreadcrumbItem>
          </Breadcrumb>
          <Autopilot />
        </Content>
        <Footer />
      </Layout>
    </Layout>
  );
};

export default AutopilotWorkbenchLive;
