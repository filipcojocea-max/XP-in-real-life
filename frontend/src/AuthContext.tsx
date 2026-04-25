import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const TOKEN_KEY = 'xp_token';
const USER_KEY = 'xp_user';

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
  signIn: (token: string, user: AuthUser) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  loading: true,
  token: null,
  user: null,
  signIn: async () => {},
  signOut: async () => {},
});

// Module-level cache so api.ts can read the token synchronously
let currentToken: string | null = null;
export function getAuthToken(): string | null {
  return currentToken;
}
let onUnauthorizedCb: () => void = () => {};
export function setOnUnauthorized(fn: () => void) {
  onUnauthorizedCb = fn;
}
export function fireUnauthorized() {
  onUnauthorizedCb();
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [t, u] = await Promise.all([storage.get(TOKEN_KEY), storage.get(USER_KEY)]);
        if (t && u) {
          currentToken = t;
          setToken(t);
          setUser(JSON.parse(u));
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
    await storage.set(TOKEN_KEY, newToken);
    await storage.set(USER_KEY, JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  }, []);

  const signOut = useCallback(async () => {
    currentToken = null;
    await storage.del(TOKEN_KEY);
    await storage.del(USER_KEY);
    setToken(null);
    setUser(null);
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

  return (
    <AuthContext.Provider value={{ loading, token, user, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
