import React from 'react';
import { Layout, Row } from 'tdesign-react';
import { useAppSelector } from 'modules/store';
import { selectGlobal } from 'modules/global';

const { Footer: TFooter } = Layout;

const Footer = () => {
  const globalState = useAppSelector(selectGlobal);
  if (!globalState.showFooter) {
    return null;
  }

  return (
    <TFooter style={{ padding: '8px 20px 18px', background: 'transparent' }}>
      <Row justify='center' style={{ color: 'rgba(168, 174, 196, 0.54)', fontSize: 12 }}>
        Copyright © 2026-{new Date().getFullYear()} 智改GEO
      </Row>
    </TFooter>
  );
};

export default React.memo(Footer);
