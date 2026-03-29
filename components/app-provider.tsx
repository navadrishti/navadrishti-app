"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { processSyncQueue, type SyncRunResult } from "@/lib/sync-engine";
import { getSupabaseClient } from "@/lib/supabase-browser";
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
    const supabase = getSupabaseClient();
    if (!supabase) {
      setReady(true);
      return;
    }

    // Check for existing session
    void supabase.auth.getSession().then(({ data: { session: supabaseSession } }) => {
      if (supabaseSession) {
        // We still trust localStorage for the cached profile roles for now
        const storedSession = window.localStorage.getItem(SESSION_KEY);
        if (storedSession) {
          setSession(JSON.parse(storedSession) as AppSession);
        }
      }
      setReady(true);
    });

    setIsOnline(window.navigator.onLine);

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

  const signIn = useCallback(async ({ email, password, role }: SignInInput) => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      throw new Error("Supabase client is not initialized. check your .env.local file.");
    }

    // 1. Authenticate with Supabase
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password: password.trim(),
    });

    if (authError) throw authError;
    const userEmail = authData.user?.email;
    if (!userEmail) throw new Error("Authentication failed: No user email returned.");

    interface UserProfile {
      id: number;
      name: string;
      user_type: string;
      email_verified: boolean;
      phone_verified: boolean;
      verification_status: string;
    }

    // 2. Fetch User Profile and Verification status
    const { data: profileData, error: profileError } = await supabase
      .from("users")
      .select("id, name, user_type, email_verified, phone_verified, verification_status")
      .eq("email", userEmail)
      .single();

    if (profileError || !profileData) {
      await supabase.auth.signOut();
      throw new Error("Could not fetch your profile from the database.");
    }

    const profile = profileData as unknown as UserProfile;

    // 3. Verification Guard (Pilot requirement)
    // login is enabled only for those ngos who have Phone, email and docs all three verified
    const isEmailVerified = profile.email_verified === true;
    const isPhoneVerified = profile.phone_verified === true;
    const isDocsVerified = profile.verification_status === "verified";

    if (!isEmailVerified || !isPhoneVerified || !isDocsVerified) {
      const missing = [];
      if (!isEmailVerified) missing.push("Email");
      if (!isPhoneVerified) missing.push("Phone");
      if (!isDocsVerified) missing.push("Documents");
      
      await supabase.auth.signOut();
      throw new Error(`Profile Incomplete: Please ensure your ${missing.join(", ")} are verified in the main portal before using the Field App.`);
    }

    // 4. Role Guard
    if (profile.user_type !== role) {
      await supabase.auth.signOut();
      throw new Error(`Access Denied: Your account is registered as ${profile.user_type}, but you tried to sign in as ${role}.`);
    }

    const nextSession: AppSession = {
      id: profile.id.toString(),
      name: profile.name,
      email: authData.user.email!,
      role: role,
      createdAt: new Date().toISOString()
    };

    window.localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseClient();
    if (supabase) {
      await supabase.auth.signOut();
    }
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
