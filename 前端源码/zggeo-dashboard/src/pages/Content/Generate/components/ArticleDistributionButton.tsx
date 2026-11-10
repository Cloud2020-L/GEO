import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, MessagePlugin } from 'tdesign-react';
import { SendIcon } from 'tdesign-icons-react';
import { saveMediaMarketDraft } from 'utils/mediaMarketDraft';

const firstText = (...values: unknown[]) => String(values.find((value) => String(value || '').trim()) || '').trim();

const getArticleTitle = (article: Record<string, any>) =>
  firstText(article.draft_title, article.title, article.name, '未命名文章');

const getArticleBody = (article: Record<string, any>, bodyOverride?: string) =>
  firstText(bodyOverride, article.draft_body, article.body, article.content, article.article_body);

const checkDistributionCompliance = (article: Record<string, any>) => {
  const status = String(article.compliance_status || article.compliance?.status || '').trim();
  if (status === 'blocked') {
    MessagePlugin.error(
      String(article.compliance_summary || article.compliance?.summary || '文章发布审核未通过，不能分发'),
    );
    return false;
  }
  const humanReviewRequired = Boolean(article.human_review_required || article.compliance?.human_review_required);
  const humanReviewed = Boolean(article.human_reviewed_at || article.compliance?.human_reviewed);
  if (humanReviewRequired && !humanReviewed) {
    MessagePlugin.warning('该平台内容需要人工审核确认后再分发');
    return false;
  }
  return true;
};

interface ArticleDistributionButtonProps {
  article: Record<string, any>;
  bodyOverride?: string;
  disabled?: boolean;
  size?: 'small' | 'medium' | 'large';
  onBeforeCreate?: () => boolean | Promise<boolean>;
}

const ArticleDistributionButton: React.FC<ArticleDistributionButtonProps> = ({
  article,
  bodyOverride,
  disabled,
  size = 'small',
  onBeforeCreate,
}) => {
  const navigate = useNavigate();

  const jumpToMediaMarket = async () => {
    const ok = await onBeforeCreate?.();
    if (ok === false) return;

    const title = getArticleTitle(article);
    const content = getArticleBody(article, bodyOverride);
    if (!content) {
      MessagePlugin.warning('文章正文为空，不能分发到媒体市场');
      return;
    }
    if (!checkDistributionCompliance(article)) return;

    const draft = saveMediaMarketDraft({
      draft_id: String(article.id || article.draft_id || ''),
      title,
      content,
      source: 'article_generation',
    });
    MessagePlugin.success('已带入文章内容，去媒体市场选择媒体投稿');
    navigate('/distribution/market?prefill=article', {
      state: {
        fromArticleDistribution: true,
        mediaMarketDraft: draft,
      },
    });
  };

  return (
    <Button size={size} variant='outline' icon={<SendIcon />} disabled={disabled} onClick={jumpToMediaMarket}>
      分发
    </Button>
  );
};

export default ArticleDistributionButton;
