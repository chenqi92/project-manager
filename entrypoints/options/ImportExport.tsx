import { useRef, useState } from 'react';
import { AlertTriangle, Lock, Upload } from 'lucide-react';
import { useDialog } from '@/components/Dialog';
import { Banner, Button, Input, Label, Modal, Select, cx } from '@/components/ui';
import { api } from '@/lib/messaging';
import { decodeQrImage } from '@/lib/qr';
import type { ImportFormat, ImportMode, VaultData } from '@/lib/types';

function download(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function errorText(e: unknown, fallback: string): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.trim() || fallback;
}

export function ImportExport({
  data,
  onClose,
  onImported,
  onBackedUp,
  embedded,
}: {
  data: VaultData;
  onClose: () => void;
  onImported: () => Promise<void>;
  onBackedUp?: () => void;
  embedded?: boolean;
}) {
  const body = (
    <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-2">
      <ImportCard onImported={onImported} />
      <ExportCard data={data} onBackedUp={onBackedUp} />
    </div>
  );
  if (embedded) {
    return (
      <div className="flex-1 overflow-auto p-6">{body}</div>
    );
  }
  return (
    <Modal title="导入 / 导出" onClose={onClose} wide>
      {body}
    </Modal>
  );
}

// --------------------------- 导出 ---------------------------

function ExportCard({ data, onBackedUp }: { data: VaultData; onBackedUp?: () => void }) {
  const { confirm } = useDialog();
  const [msg, setMsg] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(true);
  const allIds = data.projects.map((p) => p.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds));

  const scopeIds = selected.size === allIds.length ? undefined : [...selected];
  const scopeNote = scopeIds ? `（${selected.size} 个项目）` : '（全部）';
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exportEncrypted = async (pw: string) => {
    setMsg(null);
    if (selected.size === 0) return setMsg('请至少选择一个项目');
    if (pw.length < 8) return setMsg('备份密码至少 8 位');
    const res = await api.export('encrypted', pw, scopeIds);
    download(res.filename, res.mime, res.content);
    if (!scopeIds) onBackedUp?.();
    setPwOpen(false);
    setMsg(`已导出加密备份${scopeNote}`);
  };
  const exportPlain = async (mode: 'json' | 'csv') => {
    setMsg(null);
    if (selected.size === 0) return setMsg('请至少选择一个项目');
    const ok = await confirm({
      message: `即将导出明文 ${mode.toUpperCase()}${scopeNote}，文件内含可直接读取的密码。请确认并妥善保管、用后尽快删除。`,
      danger: true,
      confirmText: '仍要导出',
    });
    if (!ok) return;
    const res = await api.export(mode, undefined, scopeIds);
    download(res.filename, res.mime, res.content);
    setMsg(`已导出明文 ${mode.toUpperCase()}${scopeNote}`);
  };

  return (
    <div className="rounded-[14px] border border-gray-200 bg-surface p-[18px]">
      <div className="text-[13px] font-bold">导出</div>
      <div className="mt-1 mb-3.5 text-[11.5px] text-gray-400">
        加密备份带独立备份密码，文件名后缀 .pem.enc，与明文导出清晰区分。
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <button
          onClick={() => setPwOpen(true)}
          className="flex flex-col items-start gap-1.5 rounded-[11px] border-[1.5px] border-pri bg-pribg p-3.5 text-left"
        >
          <Lock size={18} className="text-prid" />
          <span className="text-[12.5px] font-semibold text-prid">加密整库备份</span>
          <span className="text-[10.5px] text-gray-400">推荐 · .pem.enc</span>
        </button>
        <PlainBtn label="明文 JSON" onClick={() => exportPlain('json')} />
        <PlainBtn label="明文 CSV" onClick={() => exportPlain('csv')} />
      </div>

      <button
        onClick={() => setScopeOpen((s) => !s)}
        className="mt-3 text-[11.5px] font-semibold text-brand-600 hover:underline"
      >
        导出范围：{scopeIds ? `${selected.size} 个项目` : '全部项目'} {scopeOpen ? '▾' : '▸'}
      </button>
      {scopeOpen && (
        <div className="mt-2 rounded-[11px] border border-gray-200 p-2.5">
          <button
            onClick={() => setSelected(new Set(selected.size === allIds.length ? [] : allIds))}
            className="mb-1.5 text-[11px] text-brand-600 hover:underline"
          >
            {selected.size === allIds.length ? '全不选' : '全选'}
          </button>
          <div className="flex max-h-40 flex-col gap-1 overflow-auto">
            {data.projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-[12.5px] text-gray-700">
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="truncate">{p.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {msg && (
        <div className="mt-3">
          <Banner tone="info">{msg}</Banner>
        </div>
      )}

      {pwOpen && <ExportPwModal onClose={() => setPwOpen(false)} onExport={exportEncrypted} />}
    </div>
  );
}

function PlainBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-1.5 rounded-[11px] border border-gray-200 bg-surface p-3.5 text-left hover:bg-gray-50"
    >
      <AlertTriangle size={18} className="text-warn" />
      <span className="text-[12.5px] font-semibold">{label}</span>
      <span className="text-[10.5px] text-warn">危险 · 需确认</span>
    </button>
  );
}

function ExportPwModal({
  onClose,
  onExport,
}: {
  onClose: () => void;
  onExport: (pw: string) => Promise<void>;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="加密整库备份" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-gray-500">
          用一个独立的备份密码加密整库。文件即使泄露也无法被解密，导入时需输入该密码。
        </p>
        <div>
          <Label>备份密码（≥8 位，可与主密码不同）</Label>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onExport(pw);
              } finally {
                setBusy(false);
              }
            }}
          >
            导出
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// --------------------------- 导入 / 迁移 ---------------------------

const FORMAT_LABELS: Record<ImportFormat, string> = {
  encrypted: '加密备份（本扩展导出）',
  json: '明文 JSON（本扩展导出）',
  csv: '明文 CSV（本扩展导出，含 TOTP）',
  'chrome-csv': 'Chrome 密码 CSV',
  'bitwarden-csv': 'Bitwarden CSV（含 TOTP）',
  '1password-csv': '1Password CSV（含 TOTP）',
  'google-authenticator': 'Google Authenticator 迁移码 / 二维码',
};

const SOURCE_TAG: Record<ImportFormat, { tag: string; color: string }> = {
  encrypted: { tag: 'ENC', color: '#0d9488' },
  json: { tag: 'JSON', color: '#5b6472' },
  csv: { tag: 'CSV', color: '#5b6472' },
  'chrome-csv': { tag: 'CR', color: '#2c84c8' },
  'bitwarden-csv': { tag: 'BW', color: '#2563eb' },
  '1password-csv': { tag: '1P', color: '#4f63d2' },
  'google-authenticator': { tag: 'GA', color: '#15a34a' },
};

function ImportCard({ onImported }: { onImported: () => Promise<void> }) {
  const [format, setFormat] = useState<ImportFormat>('encrypted');
  const [mode, setMode] = useState<ImportMode>('merge');
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const clearFile = () => {
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const resolvePayload = async (): Promise<string> => {
    if (file) {
      if (format === 'google-authenticator' && file.type.startsWith('image/')) {
        return (await decodeQrImage(file)).trim();
      }
      return (await file.text()).trim();
    }
    return content.trim();
  };

  const run = async () => {
    setMsg(null);
    let payload: string;
    try {
      payload = await resolvePayload();
    } catch (e) {
      return setMsg({
        tone: 'error',
        text: errorText(e, '读取导入内容失败，请重新选择文件或粘贴内容'),
      });
    }
    if (!payload) return setMsg({ tone: 'error', text: '请先选择文件或粘贴内容' });
    if (format === 'encrypted' && !pw) {
      return setMsg({ tone: 'error', text: '请输入备份密码才能导入加密备份' });
    }
    setBusy(true);
    try {
      const { imported } = await api.import(
        format,
        payload,
        mode,
        format === 'encrypted' ? pw : undefined,
      );
      await onImported();
      setMsg({
        tone: 'info',
        text:
          mode === 'replace' ? `导入成功，共 ${imported} 个账号` : `导入成功，新增 ${imported} 个账号`,
      });
      setContent('');
      clearFile();
    } catch (e) {
      setMsg({
        tone: 'error',
        text: errorText(
          e,
          format === 'encrypted'
            ? '导入失败：请检查备份密码是否正确，以及文件是否为本扩展导出的加密备份'
            : '导入失败：请检查文件内容与导入类型是否匹配',
        ),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[14px] border border-gray-200 bg-surface p-[18px]">
      <div className="text-[13px] font-bold">导入 / 迁移</div>
      <div className="mt-1 mb-3.5 text-[11.5px] text-gray-400">
        合并模式按名称去重增量追加；替换模式会清空后导入。选择来源后在下方提供文件或粘贴内容。
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {(Object.keys(FORMAT_LABELS) as ImportFormat[]).map((f) => {
          const tg = SOURCE_TAG[f];
          const active = format === f;
          return (
            <button
              key={f}
              onClick={() => {
                setFormat(f);
                setMsg(null);
              }}
              className={cx(
                'flex flex-col items-center gap-1.5 rounded-[11px] border p-3 text-center transition',
                active
                  ? 'border-brand-600 bg-surface ring-2 ring-brand-500/30'
                  : 'border-gray-200 bg-gray-50 hover:bg-gray-100',
              )}
            >
              <span
                className="flex h-8 w-8 items-center justify-center rounded-[9px] border border-gray-200 bg-surface text-[11px] font-bold"
                style={{ color: tg.color }}
              >
                {tg.tag}
              </span>
              <span className={cx('text-[11px] leading-snug', active ? 'font-semibold text-brand-700' : 'text-gray-700')}>
                {FORMAT_LABELS[f]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3.5 flex flex-col gap-3 border-t border-gray-100 pt-3.5">
        <div>
          <Label>合并方式</Label>
          <Select value={mode} onChange={(e) => setMode(e.target.value as ImportMode)}>
            <option value="merge">合并（按名称去重追加）</option>
            <option value="replace">替换（清空后导入）</option>
          </Select>
        </div>

        {format === 'encrypted' && (
          <div>
            <Label>备份密码</Label>
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </div>
        )}

        {format === 'google-authenticator' && (
          <Banner tone="info">
            手机 Google Authenticator →「转移账号」会显示二维码：截图后在下方上传图片即可批量导入；
            也可粘贴解出的 <code>otpauth-migration://</code> 文本。
          </Banner>
        )}

        <div>
          <Label>{format === 'google-authenticator' ? '选择文件 / 二维码图片' : '选择文件'}</Label>
          <input
            ref={fileInput}
            type="file"
            accept={
              format === 'google-authenticator' ? 'image/*,.txt' : '.json,.csv,text/csv,application/json'
            }
            onChange={(e) => {
              setMsg(null);
              setFile(e.target.files?.[0] ?? null);
            }}
            className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm hover:file:bg-gray-200"
          />
          {file && (
            <p className="mt-1 text-[11px] text-gray-500">
              将导入：<b>{file.name}</b>
              <button onClick={clearFile} className="ml-2 text-brand-600 hover:underline">
                清除
              </button>
            </p>
          )}
        </div>

        <div>
          <Label>或直接粘贴内容（已选文件时以文件为准）</Label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            disabled={!!file}
            className="w-full rounded-lg border border-gray-300 p-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-50 disabled:text-gray-400"
            placeholder={
              format === 'google-authenticator'
                ? 'otpauth-migration://offline?data=...'
                : '粘贴 JSON / CSV 内容'
            }
          />
        </div>

        {mode === 'replace' && <Banner tone="warn">替换模式会清空现有全部项目，请谨慎操作。</Banner>}
        {msg && <Banner tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Banner>}

        <Button disabled={busy} onClick={run} className="self-end">
          <Upload size={16} /> 开始导入
        </Button>
      </div>
    </div>
  );
}
