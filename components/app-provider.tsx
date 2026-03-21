"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { processSyncQueue, type SyncRunResult } from "@/lib/sync-engine";
import type { AppSession, SessionRole } from "@/lib/types";

type SignInInput = {
  name: string;
  email: string;
  password: string;
  role: SessionRole;
};

type AppContextValue = {
  ready: boolean;
  session: AppSession | null;
  isOnline: boolean;
  isSyncing: boolean;
  lastSync: SyncRunResult | null;
  signIn: (input: SignInInput) => Promise<void>;
  signOut: () => void;
  syncNow: () => Promise<void>;
};

const SESSION_KEY = "navadrishti.session";
const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<AppSession | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncRunResult | null>(null);

  useEffect(() => {
    const storedSession = window.localStorage.getItem(SESSION_KEY);
    if (storedSession) {
      setSession(JSON.parse(storedSession) as AppSession);
    }

    setIsOnline(window.navigator.onLine);
    setReady(true);

    const handleOnlineState = () => setIsOnline(window.navigator.onLine);
    window.addEventListener("online", handleOnlineState);
    window.addEventListener("offline", handleOnlineState);

    return () => {
      window.removeEventListener("online", handleOnlineState);
      window.removeEventListener("offline", handleOnlineState);
    };
  }, []);

  const syncNow = useCallback(async () => {
    if (!window.navigator.onLine || isSyncing) {
      return;
    }

    setIsSyncing(true);
    try {
      const result = await processSyncQueue();
      setLastSync(result);
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing]);

  useEffect(() => {
    if (!ready || !session || !isOnline) {
      return;
    }

    void syncNow();
    const timer = window.setInterval(() => {
      void syncNow();
    }, 20000);

    return () => window.clearInterval(timer);
  }, [isOnline, ready, session, syncNow]);

  const signIn = useCallback(async ({ name, email, password, role }: SignInInput) => {
    if (password.trim().length < 6) {
      throw new Error("Use a password with at least 6 characters.");
    }

    const nextSession: AppSession = {
      id: globalThis.crypto.randomUUID(),
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role,
      createdAt: new Date().toISOString()
    };

    window.localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
  }, []);

  const signOut = useCallback(() => {
    window.localStorage.removeItem(SESSION_KEY);
    setSession(null);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      session,
      isOnline,
      isSyncing,
      lastSync,
      signIn,
      signOut,
      syncNow
    }),
    [isOnline, isSyncing, lastSync, ready, session, signIn, signOut, syncNow]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const context = useContext(AppContext);

  if (!context) {
    throw new Error("useAppContext must be used inside AppProvider.");
  }

  return context;
}
