import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { ChevronDown, Mail, MessageSquareText } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { Button, Card, CardHeader, PageHeader, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { db } from '@/lib/firebase';
import { PublicLayout, SUPPORT_EMAIL } from './Layout';

/** Set when the client provides the new support number. */
export const SUPPORT_PHONE = '';

const LEARNER_FAQ: [string, ReactNode][] = [
  ['How do I book a lesson?', 'Find an instructor who covers your suburb, choose a lesson type and pick any free time from their live calendar. The booking is confirmed straight away.'],
  ['How do I cancel or reschedule?', 'Open the booking from your dashboard. More than 24 hours before the lesson you can cancel for a full wallet refund or move it to a new time. Inside 24 hours, your cancellation request goes to your instructor, who decides whether a fee applies.'],
  ['My instructor proposed a time — what do I do?', 'Proposals appear at the top of your dashboard and you get a notification. Accept to confirm it, or decline if the time doesn’t suit.'],
  ['How does the wallet work?', 'Lesson credit, refunds and referral rewards are kept in your wallet. When you book, the lesson price is taken from your wallet if there’s enough credit; otherwise payment is due before the lesson.'],
  ['What do I need to bring to a lesson?', 'Your learner licence, comfortable shoes, and glasses or contact lenses if your licence requires them.'],
  ['Can I use my own car for the driving test?', 'The test package includes your instructor’s car, a warm-up lesson and pick up and drop off. Book the test itself with your state’s licensing authority.'],
];

const INSTRUCTOR_FAQ: [string, ReactNode][] = [
  ['How do I start receiving bookings?', 'Complete verification (driver licence, instructor licence, WWC check and vehicle registration), then set your availability and service suburbs. Once an admin approves your documents, learners can find and book you.'],
  ['How do I propose a lesson to a learner?', 'Use “Propose a lesson” from your dashboard or click a free slot on your calendar. The learner is notified and can accept or decline. Proposals hold the time slot until they respond.'],
  ['How does rescheduling work?', 'Open a booking and choose Reschedule. Pick a new time from your free slots — the original booking is cancelled (and refunded if prepaid) and a new proposal is sent to the learner.'],
  ['What happens with late cancellations?', 'If a learner cancels within 24 hours, you’ll get a request on your dashboard. Choose to refund them or charge the cancellation fee.'],
  ['How do price changes work?', 'Changes go live 24 hours after you make them, so learners see a price before they commit. Existing bookings keep the price they were booked at.'],
  ['How do I block out personal time?', 'On your calendar, click “Block time” and choose the start and end. Learners can’t book over it.'],
];

export function Support({ audience, embedded }: { audience: 'learner' | 'instructor'; embedded?: boolean }) {
  const faq = audience === 'instructor' ? INSTRUCTOR_FAQ : LEARNER_FAQ;
  const content = (
    <>
      <PageHeader title="Help centre" subtitle="Answers to the most common questions, and how to reach us." />
      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_340px]">
        <Card className="divide-y divide-ink-100 dark:divide-ink-800">
          {faq.map(([q, a]) => <FaqItem key={q} question={q} answer={a} />)}
        </Card>
        <div className="space-y-6">
          <Card className="p-5">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-brand-500 text-ink-950"><Mail className="size-5" /></div>
            <h3 className="mt-4 font-bold">Email our team</h3>
            <p className="mt-1 text-sm text-ink-500">The fastest way to get help. We usually reply within one business day.</p>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="mt-3 block font-bold text-ink-950 underline dark:text-white">{SUPPORT_EMAIL}</a>
            {SUPPORT_PHONE && <p className="mt-4 text-sm text-ink-500">Urgent on the day of a lesson? SMS <strong className="text-ink-900 dark:text-white">{SUPPORT_PHONE}</strong></p>}
          </Card>
          <FeedbackForm />
        </div>
      </div>
    </>
  );
  if (embedded) return content;
  return <PublicLayout><div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{content}</div></PublicLayout>;
}

function FaqItem({ question, answer }: { question: string; answer: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left font-semibold" aria-expanded={open}>
        {question}
        <ChevronDown className={`size-5 shrink-0 text-ink-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="animate-fade-in px-5 pb-5 text-sm leading-relaxed text-ink-600 dark:text-ink-300">{answer}</div>}
    </div>
  );
}

function FeedbackForm() {
  const { user, profile, readOnly } = useAuth();
  const [message, setMessage] = useState('');
  const [topic, setTopic] = useState('feedback');
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><MessageSquareText className="size-4" />Send feedback</span>} />
      <form
        className="space-y-3 p-5"
        onSubmit={async e => {
          e.preventDefault();
          if (!message.trim()) return;
          setBusy(true);
          try {
            await addDoc(collection(db, 'feedback'), {
              userId: user.uid,
              name: profile?.firstName ?? '',
              role: profile?.role ?? 'unknown',
              topic,
              message: message.trim(),
              createdAt: serverTimestamp(),
            });
            setMessage('');
            toast.success('Thanks! Your message was sent to the Safe Learners team.');
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Select value={topic} onChange={e => setTopic(e.target.value)} aria-label="Topic">
          <option value="feedback">General feedback</option>
          <option value="problem">Report a problem</option>
          <option value="booking">Question about a booking</option>
        </Select>
        <Textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Tell us what’s on your mind…" maxLength={4000} />
        <Button type="submit" className="w-full" loading={busy} disabled={readOnly || !message.trim()}>Send</Button>
      </form>
    </Card>
  );
}
