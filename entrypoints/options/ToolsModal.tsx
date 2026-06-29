import { useState } from 'react';
import { Copy, KeyRound, RefreshCw, Type, Zap } from 'lucide-react';
import { Button, Modal, Segmented, Toggle, cx } from '@/components/ui';
import { requestHost } from '@/lib/feeds';

type Tab = 'pw' | 'api' | 'reader';

export function ToolsModal({
  onClose,
  onCopy,
  embedded,
  networkEnabled,
  onEnableNetwork,
}: {
  onClose: () => void;
  onCopy: (text: string, what: string) => void;
  embedded?: boolean;
  networkEnabled: boolean;
  onEnableNetwork: () => void;
}) {
  const [tab, setTab] = useState<Tab>('pw');

  const body = (
    <div className="flex flex-col gap-[18px] lg:flex-row lg:items-start">
      <div className="flex w-full shrink-0 flex-col gap-1.5 lg:w-[194px]">
        <ToolNav active={tab === 'pw'} onClick={() => setTab('pw')} icon={<KeyRound size={16} />} label="密码工具" />
        <ToolNav active={tab === 'api'} onClick={() => setTab('api')} icon={<Zap size={16} />} label="接口测试" />
        <ToolNav active={tab === 'reader'} onClick={() => setTab('reader')} icon={<Type size={16} />} label="网站重排" />
        <div className="mt-1.5 rounded-[11px] border border-gray-200 bg-surface p-3 text-[11px] leading-relaxed text-gray-400">
          密码工具纯本地；接口测试 / 网站重排需联网，须先在「设置 → 联网功能」开启。
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {tab === 'pw' && <PwTools onCopy={onCopy} />}
        {tab === 'api' && (
          <ApiTester networkEnabled={networkEnabled} onEnableNetwork={onEnableNetwork} onCopy={onCopy} />
        )}
        {tab === 'reader' && (
          <WebReader networkEnabled={networkEnabled} onEnableNetwork={onEnableNetwork} />
        )}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex-1 overflow-auto p-6">{body}</div>
    );
  }
  return (
    <Modal title="工具" onClose={onClose} wide>
      {body}
    </Modal>
  );
}

function ToolNav({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left text-[13px] font-semibold transition-colors',
        active ? 'bg-brand-50 text-brand-700' : 'text-gray-600 hover:bg-gray-100',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function NetGate({ onEnable, what }: { onEnable: () => void; what: string }) {
  return (
    <div className="rounded-[14px] border border-gray-200 bg-surface p-8 text-center">
      <p className="text-sm text-gray-500">{what}需联网请求，默认关闭。</p>
      <Button className="mt-3" onClick={onEnable}>
        开启联网功能
      </Button>
      <p className="mt-2 text-[11px] text-gray-400">也可在「设置 → 联网功能」里开启/关闭。</p>
    </div>
  );
}

// ============================ 密码工具 ============================

const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const NUM = '23456789';
const SYM = '!@#$%^&*()-_=+[]{}';

function genPassword(len: number, opts: { upper: boolean; num: boolean; sym: boolean }): string {
  let pool = LOWER;
  if (opts.upper) pool += UPPER;
  if (opts.num) pool += NUM;
  if (opts.sym) pool += SYM;
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += pool[arr[i]! % pool.length];
  return out;
}

function strength(pw: string): { label: string; color: string; pct: number } {
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^a-zA-Z0-9]/.test(pw)) classes++;
  const score = Math.min(100, pw.length * 4 + classes * 12);
  if (score < 45) return { label: '弱', color: 'var(--color-danger)', pct: score };
  if (score < 75) return { label: '中', color: 'var(--color-warn)', pct: score };
  return { label: '强', color: 'var(--color-ok)', pct: score };
}

function b64Encode(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function b64Decode(s: string): string {
  const bin = atob(s.trim());
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function PwTools({ onCopy }: { onCopy: (text: string, what: string) => void }) {
  const [len, setLen] = useState(20);
  const [upper, setUpper] = useState(true);
  const [num, setNum] = useState(true);
  const [sym, setSym] = useState(true);
  const [pw, setPw] = useState(() => genPassword(20, { upper: true, num: true, sym: true }));
  const regen = () => setPw(genPassword(len, { upper, num, sym }));
  const st = strength(pw);

  const [text, setText] = useState('');
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');
  const doEncode = () => {
    try {
      setOut(b64Encode(text));
      setErr('');
    } catch {
      setErr('编码失败');
    }
  };
  const doDecode = () => {
    try {
      setOut(b64Decode(text));
      setErr('');
    } catch {
      setErr('不是有效的 Base64');
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-[14px] border border-gray-200 bg-surface p-4">
        <div className="mb-3 text-[13px] font-bold">生成强密码</div>
        <div className="mb-3 flex items-center gap-2.5 rounded-[11px] border border-gray-200 bg-gray-50 px-3.5 py-3">
          <span className="min-w-0 flex-1 break-all font-mono text-[15px] font-semibold tracking-[.04em]">
            {pw}
          </span>
          <button
            onClick={regen}
            title="重新生成"
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] border border-gray-200 bg-surface text-gray-600 hover:bg-gray-100"
          >
            <RefreshCw size={15} />
          </button>
          <button
            onClick={() => onCopy(pw, '密码')}
            title="复制"
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-brand-600 text-white hover:bg-brand-700"
          >
            <Copy size={15} />
          </button>
        </div>
        <div className="mb-4 flex items-center gap-2.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
            <div className="h-full rounded-full transition-all" style={{ width: `${st.pct}%`, background: st.color }} />
          </div>
          <span className="text-[11.5px] font-bold" style={{ color: st.color }}>
            {st.label}
          </span>
        </div>
        <div className="mb-3 flex items-center gap-3">
          <span className="w-16 text-[12.5px] text-gray-600">长度 {len}</span>
          <input
            type="range"
            min={8}
            max={40}
            value={len}
            onChange={(e) => {
              const n = Number(e.target.value);
              setLen(n);
              setPw(genPassword(n, { upper, num, sym }));
            }}
            className="flex-1 accent-brand-600"
          />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {(
            [
              ['大写', upper, setUpper],
              ['数字', num, setNum],
              ['符号', sym, setSym],
            ] as const
          ).map(([label, val, set]) => (
            <label key={label} className="flex items-center gap-2 text-[12px] text-gray-600">
              <Toggle
                checked={val}
                onChange={(v) => {
                  set(v);
                  setPw(
                    genPassword(len, {
                      upper: label === '大写' ? v : upper,
                      num: label === '数字' ? v : num,
                      sym: label === '符号' ? v : sym,
                    }),
                  );
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-[14px] border border-gray-200 bg-surface p-4">
        <div className="mb-1 text-[13px] font-bold">Base64 编码 / 解码</div>
        <div className="mb-3 text-[11.5px] text-gray-400">本地运算，不上传任何内容。</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入要编码的文本，或粘贴 Base64 以解码…"
          className="mb-2.5 h-[88px] w-full resize-y rounded-[11px] border-[1.5px] border-gray-200 bg-gray-50 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-gray-800 outline-none focus:border-brand-500"
        />
        <div className="mb-3 flex gap-2.5">
          <Button onClick={doEncode}>编码</Button>
          <Button variant="outline" onClick={doDecode}>
            解码
          </Button>
          {err && <span className="self-center text-[12px] text-danger">{err}</span>}
        </div>
        {out && (
          <div className="relative rounded-[11px] bg-[#1a1d23] p-3.5">
            <div className="whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-[#e6e8ee]">
              {out}
            </div>
            <button
              onClick={() => onCopy(out, '结果')}
              className="absolute right-2.5 top-2.5 rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/20"
            >
              复制
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================ 接口测试 ============================

function ApiTester({
  networkEnabled,
  onEnableNetwork,
  onCopy,
}: {
  networkEnabled: boolean;
  onEnableNetwork: () => void;
  onCopy: (text: string, what: string) => void;
}) {
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [body, setBody] = useState('');
  const [resp, setResp] = useState<{ status: number; ok: boolean; time: number; text: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setErr('');
    setResp(null);
    if (!url.trim()) return setErr('请输入 URL');
    if (!(await requestHost(url))) return setErr('未授权访问该地址');
    setBusy(true);
    const t0 = Date.now();
    try {
      const init: RequestInit = { method, signal: AbortSignal.timeout(15000) };
      if (method !== 'GET' && body.trim()) {
        init.body = body;
        init.headers = { 'Content-Type': 'application/json' };
      }
      const r = await fetch(url, init);
      const text = await r.text();
      setResp({ status: r.status, ok: r.ok, time: Date.now() - t0, text: text.slice(0, 20000) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!networkEnabled) return <NetGate onEnable={onEnableNetwork} what="接口测试" />;

  return (
    <div className="rounded-[14px] border border-gray-200 bg-surface p-4">
      <div className="mb-1 text-[13px] font-bold">接口测试</div>
      <div className="mb-3.5 text-[11.5px] text-gray-400">
        轻量调试面板。请求由你手动发起、发往你填写的地址，发送前会申请对该域名的访问授权。
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Segmented
          value={method}
          onChange={setMethod}
          options={['GET', 'POST', 'PUT', 'DELETE'].map((m) => ({ value: m, label: m }))}
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://api.example.com/..."
          className="h-10 min-w-0 flex-1 rounded-[10px] border-[1.5px] border-gray-200 bg-gray-50 px-3.5 font-mono text-[12.5px] text-gray-800 outline-none focus:border-brand-500"
        />
        <Button disabled={busy} onClick={send}>
          {busy ? '发送中…' : '发送'}
        </Button>
      </div>
      {method !== 'GET' && (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="请求体 JSON（可选）"
          className="mb-3 h-[76px] w-full resize-y rounded-[11px] border-[1.5px] border-gray-200 bg-gray-50 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-gray-800 outline-none focus:border-brand-500"
        />
      )}
      {err && <p className="mb-2 text-[12px] text-danger">{err}</p>}
      {resp && (
        <>
          <div className="mb-2 flex items-center gap-2.5">
            <span
              className={cx(
                'rounded-full px-2.5 py-0.5 text-[11px] font-bold',
                resp.ok ? 'bg-okbg text-ok' : 'bg-dangerbg text-danger',
              )}
            >
              {resp.status}
            </span>
            <span className="text-[11.5px] text-gray-400">耗时 {resp.time}ms</span>
            <button
              onClick={() => onCopy(resp.text, '响应')}
              className="ml-auto text-[11.5px] font-semibold text-brand-600 hover:underline"
            >
              复制响应
            </button>
          </div>
          <pre className="max-h-[360px] overflow-auto rounded-[11px] bg-[#1a1d23] p-3.5 font-mono text-[12px] leading-relaxed text-[#e6e8ee]">
            {resp.text}
          </pre>
        </>
      )}
    </div>
  );
}

// ============================ 网站重排（阅读视图）============================

function WebReader({
  networkEnabled,
  onEnableNetwork,
}: {
  networkEnabled: boolean;
  onEnableNetwork: () => void;
}) {
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<{ title: string; blocks: { tag: string; text: string }[] } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setErr('');
    setResult(null);
    if (!url.trim()) return setErr('请输入网址');
    if (!(await requestHost(url))) return setErr('未授权访问该地址');
    setBusy(true);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc
        .querySelectorAll('script,style,nav,header,footer,aside,noscript,svg,form,iframe')
        .forEach((n) => n.remove());
      const root = doc.querySelector('article') || doc.querySelector('main') || doc.body;
      const title = doc.querySelector('h1')?.textContent?.trim() || doc.title || '阅读视图';
      const blocks = Array.from(root?.querySelectorAll('h2,h3,p,li,pre') ?? [])
        .map((n) => ({ tag: n.tagName.toLowerCase(), text: (n.textContent ?? '').trim() }))
        .filter((b) => b.text.length > 6)
        .slice(0, 300);
      setResult({ title, blocks });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!networkEnabled) return <NetGate onEnable={onEnableNetwork} what="网站重排" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="粘贴网页地址…"
          className="h-[42px] min-w-0 flex-1 rounded-[11px] border-[1.5px] border-gray-200 bg-surface px-3.5 font-mono text-[12.5px] text-gray-800 outline-none focus:border-brand-500"
        />
        <Button disabled={busy} onClick={run}>
          {busy ? '整理中…' : '整理排版'}
        </Button>
      </div>
      {err && <p className="text-[12px] text-danger">{err}</p>}
      {result && (
        <div className="rounded-[14px] border border-gray-200 bg-surface px-7 py-8">
          <div className="mb-1 text-[11px] font-bold tracking-[.08em] text-brand-600">阅读视图</div>
          <h1 className="mb-4 text-[22px] font-bold leading-snug">{result.title}</h1>
          <div className="space-y-3">
            {result.blocks.map((b, i) =>
              b.tag === 'h2' || b.tag === 'h3' ? (
                <h2 key={i} className="pt-1 text-[16px] font-bold">
                  {b.text}
                </h2>
              ) : b.tag === 'pre' ? (
                <pre key={i} className="overflow-auto rounded-lg bg-gray-50 p-3 font-mono text-[12px] text-gray-700">
                  {b.text}
                </pre>
              ) : (
                <p key={i} className="text-[13.5px] leading-relaxed text-gray-700">
                  {b.tag === 'li' ? `· ${b.text}` : b.text}
                </p>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
