import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Dialog, Form, Input, MessagePlugin, Select, Space, Table, Tag, Textarea } from 'tdesign-react';
import { AddIcon, CopyIcon, RefreshIcon } from 'tdesign-icons-react';
import {
  confirmDistributionRecordPublish,
  createDistributionRecordDb,
  listDistributionRecordsDb,
  type DistributionRecordCreateRequest,
  type DistributionRecordPublishRequest,
  type DistributionRecordRow,
} from 'services/zggeo-api';
import { stripMarkdownForPublish } from 'utils/publishText';
import Style from '../linear.module.less';

const { FormItem } = Form;

const PLATFORMS = ['小红书', '知乎', '视频号', '抖音', 'B站', '微博', '公众号', '官网'];

const isPersonalMediaRecord = (row: DistributionRecordRow) => {
  const text = [row.channel, row.target, row.platform, row.account_name].filter(Boolean).join(' ');
  return (
    text.includes('个人自媒体') ||
    ['小红书', '知乎', '视频号', '抖音', 'B站', '微博'].some((item) => text.includes(item))
  );
};

const guessPlatform = (row: DistributionRecordRow) => {
  const text = [row.platform, row.channel, row.target].filter(Boolean).join(' ');
  return PLATFORMS.find((item) => text.includes(item)) || '小红书';
};

const copyText = async (text: string, label: string) => {
  if (!text.trim()) {
    MessagePlugin.warning(`${label}为空，暂无可复制内容`);
    return;
  }
  try {
    await navigator.clipboard.writeText(label.includes('正文') ? stripMarkdownForPublish(text) : text);
    MessagePlugin.success(`${label}已复制`);
  } catch {
    MessagePlugin.error(`${label}复制失败，请检查浏览器权限`);
  }
};

const EMPTY_CREATE_FORM: DistributionRecordCreateRequest = {
  title: '',
  channel: '个人自媒体',
  target: '个人自媒体',
  status: '待发布',
  platform: '小红书',
  account_name: '',
  publish_url: '',
  publisher_name: '运营同学',
  review_note: '',
  draft_body: '',
};

const Personal: React.FC = () => {
  const [records, setRecords] = useState<DistributionRecordRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [activeRecord, setActiveRecord] = useState<DistributionRecordRow | null>(null);
  const [publishForm, setPublishForm] = useState<DistributionRecordPublishRequest>({
    platform: '小红书',
    account_name: '',
    publish_url: '',
    review_note: '',
    publisher_name: '运营同学',
  });

  // 手动新建草稿
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<DistributionRecordCreateRequest>(EMPTY_CREATE_FORM);
  const [creating, setCreating] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await listDistributionRecordsDb();
      setRecords(data.filter(isPersonalMediaRecord));
    } catch (err: any) {
      MessagePlugin.error(`个人自媒体草稿箱加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const pendingRecords = useMemo(() => records.filter((item) => item.status === '待发布'), [records]);

  const publishedRecords = useMemo(() => records.filter((item) => item.status === '已发布'), [records]);

  const stats = useMemo(
    () => ({
      total: records.length,
      pending: pendingRecords.length,
      published: publishedRecords.length,
      noLink: publishedRecords.filter((item) => !item.publish_url).length,
    }),
    [records, pendingRecords, publishedRecords],
  );

  const openDraft = (row: DistributionRecordRow) => {
    setActiveRecord(row);
    setPublishForm({
      platform: row.platform || guessPlatform(row),
      account_name: row.account_name || '',
      publish_url: row.publish_url || '',
      review_note: row.review_note || '',
      publisher_name: row.publisher_name || '运营同学',
    });
  };

  const closeDraft = () => {
    setActiveRecord(null);
    setPublishForm({
      platform: '小红书',
      account_name: '',
      publish_url: '',
      review_note: '',
      publisher_name: '运营同学',
    });
  };

  const openCreate = () => {
    setCreateForm(EMPTY_CREATE_FORM);
    setCreateOpen(true);
  };
  const closeCreate = () => {
    setCreateOpen(false);
    setCreateForm(EMPTY_CREATE_FORM);
  };

  const handleCreateDraft = async () => {
    const title = (createForm.title || '').trim();
    const body = stripMarkdownForPublish(createForm.draft_body);
    if (!title) {
      MessagePlugin.warning('请填写内容标题');
      return;
    }
    if (!body) {
      MessagePlugin.warning('请填写草稿正文，否则预览草稿会空');
      return;
    }
    setCreating(true);
    try {
      // channel 里同时带上平台名，保证这条草稿能过 isPersonalMediaRecord 过滤器出现在本页
      const platform = createForm.platform || '小红书';
      await createDistributionRecordDb({
        ...createForm,
        title,
        channel: `个人自媒体 / ${platform}`,
        target: createForm.target || '个人自媒体',
        status: createForm.status || '待发布',
        platform,
        draft_body: body,
      });
      MessagePlugin.success('草稿已创建，已进入待发布列表');
      closeCreate();
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(`新建草稿失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setCreating(false);
    }
  };

  const handleConfirmPublish = async () => {
    if (!activeRecord) return;
    setActionLoading(activeRecord.id);
    try {
      await confirmDistributionRecordPublish(activeRecord.id, publishForm);
      MessagePlugin.success('这条草稿已确认进入已发布记录');
      closeDraft();
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(`确认发布失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setActionLoading('');
    }
  };

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              个人自媒体
            </Tag>
            <Tag theme='warning' variant='light'>
              待发布草稿箱 / 人工确认发布
            </Tag>
          </Space>
          <div className={Style.heroTitle}>个人自媒体分发草稿箱</div>
          <div className={Style.heroDesc}>
            文章在“文章生成”页确认生成后，会把待发布内容送到这里。运营只需要预览正文、补平台账号或发布链接，再点一次确认发布即可。
          </div>
        </Space>
      </Card>

      <div className={Style.statsGrid}>
        <Metric title='草稿箱总数' value={stats.total} />
        <Metric title='待发布' value={stats.pending} color='#ED7B2F' />
        <Metric title='已发布' value={stats.published} color='#00A870' />
        <Metric title='已发未补链接' value={stats.noLink} color='#E34D59' />
      </div>

      <Card
        bordered={false}
        className={Style.sectionCard}
        title='待发布草稿'
        actions={
          <Space>
            <Button theme='primary' icon={<AddIcon />} onClick={openCreate}>
              新建草稿
            </Button>
            <Button icon={<RefreshIcon />} loading={loading} onClick={fetchData}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table
          loading={loading}
          rowKey='id'
          data={pendingRecords}
          columns={[
            {
              colKey: 'title',
              title: '内容标题',
              cell: ({ row }) => (
                <div>
                  <div className={Style.itemTitle}>{row.title}</div>
                  <div className={Style.mutedText} style={{ fontSize: 12, marginTop: 4 }}>
                    {row.brand || '-'} · {row.domain || '-'} · {row.keyword || '-'}
                  </div>
                </div>
              ),
            },
            {
              colKey: 'channel',
              title: '待发渠道',
              width: 180,
              cell: ({ row }) => (
                <Space direction='vertical' size={4}>
                  <Tag theme='primary' variant='light'>
                    {row.platform || guessPlatform(row)}
                  </Tag>
                  <span className={Style.mutedText} style={{ fontSize: 12 }}>
                    {row.channel}
                  </span>
                </Space>
              ),
            },
            {
              colKey: 'status',
              title: '状态',
              width: 110,
              cell: ({ row }) => (
                <Tag theme='warning' variant='light'>
                  {row.status}
                </Tag>
              ),
            },
            {
              colKey: 'created_at',
              title: '进入草稿箱时间',
              width: 180,
              cell: ({ row }) => new Date(row.created_at).toLocaleString('zh-CN'),
            },
            {
              colKey: 'action',
              title: '操作',
              width: 180,
              fixed: 'right',
              cell: ({ row }) => (
                <Space>
                  <Button size='small' variant='outline' onClick={() => openDraft(row)}>
                    预览草稿
                  </Button>
                  <Button
                    size='small'
                    theme='primary'
                    loading={actionLoading === row.id}
                    onClick={() => openDraft(row)}
                  >
                    确认发布
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card bordered={false} className={Style.sectionCard} title='近期已发布记录' style={{ marginTop: 16 }}>
        <Table
          loading={loading}
          rowKey='id'
          data={publishedRecords}
          columns={[
            {
              colKey: 'title',
              title: '标题',
              cell: ({ row }) => (
                <div>
                  <div className={Style.itemTitle}>{row.title}</div>
                  <div className={Style.mutedText} style={{ fontSize: 12, marginTop: 4 }}>
                    {row.account_name || '未填账号'} · {row.platform || guessPlatform(row)}
                  </div>
                </div>
              ),
            },
            {
              colKey: 'published_at',
              title: '发布时间',
              width: 180,
              cell: ({ row }) => (row.published_at ? new Date(row.published_at).toLocaleString('zh-CN') : '-'),
            },
            {
              colKey: 'publish_url',
              title: '发布链接',
              cell: ({ row }) =>
                row.publish_url ? (
                  <a href={row.publish_url} target='_blank' rel='noreferrer'>
                    {row.publish_url}
                  </a>
                ) : (
                  <span className={Style.mutedText}>未填写</span>
                ),
            },
            {
              colKey: 'status',
              title: '状态',
              width: 100,
              cell: () => (
                <Tag theme='success' variant='light'>
                  已发布
                </Tag>
              ),
            },
          ]}
        />
      </Card>

      <Dialog
        visible={createOpen}
        header='新建个人自媒体草稿'
        width='760px'
        confirmBtn={creating ? '创建中…' : '创建草稿'}
        onClose={closeCreate}
        onConfirm={handleCreateDraft}
      >
        <Form layout='vertical'>
          <FormItem label='内容标题' requiredMark>
            <Input
              value={createForm.title}
              onChange={(v) => setCreateForm({ ...createForm, title: String(v) })}
              placeholder='例如：3 分钟看懂 AI 搜索可见度优化'
            />
          </FormItem>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormItem label='发布平台'>
              <Select
                value={createForm.platform}
                onChange={(v) => setCreateForm({ ...createForm, platform: String(v) })}
                options={PLATFORMS.map((item) => ({ label: item, value: item }))}
              />
            </FormItem>
            <FormItem label='发布账号'>
              <Input
                value={createForm.account_name}
                onChange={(v) => setCreateForm({ ...createForm, account_name: String(v) })}
                placeholder='例如：@ZGEO_yan / 知乎-yanlyubo'
              />
            </FormItem>
          </div>
          <FormItem label='草稿正文' requiredMark>
            <Textarea
              value={createForm.draft_body}
              onChange={(v) => setCreateForm({ ...createForm, draft_body: String(v) })}
              autosize={{ minRows: 8, maxRows: 16 }}
              placeholder='粘贴或手写正文内容，"预览草稿"对话框会原样展示。'
            />
          </FormItem>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormItem label='预发布链接（可选）'>
              <Input
                value={createForm.publish_url}
                onChange={(v) => setCreateForm({ ...createForm, publish_url: String(v) })}
                placeholder='已经发出去的链接可先贴在这里'
              />
            </FormItem>
            <FormItem label='执行人'>
              <Input
                value={createForm.publisher_name}
                onChange={(v) => setCreateForm({ ...createForm, publisher_name: String(v) })}
                placeholder='例如：运营同学 / 客户本人'
              />
            </FormItem>
          </div>
          <FormItem label='备注'>
            <Textarea
              value={createForm.review_note}
              onChange={(v) => setCreateForm({ ...createForm, review_note: String(v) })}
              autosize={{ minRows: 2, maxRows: 5 }}
              placeholder='例如：周一上午发；首图待替换；等法务确认后发布'
            />
          </FormItem>
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.03)',
              color: 'rgba(203,213,225,0.74)',
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            创建后这条草稿状态默认是"待发布"，会直接出现在上方"待发布草稿"列表。正文会同时写入内容草稿库，预览和复制功能都能正常用。
          </div>
        </Form>
      </Dialog>

      <Dialog
        visible={!!activeRecord}
        header='个人自媒体草稿预览与确认发布'
        width='1100px'
        confirmBtn='确认发布'
        onClose={closeDraft}
        onConfirm={handleConfirmPublish}
      >
        {activeRecord ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 1fr',
              gap: 16,
              alignItems: 'start',
            }}
          >
            <Card bordered={false} className={Style.dialogCard} title='草稿正文预览'>
              <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
                <Space>
                  <Tag theme='primary' variant='light'>
                    {activeRecord.brand || '-'}
                  </Tag>
                  <Tag theme='default' variant='light'>
                    {activeRecord.keyword || '-'}
                  </Tag>
                  <Tag theme='warning' variant='light'>
                    {activeRecord.channel}
                  </Tag>
                </Space>
                <Space>
                  <Button
                    size='small'
                    variant='outline'
                    icon={<CopyIcon />}
                    onClick={() => copyText(activeRecord.title, '标题')}
                  >
                    复制标题
                  </Button>
                  <Button
                    size='small'
                    variant='outline'
                    icon={<CopyIcon />}
                    onClick={() => copyText(activeRecord.draft_body || '', '正文')}
                  >
                    复制正文
                  </Button>
                </Space>
              </Space>

              <div className={Style.itemTitle} style={{ fontSize: 18, marginBottom: 12 }}>
                {activeRecord.title}
              </div>
              <div className={Style.articleDraftPreview}>{activeRecord.draft_body || '暂无正文内容'}</div>
            </Card>

            <Card bordered={false} className={Style.dialogCard} title='发布确认信息'>
              <Form layout='vertical'>
                <FormItem label='发布平台'>
                  <Select
                    value={publishForm.platform}
                    onChange={(v) => setPublishForm({ ...publishForm, platform: String(v) })}
                    options={PLATFORMS.map((item) => ({ label: item, value: item }))}
                  />
                </FormItem>
                <FormItem label='发布账号'>
                  <Input
                    value={publishForm.account_name}
                    onChange={(v) => setPublishForm({ ...publishForm, account_name: String(v) })}
                    placeholder='例如：品牌主理人小红书 / 创始人知乎号'
                  />
                </FormItem>
                <FormItem label='发布链接'>
                  <Input
                    value={publishForm.publish_url}
                    onChange={(v) => setPublishForm({ ...publishForm, publish_url: String(v) })}
                    placeholder='可选，发布后把真实链接贴回来'
                  />
                </FormItem>
                <FormItem label='执行人'>
                  <Input
                    value={publishForm.publisher_name}
                    onChange={(v) => setPublishForm({ ...publishForm, publisher_name: String(v) })}
                    placeholder='例如：运营同学 / 客户本人'
                  />
                </FormItem>
                <FormItem label='备注'>
                  <Textarea
                    value={publishForm.review_note}
                    onChange={(v) => setPublishForm({ ...publishForm, review_note: String(v) })}
                    autosize={{ minRows: 4, maxRows: 8 }}
                    placeholder='例如：已人工审核，可直接发布；或者发布时需要替换首图'
                  />
                </FormItem>

                <div
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    background: 'rgba(255,255,255,0.03)',
                    color: 'rgba(203,213,225,0.74)',
                    lineHeight: 1.8,
                  }}
                >
                  <div>当前分发对象：{activeRecord.target}</div>
                  <div>草稿状态：{activeRecord.draft_status || '待发布'}</div>
                  <div>点击“确认发布”后，这条记录会进入已发布列表，正文仍可复制给运营或客户手动发到对应平台。</div>
                </div>
              </Form>
            </Card>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
};

const Metric: React.FC<{ title: string; value: number; color?: string }> = ({ title, value, color }) => (
  <Card bordered={false} className={Style.statCard}>
    <div className={Style.statLabel}>{title}</div>
    <div className={Style.statValue} style={color ? { color } : undefined}>
      {value}
    </div>
  </Card>
);

export default Personal;
