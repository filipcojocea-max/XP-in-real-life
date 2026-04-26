import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const TOKEN_KEY = 'xp_token';
const USER_KEY = 'xp_user';
const ANON_KEY = 'xp_anon_id';

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

  useEffect(() => {
    (async () => {
      try {
        const [t, u, a] = await Promise.all([
          storage.get(TOKEN_KEY),
          storage.get(USER_KEY),
          storage.get(ANON_KEY),
        ]);
        if (t && u) {
          currentToken = t;
          setToken(t);
          setUser(JSON.parse(u));
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
    currentToken = newToken;
    currentAnonId = null;
    await storage.set(TOKEN_KEY, newToken);
    await storage.set(USER_KEY, JSON.stringify(newUser));
    await storage.del(ANON_KEY);
    setToken(newToken);
    setUser(newUser);
    setAnonymousId(null);
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

  const isAnonymous = !token && !!anonymousId;

  return (
    <AuthContext.Provider value={{ loading, token, user, anonymousId, isAnonymous, signIn, signOut, continueAnonymously }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
