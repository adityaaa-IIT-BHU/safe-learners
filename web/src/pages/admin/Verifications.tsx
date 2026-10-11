import { doc } from 'firebase/firestore';
import { BadgeCheck, ExternalLink, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { VERIFICATION_STEPS, fullName, isExpired, normaliseExpiry, type UserProfile, type VerificationDocument, type VerificationStepKey } from '@shared/domain';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, Modal, PageHeader, Tabs, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useDoc } from '@/lib/data';
import { db } from '@/lib/firebase';
import { useAllUsers } from './Overview';

type Tab = 'pending_review' | 'updates' | 'not_submitted' | 'verified' | 'rejected';

export function AdminVerifications() {
  const { data: users } = useAllUsers();
  const [tab, setTab] = useState<Tab>('pending_review');
  const instructors = users.filter(u => u.role === 'instructor');
  // "Document updates": verified instructors who sent a renewed document.
  const matches = (u: UserProfile, t: Tab) => t === 'updates'
    ? u.verificationStatus === 'verified' && u.documentsPending === true
    : (u.verificationStatus ?? 'not_submitted') === t;
  const list = instructors.filter(u => matches(u, tab));
  const count = (t: Tab) => instructors.filter(u => matches(u, t)).length;

  return (
    <>
      <PageHeader title="Instructor verification" />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'pending_review', label: 'Awaiting review', count: count('pending_review') },
        { value: 'updates', label: 'Document updates', count: count('updates') },
        { value: 'not_submitted', label: 'Not submitted', count: count('not_submitted') },
        { value: 'rejected', label: 'Needs changes', count: count('rejected') },
        { value: 'verified', label: 'Verified', count: count('verified') },
      ]} />
      <div className="mt-4 space-y-4">
        {list.length === 0 ? <Card><EmptyState icon={<ShieldCheck className="size-6" />} title="Nothing here" /></Card> : list.map(u => <InstructorReview key={u.id} instructor={u} />)}
      </div>
    </>
  );
}

function InstructorReview({ instructor }: { instructor: UserProfile }) {
  const { data: docs } = useDoc(doc(db, 'users', instructor.id, 'private', 'profile'), (_, d) => (d.verification ?? {}) as Record<string, VerificationDocument>);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // Legacy instructors uploaded through the old site: URLs live on the main user doc.
  const legacy = instructor as unknown as Record<string, string | undefined>;
  const docFor = (key: string): VerificationDocument | undefined => docs?.[key] ?? {
    driverLicence: legacy.driverLicenseUrl ? { url: legacy.driverLicenseUrl, number: legacy.licenseNumber, expiry: legacy.licenseExpiry } : undefined,
    instructorLicence: legacy.instructorLicenseUrl ? { url: legacy.instructorLicenseUrl, number: legacy.instructorLicenseNumber, expiry: legacy.instructorLicenseExpiry } : undefined,
    wwc: legacy.wwcCheckUrl ? { url: legacy.wwcCheckUrl, number: legacy.wwcNumber, expiry: legacy.wwcExpiry } : undefined,
    vehicleRego: legacy.vehicleRegoUrl ? { url: legacy.vehicleRegoUrl, number: legacy.plateNumber, expiry: legacy.regoExpiry } : undefined,
  }[key];

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await api.reviewVerification({ uid: instructor.id, approve, reason: approve ? undefined : reason.trim() });
      toast.success(approve ? `${instructor.firstName} is verified.` : 'Instructor asked to resubmit.');
      setRejectOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-3"><Avatar name={fullName(instructor)} src={instructor.photoUrl} size={36} />{fullName(instructor)}</span>}
        subtitle={[instructor.email, instructor.mobile].filter(Boolean).join(' · ')}
        action={instructor.verificationStatus !== 'verified' ? (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRejectOpen(true)}>Request changes</Button>
            <Button size="sm" variant="success" icon={<BadgeCheck className="size-4" />} loading={busy} onClick={() => decide(true)}>Approve</Button>
          </div>
        ) : <Badge tone="green">Verified</Badge>}
      />
      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
        {VERIFICATION_STEPS.map(s => {
          const d = docFor(s.key);
          const expired = isExpired(d?.expiry);
          const shown = normaliseExpiry(d?.expiry);
          return (
            <div key={s.key} className={`rounded-xl border p-3 text-sm ${instructor.documentReviews?.[s.key]?.status === 'pending' ? 'border-amber-400 bg-amber-50/50 dark:bg-amber-500/5' : 'border-ink-200 dark:border-ink-700'}`}>
              <p className="flex items-center justify-between gap-2 font-semibold">{s.label}<ReviewBadge status={instructor.documentReviews?.[s.key]?.status} /></p>
              {d?.url ? (
                <>
                  <p className="mt-1 text-ink-500">No. {d.number ?? '—'}{d.state ? ` · ${d.state}` : ''}</p>
                  <p className={expired ? 'font-semibold text-red-600' : 'text-ink-500'}>{expired ? 'Expired' : 'Expires'} {shown ? shown.split('-').reverse().join('/') : d.expiry ?? '—'}</p>
                  <div className="mt-2 flex gap-3">
                    <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-bold underline"><ExternalLink className="size-3" />{d.backUrl ? 'Front' : 'Open document'}</a>
                    {d.backUrl && <a href={d.backUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-bold underline"><ExternalLink className="size-3" />Back</a>}
                  </div>
                  {instructor.verificationStatus === 'verified' && instructor.documentReviews?.[s.key]?.status === 'pending' && (
                    <DocumentDecision uid={instructor.id} docKey={s.key} name={instructor.firstName} />
                  )}
                </>
              ) : <p className="mt-1 text-ink-400">Not provided</p>}
            </div>
          );
        })}
      </div>
      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title={`Request changes from ${instructor.firstName}`}
        footer={<Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => decide(false)}>Send request</Button>}>
        <Textarea label="What needs fixing?" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. The WWC check photo is blurry — please upload a clearer copy." />
      </Modal>
    </Card>
  );
}

function ReviewBadge({ status }: { status?: string }) {
  if (status === 'pending') return <Badge tone="amber">To review</Badge>;
  if (status === 'approved') return <Badge tone="green">Approved</Badge>;
  if (status === 'rejected') return <Badge tone="red">Rejected</Badge>;
  return null;
}

/** Approve or reject one renewed document for an already verified instructor. */
function DocumentDecision({ uid, docKey, name }: { uid: string; docKey: VerificationStepKey; name: string }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject');
    try {
      await api.reviewDocument({ uid, key: docKey, approve, note: approve ? undefined : note.trim() });
      toast.success(approve ? 'Document approved' : `${name} asked to resubmit`);
      setRejecting(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-3 space-y-2">
      {rejecting && <Textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="What needs fixing?" />}
      <div className="flex gap-2">
        {rejecting
          ? <Button size="sm" variant="danger" loading={busy === 'reject'} disabled={!note.trim()} onClick={() => decide(false)}>Send</Button>
          : <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>Reject</Button>}
        <Button size="sm" variant="success" loading={busy === 'approve'} onClick={() => decide(true)}>Approve</Button>
      </div>
    </div>
  );
}
