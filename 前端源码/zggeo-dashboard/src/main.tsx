import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import store from 'modules/store';
import App from 'layouts/index';
import ErrorBoundary from 'components/ErrorBoundary';
import { installClientErrorReporting } from 'services/zggeo-api';

import 'tdesign-react/es/style/index.css';

import './styles/index.less';

const env = import.meta.env.MODE || 'development';
const normalizeRouterBase = (value?: string) => {
  const base = (value || '').trim();
  if (!base || base === '/') return '';
  return base.startsWith('/') ? base.replace(/\/+$/, '') : `/${base.replace(/\/+$/, '')}`;
};
const baseRouterName = env === 'site' ? '/starter/react/' : normalizeRouterBase(import.meta.env.VITE_ROUTER_BASENAME);

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const root = document.getElementById('app')!;

if (baseRouterName && !window.location.pathname.startsWith(baseRouterName)) {
  const nextPath = window.location.pathname === '/' ? baseRouterName : `${baseRouterName}${window.location.pathname}`;
  window.history.replaceState(null, '', `${nextPath}${window.location.search}${window.location.hash}`);
}

const renderApp = () => {
  installClientErrorReporting();
  ReactDOM.createRoot(root).render(
    <ErrorBoundary>
      <Provider store={store}>
        <BrowserRouter basename={baseRouterName}>
          <App />
        </BrowserRouter>
      </Provider>
    </ErrorBoundary>,
  );
};

renderApp();
