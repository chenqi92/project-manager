chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'offscreen:clipboardWrite') return false;
  clipboardWrite(String(msg.text ?? ''))
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
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
