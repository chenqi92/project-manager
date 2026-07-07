import { useState } from 'react';
import { Braces, Copy, FolderGit2, KeyRound, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { Button, Modal, Segmented, Toggle, cx } from '@/components/ui';
import { requestHost } from '@/lib/feeds';
import type { VaultData } from '@/lib/types';
import { JsonTreeView, parseJson } from './JsonView';
import { CnbPage } from './CnbPage';

type Tab = 'pw' | 'json' | 'api' | 'cnb';

/** 网页 JSON 自动格式化开关：返回错误信息（null 表示成功）。 */
export type SetJsonViewer = (next: boolean) => Promise<string | null>;

export function ToolsModal({
  onClose,
  onCopy,
  embedded,
  networkEnabled,
  onEnableNetwork,
  jsonViewerEnabled,
  onSetJsonViewer,
  data,
  onSave,
}: {
  onClose: () => void;
  onCopy: (text: string, what: string) => void;
  embedded?: boolean;
  networkEnabled: boolean;
  onEnableNetwork: () => void;
  jsonViewerEnabled: boolean;
  onSetJsonViewer: SetJsonViewer;
  data: VaultData;
  onSave: (next: VaultData) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('pw');

  const body = (
    <div className="flex flex-col gap-[18px] lg:flex-row lg:items-start">
      <div className="flex w-full shrink-0 flex-col gap-1.5 lg:w-[194px]">
        <ToolNav active={tab === 'pw'} onClick={() => setTab('pw')} icon={<KeyRound size={16} />} label="密码工具" />
        <ToolNav active={tab === 'json'} onClick={() => setTab('json')} icon={<Braces size={16} />} label="JSON 格式化" />
        <ToolNav active={tab === 'api'} onClick={() => setTab('api')} icon={<Zap size={16} />} label="接口测试" />
        <ToolNav active={tab === 'cnb'} onClick={() => setTab('cnb')} icon={<FolderGit2 size={16} />} label="代码仓库 · CNB" />
        <div className="mt-1.5 rounded-[11px] border border-gray-200 bg-surface p-3 text-[11px] leading-relaxed text-gray-400">
          密码工具 / JSON 格式化纯本地；接口测试需先在「设置 → 联网功能」开启；代码仓库（CNB）需填访问令牌并授权 api.cnb.cool。
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {tab === 'pw' && <PwTools onCopy={onCopy} />}
        {tab === 'json' && (
          <JsonTool
            onCopy={onCopy}
            jsonViewerEnabled={jsonViewerEnabled}
            onSetJsonViewer={onSetJsonViewer}
          />
        )}
        {tab === 'api' && (
          <ApiTester networkEnabled={networkEnabled} onEnableNetwork={onEnableNetwork} onCopy={onCopy} />
        )}
        {tab === 'cnb' && <CnbPage embedded data={data} onSave={onSave} onCopy={onCopy} />}
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
        active ? 'bg-brand-50 text-prid' : 'text-gray-600 hover:bg-gray-100',
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

// ============================ JSON 格式化 ============================

function JsonTool({
  onCopy,
  jsonViewerEnabled,
  onSetJsonViewer,
}: {
  onCopy: (text: string, what: string) => void;
  jsonViewerEnabled: boolean;
  onSetJsonViewer: SetJsonViewer;
}) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<unknown>(undefined);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const format = () => {
    const r = parseJson(text);
    if (!r.ok) {
      setErr(r.error);
      setParsed(undefined);
      return;
    }
    setErr('');
    setParsed(r.value);
    // 顺手回填美化后的文本，方便复制。
    if (typeof r.value === 'object' && r.value !== null) setText(JSON.stringify(r.value, null, 2));
  };
  const minify = () => {
    const r = parseJson(text);
    if (!r.ok) return setErr(r.error);
    setErr('');
    setText(JSON.stringify(r.value));
    setParsed(r.value);
  };

  const toggleWebViewer = async (next: boolean) => {
    setMsg(null);
    setBusy(true);
    try {
      const error = await onSetJsonViewer(next);
      if (error) setMsg({ tone: 'error', text: error });
      else
        setMsg({
          tone: 'info',
          text: next ? '已开启网页 JSON 自动格式化，新打开或刷新的页面生效。' : '已关闭网页 JSON 自动格式化。',
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-[14px] border border-gray-200 bg-surface p-4">
        <div className="mb-1 flex items-center gap-2">
          <div className="text-[13px] font-bold">JSON 格式化</div>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10.5px] font-semibold text-gray-500">
            本地运算
          </span>
        </div>
        <div className="mb-3 text-[11.5px] text-gray-400">
          粘贴 JSON 后格式化为可折叠的树。可折叠/展开任意节点、复制节点值或路径；数组节点可「提取字段」列出每一项的某个 key。
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='粘贴 JSON，例如 {"list":[{"id":1,"name":"a"}]}'
          className="mb-2.5 h-[120px] w-full resize-y rounded-[11px] border-[1.5px] border-gray-200 bg-gray-50 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-gray-800 outline-none focus:border-brand-500"
        />
        <div className="mb-2 flex flex-wrap items-center gap-2.5">
          <Button onClick={format}>格式化</Button>
          <Button variant="outline" onClick={minify}>
            压缩
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setText('');
              setParsed(undefined);
              setErr('');
            }}
          >
            清空
          </Button>
          {err && <span className="text-[12px] text-danger">解析失败：{err}</span>}
        </div>
        {parsed !== undefined && <JsonTreeView value={parsed} onCopy={onCopy} />}
      </div>

      <div className="rounded-[14px] border border-gray-200 bg-surface p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold">网页 JSON 自动格式化</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-gray-400">
              开启后，当你在浏览器直接打开一个返回 JSON 的接口时，自动把响应渲染成可折叠、可复制、可提取字段的树。
              需授予 http(s) 全站访问权限；默认关闭，仅在本地处理页面内容、不发任何网络请求。
            </div>
          </div>
          <Toggle checked={jsonViewerEnabled} disabled={busy} onChange={(v) => void toggleWebViewer(v)} />
        </div>
        {msg && (
          <div
            className={cx(
              'mt-2.5 rounded-lg px-3 py-2 text-[11.5px] leading-relaxed',
              msg.tone === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-pribg text-prid',
            )}
          >
            {msg.text}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================ 接口测试 ============================

interface HeaderRow {
  id: number;
  key: string;
  value: string;
}

let headerRowSeq = 1;
const newHeaderRow = (): HeaderRow => ({ id: headerRowSeq++, key: '', value: '' });

interface ApiResp {
  status: number;
  statusText: string;
  ok: boolean;
  time: number;
  size: number;
  text: string;
  headers: Array<[string, string]>;
}

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
  const [headers, setHeaders] = useState<HeaderRow[]>([newHeaderRow()]);
  const [useBrowserUa, setUseBrowserUa] = useState(true);
  const [customUa, setCustomUa] = useState(navigator.userAgent);
  const [sendCookies, setSendCookies] = useState(false);
  const [resp, setResp] = useState<ApiResp | null>(null);
  const [respView, setRespView] = useState<'tree' | 'raw'>('tree');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const setHeader = (id: number, patch: Partial<HeaderRow>) =>
    setHeaders((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addHeader = () => setHeaders((rows) => [...rows, newHeaderRow()]);
  const removeHeader = (id: number) =>
    setHeaders((rows) => (rows.length <= 1 ? [newHeaderRow()] : rows.filter((r) => r.id !== id)));

  const send = async () => {
    setErr('');
    setResp(null);
    if (!url.trim()) return setErr('请输入 URL');
    if (!(await requestHost(url))) return setErr('未授权访问该地址');
    setBusy(true);
    const t0 = Date.now();
    try {
      const h = new Headers();
      for (const row of headers) {
        const k = row.key.trim();
        if (k) h.set(k, row.value);
      }
      // 自定义 User-Agent：扩展页已获得目标主机权限，跨源请求不过 CORS 预检，可直接改。
      if (!useBrowserUa && customUa.trim()) h.set('User-Agent', customUa.trim());
      const init: RequestInit = {
        method,
        headers: h,
        signal: AbortSignal.timeout(20000),
        credentials: sendCookies ? 'include' : 'omit',
      };
      if (method !== 'GET' && method !== 'HEAD' && body.trim()) {
        init.body = body;
        if (!h.has('Content-Type')) h.set('Content-Type', 'application/json');
      }
      const r = await fetch(url, init);
      const text = await r.text();
      const respHeaders = [...r.headers.entries()];
      setResp({
        status: r.status,
        statusText: r.statusText,
        ok: r.ok,
        time: Date.now() - t0,
        size: new Blob([text]).size,
        text,
        headers: respHeaders,
      });
      setRespView(parseJson(text).ok ? 'tree' : 'raw');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!networkEnabled) return <NetGate onEnable={onEnableNetwork} what="接口测试" />;

  const parsedResp = resp ? parseJson(resp.text) : null;

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
          options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ value: m, label: m }))}
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

      {/* 请求头 */}
      <div className="mb-3 rounded-[11px] border border-gray-200 bg-gray-50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-bold text-gray-600">请求头 Headers</span>
          <button
            onClick={addHeader}
            className="flex items-center gap-1 text-[11.5px] font-semibold text-brand-600 hover:underline"
          >
            <Plus size={13} /> 添加
          </button>
        </div>
        <div className="space-y-2">
          {headers.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <input
                value={row.key}
                onChange={(e) => setHeader(row.id, { key: e.target.value })}
                placeholder="Header 名，如 Authorization"
                className="h-9 w-[42%] min-w-0 rounded-[9px] border border-gray-200 bg-surface px-3 font-mono text-[12px] text-gray-800 outline-none focus:border-brand-500"
              />
              <input
                value={row.value}
                onChange={(e) => setHeader(row.id, { value: e.target.value })}
                placeholder="值，如 Bearer xxx"
                className="h-9 min-w-0 flex-1 rounded-[9px] border border-gray-200 bg-surface px-3 font-mono text-[12px] text-gray-800 outline-none focus:border-brand-500"
              />
              <button
                onClick={() => removeHeader(row.id)}
                title="删除该行"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-gray-200 bg-surface text-gray-400 hover:bg-gray-100 hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* User-Agent / 凭据 */}
        <div className="mt-3 space-y-2 border-t border-gray-200 pt-3">
          <label className="flex items-center gap-2 text-[12px] text-gray-600">
            <Toggle checked={useBrowserUa} onChange={setUseBrowserUa} />
            使用当前浏览器 User-Agent
          </label>
          {!useBrowserUa && (
            <input
              value={customUa}
              onChange={(e) => setCustomUa(e.target.value)}
              placeholder="自定义 User-Agent"
              className="h-9 w-full rounded-[9px] border border-gray-200 bg-surface px-3 font-mono text-[11.5px] text-gray-800 outline-none focus:border-brand-500"
            />
          )}
          <label className="flex items-center gap-2 text-[12px] text-gray-600">
            <Toggle checked={sendCookies} onChange={setSendCookies} />
            携带 Cookie 凭据（credentials: include）
          </label>
        </div>
      </div>

      {method !== 'GET' && method !== 'HEAD' && (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="请求体（可选，默认按 JSON 发送）"
          className="mb-3 h-[76px] w-full resize-y rounded-[11px] border-[1.5px] border-gray-200 bg-gray-50 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-gray-800 outline-none focus:border-brand-500"
        />
      )}
      {err && <p className="mb-2 text-[12px] text-danger">{err}</p>}
      {resp && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2.5">
            <span
              className={cx(
                'rounded-full px-2.5 py-0.5 text-[11px] font-bold',
                resp.ok ? 'bg-okbg text-ok' : 'bg-dangerbg text-danger',
              )}
            >
              {resp.status} {resp.statusText}
            </span>
            <span className="text-[11.5px] text-gray-400">耗时 {resp.time}ms</span>
            <span className="text-[11.5px] text-gray-400">
              {resp.size < 1024 ? `${resp.size} B` : `${(resp.size / 1024).toFixed(1)} KB`}
            </span>
            {parsedResp?.ok && typeof parsedResp.value === 'object' && parsedResp.value !== null && (
              <Segmented
                value={respView}
                onChange={setRespView}
                options={[
                  { value: 'tree', label: '树形' },
                  { value: 'raw', label: '原始' },
                ]}
              />
            )}
            <button
              onClick={() => onCopy(resp.text, '响应')}
              className="ml-auto text-[11.5px] font-semibold text-brand-600 hover:underline"
            >
              复制响应
            </button>
          </div>

          {resp.headers.length > 0 && (
            <details className="mb-2 rounded-[11px] border border-gray-200 bg-gray-50 px-3 py-2">
              <summary className="cursor-pointer text-[11.5px] font-semibold text-gray-500">
                响应头（{resp.headers.length}）
              </summary>
              <div className="mt-2 space-y-0.5 font-mono text-[11.5px]">
                {resp.headers.map(([k, v]) => (
                  <div key={k} className="flex gap-2 break-all">
                    <span className="shrink-0 text-violet-600 dark:text-violet-400">{k}:</span>
                    <span className="text-gray-700 dark:text-gray-200">{v}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {respView === 'tree' && parsedResp?.ok ? (
            <JsonTreeView value={parsedResp.value} onCopy={onCopy} />
          ) : (
            <pre className="max-h-[360px] overflow-auto rounded-[11px] bg-[#1a1d23] p-3.5 font-mono text-[12px] leading-relaxed text-[#e6e8ee]">
              {resp.text.slice(0, 200000)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

