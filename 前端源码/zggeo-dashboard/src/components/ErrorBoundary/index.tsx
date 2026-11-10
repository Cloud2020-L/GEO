import React from 'react';
import { Button, Space } from 'tdesign-react';
import { RefreshIcon, ErrorCircleFilledIcon } from 'tdesign-icons-react';
import { reportClientEvent } from 'services/zggeo-api';

/**
 * 全局错误边界
 * 渲染阶段抛出的异常（组件崩溃、lazy chunk 加载失败等）在这里被兜住
 * 不负责拦截 Promise 里的 fetch 错误（那类走 axios 拦截器 / MessagePlugin）
 */

interface State {
  hasError: boolean;
  error: Error | null;
}

interface Props {
  children: React.ReactNode;
  /** 可选的自定义兜底 UI */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 生产环境可以接入 Sentry / 自建日志
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
    reportClientEvent({
      event_type: 'js_error',
      message: error.message || 'React 渲染错误',
      error_stack: `${error.stack || ''}\n${info.componentStack || ''}`.trim(),
      extra: {
        componentStack: info.componentStack,
      },
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { hasError, error } = this.state;
    const { children, fallback } = this.props;

    if (!hasError || !error) return children;

    if (fallback) return fallback(error, this.handleReset);

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #FEF2F2 0%, #FFF7ED 100%)',
          padding: 24,
        }}
      >
        <div
          style={{
            maxWidth: 560,
            width: '100%',
            background: '#fff',
            borderRadius: 12,
            padding: 32,
            boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              margin: '0 auto 16px',
              borderRadius: 16,
              background: '#FEE2E2',
              color: '#DC2626',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 36,
            }}
          >
            <ErrorCircleFilledIcon />
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#1F2937' }}>页面出错了</div>
          <div style={{ fontSize: 13, color: '#6B7280', marginTop: 6 }}>
            控制台有完整堆栈；下方是异常摘要，点"重试"尝试重挂载，或"刷新页面"整页重载。
          </div>
          <pre
            style={{
              textAlign: 'left',
              marginTop: 16,
              padding: 12,
              background: '#F9FAFB',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 12,
              color: '#B91C1C',
              overflow: 'auto',
              maxHeight: 180,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.name}: {error.message}
            {error.stack ? `\n\n${error.stack.split('\n').slice(0, 6).join('\n')}` : ''}
          </pre>
          <Space style={{ marginTop: 20, justifyContent: 'center', width: '100%' }}>
            <Button theme='primary' icon={<RefreshIcon />} onClick={this.handleReset}>
              重试
            </Button>
            <Button variant='outline' onClick={this.handleReload}>
              刷新页面
            </Button>
          </Space>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
