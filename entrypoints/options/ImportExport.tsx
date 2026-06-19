import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { Banner, Button, Input, Label, Modal, Select, cx } from '@/components/ui';
import { api } from '@/lib/messaging';
import type { ImportFormat, ImportMode } from '@/lib/types';

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
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
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
              tab === t ? 'bg-white shadow-sm' : 'text-gray-500',
            )}
          >
            {t === 'export' ? '导出' : '导入'}
          </button>
        ))}
      </div>
      {tab === 'export' ? <ExportTab /> : <ImportTab onImported={onImported} />}
    </Modal>
  );
}

function ExportTab() {
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const exportEncrypted = async () => {
    setMsg(null);
    if (pw.length < 8) return setMsg('备份密码至少 8 位');
    const res = await api.export('encrypted', pw);
    download(res.filename, res.mime, res.content);
    setMsg('已导出加密备份');
  };
  const exportPlain = async (mode: 'json' | 'csv') => {
    const res = await api.export(mode);
    download(res.filename, res.mime, res.content);
    setMsg(`已导出明文 ${mode.toUpperCase()}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-800">加密备份（推荐）</h3>
        <p className="mt-1 text-xs text-gray-500">
          整库密文 + KDF 参数，用一个备份密码加密。适合设备间迁移与离线备份，文件即使泄露也无法被解密。
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
  csv: '明文 CSV（本扩展导出）',
  'chrome-csv': 'Chrome 密码 CSV',
  'bitwarden-csv': 'Bitwarden CSV',
};

function ImportTab({ onImported }: { onImported: () => Promise<void> }) {
  const [format, setFormat] = useState<ImportFormat>('encrypted');
  const [mode, setMode] = useState<ImportMode>('merge');
  const [content, setContent] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setContent(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const run = async () => {
    setMsg(null);
    if (!content.trim()) return setMsg({ tone: 'error', text: '请先选择文件或粘贴内容' });
    setBusy(true);
    try {
      const { imported } = await api.import(
        format,
        content,
        mode,
        format === 'encrypted' ? pw : undefined,
      );
      await onImported();
      setMsg({ tone: 'info', text: `导入成功，新增 ${imported} 个账号` });
      setContent('');
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

      <div>
        <Label>选择文件</Label>
        <input
          type="file"
          accept=".json,.csv,text/csv,application/json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) readFile(f);
          }}
          className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm hover:file:bg-gray-200"
        />
      </div>

      <div>
        <Label>或直接粘贴内容</Label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          className="w-full rounded-lg border border-gray-300 p-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          placeholder="粘贴 JSON / CSV 内容"
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
