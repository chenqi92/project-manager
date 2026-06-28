// ---------------------------------------------------------------------------
// 每卡配置面板：自定义标题 + 数据绑定（项目过滤 / 文档选择 / 仅收藏 / 默认揭示）
// + 天气城市单位、图片上传等卡片专属设置。写回 widget.config（随加密 vault 存储）。
// 在编辑模式下点磁贴右上角 ⚙ 进入——磁贴本体不可点（用于拖动），故配置统一在此设。
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import { Check, Upload } from 'lucide-react';
import { Button, Label, Modal, Select, cx } from '@/components/ui';
import { Input } from '@/components/ui';
import { widgetLabel } from './registry';
import { HOTLIST_SOURCES, hasHost, hotlistUrl, requestHost, stocksProbeUrl } from '@/lib/feeds';
import type { DashWidget, VaultData } from '@/lib/types';

const HAS_PROJECT: DashWidget['type'][] = ['launcher', 'repos', 'totp', 'doc'];
const HAS_FAVORITE: DashWidget['type'][] = ['launcher', 'repos'];
const HAS_REVEAL: DashWidget['type'][] = ['totp'];
const MAX_IMG_BYTES = 1.5 * 1024 * 1024;

export function ConfigModal({
  widget,
  data,
  onClose,
  onConfig,
}: {
  widget: DashWidget;
  data: VaultData;
  onClose: () => void;
  onConfig: (cfg: NonNullable<DashWidget['config']>) => void;
}) {
  const cfg = widget.config ?? {};
  const [label, setLabel] = useState(cfg.label ?? '');
  const [projectId, setProjectId] = useState(cfg.projectId ?? '');
  const [docId, setDocId] = useState(cfg.docId ?? '');
  const [onlyFavorite, setOnlyFavorite] = useState(!!cfg.onlyFavorite);
  const [reveal, setReveal] = useState(!!cfg.reveal);
  const [city, setCity] = useState(cfg.city ?? '');
  const [unit, setUnit] = useState<'c' | 'f'>(cfg.unit === 'f' ? 'f' : 'c');
  const [dataUrl, setDataUrl] = useState(cfg.dataUrl ?? '');
  const [caption, setCaption] = useState(cfg.caption ?? '');
  const [imgErr, setImgErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const type = widget.type;
  // 联网磁贴（hotlist / stocks）：来源 + 自定义 URL + 条数 + 股票代码 + 授权状态。
  const [source, setSource] = useState(cfg.source ?? (type === 'stocks' ? 'builtin' : 'zhihu'));
  const [sourceUrl, setSourceUrl] = useState(cfg.sourceUrl ?? '');
  const [count, setCount] = useState(String(cfg.count ?? 10));
  const [symbols, setSymbols] = useState(cfg.symbols ?? '');
  const [authed, setAuthed] = useState<boolean | null>(null);

  const probeUrl =
    type === 'hotlist'
      ? hotlistUrl(source, sourceUrl)
      : type === 'stocks'
        ? stocksProbeUrl(source, sourceUrl)
        : null;
  useEffect(() => {
    if (!probeUrl) {
      setAuthed(null);
      return;
    }
    let alive = true;
    hasHost(probeUrl).then((ok) => alive && setAuthed(ok));
    return () => {
      alive = false;
    };
  }, [probeUrl]);
  const authorize = async () => {
    if (!probeUrl) return;
    setAuthed(await requestHost(probeUrl));
  };
  const docProject = data.projects.find((p) => p.id === projectId);
  const docs = type === 'doc' ? (docProject ? docProject.docs ?? [] : data.projects.flatMap((p) => p.docs ?? [])) : [];

  const pickImage = (file: File) => {
    setImgErr(null);
    if (!file.type.startsWith('image/')) return setImgErr('请选择图片文件');
    if (file.size > MAX_IMG_BYTES) return setImgErr('图片过大（上限 1.5MB），请压缩后再上传');
    const reader = new FileReader();
    reader.onerror = () => setImgErr('图片读取失败，请重试');
    reader.onload = () => setDataUrl(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  };

  const save = () => {
    onConfig({
      label: label.trim() || undefined,
      projectId: HAS_PROJECT.includes(type) ? projectId || undefined : cfg.projectId,
      docId: type === 'doc' ? docId || undefined : cfg.docId,
      onlyFavorite: HAS_FAVORITE.includes(type) ? onlyFavorite : cfg.onlyFavorite,
      reveal: HAS_REVEAL.includes(type) ? reveal : cfg.reveal,
      city: type === 'weather' ? city.trim() || undefined : cfg.city,
      unit: type === 'weather' ? unit : cfg.unit,
      dataUrl: type === 'image' ? dataUrl || undefined : cfg.dataUrl,
      caption: type === 'image' ? caption.trim() || undefined : cfg.caption,
      source: type === 'hotlist' || type === 'stocks' ? source : cfg.source,
      sourceUrl:
        type === 'hotlist' || type === 'stocks' ? sourceUrl.trim() || undefined : cfg.sourceUrl,
      count:
        type === 'hotlist' || type === 'cnb'
          ? Math.max(1, Math.min(30, Number(count) || 10))
          : cfg.count,
      symbols: type === 'stocks' ? symbols.trim() || undefined : cfg.symbols,
    });
    onClose();
  };

  const authBlock = probeUrl ? (
    <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
      {authed ? (
        <span className="flex items-center gap-1.5 text-[12px] text-ok">
          <Check size={14} /> 已授权数据源
        </span>
      ) : (
        <>
          <span className="flex-1 text-[12px] text-gray-500">需授权访问数据源域名后才能取数</span>
          <Button variant="subtle" onClick={authorize}>
            授权访问
          </Button>
        </>
      )}
    </div>
  ) : null;

  return (
    <Modal title={`配置：${widgetLabel(type)}`} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <Label>标题（留空用默认）</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={widgetLabel(type)} />
        </div>

        {type === 'weather' && (
          <>
            <div>
              <Label>城市</Label>
              <Input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="如 北京 / Shanghai"
                autoFocus
              />
            </div>
            <div>
              <Label>温度单位</Label>
              <Select value={unit} onChange={(e) => setUnit(e.target.value === 'f' ? 'f' : 'c')}>
                <option value="c">摄氏 °C</option>
                <option value="f">华氏 °F</option>
              </Select>
            </div>
            <p className="text-[11px] text-gray-400">
              天气需联网获取（默认关闭，在「设置」里开启）。城市保存后随看板加密存储。
            </p>
          </>
        )}

        {type === 'image' && (
          <>
            <div>
              <Label>图片 / 图表（≤1.5MB，存进加密保险箱）</Label>
              {dataUrl ? (
                <img src={dataUrl} alt="预览" className="mb-2 max-h-40 w-full rounded-lg object-contain" />
              ) : null}
              <div className="flex items-center gap-2">
                <Button variant="subtle" onClick={() => fileRef.current?.click()}>
                  <Upload size={14} /> {dataUrl ? '更换图片' : '上传图片'}
                </Button>
                {dataUrl && (
                  <button onClick={() => setDataUrl('')} className="text-xs text-rose-600 hover:underline">
                    移除
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) pickImage(f);
                  }}
                />
              </div>
              {imgErr && <p className="mt-1 text-xs text-rose-500">{imgErr}</p>}
            </div>
            <div>
              <Label>图注（可选）</Label>
              <Input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="图片下方的说明文字" />
            </div>
          </>
        )}

        {type === 'hotlist' && (
          <>
            <div>
              <Label>来源</Label>
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                {HOTLIST_SOURCES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
                <option value="custom">自定义 URL…</option>
              </Select>
            </div>
            {source === 'custom' && (
              <div>
                <Label>自定义接口 URL（返回 JSON 列表）</Label>
                <Input
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://your.api/hot"
                />
                <p className="mt-1 text-[11px] text-gray-400">
                  兼容 {'{data:[{title,url,hot}]}'} 或 [{'{title,url}'}] 等常见形状。
                </p>
              </div>
            )}
            <div>
              <Label>显示条数</Label>
              <Input type="number" min={1} max={30} value={count} onChange={(e) => setCount(e.target.value)} />
            </div>
            {authBlock}
            <p className="text-[11px] text-gray-400">
              需在「设置 → 联网功能」开启联网后生效。内置来源为第三方开放聚合服务，授权后才会请求。
            </p>
          </>
        )}

        {type === 'stocks' && (
          <>
            <div>
              <Label>股票代码（逗号分隔）</Label>
              <Input
                value={symbols}
                onChange={(e) => setSymbols(e.target.value)}
                placeholder="AAPL, 600519.SS, 0700.HK"
                autoFocus
              />
              <p className="mt-1 text-[11px] text-gray-400">
                内置源用 Yahoo 代码：美股直接写，A 股加 .SS/.SZ，港股加 .HK。
              </p>
            </div>
            <div>
              <Label>数据源</Label>
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="builtin">内置免费源（Yahoo Finance）</option>
                <option value="custom">自定义 URL…</option>
              </Select>
            </div>
            {source === 'custom' && (
              <div>
                <Label>自定义接口 URL（含 {'{symbol}'}，返回 JSON）</Label>
                <Input
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://your.api/quote?s={symbol}"
                />
                <p className="mt-1 text-[11px] text-gray-400">
                  尽力解析 price / last / regularMarketPrice 与涨跌幅 changePct / percent / dp。
                </p>
              </div>
            )}
            {authBlock}
            <p className="text-[11px] text-gray-400">需在「设置 → 联网功能」开启联网后生效。</p>
          </>
        )}

        {type === 'cnb' && (
          <>
            <div>
              <Label>显示最近更新的仓库数</Label>
              <Input type="number" min={1} max={30} value={count} onChange={(e) => setCount(e.target.value)} />
            </div>
            <p className="text-[11px] text-gray-400">
              展示在「设置 → 代码仓库」里已配置组织的最近更新仓库。完整的子组织 / 项目浏览请打开「代码仓库」整页。
            </p>
          </>
        )}

        {HAS_PROJECT.includes(type) && (
          <div>
            <Label>限定项目</Label>
            <Select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setDocId('');
              }}
            >
              <option value="">全部项目</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        {type === 'doc' && (
          <div>
            <Label>选择文档（留空取最近更新）</Label>
            <Select value={docId} onChange={(e) => setDocId(e.target.value)}>
              <option value="">最近更新的文档</option>
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </Select>
          </div>
        )}

        {HAS_FAVORITE.includes(type) && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={onlyFavorite} onChange={(e) => setOnlyFavorite(e.target.checked)} />
            仅显示收藏的项目
          </label>
        )}

        {HAS_REVEAL.includes(type) && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
            默认显示验证码（否则遮蔽，点眼睛临时显示）
          </label>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className={cx('rounded-lg bg-gray-100 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200')}>
            取消
          </button>
          <button onClick={save} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}
