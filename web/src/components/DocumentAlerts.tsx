// Instructor dashboard: a banner for documents expiring within 30 days (or expired), and a pop-up
// for the important ones (7 days or less, or expired). The pop-up can be dismissed for the day;
// expired documents bring it back on every visit until a renewal is uploaded.
import { AlertTriangle, CalendarClock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { daysUntil, describeDaysLeft, docTypeLabel, formatDocDateLong, REVIEW_QUEUE } from '@shared/documents';
import { ButtonLink, Button, Modal } from '@/components/ui';
import { useInstructorDocuments } from '@/lib/documents';

const today = () => new Date().toISOString().slice(0, 10);

export function DocumentAlerts({ uid }: { uid: string }) {
  const { data } = useInstructorDocuments(uid);
  const items = data
    .filter(r => r.verifiedExpiry)
    .map(r => ({ r, days: daysUntil(r.verifiedExpiry!), renewal: r.latestVersion !== r.verifiedVersion && REVIEW_QUEUE.includes(r.latestStatus) }))
    .filter(x => x.days <= 30)
    .sort((a, b) => a.days - b.days);
  const urgent = items.filter(x => x.days <= 7 && !x.renewal);
  const expired = urgent.some(x => x.days < 0);
  const key = `docAlertsDismissed:${uid}`;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!urgent.length) return;
    let dismissed = '';
    try { dismissed = localStorage.getItem(key) ?? ''; } catch { /* storage unavailable */ }
    if (expired || dismissed !== today()) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urgent.length, expired]);
  if (!items.length) return null;

  const dismiss = () => {
    try { localStorage.setItem(key, today()); } catch { /* storage unavailable */ }
    setOpen(false);
  };

  return (
    <>
      <div className={`mb-6 flex items-start gap-3 rounded-2xl p-4 text-sm ${expired ? 'bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200'}`}>
        <CalendarClock className="mt-0.5 size-5 shrink-0" />
        <div className="flex-1 space-y-0.5">
          {items.map(({ r, days, renewal }) => (
            <p key={r.id}><strong>{docTypeLabel(r.type)}</strong> {days < 0 ? `expired ${describeDaysLeft(days)}` : days === 0 ? 'expires today' : `expires ${describeDaysLeft(days)}`}{renewal ? ' — renewal received, under review.' : '.'}</p>
          ))}
        </div>
        <ButtonLink to="/instructor/verification" size="sm" variant="secondary">Update documents</ButtonLink>
      </div>
      <Modal open={open} onClose={dismiss} title={expired ? 'Document Expired' : 'Document Expiring Soon'}
        footer={<><Button variant="ghost" onClick={dismiss}>Remind me later</Button><ButtonLink to={`/instructor/verification?doc=${urgent[0]?.r.type ?? ''}`}>Upload renewed document</ButtonLink></>}>
        <div className="space-y-3">
          {urgent.map(({ r, days }) => (
            <div key={r.id} className="flex items-start gap-3">
              <AlertTriangle className={`mt-0.5 size-5 shrink-0 ${days < 0 ? 'text-red-600' : 'text-amber-600'}`} />
              <p className="text-sm">{days < 0
                ? <>Your <strong>{docTypeLabel(r.type)}</strong> expired on {formatDocDateLong(r.verifiedExpiry!)}. Please upload your renewed document as soon as possible to avoid any interruption to your verification status.</>
                : <>Your <strong>{docTypeLabel(r.type)}</strong> is due to expire on {formatDocDateLong(r.verifiedExpiry!)}. Please upload your renewed document before the expiry date to avoid any interruption to your verification status.</>}
              </p>
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
}
