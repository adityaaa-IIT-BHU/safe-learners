// Module × action permission grid used for roles and individual administrators.
import { ACTIONS, CLIENT_MODULES, SUPER_ONLY, cleanPerms, type Perms } from '@shared/access';
import { cx } from '@/components/ui';

export function PermissionMatrix({ value, onChange, readOnly }: { value: Perms; onChange?: (p: Perms) => void; readOnly?: boolean }) {
  const toggle = (m: string, letter: string) => {
    if (!onChange) return;
    const cur = value[m as keyof Perms] ?? '';
    let next = cur.includes(letter) ? cur.replace(letter, '') : cur + letter;
    if (letter === 'v' && cur.includes('v')) next = ''; // removing View removes the module
    onChange(cleanPerms({ ...value, [m]: next }));
  };
  const rowAll = (m: string, on: boolean) => onChange?.(cleanPerms({ ...value, [m]: on ? ACTIONS.map(a => a.letter).join('') : '' }));
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-ink-200 dark:border-ink-700">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 dark:bg-ink-800/60">
            <tr className="text-left text-xs uppercase text-ink-500">
              <th className="px-3 py-2">Module</th>
              {ACTIONS.map(a => <th key={a.key} className="px-2 py-2 text-center">{a.label}</th>)}
              {!readOnly && <th className="px-2 py-2 text-center">All</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
            {CLIENT_MODULES.map(m => {
              const cur = value[m.key] ?? '';
              return (
                <tr key={m.key} className={cx(cur && 'bg-emerald-50/40 dark:bg-emerald-500/5')}>
                  <td className="px-3 py-1.5"><p className="font-semibold">{m.label}</p><p className="text-xs text-ink-500">{m.help}</p></td>
                  {ACTIONS.map(a => (
                    <td key={a.key} className="px-2 py-1.5 text-center">
                      <input type="checkbox" aria-label={`${m.label}: ${a.label}`} className="size-4 accent-[#6f42c1]" checked={cur.includes(a.letter)} disabled={readOnly} onChange={() => toggle(m.key, a.letter)} />
                    </td>
                  ))}
                  {!readOnly && <td className="px-2 py-1.5 text-center"><input type="checkbox" aria-label={`${m.label}: all`} className="size-4" checked={cur.length === ACTIONS.length} onChange={e => rowAll(m.key, e.target.checked)} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-500">Never available to client admins: {SUPER_ONLY.join(' · ')}.</p>
    </div>
  );
}
