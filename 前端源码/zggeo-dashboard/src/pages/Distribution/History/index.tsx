import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Dialog,
  Form,
  Input,
  InputNumber,
  MessagePlugin,
  Pagination,
  Select,
  Space,
  Table,
  Textarea,
  Tabs,
  Tag,
} from 'tdesign-react';
import { AddIcon, RefreshIcon } from 'tdesign-icons-react';
import {
  type DistributionRecordRow,
  createDistributionRecordDb,
  getArticleDraftDb,
  updateArticleDraftDb,
  listDistributionRecordsDb,
  listOwnedPublishingTasks,
  listMediaMarketOrders,
  MEDIA_MARKET_AUDIT_LABEL,
  MEDIA_MARKET_AUDIT_THEME,
  type MediaMarketOrderRow,
  type MediaMarketPagination,
  type OwnedPublishingTaskRow,
} from 'services/zggeo-api';
import { stripMarkdownForPublish } from 'utils/publishText';
import Style from '../linear.module.less';

const { FormItem } = Form;
const { TabPanel } = Tabs;

const AUDIT_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '待审核', value: '0' },
  { label: '发布中', value: '1' },
  { label: '已发布', value: '2' },
  { label: '拒稿', value: '3' },
];

const statusThemeMap: Record<string, 'success' | 'danger' | 'warning' | 'primary'> = {
  已发布: 'success',
  失败: 'danger',
  待发布: 'warning',
};

const darkPanelTitleStyle: React.CSSProperties = {
  color: '#F8FAFC',
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: '0.01em',
};

const darkFieldLabel = (label: string) => <span style={{ color: '#CBD5E1', fontWeight: 600 }}>{label}</span>;
const accountTypeLabel = (value?: string | null) =>
  ({ personal: '个人号', enterprise: '企业号', organization: '机构号' }[String(value || '')] || value || '-');
const formatCents = (value?: number | null) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  return `￥${(Number(value) / 100).toFixed(2)}`;
};

// ---------------------- Tab 1：原内部记录 ----------------------

function InternalRecords() {
  const [data, setData] = useState<DistributionRecordRow[]>([]);
  const [open, setOpen] = useState(false);
  const [activeRecord, setActiveRecord] = useState<DistributionRecordRow | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftLoading, setDraftLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [form, setForm] = useState({
    title: '',
    channel: '媒体市场',
    target: '',
    status: '待提交',
    cost: 10,
    publish_url: '',
  });

  const fetchData = async () => {
    try {
      setData(await listDistributionRecordsDb());
    } catch (err: any) {
      MessagePlugin.error(`发稿记录加载失败：${err?.message || '未知错误'}`);
    }
  };
  useEffect(() => {
    fetchData();
  }, []);

  const openDraftEditor = async (row: DistributionRecordRow) => {
    if (!row.draft_id) {
      MessagePlugin.warning('这条发布记录没有关联文章草稿，暂时不能查看或编辑正文');
      return;
    }
    setDraftLoading(true);
    try {
      let nextRecord = row;
      if (!row.draft_body || !row.draft_title || !row.draft_status) {
        const matched = await getArticleDraftDb(String(row.draft_id));
        nextRecord = {
          ...row,
          draft_title: String(matched.title || row.draft_title || row.title || ''),
          draft_body: String(matched.body || row.draft_body || ''),
          draft_status: String(matched.status || row.draft_status || ''),
          draft_model: String(matched.model || row.draft_model || ''),
          draft_provider: String(matched.provider || row.draft_provider || ''),
          draft_created_at: String(matched.created_at || row.draft_created_at || ''),
        };
      }
      setActiveRecord(nextRecord);
      setDraftTitle(String(nextRecord.draft_title || nextRecord.title || ''));
      setDraftBody(String(nextRecord.draft_body || ''));
      if (!String(nextRecord.draft_body || '').trim()) {
        MessagePlugin.warning('这条待发布记录已关联草稿，但正文还是空的；请检查 Agent 生成链路或草稿库数据');
      }
    } catch (err: any) {
      MessagePlugin.error(`读取草稿失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setDraftLoading(false);
    }
  };

  const closeDraftEditor = () => {
    setActiveRecord(null);
    setDraftTitle('');
    setDraftBody('');
  };

  const saveDraft = async () => {
    if (!activeRecord?.draft_id) return;
    if (!draftTitle.trim()) {
      MessagePlugin.warning('文章标题不能为空');
      return;
    }
    if (!draftBody.trim()) {
      MessagePlugin.warning('文章正文不能为空');
      return;
    }
    setSavingDraft(true);
    try {
      await updateArticleDraftDb(String(activeRecord.draft_id), {
        title: draftTitle.trim(),
        body: draftBody,
        status: String(activeRecord.draft_status || activeRecord.status || '待发布'),
      });
      MessagePlugin.success('文章草稿已保存');
      closeDraftEditor();
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(`保存失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setSavingDraft(false);
    }
  };

  const copyText = async (value: string, label: string) => {
    if (!value.trim()) {
      MessagePlugin.warning(`${label}为空，无法复制`);
      return;
    }
    await navigator.clipboard.writeText(label.includes('正文') ? stripMarkdownForPublish(value) : value);
    MessagePlugin.success(`已复制${label}`);
  };

  const draftStatusText = (() => {
    if (draftLoading) return '正在读取草稿正文...';
    if (draftBody.trim()) return '当前正文已载入，可直接编辑后保存。';
    return '当前没有读取到正文内容，这不是颜色问题，而是这条草稿本身暂时没有正文。';
  })();

  const submit = async () => {
    if (!form.title || !form.target) {
      MessagePlugin.warning('请填写标题和发布对象');
      return;
    }
    await createDistributionRecordDb(form);
    MessagePlugin.success('发稿记录已写入数据库并按费用扣点');
    setOpen(false);
    fetchData();
  };

  return (
    <>
      <Card
        bordered={false}
        className={Style.sectionCard}
        title='内部发稿记录'
        actions={
          <Space>
            <Button icon={<RefreshIcon />} onClick={fetchData}>
              刷新
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={() => setOpen(true)}>
              新增记录
            </Button>
          </Space>
        }
      >
        <Table
          rowKey='id'
          data={data}
          columns={[
            { colKey: 'title', title: '稿件标题' },
            { colKey: 'channel', title: '渠道' },
            {
              colKey: 'platform',
              title: '平台 / 账号',
              cell: ({ row }) => [row.platform, row.account_name].filter(Boolean).join(' / ') || '-',
            },
            { colKey: 'target', title: '发布对象' },
            {
              colKey: 'status',
              title: '状态',
              cell: ({ row }) => (
                <Tag theme={statusThemeMap[row.status] || 'primary'} variant='light'>
                  {row.status}
                </Tag>
              ),
            },
            { colKey: 'cost', title: '扣点/费用' },
            {
              colKey: 'publish_url',
              title: '发布链接',
              cell: ({ row }) => row.publish_url || '-',
            },
            {
              colKey: 'published_at',
              title: '发布时间',
              cell: ({ row }) => (row.published_at ? new Date(row.published_at).toLocaleString('zh-CN') : '-'),
            },
            {
              colKey: 'created_at',
              title: '创建时间',
              cell: ({ row }) => new Date(row.created_at).toLocaleString('zh-CN'),
            },
            {
              colKey: 'action',
              title: '操作',
              width: 160,
              fixed: 'right',
              cell: ({ row }) => (
                <Button size='small' variant='outline' disabled={!row.draft_id} onClick={() => openDraftEditor(row)}>
                  查看/编辑正文
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Dialog visible={open} header='新增发稿记录' onClose={() => setOpen(false)} onConfirm={submit}>
        <Form layout='vertical'>
          <FormItem label='稿件标题'>
            <Input value={form.title} onChange={(v) => setForm({ ...form, title: String(v) })} />
          </FormItem>
          <FormItem label='渠道'>
            <Select
              value={form.channel}
              onChange={(v) => setForm({ ...form, channel: String(v) })}
              options={['媒体市场', '自媒体号池', '个人自媒体', '公众号发稿'].map((x) => ({
                label: x,
                value: x,
              }))}
            />
          </FormItem>
          <FormItem label='发布对象'>
            <Input value={form.target} onChange={(v) => setForm({ ...form, target: String(v) })} />
          </FormItem>
          <FormItem label='状态'>
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: String(v) })}
              options={['待提交', '待发布', '待审核', '已发布', '失败'].map((x) => ({ label: x, value: x }))}
            />
          </FormItem>
          <FormItem label='扣点'>
            <InputNumber value={form.cost} onChange={(v) => setForm({ ...form, cost: Number(v) })} />
          </FormItem>
          <FormItem label='发布链接'>
            <Input value={form.publish_url} onChange={(v) => setForm({ ...form, publish_url: String(v) })} />
          </FormItem>
        </Form>
      </Dialog>

      <Dialog
        visible={!!activeRecord}
        header='查看 / 编辑文章草稿'
        width='1100px'
        confirmBtn={savingDraft ? '保存中...' : '保存修改'}
        onClose={closeDraftEditor}
        onConfirm={saveDraft}
      >
        {activeRecord ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.35fr 1fr',
              gap: 16,
              alignItems: 'start',
            }}
          >
            <Card
              bordered={false}
              className={Style.sectionCard}
              title={<span style={darkPanelTitleStyle}>文章正文</span>}
            >
              <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
                <Space>
                  <Tag theme='primary' variant='light'>
                    {activeRecord.channel}
                  </Tag>
                  {activeRecord.platform ? (
                    <Tag theme='default' variant='light'>
                      {activeRecord.platform}
                    </Tag>
                  ) : null}
                  {activeRecord.keyword ? (
                    <Tag theme='warning' variant='light'>
                      {activeRecord.keyword}
                    </Tag>
                  ) : null}
                </Space>
                <Space>
                  <Button size='small' variant='outline' onClick={() => copyText(draftTitle, '标题')}>
                    复制标题
                  </Button>
                  <Button size='small' variant='outline' onClick={() => copyText(draftBody, '正文')}>
                    复制正文
                  </Button>
                </Space>
              </Space>

              <Form layout='vertical'>
                <FormItem label={darkFieldLabel('文章标题')}>
                  <Input
                    value={draftTitle}
                    onChange={(v) => setDraftTitle(String(v))}
                    style={{ color: '#111827', backgroundColor: '#FFFFFF' }}
                  />
                </FormItem>
                <FormItem label={darkFieldLabel('文章正文')}>
                  <Textarea
                    value={draftBody}
                    onChange={(v) => setDraftBody(String(v))}
                    autosize={{ minRows: 20, maxRows: 28 }}
                    placeholder='这里显示 Agent 自动生成的正文，也可以直接修改后保存'
                    style={{
                      color: '#111827',
                      backgroundColor: '#FFFFFF',
                      lineHeight: 1.8,
                    }}
                  />
                </FormItem>
              </Form>
              <div
                style={{
                  marginTop: 12,
                  padding: 14,
                  borderRadius: 12,
                  background: '#0F172A',
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  color: '#E5E7EB',
                  lineHeight: 1.8,
                  fontSize: 13,
                }}
              >
                {draftStatusText}
              </div>
            </Card>

            <Card
              bordered={false}
              className={Style.sectionCard}
              title={<span style={darkPanelTitleStyle}>草稿信息</span>}
            >
              <div
                style={{
                  display: 'grid',
                  gap: 12,
                }}
              >
                {[
                  { label: '发布对象', value: activeRecord.target || '-' },
                  { label: '当前状态', value: activeRecord.status || '-' },
                  { label: '草稿状态', value: activeRecord.draft_status || '-' },
                  {
                    label: '模型',
                    value: [activeRecord.draft_provider, activeRecord.draft_model].filter(Boolean).join(' / ') || '-',
                  },
                  {
                    label: '品牌 / 域名',
                    value: [activeRecord.brand, activeRecord.domain].filter(Boolean).join(' / ') || '-',
                  },
                  {
                    label: '创建时间',
                    value: new Date(activeRecord.created_at).toLocaleString('zh-CN'),
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 12,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(148, 163, 184, 0.16)',
                    }}
                  >
                    <div
                      style={{
                        color: '#94A3B8',
                        fontSize: 12,
                        marginBottom: 6,
                        letterSpacing: '0.02em',
                      }}
                    >
                      {item.label}
                    </div>
                    <div
                      style={{
                        color: '#F8FAFC',
                        fontSize: 14,
                        lineHeight: 1.7,
                        wordBreak: 'break-word',
                      }}
                    >
                      {item.value}
                    </div>
                  </div>
                ))}

                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 12,
                    background: 'rgba(59, 130, 246, 0.08)',
                    border: '1px solid rgba(96, 165, 250, 0.2)',
                    color: '#DBEAFE',
                    lineHeight: 1.9,
                    fontSize: 13,
                  }}
                >
                  Agent 自动跑到“待发布”后，正文会先落在内容草稿库，再挂到发布记录上。
                  这里保存的是文章草稿本身，保存后内容任务页和发布记录页看到的正文会同步更新。
                </div>
              </div>
            </Card>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function OwnedAccountRecords() {
  const [data, setData] = useState<OwnedPublishingTaskRow[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      setData(await listOwnedPublishingTasks());
    } catch (err: any) {
      MessagePlugin.error(`自有账号发布记录加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <Card
      bordered={false}
      className={Style.sectionCard}
      title='自有账号发布记录'
      actions={
        <Button icon={<RefreshIcon />} loading={loading} onClick={fetchData}>
          刷新
        </Button>
      }
    >
      <Table
        loading={loading}
        rowKey='id'
        data={data}
        columns={[
          { colKey: 'title', title: '文章标题', minWidth: 260 },
          { colKey: 'platform', title: '平台', width: 120 },
          {
            colKey: 'account_name',
            title: '账号',
            minWidth: 180,
            cell: ({ row }) =>
              [row.account_name, accountTypeLabel(row.account_type), row.subject_name].filter(Boolean).join(' · ') ||
              '-',
          },
          {
            colKey: 'status',
            title: '状态',
            width: 130,
            cell: ({ row }) => (
              <Tag theme={statusThemeMap[row.status] || 'primary'} variant='light'>
                {row.status}
              </Tag>
            ),
          },
          {
            colKey: 'publish_url',
            title: '发布链接',
            minWidth: 220,
            cell: ({ row }) =>
              row.publish_url ? (
                <a href={row.publish_url} target='_blank' rel='noreferrer noopener'>
                  {row.publish_url}
                </a>
              ) : (
                '-'
              ),
          },
          {
            colKey: 'published_at',
            title: '发布时间',
            width: 170,
            cell: ({ row }) => (row.published_at ? new Date(row.published_at).toLocaleString('zh-CN') : '-'),
          },
          {
            colKey: 'created_at',
            title: '创建时间',
            width: 170,
            cell: ({ row }) => new Date(row.created_at).toLocaleString('zh-CN'),
          },
        ]}
        empty='暂无自有账号发布记录'
      />
    </Card>
  );
}

// ---------------------- Tab 2：媒介集市订单 ----------------------

/** 把 DatePicker 的 value 压成 'YYYY-MM-DD HH:MM:SS' */
function pickToTimeStr(value: string, kind: 'start' | 'end'): string {
  if (!value) return '';
  // DatePicker 已经返回 YYYY-MM-DD
  return kind === 'start' ? `${value} 00:00:00` : `${value} 23:59:59`;
}

function MediaMarketOrders() {
  const [resp, setResp] = useState<MediaMarketPagination<MediaMarketOrderRow> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 筛选表单草稿
  const [draftTitle, setDraftTitle] = useState('');
  const [draftAuditing, setDraftAuditing] = useState<string>('');
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd, setDraftEnd] = useState('');

  // 已提交的筛选
  const [title, setTitle] = useState('');
  const [auditing, setAuditing] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listMediaMarketOrders({
        page,
        size: pageSize,
        popTitle: title,
        popAuditing: auditing,
        startTime,
        endTime,
      });
      setResp(data);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(detail?.mess || err?.message || '媒介集市订单拉取失败');
      setResp(null);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, title, auditing, startTime, endTime]);

  useEffect(() => {
    load();
  }, [load]);

  const applyFilters = () => {
    setTitle(draftTitle.trim());
    setAuditing(draftAuditing);
    setStartTime(pickToTimeStr(draftStart, 'start'));
    setEndTime(pickToTimeStr(draftEnd, 'end'));
    setPage(1);
  };

  const resetFilters = () => {
    setDraftTitle('');
    setDraftAuditing('');
    setDraftStart('');
    setDraftEnd('');
    setTitle('');
    setAuditing('');
    setStartTime('');
    setEndTime('');
    setPage(1);
  };

  return (
    <>
      <Card bordered={false} className={Style.toolbarCard} style={{ marginBottom: 12 }}>
        <Space size={12} style={{ flexWrap: 'wrap' }}>
          <Input
            style={{ width: 220 }}
            placeholder='标题关键词'
            value={draftTitle}
            onChange={(v) => setDraftTitle(String(v))}
            onEnter={applyFilters}
            clearable
          />
          <Select
            style={{ width: 140 }}
            value={draftAuditing}
            onChange={(v) => setDraftAuditing(String(v))}
            options={AUDIT_OPTIONS}
          />
          <DatePicker
            value={draftStart}
            onChange={(v) => setDraftStart(String(v || ''))}
            placeholder='开始日期'
            clearable
          />
          <DatePicker
            value={draftEnd}
            onChange={(v) => setDraftEnd(String(v || ''))}
            placeholder='结束日期'
            clearable
          />
          <Button theme='primary' onClick={applyFilters}>
            查询
          </Button>
          <Button variant='outline' onClick={resetFilters}>
            重置
          </Button>
          <Button icon={<RefreshIcon />} onClick={load}>
            刷新
          </Button>
        </Space>
      </Card>

      {error && (
        <Alert
          theme='error'
          message={`媒介集市订单拉取失败：${error}`}
          operation={
            <Button variant='text' onClick={load}>
              重试
            </Button>
          }
          style={{ marginBottom: 12 }}
        />
      )}

      <Card bordered={false} className={Style.sectionCard} title='媒介集市订单（实时）'>
        <Table
          loading={loading}
          rowKey='popId'
          data={resp?.content || []}
          columns={[
            {
              colKey: 'popTitle',
              title: '稿件标题',
              ellipsis: true,
              width: 260,
              cell: ({ row }) => (row as MediaMarketOrderRow).popTitle || '-',
            },
            {
              colKey: 'mediaName',
              title: '发布媒体',
              ellipsis: true,
              width: 180,
            },
            {
              colKey: 'popAuditing',
              title: '审核状态',
              width: 100,
              cell: ({ row }) => {
                const r = row as MediaMarketOrderRow;
                const k = String(r.popAuditing ?? '');
                const label = r.popAuditingStr || MEDIA_MARKET_AUDIT_LABEL[k] || k || '-';
                const theme = MEDIA_MARKET_AUDIT_THEME[k] || 'default';
                return (
                  <Tag theme={theme} variant='light'>
                    {label}
                  </Tag>
                );
              },
            },
            {
              colKey: 'popPrice',
              title: '消耗/成本',
              width: 150,
              cell: ({ row }) => {
                const r = row as MediaMarketOrderRow;
                const credits = Number(r.chargeCredits || 0);
                const cost = r.costAmountCents;
                return (
                  <Space direction='vertical' size={2}>
                    <span>{credits > 0 ? `${credits.toLocaleString('zh-CN')} 点` : '-'}</span>
                    {cost ? <span style={{ color: '#94A3B8', fontSize: 12 }}>成本 {formatCents(cost)}</span> : null}
                  </Space>
                );
              },
            },
            {
              colKey: 'popOutTradeNo',
              title: '订单号',
              width: 200,
              ellipsis: true,
            },
            {
              colKey: 'popPublishLink',
              title: '发布链接',
              width: 220,
              cell: ({ row }) => {
                const url = (row as MediaMarketOrderRow).popPublishLink;
                return url ? (
                  <a href={url} target='_blank' rel='noreferrer noopener'>
                    打开
                  </a>
                ) : (
                  '-'
                );
              },
            },
            {
              colKey: 'popRefundReason',
              title: '备注/拒稿原因',
              ellipsis: true,
              cell: ({ row }) => (row as MediaMarketOrderRow).popRefundReason || '-',
            },
            {
              colKey: 'popCreateTime',
              title: '下单时间',
              width: 170,
              cell: ({ row }) => (row as MediaMarketOrderRow).popCreateTime || '-',
            },
          ]}
          empty='没有匹配的订单（若为空且从未下单，属正常）'
        />
        {(resp?.totalElements ?? 0) > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <Pagination
              current={page}
              pageSize={pageSize}
              total={resp?.totalElements || 0}
              pageSizeOptions={[10, 20, 30, 50]}
              showPageSize
              showJumper
              onChange={({ current, pageSize: newSize }) => {
                setPage(current);
                if (newSize && newSize !== pageSize) setPageSize(newSize);
              }}
            />
          </div>
        )}
      </Card>
    </>
  );
}

const History: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'internal' | 'owned' | 'media-market'>('internal');

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              发稿记录
            </Tag>
            <Tag theme='success' variant='light'>
              内部数据库 + 媒介集市
            </Tag>
          </Space>
          <div className={Style.heroTitle}>统一发稿记录</div>
          <div className={Style.heroDesc}>
            内部记录是 codex 数据库里的点数交付凭证；媒介集市订单直接拉 meijiejishi.com 的真实订单状态。
          </div>
        </Space>
      </Card>

      <Tabs value={activeTab} onChange={(v) => setActiveTab(v as 'internal' | 'owned' | 'media-market')}>
        <TabPanel value='internal' label='内部记录（数据库）' destroyOnHide={false}>
          <InternalRecords />
        </TabPanel>
        <TabPanel value='owned' label='自有账号发布' destroyOnHide={false}>
          <OwnedAccountRecords />
        </TabPanel>
        <TabPanel value='media-market' label='媒介集市订单（实时）' destroyOnHide={false}>
          <MediaMarketOrders />
        </TabPanel>
      </Tabs>
    </div>
  );
};

export default History;
