import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const TOKEN_KEY = 'xp_token';
const USER_KEY = 'xp_user';
const ANON_KEY = 'xp_anon_id';
// When a guest signs in / registers, we move their anonymous id from
// ANON_KEY → PENDING_MIGRATION_KEY so the api client stops sending it
// (the new JWT takes over), but we still remember it so the post-
// onboarding modal can offer to migrate guest progress to the new
// account.
const PENDING_MIGRATION_KEY = 'xp_pending_migration_anon_id';

// SecureStore is only on iOS/Android — fall back to AsyncStorage on web/dev
const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return AsyncStorage.getItem(key);
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return AsyncStorage.getItem(key);
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') return AsyncStorage.setItem(key, value);
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      await AsyncStorage.setItem(key, value);
    }
  },
  async del(key: string): Promise<void> {
    if (Platform.OS === 'web') return AsyncStorage.removeItem(key);
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      await AsyncStorage.removeItem(key);
    }
  },
};

export type AuthUser = {
  id: string;
  full_name: string;
  email: string;
  verified: boolean;
};

type AuthState = {
  loading: boolean;
  token: string | null;
  user: AuthUser | null;
  anonymousId: string | null;
  isAnonymous: boolean;
  signIn: (token: string, user: AuthUser) => Promise<void>;
  signOut: () => Promise<void>;
  continueAnonymously: () => Promise<void>;
  /** Set by signIn() when the user came from guest mode. The post-
   *  onboarding migration host reads this to decide whether to show
   *  the "continue guest progress?" prompt. */
  pendingMigrationAnonId: string | null;
  /** Clears pendingMigrationAnonId from state + storage. Called by the
   *  migration modal on BOTH "migrate" success and "start fresh". */
  clearPendingMigration: () => Promise<void>;
  // Set by the API client when a 403 account_suspended response arrives.
  // The root layout listens for this and renders the golden alert.
  suspension: {
    message?: string;
    forever?: boolean;
    remaining_seconds?: number | null;
    until?: string | null;
    reason?: string;
  } | null;
  clearSuspension: () => void;
};

const AuthContext = createContext<AuthState>({
  loading: true,
  token: null,
  user: null,
  anonymousId: null,
  isAnonymous: false,
  signIn: async () => {},
  signOut: async () => {},
  continueAnonymously: async () => {},
  pendingMigrationAnonId: null,
  clearPendingMigration: async () => {},
  suspension: null,
  clearSuspension: () => {},
});

// Module-level cache so api.ts can read the token / anon-id synchronously
let currentToken: string | null = null;
let currentAnonId: string | null = null;
export function getAuthToken(): string | null {
  return currentToken;
}
export function getAnonymousId(): string | null {
  return currentAnonId;
}
let onUnauthorizedCb: () => void = () => {};
export function setOnUnauthorized(fn: () => void) {
  onUnauthorizedCb = fn;
}
export function fireUnauthorized() {
  onUnauthorizedCb();
}

// ── Account-suspension propagation ─────────────────────────────
// Fired by the API client whenever the backend returns 403
// detail.error === 'account_suspended'. The root layout subscribes,
// force-logs-out the user and shows a golden alert with the time-remaining.
type SuspensionPayload = {
  message?: string;
  forever?: boolean;
  remaining_seconds?: number | null;
  until?: string | null;
  reason?: string;
};
let onSuspendedCb: (p: SuspensionPayload) => void = () => {};
export function setOnAccountSuspended(fn: (p: SuspensionPayload) => void) {
  onSuspendedCb = fn;
}
export function fireAccountSuspended(p: SuspensionPayload) {
  onSuspendedCb(p);
}

function _genAnonId(): string {
  // 16 hex chars, sufficient uniqueness for per-device anon tracking
  let out = '';
  const chars = 'abcdef0123456789';
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [anonymousId, setAnonymousId] = useState<string | null>(null);
  const [pendingMigrationAnonId, setPendingMigrationAnonId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [t, u, a, pend] = await Promise.all([
          storage.get(TOKEN_KEY),
          storage.get(USER_KEY),
          storage.get(ANON_KEY),
          storage.get(PENDING_MIGRATION_KEY),
        ]);
        if (t && u) {
          currentToken = t;
          setToken(t);
          setUser(JSON.parse(u));
          if (pend) setPendingMigrationAnonId(pend);
        } else if (a) {
          currentAnonId = a;
          setAnonymousId(a);
        }
      } catch (e) {
        console.log('auth restore', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signIn = useCallback(async (newToken: string, newUser: AuthUser) => {
    // Capture the guest's anonymous id BEFORE wiping it. The post-
    // onboarding migration prompt reads it to know whether there's
    // anything to migrate.
    let prevAnon: string | null = null;
    try {
      prevAnon = await storage.get(ANON_KEY);
    } catch {
      prevAnon = null;
    }
    currentToken = newToken;
    currentAnonId = null;
    await storage.set(TOKEN_KEY, newToken);
    await storage.set(USER_KEY, JSON.stringify(newUser));
    await storage.del(ANON_KEY);
    if (prevAnon) {
      try {
        await storage.set(PENDING_MIGRATION_KEY, prevAnon);
      } catch {
        /* non-fatal */
      }
      setPendingMigrationAnonId(prevAnon);
    }
    setToken(newToken);
    setUser(newUser);
    setAnonymousId(null);
  }, []);

  const clearPendingMigration = useCallback(async () => {
    try {
      await storage.del(PENDING_MIGRATION_KEY);
    } catch {
      /* ignore */
    }
    setPendingMigrationAnonId(null);
  }, []);

  const signOut = useCallback(async () => {
    currentToken = null;
    await storage.del(TOKEN_KEY);
    await storage.del(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const continueAnonymously = useCallback(async () => {
    let id = await storage.get(ANON_KEY);
    if (!id) {
      id = _genAnonId();
      await storage.set(ANON_KEY, id);
    }
    currentAnonId = id;
    setAnonymousId(id);
  }, []);

  // Allow api.ts to trigger sign-out on 401
  useEffect(() => {
    setOnUnauthorized(() => {
      currentToken = null;
      storage.del(TOKEN_KEY).catch(() => {});
      storage.del(USER_KEY).catch(() => {});
      setToken(null);
      setUser(null);
    });
  }, []);

  // Account-suspension: when ANY API call returns 403 account_suspended
  // we wipe the JWT (logging the user out) and stash the payload so the
  // root layout can render a golden modal explaining the suspension and
  // its remaining time. The token is removed BEFORE setOnSuspended() the
  // payload to setSuspension because the AuthGate will then send the
  // user to /auth where the alert is mounted and visible.
  const [suspension, setSuspension] = useState<any | null>(null);
  useEffect(() => {
    setOnAccountSuspended((payload) => {
      currentToken = null;
      storage.del(TOKEN_KEY).catch(() => {});
      storage.del(USER_KEY).catch(() => {});
      setToken(null);
      setUser(null);
      setSuspension(payload || { message: 'This account has been suspended.' });
    });
  }, []);
  const clearSuspension = useCallback(() => setSuspension(null), []);

  const isAnonymous = !token && !!anonymousId;

  return (
    <AuthContext.Provider value={{ loading, token, user, anonymousId, isAnonymous, signIn, signOut, continueAnonymously, pendingMigrationAnonId, clearPendingMigration, suspension, clearSuspension }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
