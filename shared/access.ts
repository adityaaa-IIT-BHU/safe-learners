// Access hierarchy: Cybria Super Admin (set only in server configuration) and client admins, whose
// access is a role plus per-module permissions chosen by Cybria. Shared by the web app and Cloud
// Functions. Permissions are stored in adminAccounts and read live by the database
// rules and every server function. Document Verification and OCR are Cybria Super Admin only.

export const ACTIONS = [
  { key: 'view', letter: 'v', label: 'View' },
  { key: 'create', letter: 'c', label: 'Create' },
  { key: 'edit', letter: 'e', label: 'Edit' },
  { key: 'delete', letter: 'd', label: 'Delete' },
  { key: 'approve', letter: 'a', label: 'Approve' },
  { key: 'reject', letter: 'r', label: 'Reject' },
  { key: 'export', letter: 'x', label: 'Export' },
  { key: 'settings', letter: 's', label: 'Manage settings' },
] as const;
export type Action = (typeof ACTIONS)[number]['key'];
export const ACTION_LETTER = Object.fromEntries(ACTIONS.map(a => [a.key, a.letter])) as Record<Action, string>;

/** Modules a client admin can be given access to. */
export const MODULES = [
  { key: 'learners', label: 'Learner Management', help: 'Learner accounts, profiles and status' },
  { key: 'instructors', label: 'Instructor Management', help: 'Instructor accounts, approvals and status' },
  { key: 'bookings', label: 'Booking Management', help: 'All bookings and lessons' },
  { key: 'scheduling', label: 'Calendar and Scheduling', help: 'Instructor calendars, hours and suburbs' },
  { key: 'finance', label: 'Finance', help: 'Transactions, refunds, reconciliation and finance settings' },
  { key: 'wallet', label: 'Wallet Management', help: 'Learner wallets, credits and adjustments' },
  { key: 'commission', label: 'Commission Management', help: 'Commission structure and instructor rates' },
  { key: 'invoices', label: 'Invoice Management', help: 'Lesson invoices and credit notes' },
  { key: 'documents', label: 'Document Verification', help: 'Instructor documents and decisions (Cybria Super Admin only)', superOnly: true },
  { key: 'ocr', label: 'OCR and Automation', help: 'Automation switches, test mode and processing (Cybria Super Admin only)', superOnly: true },
  { key: 'notifications', label: 'Notifications', help: 'Admin notifications' },
  { key: 'reports', label: 'Reports', help: 'Dashboards and reports' },
  { key: 'reviews', label: 'Reviews', help: 'Learner reviews of instructors' },
  { key: 'xero', label: 'Xero (status and sync)', help: 'Connection status, sync and retries (connecting is Cybria only)' },
  { key: 'settings', label: 'Platform Settings', help: 'Settings pages the admin may change' },
  { key: 'tools', label: 'Admin Tools', help: 'Data tools and migrations' },
] as const;
export type ModuleKey = (typeof MODULES)[number]['key'];
export const MODULE_KEYS = MODULES.map(m => m.key) as ModuleKey[];
/** Modules kept for Cybria Super Admin only: never part of a client admin's permissions. */
export const SUPER_ONLY_MODULES = MODULES.filter(m => 'superOnly' in m && m.superOnly).map(m => m.key) as ModuleKey[];
export const isSuperOnlyModule = (m: ModuleKey) => SUPER_ONLY_MODULES.includes(m);
/** Modules that can be granted to client admins. */
export const CLIENT_MODULES = MODULES.filter(m => !isSuperOnlyModule(m.key));

/** Never grantable to a client admin, whatever their role. */
export const SUPER_ONLY = [
  'Super Admin Control Centre', 'Document verification', 'OCR and automation', 'Client admin accounts, roles and permissions', 'Security settings and sessions',
  'Integration connections and credentials (including connecting or disconnecting Xero)', 'System monitoring', 'Backup and recovery',
];

export type Perms = Partial<Record<ModuleKey, string>>;

/** Normalises a permission set: client-grantable modules only, known letters only, in canonical order. */
export function cleanPerms(raw: unknown): Perms {
  const out: Perms = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const m of MODULE_KEYS) {
    if (isSuperOnlyModule(m)) continue;
    const v = (raw as Record<string, unknown>)[m];
    if (typeof v !== 'string') continue;
    let letters = ACTIONS.map(a => a.letter).filter(l => v.includes(l)).join('');
    // Any action implies being able to see the module.
    if (letters && !letters.includes('v')) letters = `v${letters}`;
    if (letters) out[m] = letters;
  }
  return out;
}

export function allows(perms: Perms | null | undefined, module: ModuleKey, action: Action): boolean {
  if (isSuperOnlyModule(module)) return false; // never through a client permission, even if stored earlier
  return !!perms?.[module]?.includes(ACTION_LETTER[action]);
}

/** Every letter in `inner` is also in `outer` (used to stop anyone granting more than they hold). */
export function isSubset(inner: Perms, outer: Perms): boolean {
  return MODULE_KEYS.every(m => [...(inner[m] ?? '')].every(l => (outer[m] ?? '').includes(l)));
}

const ALL = 'vcedarxs';
const WORK = 'vcearx';
const fill = (letters: string, modules: ModuleKey[]): Perms => Object.fromEntries(modules.map(m => [m, letters]));

export interface RoleTemplate { id: string; name: string; description: string; perms: Perms }

/** Starting roles. Cybria can edit them and create others; they are examples, not fixed rules. */
export const BUILT_IN_ROLES: RoleTemplate[] = [
  { id: 'client_main_admin', name: 'Client Main Admin', description: 'Runs day-to-day operations. No commission, settings or tools unless Cybria adds them.',
    perms: { ...fill(WORK + 'd', ['learners', 'instructors', 'bookings', 'scheduling']), ...fill(WORK, ['finance', 'wallet', 'invoices', 'reviews']), reports: 'vx', notifications: 'v', xero: 'v' } },
  { id: 'operations_manager', name: 'Operations Manager', description: 'Learners, instructors, bookings and scheduling.',
    perms: { ...fill(WORK, ['learners', 'instructors', 'bookings', 'scheduling']), reports: 'vx' } },
  { id: 'finance_manager', name: 'Finance Manager', description: 'Finance, wallets, invoices and refunds.',
    perms: { ...fill(WORK, ['finance', 'wallet', 'invoices']), learners: 'v', reports: 'vx', xero: 'v' } },
  { id: 'instructor_manager', name: 'Instructor Manager', description: 'Instructor accounts, approvals and calendars.',
    perms: { instructors: WORK, scheduling: 've', bookings: 'v', reports: 'v' } },
  { id: 'learner_support', name: 'Learner Support', description: 'Help learners with accounts, bookings and wallets (view only for money).',
    perms: { learners: 've', bookings: 've', wallet: 'v', invoices: 'v' } },
  { id: 'read_only_auditor', name: 'Read-Only Auditor', description: 'Can see and export everything a client admin can, but change nothing.',
    perms: fill('vx', CLIENT_MODULES.map(m => m.key).filter(m => m !== 'settings' && m !== 'tools')) },
];
/** Built-in roles retired by later changes (kept in history; can no longer be assigned). */
export const RETIRED_ROLES = ['document_officer'];

export type AdminStatus = 'active' | 'suspended' | 'deactivated';
export const ADMIN_STATUS: Record<AdminStatus, { label: string; tone: 'green' | 'amber' | 'slate' }> = {
  active: { label: 'Active', tone: 'green' }, suspended: { label: 'Suspended', tone: 'amber' }, deactivated: { label: 'Deactivated', tone: 'slate' },
};

export const ALL_LETTERS = ALL;
