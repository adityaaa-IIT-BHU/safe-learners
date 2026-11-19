// Terms of use and privacy policy. DRAFT text describing what the app actually does with bookings,
// payments and personal information. It must be reviewed and approved by Safe Learners (and its legal
// adviser) before the platform goes live; the banner says so until DRAFT is set to false.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FREE_CANCELLATION_HOURS } from '@shared/domain';
import { PublicLayout, SUPPORT_EMAIL } from './Layout';

const DRAFT = true;
const UPDATED = '20 November 2026';
const BUSINESS = 'Safe Learners Australia (ABN 74 679 772 840)';

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PublicLayout>
      <article className="mx-auto max-w-3xl px-4 py-10 sm:px-6 [&_h2]:mb-2 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-bold [&_li]:mt-1 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-6 text-[15px] leading-relaxed text-ink-700 dark:text-ink-300">
        {DRAFT && (
          <p className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            Draft for review. This text has not yet been approved by Safe Learners and may change before launch.
          </p>
        )}
        <h1 className="text-3xl font-extrabold tracking-tight text-ink-950 dark:text-white">{title}</h1>
        <p className="text-sm text-ink-500">Last updated {UPDATED}</p>
        {children}
        <p className="mt-10 text-sm text-ink-500">Questions? Email <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> or visit the <Link className="underline" to="/support">Help centre</Link>.</p>
      </article>
    </PublicLayout>
  );
}

export function Terms() {
  return (
    <LegalPage title="Terms of use">
      <p>These terms apply when you use the Safe Learners website and app, run by {BUSINESS} (“Safe Learners”, “we”). By creating an account you agree to them. Nothing in these terms limits your rights under the Australian Consumer Law.</p>

      <h2>1. What Safe Learners does</h2>
      <p>Safe Learners helps learner drivers find and book lessons with driving instructors, and helps instructors manage their bookings. Instructors are responsible for delivering their lessons safely and in line with the law.</p>

      <h2>2. Your account</h2>
      <ul>
        <li>Give accurate details and keep your password private. You are responsible for activity on your account.</li>
        <li>We may suspend an account that is misused, gives false information or puts others at risk.</li>
      </ul>

      <h2>3. Bookings, changes and cancellations</h2>
      <ul>
        <li>A booking is confirmed when it appears as confirmed in your account.</li>
        <li>You can cancel or reschedule without charge up to {FREE_CANCELLATION_HOURS} hours before the lesson. Closer to the lesson, you can ask to cancel; your instructor (or the Safe Learners office) decides whether a cancellation fee applies.</li>
        <li>If an instructor or the Safe Learners office cancels or moves a lesson, you will be told, and any lesson credit used is returned to your wallet unless a fee was agreed.</li>
        <li>Instructors can propose lesson times; a proposal that is not accepted in time lapses automatically.</li>
      </ul>

      <h2>4. Prices, payment and wallet credit</h2>
      <ul>
        <li>Lesson prices are shown before you book. Payment for a lesson is due before it starts.</li>
        <li>Credit in your Safe Learners wallet is used automatically for bookings. You can ask for unused credit back; each request is reviewed and approved refunds are paid by bank transfer.</li>
        <li>Promotional and referral credit has no cash value unless we say otherwise.</li>
      </ul>

      <h2>5. Instructors</h2>
      <ul>
        <li>Instructors must hold, and keep current, the licences, checks and registrations required for driving instruction (including a driver licence, driving instructor licence, Working With Children Check and vehicle registration).</li>
        <li>Instructors upload these documents for checking. An instructor whose required documents are missing or expired may be unable to take new bookings.</li>
        <li>Safe Learners keeps a commission from lesson fees as agreed with each instructor.</li>
      </ul>

      <h2>6. Reviews and conduct</h2>
      <p>Reviews must be honest and about a real lesson. We may hide reviews or content that is abusive, misleading or unlawful. Treat everyone you meet through Safe Learners with respect.</p>

      <h2>7. Liability</h2>
      <p>We take care to keep the service available and accurate but cannot promise it will always be uninterrupted. To the extent the law allows, we are not liable for indirect loss. Your rights under the Australian Consumer Law are not affected.</p>

      <h2>8. Changes</h2>
      <p>We may update these terms. If a change materially affects you, we will tell you before it applies.</p>
    </LegalPage>
  );
}

export function Privacy() {
  return (
    <LegalPage title="Privacy policy">
      <p>This policy explains how {BUSINESS} collects, uses and protects personal information, in line with the Privacy Act 1988 (Cth) and the Australian Privacy Principles.</p>

      <h2>1. What we collect</h2>
      <ul>
        <li><b>Account details:</b> name, email, mobile number, and for learners optionally date of birth and transmission preference.</li>
        <li><b>Bookings:</b> lesson times, pick up and drop off addresses, notes, cancellations and reviews.</li>
        <li><b>Payments:</b> wallet credit, lesson payments, invoices and refund requests. Bank details only if you ask for a refund or receive payouts.</li>
        <li><b>Instructors:</b> profile, vehicle, service suburbs and working hours (shown publicly), and verification documents such as licences, Working With Children Check and vehicle registration (not shown publicly).</li>
        <li><b>Technical:</b> sign-in records and basic usage information needed to run and secure the service.</li>
      </ul>

      <h2>2. How we use it</h2>
      <ul>
        <li>To run bookings, reminders, payments, invoices and refunds.</li>
        <li>To check instructors’ documents and whether they can take bookings.</li>
        <li>To support you, keep the service secure, and meet our legal and accounting obligations.</li>
      </ul>

      <h2>3. Who can see it</h2>
      <ul>
        <li>Your instructor sees the details needed for your lessons; you see your instructor’s contact details for your bookings.</li>
        <li>Authorised Safe Learners staff see what their role requires. Every administrator action is recorded.</li>
        <li>Service providers that help us run Safe Learners, under confidentiality: cloud hosting (data stored in Sydney, Australia), accounting software for invoices and payments, email delivery, and an OCR (automatic document reading) service.</li>
      </ul>

      <h2>4. Information sent overseas</h2>
      <p>Instructor verification documents are read automatically by an OCR service that processes them in the United States. Only the document image is sent, and the results are stored back in Australia. We take reasonable steps to ensure overseas providers protect the information in line with the Australian Privacy Principles.</p>

      <h2>5. Keeping it safe and how long we keep it</h2>
      <p>Information is stored with access controls, encryption in transit and regular backups. We keep records for as long as your account is active and as long as the law requires afterwards (for example, financial records). Unneeded document data is removed on a schedule.</p>

      <h2>6. Your choices and rights</h2>
      <ul>
        <li>You can view and update most of your details in your account.</li>
        <li>You can ask for a copy of your information, ask us to correct it, or ask us to close your account by emailing <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</li>
        <li>If you are not happy with how we handled a privacy matter, contact us first. You can also complain to the Office of the Australian Information Commissioner (oaic.gov.au).</li>
      </ul>

      <h2>7. Changes</h2>
      <p>We will post any update to this policy here and tell you about significant changes.</p>
    </LegalPage>
  );
}
