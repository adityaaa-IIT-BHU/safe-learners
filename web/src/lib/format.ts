export function timeAgo(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en-AU', { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(-Math.round(seconds / 86400), 'day');
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "in 3 days", "in 4 hours" for upcoming lessons. */
export function timeUntil(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en-AU', { numeric: 'auto' });
  if (seconds < 3600) return rtf.format(Math.max(1, Math.round(seconds / 60)), 'minute');
  if (seconds < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86400), 'day');
}

export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
