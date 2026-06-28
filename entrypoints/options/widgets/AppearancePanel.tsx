// ---------------------------------------------------------------------------
// 仪表盘外观抽屉：背景（无 / 预设渐变 / 自上传图）+ 玻璃拟态（透明度 / 模糊）。
// 背景图以 dataURL 存进加密 vault，限制 ≤1.5MB 控制体积。右侧滑入抽屉。
// ---------------------------------------------------------------------------
import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { cx } from '@/components/ui';
import { GRADIENTS, normAppearance } from '@/lib/dashboard';
import type { DashAppearance } from '@/lib/types';

const GRADIENT_NAMES: Record<string, string> = {
  aurora: '极光',
  dusk: '暮色',
  sunset: '日落',
  forest: '森林',
  mist: '薄雾',
};

export function AppearancePanel({
  appearance,
  onChange,
  onClose,
}: {
  appearance: DashAppearance;
  onChange: (next: DashAppearance) => void;
  onClose: () => void;
}) {
  const a = normAppearance(appearance);
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const patch = (p: Partial<DashAppearance>) => onChange({ ...appearance, ...p });

  const MAX = 1.5 * 1024 * 1024;
  const pick = (file: File) => {
    setErr(null);
    if (!file.type.startsWith('image/')) return setErr('请选择图片文件');
    if (file.size > MAX) return setErr('图片过大（上限 1.5MB），请压缩后再上传');
    const reader = new FileReader();
    reader.onerror = () => setErr('图片读取失败，请重试');
    reader.onload = () => patch({ bg: 'image', imageDataUrl: String(reader.result ?? '') });
    reader.readAsDataURL(file);
  };

  const swatches: Array<{ key: string; name: string; css: string }> = [
    { key: 'none', name: '无', css: 'var(--color-gray-100)' },
    ...Object.keys(GRADIENTS).map((key) => ({
      key,
      name: GRADIENT_NAMES[key] ?? key,
      css: GRADIENTS[key]!,
    })),
  ];

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-[#141a28]/30" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-[312px] flex-col border-l border-gray-200 bg-surface shadow-[-12px_0_40px_-16px_rgba(20,26,40,.3)]">
        <div className="flex items-center gap-2.5 border-b border-gray-200 px-[18px] py-4">
          <span className="flex-1 text-[14px] font-bold">外观与背景</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-[18px]">
          <div className="mb-2.5 text-xs font-semibold">背景</div>
          <div className="mb-5 grid grid-cols-3 gap-2.5">
            {swatches.map((s) => {
              const active =
                s.key === 'none' ? a.bg === 'none' : a.bg === 'gradient' && a.gradient === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() =>
                    s.key === 'none' ? patch({ bg: 'none' }) : patch({ bg: 'gradient', gradient: s.key })
                  }
                  className={cx(
                    'flex flex-col items-center gap-1.5 rounded-[11px] border-2 p-1.5',
                    active ? 'border-brand-500' : 'border-transparent hover:border-gray-200',
                  )}
                >
                  <span
                    className="h-[42px] w-full rounded-[7px] border border-gray-200"
                    style={{ background: s.css }}
                  />
                  <span
                    className={cx(
                      'text-[10.5px]',
                      active ? 'font-semibold text-gray-700' : 'text-gray-500',
                    )}
                  >
                    {s.name}
                  </span>
                </button>
              );
            })}
          </div>

          <label className="mb-2.5 flex h-[38px] cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed border-gray-200 bg-gray-50 text-[12px] font-semibold text-gray-600 hover:bg-gray-100">
            <Upload size={15} /> 上传背景图片
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) pick(f);
              }}
            />
          </label>
          {a.bg === 'image' && a.imageDataUrl && (
            <>
              <img
                src={a.imageDataUrl}
                alt="背景预览"
                className="mb-2 h-20 w-full rounded-lg object-cover"
              />
              <button
                onClick={() => patch({ bg: 'none', imageDataUrl: '' })}
                className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-[7px] text-[11.5px] font-semibold text-gray-400 hover:text-gray-600"
              >
                移除自定义背景
              </button>
            </>
          )}
          {err && <p className="mb-3 text-xs text-danger">{err}</p>}

          <div className="mt-3 mb-2 flex items-center">
            <span className="flex-1 text-xs font-semibold">磁贴不透明度</span>
            <span className="font-mono text-[11.5px] text-gray-400">{a.tileOpacity}%</span>
          </div>
          <input
            type="range"
            min={50}
            max={100}
            value={a.tileOpacity}
            onChange={(e) => patch({ tileOpacity: Number(e.target.value) })}
            className="mb-5 w-full accent-brand-600"
          />

          <div className="mb-2 flex items-center">
            <span className="flex-1 text-xs font-semibold">磁贴模糊（玻璃拟态）</span>
            <span className="font-mono text-[11.5px] text-gray-400">{a.tileBlur}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={20}
            value={a.tileBlur}
            onChange={(e) => patch({ tileBlur: Number(e.target.value) })}
            className="mb-4 w-full accent-brand-600"
          />

          <div className="rounded-[9px] bg-gray-50 px-3 py-2.5 text-[11px] leading-relaxed text-gray-400">
            提示：选择背景后，磁贴会自动启用玻璃拟态质感；可用上面的滑块微调通透度与模糊。
          </div>
        </div>
      </div>
    </div>
  );
}
