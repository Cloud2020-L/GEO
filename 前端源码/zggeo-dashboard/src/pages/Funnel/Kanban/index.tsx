import React, { useEffect, useMemo, useState } from 'react';
import { Card, Tag, Button, Input, MessagePlugin, Skeleton } from 'tdesign-react';
import { RefreshIcon, SearchIcon, UserIcon, TimeFilledIcon } from 'tdesign-icons-react';
import { listLeads, updateLead, Lead, FollowupStatus } from 'services/zggeo-api';
import LeadDetailDrawer from 'components/LeadDetailDrawer';

/**
 * L2 销售漏斗 · 跟进看板
 * 把留资按 followup_status 分成 4 列，支持拖拽换状态（HTML5 原生拖拽）
 */

interface Column {
  key: FollowupStatus;
  label: string;
  color: string;
  bg: string;
}

const COLUMNS: Column[] = [
  { key: 'new', label: '🌱 新留资', color: '#F59E0B', bg: '#FFF7ED' },
  { key: 'contacted', label: '📞 已联系', color: '#3B82F6', bg: '#EFF6FF' },
  { key: 'in_progress', label: '🔥 跟进中', color: '#6366F1', bg: '#EEF2FF' },
  { key: 'closed', label: '🗃️ 已关闭', color: '#94A3B8', bg: '#F8FAFC' },
];

const timeAgo = (iso?: string) => {
  if (!iso) return '-';
  const d = Date.now() - new Date(iso).getTime();
  const h = Math.floor(d / 3600_000);
  if (h < 1) return '刚刚';
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
};

const Kanban: React.FC = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [hoverCol, setHoverCol] = useState<FollowupStatus | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [currentLead, setCurrentLead] = useState<Lead | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      setLeads(await listLeads());
    } catch (e: any) {
      MessagePlugin.error(`拉取留资失败：${e?.message || '未知'}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    fetchData();
  }, []);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return leads;
    return leads.filter(
      (l) =>
        (l.name || '').toLowerCase().includes(k) ||
        (l.contact || '').toLowerCase().includes(k) ||
        (l.company || '').toLowerCase().includes(k) ||
        (l.needs || '').toLowerCase().includes(k),
    );
  }, [leads, keyword]);

  const grouped = useMemo(() => {
    const g: Record<FollowupStatus, Lead[]> = {
      new: [],
      contacted: [],
      in_progress: [],
      closed: [],
    };
    filtered.forEach((l) => {
      const s = (l.followup_status || 'new') as FollowupStatus;
      if (g[s]) g[s].push(l);
    });
    // 每列按时间倒序
    Object.keys(g).forEach((k) =>
      g[k as FollowupStatus].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
    );
    return g;
  }, [filtered]);

  const moveLead = async (leadId: string, next: FollowupStatus) => {
    const prev = leads.find((l) => l.id === leadId)?.followup_status;
    if (prev === next) return;
    // 乐观更新
    setLeads((ls) => ls.map((l) => (l.id === leadId ? { ...l, followup_status: next } : l)));
    try {
      await updateLead(leadId, { followup_status: next });
      MessagePlugin.success(`已移到「${COLUMNS.find((c) => c.key === next)?.label}」`);
    } catch (e: any) {
      // 回滚
      setLeads((ls) => ls.map((l) => (l.id === leadId ? { ...l, followup_status: prev } : l)));
      MessagePlugin.error(`移动失败：${e?.message || '未知'}`);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      {/* 工具栏 */}
      <Card bordered={false} style={{ marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input
            prefixIcon={<SearchIcon />}
            placeholder='搜姓名 / 联系方式 / 公司'
            value={keyword}
            onChange={(v) => setKeyword(v as string)}
            style={{ width: 280 }}
            clearable
          />
          <div style={{ flex: 1 }} />
          <Tag theme='success' variant='light'>
            拖拽卡片换状态
          </Tag>
          <Button icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </div>
      </Card>

      {/* 看板 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 12,
          alignItems: 'start',
        }}
      >
        {COLUMNS.map((col) => {
          const items = grouped[col.key];
          const isHover = hoverCol === col.key;
          return (
            <div
              key={col.key}
              onDragOver={(e) => {
                e.preventDefault();
                setHoverCol(col.key);
              }}
              onDragLeave={() => setHoverCol(null)}
              onDrop={(e) => {
                e.preventDefault();
                setHoverCol(null);
                const id = e.dataTransfer.getData('text/plain');
                if (id) moveLead(id, col.key);
                setDragging(null);
              }}
              style={{
                background: col.bg,
                borderRadius: 10,
                padding: 12,
                minHeight: 400,
                outline: isHover ? `2px dashed ${col.color}` : '2px dashed transparent',
                transition: 'outline 120ms',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontWeight: 600, color: col.color, fontSize: 13 }}>{col.label}</div>
                <Tag theme='default' variant='light' size='small'>
                  {items.length}
                </Tag>
              </div>

              {loading && items.length === 0 && (
                <Skeleton
                  animation='gradient'
                  theme='paragraph'
                  loading
                  rowCol={[
                    { width: '100%', height: 'px' },
                    { width: '100%', height: 'px' },
                    { width: '100%', height: 'px' },
                  ]}
                />
              )}
              {!loading && items.length === 0 && (
                <div
                  style={{ textAlign: 'center', padding: 24, color: 'var(--td-text-color-placeholder)', fontSize: 12 }}
                >
                  这列暂时空
                </div>
              )}

              <div style={{ display: 'grid', gap: 8 }}>
                {items.map((l) => {
                  const isDrag = dragging === l.id;
                  return (
                    <div
                      key={l.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', l.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDragging(l.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                      onClick={() => {
                        setCurrentLead(l);
                        setDetailOpen(true);
                      }}
                      style={{
                        background: '#fff',
                        borderRadius: 8,
                        padding: 10,
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                        cursor: 'grab',
                        opacity: isDrag ? 0.4 : 1,
                        transform: isDrag ? 'scale(0.98)' : 'none',
                        transition: 'opacity 120ms, transform 120ms',
                        borderLeft: `3px solid ${col.color}`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                        <UserIcon style={{ color: col.color }} />
                        {l.name || '（未留姓名）'}
                      </div>
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 12,
                          color: 'var(--td-text-color-secondary)',
                          fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace',
                        }}
                      >
                        {l.contact || '—'}
                      </div>
                      {l.company && (
                        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--td-text-color-secondary)' }}>
                          🏢 {l.company}
                        </div>
                      )}
                      {l.needs && (
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 12,
                            color: 'var(--td-text-color-placeholder)',
                            lineHeight: 1.5,
                            overflow: 'hidden',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                          }}
                        >
                          {l.needs}
                        </div>
                      )}
                      <div
                        style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                      >
                        <span style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>
                          <TimeFilledIcon style={{ verticalAlign: 'middle', marginRight: 2 }} />
                          {timeAgo(l.created_at)}
                        </span>
                        {l.report_id && (
                          <Tag size='small' theme='primary' variant='light'>
                            含报告
                          </Tag>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

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

export default Kanban;
