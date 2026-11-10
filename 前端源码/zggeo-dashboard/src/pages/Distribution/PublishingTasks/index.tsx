import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Dialog, Drawer, Input, MessagePlugin, Select, Space, Table, Tag, Textarea } from 'tdesign-react';
import { LinkIcon, RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import {
  cancelOwnedPublishingTask,
  cancelPublishingTask,
  confirmOwnedPublishingTaskContent,
  confirmPublishingTaskContent,
  deleteOwnedPublishingTask,
  deletePublishingTask,
  failOwnedPublishingTask,
  failPublishingTask,
  fillOwnedPublishingTaskLink,
  fillPublishingTaskLink,
  listOwnedPublishingTaskLogs,
  listOwnedPublishingTasks,
  listPublishingTaskLogs,
  listPublishingTasks,
  markOwnedPublishingTaskPublished,
  markPublishingTaskPublished,
  type OwnedPublishingTaskRow,
  type PublishingLogRow,
  type PublishingTaskRow,
} from 'services/zggeo-api';
import { composePublishClipboardText, decodeStoredPublishText, stripMarkdownForPublish } from 'utils/publishText';
import { buildZhihuTitleFillBookmarklet, zhihuAssistantHelpText } from 'utils/zhihuAssist';
import Style from '../linear.module.less';

const STATUSES = ['待发布', '待回填链接', '已发布', '待客户确认', '已确认待发布', '已发布待回填', '发布失败', '已取消'];
const PLATFORM_OPTIONS = ['小红书', '知乎', '微信公众号', '官网 CMS', 'B站', '微博', '抖音', '视频号'];
type AnyPublishingTaskRow = (PublishingTaskRow | OwnedPublishingTaskRow) & {
  id: string;
  title: string;
  status: string;
  publish_url?: string | null;
  platform?: string | null;
  account_name?: string | null;
  account_type?: string | null;
  subject_name?: string | null;
  brand?: string | null;
  domain?: string | null;
  keyword?: string | null;
  draft_body?: string | null;
  platform_entry_url?: string | null;
  publish_mode?: string | null;
  scheduled_at?: string | null;
  normalized_status?: string;
  task_source?: 'owned_account' | 'distribution_record';
  target?: string | null;
  channel?: string | null;
};

const statusTheme = (status: string) => {
  if (['已回填链接', '已发布'].includes(status)) return 'success' as const;
  if (['已确认待发布', '待发布'].includes(status)) return 'primary' as const;
  if (['待客户确认', '已发布待回填', '待回填链接'].includes(status)) return 'warning' as const;
  if (['发布失败', '已取消'].includes(status)) return 'danger' as const;
  return 'default' as const;
};

const normalizeStatus = (row: Pick<AnyPublishingTaskRow, 'status' | 'publish_url' | 'task_source'>) => {
  if (row.task_source === 'owned_account') {
    if (row.status === '已确认待发布' || row.status === '待客户确认' || row.status === '待发布') return '待发布';
    if (row.status === '已发布待回填') return '待回填链接';
    if (row.status === '已回填链接' || (row.status === '已发布' && row.publish_url)) return '已发布';
  }
  if (STATUSES.includes(row.status)) return row.status;
  if (row.status === '待提交') return '待客户确认';
  if (row.status === '待发布') return '已确认待发布';
  if (row.status === '已发布') return row.publish_url ? '已回填链接' : '已发布待回填';
  if (row.status === '失败') return '发布失败';
  return row.status || '待客户确认';
};

const formatTime = (value?: string | null) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN');
};

const accountTypeLabel = (value?: string | null) =>
  ({ personal: '个人号', enterprise: '企业号', organization: '机构号' }[String(value || '')] || value || '');

const PublishingTasks: React.FC = () => {
  const [rows, setRows] = useState<AnyPublishingTaskRow[]>([]);
  const [logs, setLogs] = useState<PublishingLogRow[]>([]);
  const [active, setActive] = useState<AnyPublishingTaskRow | null>(null);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [publishUrl, setPublishUrl] = useState('');
  const [failureReason, setFailureReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [failDialogOpen, setFailDialogOpen] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [legacyRows, ownedRows] = await Promise.all([listPublishingTasks(), listOwnedPublishingTasks()]);
      setRows([...ownedRows, ...legacyRows.map((item) => ({ ...item, task_source: 'distribution_record' as const }))]);
    } catch (err: any) {
      MessagePlugin.error(`发布任务加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const openDetail = async (row: AnyPublishingTaskRow) => {
    setActive(row);
    setPublishUrl(row.publish_url || '');
    try {
      setLogs(
        row.task_source === 'owned_account'
          ? await listOwnedPublishingTaskLogs(row.id)
          : await listPublishingTaskLogs(row.id),
      );
    } catch {
      setLogs([]);
    }
  };

  const refreshActive = async () => {
    await fetchData();
    if (active) {
      const nextLogs =
        active.task_source === 'owned_account'
          ? await listOwnedPublishingTaskLogs(active.id).catch(() => [])
          : await listPublishingTaskLogs(active.id).catch(() => []);
      setLogs(nextLogs);
    }
  };

  const runAction = async (fn: () => Promise<AnyPublishingTaskRow>, message: string) => {
    try {
      const next = await fn();
      setActive(next);
      MessagePlugin.success(message);
      await refreshActive();
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '操作失败');
    }
  };

  const deleteTask = async (row: AnyPublishingTaskRow) => {
    if (!window.confirm(`确认删除「${row.title}」这条发布任务？删除后不可恢复。`)) return;
    try {
      if (row.task_source === 'owned_account') {
        await deleteOwnedPublishingTask(row.id);
      } else {
        await deletePublishingTask(row.id);
      }
      MessagePlugin.success('发布任务已删除');
      if (active?.id === row.id) {
        setActive(null);
        setLogs([]);
      }
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(err?.response?.data?.detail || err?.message || '删除失败');
    }
  };

  const copyText = async (value: string, label: string) => {
    const text = decodeStoredPublishText(value);
    if (!text.trim()) {
      MessagePlugin.warning(`${label}为空`);
      return;
    }
    try {
      await navigator.clipboard.writeText(label.includes('正文') ? stripMarkdownForPublish(text) : text);
      MessagePlugin.success(`已复制${label}`);
    } catch {
      MessagePlugin.error('浏览器未允许复制，请手动选中文本复制');
    }
  };

  const copyZhihuTitleAssistant = async (row: AnyPublishingTaskRow) => {
    const title = decodeStoredPublishText(row.title).trim();
    if (!title) {
      MessagePlugin.warning('标题为空，无法生成标题助手');
      return;
    }
    try {
      await navigator.clipboard.writeText(buildZhihuTitleFillBookmarklet(title));
      MessagePlugin.success('已复制知乎标题填充助手');
    } catch {
      MessagePlugin.warning('浏览器未允许复制标题助手，可继续使用复制标题');
    }
  };

  const copyAndOpenPlatform = async (row: AnyPublishingTaskRow) => {
    const publishText = composePublishClipboardText(row.title, row.draft_body || '');
    if (publishText) {
      try {
        await navigator.clipboard.writeText(publishText);
        MessagePlugin.success('已复制标题和正文，正在打开平台');
      } catch {
        MessagePlugin.warning('浏览器未允许自动复制，已打开平台后可返回手动复制');
      }
    } else {
      MessagePlugin.warning('正文为空，只打开平台入口');
    }
    if (row.platform_entry_url) {
      window.open(String(row.platform_entry_url), '_blank', 'noopener,noreferrer');
    }
  };

  const pastePublishUrl = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const match = text.match(/https?:\/\/[^\s"'<>]+/);
      if (!match) {
        MessagePlugin.warning('剪贴板里没有可用的文章链接');
        return;
      }
      setPublishUrl(match[0]);
      MessagePlugin.success('已粘贴发布链接');
    } catch {
      MessagePlugin.warning('浏览器未允许读取剪贴板，请手动粘贴链接');
    }
  };

  const finishOwnedPublish = async () => {
    if (!active) return;
    if (!publishUrl.trim()) {
      MessagePlugin.warning('请先填写发布后的文章链接');
      return;
    }
    await runAction(
      () => markOwnedPublishingTaskPublished(active.id, { publish_url: publishUrl.trim() }),
      '发布已完成，链接已保存',
    );
  };

  const filteredRows = useMemo(
    () =>
      rows
        .map((row) => ({ ...row, normalized_status: normalizeStatus(row) }))
        .filter((row) => {
          if (status && row.normalized_status !== status) return false;
          if (platform && ![row.platform, row.target, row.channel].filter(Boolean).join(' ').includes(platform))
            return false;
          if (!keyword.trim()) return true;
          const text = [row.title, row.brand, row.domain, row.keyword, row.platform, row.account_name, row.account_type]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return text.includes(keyword.trim().toLowerCase());
        }),
    [keyword, platform, rows, status],
  );

  const stats = useMemo(() => {
    const normalized = rows.map((row) => normalizeStatus(row));
    return {
      confirm: normalized.filter((item) => item === '待客户确认').length,
      ready: normalized.filter((item) => item === '已确认待发布' || item === '待发布').length,
      link: normalized.filter((item) => item === '已发布待回填' || item === '待回填链接').length,
      done: normalized.filter((item) => item === '已回填链接' || item === '已发布').length,
      failed: normalized.filter((item) => item === '发布失败').length,
    };
  }, [rows]);

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              发布任务台
            </Tag>
            <Tag theme='warning' variant='light'>
              客户确认式发布
            </Tag>
          </Space>
          <div className={Style.heroTitle}>发布任务台</div>
          <div className={Style.heroDesc}>
            统一管理文章生成后的确认、手动发布和链接回填。第一版不托管平台密码，不保存 Cookie，不做静默自动发布。
          </div>
        </Space>
      </Card>

      <div className={Style.statsGrid}>
        <Metric title='待客户确认' value={stats.confirm} color='#ED7B2F' />
        <Metric title='待发布' value={stats.ready} color='#5E6AD2' />
        <Metric title='待回填链接' value={stats.link} color='#D54941' />
        <Metric title='已回填链接' value={stats.done} color='#00A870' />
        <Metric title='发布失败' value={stats.failed} color='#E34D59' />
      </div>

      <Card
        bordered={false}
        className={Style.sectionCard}
        title='任务列表'
        actions={
          <Button icon={<RefreshIcon />} loading={loading} onClick={fetchData}>
            刷新
          </Button>
        }
      >
        <Space size={12} breakLine style={{ width: '100%', marginBottom: 16 }}>
          <Input
            value={keyword}
            prefixIcon={<SearchIcon />}
            clearable
            placeholder='搜索标题、品牌、账号、平台'
            style={{ width: 280 }}
            onChange={(value) => setKeyword(String(value))}
          />
          <Select
            value={status}
            clearable
            placeholder='筛选状态'
            style={{ width: 180 }}
            options={STATUSES.map((item) => ({ label: item, value: item }))}
            onChange={(value) => setStatus(String(value || ''))}
          />
          <Select
            value={platform}
            clearable
            placeholder='筛选平台'
            style={{ width: 180 }}
            options={PLATFORM_OPTIONS.map((item) => ({ label: item, value: item }))}
            onChange={(value) => setPlatform(String(value || ''))}
          />
        </Space>
        <Table
          loading={loading}
          rowKey='id'
          data={filteredRows}
          columns={[
            {
              colKey: 'title',
              title: '内容标题',
              minWidth: 260,
              cell: ({ row }) => (
                <div>
                  <div className={Style.itemTitle}>{row.title}</div>
                  <div className={Style.mutedText} style={{ fontSize: 12, marginTop: 4 }}>
                    {[row.brand, row.domain, row.keyword].filter(Boolean).join(' · ') || '未关联客户资产'}
                  </div>
                </div>
              ),
            },
            {
              colKey: 'platform',
              title: '平台 / 账号',
              width: 180,
              cell: ({ row }) => (
                <Space direction='vertical' size={4}>
                  <Tag theme='primary' variant='light'>
                    {row.platform || row.target || '-'}
                  </Tag>
                  <span className={Style.mutedText}>{row.account_name || '未选择账号'}</span>
                  {row.task_source === 'owned_account' ? (
                    <span className={Style.mutedText}>{accountTypeLabel(row.account_type)}</span>
                  ) : null}
                </Space>
              ),
            },
            {
              colKey: 'status',
              title: '状态',
              width: 140,
              cell: ({ row }) => (
                <Tag theme={statusTheme(row.normalized_status)} variant='light'>
                  {row.normalized_status}
                </Tag>
              ),
            },
            {
              colKey: 'source',
              title: '来源',
              width: 120,
              cell: ({ row }) => (
                <Tag theme={row.task_source === 'owned_account' ? 'success' : 'default'} variant='light'>
                  {row.task_source === 'owned_account' ? '自有账号' : '原分发'}
                </Tag>
              ),
            },
            {
              colKey: 'publish_mode',
              title: '发布方式',
              width: 140,
              cell: ({ row }) => row.publish_mode || 'manual_copy',
            },
            { colKey: 'scheduled_at', title: '计划时间', width: 170, cell: ({ row }) => formatTime(row.scheduled_at) },
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
                  <span className={Style.mutedText}>待回填</span>
                ),
            },
            {
              colKey: 'action',
              title: '操作',
              fixed: 'right',
              width: 180,
              cell: ({ row }) => (
                <Space size={8}>
                  <Button size='small' variant='outline' onClick={() => openDetail(row)}>
                    {row.task_source === 'owned_account' && normalizeStatus(row) !== '已发布' ? '继续发布' : '查看'}
                  </Button>
                  <Button size='small' variant='text' theme='danger' onClick={() => deleteTask(row)}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer visible={Boolean(active)} header='发布任务详情' size='640px' onClose={() => setActive(null)}>
        {active ? (
          <Space direction='vertical' style={{ width: '100%' }} size={16}>
            <Space>
              <Tag theme={statusTheme(normalizeStatus(active))} variant='light'>
                {normalizeStatus(active)}
              </Tag>
              <Tag theme='primary' variant='light'>
                {active.platform || active.target || '-'}
              </Tag>
              <Tag theme='default' variant='light'>
                {active.task_source === 'owned_account' ? '自有账号' : active.publish_mode || 'manual_copy'}
              </Tag>
            </Space>
            <div>
              <div className={Style.itemTitle}>{active.title}</div>
              <div className={Style.mutedText} style={{ marginTop: 6 }}>
                {[active.brand, active.domain, active.keyword].filter(Boolean).join(' · ') || '未关联客户资产'}
              </div>
              {active.task_source === 'owned_account' ? (
                <div className={Style.mutedText} style={{ marginTop: 6 }}>
                  {[active.account_name, accountTypeLabel(active.account_type), active.subject_name]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              ) : null}
            </div>
            {active.task_source === 'owned_account' ? (
              <div className={Style.mutedText}>
                请在平台页面完成发布后复制文章链接，回到这里粘贴链接并完成任务。系统不会修改原文章，也不会进入媒体市场流程。
              </div>
            ) : null}
            {active.task_source === 'owned_account' &&
            String(active.platform || '').includes('知乎') &&
            String(active.publish_mode || '').startsWith('zhihu_import') ? (
              <div className={Style.mutedText}>
                知乎导入文档不会自动填写顶部标题栏。可点击「复制填标题助手」，到知乎写文章页把地址栏替换为该助手并回车，让它扫描并填入标题。
                {zhihuAssistantHelpText}
              </div>
            ) : null}
            <Textarea
              value={decodeStoredPublishText(active.draft_body || '')}
              readonly
              autosize={{ minRows: 8, maxRows: 16 }}
            />
            <Space breakLine>
              <Button onClick={() => copyText(active.title, '标题')}>复制标题</Button>
              {active.task_source === 'owned_account' &&
              String(active.platform || '').includes('知乎') &&
              String(active.publish_mode || '').startsWith('zhihu_import') ? (
                <Button variant='outline' onClick={() => copyZhihuTitleAssistant(active)}>
                  复制填标题助手
                </Button>
              ) : null}
              <Button onClick={() => copyText(String(active.draft_body || ''), '正文')}>复制正文</Button>
              {active.platform_entry_url ? (
                <Button icon={<LinkIcon />} onClick={() => copyAndOpenPlatform(active)}>
                  复制并打开平台
                </Button>
              ) : null}
              {active.publish_url ? (
                <Button
                  variant='outline'
                  onClick={() => window.open(String(active.publish_url), '_blank', 'noopener,noreferrer')}
                >
                  查看已发布文章
                </Button>
              ) : null}
              {active.task_source !== 'owned_account' && normalizeStatus(active) === '待客户确认' ? (
                <Button
                  theme='primary'
                  onClick={() =>
                    runAction(
                      () =>
                        active.task_source === 'owned_account'
                          ? confirmOwnedPublishingTaskContent(active.id)
                          : confirmPublishingTaskContent(active.id),
                      '内容已确认',
                    )
                  }
                >
                  确认内容
                </Button>
              ) : null}
              {active.task_source !== 'owned_account' && normalizeStatus(active) === '已确认待发布' ? (
                <Button
                  theme='primary'
                  onClick={() =>
                    runAction(
                      () =>
                        active.task_source === 'owned_account'
                          ? markOwnedPublishingTaskPublished(active.id)
                          : markPublishingTaskPublished(active.id),
                      '已标记为发布待回填',
                    )
                  }
                >
                  我已发布
                </Button>
              ) : null}
              {active.task_source !== 'owned_account' &&
              ['已确认待发布', '已发布待回填', '已回填链接'].includes(normalizeStatus(active)) ? (
                <Button variant='outline' onClick={() => setLinkDialogOpen(true)}>
                  回填链接
                </Button>
              ) : null}
              {active.task_source !== 'owned_account' &&
              ['待客户确认', '已确认待发布'].includes(normalizeStatus(active)) ? (
                <Button
                  variant='text'
                  theme='danger'
                  onClick={() =>
                    runAction(
                      () =>
                        active.task_source === 'owned_account'
                          ? cancelOwnedPublishingTask(active.id)
                          : cancelPublishingTask(active.id),
                      '任务已取消',
                    )
                  }
                >
                  取消任务
                </Button>
              ) : null}
              {!['发布失败', '已取消'].includes(normalizeStatus(active)) ? (
                <Button variant='text' theme='danger' onClick={() => setFailDialogOpen(true)}>
                  标记失败
                </Button>
              ) : null}
              <Button variant='text' theme='danger' onClick={() => deleteTask(active)}>
                删除任务
              </Button>
            </Space>
            {active.task_source === 'owned_account' && normalizeStatus(active) !== '已发布' ? (
              <Space style={{ width: '100%' }} breakLine>
                <Input
                  value={publishUrl}
                  style={{ flex: 1, minWidth: 360 }}
                  placeholder='发布成功后，把文章链接粘贴到这里'
                  onChange={(value) => setPublishUrl(String(value))}
                />
                <Button variant='outline' onClick={pastePublishUrl}>
                  粘贴发布链接
                </Button>
                <Button theme='primary' onClick={finishOwnedPublish}>
                  完成发布
                </Button>
                {['待发布', '待回填链接'].includes(normalizeStatus(active)) ? (
                  <Button
                    variant='text'
                    theme='danger'
                    onClick={() => runAction(() => cancelOwnedPublishingTask(active.id), '任务已取消')}
                  >
                    取消任务
                  </Button>
                ) : null}
              </Space>
            ) : null}
            <Card bordered={false} className={Style.itemCard} title='操作日志'>
              <Space direction='vertical' style={{ width: '100%' }}>
                {logs.length === 0 ? <div className={Style.emptyState}>暂无日志</div> : null}
                {logs.map((item) => (
                  <div key={item.id} className={Style.itemDesc}>
                    {formatTime(item.created_at)} · {item.action} ·{' '}
                    {[item.before_status, item.after_status].filter(Boolean).join(' -> ') || '-'}
                  </div>
                ))}
              </Space>
            </Card>
          </Space>
        ) : null}
      </Drawer>

      <Dialog
        visible={linkDialogOpen}
        header='回填发布链接'
        onClose={() => setLinkDialogOpen(false)}
        onCancel={() => setLinkDialogOpen(false)}
        onConfirm={() =>
          active &&
          runAction(
            () =>
              active.task_source === 'owned_account'
                ? fillOwnedPublishingTaskLink(active.id, { publish_url: publishUrl })
                : fillPublishingTaskLink(active.id, { publish_url: publishUrl }),
            '发布链接已回填',
          ).then(() => setLinkDialogOpen(false))
        }
      >
        <Input value={publishUrl} placeholder='https://...' onChange={(value) => setPublishUrl(String(value))} />
      </Dialog>
      <Dialog
        visible={failDialogOpen}
        header='标记发布失败'
        onClose={() => setFailDialogOpen(false)}
        onCancel={() => setFailDialogOpen(false)}
        onConfirm={() =>
          active &&
          runAction(
            () =>
              active.task_source === 'owned_account'
                ? failOwnedPublishingTask(active.id, { error_message: failureReason })
                : failPublishingTask(active.id, { error_message: failureReason }),
            '已标记发布失败',
          ).then(() => setFailDialogOpen(false))
        }
      >
        <Input value={failureReason} placeholder='填写失败原因' onChange={(value) => setFailureReason(String(value))} />
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

export default PublishingTasks;
