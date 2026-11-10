import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Drawer, Input, MessagePlugin, Row, Select, Space, Table, Tag } from 'tdesign-react';
import { RefreshIcon } from 'tdesign-icons-react';
import {
  CustomerActivityLog,
  CustomerOperationStep,
  ObservabilitySummary,
  getCustomerActivity,
  getObservabilitySummary,
  listObservableTenants,
  listCustomerActivities,
} from 'services/zggeo-api';

const MODULE_OPTIONS = [
  { label: '全部模块', value: '' },
  { label: '客户资产', value: '客户资产' },
  { label: '拓展关键词', value: '拓展关键词' },
  { label: 'Prompt库存', value: 'Prompt库存' },
  { label: 'GEO资产', value: 'GEO资产' },
  { label: '可见度监测', value: '可见度监测' },
  { label: '文章生成', value: '文章生成' },
  { label: '报告导出', value: '报告导出' },
  { label: '媒介集市', value: '媒介集市' },
  { label: '分发执行', value: '分发执行' },
  { label: 'Agent自动流程', value: 'Agent自动流程' },
  { label: '前端错误', value: '前端错误' },
];

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' },
  { label: '运行中', value: 'running' },
];

const ERROR_OPTIONS = [
  { label: '全部错误', value: '' },
  { label: '官网读取失败', value: 'homepage_fetch_failed' },
  { label: '模型调用失败', value: 'model_call_failed' },
  { label: '数据库失败', value: 'db_failed' },
  { label: '参数/校验失败', value: 'validation_failed' },
  { label: '客户端接口失败', value: 'api_request_failed' },
  { label: '前端页面错误', value: 'frontend_failed' },
  { label: '未知失败', value: 'unknown_failed' },
];

const Observability: React.FC = () => {
  const [rows, setRows] = useState<CustomerActivityLog[]>([]);
  const [knownTenants, setKnownTenants] = useState<Array<{ label: string; value: string }>>([]);
  const [q, setQ] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [module, setModule] = useState('');
  const [status, setStatus] = useState('');
  const [errorType, setErrorType] = useState('');
  const [loading, setLoading] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [detail, setDetail] = useState<{ activity: CustomerActivityLog; steps: CustomerOperationStep[] } | null>(null);
  const [summary, setSummary] = useState<ObservabilitySummary | null>(null);

  const load = async (
    overrides: Partial<{ q: string; tenantId: string; module: string; status: string; errorType: string }> = {},
  ) => {
    const filters = {
      q,
      tenantId,
      module,
      status,
      errorType,
      ...overrides,
    };
    setLoading(true);
    try {
      const data = await listCustomerActivities({
        q: filters.q.trim() || undefined,
        tenant_id: filters.tenantId || undefined,
        module: filters.module || undefined,
        status: filters.status || undefined,
        error_type: filters.errorType || undefined,
        limit: 200,
      });
      setRows(data);
      setKnownTenants((prev) => mergeTenantOptions(prev, data));
      getObservabilitySummary({ window_minutes: 60 })
        .then(setSummary)
        .catch(() => undefined);
    } catch (err: any) {
      MessagePlugin.error(`客户操作日志加载失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    listObservableTenants()
      .then((items) => {
        setKnownTenants(
          items.map((item) => ({
            label: `${item.name}${item.activity_count ? `（${item.activity_count}）` : ''}`,
            value: item.id,
          })),
        );
      })
      .catch(() => undefined);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const failed = rows.filter((item) => item.status === 'failed').length;
    return {
      total: rows.length,
      success: rows.filter((item) => item.status === 'success').length,
      failed,
      activeTenants: new Set(rows.map((item) => item.tenant_id).filter(Boolean)).size,
      running: rows.filter((item) => item.status === 'running').length,
      failedSteps: rows.reduce((sum, item) => sum + (Number(item.failed_step_count) || 0), 0),
    };
  }, [rows]);

  const failedStep = useMemo(() => detail?.steps.find((item) => item.status === 'failed') || null, [detail]);

  const openDetail = async (row: CustomerActivityLog) => {
    try {
      const data = await getCustomerActivity(row.id);
      setDetail(data);
      setDrawerVisible(true);
    } catch (err: any) {
      MessagePlugin.error(`详情加载失败：${err?.message || '未知错误'}`);
    }
  };

  const columns: any[] = [
    {
      colKey: 'created_at',
      title: '时间',
      width: 170,
      cell: ({ row }: { row: CustomerActivityLog }) => formatTime(row.created_at),
    },
    {
      colKey: 'tenant_name',
      title: '客户 / 用户',
      width: 220,
      cell: ({ row }: { row: CustomerActivityLog }) => (
        <Space direction='vertical' size={2}>
          <b>{row.tenant_name || '未绑定客户'}</b>
          <span style={{ color: 'var(--td-text-color-secondary)' }}>
            {row.user_name || row.user_email || row.role || '-'}
          </span>
        </Space>
      ),
    },
    {
      colKey: 'module',
      title: '模块 / 动作',
      width: 180,
      cell: ({ row }: { row: CustomerActivityLog }) => (
        <Space direction='vertical' size={4}>
          <Tag variant='light'>{row.module}</Tag>
          <span style={{ color: 'var(--td-text-color-secondary)' }}>{row.action}</span>
        </Space>
      ),
    },
    {
      colKey: 'message',
      title: '摘要 / 失败原因',
      ellipsis: true,
      cell: ({ row }: { row: CustomerActivityLog }) => (
        <Space direction='vertical' size={4}>
          <span>{row.message || '-'}</span>
          {row.status === 'failed' && (
            <span style={{ color: '#e34d59' }}>
              {errorTypeText(row.error_type)}
              {row.error_detail ? `：${row.error_detail}` : ''}
            </span>
          )}
        </Space>
      ),
    },
    {
      colKey: 'status',
      title: '状态',
      width: 120,
      cell: ({ row }: { row: CustomerActivityLog }) => (
        <Tag theme={statusTheme(row.status)} variant='light'>
          {statusText(row.status)}
        </Tag>
      ),
    },
    {
      colKey: 'step_count',
      title: '步骤',
      width: 120,
      cell: ({ row }: { row: CustomerActivityLog }) => (
        <Space direction='vertical' size={2}>
          <span>共 {row.step_count || 0}</span>
          {Boolean(row.failed_step_count) && (
            <Tag theme='danger' variant='light'>
              失败 {row.failed_step_count}
            </Tag>
          )}
        </Space>
      ),
    },
    { colKey: 'request_id', title: 'Request ID', width: 180, ellipsis: true },
    {
      colKey: 'operation',
      title: '操作',
      width: 90,
      cell: ({ row }: { row: CustomerActivityLog }) => (
        <Button variant='text' theme='primary' onClick={() => openDetail(row)}>
          查看
        </Button>
      ),
    },
  ];

  return (
    <div style={{ padding: 16 }}>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <Space direction='vertical' size={10}>
          <Space>
            <Tag theme='primary' variant='light'>
              系统治理
            </Tag>
            <Tag theme='success' variant='light'>
              客户交付观测
            </Tag>
          </Space>
          <div style={{ fontSize: 24, fontWeight: 800 }}>客户操作监控</div>
          <div style={{ color: 'var(--td-text-color-secondary)' }}>
            汇总 3004 客户端写入、生成、删除和 Agent 启动行为，管理员可按客户、模块和失败状态排查交付链路。
          </div>
        </Space>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={3}>
          <Metric title='最近操作' value={stats.total} />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='成功' value={stats.success} theme='success' />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='失败操作' value={stats.failed} theme='danger' />
        </Col>
        <Col xs={12} lg={3}>
          <Metric title='失败步骤' value={stats.failedSteps} theme='danger' />
        </Col>
      </Row>

      {summary && (
        <Card bordered title='运行告警' style={{ marginBottom: 16 }}>
          <Row gutter={[16, 16]}>
            <Col xs={12} lg={3}>
              <Metric
                title='模型失败率'
                value={Math.round((summary.metrics.model.failure_rate || 0) * 100)}
                suffix='%'
                theme={summary.metrics.model.failures ? 'danger' : 'success'}
              />
            </Col>
            <Col xs={12} lg={3}>
              <Metric
                title='任务队列积压'
                value={summary.metrics.task_queue.backlog || 0}
                theme={summary.metrics.task_queue.backlog ? 'danger' : 'success'}
              />
            </Col>
            <Col xs={12} lg={3}>
              <Metric
                title='任务失败率'
                value={Math.round((summary.metrics.task_queue.failure_rate || 0) * 100)}
                suffix='%'
                theme={summary.metrics.task_queue.failures ? 'danger' : 'success'}
              />
            </Col>
            <Col xs={12} lg={3}>
              <Metric
                title='客户端错误'
                value={summary.metrics.frontend.errors || 0}
                theme={summary.metrics.frontend.errors ? 'danger' : 'success'}
              />
            </Col>
          </Row>
          <Space direction='vertical' style={{ width: '100%', marginTop: 14 }}>
            {summary.alerts.length ? (
              summary.alerts.map((alert) => (
                <Tag key={alert.key} theme={alert.severity === 'critical' ? 'danger' : 'warning'} variant='light'>
                  {alert.title}：{alert.message}
                </Tag>
              ))
            ) : (
              <Tag theme='success' variant='light'>
                最近 {summary.window_minutes} 分钟暂无运行告警
              </Tag>
            )}
          </Space>
        </Card>
      )}

      <Card bordered title='客户操作流水'>
        <Space style={{ marginBottom: 16 }} breakLine>
          <Input
            clearable
            style={{ width: 280 }}
            value={q}
            placeholder='搜客户、用户、模块、摘要'
            onChange={(value) => setQ(String(value))}
            onEnter={() => load()}
          />
          <Select
            clearable
            style={{ width: 190 }}
            value={tenantId}
            options={[{ label: '全部客户', value: '' }, ...knownTenants]}
            onChange={(value) => setTenantId(String(value || ''))}
          />
          <Select
            style={{ width: 170 }}
            value={module}
            options={MODULE_OPTIONS}
            onChange={(value) => setModule(String(value || ''))}
          />
          <Select
            style={{ width: 150 }}
            value={status}
            options={STATUS_OPTIONS}
            onChange={(value) => setStatus(String(value || ''))}
          />
          <Select
            style={{ width: 170 }}
            value={errorType}
            options={ERROR_OPTIONS}
            onChange={(value) => setErrorType(String(value || ''))}
          />
          <Button theme='primary' onClick={() => load()}>
            筛选
          </Button>
          <Button icon={<RefreshIcon />} onClick={() => load()}>
            刷新
          </Button>
          <Button
            variant='outline'
            theme='danger'
            onClick={() => {
              setStatus('failed');
              load({ status: 'failed' });
            }}
          >
            只看失败
          </Button>
          <Button
            variant='outline'
            onClick={() => {
              setQ('');
              setTenantId('');
              setModule('');
              setStatus('');
              setErrorType('');
              load({ q: '', tenantId: '', module: '', status: '', errorType: '' });
            }}
          >
            清空筛选
          </Button>
        </Space>
        <Table
          loading={loading}
          rowKey='id'
          data={rows}
          columns={columns}
          pagination={{ defaultPageSize: 20, total: rows.length, showJumper: true }}
        />
      </Card>

      <Drawer
        size='760px'
        visible={drawerVisible}
        header='操作详情'
        onClose={() => setDrawerVisible(false)}
        footer={false}
      >
        {detail && (
          <Space direction='vertical' style={{ width: '100%' }} size={16}>
            <Card bordered title='基础信息'>
              <InfoGrid
                items={[
                  ['客户', detail.activity.tenant_name || '-'],
                  ['用户', detail.activity.user_name || detail.activity.user_email || '-'],
                  ['模块', detail.activity.module],
                  ['动作', detail.activity.action],
                  ['状态', statusText(detail.activity.status)],
                  ['Request ID', detail.activity.request_id || '-'],
                  ['目标', `${detail.activity.target_type || '-'} / ${detail.activity.target_id || '-'}`],
                  ['时间', formatTime(detail.activity.created_at)],
                ]}
              />
            </Card>
            {failedStep && (
              <Card bordered title='失败定位'>
                <InfoGrid
                  items={[
                    ['失败步骤', failedStep.step_name || failedStep.step_key],
                    ['错误类型', errorTypeText(detail.activity.error_type)],
                    ['说明', failedStep.message || detail.activity.message || '-'],
                    ['错误详情', failedStep.error_detail || detail.activity.error_detail || '-'],
                  ]}
                />
              </Card>
            )}
            <Card bordered title='步骤链路'>
              <Table
                rowKey='id'
                data={detail.steps}
                columns={[
                  { colKey: 'step_name', title: '步骤' },
                  {
                    colKey: 'status',
                    title: '状态',
                    width: 90,
                    cell: ({ row }: { row: CustomerOperationStep }) => (
                      <Tag theme={statusTheme(row.status)} variant='light'>
                        {statusText(row.status)}
                      </Tag>
                    ),
                  },
                  {
                    colKey: 'duration_ms',
                    title: '耗时',
                    width: 90,
                    cell: ({ row }: { row: CustomerOperationStep }) =>
                      row.duration_ms == null ? '-' : `${row.duration_ms}ms`,
                  },
                  { colKey: 'message', title: '说明', ellipsis: true },
                  { colKey: 'error_detail', title: '错误', ellipsis: true },
                ]}
              />
            </Card>
            <JsonBlock title='请求摘要' value={detail.activity.request_payload} />
            <JsonBlock title='结果摘要' value={detail.activity.response_summary} />
            {detail.activity.error_detail && <JsonBlock title='错误详情' value={detail.activity.error_detail} />}
          </Space>
        )}
      </Drawer>
    </div>
  );
};

const Metric: React.FC<{ title: string; value: number; suffix?: string; theme?: 'success' | 'danger' }> = ({
  title,
  value,
  suffix,
  theme,
}) => (
  <Card bordered>
    <div style={{ color: 'var(--td-text-color-secondary)' }}>{title}</div>
    <div
      style={{
        fontSize: 32,
        fontWeight: 800,
        color: theme === 'success' ? '#00a870' : theme === 'danger' ? '#e34d59' : undefined,
      }}
    >
      {value}
      {suffix || ''}
    </div>
  </Card>
);

const InfoGrid: React.FC<{ items: Array<[string, React.ReactNode]> }> = ({ items }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 10, columnGap: 12 }}>
    {items.map(([label, value]) => (
      <React.Fragment key={label}>
        <div style={{ color: 'var(--td-text-color-secondary)' }}>{label}</div>
        <div style={{ wordBreak: 'break-all' }}>{value}</div>
      </React.Fragment>
    ))}
  </div>
);

const JsonBlock: React.FC<{ title: string; value: unknown }> = ({ title, value }) => (
  <Card bordered title={title}>
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' }}>
      {typeof value === 'string' ? value : JSON.stringify(value || {}, null, 2)}
    </pre>
  </Card>
);

function formatTime(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function statusText(value?: string | null) {
  if (value === 'success') return '成功';
  if (value === 'failed') return '失败';
  if (value === 'running') return '运行中';
  if (value === 'skipped') return '未执行';
  return value || '-';
}

function statusTheme(value?: string | null) {
  if (value === 'success') return 'success';
  if (value === 'failed') return 'danger';
  if (value === 'running' || value === 'skipped') return 'warning';
  return 'default';
}

function errorTypeText(value?: string | null) {
  const item = ERROR_OPTIONS.find((option) => option.value === value);
  return item?.label || value || '-';
}

function mergeTenantOptions(prev: Array<{ label: string; value: string }>, rows: CustomerActivityLog[]) {
  const map = new Map(prev.map((item) => [item.value, item.label]));
  rows.forEach((row) => {
    if (row.tenant_id) {
      map.set(row.tenant_id, row.tenant_name || row.tenant_id);
    }
  });
  return Array.from(map.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

export default Observability;
