// Super Admin → Roles & Permissions: built-in and custom roles. Editing a role updates every
// administrator on it (except those individually adjusted).
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type Perms } from '@shared/access';
import { Badge, Button, Card, CardHeader, Input, Modal, PageHeader, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useQuery } from '@/lib/data';
import { db } from '@/lib/firebase';
import { AuditTable, accessSummary, useRoles, type Role } from './ClientAdmins';
import { PermissionMatrix } from './PermissionMatrix';

export function Roles() {
  const roles = useRoles();
  const { data: accounts } = useQuery(query(collection(db, 'adminAccounts')), (id, d) => ({ id, roleId: d.roleId as string }), 'cybria:accountRoles');
  const audit = useQuery(query(collection(db, 'adminAudit'), orderBy('atMs', 'desc'), limit(100)), (id, d) => ({ id, ...d } as Record<string, any>), 'cybria:roleAudit').data.filter(a => a.action.startsWith('role_'));
  const [edit, setEdit] = useState<Role | null>(null);
  useEffect(() => { if (!roles.length) api.ensureAdminRoles({}).catch(() => undefined); }, [roles.length]);
  const users = (id: string) => accounts.filter(a => a.roleId === id).length;
  return (
    <>
      <PageHeader title="Roles & Permissions" subtitle="Starting points for client administrators. Edit any role, or create your own. Super Admin functions are never part of a role."
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setEdit({ id: '', name: '', description: '', perms: {} })}>New role</Button>} />
      <div className="grid gap-4 md:grid-cols-2">
        {[...roles].sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name)).map(r => (
          <Card key={r.id} className="cursor-pointer p-4 transition hover:shadow-md" onClick={() => setEdit(r)}>
            <p className="flex items-center gap-2 font-bold"><KeyRound className="size-4 text-[#6f42c1]" />{r.name}{r.builtIn ? <Badge>Built-in</Badge> : <Badge tone="blue">Custom</Badge>}</p>
            <p className="mt-1 text-sm text-ink-500">{r.description}</p>
            <p className="mt-2 text-xs text-ink-500">{accessSummary(r.perms)} · {users(r.id)} administrator(s)</p>
          </Card>
        ))}
      </div>
      <h2 className="mb-2 mt-8 font-bold">Role change history</h2>
      <AuditTable rows={audit} empty="No role changes yet" />
      {edit && <RoleEditor role={edit} users={edit.id ? users(edit.id) : 0} onClose={() => setEdit(null)} />}
    </>
  );
}

function RoleEditor({ role, users, onClose }: { role: Role; users: number; onClose: () => void }) {
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? '');
  const [perms, setPerms] = useState<Perms>(role.perms);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} size="xl" title={role.id ? `Edit role: ${role.name}` : 'New role'}
      footer={<>
        {role.id && !role.builtIn && <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={users > 0 || reason.trim().length < 3} onClick={async () => {
          try { await api.deleteAdminRole({ id: role.id, reason: reason.trim() }); toast.success('Role deleted'); onClose(); } catch (err) { toast.error(errorMessage(err)); }
        }}>Delete</Button>}
        <Button loading={busy} disabled={!name.trim() || reason.trim().length < 3} onClick={async () => {
          setBusy(true);
          try { const r = await api.saveAdminRole({ id: role.id || undefined, name, description, perms: perms as Record<string, string>, reason: reason.trim() }); toast.success(`Saved${r.accountsUpdated ? ` · ${r.accountsUpdated} administrator(s) updated` : ''}`); onClose(); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
        }}>Save role</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Role name" value={name} onChange={e => setName(e.target.value)} />
          <Input label="Description" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <PermissionMatrix value={perms} onChange={setPerms} />
        <Card className="p-3 text-sm">{users ? `${users} administrator(s) use this role. Saving updates their access immediately (except anyone individually adjusted).` : 'No administrators use this role yet.'}</Card>
        <Textarea label="Reason (recorded)" value={reason} onChange={e => setReason(e.target.value)} />
        <CardHeader title="" />
      </div>
    </Modal>
  );
}
