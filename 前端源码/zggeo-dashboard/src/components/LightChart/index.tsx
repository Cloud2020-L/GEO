import React from 'react';

interface LightChartProps {
  style?: React.CSSProperties;
  className?: string;
}

const LightChart: React.FC<LightChartProps> = ({ style, className }) => (
  <div
    className={className}
    style={{
      minHeight: 180,
      borderRadius: 8,
      background: 'linear-gradient(180deg, rgba(99,102,241,0.08) 0%, rgba(14,165,233,0.06) 100%)',
      border: '1px solid rgba(99,102,241,0.12)',
      ...style,
    }}
  />
);

export default React.memo(LightChart);
