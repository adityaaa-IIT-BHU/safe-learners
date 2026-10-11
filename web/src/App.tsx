import { Suspense, lazy, type ReactNode } from 'react';
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
const NotFound = page(() => import('@/pages/public/NotFound'), 'NotFound');

// Learner
const LearnerDashboard = page(() => import('@/pages/learner/Dashboard'), 'LearnerDashboard');
const BookLesson = page(() => import('@/pages/learner/BookLesson'), 'BookLesson');
const LearnerBooking = page(() => import('@/pages/learner/BookingDetail'), 'LearnerBookingDetail');
const LearnerWallet = page(() => import('@/pages/learner/Wallet'), 'Wallet');
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
            <Route path="/app" element={<AppRedirect />} />

            <Route path="/learner" element={<RequireRole role="learner"><AppShell role="learner" /></RequireRole>}>
              <Route index element={<LearnerDashboard />} />
              <Route path="instructors" element={<FindInstructors embedded />} />
              <Route path="instructors/:id" element={<InstructorProfile embedded />} />
              <Route path="book/:instructorId" element={<BookLesson />} />
              <Route path="bookings/:id" element={<LearnerBooking />} />
              <Route path="wallet" element={<LearnerWallet />} />
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
              <Route index element={<AdminOverview />} />
              <Route path="verifications" element={<AdminVerifications />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="users/:id" element={<AdminUser />} />
              <Route path="bookings" element={<AdminBookings />} />
              <Route path="reviews" element={<AdminReviews />} />
              <Route path="tools" element={<AdminTools />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
