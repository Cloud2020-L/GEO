import path from 'path';
import { loadEnv } from 'vite';
import { viteMockServe } from 'vite-plugin-mock';
import react from '@vitejs/plugin-react';
import svgr from '@honkhonk/vite-plugin-svgr';

const CWD = process.cwd();

export default (params) => {
  const { mode } = params;
  const { VITE_BASE_URL, VITE_ZGEO_PORTAL } = loadEnv(mode, CWD);
  const portalOutDir =
    VITE_ZGEO_PORTAL === 'client' ? 'dist-client' : VITE_ZGEO_PORTAL === 'admin' ? 'dist-admin' : 'dist';
  const portalCacheDir =
    VITE_ZGEO_PORTAL === 'client'
      ? 'node_modules/.vite-client'
      : VITE_ZGEO_PORTAL === 'admin'
      ? 'node_modules/.vite-admin'
      : 'node_modules/.vite';

  return {
    base: VITE_BASE_URL || '/',
    cacheDir: portalCacheDir,
    resolve: {
      alias: {
        assets: path.resolve(__dirname, './src/assets'),
        components: path.resolve(__dirname, './src/components'),
        configs: path.resolve(__dirname, './src/configs'),
        'echarts-for-react': path.resolve(__dirname, './src/components/LightChart'),
        layouts: path.resolve(__dirname, './src/layouts'),
        modules: path.resolve(__dirname, './src/modules'),
        pages: path.resolve(__dirname, './src/pages'),
        styles: path.resolve(__dirname, './src/styles'),
        utils: path.resolve(__dirname, './src/utils'),
        services: path.resolve(__dirname, './src/services'),
        router: path.resolve(__dirname, './src/router'),
        hooks: path.resolve(__dirname, './src/hooks'),
        types: path.resolve(__dirname, './src/types'),
      },
    },

    css: {
      preprocessorOptions: {
        less: {
          modifyVars: {
            // 如需自定义组件其他 token, 在此处配置
          },
        },
      },
    },

    plugins: [
      svgr(),
      react(),
      mode === 'mock' &&
        viteMockServe({
          mockPath: './mock',
          localEnabled: true,
        }),
    ],

    build: {
      outDir: portalOutDir,
      cssCodeSplit: true,
      chunkSizeWarningLimit: 1500,
    },

    // 生产构建后的静态预览服务（pnpm preview）
    // 用这个 + cloudflared 绕开 dev server HMR WebSocket 的各种坑
    preview: {
      host: '0.0.0.0',
      port: 3003,
      proxy: {
        '/api/zggeo': {
          target: 'http://127.0.0.1:8010',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/zggeo/, ''),
        },
      },
    },

    server: {
      host: '0.0.0.0',
      port: 3003,
      // 只在显式开启 tunnel 调试时覆盖 HMR。
      // 本地/LAN 访问如果强制走 wss:443，会让浏览器端握手异常并出现白屏。
      hmr:
        process.env.VITE_DEV_TUNNEL === '1'
          ? {
              clientPort: 443,
              protocol: 'wss',
            }
          : undefined,
      proxy: {
        // ZGEO codex 后端 (本机 FastAPI)
        // 所有以 /api/zggeo 开头的请求 → 去掉前缀 → 转发到 http://localhost:8010
        // 这样前端里写 fetch('/api/zggeo/leads') 实际打到 codex 的 GET /leads
        '/api/zggeo': {
          target: 'http://localhost:8010',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/zggeo/, ''),
        },
        // 模板原有的 mock 网关（保留，万一老代码还在用）
        '/api': {
          target: 'https://service-exndqyuk-1257786608.gz.apigw.tencentcs.com',
          changeOrigin: true,
        },
      },
    },
  };
};
