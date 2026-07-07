// 网页 JSON 自动格式化内容脚本。
// 仅在用户开启「网页 JSON 自动格式化」并授予 http(s) 全站权限后由后台动态注册。
// 纯浏览态便利功能：不读写金库、不发网络请求，只把当前页面的 JSON 响应渲染成可折叠的树。
(() => {
  if (window.__PEM_JSON_VIEWER__) return;

  // 只处理「内容类型为 JSON」的响应页，避免误伤普通 HTML 页面。
  const ct = (document.contentType || '').toLowerCase();
  const isJsonType = /^(application|text)\/([a-z.+-]*\+)?json\b/.test(ct) || ct === 'text/json';
  if (!isJsonType) return;

  // 取原始文本：JSON 响应页里浏览器通常把正文包在单个 <pre> 中。
  const pre = document.body ? document.body.querySelector('pre') : null;
  const raw = (pre ? pre.textContent : document.body ? document.body.textContent : '') || '';
  const trimmed = raw.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[' && trimmed[0] !== '"')) return;

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return; // 不是合法 JSON：保持页面原样。
  }
  // 顶层只有当是对象/数组时才值得树形展示；纯标量/字符串就不接管了。
  if (data === null || typeof data !== 'object') return;

  window.__PEM_JSON_VIEWER__ = true;

  // ------------------------------------------------------------------ 样式
  const style = document.createElement('style');
  style.textContent = `
  .pemjv-root{--jv-bg:#fbfcfd;--jv-fg:#1f2430;--jv-muted:#8b94a3;--jv-line:#e6e9ef;--jv-key:#7c4dff;--jv-str:#0a8f5b;--jv-num:#2563eb;--jv-bool:#c2410c;--jv-null:#8b94a3;--jv-chip:#eef1f5;--jv-hover:#f0f3f7;--jv-accent:#0d9488;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--jv-fg);background:var(--jv-bg);min-height:100vh;margin:0;padding:0;-webkit-text-size-adjust:100%}
  @media(prefers-color-scheme:dark){.pemjv-root{--jv-bg:#0f1216;--jv-fg:#e6e8ee;--jv-muted:#7d8798;--jv-line:#242a33;--jv-key:#c4b5fd;--jv-str:#4ade80;--jv-num:#60a5fa;--jv-bool:#fdba74;--jv-null:#6b7280;--jv-chip:#1b2027;--jv-hover:#171c22;--jv-accent:#2dd4bf}}
  .pemjv-bar{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 14px;background:var(--jv-bg);border-bottom:1px solid var(--jv-line)}
  .pemjv-brand{display:flex;align-items:center;gap:6px;font-weight:700;color:var(--jv-accent);margin-right:4px}
  .pemjv-btn{cursor:pointer;border:1px solid var(--jv-line);background:transparent;color:var(--jv-fg);border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;font-weight:600;transition:background .12s}
  .pemjv-btn:hover{background:var(--jv-hover)}
  .pemjv-btn[data-on="1"]{background:var(--jv-accent);color:#fff;border-color:transparent}
  .pemjv-find{flex:1;min-width:120px;max-width:320px;border:1px solid var(--jv-line);background:transparent;color:var(--jv-fg);border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;outline:none}
  .pemjv-find:focus{border-color:var(--jv-accent)}
  .pemjv-stat{color:var(--jv-muted);font-size:11.5px;margin-left:auto}
  .pemjv-tree{padding:14px 16px 60px}
  .pemjv-raw{white-space:pre-wrap;word-break:break-word;padding:14px 16px 60px;margin:0;font:inherit}
  .pemjv-node{position:relative}
  .pemjv-row{display:flex;align-items:flex-start;border-radius:6px;padding:0 4px;white-space:pre-wrap;word-break:break-word}
  .pemjv-row:hover{background:var(--jv-hover)}
  .pemjv-row:hover .pemjv-acts{opacity:1}
  .pemjv-tw{flex-shrink:0;width:14px;margin-right:2px;color:var(--jv-muted);cursor:pointer;user-select:none;text-align:center}
  .pemjv-tw.pemjv-leaf{cursor:default;visibility:hidden}
  .pemjv-main{min-width:0;flex:1}
  .pemjv-k{color:var(--jv-key)}
  .pemjv-kx{color:var(--jv-muted)}
  .pemjv-s{color:var(--jv-str)}
  .pemjv-n{color:var(--jv-num)}
  .pemjv-b{color:var(--jv-bool)}
  .pemjv-z{color:var(--jv-null)}
  .pemjv-punc{color:var(--jv-muted)}
  .pemjv-count{color:var(--jv-muted);font-size:11px;margin-left:6px}
  .pemjv-preview{color:var(--jv-muted);cursor:pointer}
  .pemjv-kids{margin-left:15px;border-left:1px solid var(--jv-line);padding-left:6px}
  .pemjv-collapsed>.pemjv-kids{display:none}
  .pemjv-collapsed>.pemjv-row .pemjv-ellip{display:inline}
  .pemjv-ellip{display:none;color:var(--jv-muted)}
  .pemjv-acts{display:inline-flex;gap:4px;margin-left:8px;opacity:0;transition:opacity .1s}
  .pemjv-act{cursor:pointer;border:1px solid var(--jv-line);background:var(--jv-bg);color:var(--jv-muted);border-radius:6px;padding:0 6px;font-size:10.5px;font-weight:600;line-height:17px}
  .pemjv-act:hover{color:var(--jv-fg);background:var(--jv-hover)}
  .pemjv-pluck{margin:4px 0 4px 15px;border:1px solid var(--jv-line);border-radius:9px;padding:8px 10px;background:var(--jv-chip)}
  .pemjv-pluck-hd{display:flex;gap:6px;align-items:center;margin-bottom:6px}
  .pemjv-pluck-in{flex:1;min-width:80px;border:1px solid var(--jv-line);background:var(--jv-bg);color:var(--jv-fg);border-radius:7px;padding:3px 8px;font:inherit;font-size:12px;outline:none}
  .pemjv-pluck-in:focus{border-color:var(--jv-accent)}
  .pemjv-pluck-list{max-height:260px;overflow:auto;font-size:12px}
  .pemjv-pluck-row{display:flex;gap:8px;padding:1px 0}
  .pemjv-pluck-i{color:var(--jv-muted);flex-shrink:0;min-width:42px}
  .pemjv-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1a1d23;color:#fff;padding:8px 16px;border-radius:10px;font-size:12.5px;z-index:50;box-shadow:0 12px 30px -8px rgba(0,0,0,.45);opacity:0;transition:opacity .15s}
  .pemjv-toast[data-show="1"]{opacity:1}
  `;

  const MAX_AUTO_EXPAND = 400; // 节点总数较少时默认全展开，过大时只展开前两层。
  let nodeCount = 0;
  (function count(v) {
    if (v && typeof v === 'object') {
      nodeCount += Array.isArray(v) ? v.length : Object.keys(v).length;
      if (nodeCount <= MAX_AUTO_EXPAND) for (const k in v) count(v[k]);
    }
  })(data);
  const autoExpandAll = nodeCount <= MAX_AUTO_EXPAND;

  // ------------------------------------------------------------- 工具函数
  const esc = (s) => s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
  const typeOf = (v) =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  const isContainer = (v) => v !== null && typeof v === 'object';

  const pathToStr = (path) =>
    path.reduce((acc, seg) => {
      if (typeof seg === 'number') return acc + '[' + seg + ']';
      return /^[A-Za-z_$][\w$]*$/.test(seg) ? (acc ? acc + '.' + seg : seg) : acc + '["' + seg + '"]';
    }, '');

  const getByPath = (obj, keyPath) => {
    const segs = keyPath.split('.').map((s) => s.trim()).filter(Boolean);
    let cur = obj;
    for (const s of segs) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[s];
    }
    return cur;
  };

  const previewOf = (v) => {
    if (Array.isArray(v)) return 'Array(' + v.length + ')';
    const keys = Object.keys(v);
    return '{ ' + keys.slice(0, 4).join(', ') + (keys.length > 4 ? ', …' : '') + ' }';
  };

  let toastTimer = 0;
  const toast = (msg) => {
    let el = document.querySelector('.pemjv-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'pemjv-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.setAttribute('data-show', '1');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.setAttribute('data-show', '0'), 1400);
  };
  const copy = (text, what) => {
    navigator.clipboard.writeText(text).then(
      () => toast((what || '内容') + '已复制'),
      () => toast('复制失败'),
    );
  };

  // ---------------------------------------------------------- 渲染值节点
  // 返回一个 DOM 节点；容器节点带折叠能力与操作按钮。
  function renderValue(value, keyName, path, depth) {
    const node = document.createElement('div');
    node.className = 'pemjv-node';
    const row = document.createElement('div');
    row.className = 'pemjv-row';
    node.appendChild(row);

    const tw = document.createElement('span');
    tw.className = 'pemjv-tw';
    row.appendChild(tw);

    const main = document.createElement('span');
    main.className = 'pemjv-main';
    row.appendChild(main);

    const keyHtml =
      keyName === undefined
        ? ''
        : typeof keyName === 'number'
          ? '<span class="pemjv-kx">' + keyName + '</span><span class="pemjv-punc">: </span>'
          : '<span class="pemjv-k">"' + esc(String(keyName)) + '"</span><span class="pemjv-punc">: </span>';

    if (!isContainer(value)) {
      tw.classList.add('pemjv-leaf');
      tw.textContent = '•';
      let vHtml;
      const t = typeOf(value);
      if (t === 'string') vHtml = '<span class="pemjv-s">"' + esc(value) + '"</span>';
      else if (t === 'number') vHtml = '<span class="pemjv-n">' + esc(String(value)) + '</span>';
      else if (t === 'boolean') vHtml = '<span class="pemjv-b">' + value + '</span>';
      else vHtml = '<span class="pemjv-z">null</span>';
      main.innerHTML = keyHtml + vHtml;
      addActions(row, value, path, false);
      return node;
    }

    // 容器（对象 / 数组）
    const arr = Array.isArray(value);
    const entries = arr ? value.map((v, i) => [i, v]) : Object.entries(value);
    const openB = arr ? '[' : '{';
    const closeB = arr ? ']' : '}';

    tw.textContent = '▾';
    tw.setAttribute('role', 'button');

    main.innerHTML =
      keyHtml +
      '<span class="pemjv-punc">' +
      openB +
      '</span>' +
      '<span class="pemjv-ellip">…' +
      '<span class="pemjv-preview">' +
      esc(previewOf(value)) +
      '</span>…</span>' +
      '<span class="pemjv-count">' +
      entries.length +
      (arr ? ' 项' : ' 键') +
      '</span>';

    addActions(row, value, path, arr);

    const kids = document.createElement('div');
    kids.className = 'pemjv-kids';
    node.appendChild(kids);

    const closer = document.createElement('div');
    closer.className = 'pemjv-punc';
    closer.style.paddingLeft = '4px';
    closer.textContent = closeB;
    node.appendChild(closer);

    // 折叠切换
    const setCollapsed = (c) => node.classList.toggle('pemjv-collapsed', c);
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      for (const [k, v] of entries) kids.appendChild(renderValue(v, k, path.concat(k), depth + 1));
    };
    const toggle = () => {
      const willCollapse = !node.classList.contains('pemjv-collapsed');
      if (!willCollapse) build();
      tw.textContent = willCollapse ? '▸' : '▾';
      setCollapsed(willCollapse);
    };
    tw.addEventListener('click', toggle);
    main.querySelector('.pemjv-preview')?.addEventListener('click', toggle);

    const expanded = autoExpandAll || depth < 1;
    if (expanded) {
      build();
    } else {
      tw.textContent = '▸';
      setCollapsed(true);
    }
    return node;
  }

  // 行内操作按钮：复制值 / 复制路径 / 数组提取字段
  function addActions(row, value, path, isArray) {
    const acts = document.createElement('span');
    acts.className = 'pemjv-acts';
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'pemjv-act';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      acts.appendChild(b);
    };
    mk('复制值', '复制该节点的值', () =>
      copy(typeof value === 'string' ? value : JSON.stringify(value, null, 2), '值'),
    );
    if (path.length) mk('复制路径', '复制到该节点的路径', () => copy(pathToStr(path), '路径'));
    if (isArray && value.length) mk('提取字段', '列出数组中每一项的某个字段', () => openPluck(row, value));
    row.appendChild(acts);
  }

  // 数组「提取字段」：给定 key 路径，列出每一项的对应值。
  function openPluck(row, arr) {
    const node = row.parentElement;
    if (node.querySelector(':scope > .pemjv-pluck')) {
      node.querySelector(':scope > .pemjv-pluck').remove();
      return;
    }
    const box = document.createElement('div');
    box.className = 'pemjv-pluck';
    const hd = document.createElement('div');
    hd.className = 'pemjv-pluck-hd';
    const input = document.createElement('input');
    input.className = 'pemjv-pluck-in';
    input.placeholder = '字段名，如 id 或 user.name（留空取整项）';
    const go = document.createElement('button');
    go.className = 'pemjv-btn';
    go.textContent = '提取';
    const copyAll = document.createElement('button');
    copyAll.className = 'pemjv-btn';
    copyAll.textContent = '复制全部';
    hd.append(input, go, copyAll);
    const list = document.createElement('div');
    list.className = 'pemjv-pluck-list';
    box.append(hd, list);
    row.after(box);
    input.focus();

    let lastValues = [];
    const run = () => {
      const key = input.value.trim();
      list.innerHTML = '';
      lastValues = [];
      let shown = 0;
      arr.forEach((item, i) => {
        const val = key ? getByPath(item, key) : item;
        if (val === undefined) return;
        lastValues.push(val);
        if (shown >= 1000) return;
        shown++;
        const r = document.createElement('div');
        r.className = 'pemjv-pluck-row';
        const idx = document.createElement('span');
        idx.className = 'pemjv-pluck-i';
        idx.textContent = '[' + i + ']';
        const v = document.createElement('span');
        const disp =
          val === null
            ? 'null'
            : typeof val === 'object'
              ? JSON.stringify(val)
              : typeof val === 'string'
                ? val
                : String(val);
        v.className =
          typeof val === 'string'
            ? 'pemjv-s'
            : typeof val === 'number'
              ? 'pemjv-n'
              : typeof val === 'boolean'
                ? 'pemjv-b'
                : 'pemjv-main';
        v.textContent = disp;
        v.style.cursor = 'pointer';
        v.title = '点击复制';
        v.addEventListener('click', () => copy(disp, '值'));
        r.append(idx, v);
        list.appendChild(r);
      });
      const head = document.createElement('div');
      head.className = 'pemjv-pluck-i';
      head.style.margin = '0 0 4px';
      head.textContent = '命中 ' + lastValues.length + ' / ' + arr.length + ' 项';
      list.prepend(head);
    };
    go.addEventListener('click', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run();
    });
    copyAll.addEventListener('click', () => copy(JSON.stringify(lastValues, null, 2), '全部值'));
    run();
  }

  // ------------------------------------------------------------------- 组装
  const root = document.createElement('div');
  root.className = 'pemjv-root';

  const bar = document.createElement('div');
  bar.className = 'pemjv-bar';
  bar.innerHTML =
    '<span class="pemjv-brand">{ } JSON</span>' +
    '<button class="pemjv-btn" data-a="expand">展开全部</button>' +
    '<button class="pemjv-btn" data-a="collapse">折叠全部</button>' +
    '<button class="pemjv-btn" data-a="copy">复制 JSON</button>' +
    '<button class="pemjv-btn" data-a="raw">原始文本</button>' +
    '<input class="pemjv-find" placeholder="过滤 key…（回车）" data-a="find">' +
    '<span class="pemjv-stat"></span>';
  root.appendChild(bar);

  const tree = document.createElement('div');
  tree.className = 'pemjv-tree';
  tree.appendChild(renderValue(data, undefined, [], 0));
  root.appendChild(tree);

  const rawPre = document.createElement('pre');
  rawPre.className = 'pemjv-raw';
  rawPre.style.display = 'none';
  rawPre.textContent = JSON.stringify(data, null, 2);
  root.appendChild(rawPre);

  // 统计信息
  const byteLen = new Blob([trimmed]).size;
  const kb = byteLen < 1024 ? byteLen + ' B' : (byteLen / 1024).toFixed(1) + ' KB';
  bar.querySelector('.pemjv-stat').textContent =
    (Array.isArray(data) ? data.length + ' 项' : Object.keys(data).length + ' 键') + ' · ' + kb;

  // 工具栏行为
  const setAll = (collapse) => {
    tree.querySelectorAll('.pemjv-node').forEach((n) => {
      if (!n.querySelector(':scope > .pemjv-kids')) return;
      const tw = n.querySelector(':scope > .pemjv-row > .pemjv-tw');
      if (collapse) {
        n.classList.add('pemjv-collapsed');
        if (tw) tw.textContent = '▸';
      } else {
        // 展开需要确保子节点已构建：点击一次已折叠节点的三角来触发构建。
        if (n.classList.contains('pemjv-collapsed') && tw) tw.click();
        n.classList.remove('pemjv-collapsed');
        if (tw) tw.textContent = '▾';
      }
    });
  };
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.getAttribute('data-a');
    if (a === 'expand') {
      // 反复展开直到没有仍处于折叠态的容器（懒构建可能逐层展开）。
      for (let i = 0; i < 40 && tree.querySelector('.pemjv-collapsed'); i++) setAll(false);
    } else if (a === 'collapse') setAll(true);
    else if (a === 'copy') copy(JSON.stringify(data, null, 2), 'JSON');
    else if (a === 'raw') {
      const showRaw = rawPre.style.display === 'none';
      rawPre.style.display = showRaw ? 'block' : 'none';
      tree.style.display = showRaw ? 'none' : 'block';
      b.setAttribute('data-on', showRaw ? '1' : '0');
      b.textContent = showRaw ? '树形视图' : '原始文本';
    }
  });

  // key 过滤：隐藏不含关键字的叶子行、保留命中项的祖先链。
  const findInput = bar.querySelector('[data-a="find"]');
  const applyFilter = () => {
    const q = findInput.value.trim().toLowerCase();
    const rows = tree.querySelectorAll('.pemjv-node');
    if (!q) {
      rows.forEach((n) => (n.style.display = ''));
      return;
    }
    // 先展开全部以便过滤覆盖懒构建的深层节点。
    for (let i = 0; i < 40 && tree.querySelector('.pemjv-collapsed'); i++) setAll(false);
    tree.querySelectorAll('.pemjv-node').forEach((n) => {
      const txt = (n.querySelector(':scope > .pemjv-row .pemjv-main')?.textContent || '').toLowerCase();
      const hit = txt.includes(q);
      n.dataset.hit = hit ? '1' : '';
    });
    tree.querySelectorAll('.pemjv-node').forEach((n) => {
      const selfHit = n.dataset.hit === '1';
      const descHit = !!n.querySelector('.pemjv-node[data-hit="1"]');
      n.style.display = selfHit || descHit ? '' : 'none';
    });
  };
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyFilter();
    if (e.key === 'Escape') {
      findInput.value = '';
      applyFilter();
    }
  });

  // 接管页面
  document.head && document.head.appendChild(style);
  if (!document.head) document.documentElement.appendChild(style);
  document.body.replaceChildren(root);
  document.body.style.margin = '0';
})();
