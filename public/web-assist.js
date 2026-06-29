// Web assist content script.
// Registered dynamically only after the user enables the feature and grants host access.
(() => {
  if (window.__PEM_WEB_ASSIST__) return;
  window.__PEM_WEB_ASSIST__ = true;

  let host = null;
  let root = null;
  let snapshot = null;
  let expanded = false;
  let dismissed = false;
  let capturePrompt = null;
  let captureMode = 'new';
  let selectedUpdateId = '';
  let captureDraft = null;
  let refreshTimer = 0;
  let lastSent = 0;
  let successCheckUntil = 0;
  let successTimer = 0;
  let lockedPrompt = false;
  let lockedCandidate = null;
  let unlockPoll = 0;
  let lastUnlockRetry = 0;

  const CHECK_DELAYS = [650, 1600, 3200, 6000];

  const send = (msg) =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!res) return reject(new Error('后台无响应'));
          if (!res.ok) return reject(new Error(res.error || '操作失败'));
          resolve(res.data);
        });
      } catch (e) {
        reject(e);
      }
    });

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const passwordFields = () =>
    Array.from(document.querySelectorAll('input[type="password"]')).filter(
      (el) => el.value !== undefined && visible(el),
    );

  const usernameFields = () =>
    Array.from(
      document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
      ),
    ).filter((el) => {
      if (el.type === 'password' || !visible(el)) return false;
      const text = [
        el.name,
        el.id,
        el.autocomplete,
        el.inputMode,
        el.placeholder,
        el.getAttribute('aria-label') || '',
      ]
        .join(' ')
        .toLowerCase();
      if (/(search|query|keyword|验证码|验证|code|otp|totp)/i.test(text)) return false;
      return (
        document.activeElement === el ||
        el.type === 'email' ||
        el.autocomplete === 'username' ||
        el.autocomplete === 'email' ||
        /(user|username|email|account|login|phone|mobile|apple.?id|账号|账户|邮箱|邮件|手机|电话|用户名)/i.test(text)
      );
    });

  const otpFields = () =>
    Array.from(document.querySelectorAll('input:not([type="password"]):not([type="hidden"])')).filter((el) => {
      if (!visible(el)) return false;
      const text = [
        el.name,
        el.id,
        el.autocomplete,
        el.inputMode,
        el.placeholder,
        el.getAttribute('aria-label') || '',
      ]
        .join(' ')
        .toLowerCase();
      return (
        el.autocomplete === 'one-time-code' ||
        /(otp|totp|mfa|2fa|code|token|verify|verification|auth|验证码|验证|动态码)/i.test(text)
      );
    });

  const hasSuccessHint = () =>
    Array.from(document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]'))
      .slice(0, 220)
      .some((el) => {
        if (!visible(el)) return false;
        const text = [
          el.textContent || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('href') || '',
          el.value || '',
        ]
          .join(' ')
          .toLowerCase();
        return /(logout|log out|signout|sign out|退出|注销|登出)/i.test(text);
      });

  const successSignals = () => {
    const pws = passwordFields();
    return {
      visiblePasswordFields: pws.length,
      filledPasswordFields: pws.filter((el) => el.value).length,
      visibleOtpFields: otpFields().length,
      successHint: hasSuccessHint(),
    };
  };

  const surfaceKind = () => {
    if (passwordFields().length > 0) return 'password';
    if (otpFields().length > 0) return 'otp';
    if (usernameFields().length > 0) return 'username';
    return 'none';
  };

  const preferredId = () => {
    try {
      return sessionStorage.getItem('pemAssistPreferredAccountId') || '';
    } catch {
      return '';
    }
  };

  const remember = (accountId) => {
    try {
      sessionStorage.setItem('pemAssistPreferredAccountId', accountId);
    } catch {
      /* ignore private/session storage failures */
    }
  };

  const sortMatches = (surface) => {
    if (!snapshot?.matches?.length) return;
    if (surface === 'otp') {
      snapshot.matches.sort((a, b) => (a.hasTotp === b.hasTotp ? 0 : a.hasTotp ? -1 : 1));
      return;
    }
    const preferred = preferredId();
    if (!preferred) return;
    snapshot.matches.sort((a, b) => (a.accountId === preferred ? -1 : b.accountId === preferred ? 1 : 0));
  };

  const ensureRoot = () => {
    if (root) return root;
    host = document.createElement('div');
    host.id = 'pem-web-assist';
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.right = '0';
    host.style.top = '12px';
    host.style.zIndex = '2147483647';
    host.style.display = 'flex';
    host.style.justifyContent = 'center';
    host.style.pointerEvents = 'none';
    root = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    return root;
  };

  const placeRoot = (modal) => {
    if (!host) return;
    const placement = snapshot?.capturePromptPlacement || 'top-right';
    host.style.top = modal ? '0' : '12px';
    host.style.bottom = modal ? '0' : '';
    host.style.alignItems = modal && placement === 'center' ? 'center' : 'flex-start';
    host.style.justifyContent = modal && placement === 'top-right' ? 'flex-end' : 'center';
    host.style.padding = modal ? '18px 24px' : '0';
    host.style.boxSizing = 'border-box';
    host.style.setProperty('--pem-modal-width', placement === 'top-right' ? '540px' : '760px');
  };

  const destroy = () => {
    clearInterval(unlockPoll);
    unlockPoll = 0;
    host?.remove();
    host = null;
    root = null;
  };

  const css = `
    :host { all: initial; }
    .wrap {
      pointer-events: auto;
      min-width: min(520px, calc(100vw - 24px));
      max-width: min(640px, calc(100vw - 24px));
      color: #111827;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      overflow: hidden;
      border: 1px solid rgba(37, 99, 235, .35);
      border-radius: 22px;
      background: rgba(255, 255, 255, .98);
      box-shadow: 0 16px 40px rgba(15, 23, 42, .18);
      backdrop-filter: blur(10px);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
    }
    .logo {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #fff;
      background: #0d9488;
      font-size: 14px;
      font-weight: 800;
      flex: 0 0 auto;
    }
    .text { min-width: 0; flex: 1; }
    .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 700;
      line-height: 18px;
    }
    .sub {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #6b7280;
      font-size: 12px;
      line-height: 16px;
    }
    .actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    button {
      all: initial;
      box-sizing: border-box;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      padding: 0 10px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      user-select: none;
    }
    button.primary { background: #0d9488; color: #fff; }
    button.secondary { background: #eef2f7; color: #374151; }
    button.icon { width: 30px; padding: 0; color: #6b7280; background: transparent; }
    button:hover { filter: brightness(.96); }
    .list { border-top: 1px solid #eef2f7; padding: 4px; }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      border-radius: 12px;
      padding: 8px;
    }
    .item:hover { background: #f8fafc; }
    .tiny {
      height: 26px;
      border-radius: 8px;
      padding: 0 8px;
      font-size: 11px;
      background: #eef2f7;
      color: #374151;
    }
    .msg {
      border-top: 1px solid #eef2f7;
      padding: 8px 12px 10px;
      color: #0f766e;
      font-size: 12px;
      font-weight: 650;
    }
    .warn { color: #b45309; }
    .modal {
      pointer-events: auto;
      width: min(var(--pem-modal-width, 760px), calc(100vw - 28px));
      max-height: min(720px, calc(100vh - 28px));
      overflow: hidden;
      border: 1px solid rgba(148, 163, 184, .42);
      border-radius: 18px;
      background: #202124;
      color: #f8fafc;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .38), 0 0 0 1px rgba(255, 255, 255, .05) inset;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .modal-head {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 20px 24px 16px;
    }
    .modal-title {
      flex: 1;
      font-size: 22px;
      line-height: 28px;
      font-weight: 800;
    }
    .modal-close {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      color: #d1d5db;
      background: transparent;
      font-size: 26px;
      padding: 0;
    }
    .modal-body {
      padding: 0 28px 18px;
      overflow: auto;
      max-height: min(560px, calc(100vh - 190px));
    }
    .seg {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      border-radius: 13px;
      background: #323334;
      padding: 4px;
      margin-bottom: 18px;
    }
    .seg button {
      height: 42px;
      border-radius: 10px;
      color: #e5e7eb;
      background: transparent;
      font-size: 15px;
    }
    .seg button.active {
      background: #737373;
      color: #fff;
      box-shadow: 0 1px 0 rgba(255, 255, 255, .18) inset, 0 8px 22px rgba(0, 0, 0, .24);
    }
    .capture-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 14px;
      color: #cbd5e1;
      font-size: 13px;
    }
    .pill {
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border-radius: 999px;
      background: rgba(20, 184, 166, .16);
      color: #99f6e4;
      padding: 5px 10px;
      font-weight: 700;
    }
    .capture-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
    .capture-item {
      display: grid;
      grid-template-columns: 44px 1fr 28px;
      align-items: center;
      gap: 12px;
      border: 1px solid transparent;
      border-radius: 14px;
      padding: 10px 12px;
      cursor: pointer;
    }
    .capture-item:hover { background: rgba(255, 255, 255, .05); }
    .capture-item.selected {
      border-color: rgba(59, 130, 246, .42);
      background: rgba(37, 99, 235, .24);
    }
    .capture-avatar {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: #b7e4d4;
      color: #315b54;
      font-size: 16px;
      font-weight: 900;
    }
    .capture-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 16px;
      font-weight: 760;
      line-height: 21px;
    }
    .capture-user {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #b6bbc4;
      font-size: 13px;
      line-height: 18px;
    }
    .radio {
      width: 20px;
      height: 20px;
      border-radius: 999px;
      border: 2px solid #7a7f88;
      box-sizing: border-box;
    }
    .selected .radio {
      border: 6px solid #2680eb;
      background: #fff;
    }
    .new-box {
      border: 1px solid rgba(148, 163, 184, .24);
      border-radius: 14px;
      background: rgba(255, 255, 255, .045);
      padding: 14px;
    }
    .new-row {
      display: grid;
      grid-template-columns: 92px 1fr;
      gap: 10px;
      padding: 6px 0;
      font-size: 13px;
    }
    .new-label { color: #94a3b8; }
    .new-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #f8fafc;
      font-weight: 700;
    }
    .field-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin: 12px 0 14px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .field label {
      color: #94a3b8;
      font-size: 12px;
      font-weight: 700;
    }
    .field input, .field select {
      all: initial;
      box-sizing: border-box;
      width: 100%;
      height: 38px;
      border: 1px solid rgba(148, 163, 184, .32);
      border-radius: 11px;
      background: rgba(15, 23, 42, .48);
      color: #f8fafc;
      padding: 0 11px;
      font-family: inherit;
      font-size: 13px;
    }
    .field select option { color: #111827; background: #fff; }
    .field.wide { grid-column: 1 / -1; }
    .modal-foot {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
      border-top: 1px solid rgba(148, 163, 184, .18);
      padding: 16px 28px 22px;
    }
    .modal-foot button {
      height: 40px;
      min-width: 82px;
      border-radius: 12px;
      font-size: 14px;
    }
    .modal-foot .primary { background: #0d6efd; }
    .modal-foot .secondary {
      background: transparent;
      color: #e5e7eb;
      border: 1px solid #71717a;
    }
    .lock-panel {
      margin: 0 28px 18px;
      border-radius: 14px;
      background: rgba(37, 99, 235, .28);
      padding: 18px 20px;
      color: #bfdbfe;
    }
    .lock-line {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 16px;
      line-height: 24px;
      font-weight: 750;
    }
    .lock-icon {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: rgba(147, 197, 253, .2);
      color: #93c5fd;
      font-size: 17px;
      flex: 0 0 auto;
    }
    .lock-help {
      margin: 10px 0 0 46px;
      color: #dbeafe;
      font-size: 12px;
      line-height: 18px;
      opacity: .9;
    }
    .lock-actions {
      display: flex;
      gap: 10px;
      margin: 16px 0 0 46px;
    }
    .lock-actions button {
      height: 36px;
      border-radius: 10px;
      font-size: 13px;
    }
    .lock-actions .primary { background: #0d6efd; color: #fff; }
    .lock-actions .secondary {
      background: rgba(255, 255, 255, .1);
      color: #e5e7eb;
    }
    @media (max-width: 520px) {
      .row { align-items: flex-start; }
      .actions { flex-wrap: wrap; justify-content: flex-end; max-width: 148px; }
      button { height: 28px; padding: 0 8px; }
      .modal-head { padding: 16px 16px 12px; }
      .modal-body { padding: 0 16px 14px; }
      .modal-foot { padding: 14px 16px 16px; }
      .modal-title { font-size: 19px; }
      .field-grid { grid-template-columns: 1fr; }
      .lock-panel { margin: 0 16px 16px; padding: 16px; }
      .lock-help, .lock-actions { margin-left: 0; }
      .lock-actions { flex-direction: column; }
    }
  `;

  const esc = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const labelFor = (e) => e.accountLabel || e.username || e.linkName || '账号';

  const captureCandidates = () => {
    const list = capturePrompt?.updateCandidates || [];
    if (capturePrompt?.kind === 'update' && capturePrompt.accountId && !list.some((c) => c.accountId === capturePrompt.accountId)) {
      return [
        {
          accountId: capturePrompt.accountId,
          accountLabel: capturePrompt.linkName || '已保存账号',
          username: capturePrompt.username || '',
          linkName: capturePrompt.linkName || '已保存账号',
        },
        ...list,
      ];
    }
    return list;
  };

  const setCapturePrompt = (next) => {
    capturePrompt = next;
    const candidates = captureCandidates();
    selectedUpdateId = next?.accountId || candidates[0]?.accountId || '';
    captureMode = selectedUpdateId ? 'update' : 'new';
    captureDraft = next
      ? {
          username: next.username || '',
          accountLabel: next.accountLabel || next.linkName || '',
          targetLinkId: next.targetLinkId || next.saveTargets?.[0]?.linkId || '',
        }
      : null;
    dismissed = false;
    expanded = false;
  };

  const shortName = (s) => String(s || '?').trim().slice(0, 2).toLowerCase();

  const captureItemTitle = (c) => c.accountLabel || c.linkName || c.username || '已保存账号';

  const render = (message, tone = 'info') => {
    const surface = surfaceKind();
    sortMatches(surface);
    const shouldShowMatches =
      !dismissed &&
      snapshot &&
      snapshot.enabled &&
      snapshot.matches.length > 0 &&
      (surface === 'password' ||
        surface === 'username' ||
        (surface === 'otp' && snapshot.matches.some((e) => e.hasTotp)));
    const shouldShowLocked = lockedPrompt && snapshot?.locked;
    if (!capturePrompt && !shouldShowMatches && !shouldShowLocked) return destroy();

    const r = ensureRoot();
    placeRoot(Boolean(capturePrompt || shouldShowLocked));
    if (shouldShowLocked) {
      r.innerHTML = `
        <style>${css}</style>
        <div class="modal">
          <div class="modal-head">
            <div class="logo">PM</div>
            <div class="modal-title">保存登录</div>
            <button class="modal-close" data-act="close" aria-label="关闭">×</button>
          </div>
          <div class="lock-panel">
            <div class="lock-line">
              <span class="lock-icon">锁</span>
              <span>要保存这次登录，需先解锁项目环境管家。</span>
            </div>
            <div class="lock-help">
              解锁后回到当前页面，会自动尝试恢复保存提示；也可以在扩展弹窗里手动捕获当前输入。
            </div>
            <div class="lock-actions">
              <button class="primary" data-act="unlock-vault">解锁项目环境管家</button>
              <button class="secondary" data-act="close">稍后</button>
            </div>
          </div>
          ${message ? `<div class="msg ${tone === 'warn' ? 'warn' : ''}">${esc(message)}</div>` : ''}
        </div>
      `;
      r.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void onAction(btn.dataset.act, btn.dataset.id);
        });
      });
      return;
    }
    if (capturePrompt) {
      const candidates = captureCandidates();
      const canUpdate = candidates.length > 0;
      if (!canUpdate) captureMode = 'new';
      if (canUpdate && (!selectedUpdateId || !candidates.some((c) => c.accountId === selectedUpdateId))) {
        selectedUpdateId = candidates[0].accountId;
      }
      const mode = canUpdate ? captureMode : 'new';
      const selected = candidates.find((c) => c.accountId === selectedUpdateId) || candidates[0];
      const targets = capturePrompt.saveTargets || [];
      const draft = captureDraft || {
        username: capturePrompt.username || '',
        accountLabel: capturePrompt.accountLabel || capturePrompt.linkName || '',
        targetLinkId: capturePrompt.targetLinkId || targets[0]?.linkId || '',
      };
      r.innerHTML = `
        <style>${css}</style>
        <div class="modal">
          <div class="modal-head">
            <div class="logo">PM</div>
            <div class="modal-title">保存登录</div>
            <button class="modal-close" data-act="close" aria-label="关闭">×</button>
          </div>
          <div class="modal-body">
            ${
              canUpdate
                ? `<div class="seg">
                    <button data-act="capture-mode-new" class="${mode === 'new' ? 'active' : ''}">新建登录</button>
                    <button data-act="capture-mode-update" class="${mode === 'update' ? 'active' : ''}">更新现有</button>
                  </div>`
                : ''
            }
            <div class="capture-meta">
              <span class="pill">${esc(hostOf(capturePrompt.origin))}</span>
              <span>${esc(capturePrompt.username || '无用户名')}</span>
            </div>
            <div class="field-grid">
              <div class="field">
                <label>登录名称</label>
                <input data-field="accountLabel" value="${esc(draft.accountLabel || '')}" placeholder="${esc(hostOf(capturePrompt.origin))}" />
              </div>
              <div class="field">
                <label>用户名</label>
                <input data-field="username" value="${esc(draft.username || '')}" placeholder="用户名" />
              </div>
              ${
                mode === 'new' && targets.length
                  ? `<div class="field wide">
                      <label>保存到</label>
                      <select data-field="targetLinkId">
                        ${targets
                          .map(
                            (t) =>
                              `<option value="${esc(t.linkId)}" ${t.linkId === draft.targetLinkId ? 'selected' : ''}>${esc(`${t.projectName} / ${t.envName} / ${t.linkName}`)}</option>`,
                          )
                          .join('')}
                      </select>
                    </div>`
                  : ''
              }
            </div>
            ${
              mode === 'update'
                ? `<div class="capture-list">
                    ${candidates
                      .map(
                        (c) => `<div class="capture-item ${c.accountId === selectedUpdateId ? 'selected' : ''}" data-act="select-capture-update" data-id="${esc(c.accountId)}">
                          <div class="capture-avatar">${esc(shortName(c.accountLabel || c.linkName || c.username))}</div>
                          <div>
                            <div class="capture-name">${esc(captureItemTitle(c))}</div>
                            <div class="capture-user">${esc(c.username || '无用户名')} · ${esc(c.linkName || '当前网站')}</div>
                          </div>
                          <div class="radio"></div>
                        </div>`,
                      )
                      .join('')}
                  </div>`
                : `<div class="new-box">
                    <div class="new-row"><div class="new-label">网站</div><div class="new-value">${esc(hostOf(capturePrompt.origin))}</div></div>
                    <div class="new-row"><div class="new-label">用户名</div><div class="new-value">${esc(capturePrompt.username || '无用户名')}</div></div>
                    <div class="new-row"><div class="new-label">保存到</div><div class="new-value">${esc(capturePrompt.linkName || '捕获 / 默认')}</div></div>
                  </div>`
            }
          </div>
          <div class="modal-foot">
            <button class="secondary" data-act="edit-capture">编辑</button>
            <button class="primary" data-act="confirm-capture" ${mode === 'update' && !selected ? 'disabled' : ''}>${mode === 'update' ? '更新' : '保存'}</button>
          </div>
          ${message ? `<div class="msg ${tone === 'warn' ? 'warn' : ''}">${esc(message)}</div>` : ''}
        </div>
      `;
      r.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void onAction(btn.dataset.act, btn.dataset.id);
        });
      });
      r.querySelectorAll('[data-field]').forEach((field) => {
        field.addEventListener('input', () => {
          captureDraft = {
            ...(captureDraft || {}),
            [field.dataset.field]: field.value,
          };
        });
        field.addEventListener('change', () => {
          captureDraft = {
            ...(captureDraft || {}),
            [field.dataset.field]: field.value,
          };
        });
      });
      return;
    }

    const first = snapshot?.matches?.[0];
    const matchCount = snapshot?.matches?.length || 0;
    const title = capturePrompt
      ? capturePrompt.kind === 'update'
        ? `更新 ${capturePrompt.linkName || '已保存账号'} 的密码?`
        : `保存 ${capturePrompt.username || '这个账号'}?`
      : `${first.linkName || first.projectName} · ${labelFor(first)}`;
    const sub = capturePrompt
      ? `${hostOf(capturePrompt.origin)} · ${capturePrompt.username || '无用户名'}`
      : `${first.username || '无用户名'} · ${first.projectName} / ${first.envName}`;

    r.innerHTML = `
      <style>${css}</style>
      <div class="wrap">
        <div class="card">
          <div class="row">
            <div class="logo">${capturePrompt ? '+' : 'PM'}</div>
            <div class="text">
              <div class="title">${esc(title)}</div>
              <div class="sub">${esc(sub)}</div>
            </div>
            <div class="actions">
              ${
                capturePrompt
                  ? `<button class="primary" data-act="save-capture">${capturePrompt.kind === 'update' ? '更新' : '保存'}</button>
                     ${
                       capturePrompt.kind === 'new' && capturePrompt.updateCandidates?.length
                         ? `<button class="secondary" data-act="update-capture" data-id="${esc(capturePrompt.updateCandidates[0].accountId)}">更新已有</button>`
                         : ''
                     }
                     <button class="secondary" data-act="edit-capture">编辑</button>
                     <button class="secondary" data-act="dismiss-capture">忽略</button>`
                  : `${
                      surface === 'username'
                        ? `<button class="primary" data-act="fill-user" data-id="${esc(first.accountId)}">填账号</button>
                           <button class="secondary" data-act="continue-user" data-id="${esc(first.accountId)}">继续</button>`
                        : surface === 'otp'
                          ? first.hasTotp
                            ? `<button class="primary" data-act="totp" data-id="${esc(first.accountId)}">验证码</button>`
                            : ''
                          : `<button class="primary" data-act="fill" data-id="${esc(first.accountId)}">填充</button>
                             <button class="secondary" data-act="login" data-id="${esc(first.accountId)}">登录</button>
                             ${
                               first.hasTotp
                                 ? `<button class="secondary" data-act="totp" data-id="${esc(first.accountId)}">验证码</button>`
                                 : ''
                             }`
                    }
                     ${
                       matchCount > 1
                         ? `<button class="secondary" data-act="more">更多 ${matchCount}</button>`
                         : ''
                     }`
              }
              <button class="icon" data-act="close" aria-label="关闭">×</button>
            </div>
          </div>
          ${
            expanded && !capturePrompt
              ? `<div class="list">
                  ${snapshot.matches
                    .map(
                      (e) => `<div class="item">
                        <div class="logo">${esc((e.accountLabel || e.username || '?').slice(0, 1).toUpperCase())}</div>
                        <div class="text">
                          <div class="title">${esc(e.linkName || e.projectName)} · ${esc(labelFor(e))}</div>
                          <div class="sub">${esc(e.username || '无用户名')} · ${esc(e.envName)}</div>
                        </div>
                        ${
                          surface === 'username'
                            ? `<button class="tiny" data-act="fill-user" data-id="${esc(e.accountId)}">填账号</button>
                               <button class="tiny" data-act="continue-user" data-id="${esc(e.accountId)}">继续</button>`
                            : surface === 'otp'
                              ? e.hasTotp
                                ? `<button class="tiny" data-act="totp" data-id="${esc(e.accountId)}">验证码</button>`
                                : ''
                              : `<button class="tiny" data-act="fill" data-id="${esc(e.accountId)}">填充</button>
                                 <button class="tiny" data-act="login" data-id="${esc(e.accountId)}">登录</button>
                                 ${e.hasTotp ? `<button class="tiny" data-act="totp" data-id="${esc(e.accountId)}">验证码</button>` : ''}`
                        }
                      </div>`,
                    )
                    .join('')}
                </div>`
              : ''
          }
          ${message ? `<div class="msg ${tone === 'warn' ? 'warn' : ''}">${esc(message)}</div>` : ''}
        </div>
      </div>
    `;

    r.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void onAction(btn.dataset.act, btn.dataset.id);
      });
    });
  };

  const retryLockedCandidate = async () => {
    if (!lockedCandidate || snapshot?.locked) return false;
    const now = Date.now();
    if (now - lastUnlockRetry < 1200) return false;
    lastUnlockRetry = now;
    const c = lockedCandidate;
    try {
      const res = await send({
        type: 'capture:login',
        origin: c.origin,
        url: c.url,
        username: c.username,
        password: c.password,
      });
      lockedPrompt = false;
      lockedCandidate = null;
      if (res?.pending) {
        setCapturePrompt(res);
        render();
      } else {
        render('已解锁，可继续使用项目环境管家');
        setTimeout(scheduleRefresh, 1200);
      }
      return true;
    } catch (e) {
      render(e instanceof Error ? e.message : String(e), 'warn');
      return true;
    }
  };

  const startUnlockPolling = () => {
    clearInterval(unlockPoll);
    const stopAt = Date.now() + 120_000;
    unlockPoll = setInterval(async () => {
      if (Date.now() > stopAt) {
        clearInterval(unlockPoll);
        unlockPoll = 0;
        return;
      }
      await loadSnapshot();
      if (!snapshot?.locked) {
        clearInterval(unlockPoll);
        unlockPoll = 0;
        const retried = await retryLockedCandidate();
        if (!retried) render();
      }
    }, 1500);
  };

  const onAction = async (act, accountId) => {
    try {
      if (act === 'close') {
        dismissed = true;
        capturePrompt = null;
        lockedPrompt = false;
        lockedCandidate = null;
        destroy();
        return;
      }
      if (act === 'unlock-vault') {
        window.open(chrome.runtime.getURL('/options.html?unlock=1'), '_blank', 'noopener');
        startUnlockPolling();
        render('已打开解锁页面');
        return;
      }
      if (act === 'more') {
        expanded = !expanded;
        render();
        return;
      }
      if (act === 'capture-mode-new') {
        captureMode = 'new';
        render();
        return;
      }
      if (act === 'capture-mode-update') {
        const candidates = captureCandidates();
        if (candidates.length > 0) {
          captureMode = 'update';
          selectedUpdateId = selectedUpdateId || candidates[0].accountId;
        }
        render();
        return;
      }
      if (act === 'select-capture-update') {
        selectedUpdateId = accountId || '';
        captureMode = 'update';
        render();
        return;
      }
      if (act === 'confirm-capture') {
        const accountIdToUpdate = captureMode === 'update' ? selectedUpdateId : undefined;
        await send({
          type: 'capture:save',
          id: capturePrompt?.id,
          accountId: accountIdToUpdate,
          username: captureDraft?.username,
          accountLabel: captureDraft?.accountLabel,
          targetLinkId: captureMode === 'new' ? captureDraft?.targetLinkId : undefined,
        });
        capturePrompt = null;
        captureDraft = null;
        await loadSnapshot();
        render(accountIdToUpdate ? '已更新保险箱' : '已保存到保险箱');
        setTimeout(scheduleRefresh, 1400);
        return;
      }
      if (act === 'save-capture') {
        await send({ type: 'capture:save', id: capturePrompt?.id });
        capturePrompt = null;
        await loadSnapshot();
        render('已保存到保险箱');
        setTimeout(scheduleRefresh, 1400);
        return;
      }
      if (act === 'update-capture') {
        await send({ type: 'capture:save', id: capturePrompt?.id, accountId });
        capturePrompt = null;
        await loadSnapshot();
        render('已更新保险箱');
        setTimeout(scheduleRefresh, 1400);
        return;
      }
      if (act === 'edit-capture') {
        await send({ type: 'capture:editSave', id: capturePrompt?.id });
        render('已打开编辑保存');
        return;
      }
      if (act === 'dismiss-capture') {
        await send({ type: 'capture:dismiss', id: capturePrompt?.id });
        capturePrompt = null;
        render('已忽略');
        setTimeout(scheduleRefresh, 900);
        return;
      }
      if (act === 'fill-user' || act === 'continue-user') {
        remember(accountId);
        const res = await send({
          type: 'assist:fillUsername',
          accountId,
          submit: act === 'continue-user',
        });
        render(res?.ok === false ? res.reason || '未能填账号' : act === 'continue-user' ? '已填账号并继续' : '已填账号', res?.ok === false ? 'warn' : 'info');
        return;
      }
      if (act === 'fill' || act === 'login') {
        remember(accountId);
        const res = await send({ type: 'assist:fill', accountId, submit: act === 'login' });
        render(res?.ok === false ? res.reason || '未能填充' : act === 'login' ? '已填充并提交' : '已填充', res?.ok === false ? 'warn' : 'info');
        return;
      }
      if (act === 'totp') {
        remember(accountId);
        const res = await send({ type: 'assist:fillTotp', accountId, submit: false });
        render(res?.ok === false ? res.reason || '未能填验证码' : '验证码已填充', res?.ok === false ? 'warn' : 'info');
      }
    } catch (e) {
      render(e instanceof Error ? e.message : String(e), 'warn');
    }
  };

  const loadSnapshot = async () => {
    try {
      snapshot = await send({ type: 'assist:matches' });
    } catch {
      snapshot = null;
    }
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await loadSnapshot();
      const retried = await retryLockedCandidate();
      if (!retried) render();
    }, 120);
  };

  const captureCandidate = async () => {
    const fields = passwordFields().filter((el) => el.value);
    const pw = fields[0];
    if (!pw || !pw.value) return;

    const scope = pw.form || document;
    const cands = Array.from(
      scope.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type])'),
    ).filter((el) => el.type !== 'password' && el.value && visible(el));

    let username = '';
    for (const el of cands) {
      if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) username = el.value;
    }
    if (!username && cands[0]) username = cands[0].value;

    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;

    const candidate = {
      origin: location.origin,
      url: location.href,
      username,
      password: pw.value,
    };

    try {
      await loadSnapshot();
      if (snapshot?.locked) {
        lockedCandidate = candidate;
        lockedPrompt = true;
        dismissed = false;
        render();
        return;
      }
      await send({
        type: 'capture:candidate',
        ...candidate,
      });
    } catch {
      // Ignore stale extension contexts or locked vaults.
    }
  };

  const confirmCaptureSuccess = async () => {
    try {
      const res = await send({
        type: 'capture:successCheck',
        origin: location.origin,
        url: location.href,
        signals: successSignals(),
      });
      if (res?.pending) {
        setCapturePrompt(res);
        render();
      }
    } catch {
      // Ignore stale extension contexts or locked vaults.
    }
  };

  const scheduleSuccessCheck = () => {
    if (Date.now() > successCheckUntil) return;
    clearTimeout(successTimer);
    successTimer = setTimeout(() => void confirmCaptureSuccess(), 250);
  };

  const armSuccessChecks = (windowMs = 15_000) => {
    successCheckUntil = Math.max(successCheckUntil, Date.now() + windowMs);
    for (const delay of CHECK_DELAYS) setTimeout(() => void confirmCaptureSuccess(), delay);
  };

  const soonCapture = () => {
    armSuccessChecks();
    void captureCandidate();
  };

  const hostOf = (origin) => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  };

  document.addEventListener('submit', soonCapture, true);
  document.addEventListener(
    'click',
    (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.includes(host)) return;
      const t = e.target;
      if (t && t.closest && t.closest('button, input[type="submit"], [role="button"]')) soonCapture();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') soonCapture();
    },
    true,
  );
  document.addEventListener('focusin', scheduleRefresh, true);
  window.addEventListener('focus', scheduleRefresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh();
  });

  new MutationObserver(() => {
    scheduleRefresh();
    scheduleSuccessCheck();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'style', 'class', 'hidden', 'autocomplete', 'inputmode'],
  });

  // 新页面加载时检查上一页提交留下的同源候选。
  armSuccessChecks(7000);
  void loadSnapshot().then(() => render());
})();
