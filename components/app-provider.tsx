"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { processSyncQueue, pullProjectData, logStep, logStepError, type SyncRunResult } from "@/lib/sync-engine";
import { apiFetch, FIELD_APP_NAME } from "@/lib/env";
import { resolveUserAvatarUrl } from "@/lib/utils";
import { getSupabaseClient } from "@/lib/supabase-browser";
import { db } from "@/lib/db";
import type { AppSession, SessionRole } from "@/lib/types";
import { ProductBrand } from "@/components/product-brand";

type SignInInput = {
  name: string;
  email: string;
  password: string;
  role: SessionRole;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
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
  applySession: (session: AppSession) => void;
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
    await db.transaction(
      "rw",
      [
        db.recordsLocal,
        db.mediaLocal,
        db.syncQueue,
        db.syncLog,
        db.milestones,
        db.referencePoints,
        db.attendanceCache,
        db.attendanceOutbox,
      ],
      async () => {
        await db.recordsLocal.clear();
        await db.mediaLocal.clear();
        await db.syncQueue.clear();
        await db.syncLog.clear();
        await db.milestones.clear();
        await db.referencePoints.clear();
        await db.attendanceCache.clear();
        await db.attendanceOutbox.clear();
      }
    );
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
    await db.transaction("rw", [db.milestones, db.referencePoints, db.attendanceCache], async () => {
      await db.milestones.clear();
      await db.referencePoints.clear();
      await db.attendanceCache.clear();
    });
    console.log("[AppProvider] Shared cache cleared (sign-out). Pending uploads preserved.");
  } catch (err) {
    console.error("[AppProvider] Failed to clear shared cache:", err);
  }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [missingEnv, setMissingEnv] = useState<string[]>([]);
  const [session, setSession] = useState<AppSession | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncRunResult | null>(null);
  const syncingRef = useRef(false);

  useEffect(() => {
    // Restore session immediately — don't wait on network
    try {
      const storedSession = window.localStorage.getItem(SESSION_KEY);
      if (storedSession) {
        setSession(JSON.parse(storedSession) as AppSession);
      }
    } catch {
      window.localStorage.removeItem(SESSION_KEY);
    }
    setReady(true);

    void apiFetch("/api/session")
      .then((res) => res.json())
      .then((data) => {
        setConfigured(Boolean(data.configured));
        setMissingEnv(Array.isArray(data.missingEnv) ? data.missingEnv : []);
      })
      .catch(() => setConfigured(true));

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

      if (session.role === "ngo") {
        logStep("syncNow: Calling pullProjectData");
        await pullProjectData();
      }

      // Process uploads in queue for THIS signed-in user only (evidence + attendance)
      logStep(`syncNow: Processing sync queue for user ${session.id}`);
      const result = await processSyncQueue(session.id);
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

  useEffect(() => {
    if (!ready || !session) {
      return;
    }

    let cancelled = false;

    void apiFetch("/api/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.profile || !session) return;

        const avatarUrl =
          typeof data.profile.avatarUrl === "string" || data.profile.avatarUrl === null
            ? data.profile.avatarUrl
            : undefined;
        const name =
          typeof data.profile.name === "string" && data.profile.name.trim()
            ? data.profile.name.trim()
            : session.name;

        if (avatarUrl === session.avatarUrl && name === session.name) {
          return;
        }

        const nextSession: AppSession = {
          ...session,
          name,
          ngoName: name,
          avatarUrl: avatarUrl ?? session.avatarUrl ?? null,
        };

        window.localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
        setSession(nextSession);
      })
      .catch(() => {
        // Profile refresh is best-effort; cached session remains usable.
      });

    return () => {
      cancelled = true;
    };
  }, [ready, session?.id]);

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
      profile_data?: unknown;
      profile_image?: string | null;
    }

    // 2. Fetch User Profile and Verification status
    const { data: profileData, error: profileError } = await supabase
      .from("users")
      .select(
        "id, name, user_type, email_verified, phone_verified, verification_status, profile_image, profile_data",
      )
      .eq("email", userEmail)
      .single();

    if (profileError || !profileData) {
      await supabase.auth.signOut();
      throw new Error("Could not fetch your profile from the database.");
    }

    const profile = profileData as unknown as UserProfile;

    // 3. Verification Guard
    const isEmailVerified = profile.email_verified === true;
    const isDocsVerified = profile.verification_status === "verified";
    const userType = String(profile.user_type || "").toLowerCase();

    if (!isEmailVerified) {
      await supabase.auth.signOut();
      throw new Error("Email is not verified. Verify your email on the platform, then try again.");
    }

    if (userType === "ngo" && !isDocsVerified) {
      await supabase.auth.signOut();
      throw new Error("Verification is incomplete. Fully verified accounts can access the field app.");
    }

    // 4. Role Guard — NGO evidence / individual attendance only
    if (userType !== "ngo" && userType !== "individual") {
      await supabase.auth.signOut();
      throw new Error("This account cannot access the field app.");
    }

    const nextSession: AppSession = {
      id: profile.id.toString(),
      name: profile.name,
      ngoId: profile.id,
      ngoName: profile.name,
      email: authData.user.email!,
      role: userType as SessionRole,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 24 * 7 * 1000,
      createdAt: new Date().toISOString(),
      avatarUrl: resolveUserAvatarUrl({
        profileImage: profile.profile_image,
        profileData: profile.profile_data,
      }),
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

  const applySession = useCallback((nextSession: AppSession) => {
    window.localStorage.setItem(LAST_USER_KEY, nextSession.id);
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
      configured,
      missingEnv,
      session,
      isOnline,
      isSyncing,
      lastSync,
      signIn,
      applySession,
      signOut,
      syncNow
    }),
    [configured, isOnline, isSyncing, lastSync, missingEnv, ready, session, signIn, applySession, signOut, syncNow]
  );

  return (
    <AppContext.Provider value={value}>
      <InstallGate>{children}</InstallGate>
    </AppContext.Provider>
  );
}

function isStandaloneApp() {
  if (typeof window === "undefined") return false;
  const media = window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone = Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
  return media || iosStandalone;
}

function InstallGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [installing, setInstalling] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const [canPrompt, setCanPrompt] = useState(false);

  useEffect(() => {
    setInstalled(isStandaloneApp());
    setReady(true);

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      deferredPrompt.current = event as BeforeInstallPromptEvent;
      setCanPrompt(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", () => setInstalled(true));

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    };
  }, []);

  async function handleInstall() {
    if (!deferredPrompt.current) return;
    setInstalling(true);
    try {
      await deferredPrompt.current.prompt();
      const choice = await deferredPrompt.current.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
    } finally {
      deferredPrompt.current = null;
      setCanPrompt(false);
      setInstalling(false);
    }
  }

  if (!ready) return null;

  const isLocalDev =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  if (installed || isLocalDev) return <>{children}</>;

  return (
    <main className="login-screen">
      <div className="login-shell">
        <ProductBrand
          size="md"
          nameClassName="brand-name-on-field"
          poweredClassName="brand-powered-on-field"
        />
        <section className="login-card">
          <h1 style={{ margin: "0 0 8px", fontSize: "1.25rem" }}>Install {FIELD_APP_NAME}</h1>
          <p className="subtle" style={{ marginBottom: 16 }}>
            {FIELD_APP_NAME} is meant to run as an installed app on your phone. Install it once,
            then open it from your home screen.
          </p>
          {canPrompt ? (
            <button type="button" onClick={() => void handleInstall()} disabled={installing}>
              {installing ? "Installing…" : `Install ${FIELD_APP_NAME}`}
            </button>
          ) : (
            <div className="install-steps">
              <p className="subtle" style={{ marginBottom: 8 }}>On your phone browser:</p>
              <ol style={{ margin: 0, paddingLeft: 18, color: "#334155", fontSize: "0.9rem", lineHeight: 1.5 }}>
                <li>Open the browser menu</li>
                <li>Tap <strong>Add to Home Screen</strong> / <strong>Install app</strong></li>
                <li>Open {FIELD_APP_NAME} from your home screen</li>
              </ol>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);

  if (!context) {
    throw new Error("useAppContext must be used inside AppProvider.");
  }

  return context;
}
