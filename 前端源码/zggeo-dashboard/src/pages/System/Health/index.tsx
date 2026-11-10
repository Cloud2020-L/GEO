import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, MessagePlugin, Row, Space, Table, Tag } from 'tdesign-react';
import { RefreshIcon } from 'tdesign-icons-react';
import { getSystemHealth, SystemHealthCheck } from 'services/zggeo-api';

const SystemHealth: React.FC = () => {
  const [checks, setChecks] = useState<SystemHealthCheck[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getSystemHealth();
      setStatus(data.status);
      setChecks(data.checks || []);
    } catch (err: any) {
      MessagePlugin.error(`系统健康检查失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const stats = useMemo(
    () => ({
      total: checks.length,
      ok: checks.filter((item) => item.status === 'ok').length,
      warning: checks.filter((item) => item.status === 'warning').length,
      error: checks.filter((item) => item.status === 'error').length,
    }),
    [checks],
  );

  return (
    <div style={{ padding: 16 }}>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <Space direction='vertical' size={10}>
          <Space>
            <Tag theme='primary' variant='light'>
              系统治理
            </Tag>
            <Tag theme={statusTheme(status)} variant='light'>
              {statusLabel(status)}
            </Tag>
          </Space>
          <div style={{ fontSize: 24, fontWeight: 800 }}>系统健康</div>
          <div style={{ color: 'var(--td-text-color-secondary)' }}>
            汇总后端、数据库、模型网关、媒介集市和客户操作监控状态，用于上线后快速定位基础服务问题。
          </div>
        </Space>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={3}>
          <Metric title='检查项' value={stats.total} />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='正常' value={stats.ok} theme='success' />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='预警' value={stats.warning} theme='warning' />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='异常' value={stats.error} theme='danger' />
        </Col>
      </Row>

      <Card
        bordered
        title='服务状态'
        actions={
          <Button icon={<RefreshIcon />} onClick={load}>
            刷新检查
          </Button>
        }
      >
        <Table
          loading={loading}
          rowKey='key'
          data={checks}
          columns={[
            { colKey: 'name', title: '检查项', width: 220 },
            {
              colKey: 'status',
              title: '状态',
              width: 110,
              cell: ({ row }: { row: SystemHealthCheck }) => (
                <Tag theme={statusTheme(row.status)} variant='light'>
                  {statusLabel(row.status)}
                </Tag>
              ),
            },
            { colKey: 'message', title: '说明', ellipsis: true },
            {
              colKey: 'meta',
              title: '补充信息',
              width: 260,
              ellipsis: true,
              cell: ({ row }: { row: SystemHealthCheck }) => formatMeta(row.meta),
            },
          ]}
        />
      </Card>
    </div>
  );
};

const Metric: React.FC<{ title: string; value: number; theme?: 'success' | 'warning' | 'danger' }> = ({
  title,
  value,
  theme,
}) => {
  const color =
    theme === 'success' ? '#00a870' : theme === 'warning' ? '#ed7b2f' : theme === 'danger' ? '#e34d59' : undefined;
  return (
    <Card bordered>
      <div style={{ color: 'var(--td-text-color-secondary)' }}>{title}</div>
      <div style={{ fontSize: 32, fontWeight: 800, color }}>{value}</div>
    </Card>
  );
};

const statusTheme = (status: string) => {
  if (status === 'ok') return 'success';
  if (status === 'warning') return 'warning';
  if (status === 'error') return 'danger';
  return 'default';
};

const statusLabel = (status: string) => {
  if (status === 'ok') return '正常';
  if (status === 'warning') return '预警';
  if (status === 'error') return '异常';
  return status || '未检查';
};

const formatMeta = (meta?: Record<string, unknown>) => {
  if (!meta || Object.keys(meta).length === 0) return '-';
  return JSON.stringify(meta);
};

export default SystemHealth;
