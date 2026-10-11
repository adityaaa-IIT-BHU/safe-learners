import { useCallback, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'sl:theme';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage unavailable: fall back to the system preference.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme = initialTheme()) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const toggle = useCallback(() => {
    setTheme(t => {
      const next = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Not persisted in private mode.
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}
