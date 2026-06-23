// ---------------------------------------------------------------------------
// Markdown 渲染：marked 解析 -> DOMPurify 消毒 -> 注入。
// 代码块用样式化 <pre><code>；```mermaid 流程图用 IntersectionObserver 懒渲染
// （滚动到可视区才加载 mermaid 并绘制），失败则降级为源码 + 提示（不影响其余文档）。
// 额外提供：标题锚点 + 目录回调（onToc）、文档内搜索高亮（searchTerm/searchActive）。
// 严格 CSP 下安全：DOMPurify 去掉脚本/事件属性，扩展页 CSP 亦禁内联脚本执行。
// ---------------------------------------------------------------------------
import { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

let mermaidSeq = 0;

function slugify(text: string, used: Set<string>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      // 保留中日韩、字母数字、下划线、连字符；其余转连字符
      .replace(/[^\w一-龥\- ]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section';
  let id = base;
  let i = 1;
  while (used.has(id)) id = `${base}-${i++}`;
  used.add(id);
  return id;
}

/** 给标题加稳定 id，并抽出目录。 */
function assignHeadingIds(root: HTMLElement): TocItem[] {
  const used = new Set<string>();
  const toc: TocItem[] = [];
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    const text = (h.textContent ?? '').trim();
    if (!text) return;
    const id = slugify(text, used);
    h.id = id;
    toc.push({ id, text, level: Number(h.tagName[1]) });
  });
  return toc;
}

/** mermaid 懒渲染：仅在块进入视口附近时加载并绘制，大文档不会一次性卡住。 */
function setupLazyMermaid(root: HTMLElement, isCancelled: () => boolean): () => void {
  const blocks = Array.from(root.querySelectorAll('code.language-mermaid'));
  if (blocks.length === 0) return () => {};

  let mermaidMod: typeof import('mermaid').default | null = null;
  let loading: Promise<void> | null = null;
  const ensureMermaid = async () => {
    if (mermaidMod) return;
    if (!loading) {
      loading = (async () => {
        const m = (await import('mermaid')).default;
        m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
        mermaidMod = m;
      })().catch(() => {});
    }
    await loading;
  };

  const renderOne = async (code: Element) => {
    const host = (code.closest('pre') as HTMLElement) ?? (code as HTMLElement);
    const src = code.textContent ?? '';
    await ensureMermaid();
    if (isCancelled() || !mermaidMod || !host.isConnected) return;
    try {
      const { svg } = await mermaidMod.render(`mmd-${mermaidSeq++}`, src);
      if (isCancelled() || !host.isConnected) return;
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-rendered';
      wrap.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      host.replaceWith(wrap);
    } catch {
      if (isCancelled() || !host.isConnected) return;
      const note = document.createElement('div');
      note.className = 'mermaid-error';
      note.textContent = '流程图渲染失败，显示源码：';
      host.before(note);
    }
  };

  const io = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        const code =
          (entry.target as HTMLElement).querySelector('code.language-mermaid') ?? entry.target;
        void renderOne(code);
      }
    },
    { rootMargin: '200px' },
  );
  for (const code of blocks) {
    const host = (code.closest('pre') as HTMLElement) ?? (code as HTMLElement);
    io.observe(host);
  }
  return () => io.disconnect();
}

/** 清除上一次的搜索高亮（把 <mark.md-hit> 还原为文本）。 */
function clearHighlights(root: HTMLElement): void {
  const marks = root.querySelectorAll('mark.md-hit');
  if (marks.length === 0) return;
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (parent) parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
  });
  root.normalize();
}

/** 在文本节点里高亮所有匹配，返回高亮元素（用于上一个/下一个跳转）。 */
function applyHighlights(root: HTMLElement, term: string): HTMLElement[] {
  const q = term.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(lower)) {
        return NodeFilter.FILTER_REJECT;
      }
      const p = node.parentElement;
      if (!p || p.closest('svg, .mermaid-rendered, mark.md-hit, code.language-mermaid')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  const hits: HTMLElement[] = [];
  for (const textNode of targets) {
    const text = textNode.nodeValue ?? '';
    const lowerText = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let idx = 0;
    let pos = lowerText.indexOf(lower, idx);
    while (pos !== -1) {
      if (pos > idx) frag.appendChild(document.createTextNode(text.slice(idx, pos)));
      const mark = document.createElement('mark');
      mark.className = 'md-hit';
      mark.textContent = text.slice(pos, pos + q.length);
      frag.appendChild(mark);
      hits.push(mark);
      idx = pos + q.length;
      pos = lowerText.indexOf(lower, idx);
    }
    if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  return hits;
}

function updateActive(hits: HTMLElement[], idx: number): void {
  hits.forEach((h, i) => h.classList.toggle('md-hit-active', i === idx));
  const cur = hits[idx];
  if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function Markdown({
  source,
  onToc,
  searchTerm = '',
  searchActive = 0,
  onSearchHits,
}: {
  source: string;
  /** 渲染完成后回传标题目录 */
  onToc?: (toc: TocItem[]) => void;
  /** 文档内搜索词；非空时高亮所有匹配 */
  searchTerm?: string;
  /** 当前高亮项序号（用于上一个/下一个跳转） */
  searchActive?: number;
  /** 回传匹配数量 */
  onSearchHits?: (count: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hitsRef = useRef<HTMLElement[]>([]);
  const onTocRef = useRef(onToc);
  const onHitsRef = useRef(onSearchHits);
  const termRef = useRef(searchTerm);
  onTocRef.current = onToc;
  onHitsRef.current = onSearchHits;
  termRef.current = searchTerm;

  // 解析 + 注入；source 变化时重建
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let disposeMermaid = () => {};
    void (async () => {
      const html = await marked.parse(source ?? '', { gfm: true, breaks: true });
      const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
      if (cancelled || !ref.current) return;
      el.innerHTML = clean;
      el.querySelectorAll('a[href]').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noreferrer noopener');
      });
      onTocRef.current?.(assignHeadingIds(el));
      const hits = applyHighlights(el, termRef.current);
      hitsRef.current = hits;
      onHitsRef.current?.(hits.length);
      updateActive(hits, 0);
      disposeMermaid = setupLazyMermaid(el, () => cancelled);
    })();
    return () => {
      cancelled = true;
      disposeMermaid();
    };
  }, [source]);

  // 搜索词变化：重建高亮
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    clearHighlights(el);
    const hits = applyHighlights(el, searchTerm);
    hitsRef.current = hits;
    onHitsRef.current?.(hits.length);
  }, [searchTerm]);

  // 当前高亮项变化：滚动定位
  useEffect(() => {
    updateActive(hitsRef.current, searchActive);
  }, [searchActive, searchTerm]);

  return <div ref={ref} className="md-body" />;
}
