import React from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Tag } from 'tdesign-react';
import { RocketIcon } from 'tdesign-icons-react';

/**
 * 占位页面 —— 用于 L1-L9 尚未实现的模块
 * 会根据 URL 自动显示对应的业务说明
 */

interface PageMeta {
  title: string;
  subtitle: string;
  description: string;
  status: 'beta' | 'coming' | 'planning';
  targetDate?: string;
}

const PAGE_META: Record<string, PageMeta> = {
  // L5 内容生产
  '/content/tasks': {
    title: '写作任务池',
    subtitle: 'L5 内容生产',
    description: '基于诊断报告的内容缺口，自动生成写作任务队列，支持按品牌/问题/渠道分派。',
    status: 'beta',
    targetDate: '2026.05',
  },
  '/content/prompts': {
    title: 'Prompt 库',
    subtitle: 'L5 内容生产',
    description: '沉淀多行业、多场景的 Prompt 模板，支持版本管理、效果评测、团队共享。',
    status: 'beta',
    targetDate: '2026.05',
  },
  '/content/knowledge': {
    title: '品牌知识库',
    subtitle: 'L5 内容生产',
    description: '品牌+行业知识库，用于 RAG 增强生成，保证内容的事实准确性。',
    status: 'beta',
    targetDate: '2026.05',
  },
  '/content/generate': {
    title: 'AI 文章生成',
    subtitle: 'L5 内容生产',
    description: '调用 DeepSeek / 豆包 / Kimi 生成文章，支持结构化输入、多轮优化。',
    status: 'beta',
    targetDate: '2026.05',
  },
  // L6 分发执行
  '/distribution/market': {
    title: '媒体市场',
    subtitle: 'L6 分发执行',
    description: '聚合各类媒体渠道（公众号、知乎、小红书、自媒体号等）的发稿市场。',
    status: 'coming',
    targetDate: '2026.06',
  },
  '/distribution/media-box': {
    title: '媒介盒子',
    subtitle: 'L6 分发执行',
    description: '预留第三方媒介盒子供应商入口，用于后续接入媒介资源、下单和回填发布结果。',
    status: 'planning',
    targetDate: '2026.06',
  },
  '/distribution/accounts': {
    title: '自媒体号池',
    subtitle: 'L6 分发执行',
    description: '管理托管的自媒体账号矩阵，支持批量扫码登录、账号健康度监控。',
    status: 'coming',
    targetDate: '2026.06',
  },
  '/distribution/wechat': {
    title: '公众号发稿',
    subtitle: 'L6 分发执行',
    description: '通过微信公众号官方 API 自动发稿，支持图文、视频号、定时发布。',
    status: 'beta',
    targetDate: '2026.05',
  },
  '/distribution/history': {
    title: '发稿记录',
    subtitle: 'L6 分发执行',
    description: '所有分发动作的历史记录，支持按渠道/时间/品牌筛选。',
    status: 'beta',
    targetDate: '2026.05',
  },
  // L7 回测闭环
  '/recheck/tasks': {
    title: '复测任务',
    subtitle: 'L7 回测闭环',
    description: '内容发布后 14/30/90 天自动触发复测，对比 AI 可见度变化。',
    status: 'beta',
    targetDate: '2026.05',
  },
  '/recheck/curve': {
    title: '效果曲线',
    subtitle: 'L7 回测闭环',
    description: '品牌 AI 可见度随时间的变化曲线图，按模型/问题/渠道多维拆解。',
    status: 'beta',
    targetDate: '2026.05',
  },
  '/recheck/compare': {
    title: '前后对比',
    subtitle: 'L7 回测闭环',
    description: '发稿前 vs 发稿后的引用率、提及率、排名变化可视化对比。',
    status: 'beta',
    targetDate: '2026.05',
  },
  '/recheck/attribution': {
    title: '归因分析',
    subtitle: 'L7 回测闭环',
    description: '哪些内容真正拉升了 AI 可见度？精准归因到单篇文章/单个渠道。',
    status: 'coming',
    targetDate: '2026.07',
  },
  // L8 商业化
  '/billing/plans': {
    title: '套餐 / 权益',
    subtitle: 'L8 商业化',
    description: '定义 SaaS 套餐：免费版、标准版、企业版的权益配置。',
    status: 'planning',
    targetDate: '2026.06',
  },
  '/billing/credits': {
    title: '点数账户',
    subtitle: 'L8 商业化',
    description: '按 API 调用、内容生成数量、监测频次计费的点数系统。',
    status: 'planning',
    targetDate: '2026.06',
  },
  '/billing/pay': {
    title: '支付中心',
    subtitle: 'L8 商业化',
    description: '微信支付 / 支付宝 / 对公账户三种方式，支持发票开具。',
    status: 'planning',
    targetDate: '2026.06',
  },
  '/billing/consumption': {
    title: '消耗明细',
    subtitle: 'L8 商业化',
    description: '租户维度的资源消耗明细，支持导出账单。',
    status: 'planning',
    targetDate: '2026.06',
  },
  // 目标关键词系统
  '/keyword-system/keyword-expansion': {
    title: '拓展关键词',
    subtitle: '目标关键词系统',
    description: '围绕客户录入信息和监测关键词，后续扩展行业词、场景词、问题词和高意向转化词。',
    status: 'coming',
    targetDate: '2026.05',
  },
  // L9 运营
  '/ops/notify': {
    title: '企微通知',
    subtitle: 'L9 运营交付',
    description: '通过 ntfy 将关键事件推送到企业微信群：新留资、任务完成、异常告警。',
    status: 'beta',
    targetDate: '2026.05',
  },
  '/ops/deploy': {
    title: '部署记录',
    subtitle: 'L9 运营交付',
    description: '所有版本发布、功能上线、配置变更的审计记录。',
    status: 'planning',
    targetDate: '2026.07',
  },
  // 系统管理
  '/system/users': {
    title: '用户 / 租户',
    subtitle: '系统治理',
    description: '多租户管理，每个租户有独立的品牌、数据、配额。',
    status: 'beta',
    targetDate: '2026.05',
  },
  '/system/permissions': {
    title: '权限管理',
    subtitle: '系统治理',
    description: '基于角色的细粒度权限控制（RBAC）。',
    status: 'planning',
    targetDate: '2026.06',
  },
  '/system/apikeys': {
    title: 'API Key',
    subtitle: '系统治理',
    description: '管理对外开放的 API 密钥，供客户系统集成调用。',
    status: 'planning',
    targetDate: '2026.07',
  },
  '/system/logs': {
    title: '操作日志',
    subtitle: '系统治理',
    description: '所有关键操作的审计日志。',
    status: 'beta',
    targetDate: '2026.05',
  },
};

const STATUS_CONFIG: Record<string, { text: string; theme: 'primary' | 'warning' | 'default' }> = {
  beta: { text: 'Beta 内测中', theme: 'primary' },
  coming: { text: '即将上线', theme: 'warning' },
  planning: { text: '规划中', theme: 'default' },
};

const Placeholder: React.FC = () => {
  const location = useLocation();
  const meta = PAGE_META[location.pathname] || {
    title: '功能开发中',
    subtitle: '',
    description: '该功能正在加紧开发中，敬请期待。',
    status: 'coming' as const,
  };

  const status = STATUS_CONFIG[meta.status];

  return (
    <div
      style={{
        minHeight: 'calc(100vh - 200px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 48,
      }}
    >
      <div
        style={{
          maxWidth: 680,
          width: '100%',
          padding: 48,
          borderRadius: 16,
          background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.92), rgba(15, 23, 42, 0.92))',
          border: '1px solid rgba(148, 163, 184, 0.42)',
          textAlign: 'center',
          boxShadow: '0 24px 80px rgba(0, 0, 0, 0.35)',
        }}
      >
        <div style={{ fontSize: 56, marginBottom: 16 }}>
          <RocketIcon style={{ color: '#6366F1' }} />
        </div>

        {meta.subtitle && (
          <div
            style={{
              fontSize: 12,
              color: '#a5b4fc',
              fontWeight: 600,
              letterSpacing: 1,
              marginBottom: 8,
            }}
          >
            {meta.subtitle}
          </div>
        )}

        <h1 style={{ fontSize: 28, fontWeight: 700, margin: '8px 0 16px', color: '#f8fafc' }}>{meta.title}</h1>

        <div style={{ marginBottom: 24 }}>
          <Tag theme={status.theme} variant='light'>
            {status.text}
          </Tag>
          {meta.targetDate && (
            <Tag
              theme='default'
              variant='outline'
              style={{ marginLeft: 8, color: '#cbd5e1', borderColor: 'rgba(203, 213, 225, 0.5)' }}
            >
              预计 {meta.targetDate} 上线
            </Tag>
          )}
        </div>

        <p
          style={{
            fontSize: 15,
            lineHeight: 1.8,
            color: '#cbd5e1',
            margin: '0 0 32px',
          }}
        >
          {meta.description}
        </p>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <Button theme='primary' variant='outline'>
            申请内测
          </Button>
          <Button theme='default' variant='text' style={{ color: '#e2e8f0' }}>
            查看路线图
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Placeholder;
