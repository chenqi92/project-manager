import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { generateTotp, parseTotp } from '@/lib/totp';
import { cx } from './ui';

/** 实时显示某账号的 TOTP 验证码与剩余秒数；点击复制。 */
export function TotpBadge({
  secret,
  onCopy,
}: {
  secret: string;
  onCopy?: (code: string) => void;
}) {
  const [code, setCode] = useState('------');
  const [remaining, setRemaining] = useState(30);
  const [valid, setValid] = useState(true);

  useEffect(() => {
    const cfg = parseTotp(secret);
    if (!cfg) {
      setValid(false);
      return;
    }
    setValid(true);
    let active = true;
    const tick = async () => {
      const r = await generateTotp(cfg, Date.now());
      if (!active) return;
      setCode(r.code);
      setRemaining(r.secondsRemaining);
    };
    void tick().catch(() => {});
    const timer = setInterval(() => void tick().catch(() => {}), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [secret]);

  if (!valid) return <span className="text-xs text-rose-500">TOTP 密钥无效</span>;

  return (
    <button
      onClick={() => onCopy?.(code)}
      title="复制验证码"
      className="inline-flex items-center gap-1.5 rounded-md bg-brand-50 px-2 py-1 font-mono text-sm text-prid hover:bg-brand-100"
    >
      <span className="tracking-widest">
        {code.slice(0, Math.ceil(code.length / 2))} {code.slice(Math.ceil(code.length / 2))}
      </span>
      <span className={cx('text-[10px]', remaining <= 5 ? 'text-rose-500' : 'text-brand-400')}>
        {remaining}s
      </span>
      {onCopy && <Copy size={12} />}
    </button>
  );
}
