/** 复制到剪贴板，并在若干秒后自动清空，缩短敏感信息的暴露窗口。 */
export async function copyWithAutoClear(
  text: string,
  clearMs = 25_000,
): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (clearMs > 0) {
    setTimeout(() => {
      navigator.clipboard.writeText('').catch(() => {});
    }, clearMs);
  }
}
