let clearTimer = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'offscreen:clipboardWrite') {
    clipboardWrite(String(msg.text ?? ''))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }
  if (msg?.type === 'offscreen:clearAfter') {
    // 在 offscreen 文档内计时并清空；offscreen 不受 service worker 约 30 秒空闲回收影响，
    // 故 SW 即便被终止，到点仍会执行清空。新的复制会重置该计时器。
    if (clearTimer) clearTimeout(clearTimer);
    const delay = Math.max(Number(msg.delayMs) || 0, 0);
    clearTimer = setTimeout(() => {
      clearTimer = null;
      clipboardWrite('').catch(() => {});
    }, delay);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

async function clipboardWrite(text) {
  // 优先用异步 Clipboard API（新版 Chrome 的 offscreen 文档可用）。
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // offscreen 文档无焦点时 writeText 会抛 "Document is not focused"，
    // 退回 execCommand('copy')（textarea 选区复制，不依赖焦点）。
  }
  if (execCommandCopy(text)) return;
  // 清空场景下空选区可能复制失败，用单个空格兜底覆盖掉敏感内容。
  if (text === '' && execCommandCopy(' ')) return;
  throw new Error('execCommand copy failed');
}

function execCommandCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
