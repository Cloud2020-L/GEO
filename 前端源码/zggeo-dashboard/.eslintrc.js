module.exports = {
  root: true,
  extends: [
    'airbnb-base',
    'prettier',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:import/typescript',
    'plugin:@typescript-eslint/recommended',
  ],
  plugins: ['eslint-plugin-prettier'],
  parser: '@typescript-eslint/parser',
  env: {
    jest: true,
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
    // TypeScript 已覆盖这些基础规则，避免 TS 与 ESLint 对同一语义重复报错。
    'no-shadow': 'off',
    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': 'off',

    // 项目风格规则：后台页面存在较多条件渲染、流程编排和业务字段拼装，这些 Airbnb 风格限制不作为阻断项。
    'no-nested-ternary': 'off',
    'arrow-body-style': 'off',
    'class-methods-use-this': 'off',
    'no-underscore-dangle': 'off',
    'no-continue': 'off',
    'react/no-unescaped-entities': 'off',
    'prefer-destructuring': 'off',
    'no-console': 'off',

    // 质量阻断规则：保留低误报、低迁移成本的基础约束。
    'no-param-reassign': ['error', { props: false }],
    'no-plusplus': [
      'error',
      {
        allowForLoopAfterthoughts: true,
      },
    ],
    'react/display-name': 'off',
    // jsx 单引号
    'jsx-quotes': [2, 'prefer-single'],

    // import 规则债务：项目依赖 Vite alias。打开 unresolved/cycle 前必须先补 resolver 并完成循环依赖扫描。
    'import/no-cycle': 'off',
    'import/extensions': 'off',
    'import/no-unresolved': 'off',
    'import/order': 'off',
    'import/prefer-default-export': 'off',
    'import/no-extraneous-dependencies': ['error', { devDependencies: true }],

    // 关闭variable必须全部大写规则
    '@typescript-eslint/naming-convention': [
      'error',
      {
        selector: 'variable',
        modifiers: ['const'],
        format: null,
      },
    ],

    // TypeScript 历史债务：不在本轮一次性打开，后续按服务层、共享组件、新增页面分阶段治理。
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/ban-types': 'off',

    // 统一eslint prettier配置
    'prettier/prettier': [
      'warn',
      {},
      {
        usePrettierrc: true,
      },
    ],
  },
};
