import React, { useEffect, useMemo, useState } from 'react';
import {
  Table,
  Tag,
  Button,
  Space,
  Card,
  Input,
  Select,
  MessagePlugin,
  Popconfirm,
  Tooltip,
  PrimaryTableCol,
} from 'tdesign-react';
import { RefreshIcon, SearchIcon, LinkIcon } from 'tdesign-icons-react';
import {
  deleteLead,
  listLeads,
  updateLead,
  Lead,
  FollowupStatus,
  FOLLOWUP_STATUS_LABEL,
  FOLLOWUP_STATUS_THEME,
} from 'services/zggeo-api';
import LeadDetailDrawer from 'components/LeadDetailDrawer';
import { removeDeletedLeadProjectCache } from 'utils/projectContext';
import Style from './index.module.less';

/**
 * L2 销售漏斗 · 留资线索
 * 数据源：codex 后端 GET /leads  (http://localhost:8010/leads)
 * 通过 vite proxy → /api/zggeo/leads
 */

const NOTIFY_THEME: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  success: 'success',
  pending: 'warning',
  failed: 'danger',
};

const NOTIFY_LABEL: Record<string, string> = {
  success: '已通知',
  pending: '待通知',
  failed: '通知失败',
};

const FOLLOWUP_OPTIONS: { label: string; value: FollowupStatus }[] = [
  { label: '新留资', value: 'new' },
  { label: '已联系', value: 'contacted' },
  { label: '跟进中', value: 'in_progress' },
  { label: '已关闭', value: 'closed' },
];

const FILTER_OPTIONS: { label: string; value: FollowupStatus | 'all' }[] = [
  { label: '全部状态', value: 'all' },
  ...FOLLOWUP_OPTIONS,
];

const Leads: React.FC = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<FollowupStatus | 'all'>('all');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // 留资详情 Drawer
  const [detailOpen, setDetailOpen] = useState(false);
  const [currentLead, setCurrentLead] = useState<Lead | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await listLeads();
      setLeads(data);
    } catch (err: any) {
      MessagePlugin.error(`拉取留资失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleStatusChange = async (leadId: string, next: FollowupStatus) => {
    setUpdatingId(leadId);
    try {
      await updateLead(leadId, { followup_status: next });
      MessagePlugin.success('状态已更新');
      // 乐观更新：本地先改，免去整表重拉
      setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, followup_status: next } : l)));
    } catch (err: any) {
      MessagePlugin.error(`更新失败：${err?.message || '未知错误'}`);
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDeleteLead = async (lead: Lead) => {
    setUpdatingId(lead.id);
    try {
      await deleteLead(lead.id);
      removeDeletedLeadProjectCache([lead]);
      setLeads((prev) => prev.filter((item) => item.id !== lead.id));
      if (currentLead?.id === lead.id) {
        setCurrentLead(null);
        setDetailOpen(false);
      }
      MessagePlugin.success('留资已删除');
    } catch (err: any) {
      MessagePlugin.error(`删除失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setUpdatingId(null);
    }
  };

  // 按关键词 + 状态筛选
  const filtered = useMemo(() => {
    return leads.filter((l) => {
      if (statusFilter !== 'all' && l.followup_status !== statusFilter) return false;
      if (!keyword) return true;
      const k = keyword.toLowerCase();
      return (
        (l.name || '').toLowerCase().includes(k) ||
        (l.contact || '').toLowerCase().includes(k) ||
        (l.company || '').toLowerCase().includes(k) ||
        (l.needs || '').toLowerCase().includes(k)
      );
    });
  }, [leads, keyword, statusFilter]);

  // 统计面板数据
  const stats = useMemo(() => {
    const s = { total: leads.length, new: 0, contacted: 0, in_progress: 0, closed: 0 };
    leads.forEach((l) => {
      const fs = l.followup_status || 'new';
      if (fs in s) (s as any)[fs] += 1;
    });
    return s;
  }, [leads]);

  const columns: PrimaryTableCol<Lead>[] = [
    {
      colKey: 'created_at',
      title: '提交时间',
      width: 160,
      cell: ({ row }) => (row.created_at ? new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }) : '-'),
    },
    {
      colKey: 'name',
      title: '姓名',
      width: 120,
      cell: ({ row }) => <strong>{row.name || '-'}</strong>,
    },
    {
      colKey: 'contact',
      title: '联系方式',
      width: 180,
      cell: ({ row }) => <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{row.contact || '-'}</span>,
    },
    {
      colKey: 'company',
      title: '公司',
      width: 160,
      cell: ({ row }) => row.company || <span style={{ color: '#999' }}>—</span>,
    },
    {
      colKey: 'needs',
      title: '需求描述',
      minWidth: 240,
      cell: ({ row }) => (
        <Tooltip content={row.needs || ''} placement='top'>
          <div
            style={{
              maxWidth: 300,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.needs || '-'}
          </div>
        </Tooltip>
      ),
    },
    {
      colKey: 'source_page',
      title: '来源',
      width: 140,
      cell: ({ row }) => {
        if (!row.source_page) return <span style={{ color: '#999' }}>—</span>;
        const hasReport = row.source_page.includes('report_id');
        return (
          <Tag theme={hasReport ? 'primary' : 'default'} variant='light'>
            {hasReport ? '报告落地页' : row.source_page}
          </Tag>
        );
      },
    },
    {
      colKey: 'report_id',
      title: '关联报告',
      width: 120,
      cell: ({ row }) =>
        row.report_id ? (
          <Button
            variant='text'
            theme='primary'
            size='small'
            icon={<LinkIcon />}
            onClick={() => MessagePlugin.info(`跳转到报告 ${row.report_id?.slice(0, 8)}... (L4 页面待接)`)}
          >
            查看报告
          </Button>
        ) : (
          <span style={{ color: '#999' }}>—</span>
        ),
    },
    {
      colKey: 'notify_status',
      title: '通知',
      width: 100,
      cell: ({ row }) => {
        const st = row.notify_status || 'pending';
        return (
          <Tooltip content={row.notify_error || NOTIFY_LABEL[st] || st} placement='top' destroyOnClose>
            <Tag theme={NOTIFY_THEME[st] || 'default'} variant='light'>
              {NOTIFY_LABEL[st] || st}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      colKey: 'followup_status',
      title: '跟进状态',
      width: 130,
      fixed: 'right',
      cell: ({ row }) => {
        const current = (row.followup_status || 'new') as FollowupStatus;
        return (
          <Select
            value={current}
            size='small'
            style={{ width: 100 }}
            options={FOLLOWUP_OPTIONS}
            loading={updatingId === row.id}
            onChange={(v) => handleStatusChange(row.id, v as FollowupStatus)}
            borderless={false}
          />
        );
      },
    },
    {
      colKey: 'actions',
      title: '操作',
      width: 160,
      fixed: 'right',
      cell: ({ row }) => (
        <Space size='small'>
          <Button
            variant='text'
            theme='primary'
            size='small'
            onClick={() => {
              setCurrentLead(row);
              setDetailOpen(true);
            }}
          >
            详情
          </Button>
          <Popconfirm
            content='确认将此线索关闭？'
            onConfirm={() => handleStatusChange(row.id, 'closed')}
            placement='top-right'
          >
            <Button variant='text' theme='danger' size='small'>
              关闭
            </Button>
          </Popconfirm>
          <Popconfirm
            content='确认永久删除这条留资？相关 Prompt、报告和自动流程记录也会一并清理。'
            onConfirm={() => handleDeleteLead(row)}
            placement='top-right'
          >
            <Button variant='text' theme='danger' size='small' loading={updatingId === row.id}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className={Style.page}>
      {/* 统计卡 */}
      <Card bordered style={{ marginBottom: 16 }} bodyStyle={{ padding: '20px 24px' }}>
        <div className={Style.statsRow}>
          <StatItem label='全部留资' value={stats.total} color='#6366F1' highlight />
          <StatItem label='新留资' value={stats.new} color='#F59E0B' />
          <StatItem label='已联系' value={stats.contacted} color='#3B82F6' />
          <StatItem label='跟进中' value={stats.in_progress} color='#6366F1' />
          <StatItem label='已关闭' value={stats.closed} color='#94A3B8' />
        </div>
      </Card>

      {/* 工具栏 */}
      <Card bordered bodyStyle={{ padding: 16 }}>
        <div className={Style.toolbar}>
          <div className={Style.filterGroup}>
            <Input
              placeholder='搜姓名 / 联系方式 / 公司 / 需求'
              value={keyword}
              onChange={setKeyword}
              prefixIcon={<SearchIcon />}
              className={Style.searchInput}
              clearable
            />
            <Select
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as FollowupStatus | 'all')}
              options={FILTER_OPTIONS}
              className={Style.statusSelect}
            />
          </div>
          <div className={Style.actionGroup}>
            <Tag theme='success' variant='light' className={Style.sourceTag}>
              来源：codex GET /leads · http://localhost:8010
            </Tag>
            <Button
              theme='default'
              variant='outline'
              icon={<RefreshIcon />}
              loading={loading}
              onClick={fetchData}
              className={Style.refreshButton}
            >
              刷新
            </Button>
          </div>
        </div>

        <div className={Style.tableWrap}>
          <Table
            data={filtered}
            columns={columns}
            rowKey='id'
            loading={loading}
            bordered
            stripe
            hover
            size='medium'
            empty={
              leads.length === 0
                ? '尚无留资数据（可在 codex 前端 :3001 /contact 页面提交一条测试）'
                : '没有符合条件的留资'
            }
            pagination={{
              defaultCurrent: 1,
              defaultPageSize: 20,
              total: filtered.length,
              showJumper: true,
            }}
          />
        </div>
      </Card>

      {/* 留资详情 Drawer */}
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

// -------------------- 小组件 --------------------
interface StatItemProps {
  label: string;
  value: number;
  color: string;
  highlight?: boolean;
}
const StatItem: React.FC<StatItemProps> = ({ label, value, color, highlight }) => (
  <div>
    <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginBottom: 4 }}>{label}</div>
    <div
      style={{
        fontSize: highlight ? 28 : 22,
        fontWeight: 600,
        color,
        lineHeight: 1,
      }}
    >
      {value}
    </div>
  </div>
);

export default Leads;
