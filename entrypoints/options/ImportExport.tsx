import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
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

export function ImportExport({
  data,
  onClose,
  onImported,
  onBackedUp,
}: {
  data: VaultData;
  onClose: () => void;
  onImported: () => Promise<void>;
  /** 成功导出一份加密备份后回调（用于记录上次备份时间）。 */
  onBackedUp?: () => void;
}) {
  const [tab, setTab] = useState<'export' | 'import'>('export');

  return (
    <Modal title="导入 / 导出" onClose={onClose} wide>
      <div className="mb-4 flex gap-1 rounded-lg bg-gray-100 p-1 text-sm">
        {(['export', 'import'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx(
              'flex-1 rounded-md py-1.5 font-medium',
              tab === t ? 'bg-surface shadow-sm' : 'text-gray-500',
            )}
          >
            {t === 'export' ? '导出' : '导入'}
          </button>
        ))}
      </div>
      {tab === 'export' ? (
        <ExportTab data={data} onBackedUp={onBackedUp} />
      ) : (
        <ImportTab onImported={onImported} />
      )}
    </Modal>
  );
}

function ExportTab({ data, onBackedUp }: { data: VaultData; onBackedUp?: () => void }) {
  const { confirm } = useDialog();
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const allIds = data.projects.map((p) => p.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds));

  // 全选时传 undefined(=整库);部分选时只传选中的项目 id。
  const scopeIds = selected.size === allIds.length ? undefined : [...selected];
  const scopeNote = scopeIds ? `（${selected.size} 个项目）` : '（全部）';
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const acctCount = (pid: string) => {
    const p = data.projects.find((x) => x.id === pid);
    return p
      ? p.environments.reduce((n, e) => n + e.links.reduce((m, l) => m + l.accounts.length, 0), 0)
      : 0;
  };

  const exportEncrypted = async () => {
    setMsg(null);
    if (selected.size === 0) return setMsg('请至少选择一个项目');
    if (pw.length < 8) return setMsg('备份密码至少 8 位');
    const res = await api.export('encrypted', pw, scopeIds);
    download(res.filename, res.mime, res.content);
    // 只有整库备份才算「有了一份完整后路」；部分项目导出不重置备份提醒。
    if (!scopeIds) onBackedUp?.();
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
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800">导出范围</h3>
          <button
            onClick={() => setSelected(new Set(selected.size === allIds.length ? [] : allIds))}
            className="text-xs text-brand-600 hover:underline"
          >
            {selected.size === allIds.length ? '全不选' : '全选'}
          </button>
        </div>
        {data.projects.length === 0 ? (
          <p className="mt-2 text-xs text-gray-400">还没有项目可导出。</p>
        ) : (
          <div className="mt-2 flex max-h-44 flex-col gap-1 overflow-auto">
            {data.projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="truncate">{p.name}</span>
                <span className="ml-auto shrink-0 text-xs text-gray-400">{acctCount(p.id)} 账号</span>
              </label>
            ))}
          </div>
        )}
        <p className="mt-1 text-[11px] text-gray-400">默认全选；只勾选部分项目即可仅导出这些。</p>
      </section>

      <section className="rounded-xl border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-800">加密备份（推荐）</h3>
        <p className="mt-1 text-xs text-gray-500">
          整库密文 + KDF 参数，用一个备份密码加密。文件即使泄露也无法被解密。
          导入时需输入该密码，且默认按名称去重「增量合并」，不会覆盖现有数据。
        </p>
        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <Label>备份密码</Label>
            <Input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="可与主密码不同"
            />
          </div>
          <Button onClick={exportEncrypted}>
            <Download size={16} /> 导出加密备份
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-800">明文导出</h3>
        <Banner tone="warn">
          明文文件包含可直接读取的密码，仅用于互通或手动编辑，导出后请妥善保管并尽快删除。
        </Banner>
        <div className="mt-3 flex gap-2">
          <Button variant="subtle" onClick={() => exportPlain('json')}>
            <Download size={16} /> 明文 JSON
          </Button>
          <Button variant="subtle" onClick={() => exportPlain('csv')}>
            <Download size={16} /> 明文 CSV
          </Button>
        </div>
      </section>

      {msg && <Banner tone="info">{msg}</Banner>}
    </div>
  );
}

const FORMAT_LABELS: Record<ImportFormat, string> = {
  encrypted: '加密备份（本扩展导出）',
  json: '明文 JSON（本扩展导出）',
  csv: '明文 CSV（本扩展导出，含 TOTP）',
  'chrome-csv': 'Chrome 密码 CSV',
  'bitwarden-csv': 'Bitwarden CSV（含 TOTP）',
  '1password-csv': '1Password CSV（含 TOTP）',
  'google-authenticator': 'Google Authenticator 迁移码 / 二维码',
};

function ImportTab({ onImported }: { onImported: () => Promise<void> }) {
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

  // 取本次导入内容：选了文件就用文件（图片走二维码解码），否则用粘贴框。
  // 在「开始导入」时才读文件（await），避免选文件后异步读取造成的竞态/误报。
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
      return setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    }
    if (!payload) return setMsg({ tone: 'error', text: '请先选择文件或粘贴内容' });
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
        text: mode === 'replace' ? `导入成功，共 ${imported} 个账号` : `导入成功，新增 ${imported} 个账号`,
      });
      setContent('');
      clearFile();
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>来源格式</Label>
          <Select value={format} onChange={(e) => setFormat(e.target.value as ImportFormat)}>
            {(Object.keys(FORMAT_LABELS) as ImportFormat[]).map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>合并方式</Label>
          <Select value={mode} onChange={(e) => setMode(e.target.value as ImportMode)}>
            <option value="merge">合并（按名称去重追加）</option>
            <option value="replace">替换（清空后导入）</option>
          </Select>
        </div>
      </div>

      {format === 'encrypted' && (
        <div>
          <Label>备份密码</Label>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
      )}

      {format === 'google-authenticator' && (
        <Banner tone="info">
          手机 Google Authenticator →「转移账号 / 导出账号」会显示一个二维码：截图后在下方上传图片即可
          批量导入其中的 TOTP；也可把二维码解出的 <code>otpauth-migration://</code> 文本粘贴到下面。
        </Banner>
      )}

      <div>
        <Label>{format === 'google-authenticator' ? '选择文件 / 二维码图片' : '选择文件'}</Label>
        <input
          ref={fileInput}
          type="file"
          accept={
            format === 'google-authenticator'
              ? 'image/*,.txt'
              : '.json,.csv,text/csv,application/json'
          }
          onChange={(e) => {
            setMsg(null);
            setFile(e.target.files?.[0] ?? null);
          }}
          className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm hover:file:bg-gray-200"
        />
        {file && (
          <p className="mt-1 text-[11px] text-gray-500">
            将导入此文件：<b>{file.name}</b>
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
          rows={5}
          disabled={!!file}
          className="w-full rounded-lg border border-gray-300 p-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-50 disabled:text-gray-400"
          placeholder={
            format === 'google-authenticator'
              ? 'otpauth-migration://offline?data=...'
              : '粘贴 JSON / CSV 内容'
          }
        />
      </div>

      {mode === 'replace' && (
        <Banner tone="warn">替换模式会清空现有全部项目，请谨慎操作。</Banner>
      )}
      {msg && <Banner tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Banner>}

      <Button disabled={busy} onClick={run} className="self-end">
        <Upload size={16} /> 开始导入
      </Button>
    </div>
  );
}
