export type Theme = 'light' | 'dark' | 'system';

/** 根据主题设置切换 documentElement 上的 .dark 类。 */
export function applyTheme(theme: Theme | undefined): void {
  const dark =
    theme === 'dark' ||
    (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
