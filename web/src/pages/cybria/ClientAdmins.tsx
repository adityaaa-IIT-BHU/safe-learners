// Super Admin → Client Admin Management: every administrator account given to the client, with status,
// role, individual permissions, sessions, notes, login history and activity.
import { collection, doc, limit, query, where } from 'firebase/firestore';
import { Copy, History, KeyRound, LogOut, Plus, ShieldAlert, UserCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ADMIN_STATUS, MODULES, cleanPerms, type AdminStatus, type Perms } from '@shared/access';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Modal, PageHeader, Select, Textarea, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toDate, useDoc, useQuery } from '@/lib/data';
import { db } from '@/lib/firebase';
import { PermissionMatrix } from './PermissionMatrix';

export interface AdminAcct {
  id: string; email: string; firstName?: string; surname?: string; status: AdminStatus; roleId: string; roleName: string; perms: Perms; customised?: boolean;
  notes?: { id: string; text: string; by: string; at: string }[]; lastLoginAt?: Date; createdAt?: Date; createdBy?: { name: string }; statusReason?: string;
}
export interface Role { id: string; name: string; description?: string; perms: Perms; builtIn?: boolean }
const mapAcct = (id: string, d: Record<string, any>): AdminAcct => ({ id, ...d, perms: d.perms ?? {}, lastLoginAt: toDate(d.lastLoginAt), createdAt: toDate(d.createdAt) } as AdminAcct);
export const useRoles = () => useQuery(query(collection(db, 'adminRoles')), (id, d) => ({ id, ...d, perms: d.perms ?? {} } as Role), 'cybria:roles').data;
const when = (d?: Date | string | null) => { const x = typeof d === 'string' ? new Date(d) : d; return x ? x.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; };
export const accessSummary = (p: Perms) => { const n = Object.keys(p).length; return n ? `${n} of ${MODULES.length} modules` : 'No access'; };

export function ClientAdmins() {
  const { data: accounts } = useQuery(query(collection(db, 'adminAccounts')), mapAcct, 'cybria:accounts');
  const roles = useRoles();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<'all' | AdminStatus>('all');
  useEffect(() => { if (!roles.length) api.ensureAdminRoles({}).catch(() => undefined); }, [roles.length]);
  const shown = accounts.filter(a => filter === 'all' || a.status === filter).sort((a, b) => (a.firstName ?? a.email).localeCompare(b.firstName ?? b.email));
  return (
    <>
      <PageHeader title="Client Admin Management" subtitle="Every administrator account given to SafeLearners. Cybria Super Admins are set in server configuration and never appear here."
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New client admin</Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 p-4 dark:border-ink-800">
          <Select value={filter} onChange={e => setFilter(e.target.value as never)} wrapperClassName="w-44"><option value="all">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="deactivated">Deactivated</option></Select>
          <span className="text-sm text-ink-500">{accounts.filter(a => a.status === 'active').length} active of {accounts.length}</span>
        </div>
        {!shown.length ? <EmptyState icon={<UserCog className="size-6" />} title="No client administrators yet" body="Create one to give SafeLearners access to the Admin Panel." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">Administrator</th><th className="px-4 py-2">Role</th><th className="px-4 py-2">Access</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Last login</th></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {shown.map(a => (
                  <tr key={a.id} className="cursor-pointer hover:bg-ink-50 dark:hover:bg-ink-800/40" onClick={() => setOpen(a.id)}>
                    <td className="px-4 py-2"><p className="font-semibold">{[a.firstName, a.surname].filter(Boolean).join(' ') || '—'}</p><p className="text-xs text-ink-500">{a.email}</p></td>
                    <td className="px-4 py-2">{a.roleName}{a.customised && <Badge tone="yellow" className="ml-2">Adjusted</Badge>}</td>
                    <td className="px-4 py-2">{accessSummary(a.perms)}</td>
                    <td className="px-4 py-2"><Badge tone={ADMIN_STATUS[a.status]?.tone ?? 'slate'}>{ADMIN_STATUS[a.status]?.label ?? a.status}</Badge></td>
                    <td className="px-4 py-2">{when(a.lastLoginAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <CreateAdmin roles={roles} onClose={() => setCreating(false)} />}
      {open && <AdminDetail uid={open} roles={roles} onClose={() => setOpen(null)} />}
    </>
  );
}

function CreateAdmin({ roles, onClose }: { roles: Role[]; onClose: () => void }) {
  const [f, setF] = useState({ email: '', firstName: '', surname: '', roleId: 'client_main_admin' });
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={link ? 'Administrator created' : 'New client administrator'}
      footer={link ? <Button onClick={onClose}>Done</Button> : <Button loading={busy} disabled={!f.email || !f.firstName} onClick={async () => {
        setBusy(true);
        try { const r = await api.createClientAdmin(f); setLink(r.setPasswordLink); toast.success('Administrator created'); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
      }}>Create</Button>}>
      {link ? (
        <div className="space-y-3 text-sm">
          <p>Send this one-time link to <strong>{f.email}</strong> privately. They choose their own password; nobody else sees it. The link expires after one use or within a few hours.</p>
          <div className="flex gap-2"><Input value={link} readOnly wrapperClassName="flex-1" /><Button variant="secondary" icon={<Copy className="size-4" />} onClick={() => { navigator.clipboard.writeText(link).then(() => toast.success('Copied')); }}>Copy</Button></div>
          <p className="text-xs text-ink-500">If it expires, create a new one from the administrator’s page (“Password link”).</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Email" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} wrapperClassName="sm:col-span-2" />
          <Input label="First name" value={f.firstName} onChange={e => setF({ ...f, firstName: e.target.value })} />
          <Input label="Surname" value={f.surname} onChange={e => setF({ ...f, surname: e.target.value })} />
          <Select label="Role" value={f.roleId} onChange={e => setF({ ...f, roleId: e.target.value })} wrapperClassName="sm:col-span-2">{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
          <p className="text-xs text-ink-500 sm:col-span-2">{roles.find(r => r.id === f.roleId)?.description}</p>
        </div>
      )}
    </Modal>
  );
}

function AdminDetail({ uid, roles, onClose }: { uid: string; roles: Role[]; onClose: () => void }) {
  const { data: a } = useDoc(doc(db, 'adminAccounts', uid), mapAcct);
  const logins = useQuery(query(collection(db, 'adminLogins'), where('uid', '==', uid), limit(100)), (id, d) => ({ id, ...d } as Record<string, any>), `cybria:logins:${uid}`).data.sort((x, y) => y.atMs - x.atMs);
  const targeted = useQuery(query(collection(db, 'adminAudit'), where('targetUid', '==', uid), limit(200)), (id, d) => ({ id, ...d } as Record<string, any>), `cybria:auditT:${uid}`).data.sort((x, y) => y.atMs - x.atMs);
  const acted = useQuery(query(collection(db, 'adminAudit'), where('actor.uid', '==', uid), limit(200)), (id, d) => ({ id, ...d } as Record<string, any>), `cybria:auditA:${uid}`).data.sort((x, y) => y.atMs - x.atMs);
  const [tab, setTab] = useState<'access' | 'history' | 'activity'>('access');
  const [perms, setPerms] = useState<Perms | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [details, setDetails] = useState<{ firstName: string; surname: string } | null>(null);
  const [ask, setAsk] = useState<null | { title: string; body: string; run: (reason: string) => Promise<unknown>; danger?: boolean }>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  if (!a) return null;
  const draft = perms ?? a.perms;
  const role = roles.find(r => r.id === (roleId ?? a.roleId));
  const dirty = roleId !== null || perms !== null;
  const name = [a.firstName, a.surname].filter(Boolean).join(' ') || a.email;
  const confirm = (title: string, body: string, run: (reason: string) => Promise<unknown>, danger = false) => { setReason(''); setAsk({ title, body, run, danger }); };

  return (
    <Modal open onClose={onClose} size="xl" title={`${name} · ${a.email}`}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={ADMIN_STATUS[a.status].tone}>{ADMIN_STATUS[a.status].label}</Badge>
        <span className="text-xs text-ink-500">Role: {a.roleName}{a.customised ? ' (adjusted)' : ''} · last login {when(a.lastLoginAt)} · created {when(a.createdAt)} by {a.createdBy?.name ?? '—'}</span>
        <span className="flex-1" />
        {a.status === 'active' && <Button size="sm" variant="secondary" icon={<ShieldAlert className="size-4" />} onClick={() => confirm('Suspend this administrator?', 'They lose Admin Panel access straight away and are signed out. You can reinstate them later.', r => api.setClientAdminStatus({ uid, status: 'suspended', reason: r }), true)}>Suspend</Button>}
        {a.status !== 'deactivated' && <Button size="sm" variant="secondary" onClick={() => confirm('Deactivate this administrator?', 'Their sign-in is disabled entirely and admin access removed. Records and history are kept.', r => api.setClientAdminStatus({ uid, status: 'deactivated', reason: r }), true)}>Deactivate</Button>}
        {a.status !== 'active' && <Button size="sm" onClick={() => confirm('Reinstate this administrator?', 'Their access returns with their current role and permissions.', r => api.setClientAdminStatus({ uid, status: 'active', reason: r }))}>Reinstate</Button>}
        <Button size="sm" variant="secondary" icon={<LogOut className="size-4" />} onClick={() => confirm('Sign out everywhere?', 'Ends all of this administrator’s sessions; they must sign in again.', r => api.revokeAdminSessions({ uid, reason: r }))}>Revoke sessions</Button>
        <Button size="sm" variant="secondary" icon={<KeyRound className="size-4" />} onClick={async () => {
          try { const r = await api.adminPasswordLink({ uid }); await navigator.clipboard.writeText(r.link); toast.success('One-time password link copied. Send it to them privately.'); } catch (err) { toast.error(errorMessage(err)); }
        }}>Password link</Button>
      </div>
      {a.status !== 'active' && a.statusReason && <p className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">Reason: {a.statusReason}</p>}
      <div className="mb-3 flex rounded-lg border border-ink-200 p-0.5 text-xs font-semibold dark:border-ink-700">
        {(['access', 'history', 'activity'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={cx('flex-1 rounded-md px-3 py-1.5', tab === t ? 'bg-[#1d1433] text-white' : 'text-ink-500')}>{t === 'access' ? 'Details and access' : t === 'history' ? 'Permission history and logins' : 'Activity by this admin'}</button>)}
      </div>
      {tab === 'access' && (
        <div className="space-y-4">
          <Card className="p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="First name" value={details?.firstName ?? a.firstName ?? ''} onChange={e => setDetails({ firstName: e.target.value, surname: details?.surname ?? a.surname ?? '' })} />
              <Input label="Surname" value={details?.surname ?? a.surname ?? ''} onChange={e => setDetails({ firstName: details?.firstName ?? a.firstName ?? '', surname: e.target.value })} />
              <div className="flex items-end"><Button size="sm" variant="secondary" disabled={!details} onClick={async () => { try { await api.updateClientAdmin({ uid, ...details! }); toast.success('Details saved'); setDetails(null); } catch (err) { toast.error(errorMessage(err)); } }}>Save details</Button></div>
            </div>
          </Card>
          <div className="flex flex-wrap items-end gap-3">
            <Select label="Role" value={roleId ?? a.roleId} onChange={e => { setRoleId(e.target.value); setPerms(cleanPerms(roles.find(r => r.id === e.target.value)?.perms)); }} wrapperClassName="w-64">
              {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
            <p className="pb-2 text-xs text-ink-500">{role?.description} Tick or untick boxes below to adjust this administrator only.</p>
          </div>
          <PermissionMatrix value={draft} onChange={setPerms} />
          <div className="flex gap-2">
            <Button disabled={!dirty} onClick={() => confirm('Save access changes?', `${name} will have: ${accessSummary(draft)} (${role?.name ?? a.roleName}). Takes effect immediately.`, r => api.setClientAdminAccess({ uid, roleId: roleId ?? undefined, perms: draft as Record<string, string>, reason: r }).then(() => { setPerms(null); setRoleId(null); }))}>Save access</Button>
            {dirty && <Button variant="ghost" onClick={() => { setPerms(null); setRoleId(null); }}>Discard</Button>}
          </div>
          <Card>
            <CardHeader title="Internal notes" subtitle="Visible to Cybria only." />
            <div className="space-y-2 p-4">
              {(a.notes ?? []).slice().reverse().map(n => <p key={n.id} className="text-sm"><span className="text-xs text-ink-400">{n.by} · {when(n.at)}</span><br />{n.text}</p>)}
              <div className="flex gap-2"><Input placeholder="Add a note" value={note} onChange={e => setNote(e.target.value)} wrapperClassName="flex-1" />
                <Button variant="secondary" disabled={!note.trim()} onClick={async () => { try { await api.addAdminNote({ uid, text: note }); setNote(''); } catch (err) { toast.error(errorMessage(err)); } }}>Add</Button></div>
            </div>
          </Card>
        </div>
      )}
      {tab === 'history' && (
        <div className="space-y-4">
          <AuditTable rows={targeted} empty="No changes yet" />
          <Card>
            <CardHeader title={<span className="flex items-center gap-2"><History className="size-4" />Login history</span>} />
            {!logins.length ? <EmptyState title="No logins recorded yet" /> : (
              <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">When</th><th className="px-4 py-2">IP address</th><th className="px-4 py-2">Browser</th></tr></thead>
                <tbody className="divide-y divide-ink-100 dark:divide-ink-800">{logins.map(l => <tr key={l.id}><td className="px-4 py-2">{when(new Date(l.atMs))}</td><td className="px-4 py-2">{l.ip ?? '—'}</td><td className="px-4 py-2 text-xs text-ink-500">{l.userAgent ?? '—'}</td></tr>)}</tbody></table></div>
            )}
          </Card>
        </div>
      )}
      {tab === 'activity' && <AuditTable rows={acted} empty="This administrator hasn’t made recorded changes in admin management. Their business actions appear in each module’s audit trail." />}
      <Modal open={!!ask} onClose={() => setAsk(null)} title={ask?.title ?? ''}
        footer={<><Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button><Button variant={ask?.danger ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 3} onClick={async () => {
          setBusy(true);
          try { await ask!.run(reason.trim()); toast.success('Done'); setAsk(null); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
        }}>Confirm</Button></>}>
        <p className="mb-3 text-sm">{ask?.body}</p>
        <Textarea label="Reason (recorded in the audit trail)" value={reason} onChange={e => setReason(e.target.value)} />
      </Modal>
    </Modal>
  );
}

const ACTION_LABEL: Record<string, string> = {
  admin_created: 'Administrator created', admin_details_changed: 'Details changed', admin_suspended: 'Suspended', admin_deactivated: 'Deactivated', admin_reinstated: 'Reinstated',
  admin_permissions_changed: 'Access changed', admin_sessions_revoked: 'Sessions revoked', admin_note_added: 'Note added', admin_password_link: 'Password link created',
  admin_migrated: 'Moved from server configuration', role_created: 'Role created', role_changed: 'Role changed', role_deleted: 'Role deleted',
};
const fmtVal = (v: any) => v === null || v === undefined ? '—' : typeof v === 'string' ? v : v.roleName ? `${v.roleName}: ${accessSummary(v.perms ?? {})}` : v.name ? `${v.name}: ${accessSummary(v.perms ?? {})}` : JSON.stringify(v).slice(0, 120);

export function AuditTable({ rows, empty }: { rows: Record<string, any>[]; empty: string }) {
  if (!rows.length) return <Card><EmptyState title={empty} /></Card>;
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">When</th><th className="px-4 py-2">By</th><th className="px-4 py-2">Action</th><th className="px-4 py-2">Previous</th><th className="px-4 py-2">New</th><th className="px-4 py-2">Reason</th><th className="px-4 py-2">IP</th></tr></thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
            {rows.map(r => <tr key={r.id}><td className="px-4 py-2 whitespace-nowrap">{when(new Date(r.atMs))}</td><td className="px-4 py-2">{r.actor?.name}</td><td className="px-4 py-2">{ACTION_LABEL[r.action] ?? r.action}{r.targetName ? ` · ${r.targetName}` : ''}</td><td className="px-4 py-2">{fmtVal(r.before)}</td><td className="px-4 py-2">{fmtVal(r.after)}</td><td className="px-4 py-2">{r.reason ?? '—'}</td><td className="px-4 py-2 text-xs text-ink-500">{r.ip ?? '—'}</td></tr>)}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
