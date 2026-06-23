/** 复制到剪贴板，并在若干秒后自动清空，缩短敏感信息的暴露窗口。 */
export async function copyWithAutoClear(
  text: string,
  clearMs = 25_000,
): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (clearMs > 0) {
    setTimeout(clearClipboard, clearMs);
  }
}

/**
 * 清空剪贴板。页面失焦时 writeText('') 会被浏览器拒绝（document not focused），
 * 此时改为等下一次窗口获得焦点再补清一次，避免敏感内容被静默残留。
 * 注意：popup 关闭后页面上下文已销毁，定时器与监听都不再存活——那条路径需由
 * background 调度清空（见自动清空相关说明），本函数只覆盖常驻页面（options）。
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
