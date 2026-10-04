"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { processSyncQueue, pullProjectData, logStep, logStepError, type SyncRunResult } from "@/lib/sync-engine";
import { apiFetch, FIELD_APP_NAME } from "@/lib/env";
import { getSupabaseClient } from "@/lib/supabase-browser";
import { db } from "@/lib/db";
import type { AppSession } from "@/lib/types";
import { ProductBrand } from "@/components/product-brand";

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
  applySession: (session: AppSession) => Promise<void>;
  signOut: () => Promise<void>;
  syncNow: () => Promise<void>;
};

const SESSION_KEY = "navadrishti.session";
const LAST_USER_KEY = "navadrishti.lastUserId";
const AppContext = createContext<AppContextValue | null>(null);

/**
 * Called on USER SWITCH. Shared caches and the previous user's synced history are removed.
 * Unsynced marks and evidence stay: they are scoped to their owner and upload when that user signs in again.
 */
async function clearDataForUserSwitch(nextUserId: string) {
  try {
    await db.transaction(
      "rw",
      [db.recordsLocal, db.syncLog, db.milestones, db.referencePoints, db.attendanceCache],
      async () => {
        await db.recordsLocal
          .filter((record) => record.userId !== nextUserId && record.status === "synced")
          .delete();
        await db.syncLog.clear();
        await db.milestones.clear();
        await db.referencePoints.clear();
        await db.attendanceCache.clear();
      }
    );
  } catch (err) {
    console.error("[AppProvider] Failed to clear local data on user switch:", err);
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
        // Uploads must not wait on a failed project refresh.
        await pullProjectData().catch((err: unknown) => {
          logStepError(`syncNow: Project refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        });
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

  const applySession = useCallback(async (nextSession: AppSession) => {
    const lastUserId = window.localStorage.getItem(LAST_USER_KEY);
    if (lastUserId && lastUserId !== nextSession.id) {
      await clearDataForUserSwitch(nextSession.id);
    }
    window.localStorage.setItem(LAST_USER_KEY, nextSession.id);
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseClient();
    await Promise.allSettled([
      apiFetch("/api/logout", { method: "POST" }),
      supabase ? supabase.auth.signOut() : Promise.resolve(),
    ]);
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
      applySession,
      signOut,
      syncNow
    }),
    [configured, isOnline, isSyncing, lastSync, missingEnv, ready, session, applySession, signOut, syncNow]
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
