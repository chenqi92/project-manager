import { browser } from 'wxt/browser';

/** 复制到剪贴板，并在若干秒后自动清空，缩短敏感信息的暴露窗口。 */
export async function copyWithAutoClear(
  text: string,
  clearMs = 25_000,
): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (clearMs > 0) {
    try {
      await browser.runtime.sendMessage({ type: 'clipboard:clearLater', clearMs });
    } catch {
      setTimeout(clearClipboard, clearMs);
    }
  }
}

/**
 * 清空剪贴板。后台 offscreen 调度不可用时才使用这个兜底。页面失焦时
 * writeText('') 会被浏览器拒绝（document not focused），此时改为等下一次
 * 窗口获得焦点再补清一次，避免敏感内容被静默残留。
 */
function clearClipboard(): void {
  navigator.clipboard.writeText('').catch(() => {
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      navigator.clipboard.writeText('').catch(() => {});
    };
    window.addEventListener('focus', onFocus);
  });
}
