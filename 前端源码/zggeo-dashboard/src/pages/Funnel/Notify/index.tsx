import React, { useEffect, useMemo, useState } from 'react';
import {
  Card,
  Tag,
  Button,
  Space,
  Table,
  Input,
  MessagePlugin,
  Skeleton,
  PrimaryTableCol,
  Select,
} from 'tdesign-react';
import {
  RefreshIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  TimeFilledIcon,
  SearchIcon,
  NotificationIcon,
} from 'tdesign-icons-react';
import { listLeads, Lead } from 'services/zggeo-api';
import LeadDetailDrawer from 'components/LeadDetailDrawer';

/**
 * L2 销售漏斗 · 通知中心
 * 从 leads 里抽 notify_status / notification_channel / notify_error 做仪表
 */

const NOTIFY_CONFIG: Record<
  string,
  { label: string; theme: 'success' | 'warning' | 'danger' | 'default'; color: string; icon: React.ReactElement }
> = {
  success: { label: '已通知', theme: 'success', color: '#10B981', icon: <CheckCircleFilledIcon /> },
  pending: { label: '待通知', theme: 'warning', color: '#F59E0B', icon: <TimeFilledIcon /> },
  failed: { label: '通知失败', theme: 'danger', color: '#EF4444', icon: <CloseCircleFilledIcon /> },
};

const Notify: React.FC = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'pending' | 'failed'>('all');
  const [detailOpen, setDetailOpen] = useState(false);
  const [currentLead, setCurrentLead] = useState<Lead | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      setLeads(await listLeads());
    } catch {
      MessagePlugin.error('拉取留资失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    fetchData();
  }, []);

  // 按 notify_status 分桶
  const stats = useMemo(() => {
    const s: Record<string, number> = { success: 0, pending: 0, failed: 0, unknown: 0 };
    const channelMap: Record<string, number> = {};
    leads.forEach((l) => {
      const st = (l.notify_status as string) || 'pending';
      s[st] = (s[st] || 0) + 1;
      if (l.notification_channel) {
        const c = String(l.notification_channel);
        channelMap[c] = (channelMap[c] || 0) + 1;
      }
    });
    const successRate = leads.length > 0 ? Math.round((s.success / leads.length) * 100) : 0;
    return { s, channelMap, successRate };
  }, [leads]);

  const filtered = useMemo(() => {
    return leads.filter((l) => {
      const st = (l.notify_status as string) || 'pending';
      if (statusFilter !== 'all' && st !== statusFilter) return false;
      if (!keyword) return true;
      const k = keyword.toLowerCase();
      return (
        (l.name || '').toLowerCase().includes(k) ||
        (l.contact || '').toLowerCase().includes(k) ||
        (l.company || '').toLowerCase().includes(k) ||
        (l.notify_error || '').toLowerCase().includes(k)
      );
    });
  }, [leads, keyword, statusFilter]);

  const columns: PrimaryTableCol<Lead>[] = [
    {
      colKey: 'created_at',
      title: '时间',
      width: 160,
      cell: ({ row }) => (row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : '-'),
    },
    {
      colKey: 'name',
      title: '来源留资',
      cell: ({ row }) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.name || '（未留姓名）'}</div>
          <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>
            {row.company || '—'} · {row.contact || '—'}
          </div>
        </div>
      ),
    },
    {
      colKey: 'notification_channel',
      title: '通道',
      width: 120,
      cell: ({ row }) =>
        row.notification_channel ? (
          <Tag theme='default' variant='light'>
            {String(row.notification_channel)}
          </Tag>
        ) : (
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>
        ),
    },
    {
      colKey: 'notify_status',
      title: '状态',
      width: 120,
      cell: ({ row }) => {
        const cfg = NOTIFY_CONFIG[(row.notify_status as string) || 'pending'] || NOTIFY_CONFIG.pending;
        return (
          <Tag theme={cfg.theme} variant='light' icon={cfg.icon}>
            {cfg.label}
          </Tag>
        );
      },
    },
    {
      colKey: 'notify_error',
      title: '错误信息',
      ellipsis: true,
      cell: ({ row }) =>
        row.notify_error ? (
          <span style={{ color: '#991B1B', fontSize: 12 }}>{row.notify_error}</span>
        ) : (
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>
        ),
    },
    {
      colKey: 'action',
      title: '操作',
      width: 100,
      fixed: 'right',
      cell: ({ row }) => (
        <Button
          size='small'
          variant='text'
          theme='primary'
          onClick={() => {
            setCurrentLead(row);
            setDetailOpen(true);
          }}
        >
          详情
        </Button>
      ),
    },
  ];

  return (
    <div style={{ padding: 16 }}>
      {/* 顶部仪表：成功率 + 分布 */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 3fr', gap: 16, marginBottom: 16 }}>
        <Card
          bordered={false}
          style={{
            background: 'linear-gradient(135deg, #ECFDF5 0%, #D1FAE5 100%)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                background: '#10B981',
                color: '#fff',
                fontSize: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <NotificationIcon />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: '#065F46' }}>通知成功率</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: '#064E3B', lineHeight: 1 }}>{stats.successRate}%</div>
              <div style={{ fontSize: 11, color: '#047857', marginTop: 2 }}>
                {leads.length} 条留资 · {stats.s.success || 0} 成功 / {stats.s.failed || 0} 失败 /{' '}
                {stats.s.pending || 0} 待发
              </div>
            </div>
          </div>
        </Card>

        <Card bordered={false} style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginBottom: 12 }}>状态分布</div>
          <StatusBar total={leads.length} s={stats.s} />
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--td-text-color-secondary)' }}>
            通道分布：
            {Object.keys(stats.channelMap).length === 0 ? (
              <span style={{ color: 'var(--td-text-color-placeholder)', marginLeft: 8 }}>
                （留资还没写通道字段，或后端还没配置 notify workflow）
              </span>
            ) : (
              <Space size={6} style={{ marginLeft: 8 }}>
                {Object.entries(stats.channelMap).map(([c, n]) => (
                  <Tag key={c} size='small' theme='default' variant='light'>
                    {c} · {n}
                  </Tag>
                ))}
              </Space>
            )}
          </div>
        </Card>
      </div>

      {/* 工具栏 */}
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Input
            prefixIcon={<SearchIcon />}
            placeholder='搜姓名 / 联系方式 / 错误内容'
            value={keyword}
            onChange={(v) => setKeyword(v as string)}
            style={{ width: 280 }}
            clearable
          />
          <Select
            value={statusFilter}
            options={[
              { label: '全部状态', value: 'all' },
              { label: '已通知', value: 'success' },
              { label: '待通知', value: 'pending' },
              { label: '通知失败', value: 'failed' },
            ]}
            onChange={(v) => setStatusFilter(v as any)}
            style={{ width: 160 }}
          />
          <div style={{ flex: 1 }} />
          <Tag theme='success' variant='light'>
            {filtered.length} 条
          </Tag>
          <Button icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </div>
      </Card>

      <Card bordered={false}>
        {loading && leads.length === 0 ? (
          <Skeleton
            animation='gradient'
            theme='paragraph'
            loading
            rowCol={[
              { width: '100%', height: 'px' },
              { width: '100%', height: 'px' },
              { width: '100%', height: 'px' },
              { width: '100%', height: 'px' },
              { width: '100%', height: 'px' },
            ]}
          />
        ) : (
          <Table
            data={filtered}
            columns={columns}
            rowKey='id'
            size='medium'
            stripe
            hover
            empty='暂无通知记录'
            pagination={{ defaultPageSize: 20, total: filtered.length, showJumper: true }}
          />
        )}
      </Card>

      <LeadDetailDrawer
        visible={detailOpen}
        lead={currentLead}
        onClose={() => setDetailOpen(false)}
        onUpdated={(next) => {
          setLeads((prev) => prev.map((l) => (l.id === next.id ? { ...l, ...next } : l)));
          setCurrentLead(next);
        }}
      />
    </div>
  );
};

// 堆叠条形图：success / pending / failed
const StatusBar: React.FC<{ total: number; s: Record<string, number> }> = ({ total, s }) => {
  if (total === 0) return <div style={{ height: 24, background: '#F3F4F6', borderRadius: 6 }} />;
  const segs = [
    { key: 'success', color: '#10B981', n: s.success || 0, label: '成功' },
    { key: 'pending', color: '#F59E0B', n: s.pending || 0, label: '待发' },
    { key: 'failed', color: '#EF4444', n: s.failed || 0, label: '失败' },
  ];
  return (
    <>
      <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden' }}>
        {segs.map((g) => {
          const pct = (g.n / total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={g.key}
              title={`${g.label} ${g.n} · ${pct.toFixed(1)}%`}
              style={{ width: `${pct}%`, background: g.color }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11 }}>
        {segs.map((g) => (
          <span key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, background: g.color, borderRadius: 2 }} />
            {g.label} {g.n}
          </span>
        ))}
      </div>
    </>
  );
};

export default Notify;
