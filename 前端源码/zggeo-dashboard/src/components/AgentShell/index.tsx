import React from 'react';
import { Card } from 'tdesign-react';
import { CheckCircleFilledIcon } from 'tdesign-icons-react';

import Style from './index.module.less';

/**
 * GENO Agent 人格化外壳
 * 每个 Agent 页面都用这个头做品牌感 + 注入自己的真实能力区
 */

export type AgentStatus = 'running' | 'beta' | 'idle' | 'error';

export interface AgentMeta {
  key: string; // scheduler / explorer / scorer / calibrator
  name: string; // 星枢
  title: string; // 调度
  tagline: string; // 一句话职责
  description: string; // 详细说明
  color: string; // 主色
  gradient: [string, string];
  emoji: string; // ✨ 🛰️ 等
  apis: string[]; // 它实际吃哪些后端接口
}

const STATUS_CFG: Record<AgentStatus, { label: string; color: string; bg: string }> = {
  running: { label: '运行中', color: '#10B981', bg: '#D1FAE5' },
  beta: { label: '内测', color: '#F59E0B', bg: '#FEF3C7' },
  idle: { label: '空闲', color: '#94A3B8', bg: '#F1F5F9' },
  error: { label: '告警', color: '#EF4444', bg: '#FEE2E2' },
};

interface Props {
  meta: AgentMeta;
  status: AgentStatus;
  health: number; // 0-100
  metrics: { label: string; value: React.ReactNode; hint?: string }[];
  children: React.ReactNode;
  variant?: 'default' | 'linear';
}

const AgentShell: React.FC<Props> = ({ meta, status, health, metrics, children, variant = 'default' }) => {
  const st = STATUS_CFG[status];

  if (variant === 'linear') {
    return (
      <div className={Style.linearRoot}>
        <section className={Style.linearHero}>
          <div className={Style.linearHeroBody}>
            <div>
              <div className={Style.linearHeroHead}>
                <div className={Style.linearBadge}>AGENT ENGINE</div>
                <div className={Style.linearStatus} style={{ color: st.color, background: st.bg }}>
                  <CheckCircleFilledIcon />
                  {st.label}
                </div>
              </div>

              <div className={Style.linearTitleRow}>
                <div className={Style.linearTitle}>{meta.name}</div>
                <div className={Style.linearTitleMeta}>· {meta.title}</div>
              </div>

              <div className={Style.linearTagline}>{meta.tagline}</div>
              <div className={Style.linearDescription}>{meta.description}</div>

              {meta.apis.length > 0 && (
                <div className={Style.linearApiRow}>
                  {meta.apis.map((api) => (
                    <code key={api} className={Style.linearApiCode}>
                      {api}
                    </code>
                  ))}
                </div>
              )}
            </div>

            <div className={Style.linearHealth}>
              <HealthRing value={health} />
            </div>
          </div>
        </section>

        {metrics.length > 0 && (
          <div className={Style.linearMetrics}>
            {metrics.map((metric, index) => (
              <div key={index} className={Style.linearMetricCard}>
                <div className={Style.linearMetricLabel}>{metric.label}</div>
                <div className={Style.linearMetricValue}>{metric.value}</div>
                {metric.hint ? <div className={Style.linearMetricHint}>{metric.hint}</div> : null}
              </div>
            ))}
          </div>
        )}

        <div className={Style.linearChildren}>{children}</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {/* 顶部人格化卡 */}
      <Card
        bordered={false}
        style={{
          background: `linear-gradient(135deg, ${meta.gradient[0]} 0%, ${meta.gradient[1]} 100%)`,
          color: '#fff',
          marginBottom: 16,
          boxShadow: `0 4px 24px ${meta.color}44`,
        }}
        bodyStyle={{ padding: 24 }}
      >
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 18,
              background: 'rgba(255,255,255,0.18)',
              border: '2px solid rgba(255,255,255,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 38,
              backdropFilter: 'blur(8px)',
            }}
          >
            {meta.emoji}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span style={{ fontSize: 11, letterSpacing: 2, opacity: 0.85 }}>AGENT ENGINE</span>
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 10,
                  background: st.bg,
                  color: st.color,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                <CheckCircleFilledIcon style={{ verticalAlign: 'middle', marginRight: 2 }} />
                {st.label}
              </span>
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 1 }}>
              {meta.name}
              <span style={{ fontSize: 16, fontWeight: 500, marginLeft: 10, opacity: 0.8 }}>· {meta.title}</span>
            </div>
            <div style={{ fontSize: 13, opacity: 0.92, marginTop: 2 }}>{meta.tagline}</div>
          </div>

          {/* 健康度圆环 */}
          <HealthRing value={health} />
        </div>

        <div style={{ marginTop: 16, fontSize: 12, opacity: 0.82, lineHeight: 1.7 }}>{meta.description}</div>

        {meta.apis.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, opacity: 0.7 }}>吃：</span>
            {meta.apis.map((a) => (
              <code
                key={a}
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  background: 'rgba(255,255,255,0.2)',
                  borderRadius: 4,
                  fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace',
                }}
              >
                {a}
              </code>
            ))}
          </div>
        )}
      </Card>

      {/* 指标带 */}
      {metrics.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(metrics.length, 4)}, 1fr)`,
            gap: 12,
            marginBottom: 16,
          }}
        >
          {metrics.map((m, i) => (
            <Card key={i} bordered={false} style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>{m.label}</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: meta.color, marginTop: 4, lineHeight: 1 }}>
                {m.value}
              </div>
              {m.hint && (
                <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)', marginTop: 4 }}>{m.hint}</div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* 子页自定义区 */}
      {children}
    </div>
  );
};

// 纯 SVG 健康度圆环
const HealthRing: React.FC<{ value: number }> = ({ value }) => {
  const size = 64;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = Math.PI * 2 * r;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = c - (clamped / 100) * c;

  return (
    <div style={{ width: size, height: size, position: 'relative' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke='rgba(255,255,255,0.25)' strokeWidth={stroke} fill='none' />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke='#fff'
          strokeWidth={stroke}
          fill='none'
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap='round'
          style={{ transition: 'stroke-dashoffset 400ms' }}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          fontWeight: 700,
          color: '#fff',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>{clamped.toFixed(0)}</span>
        <span style={{ fontSize: 9, opacity: 0.8, marginTop: 1 }}>HEALTH</span>
      </div>
    </div>
  );
};

export default AgentShell;
