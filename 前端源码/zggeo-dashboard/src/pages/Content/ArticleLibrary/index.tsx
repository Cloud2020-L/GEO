import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Dialog,
  Input,
  MessagePlugin,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Textarea,
} from 'tdesign-react';
import { DeleteIcon, DownloadIcon, EditIcon, RefreshIcon } from 'tdesign-icons-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Lead,
  deleteArticleDraftDb,
  exportArticleDocxDb,
  getArticleDraftDb,
  getManagedImageDb,
  listArticleDraftsDb,
  listSelectableLeads,
  updateArticleDraftDb,
} from 'services/zggeo-api';
import { parseArticlePreviewSegments, type ArticlePreviewImageSegment } from 'utils/articlePreview';
import { loadProtectedImageUrl } from 'utils/contentImageStore';
import ArticleDistributionButton from '../Generate/components/ArticleDistributionButton';
import OwnedAccountPublishButton from '../Generate/components/OwnedAccountPublishButton';
import Style from '../linear.module.less';

interface ArticleRow {
  id: string;
  task_id?: string;
  title: string;
  body?: string;
  body_preview?: string;
  body_length?: number;
  status: string;
  channel?: string;
  article_type?: string;
  provider?: string;
  model?: string;
  created_at?: string;
  brand?: string;
  domain?: string;
  keyword?: string;
  source_title?: string;
  source_prompt_id?: string;
  source_prompt_text?: string;
  source_prompt_keyword?: string;
  source_prompt_intent?: string;
  source_prompt_scenario?: string;
  generated_from?: string;
  lead_id?: string;
  compliance_status?: string;
  compliance_summary?: string;
  human_review_required?: boolean;
  human_reviewed_at?: string;
}

const statusTheme = (status: string): 'success' | 'primary' | 'warning' | 'danger' | 'default' => {
  if (['待发布', '可分发', '已发布'].includes(status)) return 'success';
  if (['已生成', '草稿'].includes(status)) return 'primary';
  if (status.includes('失败')) return 'danger';
  return 'default';
};

const cleanDomain = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();

const formatTime = (value: unknown) => {
  if (!value) return '-';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN');
};

const safeDownloadFilename = (value: unknown) =>
  String(value || '文章导出')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '文章导出';

const parseDocxFilename = (contentDisposition: unknown, fallbackTitle: string) => {
  const header = String(contentDisposition || '');
  const encodedMatch = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return encodedMatch[1];
    }
  }
  const filenameMatch = /filename="?([^";]+)"?/i.exec(header);
  return filenameMatch?.[1] || `${safeDownloadFilename(fallbackTitle)}.docx`;
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

const toArticleRows = (drafts: Record<string, unknown>[], tasks: Record<string, unknown>[]): ArticleRow[] => {
  const taskMap = new Map(tasks.map((task) => [String(task.id), task]));
  return drafts.map((draft) => {
    const task = taskMap.get(String(draft.task_id || '')) || {};
    return {
      id: String(draft.id),
      task_id: draft.task_id ? String(draft.task_id) : undefined,
      title: String(draft.title || '未命名文章'),
      body: draft.body === undefined || draft.body === null ? undefined : String(draft.body || ''),
      body_preview: String(draft.body_preview || ''),
      body_length: Number(draft.body_length || 0),
      status: String(draft.status || '已生成'),
      channel: String(draft.channel || task.channel || ''),
      article_type: draft.article_type ? String(draft.article_type) : undefined,
      provider: draft.provider ? String(draft.provider) : undefined,
      model: draft.model ? String(draft.model) : undefined,
      created_at: String(draft.created_at || ''),
      brand: String(draft.task_brand || task.brand || ''),
      domain: String(draft.task_domain || task.domain || ''),
      keyword: String(draft.source_prompt_keyword || draft.task_keyword || task.keyword || ''),
      source_title: String(draft.task_title || task.title || ''),
      source_prompt_id: draft.source_prompt_id ? String(draft.source_prompt_id) : undefined,
      source_prompt_text: draft.source_prompt_text ? String(draft.source_prompt_text) : undefined,
      source_prompt_keyword: draft.source_prompt_keyword ? String(draft.source_prompt_keyword) : undefined,
      source_prompt_intent: draft.source_prompt_intent ? String(draft.source_prompt_intent) : undefined,
      source_prompt_scenario: draft.source_prompt_scenario ? String(draft.source_prompt_scenario) : undefined,
      generated_from: draft.generated_from ? String(draft.generated_from) : undefined,
      lead_id: draft.task_lead_id ? String(draft.task_lead_id) : task.lead_id ? String(task.lead_id) : undefined,
      compliance_status: draft.compliance_status ? String(draft.compliance_status) : undefined,
      compliance_summary: draft.compliance_summary ? String(draft.compliance_summary) : undefined,
      human_review_required: Boolean(draft.human_review_required),
      human_reviewed_at: draft.human_reviewed_at ? String(draft.human_reviewed_at) : undefined,
    };
  });
};

const renderInlinePreviewText = (text: string, keyPrefix: string) => {
  const nodes: React.ReactNode[] = [];
  const strongRe = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match = strongRe.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`${keyPrefix}-txt-${lastIndex}`}>{text.slice(lastIndex, match.index)}</span>);
    }
    nodes.push(<strong key={`${keyPrefix}-strong-${match.index}`}>{match[1]}</strong>);
    lastIndex = match.index + match[0].length;
    match = strongRe.exec(text);
  }
  if (lastIndex < text.length) nodes.push(<span key={`${keyPrefix}-txt-last`}>{text.slice(lastIndex)}</span>);
  return nodes;
};

const renderArticlePreviewText = (text: string, keyPrefix: string) => {
  const blocks = String(text || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, blockIndex) => {
    const blockKey = `${keyPrefix}-block-${blockIndex}`;
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return null;

    const heading = lines[0];
    const rest = lines.slice(1).join(' ');
    if (/^#\s+/.test(heading)) {
      return (
        <React.Fragment key={blockKey}>
          <h1>{heading.replace(/^#\s+/, '')}</h1>
          {rest ? <p>{renderInlinePreviewText(rest, `${blockKey}-rest`)}</p> : null}
        </React.Fragment>
      );
    }
    if (/^##\s+/.test(heading)) {
      return (
        <React.Fragment key={blockKey}>
          <h2>{heading.replace(/^##\s+/, '')}</h2>
          {rest ? <p>{renderInlinePreviewText(rest, `${blockKey}-rest`)}</p> : null}
        </React.Fragment>
      );
    }
    if (/^###\s+/.test(heading)) {
      return (
        <React.Fragment key={blockKey}>
          <h3>{heading.replace(/^###\s+/, '')}</h3>
          {rest ? <p>{renderInlinePreviewText(rest, `${blockKey}-rest`)}</p> : null}
        </React.Fragment>
      );
    }
    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      return (
        <ul key={blockKey}>
          {lines.map((line, lineIndex) => (
            <li key={`${blockKey}-li-${lineIndex}`}>
              {renderInlinePreviewText(line.replace(/^[-*]\s+/, ''), `${blockKey}-li-${lineIndex}`)}
            </li>
          ))}
        </ul>
      );
    }
    if (lines.every((line) => /^\d+\.\s+/.test(line))) {
      return (
        <ol key={blockKey}>
          {lines.map((line, lineIndex) => (
            <li key={`${blockKey}-li-${lineIndex}`}>
              {renderInlinePreviewText(line.replace(/^\d+\.\s+/, ''), `${blockKey}-li-${lineIndex}`)}
            </li>
          ))}
        </ol>
      );
    }
    return <p key={blockKey}>{renderInlinePreviewText(lines.join(' '), blockKey)}</p>;
  });
};

const normalizePreviewFileUrl = (url: unknown) => {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('http') || value.startsWith('blob:') || value.startsWith('data:') || value.startsWith('/')) {
    return value;
  }
  return `/api/zggeo${value.startsWith('/') ? value : `/${value}`}`;
};

const renderArticlePreview = (body: string, imageUrlMap: Record<string, string> = {}) => {
  const segments = parseArticlePreviewSegments(body);
  if (!segments.length) return <div className={Style.emptyState}>暂无正文内容</div>;
  return (
    <article className={Style.articleDialogPage}>
      <Tag theme='primary' variant='light'>
        成品预览
      </Tag>
      {segments.map((segment, index) => {
        if (segment.type === 'image') {
          const src = imageUrlMap[segment.src] || (segment.src.startsWith('zggeo-image://') ? '' : segment.src);
          return (
            <figure key={`preview-image-${index}`} className={Style.articlePreviewImageBlock}>
              {src ? (
                <img className={Style.articlePreviewImage} src={src} alt={segment.alt} />
              ) : (
                <div className={Style.emptyState}>图片暂不可用：{segment.alt}</div>
              )}
              {segment.alt ? <figcaption>{segment.alt}</figcaption> : null}
            </figure>
          );
        }
        return (
          <React.Fragment key={`preview-text-${index}`}>
            {renderArticlePreviewText(segment.text, `preview-${index}`)}
          </React.Fragment>
        );
      })}
    </article>
  );
};

const ArticleLibrary: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlPromptId = searchParams.get('prompt_id') || '';
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, unknown>[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ArticleRow | null>(null);
  const [viewing, setViewing] = useState<ArticleRow | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewImageUrls, setPreviewImageUrls] = useState<Record<string, string>>({});
  const [exportingId, setExportingId] = useState('');

  const fetchData = async (leadId = selectedLeadId) => {
    setLoading(true);
    try {
      const [draftRows, leadRows] = await Promise.allSettled([
        listArticleDraftsDb({
          limit: 100,
          prompt_id: urlPromptId || undefined,
          lead_id: leadId || undefined,
        }),
        listSelectableLeads(),
      ]);
      if (draftRows.status === 'fulfilled') {
        setDrafts(draftRows.value);
      } else {
        throw draftRows.reason;
      }
      if (leadRows.status === 'fulfilled') {
        setLeads(leadRows.value);
      } else {
        MessagePlugin.warning(`客户筛选加载失败：${leadRows.reason?.message || '不影响文章列表'}`);
      }
    } catch (err: any) {
      MessagePlugin.error(`文章库加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const leadOptions = useMemo(
    () => [
      { label: '全部客户文章', value: '' },
      ...leads.map((lead) => ({
        label: `${lead.brand_name || lead.company || lead.name || '未命名'} · ${lead.domain || '无域名'}`,
        value: String(lead.id),
      })),
    ],
    [leads],
  );

  const rows = useMemo(() => toArticleRows(drafts, []), [drafts]);

  const filteredRows = useMemo(() => {
    const selectedLead = leads.find((lead) => String(lead.id) === selectedLeadId);
    const kw = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      const leadMatched =
        !selectedLead ||
        row.lead_id === selectedLeadId ||
        (cleanDomain(selectedLead.domain) && cleanDomain(selectedLead.domain) === cleanDomain(row.domain)) ||
        (selectedLead.brand_name &&
          String(row.brand || '')
            .toLowerCase()
            .includes(String(selectedLead.brand_name).toLowerCase()));
      const keywordMatched =
        !kw ||
        [
          row.title,
          row.brand,
          row.domain,
          row.keyword,
          row.status,
          row.channel,
          row.source_prompt_text,
          row.source_prompt_intent,
          row.source_prompt_scenario,
        ].some((value) =>
          String(value || '')
            .toLowerCase()
            .includes(kw),
        );
      return leadMatched && keywordMatched;
    });
  }, [keyword, leads, rows, selectedLeadId]);

  const loadArticleDetail = async (row: ArticleRow) => {
    if (row.body !== undefined) return row;
    setDetailLoadingId(row.id);
    try {
      const detail = await getArticleDraftDb(row.id);
      const detailedRow = toArticleRows([{ ...row, ...detail }], [])[0];
      setDrafts((items) => items.map((item) => (String(item.id) === row.id ? { ...item, ...detail } : item)));
      row.body = detailedRow.body || '';
      row.human_reviewed_at = detailedRow.human_reviewed_at;
      return detailedRow;
    } catch (err: any) {
      MessagePlugin.error(`文章正文加载失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
      throw err;
    } finally {
      setDetailLoadingId('');
    }
  };

  const openView = async (row: ArticleRow) => {
    const detail = await loadArticleDetail(row);
    setViewing(detail);
  };

  useEffect(() => {
    let cancelled = false;
    const resolveImages = async () => {
      const body = viewing?.body || '';
      const imageSegments = parseArticlePreviewSegments(body).filter(
        (segment): segment is ArticlePreviewImageSegment => segment.type === 'image',
      );
      if (!imageSegments.length) {
        setPreviewImageUrls({});
        return;
      }
      const pairs = await Promise.all(
        imageSegments.map(async (segment) => {
          const rawSrc = segment.src;
          if (rawSrc.startsWith('zggeo-image://')) {
            const imageId = rawSrc.replace('zggeo-image://', '');
            try {
              const image = await getManagedImageDb(imageId);
              const url = await loadProtectedImageUrl(normalizePreviewFileUrl(image.file_url));
              return [rawSrc, url] as const;
            } catch {
              return [rawSrc, ''] as const;
            }
          }
          if (rawSrc.startsWith('/')) {
            return [rawSrc, await loadProtectedImageUrl(rawSrc)] as const;
          }
          return [rawSrc, rawSrc] as const;
        }),
      );
      if (!cancelled) setPreviewImageUrls(Object.fromEntries(pairs));
    };
    resolveImages();
    return () => {
      cancelled = true;
    };
  }, [viewing?.body]);

  const openEdit = async (row: ArticleRow) => {
    const detail = await loadArticleDetail(row);
    setEditing(detail);
    setEditTitle(detail.title);
    setEditBody(detail.body || '');
  };

  const exportDocx = async (row: ArticleRow) => {
    setExportingId(row.id);
    try {
      const response = await exportArticleDocxDb(row.id);
      const blob =
        response.data instanceof Blob
          ? response.data
          : new Blob([response.data], {
              type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            });
      const filename = parseDocxFilename(response.headers?.['content-disposition'], row.title);
      downloadBlob(blob, filename.endsWith('.docx') ? filename : `${filename}.docx`);
      MessagePlugin.success('文章 DOCX 已导出');
    } catch (err: any) {
      MessagePlugin.error(`导出失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setExportingId('');
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editTitle.trim() || !editBody.trim()) {
      MessagePlugin.warning('标题和正文不能为空');
      return;
    }
    setSaving(true);
    try {
      await updateArticleDraftDb(editing.id, {
        title: editTitle.trim(),
        body: editBody,
        status: editing.status || '已生成',
      });
      MessagePlugin.success('文章已保存');
      setEditing(null);
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(`保存失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteDraft = async (row: ArticleRow) => {
    setSaving(true);
    try {
      await deleteArticleDraftDb(row.id);
      MessagePlugin.success('文章已删除');
      await fetchData();
    } catch (err: any) {
      MessagePlugin.error(`删除失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  const markReadyBeforePublish = async (row: ArticleRow) => {
    if (row.compliance_status === 'blocked') {
      MessagePlugin.error(row.compliance_summary || '文章发布审核未通过，不能分发');
      return false;
    }
    const detail = await loadArticleDetail(row);
    row.body = detail.body || '';
    const humanReviewed =
      !row.human_review_required ||
      Boolean(row.human_reviewed_at) ||
      window.confirm('该平台内容需要人工审核确认。确认你已人工编辑并审核后继续分发？');
    if (!humanReviewed) return false;
    try {
      if (row.status !== '已发布' || (row.human_review_required && !row.human_reviewed_at)) {
        await updateArticleDraftDb(row.id, {
          title: row.title,
          body: detail.body || '',
          status: row.status === '已发布' ? row.status : '待发布',
          human_reviewed: Boolean(row.human_review_required),
        });
        row.human_reviewed_at = row.human_review_required ? new Date().toISOString() : row.human_reviewed_at;
      }
      return true;
    } catch (err: any) {
      MessagePlugin.error(`状态更新失败：${err?.response?.data?.detail || err?.message || '未知错误'}`);
      return false;
    }
  };

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Tag theme='primary' variant='light'>
            内容生成
          </Tag>
          <Tag theme='success' variant='light'>
            统一文章库
          </Tag>
        </div>
        <div className={Style.heroTitle}>文章库</div>
        <div className={Style.heroDesc}>自动流程和“文章生成NEW”产生的文章统一入库；在这里查看、编辑、发布和删除。</div>
      </Card>

      <Card bordered={false} className={Style.sectionCard}>
        <div className={Style.toolbarRow}>
          <Select
            value={selectedLeadId}
            options={leadOptions}
            filterable
            clearable
            placeholder='按客户筛选，默认全部'
            style={{ width: 280 }}
            onChange={(value) => {
              const nextLeadId = String(value || '');
              setSelectedLeadId(nextLeadId);
              fetchData(nextLeadId);
            }}
          />
          <Input
            value={keyword}
            placeholder='搜索标题 / 品牌 / 域名 / 状态'
            style={{ width: 280 }}
            onChange={(value) => setKeyword(String(value || ''))}
          />
          <div style={{ flex: 1 }} />
          {urlPromptId ? (
            <Tag theme='primary' variant='light' closable onClose={() => navigate('/content-generation/articles')}>
              已按 Prompt 筛选
            </Tag>
          ) : null}
          <Tag theme='success' variant='light'>
            当前文章：{filteredRows.length} 篇
          </Tag>
          <Button icon={<RefreshIcon />} loading={loading} onClick={() => fetchData()}>
            刷新
          </Button>
        </div>
      </Card>

      <Card bordered={false} className={Style.sectionCard} title='已入库文章'>
        <div className={Style.articleLibraryTable}>
          <Table
            loading={loading}
            rowKey='id'
            data={filteredRows}
            columns={[
              {
                colKey: 'title',
                title: '文章标题',
                minWidth: 320,
                cell: ({ row }) => (
                  <div>
                    <div className={Style.itemTitle}>{row.title}</div>
                    <div className={Style.mutedText} style={{ marginTop: 4 }}>
                      {row.brand || '未关联品牌'} {row.domain ? `· ${row.domain}` : ''}{' '}
                      {row.keyword ? `· ${row.keyword}` : ''}
                    </div>
                    <div className={Style.mutedText} style={{ marginTop: 6 }}>
                      来源问题：
                      {row.source_prompt_text ? (
                        <>
                          <Tag theme='primary' variant='light'>
                            {row.source_prompt_keyword || 'Prompt'}
                          </Tag>{' '}
                          {row.source_prompt_text}
                        </>
                      ) : (
                        <Tag variant='light'>未关联 Prompt</Tag>
                      )}
                    </div>
                    {row.source_prompt_intent || row.source_prompt_scenario ? (
                      <div className={Style.mutedText} style={{ marginTop: 4 }}>
                        {row.source_prompt_intent ? `意图：${row.source_prompt_intent}` : ''}
                        {row.source_prompt_intent && row.source_prompt_scenario ? ' · ' : ''}
                        {row.source_prompt_scenario ? `场景：${row.source_prompt_scenario}` : ''}
                      </div>
                    ) : null}
                  </div>
                ),
              },
              {
                colKey: 'status',
                title: '状态',
                width: 110,
                cell: ({ row }) => (
                  <Tag theme={statusTheme(row.status)} variant='light'>
                    {row.status}
                  </Tag>
                ),
              },
              { colKey: 'channel', title: '渠道', width: 120 },
              {
                colKey: 'provider',
                title: '模型',
                width: 140,
                cell: ({ row }) => (row.model ? `${row.provider || ''}/${row.model}` : row.provider || '-'),
              },
              {
                colKey: 'created_at',
                title: '保存时间',
                width: 170,
                cell: ({ row }) => formatTime(row.created_at),
              },
              {
                colKey: 'actions',
                title: '操作',
                width: 320,
                fixed: 'right',
                cell: ({ row }) => (
                  <Space size={6} breakLine>
                    <Button
                      size='small'
                      variant='outline'
                      loading={detailLoadingId === row.id}
                      onClick={() => openView(row)}
                    >
                      查看
                    </Button>
                    <Button
                      size='small'
                      variant='outline'
                      disabled={!row.source_prompt_id}
                      onClick={() => navigate(`/keyword-system/prompt-inventory?prompt_id=${row.source_prompt_id}`)}
                    >
                      原 Prompt
                    </Button>
                    <Button
                      size='small'
                      variant='outline'
                      icon={<EditIcon />}
                      loading={detailLoadingId === row.id}
                      onClick={() => openEdit(row)}
                    >
                      编辑
                    </Button>
                    <Button
                      size='small'
                      variant='outline'
                      icon={<DownloadIcon />}
                      loading={exportingId === row.id}
                      onClick={() => exportDocx(row)}
                    >
                      导出
                    </Button>
                    <ArticleDistributionButton article={row} onBeforeCreate={() => markReadyBeforePublish(row)} />
                    <OwnedAccountPublishButton article={row} onBeforeCreate={() => markReadyBeforePublish(row)} />
                    <Popconfirm content='确认删除这篇文章？' onConfirm={() => deleteDraft(row)}>
                      <Button size='small' variant='text' theme='danger' icon={<DeleteIcon />} loading={saving}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </div>
      </Card>

      <Dialog
        header={viewing?.title || '文章内容'}
        visible={Boolean(viewing)}
        footer={false}
        width={1080}
        onClose={() => setViewing(null)}
      >
        {viewing ? (
          <div style={{ marginBottom: 12, color: 'var(--td-text-color-secondary)', lineHeight: 1.8 }}>
            来源问题：{viewing.source_prompt_text || '未关联 Prompt'}
            {viewing.source_prompt_keyword ? ` · 关键词：${viewing.source_prompt_keyword}` : ''}
          </div>
        ) : null}
        <div className={Style.articleDialogPreview}>
          {viewing ? renderArticlePreview(viewing.body || '', previewImageUrls) : null}
        </div>
      </Dialog>

      <Dialog
        header={editing ? `编辑文章：${editing.title}` : '编辑文章'}
        visible={Boolean(editing)}
        width={900}
        confirmBtn={{ content: '保存', loading: saving }}
        onConfirm={saveEdit}
        onCancel={() => setEditing(null)}
        onClose={() => setEditing(null)}
      >
        <Space direction='vertical' style={{ width: '100%' }}>
          <Input value={editTitle} placeholder='文章标题' onChange={(value) => setEditTitle(String(value || ''))} />
          <Textarea
            value={editBody}
            placeholder='文章正文'
            autosize={{ minRows: 18, maxRows: 28 }}
            onChange={(value) => setEditBody(String(value || ''))}
          />
        </Space>
      </Dialog>
    </div>
  );
};

export default ArticleLibrary;
