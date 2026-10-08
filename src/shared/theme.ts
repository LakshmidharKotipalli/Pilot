export type Theme = 'system' | 'dark' | 'light';

const KEY = 'wp_theme';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'system' || v === 'dark') return v;
  } catch {
    /* storage unavailable: use the default */
  }
  return 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* applies for this session only */
  }
  applyTheme(theme);
}
