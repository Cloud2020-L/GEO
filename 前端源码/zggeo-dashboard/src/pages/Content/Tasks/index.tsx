import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Dialog,
  Form,
  Input,
  MessagePlugin,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Textarea,
} from 'tdesign-react';
import { AddIcon, DeleteIcon, RefreshIcon, RocketIcon } from 'tdesign-icons-react';
import {
  createContentTaskDb,
  deleteArticleDraftDb,
  listContentTasksDb,
  mineContentQuestions,
  updateArticleDraftDb,
} from 'services/zggeo-api';
import {
  buildProjectSourceOptions,
  defaultKeywordsFor,
  getActiveProjectContext,
  loadProjectSources,
  normalizeDomain,
  ProjectContext,
  saveActiveProjectContext,
} from 'utils/projectContext';
import { stripMarkdownForPublish } from 'utils/publishText';
import { getScopedStorageItem, setScopedStorageItem } from 'utils/scopedStorage';
import { channels } from '../common';
import Style from '../linear.module.less';

const { FormItem } = Form;
const PROMPT_STORAGE_KEY = 'example.com.v1';

const uid = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

interface QuestionMiningContext {
  keyword: string;
  brand?: string;
  domain?: string;
  limit?: number;
}

const extractVariables = (body: string): string[] => {
  const re = /\{\{\s*([\w\u4e00-\u9fa5-]+)\s*\}\}/g;
  return [...new Set(Array.from(body.matchAll(re), (match) => match[1]))];
};

const loadPromptStore = () => {
  try {
    const raw = getScopedStorageItem(PROMPT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const appendQuestionPrompts = (items: Record<string, any>[], keyword: string) => {
  const now = new Date().toISOString();
  const existing = loadPromptStore();
  const existingKeys = new Set(existing.map((item: any) => String(item.title || '').trim()));
  const nextItems = items
    .filter((item) => item.question && !existingKeys.has(String(item.question)))
    .map((item) => ({
      id: uid(),
      title: String(item.question),
      category: 'qa',
      body: String(item.question),
      variables: extractVariables(String(item.question)),
      tags: [keyword, '高频问题', String(item.source || '搜索建议')].filter(Boolean),
      favorite: false,
      created_at: now,
      updated_at: now,
    }));
  setScopedStorageItem(PROMPT_STORAGE_KEY, JSON.stringify([...nextItems, ...existing]));
  return nextItems.length;
};

const mineAndStoreQuestionPrompts = async (context: QuestionMiningContext) => {
  const keyword = String(context.keyword || '').trim();
  if (!keyword) return { questionCount: 0, promptCount: 0 };
  const mined = await mineContentQuestions({
    keyword,
    brand: String(context.brand || '').trim() || undefined,
    domain: context.domain ? normalizeDomain(String(context.domain)) : undefined,
    limit: context.limit || 8,
  });
  const questions = ((mined.questions || []) as Record<string, any>[]).slice(0, context.limit || 8);
  return {
    questionCount: questions.length,
    promptCount: appendQuestionPrompts(questions, keyword),
  };
};

const priorityTheme = (priority: string) => {
  if (priority === '高') return 'danger';
  if (priority === '中') return 'warning';
  return 'default';
};

const Metric: React.FC<{ title: string; value: number; color?: string }> = ({ title, value, color }) => (
  <Card bordered={false} className={Style.statCard}>
    <div className={Style.statLabel}>{title}</div>
    <div className={Style.statValue} style={color ? { color } : undefined}>
      {value}
    </div>
  </Card>
);

const Tasks: React.FC = () => {
  const [tasks, setTasks] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState(false);
  const [agentLoading, setAgentLoading] = useState('');
  const [open, setOpen] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sources, setSources] = useState<ProjectContext[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [draftOpen, setDraftOpen] = useState(false);
  const [selectedDraftTask, setSelectedDraftTask] = useState<Record<string, any> | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [promptTotal, setPromptTotal] = useState(() => loadPromptStore().length);
  const [form, setForm] = useState({
    brand: 'ZGEO 智改',
    domain: 'example.com',
    keyword: '',
    channel: '官网文章',
    priority: '高',
  });

  const sourceOptions = useMemo(() => buildProjectSourceOptions(sources), [sources]);

  const fetchData = async () => {
    setLoading(true);
    try {
      setTasks(await listContentTasksDb({ limit: 50 }));
    } catch (err: any) {
      MessagePlugin.error(`任务加载失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    setPromptTotal(loadPromptStore().length);
  }, []);

  const applyProjectSource = (source: ProjectContext) => {
    const brand = source.project_name || source.domain || form.brand;
    const domain = normalizeDomain(source.domain || form.domain);
    setSelectedSourceId(source.id);
    setForm((old) => ({
      ...old,
      brand,
      domain,
      keyword: old.keyword || source.keywords[0] || defaultKeywordsFor(brand)[0] || '',
    }));
    saveActiveProjectContext(source);
  };

  const loadSources = async () => {
    setSourceLoading(true);
    try {
      let nextSources = await loadProjectSources();
      const active = getActiveProjectContext();
      if (active) {
        nextSources = [active, ...nextSources.filter((item) => item.id !== active.id)];
      }
      setSources(nextSources);
      const preferred = active || nextSources.find((item) => item.project_name && item.domain) || nextSources[0];
      if (preferred) applyProjectSource(preferred);
    } catch (err: any) {
      MessagePlugin.warning(`客户资产读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setSourceLoading(false);
    }
  };

  useEffect(() => {
    loadSources();
  }, []);

  const stats = useMemo(
    () => ({
      total: tasks.length,
      high: tasks.filter((task) => task.priority === '高').length,
      ready: tasks.filter((task) => task.status === '可分发').length,
      promptReady: promptTotal,
      waitingPublish: tasks.filter((task) => task.status === '待发布').length,
    }),
    [promptTotal, tasks],
  );

  const submit = async () => {
    if (!form.keyword.trim()) {
      MessagePlugin.warning('请填写关键词');
      return;
    }
    if (!form.brand.trim() || !form.domain.trim()) {
      MessagePlugin.warning('请先选择客户资产，或补充品牌和官网域名');
      return;
    }
    try {
      setAgentLoading('mine');
      const mined = await mineContentQuestions({
        keyword: form.keyword.trim(),
        brand: form.brand.trim(),
        domain: normalizeDomain(form.domain),
        limit: 8,
      });
      const questions = ((mined.questions || []) as Record<string, any>[]).slice(0, 8);
      if (questions.length === 0) {
        MessagePlugin.warning('没有挖掘到问题，请换一个关键词试试');
        return;
      }
      const promptCount = appendQuestionPrompts(questions, form.keyword.trim());
      setPromptTotal(loadPromptStore().length);
      await Promise.all(
        questions.map((item) => {
          const question = String(item.question || '').trim();
          return createContentTaskDb({
            title: question,
            brand: form.brand.trim(),
            domain: normalizeDomain(form.domain),
            keyword: form.keyword.trim(),
            channel: form.channel,
            priority: form.priority,
            angle: `围绕真实用户高频问题“${question}”写一篇可被 AI 搜索理解、引用和推荐的内容。问题来源：${
              item.source || '搜索建议'
            }`,
            outline: [
              `直接回答用户问题：${question}`,
              `结合 ${form.brand.trim()} 的品牌定位和官网 ${normalizeDomain(form.domain)} 说明解决方案`,
              '补充适用对象、场景、步骤、案例/证据和 FAQ',
              '输出适合官网文章/公众号发布的 CTA',
            ],
          });
        }),
      );
      MessagePlugin.success(`已生成 ${questions.length} 条写作任务，并写入 ${promptCount} 条 Prompt 库问题`);
      setOpen(false);
      fetchData();
    } catch (err: any) {
      MessagePlugin.error(`自动创建失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setAgentLoading('');
    }
  };

  const collectTaskQuestions = async (row: Record<string, any>) => {
    const taskId = String(row.id || '');
    setAgentLoading(taskId);
    try {
      const result = await mineAndStoreQuestionPrompts({
        keyword: String(row.keyword || row.title || ''),
        brand: String(row.brand || ''),
        domain: String(row.domain || ''),
        limit: 8,
      });
      if (result.questionCount === 0) {
        MessagePlugin.warning('没有采集到高频问题，请检查关键词');
        return;
      }
      setPromptTotal(loadPromptStore().length);
      MessagePlugin.success(`已采集 ${result.questionCount} 条高频问题，新增 ${result.promptCount} 条到 Prompt 库`);
    } catch (err: any) {
      MessagePlugin.error(`采集失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setAgentLoading('');
    }
  };

  const openDraft = (row: Record<string, any>) => {
    if (!row.draft_id || !row.draft_body) {
      MessagePlugin.warning('这条任务还没有文章正文，请到“文章生成”页选择任务后生成');
      return;
    }
    setSelectedDraftTask(row);
    setDraftBody(String(row.draft_body || ''));
    setDraftOpen(true);
  };

  const saveDraft = async () => {
    if (!selectedDraftTask?.draft_id) return;
    if (!draftBody.trim()) {
      MessagePlugin.warning('文章正文不能为空');
      return;
    }
    setAgentLoading('save-draft');
    try {
      await updateArticleDraftDb(String(selectedDraftTask.draft_id), {
        title: String(selectedDraftTask.draft_title || selectedDraftTask.title || ''),
        body: draftBody,
        status: String(selectedDraftTask.draft_status || '待发布'),
      });
      MessagePlugin.success('文章内容已保存');
      setDraftOpen(false);
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(`保存失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setAgentLoading('');
    }
  };

  const copyDraft = async () => {
    if (!draftBody.trim()) return;
    await navigator.clipboard.writeText(stripMarkdownForPublish(draftBody));
    MessagePlugin.success('已复制发布正文');
  };

  const deleteDraft = async (row: Record<string, any>) => {
    if (!row.draft_id) return;
    setAgentLoading(`delete-${row.draft_id}`);
    try {
      await deleteArticleDraftDb(String(row.draft_id));
      if (selectedDraftTask?.draft_id === row.draft_id) {
        setDraftOpen(false);
        setSelectedDraftTask(null);
        setDraftBody('');
      }
      MessagePlugin.success('文章草稿已删除，可重新生成');
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(`删除失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setAgentLoading('');
    }
  };

  const autoStart = async () => {
    setAgentLoading('auto-start');
    try {
      const candidates = tasks.filter((task) => !task.draft_id && String(task.keyword || '').trim()).slice(0, 10);
      const results = await Promise.all(
        candidates.map((task) =>
          mineAndStoreQuestionPrompts({
            keyword: String(task.keyword || ''),
            brand: String(task.brand || ''),
            domain: String(task.domain || ''),
            limit: 8,
          }),
        ),
      );
      const questionCount = results.reduce((sum, item) => sum + item.questionCount, 0);
      const promptCount = results.reduce((sum, item) => sum + item.promptCount, 0);
      setPromptTotal(loadPromptStore().length);
      MessagePlugin.success(
        `已扫描 ${candidates.length} 条任务关键词，采集 ${questionCount} 条高频问题，新增 ${promptCount} 条 Prompt`,
      );
    } catch (err: any) {
      MessagePlugin.error(`批量采集失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setAgentLoading('');
    }
  };

  const statusTheme = (status: string) => {
    if (status === '待发布' || status === '可分发' || status === '已发布') return 'success';
    if (status === '已生成') return 'primary';
    if (['自动运行', 'Agent运行中', '高频问题采集中'].includes(status)) return 'warning';
    if (status === '高频问题已采集') return 'primary';
    if (status === 'Agent失败') return 'danger';
    return 'default';
  };

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              内容生产
            </Tag>
            <Tag theme='success' variant='light'>
              数据库任务池
            </Tag>
            <Tag theme='warning' variant='light'>
              高频问题采集入口
            </Tag>
          </Space>
          <div className={Style.heroTitle}>写作任务池</div>
          <div className={Style.heroDesc}>
            这里负责沉淀关键词、选题和真实高频问题。自动写文章已拆到“文章生成”页，不再从任务池一键跑到待发布。
          </div>
        </Space>
      </Card>

      <div className={Style.statsGrid}>
        <Metric title='任务总数' value={stats.total} />
        <Metric title='高优先级' value={stats.high} color='#E34D59' />
        <Metric title='Prompt 问题' value={stats.promptReady} color='#ED7B2F' />
        <Metric title='待发布草稿' value={stats.waitingPublish || stats.ready} color='#00A870' />
      </div>

      <Card
        bordered={false}
        className={Style.sectionCard}
        title='任务队列'
        actions={
          <Space>
            <Button icon={<RefreshIcon />} loading={loading} onClick={fetchData}>
              刷新
            </Button>
            <Button icon={<RocketIcon />} loading={agentLoading === 'auto-start'} onClick={autoStart}>
              扫描高频问题
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={() => setOpen(true)}>
              新建写作任务
            </Button>
          </Space>
        }
      >
        <Table
          loading={loading}
          rowKey='id'
          data={tasks}
          columns={[
            {
              colKey: 'title',
              title: '选题',
              width: 340,
              cell: ({ row }) => (
                <div>
                  <div className={Style.itemTitle}>{row.title}</div>
                  <div className={Style.mutedText} style={{ marginTop: 4 }}>
                    {row.domain}
                  </div>
                  {row.agent_key && (
                    <div style={{ marginTop: 4 }}>
                      <Tag size='small' theme='primary' variant='light'>
                        {row.agent_key}
                      </Tag>
                      <Tag size='small' theme='default' variant='light' style={{ marginLeft: 4 }}>
                        {row.agent_content_type || row.agent_stage}
                      </Tag>
                    </div>
                  )}
                </div>
              ),
            },
            {
              colKey: 'keyword',
              title: '关键词',
              cell: ({ row }) => (
                <Tag theme='primary' variant='light'>
                  {row.keyword}
                </Tag>
              ),
            },
            { colKey: 'channel', title: '渠道' },
            {
              colKey: 'priority',
              title: '优先级',
              cell: ({ row }) => (
                <Tag theme={priorityTheme(String(row.priority)) as any} variant='light'>
                  {row.priority}
                </Tag>
              ),
            },
            {
              colKey: 'status',
              title: '状态',
              cell: ({ row }) => (
                <Space direction='vertical' size={2}>
                  <Tag theme={statusTheme(String(row.status)) as any} variant='light'>
                    {row.status}
                  </Tag>
                  {row.agent_geo_score ? (
                    <Tag size='small' theme='success' variant='light'>
                      GEO {row.agent_geo_score}
                    </Tag>
                  ) : null}
                </Space>
              ),
            },
            {
              colKey: 'created_at',
              title: '创建时间',
              cell: ({ row }) => new Date(row.created_at).toLocaleString('zh-CN'),
            },
            {
              colKey: 'action',
              title: '问题采集',
              fixed: 'right',
              width: 230,
              cell: ({ row }) => (
                <Space>
                  <Button size='small' variant='outline' disabled={!row.draft_id} onClick={() => openDraft(row)}>
                    查看/编辑
                  </Button>
                  <Popconfirm content='确认删除这篇文章草稿？删除后可重新生成。' onConfirm={() => deleteDraft(row)}>
                    <Button
                      size='small'
                      variant='text'
                      theme='danger'
                      icon={<DeleteIcon />}
                      loading={agentLoading === `delete-${row.draft_id}`}
                      disabled={!row.draft_id}
                    >
                      删除文章
                    </Button>
                  </Popconfirm>
                  <Button
                    size='small'
                    variant='outline'
                    loading={agentLoading === row.id}
                    disabled={!String(row.keyword || '').trim()}
                    onClick={() => collectTaskQuestions(row)}
                  >
                    采集问题
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Dialog
        visible={open}
        header='关键词生成写作任务'
        width={760}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        confirmBtn={agentLoading === 'mine' ? '生成中...' : '挖掘问题并创建任务'}
      >
        <Form layout='vertical'>
          <FormItem label='从客户资产导入'>
            <Space style={{ width: '100%' }}>
              <Select
                value={selectedSourceId}
                options={sourceOptions}
                loading={sourceLoading}
                filterable
                clearable
                placeholder='选择客户资产 / 品牌池'
                style={{ flex: 1 }}
                onChange={(value) => {
                  const source = sources.find((item) => item.id === String(value || ''));
                  if (source) applyProjectSource(source);
                }}
              />
              <Button variant='outline' loading={sourceLoading} onClick={loadSources}>
                刷新资料
              </Button>
            </Space>
          </FormItem>
          <FormItem label='品牌 / 域名'>
            <Space style={{ width: '100%' }}>
              <Input value={form.brand} onChange={(v) => setForm({ ...form, brand: String(v) })} />
              <Input value={form.domain} onChange={(v) => setForm({ ...form, domain: String(v) })} />
            </Space>
          </FormItem>
          <FormItem label='关键词 / 渠道'>
            <Space style={{ width: '100%' }}>
              <Input
                value={form.keyword}
                placeholder='只填一个核心关键词，例如：AI 可见度优化'
                onChange={(v) => setForm({ ...form, keyword: String(v) })}
              />
              <Select
                value={form.channel}
                options={channels.map((item) => ({ label: item, value: item }))}
                onChange={(v) => setForm({ ...form, channel: String(v) })}
              />
            </Space>
          </FormItem>
          <FormItem label='优先级'>
            <Select
              value={form.priority}
              options={['高', '中', '低'].map((item) => ({ label: item, value: item }))}
              onChange={(v) => setForm({ ...form, priority: String(v) })}
            />
          </FormItem>
          <div style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
            提交后会自动从搜索建议接口挖掘真实用户高频问题；每个问题会原样保存到 Prompt
            库，并生成一条写作任务。文章正文请到“文章生成”页结合公司信息、Prompt、图片和可用 AI 生成。
          </div>
        </Form>
      </Dialog>
      <Dialog
        visible={draftOpen}
        header={selectedDraftTask ? `查看/编辑文章：${selectedDraftTask.title}` : '查看/编辑文章'}
        width={980}
        onClose={() => setDraftOpen(false)}
        onConfirm={saveDraft}
        confirmBtn={agentLoading === 'save-draft' ? '保存中...' : '保存修改'}
        cancelBtn='关闭'
      >
        {selectedDraftTask && (
          <Space direction='vertical' style={{ width: '100%' }}>
            <Space>
              <Tag theme='primary' variant='light'>
                {selectedDraftTask.channel}
              </Tag>
              <Tag theme='success' variant='light'>
                {selectedDraftTask.draft_status || selectedDraftTask.status}
              </Tag>
              {selectedDraftTask.agent_geo_score ? (
                <Tag theme='warning' variant='light'>
                  GEO {selectedDraftTask.agent_geo_score}
                </Tag>
              ) : null}
              <Button size='small' variant='outline' onClick={copyDraft}>
                复制正文
              </Button>
            </Space>
            <Textarea
              value={draftBody}
              onChange={(v) => setDraftBody(String(v))}
              autosize={{ minRows: 24, maxRows: 36 }}
            />
          </Space>
        )}
      </Dialog>
    </div>
  );
};

export default Tasks;
