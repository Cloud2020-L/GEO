import { decodeStoredPublishText } from './publishText';

const normalizeTitle = (value: unknown) =>
  decodeStoredPublishText(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

export const buildZhihuTitleFillBookmarklet = (rawTitle: unknown) => {
  const title = normalizeTitle(rawTitle);
  const script = `
(() => {
  const title = ${JSON.stringify(title)};
  if (!title) {
    alert('没有可填入的标题');
    return;
  }
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 40 && rect.height > 16 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (el) =>
    [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('title'), el.className, el.textContent]
      .filter(Boolean)
      .join(' ');
  const candidates = Array.from(
    document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[placeholder*="标题"]'),
  ).filter(visible);
  const scored = candidates
    .map((el) => {
      const text = textOf(el);
      const rect = el.getBoundingClientRect();
      let score = 0;
      if (/标题|title/i.test(text)) score += 80;
      if (/请输入标题|最多100个字|写文章/i.test(text)) score += 80;
      if (rect.top < window.innerHeight * 0.45) score += 20;
      if (rect.height > 32) score += 10;
      if (rect.width > 300) score += 10;
      return { el, score };
    })
    .sort((a, b) => b.score - a.score);
  const target = scored[0]?.el;
  if (!target || scored[0].score < 40) {
    alert('没有找到知乎标题栏，请先确认当前页面是知乎写文章编辑页');
    return;
  }
  target.scrollIntoView({ block: 'center' });
  target.focus();
  const setNativeValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
  };
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    setNativeValue(target, title);
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('insertText', false, title);
    if (!String(target.textContent || '').includes(title)) {
      target.textContent = title;
    }
  }
  ['beforeinput', 'input', 'change', 'keyup', 'blur'].forEach((type) => {
    target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  });
  setTimeout(() => target.focus(), 80);
  alert('知乎标题已填入，请检查后继续导入正文');
})();
`;
  return `javascript:${encodeURIComponent(script)}`;
};

export const zhihuAssistantHelpText =
  '复制后到知乎写文章页，将浏览器地址栏内容替换为该助手并回车。它只会扫描并填写标题栏，不会自动点击发布。';
