// ---------------------------------------------------------------------------
// 远端目录选择器（对齐设计 1334–1446）。
// 本轮：UI + 接入现有配置（目录层级 / 文件名）。各 provider 的「实时远端目录浏览」作后续。
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Folder, FolderPlus, Loader2, Lock, ShieldAlert, X } from 'lucide-react';
import { Button, cx } from '@/components/ui';
import { useDialog } from '@/components/Dialog';
import type { SyncTarget } from '@/lib/types';

const META: Record<
  SyncTarget['type'],
  { tag: string; name: string; bg: string; color: string; supportsApp: boolean; rootPrefix: string }
> = {
  'self-hosted': { tag: 'SH', name: '自托管服务器', bg: '#eef1f4', color: '#5b6472', supportsApp: false, rootPrefix: '/v1/vault' },
  webdav: { tag: 'WD', name: 'WebDAV', bg: '#e3f5f1', color: '#0d9488', supportsApp: false, rootPrefix: '' },
  github: { tag: 'GH', name: 'GitHub 仓库', bg: '#fff3e2', color: '#d97706', supportsApp: false, rootPrefix: '' },
  gitlab: { tag: 'GL', name: 'GitLab 仓库', bg: '#fff3e2', color: '#d97706', supportsApp: false, rootPrefix: '' },
  'google-drive': { tag: 'GD', name: 'Google Drive', bg: '#e9f8ee', color: '#15a34a', supportsApp: true, rootPrefix: '我的云端硬盘' },
  onedrive: { tag: 'OD', name: 'OneDrive', bg: '#e4f2fb', color: '#2c84c8', supportsApp: true, rootPrefix: 'OneDrive' },
  dropbox: { tag: 'DB', name: 'Dropbox', bg: '#e4ecff', color: '#2563eb', supportsApp: true, rootPrefix: 'Dropbox' },
  synology: { tag: 'NAS', name: '群晖 Synology', bg: '#f3e8fd', color: '#9333ea', supportsApp: false, rootPrefix: '' },
};

/** 从目标当前配置解析出 {目录段, 文件名}。 */
function parseDest(t: SyncTarget): { segments: string[]; filename: string } {
  const rec = t as unknown as Record<string, string | undefined>;
  if (t.type === 'google-drive' || t.type === 'onedrive' || t.type === 'dropbox') {
    return { segments: [], filename: rec.fileName || 'vault.enc' };
  }
  const raw = rec.filePath || 'vault.enc';
  const parts = raw.split('/').filter(Boolean);
  const filename = parts.pop() || 'vault.enc';
  return { segments: parts, filename };
}

/** 把选择结果写回目标对应字段，返回新的（仍含脱敏密钥占位）目标对象。 */
function applyDest(t: SyncTarget, segments: string[], filename: string): SyncTarget {
  const rec = { ...(t as unknown as Record<string, unknown>) };
  if (t.type === 'google-drive' || t.type === 'onedrive' || t.type === 'dropbox') {
    rec.fileName = filename;
  } else if (t.type === 'synology') {
    rec.filePath = '/' + [...segments, filename].filter(Boolean).join('/');
  } else if (t.type === 'webdav' || t.type === 'github' || t.type === 'gitlab') {
    rec.filePath = [...segments, filename].filter(Boolean).join('/');
  }
  return rec as unknown as SyncTarget;
}

export function DirectoryPicker({
  target,
  onClose,
  onApply,
  browse,
}: {
  target: SyncTarget;
  onClose: () => void;
  onApply: (next: SyncTarget) => Promise<void> | void;
  /** 提供则启用「连接后实时浏览」：返回该路径下的子文件夹名。 */
  browse?: (segments: string[]) => Promise<string[]>;
}) {
  const { prompt } = useDialog();
  const meta = META[target.type];
  const init = useMemo(() => parseDest(target), [target]);
  const [segments, setSegments] = useState<string[]>(init.segments);
  const [filename, setFilename] = useState(init.filename);
  const [mode, setMode] = useState<'normal' | 'app'>(
    meta.supportsApp && init.segments.length === 0 ? 'app' : 'normal',
  );
  const [busy, setBusy] = useState(false);

  const appMode = meta.supportsApp && mode === 'app';

  // 实时浏览：browse 存在且非「应用专属目录」模式时，按当前路径拉取子文件夹。
  const [entries, setEntries] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseErr, setBrowseErr] = useState<string | null>(null);
  const segKey = segments.join('/');
  useEffect(() => {
    if (!browse || appMode) return;
    let alive = true;
    setBrowsing(true);
    setBrowseErr(null);
    browse(segments)
      .then((list) => alive && setEntries(list))
      .catch((e) => alive && setBrowseErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBrowsing(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segKey, appMode]);
  const fullPath = appMode
    ? `appDataFolder（隐藏）/ ${filename}`
    : [meta.rootPrefix, ...segments, filename].filter(Boolean).join(' / ');

  const addFolder = async () => {
    const name = await prompt({ title: '新建文件夹', message: '文件夹名称', placeholder: '如 vault' });
    if (name == null) return;
    const n = name.trim().replace(/\//g, '');
    if (n) setSegments((s) => [...s, n]);
  };

  const save = async () => {
    setBusy(true);
    try {
      await onApply(applyDest(target, appMode ? [] : segments, filename));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#141a28]/40 p-6">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="pem-pop relative flex max-h-full w-[min(760px,100%)] flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
        {/* header */}
        <div className="flex items-center gap-3 border-b border-gray-200 px-[18px] py-4">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-[9px] text-[12px] font-bold"
            style={{ background: meta.bg, color: meta.color }}
          >
            {meta.tag}
          </span>
          <div className="flex-1">
            <div className="text-[14.5px] font-bold">选择存放位置</div>
            <div className="text-[11.5px] text-gray-400">{meta.name} · 整库密文将保存到此处</div>
          </div>
          <button
            onClick={onClose}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100"
          >
            <X size={15} />
          </button>
        </div>

        {/* mode */}
        {meta.supportsApp && (
          <div className="px-[18px] pt-3.5">
            <div className="flex gap-2">
              <ModeBtn
                active={mode === 'normal'}
                onClick={() => setMode('normal')}
                icon={<Folder size={15} />}
                title="普通文件夹"
                sub="网页端可见、可管理（推荐）"
              />
              <ModeBtn
                active={mode === 'app'}
                onClick={() => setMode('app')}
                icon={<Lock size={15} />}
                title="应用专属目录"
                sub="隐藏、仅本扩展可见"
              />
            </div>
          </div>
        )}

        <div className="flex min-h-[260px] gap-0 px-[18px] pt-3.5">
          {/* left: browser */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!appMode ? (
              <>
                <div className="mb-2.5 flex flex-wrap items-center gap-1">
                  <Crumb label={meta.rootPrefix || '根目录'} onClick={() => setSegments([])} />
                  {segments.map((s, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <span className="text-[11px] text-gray-400">/</span>
                      <Crumb label={s} onClick={() => setSegments(segments.slice(0, i + 1))} />
                    </span>
                  ))}
                </div>
                {browse ? (
                  <div className="max-h-[180px] overflow-y-auto rounded-[11px] border border-gray-200">
                    {browsing ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-gray-400">
                        <Loader2 size={14} className="animate-spin" /> 读取目录中…
                      </div>
                    ) : browseErr ? (
                      <div className="px-3 py-6 text-center text-[12px] text-danger">{browseErr}</div>
                    ) : entries.length === 0 ? (
                      <div className="px-3 py-6 text-center text-[12px] text-gray-400">
                        此目录下没有子文件夹，可「新建文件夹」或直接保存到此处。
                      </div>
                    ) : (
                      entries.map((name) => (
                        <button
                          key={name}
                          onClick={() => setSegments((s) => [...s, name])}
                          className="flex w-full items-center gap-2.5 border-b border-gray-100 px-3 py-2 text-left last:border-b-0 hover:bg-gray-50"
                        >
                          <Folder size={15} className="shrink-0 text-brand-600" />
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-800">{name}</span>
                          <ChevronRight size={14} className="shrink-0 text-gray-400" />
                        </button>
                      ))
                    )}
                  </div>
                ) : (
                  <div className="max-h-[180px] overflow-y-auto rounded-[11px] border border-gray-200 p-3 text-[12px] text-gray-400">
                    该数据源暂不支持实时浏览。可用「新建文件夹」逐层指定存放路径，右侧实时预览落点。
                  </div>
                )}
                <button
                  onClick={addFolder}
                  className="mt-2.5 flex h-[30px] items-center gap-1.5 self-start rounded-lg border border-dashed border-gray-300 px-3 text-[11.5px] font-semibold text-gray-600 hover:border-brand-400 hover:text-brand-600"
                >
                  <FolderPlus size={13} /> 新建文件夹
                </button>
                <div className="mt-3">
                  <label className="mb-1 block text-[11px] font-semibold text-gray-400">文件名</label>
                  <input
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    className="h-9 w-full rounded-[10px] border-[1.5px] border-gray-200 bg-gray-50 px-3 font-mono text-[12.5px] text-gray-800 outline-none focus:border-brand-500"
                  />
                </div>
              </>
            ) : (
              <div className="flex gap-3 rounded-[11px] border border-[#f0d8a8] bg-warnbg p-4">
                <ShieldAlert size={20} className="shrink-0 text-warn" />
                <div className="text-[11.5px] leading-relaxed text-[#9a6a14]">
                  <div className="text-[12.5px] font-semibold text-[#8a5a00]">将写入应用专属隐藏目录</div>
                  文件保存在 <span className="font-mono">appDataFolder</span>，你在 {meta.name}{' '}
                  网页端将看不到、也无法手动移动或备份它。卸载或撤销授权后可能无法找回——建议改用「普通文件夹」。
                </div>
              </div>
            )}
          </div>

          {/* right: preview */}
          <div className="ml-[18px] flex w-[262px] shrink-0 flex-col border-l border-gray-200 pl-[18px]">
            <div className="mb-2.5 text-[11px] font-semibold text-gray-400">落点预览</div>
            <div className="rounded-[11px] border border-gray-200 bg-gray-50 p-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-gray-200 bg-surface text-brand-600">
                  <Folder size={17} />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-mono text-[12px] font-semibold">{filename}</div>
                  <div className="text-[10px] text-gray-400">AES-GCM 加密整库</div>
                </div>
              </div>
              <div className="mt-2.5 border-t border-gray-100 pt-2.5 text-[11px]">
                <div className="mb-1 text-gray-400">完整路径</div>
                <div className="break-all font-mono leading-relaxed text-gray-800">{fullPath}</div>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2 text-[11.5px] text-gray-600">
              <PreviewCheck ok label="保存后将校验连通性" />
              <PreviewCheck ok label="保存后将校验落点可写" />
              {appMode ? (
                <PreviewCheck ok={false} label="网页端不可见（隐藏目录）" />
              ) : (
                <PreviewCheck ok label="网页端可见、可管理" />
              )}
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="mt-4 flex items-center gap-2.5 border-t border-gray-200 px-[18px] py-4">
          <div className="flex-1 text-[11px] text-gray-400">仅 refresh token 加密入库 · 不上传明文</div>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={save}>
            保存到此处
          </Button>
        </div>
      </div>
    </div>
  );
}

function ModeBtn({
  active,
  onClick,
  icon,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex flex-1 items-center gap-2.5 rounded-[11px] border px-3 py-2.5 text-left',
        active ? 'border-pri bg-pribg text-prid' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
      )}
    >
      {icon}
      <div>
        <div className="text-[12.5px] font-semibold">{title}</div>
        <div className="text-[10px] opacity-70">{sub}</div>
      </div>
    </button>
  );
}

function Crumb({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md bg-gray-50 px-2 py-0.5 text-[11.5px] font-semibold text-gray-600 hover:bg-gray-100"
    >
      {label}
    </button>
  );
}

function PreviewCheck({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cx(
          'flex h-[18px] w-[18px] items-center justify-center rounded-full',
          ok ? 'bg-okbg text-ok' : 'bg-warnbg text-warn',
        )}
      >
        {ok ? <Check size={11} /> : <ChevronRight size={11} />}
      </span>
      {label}
    </div>
  );
}
