import React, { lazy, Suspense, useMemo, useState } from 'react';
import { Button } from 'tdesign-react';
import { RefreshIcon } from 'tdesign-icons-react';

function createGenerateLoader() {
  return lazy(() => import('pages/Content/Generate'));
}

function LoadingFallback() {
  return (
    <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', color: 'var(--td-text-color-secondary)' }}>
      ZGEO 加载中...
    </div>
  );
}

interface ChunkBoundaryProps {
  children: React.ReactNode;
  resetKey: number;
  onRetry: () => void;
}

interface ChunkBoundaryState {
  error?: Error;
}

class ChunkBoundary extends React.Component<ChunkBoundaryProps, ChunkBoundaryState> {
  state: ChunkBoundaryState = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prevProps: ChunkBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: undefined });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '60vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 16,
            color: 'var(--td-text-color-primary)',
          }}
        >
          <strong>文章生成NEW加载失败</strong>
          <span style={{ color: 'var(--td-text-color-secondary)' }}>
            模块请求可能被刷新或缓存中断，请点击重试重新加载原页面。
          </span>
          <Button icon={<RefreshIcon />} theme='primary' onClick={this.props.onRetry}>
            重试加载
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function ArticlesNew() {
  const [retryKey, setRetryKey] = useState(0);
  const Generate = useMemo(createGenerateLoader, [retryKey]);

  return (
    <ChunkBoundary resetKey={retryKey} onRetry={() => setRetryKey((key) => key + 1)}>
      <Suspense fallback={<LoadingFallback />}>
        <Generate />
      </Suspense>
    </ChunkBoundary>
  );
}
