import React from 'react';

/**
 * 4 维评分雷达图（纯 SVG，不依赖 echarts）
 * 4 轴：可见度 / 结构 / 信任 / 内容覆盖
 * 每轴 0-100 分
 */

interface Props {
  visibility: number;
  structure: number;
  trust: number;
  content: number;
  size?: number;
}

const ScoreRadar: React.FC<Props> = ({ visibility, structure, trust, content, size = 280 }) => {
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * 0.36;

  // 4 个轴的角度（顶/右/底/左）
  const axes = [
    { label: '可见度', value: visibility, angle: -90 },
    { label: '结构', value: structure, angle: 0 },
    { label: '信任', value: trust, angle: 90 },
    { label: '内容覆盖', value: content, angle: 180 },
  ];

  const toXY = (angle: number, r: number) => {
    const rad = (angle * Math.PI) / 180;
    return [cx + Math.cos(rad) * r, cy + Math.sin(rad) * r];
  };

  // 背景网格（5 层同心四边形）
  const gridLevels = [1, 0.8, 0.6, 0.4, 0.2];

  // 数据多边形
  const dataPath = `${axes
    .map(({ angle, value }, i) => {
      const r = (value / 100) * maxR;
      const [x, y] = toXY(angle, r);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ')} Z`;

  return (
    <svg width={size} height={size} style={{ overflow: 'visible' }}>
      {/* 网格 */}
      {gridLevels.map((level, i) => {
        const points = axes
          .map(({ angle }) =>
            toXY(angle, maxR * level)
              .map((v) => v.toFixed(1))
              .join(','),
          )
          .join(' ');
        return (
          <polygon
            key={i}
            points={points}
            fill={i === 0 ? 'rgba(99,102,241,0.03)' : 'none'}
            stroke='rgba(99,102,241,0.15)'
            strokeWidth={i === gridLevels.length - 1 ? 1 : 0.5}
          />
        );
      })}

      {/* 轴线 */}
      {axes.map(({ angle }, i) => {
        const [x, y] = toXY(angle, maxR);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke='rgba(99,102,241,0.2)' strokeWidth={0.5} />;
      })}

      {/* 数据多边形 */}
      <path d={dataPath} fill='rgba(99,102,241,0.25)' stroke='#6366F1' strokeWidth={2} strokeLinejoin='round' />

      {/* 数据点 + 数值 */}
      {axes.map(({ angle, value }, i) => {
        const r = (value / 100) * maxR;
        const [x, y] = toXY(angle, r);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={4} fill='#6366F1' stroke='#fff' strokeWidth={2} />
          </g>
        );
      })}

      {/* 轴标签 + 分数 */}
      {axes.map(({ angle, label, value }, i) => {
        const [x, y] = toXY(angle, maxR + 28);
        return (
          <g key={i}>
            <text
              x={x}
              y={y - 4}
              fontSize={12}
              fill='var(--td-text-color-primary)'
              textAnchor='middle'
              dominantBaseline='middle'
              fontWeight={500}
            >
              {label}
            </text>
            <text
              x={x}
              y={y + 12}
              fontSize={14}
              fill='#6366F1'
              textAnchor='middle'
              dominantBaseline='middle'
              fontWeight={700}
            >
              {value}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

export default ScoreRadar;
