import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { doc } from 'firebase/firestore';
import { allows, type Action, type AdminStatus, type ModuleKey, type Perms } from '@shared/access';
import type { UserProfile } from '@shared/domain';
import { api } from '@/lib/api';
import { useDoc, useUser } from '@/lib/data';
import { auth, db } from '@/lib/firebase';

interface AuthState {
  user: User | null;
  /** Profile of the signed-in user (or of the user an admin is viewing). */
  profile: UserProfile | null;
  /** The uid whose data screens should show. */
  uid: string | null;
  isAdmin: boolean;
  /** Cybria Super Admin (highest level; set only in server configuration). */
  isSuper: boolean;
  /** A client admin's own account (role, status, permissions); null for Super Admin and non-admins. */
  adminAccount: { status: AdminStatus; roleName?: string; perms: Perms } | null;
  /** Whether this admin may do `action` in `module` (always true for Super Admin). The server checks too. */
  can: (module: ModuleKey, action?: Action) => boolean;
  /** True while an admin is viewing someone else's account. */
  readOnly: boolean;
  loading: boolean;
  viewAs: (uid: string | null) => void;
  signOut: () => Promise<void>;
  /** Re-run onboarding (e.g. right after sign-up with a referral code). */
  onboard: (referralCode?: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const VIEW_AS_KEY = 'sl:viewAs';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuper, setIsSuper] = useState(false);
  // Routing waits for the first onboarding call after sign-in (it may grant admin rights).
  const [onboarded, setOnboarded] = useState(false);
  const [viewAsUid, setViewAsUid] = useState<string | null>(() => sessionStorageGet(VIEW_AS_KEY));

  const onboard = useCallback(async (referralCode?: string) => {
    const current = auth.currentUser;
    if (!current) return;
    try {
      const result = await api.onboardUser(referralCode ? { referralCode } : {});
      if (result.claimsChanged) await current.getIdToken(true);
    } catch (err) {
      console.warn('Onboarding call failed', err);
    }
    const token = await current.getIdTokenResult();
    setIsAdmin(token.claims.admin === true);
    setIsSuper(token.claims.sa === true);
    // One login record per browser session for admins (login history in the Super Admin).
    if (token.claims.admin === true && !sessionStorageGet('sl:adminLogin')) {
      sessionStorageSet('sl:adminLogin', '1');
      api.recordAdminLogin({}).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    return onAuthStateChanged(auth, async u => {
      setUser(u);
      if (u) {
        setOnboarded(false);
        const token = await u.getIdTokenResult();
        setIsAdmin(token.claims.admin === true);
        setIsSuper(token.claims.sa === true);
        setAuthReady(true);
        // Don't block the app for long if the network is slow.
        await Promise.race([onboard(), new Promise(r => setTimeout(r, 8000))]);
        setOnboarded(true);
      } else {
        setIsAdmin(false);
        setIsSuper(false);
        sessionStorageSet('sl:adminLogin', null);
        setViewAsUid(null);
        sessionStorageSet(VIEW_AS_KEY, null);
        setOnboarded(true);
        setAuthReady(true);
      }
    });
  }, [onboard]);

  const effectiveUid = isAdmin && viewAsUid ? viewAsUid : user?.uid ?? null;
  const profileLive = useUser(effectiveUid);
  const acctLive = useDoc(isAdmin && !isSuper && user ? doc(db, 'adminAccounts', user.uid) : null,
    (_, d) => ({ status: d.status as AdminStatus, roleName: d.roleName as string | undefined, perms: (d.perms ?? {}) as Perms }), [isAdmin, isSuper]);
  const adminAccount = acctLive.data;
  const can = useCallback((module: ModuleKey, action: Action = 'view') => isSuper || (adminAccount?.status === 'active' && allows(adminAccount.perms, module, action)), [isSuper, adminAccount]);

  const value = useMemo<AuthState>(() => ({
    user,
    profile: profileLive.data,
    uid: effectiveUid,
    isAdmin,
    isSuper,
    adminAccount,
    can,
    readOnly: isAdmin && !!viewAsUid && viewAsUid !== user?.uid,
    loading: !authReady || !onboarded || (!!effectiveUid && profileLive.loading) || (isAdmin && !isSuper && acctLive.loading),
    viewAs: uid => {
      setViewAsUid(uid);
      sessionStorageSet(VIEW_AS_KEY, uid);
    },
    signOut: async () => {
      sessionStorageSet(VIEW_AS_KEY, null);
      await fbSignOut(auth);
    },
    onboard,
  }), [user, profileLive.data, profileLive.loading, effectiveUid, isAdmin, isSuper, adminAccount, can, acctLive.loading, viewAsUid, authReady, onboarded, onboard]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Profile of the current (or viewed) user; only use inside role-guarded routes. */
export function useProfile(): UserProfile {
  const { profile } = useAuth();
  if (!profile) throw new Error('useProfile used without a loaded profile');
  return profile;
}

function sessionStorageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionStorageSet(key: string, value: string | null) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable (private mode): view-as just won't persist across reloads.
  }
}
                   