// ---------------------------------------------------------------------------
// Markdown 渲染：marked 解析 -> DOMPurify 消毒 -> 注入。
// 代码块用样式化 <pre><code>;```mermaid 流程图按需懒加载 mermaid 渲染,
// 失败则降级为源码 + 提示(不影响其余文档)。严格 CSP 下安全:
// DOMPurify 去掉脚本/事件属性,扩展页 CSP 亦禁内联脚本执行。
// ---------------------------------------------------------------------------
import { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

let mermaidSeq = 0;

async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll('code.language-mermaid');
  if (blocks.length === 0) return;
  let mermaid: typeof import('mermaid').default;
  try {
    mermaid = (await import('mermaid')).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
  } catch {
    return; // mermaid 加载失败:保留源码块
  }
  for (const code of Array.from(blocks)) {
    const host = (code.closest('pre') as HTMLElement) ?? (code as HTMLElement);
    const src = code.textContent ?? '';
    try {
      const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, src);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-rendered';
      wrap.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      host.replaceWith(wrap);
    } catch {
      const note = document.createElement('div');
      note.className = 'mermaid-error';
      note.textContent = '流程图渲染失败，显示源码：';
      host.before(note);
    }
  }
}

export function Markdown({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const html = await marked.parse(source ?? '', { gfm: true, breaks: true });
      const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
      if (cancelled || !ref.current) return;
      el.innerHTML = clean;
      el.querySelectorAll('a[href]').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noreferrer noopener');
      });
      await renderMermaidBlocks(el);
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  return <div ref={ref} className="md-body" />;
}
