"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { processSyncQueue, pullProjectData, pullAwcData, logStep, logStepError, type SyncRunResult } from "@/lib/sync-engine";
import { getSupabaseClient } from "@/lib/supabase-browser";
import { db } from "@/lib/db";
import type { AppSession, SessionRole } from "@/lib/types";

type SignInInput = {
  name: string;
  email: string;
  password: string;
  role: SessionRole;
};

type AppContextValue = {
  ready: boolean;
  sessionLoading: boolean;
  configured: boolean;
  missingEnv: string[];
  session: AppSession | null;
  isOnline: boolean;
  isSyncing: boolean;
  lastSync: SyncRunResult | null;
  signIn: (input: SignInInput) => Promise<void>;
  signOut: () => void;
  syncNow: () => Promise<void>;
};

const SESSION_KEY = "navadrishti.session";
const LAST_USER_KEY = "navadrishti.lastUserId";
const AppContext = createContext<AppContextValue | null>(null);

/**
 * Full wipe — called on USER SWITCH.
 * Clears all local tables including the user's own submissions and queue.
 */
async function clearAllLocalData() {
  try {
    await db.transaction("rw", [
      db.recordsLocal,
      db.mediaLocal,
      db.syncQueue,
      db.syncLog,
      db.remoteRecords,
      db.milestones,
      db.referencePoints
    ], async () => {
      await db.recordsLocal.clear();
      await db.mediaLocal.clear();
      await db.syncQueue.clear();
      await db.syncLog.clear();
      await db.remoteRecords.clear();
      await db.milestones.clear();
      await db.referencePoints.clear();
    });
    console.log("[AppProvider] Full local data wipe complete (user switch).");
  } catch (err) {
    console.error("[AppProvider] Failed to clear local data:", err);
  }
}

/**
 * Partial wipe — called on SIGN-OUT.
 * Only clears cached/shared data. Preserves the user's own
 * pending records, sync queue and media blobs so they survive
 * a re-login on the same device.
 */
async function clearSharedCacheData() {
  try {
    await db.transaction("rw", [
      db.remoteRecords,
      db.milestones,
      db.referencePoints
    ], async () => {
      await db.remoteRecords.clear();
      await db.milestones.clear();
      await db.referencePoints.clear();
    });
    console.log("[AppProvider] Shared cache cleared (sign-out).");
  } catch (err) {
    console.error("[AppProvider] Failed to clear shared cache:", err);
  }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<AppSession | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncRunResult | null>(null);
  const syncingRef = useRef(false);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setReady(true);
      return;
    }

    // Check for existing session
    void supabase.auth.getSession().then(({ data: { session: supabaseSession } }) => {
      // Check for existing session in localStorage (priority for our custom API login)
      const storedSession = window.localStorage.getItem(SESSION_KEY);
      if (storedSession) {
        setSession(JSON.parse(storedSession) as AppSession);
      } else if (supabaseSession) {
        // Fallback or sync with Supabase if needed (optional)
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
    logStep("syncNow: Triggered");
    if (!window.navigator.onLine) {
      logStepError("syncNow: navigator.onLine is false");
      return;
    }
    if (syncingRef.current) {
      logStep("syncNow: Already syncing, skipped");
      return;
    }

    syncingRef.current = true;
    setIsSyncing(true);
    try {
      logStep(`syncNow: Checking session, role = ${session?.role}`);
      if (!session) {
        logStepError("syncNow: Session is null");
        return;
      }
      
      if (session.role === "gov") {
        logStep("syncNow: Calling pullAwcData");
        await pullAwcData();
      } else {
        logStep("syncNow: Calling pullProjectData");
        await pullProjectData();
      }
      
      // 2. Process uploads in queue
      logStep("syncNow: Processing sync queue");
      const result = await processSyncQueue();
      setLastSync(result);
      logStep(`syncNow: Completed. Queue processed: ${result.processed}, succeeded: ${result.succeeded}`);
    } catch (err: any) {
      logStepError(`syncNow: Failed with error: ${err.message || String(err)}`);
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
    }
  }, [session]);

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
      ngoId: profile.id,
      ngoName: profile.name,
      email: authData.user.email!,
      role: role,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 24 * 7 * 1000,
      createdAt: new Date().toISOString()
    };

    // Full wipe only when a DIFFERENT user signs in
    const lastUserId = window.localStorage.getItem(LAST_USER_KEY);
    if (lastUserId && lastUserId !== profile.id.toString()) {
      console.log("[AppProvider] User switch detected. Clearing all local data.");
      await clearAllLocalData();
    }
    window.localStorage.setItem(LAST_USER_KEY, profile.id.toString());
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseClient();
    if (supabase) {
      await supabase.auth.signOut();
    }
    // Only clear shared/cached data — preserve user's own pending records
    await clearSharedCacheData();
    window.localStorage.removeItem(SESSION_KEY);
    // Keep LAST_USER_KEY so we can detect a future user switch
    setSession(null);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      sessionLoading: !ready,
      configured: true, // We assume true for now, can be linked to env check later
      missingEnv: [],
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
