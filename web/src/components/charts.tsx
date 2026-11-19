// Small dependency-free SVG charts for dashboards: a (stacked) column chart with hover tooltip, legend
// and a table view. Colours come from the validated .viz-root slots in index.css.
import { useMemo, useState } from 'react';
import { cx } from '@/components/ui';

export interface Series { key: string; label: string; slot: 1 | 2 | 3 | 4 }
export interface Point { label: string; long: string; values: Record<string, number> }

const H = 180, PAD_L = 32, PAD_B = 22, PAD_T = 8;
const niceMax = (n: number) => { if (n <= 4) return 4; const p = 10 ** Math.floor(Math.log10(n)); const m = Math.ceil(n / p); return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

/** Columns per period, stacked when several series are given. */
export function ColumnChart({ points, series, title, empty = 'Nothing in this period' }: { points: Point[]; series: Series[]; title: string; empty?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const totals = points.map(p => series.reduce((s, x) => s + (p.values[x.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const W = 640, plotW = W - PAD_L - 4, plotH = H - PAD_B - PAD_T;
  const step = plotW / Math.max(points.length, 1);
  const barW = Math.max(2, Math.min(28, step * 0.62));
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  const labelEvery = Math.ceil(points.length / 8);
  const ticks = [0, max / 2, max];
  const sum = useMemo(() => Object.fromEntries(series.map(s => [s.key, points.reduce((t, p) => t + (p.values[s.key] ?? 0), 0)])), [points, series]);
  const nothing = totals.every(t => t === 0);

  return (
    <div className="viz-root">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-600 dark:text-ink-300" aria-label={`${title} legend`}>
          {series.length > 1 && series.map(s => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: `var(--series-${s.slot})` }} />{s.label} <b className="text-ink-900 dark:text-white">{sum[s.key]}</b>
            </span>
          ))}
        </div>
        <button type="button" className="text-xs font-semibold text-ink-500 underline hover:text-ink-800 dark:hover:text-ink-200" onClick={() => setTable(t => !t)}>{table ? 'Show chart' : 'Show as table'}</button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-auto rounded-xl border border-ink-200 dark:border-ink-700">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-ink-50 text-left text-xs uppercase text-ink-500 dark:bg-ink-800"><tr><th className="px-3 py-2">Period</th>{series.map(s => <th key={s.key} className="px-3 py-2 text-right">{s.label}</th>)}</tr></thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
              {points.map(p => <tr key={p.long}><td className="px-3 py-1.5">{p.long}</td>{series.map(s => <td key={s.key} className="px-3 py-1.5 text-right tabular-nums">{p.values[s.key] ?? 0}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      ) : nothing ? (
        <p className="grid h-[180px] place-items-center rounded-xl bg-ink-50 text-sm text-ink-500 dark:bg-ink-800/40">{empty}</p>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}: ${series.map(s => `${s.label} ${sum[s.key]}`).join(', ')}`} onMouseLeave={() => setHover(null)}>
            {ticks.map(t => (
              <g key={t}>
                <line x1={PAD_L} x2={W} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
                <text x={PAD_L - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--viz-axis)">{t}</text>
              </g>
            ))}
            {points.map((p, i) => {
              const cx0 = PAD_L + step * i + step / 2;
              let acc = 0;
              const segs = series.map(s => { const v = p.values[s.key] ?? 0; const seg = { s, v, y0: y(acc), y1: y(acc + v) }; acc += v; return seg; }).filter(g => g.v > 0);
              return (
                <g key={p.long} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${p.long}: ${series.map(s => `${s.label} ${p.values[s.key] ?? 0}`).join(', ')}`}>
                  <rect x={PAD_L + step * i} y={PAD_T} width={step} height={plotH} fill={hover === i ? 'var(--viz-grid)' : 'transparent'} opacity={0.5} />
                  {segs.map((g, k) => {
                    const top = k === segs.length - 1;
                    const h = Math.max(1, g.y0 - g.y1 - (k > 0 ? 2 : 0));
                    const r = top ? Math.min(4, barW / 2, h) : 0;
                    const x = cx0 - barW / 2, yt = g.y1;
                    // Rounded data-end on the top segment only; 2px surface gap between stacked segments.
                    return <path key={g.s.key} fill={`var(--series-${g.s.slot})`}
                      d={`M${x},${yt + h} L${x},${yt + r} Q${x},${yt} ${x + r},${yt} L${x + barW - r},${yt} Q${x + barW},${yt} ${x + barW},${yt + r} L${x + barW},${yt + h} Z`} />;
                  })}
                  {i % labelEvery === 0 && <text x={cx0} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--viz-axis)">{p.label}</text>}
                </g>
              );
            })}
            <line x1={PAD_L} x2={W} y1={y(0)} y2={y(0)} stroke="var(--viz-axis)" strokeWidth={1} />
          </svg>
          {hover !== null && (
            <div className={cx('pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg border border-ink-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-ink-700 dark:bg-ink-900')}
              style={{ left: `${Math.min(78, Math.max(0, ((PAD_L + step * hover + step / 2) / W) * 100 - 8))}%` }}>
              <p className="mb-1 font-bold">{points[hover].long}</p>
              {series.map(s => (
                <p key={s.key} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: `var(--series-${s.slot})` }} />{s.label}</span>
                  <b className="tabular-nums">{points[hover].values[s.key] ?? 0}</b>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A labelled proportion bar (for example active vs inactive). Values and labels are always shown as text. */
export function SplitBar({ parts }: { parts: { label: string; value: number; slot: 1 | 2 | 3 | 4 }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="viz-root space-y-2">
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800" role="img" aria-label={parts.map(p => `${p.label} ${p.value}`).join(', ')}>
        {total > 0 && parts.filter(p => p.value > 0).map(p => <span key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: `var(--series-${p.slot})` }} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-600 dark:text-ink-300">
        {parts.map(p => <span key={p.label} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: `var(--series-${p.slot})` }} />{p.label} <b className="text-ink-900 dark:text-white">{p.value}</b></span>)}
      </div>
    </div>
  );
}
