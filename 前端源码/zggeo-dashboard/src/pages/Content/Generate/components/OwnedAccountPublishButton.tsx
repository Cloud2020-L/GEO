import React, { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Select, Space, Tag, Textarea } from 'tdesign-react';
import { LinkIcon, UserIcon } from 'tdesign-icons-react';
import {
  cancelOwnedPublishingTask,
  createOwnedPublishingTask,
  downloadOwnedPublishingTaskZhihuImportFile,
  failOwnedPublishingTask,
  listPublishingAccounts,
  markOwnedPublishingTaskPublished,
  type OwnedPublishingTaskCreateRequest,
  type OwnedPublishingTaskRow,
  type PublishingAccountRow,
} from 'services/zggeo-api';
import { composePublishClipboardText, decodeStoredPublishText, stripMarkdownForPublish } from 'utils/publishText';
import { buildZhihuTitleFillBookmarklet, zhihuAssistantHelpText } from 'utils/zhihuAssist';

const firstText = (...values: unknown[]) => String(values.find((value) => String(value || '').trim()) || '').trim();

const accountTypeLabel = (value?: string | null) =>
  ({ personal: '个人号', enterprise: '企业号', organization: '机构号' }[String(value || '')] || value || '个人号');

const getArticleTitle = (article: Record<string, any>) =>
  firstText(article.draft_title, article.title, article.name, '未命名文章');

const getArticleBody = (article: Record<string, any>, bodyOverride?: string) =>
  firstText(bodyOverride, article.draft_body, article.body, article.content, article.article_body);

interface OwnedAccountPublishButtonProps {
  article: Record<string, any>;
  bodyOverride?: string;
  disabled?: boolean;
  size?: 'small' | 'medium' | 'large';
  onBeforeCreate?: () => boolean | Promise<boolean>;
}

const OwnedAccountPublishButton: React.FC<OwnedAccountPublishButtonProps> = ({
  article,
  bodyOverride,
  disabled,
  size = 'small',
  onBeforeCreate,
}) => {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<PublishingAccountRow[]>([]);
  const [accountId, setAccountId] = useState('');
  const [platform, setPlatform] = useState('');
  const [loading, setLoading] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [createdTask, setCreatedTask] = useState<OwnedPublishingTaskRow | null>(null);
  const [publishUrl, setPublishUrl] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [publishMode, setPublishMode] = useState('manual_copy');
  const [importHint, setImportHint] = useState('');

  const selectedAccount = useMemo(
    () => accounts.find((item) => String(item.id) === accountId) || null,
    [accountId, accounts],
  );
  const isZhihuPersonal = useMemo(
    () =>
      String(platform || selectedAccount?.platform || '').includes('知乎') &&
      selectedAccount?.account_type === 'personal',
    [platform, selectedAccount],
  );

  useEffect(() => {
    if (!open) return;
    listPublishingAccounts()
      .then((items) => {
        setAccounts(items);
        const first = items[0];
        if (first) {
          setAccountId(String(first.id));
          setPlatform(first.platform);
          setPublishMode(
            first.platform.includes('知乎') && first.account_type === 'personal' ? 'zhihu_import_beta' : 'manual_copy',
          );
        }
      })
      .catch((err) =>
        MessagePlugin.error(`账号池加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`),
      );
  }, [open]);

  const openDialog = async () => {
    const ok = await onBeforeCreate?.();
    if (ok === false) return;
    const content = stripMarkdownForPublish(getArticleBody(article, bodyOverride));
    if (!content) {
      MessagePlugin.warning('文章正文为空，不能创建自有账号发布任务');
      return;
    }
    setOpen(true);
  };

  const submit = async () => {
    const draftId = String(article.id || article.draft_id || '');
    if (!draftId) {
      MessagePlugin.warning('文章缺少草稿 ID，不能创建发布任务');
      return;
    }
    if (!accountId || !platform) {
      MessagePlugin.warning('请选择自有账号和平台');
      return;
    }
    setLoading(true);
    try {
      const body: OwnedPublishingTaskCreateRequest = {
        draft_id: draftId,
        account_id: accountId,
        platform,
        publish_mode: publishMode || selectedAccount?.publish_mode || 'manual_copy',
      };
      const task = await createOwnedPublishingTask(body);
      const entryUrl = task.platform_entry_url || selectedAccount?.account_home_url;
      if (entryUrl) {
        window.open(String(entryUrl), '_blank', 'noopener,noreferrer');
      }
      setCreatedTask(task);
      setPublishUrl('');
      setImportHint('');
      setOpen(false);
      setAssistantOpen(true);
      if ((publishMode || '').startsWith('zhihu_import')) {
        await downloadZhihuImportFile(task, false);
        await copyZhihuTitleAssistant(task);
      } else {
        await copyPreparedText(task);
      }
      MessagePlugin.success(entryUrl ? '已创建任务，并打开发布助手和平台入口' : '已创建任务，并打开发布助手');
    } catch (err: any) {
      MessagePlugin.error(`创建发布任务失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  const copyPreparedText = async (task: OwnedPublishingTaskRow | null = createdTask) => {
    const publishText = composePublishClipboardText(
      task?.title || getArticleTitle(article),
      task?.draft_body || getArticleBody(article, bodyOverride),
    );
    if (!publishText) {
      MessagePlugin.warning('正文为空，无法复制');
      return false;
    }
    try {
      await navigator.clipboard.writeText(publishText);
      MessagePlugin.success('已复制标题和正文');
      return true;
    } catch {
      MessagePlugin.warning('浏览器未允许自动复制，可手动复制正文');
      return false;
    }
  };

  const copyTitleOnly = async (task: OwnedPublishingTaskRow | null = createdTask) => {
    const title = decodeStoredPublishText(task?.title || getArticleTitle(article)).trim();
    if (!title) {
      MessagePlugin.warning('标题为空，无法复制');
      return false;
    }
    try {
      await navigator.clipboard.writeText(title);
      MessagePlugin.success('已复制标题，请粘贴到知乎标题栏');
      return true;
    } catch {
      MessagePlugin.warning('浏览器未允许自动复制标题，可手动复制');
      return false;
    }
  };

  const copyZhihuTitleAssistant = async (task: OwnedPublishingTaskRow | null = createdTask) => {
    const title = decodeStoredPublishText(task?.title || getArticleTitle(article)).trim();
    if (!title) {
      MessagePlugin.warning('标题为空，无法生成标题助手');
      return false;
    }
    try {
      await navigator.clipboard.writeText(buildZhihuTitleFillBookmarklet(title));
      MessagePlugin.success('已复制知乎标题填充助手');
      return true;
    } catch {
      MessagePlugin.warning('浏览器未允许复制标题助手，可继续使用复制标题');
      return false;
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

  const finishPublish = async () => {
    if (!createdTask) return;
    if (!publishUrl.trim()) {
      MessagePlugin.warning('请先填写发布后的文章链接');
      return;
    }
    setFinishing(true);
    try {
      const next = await markOwnedPublishingTaskPublished(createdTask.id, { publish_url: publishUrl.trim() });
      setCreatedTask(next);
      MessagePlugin.success('发布已完成，链接已保存');
    } catch (err: any) {
      MessagePlugin.error(`完成发布失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setFinishing(false);
    }
  };

  const cancelTask = async () => {
    if (!createdTask) return;
    try {
      const next = await cancelOwnedPublishingTask(createdTask.id);
      setCreatedTask(next);
      setAssistantOpen(false);
      MessagePlugin.success('任务已取消');
    } catch (err: any) {
      MessagePlugin.error(`取消失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    }
  };

  const failTask = async () => {
    if (!createdTask) return;
    try {
      const next = await failOwnedPublishingTask(createdTask.id, { error_message: '运营手动标记失败' });
      setCreatedTask(next);
      MessagePlugin.success('已标记失败');
    } catch (err: any) {
      MessagePlugin.error(`标记失败失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    }
  };

  const openPlatform = async () => {
    await copyPreparedText();
    const entryUrl = createdTask?.platform_entry_url || selectedAccount?.account_home_url;
    if (entryUrl) {
      window.open(String(entryUrl), '_blank', 'noopener,noreferrer');
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const downloadZhihuImportFile = async (task: OwnedPublishingTaskRow | null = createdTask, showMessage = true) => {
    if (!task) return false;
    try {
      const file = await downloadOwnedPublishingTaskZhihuImportFile(task.id);
      downloadBlob(file.blob, file.filename);
      await copyZhihuTitleAssistant(task);
      if (showMessage) MessagePlugin.success('知乎导入文件已生成');
      return true;
    } catch (err: any) {
      MessagePlugin.error(`生成导入文件失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
      return false;
    }
  };

  const tryZhihuAutoImport = async () => {
    if (!createdTask) return;
    await downloadZhihuImportFile(createdTask, false);
    if (createdTask.platform_entry_url) {
      window.open(String(createdTask.platform_entry_url), '_blank', 'noopener,noreferrer');
    }
    setImportHint(
      `已生成知乎 .md 导入文件并打开知乎写文章页。系统已复制“标题填充助手”：${zhihuAssistantHelpText} 当前普通后台网页不能直接操控知乎上传控件；未安装浏览器助手时，请在知乎导入文档中选择刚下载的 .md 文件。`,
    );
    MessagePlugin.warning('已准备导入文件；自动扫描上传需要浏览器助手，当前可手动导入');
  };

  return (
    <>
      <Button size={size} variant='outline' icon={<UserIcon />} disabled={disabled} onClick={openDialog}>
        自有账号发布
      </Button>
      <Dialog
        visible={open}
        header='自有账号发布'
        width='560px'
        confirmBtn={{ content: '创建并打开平台', loading }}
        onClose={() => setOpen(false)}
        onCancel={() => setOpen(false)}
        onConfirm={submit}
      >
        <Space direction='vertical' style={{ width: '100%' }} size={16}>
          <div>
            <strong>{getArticleTitle(article)}</strong>
          </div>
          <Select
            value={accountId}
            clearable
            placeholder='选择账号池中的个人号或企业号'
            options={accounts.map((item) => ({
              label: `${item.platform} / ${item.account_name} / ${accountTypeLabel(item.account_type)}`,
              value: item.id,
            }))}
            onChange={(value) => {
              const id = String(value || '');
              const account = accounts.find((item) => item.id === id);
              setAccountId(id);
              if (account?.platform) {
                setPlatform(account.platform);
                setPublishMode(
                  account.platform.includes('知乎') && account.account_type === 'personal'
                    ? 'zhihu_import_beta'
                    : 'manual_copy',
                );
              }
            }}
          />
          <Select
            value={platform}
            placeholder='发布平台'
            options={['小红书', '知乎', '微信公众号', '官网 CMS', 'B站', '微博', '抖音', '视频号'].map((item) => ({
              label: item,
              value: item,
            }))}
            onChange={(value) => {
              const nextPlatform = String(value || '');
              setPlatform(nextPlatform);
              setPublishMode(
                nextPlatform.includes('知乎') && selectedAccount?.account_type === 'personal'
                  ? 'zhihu_import_beta'
                  : 'manual_copy',
              );
            }}
          />
          {isZhihuPersonal ? (
            <Select
              value={publishMode}
              placeholder='发布方式'
              options={[
                { label: '辅助导入 Beta（生成 .md 并打开知乎）', value: 'zhihu_import_beta' },
                { label: '文档导入（只生成文件）', value: 'zhihu_import_file' },
                { label: '复制粘贴发布', value: 'manual_copy' },
              ]}
              onChange={(value) => setPublishMode(String(value || 'manual_copy'))}
            />
          ) : null}
          <div style={{ color: 'rgba(148, 163, 184, 0.92)', lineHeight: 1.7 }}>
            该入口只创建自有账号发布任务，不进入媒体市场，不修改原有分发流程。知乎个人号会生成可导入 .md 文件；自动导入
            Beta 需要浏览器助手支持，失败时可退回手动导入或复制发布。
          </div>
        </Space>
      </Dialog>
      <Dialog
        visible={assistantOpen}
        header='自有账号发布助手'
        width='720px'
        footer={false}
        onClose={() => setAssistantOpen(false)}
        onCancel={() => setAssistantOpen(false)}
      >
        {createdTask ? (
          <Space direction='vertical' style={{ width: '100%' }} size={16}>
            <Space>
              <Tag theme={createdTask.publish_url ? 'success' : 'primary'} variant='light'>
                {createdTask.publish_url ? '已发布' : '待发布'}
              </Tag>
              <Tag theme='primary' variant='light'>
                {createdTask.platform}
              </Tag>
              <Tag theme='default' variant='light'>
                {createdTask.account_name || '自有账号'}
              </Tag>
            </Space>
            <div>
              <strong>{decodeStoredPublishText(createdTask.title)}</strong>
              <div style={{ color: 'rgba(148, 163, 184, 0.92)', marginTop: 8 }}>
                {String(createdTask.publish_mode || '').startsWith('zhihu_import')
                  ? '已生成知乎可导入 Markdown 文件。知乎不会把导入文档里的标题自动填进顶部标题栏，系统已复制“标题填充助手”，可在知乎页执行后自动填标题，再导入文档。发布成功后复制文章链接，回到这里完成。'
                  : '内容已准备好。请在新打开的平台页面粘贴发布，发布成功后复制文章链接，回到这里完成。'}
              </div>
            </div>
            {String(createdTask.publish_mode || '').startsWith('zhihu_import') ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  background: 'rgba(37, 99, 235, 0.08)',
                  color: 'rgba(148, 163, 184, 0.96)',
                  lineHeight: 1.7,
                }}
              >
                当前流程：生成 .md 文件 → 打开知乎写文章 → 执行标题填充助手 → 导入文档 → 人工检查发布 →
                回填链接。导入文件已移除正文 H1 和 Markdown 分割线，避免重复标题和灰色横杆。
              </div>
            ) : null}
            {importHint ? <div style={{ color: '#ED7B2F', lineHeight: 1.7 }}>{importHint}</div> : null}
            <Textarea
              value={decodeStoredPublishText(createdTask.draft_body || getArticleBody(article, bodyOverride))}
              readonly
              autosize={{ minRows: 8, maxRows: 12 }}
            />
            <Space breakLine>
              {String(createdTask.publish_mode || '').startsWith('zhihu_import') ? (
                <>
                  <Button theme='primary' onClick={tryZhihuAutoImport}>
                    尝试自动导入 Beta
                  </Button>
                  <Button variant='outline' onClick={() => downloadZhihuImportFile()}>
                    下载知乎导入文件
                  </Button>
                  <Button variant='outline' onClick={() => copyZhihuTitleAssistant()}>
                    复制填标题助手
                  </Button>
                  <Button variant='outline' onClick={() => copyTitleOnly()}>
                    复制知乎标题
                  </Button>
                </>
              ) : null}
              <Button onClick={() => copyPreparedText()}>重新复制正文</Button>
              {createdTask.platform_entry_url ? (
                <Button icon={<LinkIcon />} onClick={openPlatform}>
                  复制并打开平台
                </Button>
              ) : null}
              {createdTask.publish_url ? (
                <Button
                  variant='outline'
                  onClick={() => window.open(String(createdTask.publish_url), '_blank', 'noopener,noreferrer')}
                >
                  查看已发布文章
                </Button>
              ) : null}
            </Space>
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
              <Button theme='primary' loading={finishing} onClick={finishPublish}>
                完成发布
              </Button>
            </Space>
            <Space>
              {!createdTask.publish_url ? (
                <>
                  <Button variant='text' theme='danger' onClick={failTask}>
                    标记失败
                  </Button>
                  <Button variant='text' theme='danger' onClick={cancelTask}>
                    取消任务
                  </Button>
                </>
              ) : null}
            </Space>
          </Space>
        ) : null}
      </Dialog>
    </>
  );
};

export default OwnedAccountPublishButton;
