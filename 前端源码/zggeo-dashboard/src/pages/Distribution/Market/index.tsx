import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Dialog,
  Form,
  Input,
  Loading,
  MessagePlugin,
  Pagination,
  Row,
  Space,
  Tag,
  Textarea,
} from 'tdesign-react';
import {
  checkMediaMarketTitle,
  createMediaMarketOrder,
  getManagedImageDb,
  listMediaMarketFilters,
  searchMediaMarket,
  uploadMediaMarketImage,
  type MediaMarketFilterGroup,
  type MediaMarketPagination,
  type MediaMarketRow,
} from 'services/zggeo-api';
import { loadProtectedImageUrl } from 'utils/contentImageStore';
import {
  clearMediaMarketDraft,
  readMediaMarketDraft,
  saveMediaMarketDraft,
  type MediaMarketDistributionDraft,
} from 'utils/mediaMarketDraft';
import {
  buildMediaMarketEditableContent,
  formatMediaMarketImageSize,
  getUnknownMediaMarketPlaceholders,
  getUsedMediaMarketImages,
  previewMediaMarketHtml,
  prepareMediaMarketContent,
  sanitizeMediaMarketPreviewHtml,
  type MediaMarketImageAsset,
} from 'utils/mediaMarketContent';
import Style from './index.module.less';

/**
 * L6 分发执行 · 媒体市场
 *
 * 对接媒介集市（meijiejishi.com）新闻发稿 API（只读阶段）：
 *   - GET /media-market/filters → 9 组筛选字典
 *   - GET /media-market/media   → 媒体搜索（分页）
 *   - POST /media-market/title-check → 标题查重
 *   - POST /media-market/orders      → 创建媒介集市真实投稿订单
 */

const PAGE_SIZE = 20;
const { FormItem } = Form;
const CONTENT_IMAGE_FILE_RE = /\/content\/images\/files\/([^/?#]+)/i;

const formatCents = (value?: number | null) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  return `￥${(Number(value) / 100).toFixed(2)}`;
};

const formatCredits = (value?: number | null) => {
  const credits = Number(value || 0);
  return credits > 0 ? `${credits.toLocaleString('zh-CN')} 点` : '-';
};

interface PostFormState {
  title: string;
  content: string;
  link: string;
  remark: string;
  confirm: boolean;
}

const emptyPostForm: PostFormState = {
  title: '',
  content: '',
  link: '',
  remark: '',
  confirm: false,
};

const buildPostFormFromDraft = (
  item?: MediaMarketRow | null,
  draftOverride?: MediaMarketDistributionDraft | null,
  editableOverride?: ReturnType<typeof buildMediaMarketEditableContent>,
): PostFormState => {
  const draft = draftOverride || readMediaMarketDraft();
  const editable =
    editableOverride ||
    buildMediaMarketEditableContent(draft?.display_content || draft?.content || '', draft?.images || []);
  return {
    ...emptyPostForm,
    title: draft?.title || '',
    content: editable.displayContent,
    link: draft?.link || '',
    remark: item?.mediaRemark ? `媒体备注：${item.mediaRemark}` : '',
  };
};

const hasDraftContent = (draft?: MediaMarketDistributionDraft | null) =>
  Boolean(String(draft?.title || '').trim() || String(draft?.content || '').trim());

const hasPostFormArticle = (form: PostFormState) =>
  Boolean(String(form.title || '').trim() && String(form.content || '').trim());

const normalizeFileUrl = (url: unknown) => {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^(https?:|blob:|data:|\/)/i.test(value)) return value;
  return `/api/zggeo${value.startsWith('/') ? value : `/${value}`}`;
};

const isProtectedImageSource = (src: unknown) => {
  const value = String(src || '').trim();
  return value.startsWith('zggeo-image://') || CONTENT_IMAGE_FILE_RE.test(value);
};

const splitPostContentBlocks = (content: string) =>
  String(content || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

const normalizeRouteDraft = (value: unknown): MediaMarketDistributionDraft | null => {
  const draft = value as Partial<MediaMarketDistributionDraft> | undefined;
  if (!draft || (!draft.title && !draft.content)) return null;
  return {
    draft_id: draft.draft_id,
    title: String(draft.title || '').trim(),
    content: String(draft.content || '').trim(),
    display_content: String(draft.display_content || draft.content || '').trim(),
    content_format: draft.content_format || 'markdown',
    images: draft.images || [],
    link: draft.link,
    source: draft.source || 'article_generation',
    updated_at: draft.updated_at || new Date().toISOString(),
  };
};

/** 把 filters 状态（{ key: Set<code> }）折成后端要的 dictCode 逗号串 */
function buildDictCode(filters: Record<string, Set<string>>): string {
  const all: string[] = [];
  Object.values(filters).forEach((set) => set.forEach((code) => all.push(code)));
  return all.join(',');
}

const Market: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const routeDraft = useMemo(
    () => normalizeRouteDraft((location.state as { mediaMarketDraft?: unknown } | null)?.mediaMarketDraft),
    [location.state],
  );
  // 远端筛选字典
  const [groups, setGroups] = useState<MediaMarketFilterGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string>('');

  // 用户选中的筛选（key=dictValue，value=已选 dictCode 集合）
  const [filters, setFilters] = useState<Record<string, Set<string>>>({});
  const [keyword, setKeyword] = useState('');
  const [pendingKeyword, setPendingKeyword] = useState('');

  // 媒体列表
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [resp, setResp] = useState<MediaMarketPagination<MediaMarketRow> | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string>('');

  // 投稿下单
  const [postMedia, setPostMedia] = useState<MediaMarketRow | null>(null);
  const [postForm, setPostForm] = useState<PostFormState>(emptyPostForm);
  const [postImages, setPostImages] = useState<MediaMarketImageAsset[]>([]);
  const [postDraft, setPostDraft] = useState<MediaMarketDistributionDraft | null>(null);
  const postDraftRef = useRef<MediaMarketDistributionDraft | null>(null);
  const postImagesRef = useRef<MediaMarketImageAsset[]>([]);
  const currentDraftRef = useRef<MediaMarketDistributionDraft | null>(null);
  const [postDialogKey, setPostDialogKey] = useState(0);
  const [posting, setPosting] = useState(false);
  const [previewImage, setPreviewImage] = useState<MediaMarketImageAsset | null>(null);
  const [currentDraft, setCurrentDraft] = useState<MediaMarketDistributionDraft | null>(
    () => routeDraft || readMediaMarketDraft(),
  );

  const refreshCurrentDraft = useCallback(() => {
    const draft = readMediaMarketDraft();
    currentDraftRef.current = draft;
    setCurrentDraft(draft);
    return draft;
  }, []);

  // ----- 加载 9 组筛选 -----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setGroupsLoading(true);
      setGroupsError('');
      try {
        const data = await listMediaMarketFilters();
        if (!cancelled) setGroups(data.groups || []);
      } catch (err: any) {
        if (!cancelled) {
          const detail = err?.response?.data?.detail;
          setGroupsError(detail?.mess || err?.message || '筛选字典拉取失败');
        }
      } finally {
        if (!cancelled) setGroupsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ----- 加载媒体列表 -----
  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError('');
    try {
      const data = await searchMediaMarket({
        page,
        size: pageSize,
        dictCode: buildDictCode(filters),
        condition: keyword,
      });
      setResp(data);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setListError(detail?.mess || err?.message || '媒体列表拉取失败');
      setResp(null);
    } finally {
      setListLoading(false);
    }
  }, [filters, keyword, page, pageSize]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    refreshCurrentDraft();
    const onFocus = () => refreshCurrentDraft();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshCurrentDraft]);

  useEffect(() => {
    currentDraftRef.current = currentDraft;
  }, [currentDraft]);

  useEffect(() => {
    if (!routeDraft) return;
    saveMediaMarketDraft(routeDraft);
    currentDraftRef.current = routeDraft;
    setCurrentDraft(routeDraft);
    MessagePlugin.success('已从文章生成带入投稿文章，选择媒体后会自动填入投稿表单');
  }, [routeDraft]);

  const toggleFilterOption = (groupKey: string, optCode: string, multiple: boolean) => {
    setPage(1);
    setFilters((prev) => {
      const cur = new Set(prev[groupKey] || []);
      if (cur.has(optCode)) {
        cur.delete(optCode);
      } else {
        if (!multiple) cur.clear();
        cur.add(optCode);
      }
      return { ...prev, [groupKey]: cur };
    });
  };

  const resetFilters = () => {
    setFilters({});
    setKeyword('');
    setPendingKeyword('');
    setPage(1);
  };

  const triggerSearch = () => {
    setKeyword(pendingKeyword.trim());
    setPage(1);
  };

  const savePostDraftState = useCallback(
    (form: PostFormState, images: MediaMarketImageAsset[]) => {
      const nextDraft: MediaMarketDistributionDraft = {
        draft_id: postDraftRef.current?.draft_id || postDraft?.draft_id,
        title: form.title,
        content: form.content,
        display_content: form.content,
        content_format: 'markdown',
        images,
        link: form.link,
        source: postDraftRef.current?.source || postDraft?.source || 'media_market_form',
        updated_at: new Date().toISOString(),
      };
      postDraftRef.current = nextDraft;
      postImagesRef.current = images;
      setPostDraft(nextDraft);
      saveMediaMarketDraft(nextDraft);
      refreshCurrentDraft();
    },
    [postDraft, refreshCurrentDraft],
  );

  const resolvePostImageAssets = useCallback(
    async (form: PostFormState, images: MediaMarketImageAsset[]) => {
      if (!images.some((image) => isProtectedImageSource(image.src))) return;
      const resolvedImages = await Promise.all(
        images.map(async (image) => {
          const source = String(image.src || '').trim();
          if (!isProtectedImageSource(source)) return image;
          try {
            let fileUrl = source;
            let mime = image.mime;
            if (source.startsWith('zggeo-image://')) {
              const imageId = source.replace('zggeo-image://', '').trim();
              const row = await getManagedImageDb(imageId);
              fileUrl = normalizeFileUrl(row.file_url);
              mime = row.mime_type || mime;
            }
            const previewUrl = await loadProtectedImageUrl(normalizeFileUrl(fileUrl));
            if (!previewUrl) return image;
            const format =
              mime && mime !== 'image/*' ? mime.split('/')[1]?.toUpperCase() || image.format : image.format;
            return {
              ...image,
              src: previewUrl,
              mime,
              format,
              uploadRequired: true,
              status: 'local' as const,
              uploaded_url: undefined,
              error: undefined,
            };
          } catch {
            return {
              ...image,
              status: 'failed' as const,
              error: '图片预览加载失败，请回到素材库确认图片权限',
            };
          }
        }),
      );
      postImagesRef.current = resolvedImages;
      setPostImages(resolvedImages);
      savePostDraftState(form, resolvedImages);
    },
    [savePostDraftState],
  );

  const openPostDialog = (item: MediaMarketRow) => {
    const draft = readMediaMarketDraft() || currentDraftRef.current || currentDraft;
    if (!hasDraftContent(draft)) {
      MessagePlugin.warning('当前没有待投稿文章，可返回文章生成选择“分发”，也可以在弹窗中手动填写');
    }
    const editable = buildMediaMarketEditableContent(
      draft?.display_content || draft?.content || '',
      draft?.images || [],
    );
    const nextForm = buildPostFormFromDraft(item, draft, editable);
    const nextImages = editable.images;
    postDraftRef.current = draft || null;
    postImagesRef.current = nextImages;
    setPostDraft(draft || null);
    setCurrentDraft(draft || null);
    setPostForm(nextForm);
    setPostImages(nextImages);
    setPostMedia(item);
    setPostDialogKey((key) => key + 1);
    resolvePostImageAssets(nextForm, nextImages).catch(() => undefined);
  };

  const updatePostArticleField = (patch: Partial<Pick<PostFormState, 'title' | 'content' | 'link'>>) => {
    setPostForm((prev) => {
      const next = { ...prev, ...patch };
      let nextImages = postImagesRef.current;
      if (patch.content && /data:image\/|!\[[^\]]*\]\([^)]+\)|<img\b/i.test(patch.content)) {
        const editable = buildMediaMarketEditableContent(patch.content, nextImages);
        next.content = editable.displayContent;
        nextImages = editable.images;
        setPostImages(nextImages);
      }
      savePostDraftState(next, nextImages);
      return next;
    });
  };

  const handleClearDraft = () => {
    clearMediaMarketDraft();
    setCurrentDraft(null);
    setPostDraft(null);
    postDraftRef.current = null;
    postImagesRef.current = [];
    setPostImages([]);
    setPostForm((prev) => ({ ...prev, title: '', content: '', link: '' }));
    MessagePlugin.success('已清除当前待投稿文章');
  };

  const submitPostOrder = async () => {
    if (!postMedia?.mediaId) {
      MessagePlugin.warning('当前媒体缺少 mediaId，不能投稿');
      return;
    }
    const mediaId = String(postMedia.mediaId);
    const title = postForm.title.trim();
    const content = postForm.content.trim();
    const link = postForm.link.trim();
    if (!title) {
      MessagePlugin.warning('请填写文章标题');
      return;
    }
    if (!content) {
      MessagePlugin.warning('请填写文章正文');
      return;
    }
    if (link && !/^https?:\/\//i.test(link)) {
      MessagePlugin.warning('原文链接必须以 http:// 或 https:// 开头');
      return;
    }
    if (!postForm.confirm) {
      MessagePlugin.warning('请先勾选确认，媒介集市投稿会创建真实订单');
      return;
    }
    if (!postMedia.quoteToken) {
      MessagePlugin.warning('当前媒体缺少点数报价，请刷新媒体列表后重试');
      return;
    }

    setPosting(true);
    try {
      const check = await checkMediaMarketTitle({ title, media_ids: [mediaId] });
      if (check.duplicated) {
        MessagePlugin.error('该标题在所选媒体中已存在，请修改标题后再投稿');
        return;
      }

      const prepared = await prepareMediaMarketContent(content, postImagesRef.current, async (file) => {
        const uploaded = await uploadMediaMarketImage(file);
        if (!uploaded.url) throw new Error('图片上传成功但未返回图片地址');
        return uploaded.url;
      });
      postImagesRef.current = prepared.images;
      setPostImages(prepared.images);
      if (!prepared.html) {
        MessagePlugin.warning('文章正文转换后为空，请检查正文内容');
        return;
      }

      const result = await createMediaMarketOrder({
        title,
        content: prepared.html,
        link,
        remark: postForm.remark,
        media_ids: [mediaId],
        media_quote_tokens: [postMedia.quoteToken],
        confirm: true,
      });
      const order = result.orders?.[0];
      MessagePlugin.success(
        order?.popOutTradeNo
          ? `投稿订单已创建：${order.popOutTradeNo}`
          : '投稿订单已创建，可到发布记录查看媒介集市订单',
      );
      if (prepared.uploadedCount > 0) {
        MessagePlugin.success(`已上传并替换 ${prepared.uploadedCount} 张正文图片`);
      }
      setPostMedia(null);
      setPostDraft(null);
      postImagesRef.current = [];
      setPostImages([]);
      setPostForm(buildPostFormFromDraft(null, currentDraft));
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      const message = detail?.mess || err?.message || '投稿订单创建失败';
      setPostImages((prev) => {
        const nextImages = prev.map((image) =>
          image.uploadRequired && content.includes(image.placeholder)
            ? { ...image, status: 'failed' as const, error: message }
            : image,
        );
        postImagesRef.current = nextImages;
        return nextImages;
      });
      MessagePlugin.error(message);
    } finally {
      setPosting(false);
    }
  };

  const selectedCount = useMemo(() => Object.values(filters).reduce((a, s) => a + s.size, 0), [filters]);
  const postPreviewHtml = useMemo(
    () => sanitizeMediaMarketPreviewHtml(previewMediaMarketHtml(postForm.content, postImages)),
    [postForm.content, postImages],
  );
  const usedPostImages = useMemo(
    () => getUsedMediaMarketImages(postForm.content, postImages),
    [postForm.content, postImages],
  );
  const unknownPostPlaceholders = useMemo(
    () => getUnknownMediaMarketPlaceholders(postForm.content, postImages),
    [postForm.content, postImages],
  );
  const uploadRequiredCount = useMemo(
    () => usedPostImages.filter((image) => image.uploadRequired && image.status !== 'uploaded').length,
    [usedPostImages],
  );
  const removePostImage = (image: MediaMarketImageAsset) => {
    const nextContent = postForm.content
      .replace(image.placeholder, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const nextImages = postImages.filter((item) => item.id !== image.id);
    const nextForm = { ...postForm, content: nextContent };
    postImagesRef.current = nextImages;
    setPostImages(nextImages);
    setPostForm(nextForm);
    setPostDialogKey((key) => key + 1);
    savePostDraftState(nextForm, nextImages);
  };

  const findPostContentTextarea = () => {
    if (typeof document === 'undefined') return null;
    return (
      document.querySelector<HTMLTextAreaElement>(`.${Style.postContentTextarea} textarea`) ||
      document.querySelector<HTMLTextAreaElement>(`textarea.${Style.postContentTextarea}`) ||
      document.querySelector<HTMLTextAreaElement>('textarea')
    );
  };

  const updatePostContentWithImages = (nextContent: string, nextImages = postImages) => {
    const nextForm = { ...postForm, content: nextContent };
    const contentInput = findPostContentTextarea();
    if (contentInput && contentInput.value !== nextContent) {
      contentInput.value = nextContent;
      contentInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    postImagesRef.current = nextImages;
    setPostImages(nextImages);
    setPostForm(nextForm);
    savePostDraftState(nextForm, nextImages);
  };

  const readCurrentPostContent = () => {
    const contentInput = findPostContentTextarea();
    return contentInput?.value ?? postForm.content;
  };

  const insertPostImage = (image: MediaMarketImageAsset, placement: 'top' | 'bottom') => {
    const blocks = splitPostContentBlocks(readCurrentPostContent()).filter(
      (block) => !block.includes(image.placeholder),
    );
    const nextBlocks = placement === 'top' ? [image.placeholder, ...blocks] : [...blocks, image.placeholder];
    updatePostContentWithImages(nextBlocks.join('\n\n'));
    MessagePlugin.success(placement === 'top' ? '图片已放到正文开头' : '图片已放到正文末尾');
  };

  const movePostImage = (image: MediaMarketImageAsset, action: 'up' | 'down' | 'top' | 'bottom') => {
    const blocks = splitPostContentBlocks(readCurrentPostContent());
    const currentIndex = blocks.findIndex((block) => block.includes(image.placeholder));
    if (currentIndex < 0) {
      insertPostImage(image, action === 'top' || action === 'up' ? 'top' : 'bottom');
      return;
    }
    const block = blocks[currentIndex];
    const remainingBlocks = blocks.filter((item) => !item.includes(image.placeholder));
    const targetIndex =
      action === 'top'
        ? 0
        : action === 'bottom'
        ? remainingBlocks.length
        : action === 'up'
        ? Math.max(0, currentIndex - 1)
        : Math.min(remainingBlocks.length, currentIndex + 1);
    remainingBlocks.splice(targetIndex, 0, block);
    updatePostContentWithImages(remainingBlocks.join('\n\n'));
    MessagePlugin.success('图片位置已调整');
  };

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard}>
        <Space direction='vertical' size={8}>
          <Space>
            <Tag theme='primary' variant='light'>
              媒体市场
            </Tag>
            <Tag theme='success' variant='light'>
              对接：媒介集市 meijiejishi.com
            </Tag>
            <Tag theme='warning' variant='light'>
              真实下单：需二次确认
            </Tag>
          </Space>
          <div className={Style.heroTitle}>网站媒体发稿市场</div>
          <div className={Style.heroDesc}>
            只读阶段：9 组筛选字典、媒体库分页、价格/权重/出稿速度/收录情况全部来自媒介集市实时数据。
            投稿会调用媒介集市真实创建订单，提交前会做标题查重和费用确认。
          </div>
        </Space>
      </Card>

      <Card bordered={false} className={Style.draftCard}>
        {currentDraft ? (
          <div className={Style.draftBar}>
            <div className={Style.draftInfo}>
              <Tag theme='success' variant='light'>
                当前待投稿文章
              </Tag>
              <span className={Style.draftTitle}>{currentDraft.title || '未命名文章'}</span>
              <span className={Style.draftMeta}>
                {currentDraft.updated_at ? `已暂存：${new Date(currentDraft.updated_at).toLocaleString()}` : ''}
              </span>
            </div>
            <Space size={8}>
              <Button size='small' variant='outline' onClick={() => navigate('/content-generation/articles-new')}>
                更换文章
              </Button>
              <Button size='small' variant='text' theme='danger' onClick={handleClearDraft}>
                清除
              </Button>
            </Space>
          </div>
        ) : (
          <div className={Style.draftBar}>
            <div className={Style.draftInfo}>
              <Tag theme='warning' variant='light'>
                未选择文章
              </Tag>
              <span className={Style.draftMeta}>
                从“文章生成 NEW”点击“分发”后，投稿弹窗会自动带入标题和正文；也可以直接手动填写。
              </span>
            </div>
            <Button size='small' variant='outline' onClick={() => navigate('/content-generation/articles-new')}>
              去选择文章
            </Button>
          </div>
        )}
      </Card>

      {groupsError && (
        <Alert
          className={Style.darkAlert}
          theme='error'
          message={`筛选字典加载失败：${groupsError}`}
          operation={
            <Button variant='text' onClick={() => window.location.reload()}>
              重试
            </Button>
          }
        />
      )}

      <Card bordered={false} className={Style.filterCard}>
        {groupsLoading && <Loading loading size='small' text='加载筛选条件中...' />}

        {!groupsLoading && groups.length === 0 && !groupsError && (
          <div className={Style.filterHint}>筛选字典为空，请确认 codex `.env` 里的 MEDIA_MARKET_* 凭据是否已配置。</div>
        )}

        {groups.map((group) => {
          const selectedInGroup = filters[group.key] || new Set<string>();
          return (
            <div key={group.key} className={Style.groupRow}>
              <div className={Style.groupTitle}>
                {group.label}
                {group.multiple && <span className={Style.groupHint}>多选</span>}：
              </div>
              <Space size={8} style={{ flexWrap: 'wrap' }}>
                <Tag
                  theme={selectedInGroup.size === 0 ? 'primary' : 'default'}
                  variant={selectedInGroup.size === 0 ? 'light' : 'outline'}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setPage(1);
                    setFilters((prev) => ({ ...prev, [group.key]: new Set() }));
                  }}
                >
                  不限
                </Tag>
                {group.options.map((opt) => {
                  const selected = selectedInGroup.has(opt.code);
                  return (
                    <Tag
                      key={opt.code}
                      theme={selected ? 'primary' : 'default'}
                      variant={selected ? 'light' : 'outline'}
                      style={{ cursor: 'pointer' }}
                      onClick={() => toggleFilterOption(group.key, opt.code, group.multiple)}
                    >
                      {opt.label}
                    </Tag>
                  );
                })}
              </Space>
            </div>
          );
        })}

        <Space className={Style.searchRow} style={{ flexWrap: 'wrap' }}>
          <Input
            style={{ width: 320 }}
            value={pendingKeyword}
            onChange={(v) => setPendingKeyword(String(v))}
            onEnter={triggerSearch}
            placeholder='请输入媒体名称或链接，如：新浪、财经、sina.com.cn'
            clearable
          />
          <Button theme='primary' onClick={triggerSearch}>
            搜索
          </Button>
          <Button variant='outline' onClick={resetFilters}>
            重置
          </Button>
          {selectedCount > 0 && <span className={Style.selectedCount}>已选 {selectedCount} 个筛选项</span>}
        </Space>
      </Card>

      {listError && (
        <Alert
          className={Style.darkAlert}
          theme='error'
          message={`媒体列表加载失败：${listError}`}
          operation={
            <Button variant='text' onClick={loadList}>
              重试
            </Button>
          }
        />
      )}

      <Loading loading={listLoading} text='查询媒介集市...'>
        <div className={Style.list}>
          {(resp?.content || []).map((item) => (
            <MediaCard key={String(item.mediaId ?? item.mediaName)} item={item} onPost={openPostDialog} />
          ))}
          {!listLoading && !listError && (resp?.content?.length ?? 0) === 0 && (
            <Card bordered={false} className={Style.emptyCard}>
              <div className={Style.emptyState}>没有匹配的媒体，调整筛选或重置试试。</div>
            </Card>
          )}
        </div>
      </Loading>

      {(resp?.totalElements ?? 0) > 0 && (
        <div className={Style.paginationWrap}>
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

      <Dialog
        key={`${postMedia?.mediaId || 'post'}-${postDialogKey}-${postForm.title}-${postForm.content.length}`}
        visible={!!postMedia}
        header={`投稿到：${postMedia?.mediaName || ''}`}
        width={760}
        onClose={() => {
          if (!posting) {
            setPostMedia(null);
            setPostDraft(null);
            postDraftRef.current = null;
            postImagesRef.current = [];
            setPostImages([]);
            setPostForm(emptyPostForm);
          }
        }}
        confirmBtn={
          <Button theme='primary' loading={posting} onClick={submitPostOrder}>
            确认投稿下单
          </Button>
        }
      >
        <Form
          key={`${postDialogKey}-${postForm.title}-${postForm.content.length}`}
          layout='vertical'
          initialData={postForm}
          onValuesChange={(_, allValues) => {
            setPostForm((prev) => ({ ...prev, ...allValues }));
          }}
        >
          <div className={Style.orderNotice}>
            <b>真实订单确认：</b>
            本次投稿将消耗 {formatCredits(postMedia?.chargeCredits)}，提交后点数不退还。
            {postMedia?.costAmountCents ? (
              <>
                {' '}
                成本价 {formatCents(postMedia.costAmountCents)}，加价后金额 {formatCents(postMedia.saleAmountCents)}。
              </>
            ) : null}
          </div>
          {hasPostFormArticle(postForm) && (
            <Alert
              theme='success'
              message={`已自动带入：${postForm.title || '未命名文章'}`}
              style={{ marginBottom: 12 }}
            />
          )}
          <FormItem name='title' label='文章标题' requiredMark>
            <Input
              value={postForm.title}
              maxlength={80}
              placeholder='请输入投稿标题'
              onChange={(v) => updatePostArticleField({ title: String(v) })}
            />
          </FormItem>
          <FormItem name='link' label='原文链接' help='选填；填写时必须以 http:// 或 https:// 开头'>
            <Input
              value={postForm.link}
              placeholder='选填，例如：https://example.com/news/article'
              onChange={(v) => updatePostArticleField({ link: String(v) })}
            />
          </FormItem>
          <FormItem
            name='content'
            label='文章正文（图片已折叠显示）'
            requiredMark
            help='正文框只编辑文字和图片占位符；图片文件在下方资产区管理，提交时按占位符顺序生成 UEditor HTML'
          >
            <Textarea
              className={Style.postContentTextarea}
              value={postForm.content}
              placeholder='请粘贴需要发布的文章正文'
              autosize={{ minRows: 8, maxRows: 14 }}
              onChange={(v) => updatePostArticleField({ content: String(v) })}
            />
          </FormItem>
          {unknownPostPlaceholders.length > 0 && (
            <Alert
              theme='warning'
              message='图片占位符已被修改，可能无法自动上传；请恢复占位符或移除对应图片。'
              style={{ marginBottom: 12 }}
            />
          )}
          <div className={Style.imageAssetPanel}>
            <div className={Style.contentPreviewHeader}>
              <span>图片资产</span>
              <Space size={6} style={{ flexWrap: 'wrap' }}>
                <Tag size='small' theme={postImages.length > 0 ? 'primary' : 'default'} variant='light'>
                  已识别 {postImages.length} 张图片
                </Tag>
                {uploadRequiredCount > 0 && (
                  <Tag size='small' theme='warning' variant='light'>
                    待上传 {uploadRequiredCount} 张
                  </Tag>
                )}
              </Space>
            </div>
            {postImages.length > 0 ? (
              <div className={Style.imageAssetGrid}>
                {postImages.map((image) => {
                  const inUse = usedPostImages.some((item) => item.id === image.id);
                  const statusText = !inUse
                    ? '未使用'
                    : image.status === 'uploaded'
                    ? '已上传'
                    : image.status === 'failed'
                    ? '上传失败'
                    : image.uploadRequired
                    ? '待上传'
                    : '无需上传';
                  return (
                    <div key={image.id} className={Style.imageAssetCard}>
                      <button
                        type='button'
                        className={Style.imageThumbWrap}
                        onClick={() => setPreviewImage(image)}
                        title='预览图片'
                      >
                        <img className={Style.imageThumb} src={image.uploaded_url || image.src} alt={image.alt} />
                      </button>
                      <div className={Style.imageAssetInfo}>
                        <div className={Style.imageAssetName} title={image.alt}>
                          {image.alt}
                        </div>
                        <div className={Style.imageAssetMeta}>
                          {image.format}
                          {image.size ? ` · ${formatMediaMarketImageSize(image.size)}` : ''}
                        </div>
                        <Space size={6} style={{ flexWrap: 'wrap' }}>
                          <Tag
                            size='small'
                            theme={
                              statusText === '上传失败' ? 'danger' : statusText === '待上传' ? 'warning' : 'success'
                            }
                            variant='light'
                          >
                            {statusText}
                          </Tag>
                        </Space>
                        <Space size={4} className={Style.imagePositionActions}>
                          {inUse ? (
                            <>
                              <button
                                type='button'
                                className={Style.imageActionButton}
                                onClick={() => movePostImage(image, 'top')}
                              >
                                置顶
                              </button>
                              <button
                                type='button'
                                className={Style.imageActionButton}
                                onClick={() => movePostImage(image, 'up')}
                              >
                                前移
                              </button>
                              <button
                                type='button'
                                className={Style.imageActionButton}
                                onClick={() => movePostImage(image, 'down')}
                              >
                                后移
                              </button>
                              <button
                                type='button'
                                className={Style.imageActionButton}
                                onClick={() => movePostImage(image, 'bottom')}
                              >
                                置底
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type='button'
                                className={Style.imageActionButton}
                                onClick={() => insertPostImage(image, 'top')}
                              >
                                插到开头
                              </button>
                              <button
                                type='button'
                                className={Style.imageActionButton}
                                onClick={() => insertPostImage(image, 'bottom')}
                              >
                                插到文末
                              </button>
                            </>
                          )}
                          <button
                            type='button'
                            className={`${Style.imageActionButton} ${Style.imageActionDanger}`}
                            onClick={() => removePostImage(image)}
                          >
                            移除
                          </button>
                        </Space>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={Style.imageAssetEmpty}>未识别到图片</div>
            )}
          </div>
          <div className={Style.contentPreviewPanel}>
            <div className={Style.contentPreviewHeader}>
              <span>正文预览</span>
              <Space size={6} style={{ flexWrap: 'wrap' }}>
                <Tag size='small' theme={usedPostImages.length > 0 ? 'primary' : 'default'} variant='light'>
                  当前使用 {usedPostImages.length} 张图片
                </Tag>
                {uploadRequiredCount > 0 && (
                  <Tag size='small' theme='warning' variant='light'>
                    待上传 {uploadRequiredCount} 张
                  </Tag>
                )}
              </Space>
            </div>
            <div
              className={Style.contentPreviewBody}
              dangerouslySetInnerHTML={{
                __html: postPreviewHtml || '<p>暂无正文预览</p>',
              }}
            />
          </div>
          <FormItem name='remark' label='备注'>
            <Textarea
              value={postForm.remark}
              placeholder='可填写发布要求、注意事项等'
              autosize={{ minRows: 2, maxRows: 5 }}
              onChange={(v) => setPostForm((prev) => ({ ...prev, remark: String(v) }))}
            />
          </FormItem>
          <Checkbox
            checked={postForm.confirm}
            onChange={(checked) => setPostForm((prev) => ({ ...prev, confirm: Boolean(checked) }))}
          >
            我确认标题、正文和媒体无误，并理解该操作会创建媒介集市真实投稿订单，提交后点数不退还
          </Checkbox>
        </Form>
      </Dialog>
      <Dialog
        visible={Boolean(previewImage)}
        header={previewImage?.alt || '图片预览'}
        footer={false}
        width={760}
        onClose={() => setPreviewImage(null)}
      >
        {previewImage ? (
          <div className={Style.imagePreviewDialog}>
            <img src={previewImage.uploaded_url || previewImage.src} alt={previewImage.alt} />
            {previewImage.error ? <Alert theme='error' message={previewImage.error} /> : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
};

// ------- 单条媒体卡片 -------

const MediaCard: React.FC<{ item: MediaMarketRow; onPost: (item: MediaMarketRow) => void }> = ({ item, onPost }) => {
  const rateText = item.manuscriptRateStr || (item.manuscriptRate != null ? `${item.manuscriptRate}%` : '-');
  const specials = item.special || [];
  const canPost = Boolean(item.mediaId && item.quoteToken && Number(item.chargeCredits || 0) > 0);

  return (
    <Card bordered={false} className={Style.mediaCard}>
      <Row gutter={[16, 16]} align='middle'>
        <Col xs={12} lg={5}>
          <Space direction='vertical' size={6} style={{ width: '100%' }}>
            <Space size={6} style={{ flexWrap: 'wrap' }}>
              <span className={Style.mediaName}>{item.mediaName || '未命名媒体'}</span>
              {item.isRecommend ? (
                <Tag theme='warning' size='small' variant='light'>
                  推荐
                </Tag>
              ) : null}
              {item.isPreferred ? (
                <Tag theme='success' size='small' variant='light'>
                  优选
                </Tag>
              ) : null}
            </Space>
            {item.mediaLink && (
              <a href={item.mediaLink} target='_blank' rel='noreferrer noopener' className={Style.mediaLink}>
                {item.mediaLink}
              </a>
            )}
            {item.mediaRemark && <div className={Style.mediaRemark}>{item.mediaRemark}</div>}
          </Space>
        </Col>
        <Col xs={6} lg={2}>
          <Metric title={item.portal || '-'} desc='综合门户' />
        </Col>
        <Col xs={6} lg={2}>
          <Metric title={item.channel || '-'} desc='频道类型' />
        </Col>
        <Col xs={6} lg={2}>
          <Metric title={item.region || '-'} desc='覆盖区域' />
        </Col>
        <Col xs={6} lg={2}>
          <Metric title={String(item.weighting ?? '-')} desc='权重' />
        </Col>
        <Col xs={6} lg={2}>
          <Metric title={item.speed || '-'} desc='出稿速度' />
        </Col>
        <Col xs={6} lg={2}>
          <Metric title={item.indexing || '-'} desc={`收录 · ${item.linkType || '-'}`} />
        </Col>
        <Col xs={6} lg={2}>
          <Metric title={rateText} desc='成稿率' />
        </Col>
        <Col xs={12} lg={2}>
          <Space direction='vertical' size={6} style={{ width: '100%' }}>
            <div className={Style.price}>{formatCredits(item.chargeCredits)}</div>
            {item.costAmountCents ? (
              <div className={Style.metricLabel}>
                成本 {formatCents(item.costAmountCents)}
                {item.grossProfitCents ? ` · 毛利 ${formatCents(item.grossProfitCents)}` : ''}
              </div>
            ) : null}
            <Button theme='primary' block disabled={!canPost} onClick={() => onPost(item)}>
              投稿
            </Button>
          </Space>
        </Col>
      </Row>
      {specials.length > 0 && (
        <div className={Style.specialRow}>
          <Space size={6} style={{ flexWrap: 'wrap' }}>
            <span className={Style.specialLabel}>特殊项目：</span>
            {specials.map((s) => (
              <Tag key={s} size='small' variant='outline' theme='warning'>
                {s}
              </Tag>
            ))}
          </Space>
        </div>
      )}
    </Card>
  );
};

const Metric: React.FC<{ title: string; desc: string }> = ({ title, desc }) => (
  <div>
    <div className={Style.metricValue} title={title}>
      {title}
    </div>
    <div className={Style.metricLabel}>{desc}</div>
  </div>
);

export default Market;
