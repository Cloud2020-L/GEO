const envApiBase = import.meta.env.VITE_API_BASE_URL;
const defaultApiBase = '/api/zggeo';

export default {
  mock: {
    // 本地mock数据
    API: '',
  },
  development: {
    // 开发环境接口请求
    API: envApiBase || defaultApiBase,
  },
  admin: {
    API: envApiBase || defaultApiBase,
  },
  client: {
    API: envApiBase || defaultApiBase,
  },
  test: {
    // 测试环境接口地址
    API: envApiBase || defaultApiBase,
  },
  release: {
    // 正式环境接口地址
    API: envApiBase || 'https://api.example.com',
  },
  site: {
    // TDesign部署特殊需要 与release功能一致
    API: envApiBase || 'https://api.example.com',
  },
};
