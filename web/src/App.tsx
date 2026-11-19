import { Suspense, lazy, type ReactNode } from 'react';
import { SectionGuard } from '@/lib/adminAccess';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import type { Role } from '@shared/domain';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { AppShell } from '@/components/AppShell';
import { PageLoader } from '@/components/ui';
import { homePath } from '@/lib/routes';
import { useTheme } from '@/lib/theme';

type ComponentOf<T> = T extends React.ComponentType<infer P> ? React.ComponentType<P> : never;

/** Lazy-loads a named export, keeping its props type. */
const page = <M, K extends keyof M>(loader: () => Promise<M>, name: K) =>
  lazy(() => loader().then(m => ({ default: m[name] as ComponentOf<M[K]> })));

// Public
const Landing = page(() => import('@/pages/public/Landing'), 'Landing');
const Login = page(() => import('@/pages/public/Auth'), 'Login');
const Signup = page(() => import('@/pages/public/Auth'), 'Signup');
const ResetPassword = page(() => import('@/pages/public/Auth'), 'ResetPassword');
const FindInstructors = page(() => import('@/pages/public/FindInstructors'), 'FindInstructors');
const InstructorProfile = page(() => import('@/pages/public/InstructorProfile'), 'InstructorProfile');
const Support = page(() => import('@/pages/public/Support'), 'Support');
const Terms = page(() => import('@/pages/public/Legal'), 'Terms');
const Privacy = page(() => import('@/pages/public/Legal'), 'Privacy');
const NotFound = page(() => import('@/pages/public/NotFound'), 'NotFound');

// Learner
const LearnerDashboard = page(() => import('@/pages/learner/Dashboard'), 'LearnerDashboard');
const BookLesson = page(() => import('@/pages/learner/BookLesson'), 'BookLesson');
const LearnerBooking = page(() => import('@/pages/learner/BookingDetail'), 'LearnerBookingDetail');
const LearnerWallet = page(() => import('@/pages/learner/Wallet'), 'Wallet');
const LearnerInvoices = page(() => import('@/pages/learner/Invoices'), 'LearnerInvoices');
const Refer = page(() => import('@/pages/learner/Refer'), 'Refer');
const LearnerProfile = page(() => import('@/pages/learner/Profile'), 'LearnerProfile');

// Instructor
const InstructorDashboard = page(() => import('@/pages/instructor/Dashboard'), 'InstructorDashboard');
const Calendar = page(() => import('@/pages/instructor/Calendar'), 'Calendar');
const InstructorBooking = page(() => import('@/pages/instructor/BookingDetail'), 'InstructorBookingDetail');
const Propose = page(() => import('@/pages/instructor/Propose'), 'Propose');
const Learners = page(() => import('@/pages/instructor/Learners'), 'Learners');
const LearnerDetail = page(() => import('@/pages/instructor/Learners'), 'LearnerDetail');
const Availability = page(() => import('@/pages/instructor/Availability'), 'Availability');
const CalendarSettings = page(() => import('@/pages/instructor/CalendarSettings'), 'CalendarSettings');
const AdminReviews = page(() => import('@/pages/admin/Reviews'), 'AdminReviews');
const Pricing = page(() => import('@/pages/instructor/Pricing'), 'Pricing');
const Reports = page(() => import('@/pages/instructor/Reports'), 'Reports');
const Reviews = page(() => import('@/pages/instructor/Reviews'), 'Reviews');
const ProfileEdit = page(() => import('@/pages/instructor/ProfileEdit'), 'ProfileEdit');
const Verification = page(() => import('@/pages/instructor/Verification'), 'Verification');
const InstructorSettings = page(() => import('@/pages/instructor/Settings'), 'InstructorSettings');

// Admin
const AdminOverview = page(() => import('@/pages/admin/Overview'), 'AdminOverview');
const AdminVerifications = page(() => import('@/pages/admin/Verifications'), 'AdminVerifications');
const AdminUsers = page(() => import('@/pages/admin/Users'), 'AdminUsers');
const AdminUser = page(() => import('@/pages/admin/Users'), 'AdminUserDetail');
const AdminBookings = page(() => import('@/pages/admin/Bookings'), 'AdminBookings');
const AdminTools = page(() => import('@/pages/admin/Tools'), 'AdminTools');
const AdminXero = page(() => import('@/pages/admin/Xero'), 'AdminXero');
const AdminFinance = page(() => import('@/pages/admin/Finance'), 'AdminFinance');
const AdminSettings = page(() => import('@/pages/admin/Settings'), 'AdminSettings');
const OcrAutomationSettings = page(() => import('@/pages/admin/Settings'), 'OcrAutomationSettings');
const CybriaShell = page(() => import('@/pages/cybria/CybriaShell'), 'CybriaShell');
const CybriaLogin = page(() => import('@/pages/cybria/CybriaShell'), 'CybriaLogin');
const RequireSuper = page(() => import('@/pages/cybria/CybriaShell'), 'RequireSuper');
const CybriaDashboard = page(() => import('@/pages/cybria/Dashboard'), 'CybriaDashboard');
const ClientAdmins = page(() => import('@/pages/cybria/ClientAdmins'), 'ClientAdmins');
const Roles = page(() => import('@/pages/cybria/Roles'), 'Roles');
const CommissionManagement = page(() => import('@/pages/admin/CommissionManagement'), 'CommissionManagement');

function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { user, profile, isAdmin, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (role === 'admin') return isAdmin ? <>{children}</> : <Navigate to={profile && profile.role !== 'admin' ? homePath(profile.role) : '/'} replace />;
  if (!profile) return <PageLoader />;
  if (profile.role !== role) return <Navigate to={homePath(profile.role)} replace />;
  return <>{children}</>;
}

/** Sends signed-in users from /app to their home. */
function AppRedirect() {
  const { user, profile, isAdmin, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  if (!profile && isAdmin) return <Navigate to="/admin" replace />;
  return <Navigate to={homePath(profile?.role)} replace />;
}

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster position="top-center" richColors closeButton theme={theme} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ThemedToaster />
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup role="learner" />} />
            <Route path="/instructor/signup" element={<Signup role="instructor" />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/instructors" element={<FindInstructors />} />
            <Route path="/instructors/:id" element={<InstructorProfile />} />
            <Route path="/support" element={<Support audience="learner" />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/app" element={<AppRedirect />} />

            <Route path="/learner" element={<RequireRole role="learner"><AppShell role="learner" /></RequireRole>}>
              <Route index element={<LearnerDashboard />} />
              <Route path="instructors" element={<FindInstructors embedded />} />
              <Route path="instructors/:id" element={<InstructorProfile embedded />} />
              <Route path="book/:instructorId" element={<BookLesson />} />
              <Route path="bookings/:id" element={<LearnerBooking />} />
              <Route path="wallet" element={<LearnerWallet />} />
              <Route path="invoices" element={<LearnerInvoices />} />
              <Route path="refer" element={<Refer />} />
              <Route path="support" element={<Support audience="learner" embedded />} />
              <Route path="profile" element={<LearnerProfile />} />
            </Route>

            <Route path="/instructor" element={<RequireRole role="instructor"><AppShell role="instructor" /></RequireRole>}>
              <Route index element={<InstructorDashboard />} />
              <Route path="calendar" element={<Calendar />} />
              <Route path="bookings/:id" element={<InstructorBooking />} />
              <Route path="propose" element={<Propose />} />
              <Route path="learners" element={<Learners />} />
              <Route path="learners/:id" element={<LearnerDetail />} />
              <Route path="availability" element={<Availability />} />
              <Route path="calendar-settings" element={<CalendarSettings />} />
              <Route path="pricing" element={<Pricing />} />
              <Route path="reports" element={<Reports />} />
              <Route path="reviews" element={<Reviews />} />
              <Route path="profile" element={<ProfileEdit />} />
              <Route path="verification" element={<Verification />} />
              <Route path="settings" element={<InstructorSettings />} />
              <Route path="support" element={<Support audience="instructor" embedded />} />
            </Route>

            <Route path="/admin" element={<RequireRole role="admin"><AppShell role="admin" /></RequireRole>}>
              <Route index element={<SectionGuard path="/admin"><AdminOverview /></SectionGuard>} />
              <Route path="verifications" element={<SectionGuard path="/admin/verifications"><AdminVerifications /></SectionGuard>} />
              <Route path="users" element={<SectionGuard path="/admin/users"><AdminUsers /></SectionGuard>} />
              <Route path="users/:id" element={<SectionGuard path="/admin/users"><AdminUser /></SectionGuard>} />
              <Route path="bookings" element={<SectionGuard path="/admin/bookings"><AdminBookings /></SectionGuard>} />
              <Route path="reviews" element={<SectionGuard path="/admin/reviews"><AdminReviews /></SectionGuard>} />
              <Route path="tools" element={<SectionGuard path="/admin/tools"><AdminTools /></SectionGuard>} />
              <Route path="xero" element={<SectionGuard path="/admin/xero"><AdminXero /></SectionGuard>} />
              <Route path="finance" element={<SectionGuard path="/admin/finance"><AdminFinance /></SectionGuard>} />
              <Route path="settings" element={<SectionGuard path="/admin/settings"><AdminSettings /></SectionGuard>} />
            </Route>

            {/* Cybria Super Admin Control Centre (Super Admin only; others see "not found") */}
            <Route path="/cybria/login" element={<CybriaLogin />} />
            <Route path="/cybria" element={<RequireSuper><CybriaShell /></RequireSuper>}>
              <Route index element={<CybriaDashboard />} />
              <Route path="admins" element={<ClientAdmins />} />
              <Route path="roles" element={<Roles />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="bookings" element={<AdminBookings />} />
              <Route path="documents" element={<AdminVerifications cybria />} />
              <Route path="ocr" element={<OcrAutomationSettings />} />
              <Route path="finance" element={<AdminFinance />} />
              <Route path="commission" element={<CommissionManagement />} />
              <Route path="xero" element={<AdminXero />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
