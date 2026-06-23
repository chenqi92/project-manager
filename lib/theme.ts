export type Theme = 'light' | 'dark' | 'system';

/** 根据主题设置切换 documentElement 上的 .dark 类。 */
export function applyTheme(theme: Theme | undefined): void {
  const dark =
    theme === 'dark' ||
    (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/**
 * 监听系统配色变化：当主题为「跟随系统」（undefined / 'system'）时，OS 切换深浅色后
 * 实时重新应用。返回取消订阅函数。getTheme 用回调读最新值，避免闭包拿到旧主题。
 */
export function watchSystemTheme(getTheme: () => Theme | undefined): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    const t = getTheme();
    if (t !== 'light' && t !== 'dark') applyTheme(t);
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
