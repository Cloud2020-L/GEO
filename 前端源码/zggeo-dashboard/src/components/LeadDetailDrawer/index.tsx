import React, { useEffect, useMemo, useState } from 'react';
import { Drawer, Tag, Button, Space, Divider, Input, Select, Textarea, MessagePlugin, Tooltip } from 'tdesign-react';
import {
  FileCopyIcon,
  ChartIcon,
  SaveIcon,
  LinkIcon,
  UserIcon,
  Edit1Icon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  TimeFilledIcon,
} from 'tdesign-icons-react';
import { useNavigate } from 'react-router-dom';
import { Lead, FollowupStatus, updateLead } from 'services/zggeo-api';
import { useAppSelector } from 'modules/store';
import {
  leadToProjectContext,
  normalizeDomain,
  saveActiveProjectContext,
  upsertBrandFromProjectContext,
} from 'utils/projectContext';
import { scopedStorageKey } from 'utils/scopedStorage';

/**
 * 留资线索详情 Drawer
 * - 展示全字段（含通知回执）
 * - 跟进状态可就地切换
 * - 本地备注（localStorage）— 后端 schema 暂无 notes 字段，先落本地
 */

interface Props {
  visible: boolean;
  lead: Lead | null;
  onClose: () => void;
  onUpdated?: (lead: Lead) => void;
}

const FOLLOWUP_OPTIONS: { label: string; value: FollowupStatus }[] = [
  { label: '新留资', value: 'new' },
  { label: '已联系', value: 'contacted' },
  { label: '跟进中', value: 'in_progress' },
  { label: '已关闭', value: 'closed' },
];

const FOLLOWUP_THEME: Record<FollowupStatus, 'success' | 'primary' | 'warning' | 'danger' | 'default'> = {
  new: 'warning',
  contacted: 'primary',
  in_progress: 'primary',
  closed: 'default',
};

const FOLLOWUP_LABEL: Record<FollowupStatus, string> = {
  new: '新留资',
  contacted: '已联系',
  in_progress: '跟进中',
  closed: '已关闭',
};

const NOTIFY_CONFIG: Record<
  string,
  { label: string; theme: 'success' | 'warning' | 'danger' | 'default'; icon: React.ReactElement }
> = {
  success: { label: '已通知', theme: 'success', icon: <CheckCircleFilledIcon /> },
  pending: { label: '待通知', theme: 'warning', icon: <TimeFilledIcon /> },
  failed: { label: '通知失败', theme: 'danger', icon: <CloseCircleFilledIcon /> },
};

const NOTES_KEY = (leadId: string) => scopedStorageKey(`example.com.${leadId}`);

interface LeadEditForm {
  company: string;
  brandName: string;
  domain: string;
  keywords: string;
  competitors: string;
  name: string;
  contact: string;
  needs: string;
}

const listToText = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((item) => String(item).trim())
        .filter(Boolean)
        .join('\n')
    : '';

const parseTextList = (raw: string) =>
  raw
    .split(/[\n,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);

const leadToEditForm = (lead: Lead): LeadEditForm => ({
  company: String(lead.company || ''),
  brandName: String(lead.brand_name || lead.company || lead.name || ''),
  domain: String(lead.domain || ''),
  keywords: listToText(lead.keywords),
  competitors: listToText(lead.competitors),
  name: String(lead.name || ''),
  contact: String(lead.contact || ''),
  needs: String(lead.needs || ''),
});

const loadNotes = (leadId: string): string => {
  try {
    return localStorage.getItem(NOTES_KEY(leadId)) || '';
  } catch {
    return '';
  }
};

const saveNotes = (leadId: string, notes: string) => {
  try {
    if (notes) {
      localStorage.setItem(NOTES_KEY(leadId), notes);
    } else {
      localStorage.removeItem(NOTES_KEY(leadId));
    }
  } catch {
    // ignore quota
  }
};

const LeadDetailDrawer: React.FC<Props> = ({ visible, lead, onClose, onUpdated }) => {
  const navigate = useNavigate();
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const isClientMember = String(user?.role || '').toLowerCase() === 'client';
  const [followup, setFollowup] = useState<FollowupStatus>('new');
  const [followupSaving, setFollowupSaving] = useState(false);
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [editForm, setEditForm] = useState<LeadEditForm | null>(null);

  useEffect(() => {
    if (!visible || !lead) return;
    setFollowup((lead.followup_status || 'new') as FollowupStatus);
    setNotes(loadNotes(lead.id));
    setNotesDirty(false);
    setEditing(false);
    setEditForm(leadToEditForm(lead));
  }, [visible, lead]);

  const handleCopy = async (text: string, label = '内容') => {
    try {
      await navigator.clipboard.writeText(text);
      MessagePlugin.success(`${label}已复制`);
    } catch {
      MessagePlugin.error('复制失败');
    }
  };

  const handleFollowupChange = async (next: FollowupStatus) => {
    if (!lead) return;
    setFollowupSaving(true);
    try {
      const nextLead = await updateLead(lead.id, { followup_status: next });
      setFollowup(next);
      MessagePlugin.success('跟进状态已更新');
      onUpdated?.(nextLead);
    } catch (err: any) {
      MessagePlugin.error(`更新失败：${err?.message || '未知错误'}`);
    } finally {
      setFollowupSaving(false);
    }
  };

  const handleSaveNotes = () => {
    if (!lead) return;
    saveNotes(lead.id, notes);
    setNotesDirty(false);
    MessagePlugin.success('备注已保存到本地');
  };

  const syncLeadToProjectContext = (sourceLead: Lead) => {
    const context = leadToProjectContext(sourceLead);
    if (!context) {
      MessagePlugin.warning('这条客户资料还缺品牌或域名，暂时不能带入后续页面');
      return;
    }
    saveActiveProjectContext(context);
    upsertBrandFromProjectContext(context);
    if (!context.domain) {
      MessagePlugin.warning('已设为当前项目，但还缺官网域名，后续诊断前请补齐');
      return;
    }
    MessagePlugin.success('已设为当前项目，并同步到品牌池；后续页面会自动带入');
  };

  const handleSaveProfile = async () => {
    if (!lead || !editForm) return;

    if (isClientMember) {
      setProfileSaving(true);
      try {
        const next = await updateLead(lead.id, {
          keywords: parseTextList(editForm.keywords),
        });
        onUpdated?.(next);
        setEditing(false);
        setEditForm(leadToEditForm(next));
        MessagePlugin.success('监测关键词已更新');
      } catch (err: any) {
        MessagePlugin.error(`保存失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
      } finally {
        setProfileSaving(false);
      }
      return;
    }

    const brandName = editForm.brandName.trim() || editForm.company.trim();
    const name = editForm.name.trim();
    const contact = editForm.contact.trim();
    const needs = editForm.needs.trim();
    const domain = normalizeDomain(editForm.domain);
    if (!brandName || !name || !contact || !needs) {
      MessagePlugin.warning('请至少补齐品牌/项目、联系人、联系方式和客户需求');
      return;
    }

    setProfileSaving(true);
    try {
      const next = await updateLead(lead.id, {
        company: editForm.company.trim(),
        brand_name: brandName,
        domain,
        keywords: parseTextList(editForm.keywords),
        competitors: parseTextList(editForm.competitors),
        name,
        contact,
        needs,
      });
      onUpdated?.(next);
      setEditing(false);
      setEditForm(leadToEditForm(next));
      syncLeadToProjectContext(next);
    } catch (err: any) {
      MessagePlugin.error(`保存失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setProfileSaving(false);
    }
  };

  const notifyCfg = useMemo(() => {
    const st = (lead?.notify_status as string) || 'pending';
    return NOTIFY_CONFIG[st] || NOTIFY_CONFIG.pending;
  }, [lead]);

  const updateEditForm = (key: keyof LeadEditForm, value: string) => {
    setEditForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  if (!lead) return null;

  return (
    <Drawer
      visible={visible}
      onClose={onClose}
      size='540px'
      header={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>留资详情</span>
          <Tag theme={FOLLOWUP_THEME[followup]} variant='light'>
            {FOLLOWUP_LABEL[followup]}
          </Tag>
        </div>
      }
      footer={
        <Space>
          <Button variant='outline' icon={<Edit1Icon />} onClick={() => setEditing((prev) => !prev)}>
            {editing ? '取消编辑' : isClientMember ? '编辑关键词' : '编辑资料/补官网'}
          </Button>
          {!isClientMember && (
            <Button variant='outline' icon={<LinkIcon />} onClick={() => syncLeadToProjectContext(lead)}>
              设为当前项目
            </Button>
          )}
          {lead.report_id && (
            <Button
              icon={<ChartIcon />}
              onClick={() => {
                navigate(`/reports/scoring?report_id=${lead.report_id}`);
                onClose();
              }}
            >
              查看关联报告
            </Button>
          )}
          {!isClientMember && (
            <Button
              theme={editing ? 'default' : 'primary'}
              icon={<SaveIcon />}
              disabled={!notesDirty}
              onClick={handleSaveNotes}
            >
              保存备注
            </Button>
          )}
          {editing && (
            <Button theme='primary' icon={<SaveIcon />} loading={profileSaving} onClick={handleSaveProfile}>
              {isClientMember ? '保存关键词' : '保存客户资料'}
            </Button>
          )}
        </Space>
      }
    >
      {/* 头部卡片 */}
      <div
        style={{
          background: 'linear-gradient(135deg, #ECFEFF 0%, #E0E7FF 100%)',
          padding: 16,
          borderRadius: 10,
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: '#6366F1',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
            }}
          >
            <UserIcon />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#1F2937' }}>{lead.name || '（未留姓名）'}</div>
            <div
              style={{
                fontSize: 13,
                color: '#4B5563',
                marginTop: 2,
                fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace',
              }}
            >
              {lead.contact || '（无联系方式）'}
            </div>
          </div>
          {lead.contact && (
            <Tooltip content='复制联系方式'>
              <Button
                size='small'
                variant='outline'
                icon={<FileCopyIcon />}
                onClick={() => handleCopy(lead.contact || '', '联系方式')}
              />
            </Tooltip>
          )}
        </div>
      </div>

      {/* 基础信息 */}
      {editing && (
        <div
          style={{
            padding: 12,
            marginBottom: 12,
            borderRadius: 8,
            background: '#F8FAFC',
            border: '1px solid #E5E7EB',
            color: 'var(--td-text-color-secondary)',
            fontSize: 12,
            lineHeight: 1.7,
          }}
        >
          {isClientMember
            ? '客户会员当前仅可维护监测关键词。其他客户主档信息如需调整，请联系管理员处理。'
            : '这里是客户主档。补完官网域名并保存后，会自动设为当前项目，同步到品牌池，后续监测任务、GEO 资产生成、问题库等页面会优先带入这套资料。'}
        </div>
      )}
      <KV label='联系人'>
        {editing && editForm && !isClientMember ? (
          <Input
            value={editForm.name}
            placeholder='客户姓名 / 对接人'
            style={{ width: '100%' }}
            onChange={(v) => updateEditForm('name', String(v))}
          />
        ) : (
          lead.name || <Muted />
        )}
      </KV>
      <KV label='联系方式'>
        {editing && editForm && !isClientMember ? (
          <Input
            value={editForm.contact}
            placeholder='手机号 / 微信 / 邮箱'
            style={{ width: '100%' }}
            onChange={(v) => updateEditForm('contact', String(v))}
          />
        ) : (
          <>
            {lead.contact || <Muted />}
            {lead.contact && (
              <Button
                size='small'
                variant='text'
                icon={<FileCopyIcon />}
                onClick={() => handleCopy(lead.contact || '', '联系方式')}
              />
            )}
          </>
        )}
      </KV>
      <KV label='公司'>
        {editing && editForm && !isClientMember ? (
          <Input
            value={editForm.company}
            placeholder='公司名称，可选'
            style={{ width: '100%' }}
            onChange={(v) => updateEditForm('company', String(v))}
          />
        ) : (
          lead.company || <Muted />
        )}
      </KV>
      <KV label='品牌/项目'>
        {editing && editForm && !isClientMember ? (
          <Input
            value={editForm.brandName}
            placeholder='品牌名 / 项目名'
            style={{ width: '100%' }}
            onChange={(v) => updateEditForm('brandName', String(v))}
          />
        ) : (
          lead.brand_name || lead.company || <Muted />
        )}
      </KV>
      <KV label='官网域名'>
        {editing && editForm && !isClientMember ? (
          <Input
            value={editForm.domain}
            placeholder='例如：example.com，不用带 http://'
            style={{ width: '100%' }}
            onChange={(v) => updateEditForm('domain', String(v))}
          />
        ) : lead.domain ? (
          <span
            style={{
              fontSize: 12,
              fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace',
              color: 'var(--td-text-color-secondary)',
              wordBreak: 'break-all',
            }}
          >
            {lead.domain}
          </span>
        ) : isClientMember ? (
          <span style={{ color: '#DC2626' }}>未填写，请联系管理员补充</span>
        ) : (
          <span style={{ color: '#DC2626' }}>未填写，点“编辑资料/补官网”补上</span>
        )}
      </KV>
      <KV label='监测关键词'>
        {editing && editForm ? (
          <Textarea
            value={editForm.keywords}
            placeholder={'每行一个，例如：\n品牌名\n品牌名 官网\nAI 可见性优化'}
            autosize={{ minRows: 3, maxRows: 8 }}
            onChange={(v) => updateEditForm('keywords', String(v))}
          />
        ) : Array.isArray(lead.keywords) && lead.keywords.length > 0 ? (
          <Space size={4} style={{ flexWrap: 'wrap' }}>
            {lead.keywords.map((item) => (
              <Tag key={item} size='small' theme='primary' variant='light'>
                {item}
              </Tag>
            ))}
          </Space>
        ) : (
          <Muted />
        )}
      </KV>
      <KV label='竞品'>
        {editing && editForm && !isClientMember ? (
          <Textarea
            value={editForm.competitors}
            placeholder={'可选，每行一个竞品域名或品牌名'}
            autosize={{ minRows: 2, maxRows: 6 }}
            onChange={(v) => updateEditForm('competitors', String(v))}
          />
        ) : Array.isArray(lead.competitors) && lead.competitors.length > 0 ? (
          <Space size={4} style={{ flexWrap: 'wrap' }}>
            {lead.competitors.map((item) => (
              <Tag key={item} size='small' theme='warning' variant='light'>
                {item}
              </Tag>
            ))}
          </Space>
        ) : (
          <Muted />
        )}
      </KV>
      <KV label='需求描述'>
        {editing && editForm && !isClientMember ? (
          <Textarea
            value={editForm.needs}
            placeholder='客户需求、行业、要诊断的问题、交付目标'
            autosize={{ minRows: 4, maxRows: 10 }}
            onChange={(v) => updateEditForm('needs', String(v))}
          />
        ) : (
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{lead.needs || <Muted />}</div>
        )}
      </KV>
      <KV label='提交时间'>{lead.created_at ? new Date(lead.created_at).toLocaleString('zh-CN') : <Muted />}</KV>
      <KV label='来源页'>
        {lead.source_page ? (
          <span
            style={{
              fontSize: 12,
              fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace',
              color: 'var(--td-text-color-secondary)',
              wordBreak: 'break-all',
            }}
          >
            <LinkIcon style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {lead.source_page}
          </span>
        ) : (
          <Muted />
        )}
      </KV>
      <KV label='Lead ID'>
        <code style={{ fontSize: 12 }}>{lead.id}</code>
        <Button size='small' variant='text' icon={<FileCopyIcon />} onClick={() => handleCopy(lead.id, 'Lead ID')} />
      </KV>
      {lead.task_id && (
        <KV label='关联任务'>
          <code style={{ fontSize: 12 }}>{lead.task_id}</code>
          <Button
            size='small'
            variant='text'
            icon={<FileCopyIcon />}
            onClick={() => handleCopy(lead.task_id as string, 'Task ID')}
          />
        </KV>
      )}
      {lead.report_id && (
        <KV label='关联报告'>
          <code style={{ fontSize: 12 }}>{lead.report_id}</code>
          <Button
            size='small'
            variant='text'
            icon={<FileCopyIcon />}
            onClick={() => handleCopy(lead.report_id as string, 'Report ID')}
          />
        </KV>
      )}

      <Divider />

      {/* 通知回执 */}
      <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginBottom: 8 }}>通知回执</div>
      <Space>
        <Tag theme={notifyCfg.theme} variant='light' icon={notifyCfg.icon}>
          {notifyCfg.label}
        </Tag>
        {lead.notification_channel && (
          <Tag theme='default' variant='light'>
            通道：{lead.notification_channel}
          </Tag>
        )}
        {lead.notification_message_id && (
          <Tooltip content={String(lead.notification_message_id)}>
            <Tag theme='default' variant='light'>
              消息 ID ···
            </Tag>
          </Tooltip>
        )}
      </Space>
      {lead.notify_error && (
        <div
          style={{
            marginTop: 8,
            padding: 10,
            background: '#FEF2F2',
            color: '#991B1B',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          通知错误：{lead.notify_error}
        </div>
      )}

      {!isClientMember && <Divider />}

      {/* 跟进状态 */}
      {!isClientMember && (
        <>
          <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginBottom: 8 }}>跟进状态</div>
          <Select
            value={followup}
            options={FOLLOWUP_OPTIONS}
            onChange={(v) => handleFollowupChange(v as FollowupStatus)}
            loading={followupSaving}
            style={{ width: 200 }}
          />
        </>
      )}

      {!isClientMember && <Divider />}

      {/* 本地备注 */}
      {!isClientMember && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>
              <Edit1Icon style={{ verticalAlign: 'middle', marginRight: 4 }} />
              销售备注（仅本机可见）
            </div>
            {notesDirty && <span style={{ fontSize: 11, color: '#F59E0B' }}>未保存</span>}
          </div>
          <Textarea
            value={notes}
            onChange={(v) => {
              setNotes(v as string);
              setNotesDirty(true);
            }}
            placeholder='跟进要点、客户态度、下次联系时间…'
            autosize={{ minRows: 4, maxRows: 10 }}
          />
          <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)', marginTop: 6 }}>
            备注保存在浏览器 localStorage，后端 leads schema 暂无 notes 字段，换机器不可见。
          </div>
        </>
      )}
    </Drawer>
  );
};

// -------------------- 小组件 --------------------
const KV: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div
    style={{
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      padding: '6px 0',
      fontSize: 13,
    }}
  >
    <div style={{ minWidth: 90, color: 'var(--td-text-color-secondary)', paddingTop: 2 }}>{label}</div>
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>{children}</div>
  </div>
);

const Muted: React.FC = () => <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>;

export default LeadDetailDrawer;
