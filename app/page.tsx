"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { db } from "@/lib/db";
import { getDeviceId } from "@/lib/device";
import type {
  CloudinaryAssetReference,
  DraftDocumentEvidence,
  DraftMediaSyncStatus,
  DraftPhotoEvidence,
  ProjectDraft,
} from "@/lib/types";

interface SessionPayload {
  ngoId: number;
  ngoName: string;
  email: string;
}

interface SessionResponse {
  configured: boolean;
  missingEnv?: string[];
  session: SessionPayload | null;
}

interface MockProject {
  id: string;
  title: string;
  companyName: string;
  status: "ongoing" | "completed";
  acceptanceDate: string;
  progress: number;
  nextMilestone: string;
  nextMilestoneDeadline: string;
  location: string;
  summary: string;
  milestones: MockMilestone[];
  beneficiariesReached: number;
  fundsUtilized: number;
}

interface MockMilestone {
  id: string;
  title: string;
  description: string;
  order: number;
  amount: number;
  deadline: string;
  status: "pending" | "submitted" | "approved" | "rejected";
  paymentStatus: "pending" | "confirmed";
  evidenceRequirements: string[];
}

interface CapturedPhoto {
  id: string;
  capturedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  deviceId: string;
  blob: Blob;
  imageUrl: string;
  proofHash: string;
  lockedAt: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  syncStatus: DraftMediaSyncStatus;
  syncError: string | null;
  cloudinary: CloudinaryAssetReference | null;
}

interface ScannedDocument {
  id: string;
  name: string;
  scannedAt: string;
  sizeLabel: string;
  size: number;
  mimeType: string;
  blob: Blob;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  deviceId: string;
  previewUrl: string;
  proofHash: string;
  lockedAt: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  syncStatus: DraftMediaSyncStatus;
  syncError: string | null;
  cloudinary: CloudinaryAssetReference | null;
}

type DevicePermissionState = "granted" | "prompt" | "denied" | "unsupported";

type CameraMode = "photo" | "document";

type SyncSummary = {
  attempted: number;
  synced: number;
  failed: number;
  deferred: number;
  remaining: number;
};

const mockProjects: MockProject[] = [
  {
    id: "solar-health-001",
    title: "Solar Health Van Deployment",
    companyName: "Aster Renewables Foundation",
    status: "ongoing",
    acceptanceDate: "2026-02-10",
    progress: 68,
    nextMilestone: "Village cluster 4 outreach camp",
    nextMilestoneDeadline: "2026-03-21",
    location: "Nagpur Rural Block, Maharashtra",
    summary: "Deploy mobile health camps, collect service evidence, and record last-mile beneficiary interactions.",
    beneficiariesReached: 860,
    fundsUtilized: 125000,
    milestones: [
      {
        id: "solar-health-001-setup",
        title: "Setup",
        description: "Training center and mobile health base setup proof.",
        order: 1,
        amount: 50000,
        deadline: "2026-02-18",
        status: "approved",
        paymentStatus: "confirmed",
        evidenceRequirements: ["photos", "receipts"],
      },
      {
        id: "solar-health-001-phase-1",
        title: "Phase 1",
        description: "Submit attendance, field photos, and beneficiary proof for the first outreach batch.",
        order: 2,
        amount: 75000,
        deadline: "2026-03-21",
        status: "submitted",
        paymentStatus: "pending",
        evidenceRequirements: ["attendance", "photos", "gps"],
      },
      {
        id: "solar-health-001-completion",
        title: "Completion",
        description: "Final impact report and beneficiary list for closeout.",
        order: 3,
        amount: 25000,
        deadline: "2026-04-05",
        status: "pending",
        paymentStatus: "pending",
        evidenceRequirements: ["impact report", "beneficiary list"],
      },
    ],
  },
  {
    id: "nutrition-drive-014",
    title: "Community Nutrition Recovery Drive",
    companyName: "NorthStar Foods CSR",
    status: "ongoing",
    acceptanceDate: "2026-01-27",
    progress: 42,
    nextMilestone: "Warehouse intake and distribution proof",
    nextMilestoneDeadline: "2026-03-24",
    location: "Dhanbad, Jharkhand",
    summary: "Track supply receipt, distribution events, and proof of delivery for mothers and children support camps.",
    beneficiariesReached: 420,
    fundsUtilized: 90000,
    milestones: [
      {
        id: "nutrition-drive-014-setup",
        title: "Setup",
        description: "Warehouse intake and supply stack verification.",
        order: 1,
        amount: 40000,
        deadline: "2026-02-04",
        status: "approved",
        paymentStatus: "confirmed",
        evidenceRequirements: ["photos", "receipts", "stock note"],
      },
      {
        id: "nutrition-drive-014-phase-1",
        title: "Phase 1",
        description: "First distribution batch with attendance and field delivery proof.",
        order: 2,
        amount: 50000,
        deadline: "2026-03-24",
        status: "pending",
        paymentStatus: "pending",
        evidenceRequirements: ["photos", "beneficiary list", "gps"],
      },
    ],
  },
  {
    id: "skills-lab-009",
    title: "Women Skills Lab Setup",
    companyName: "Meridian Tech Services",
    status: "completed",
    acceptanceDate: "2025-11-04",
    progress: 100,
    nextMilestone: "Final sponsor closeout submitted",
    nextMilestoneDeadline: "2026-01-15",
    location: "Jaipur, Rajasthan",
    summary: "Completed classroom setup, attendance records, and final sponsor documentation package.",
    beneficiariesReached: 160,
    fundsUtilized: 150000,
    milestones: [
      {
        id: "skills-lab-009-completion",
        title: "Completion",
        description: "Final sponsor closure package and impact report.",
        order: 1,
        amount: 25000,
        deadline: "2026-01-15",
        status: "approved",
        paymentStatus: "confirmed",
        evidenceRequirements: ["impact report", "attendance", "photos"],
      },
    ],
  },
];

interface SupabaseProject {
  id: string;
  title: string;
  description: string | null;
  region: string | null;
  project_status: string;
  acceptance_date: string | null;
  progress_percentage: number | null;
  funds_utilized: number | null;
  expected_beneficiaries: number | null;
  csr_project_milestones: {
    id: string;
    title: string;
    description: string | null;
    milestone_order: number;
    amount: number;
    evidence_requirements: string[] | null;
    status: string;
    due_date: string | null;
  }[];
}

function mapApiProject(p: SupabaseProject): MockProject {
  const milestones: MockMilestone[] = (p.csr_project_milestones ?? [])
    .sort((a, b) => a.milestone_order - b.milestone_order)
    .map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description ?? "",
      order: m.milestone_order,
      amount: m.amount ?? 0,
      deadline: m.due_date ?? "—",
      status: (["pending", "submitted", "approved", "rejected"].includes(m.status)
        ? m.status
        : "pending") as MockMilestone["status"],
      paymentStatus: "pending" as const,
      evidenceRequirements: Array.isArray(m.evidence_requirements) ? m.evidence_requirements : [],
    }));

  const nextPending = milestones.find((m) => m.status === "pending");

  return {
    id: p.id,
    title: p.title,
    companyName: p.region ?? "CSR Project",
    status: p.project_status === "completed" ? "completed" : "ongoing",
    acceptanceDate: p.acceptance_date ? p.acceptance_date.split("T")[0] : "—",
    progress: p.progress_percentage ?? 0,
    nextMilestone: nextPending?.title ?? "—",
    nextMilestoneDeadline: nextPending?.deadline ?? "—",
    location: p.region ?? "—",
    summary: p.description ?? "",
    beneficiariesReached: p.expected_beneficiaries ?? 0,
    fundsUtilized: p.funds_utilized ?? 0,
    milestones,
  };
}

export default function HomePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docVideoRef = useRef<HTMLVideoElement | null>(null);
  const docCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const currentDraftPhotosRef = useRef<CapturedPhoto[]>([]);
  const currentDraftDocumentsRef = useRef<ScannedDocument[]>([]);
  const autoSaveTimerRef = useRef<number | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const isHydratingDraftRef = useRef(false);
  const isSyncingDraftsRef = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [missingEnv, setMissingEnv] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ngoId, setNgoId] = useState<number | null>(null);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [ngoName, setNgoName] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [projects, setProjects] = useState<MockProject[]>(mockProjects);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(mockProjects[0]?.id ?? "");
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string>(mockProjects[0]?.milestones[0]?.id ?? "");
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>("photo");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [geoStatus, setGeoStatus] = useState<string | null>(null);
  const [capturedPhotos, setCapturedPhotos] = useState<CapturedPhoto[]>([]);
  const [scannedDocuments, setScannedDocuments] = useState<ScannedDocument[]>([]);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [autoSaveMessage, setAutoSaveMessage] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [cameraPermission, setCameraPermission] = useState<DevicePermissionState>("prompt");
  const [locationPermission, setLocationPermission] = useState<DevicePermissionState>("prompt");
  const [storagePermission, setStoragePermission] = useState<DevicePermissionState>("prompt");
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [syncStatusMessage, setSyncStatusMessage] = useState<string | null>(null);
  const [syncingDrafts, setSyncingDrafts] = useState(false);

  const pendingSyncCount =
    capturedPhotos.filter((photo) => photo.syncStatus !== "synced").length
    + scannedDocuments.filter((document) => document.syncStatus !== "synced").length;

  function getRetryDelayMs(retryCount: number) {
    const baseMs = 5000;
    const maxMs = 5 * 60 * 1000;
    return Math.min(maxMs, baseMs * 2 ** Math.max(0, retryCount - 1));
  }

  function shouldDeferRetry(nextRetryAt: string | null) {
    if (!nextRetryAt) {
      return false;
    }

    const nextRetryTs = Date.parse(nextRetryAt);
    return Number.isFinite(nextRetryTs) && nextRetryTs > Date.now();
  }

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const selectedMilestone = selectedProject?.milestones.find((milestone) => milestone.id === selectedMilestoneId)
    ?? selectedProject?.milestones[0];

  function getDraftId(projectId: string, currentNgoId: number) {
    return `ngo:${currentNgoId}:project:${projectId}`;
  }

  function formatCaptureStamp(position: GeolocationPosition | null, capturedAt: string) {
    const stampParts = [`Captured ${new Date(capturedAt).toLocaleString()}`];

    if (position) {
      stampParts.push(
        `Geo ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`,
      );
      stampParts.push(`Acc ${Math.round(position.coords.accuracy)}m`);
    } else {
      stampParts.push("Geo unavailable");
    }

    if (deviceId) {
      stampParts.push(`Device ${deviceId.slice(0, 8)}`);
    }

    return stampParts.join("  |  ");
  }

  function drawCaptureOverlay(
    context: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    stamp: string,
    label: string,
  ) {
    const bandHeight = Math.max(74, Math.round(canvas.height * 0.11));

    context.save();
    context.fillStyle = "rgba(15, 23, 42, 0.72)";
    context.fillRect(0, canvas.height - bandHeight, canvas.width, bandHeight);

    context.fillStyle = "#ffffff";
    context.textBaseline = "top";

    const titleFontSize = Math.max(22, Math.round(canvas.width * 0.019));
    const bodyFontSize = Math.max(18, Math.round(canvas.width * 0.014));
    const paddingX = Math.max(18, Math.round(canvas.width * 0.02));
    const paddingTop = Math.max(10, Math.round(bandHeight * 0.18));

    context.font = `700 ${titleFontSize}px var(--font-sans), sans-serif`;
    context.fillText(label, paddingX, canvas.height - bandHeight + paddingTop);

    context.font = `500 ${bodyFontSize}px var(--font-mono), monospace`;
    context.fillText(
      stamp,
      paddingX,
      canvas.height - bandHeight + paddingTop + titleFontSize + 8,
    );
    context.restore();
  }

  function revokePhotoUrls(photos: CapturedPhoto[]) {
    photos.forEach((photo) => URL.revokeObjectURL(photo.imageUrl));
  }

  function revokeDocumentUrls(documents: ScannedDocument[]) {
    documents.forEach((document) => URL.revokeObjectURL(document.previewUrl));
  }

  function mapDraftPhotos(photos: DraftPhotoEvidence[]) {
    return photos.map((photo) => ({
      id: photo.id,
      capturedAt: photo.capturedAt,
      latitude: photo.latitude,
      longitude: photo.longitude,
      accuracyMeters: photo.accuracyMeters,
      deviceId: photo.deviceId,
      blob: photo.blob,
      imageUrl: URL.createObjectURL(photo.blob),
      proofHash: photo.proofHash,
      lockedAt: photo.lockedAt,
      retryCount: typeof photo.retryCount === "number" ? photo.retryCount : 0,
      nextRetryAt: photo.nextRetryAt ?? null,
      syncStatus: photo.syncStatus,
      syncError: photo.syncError,
      cloudinary: photo.cloudinary,
    }));
  }

  function mapDraftDocuments(documents: DraftDocumentEvidence[]) {
    return documents.map((document) => ({
      id: document.id,
      name: document.name,
      scannedAt: document.scannedAt,
      sizeLabel: `${(document.size / 1024 / 1024).toFixed(2)} MB`,
      size: document.size,
      mimeType: document.mimeType,
      blob: document.blob,
      latitude: document.latitude,
      longitude: document.longitude,
      accuracyMeters: document.accuracyMeters,
      deviceId: document.deviceId,
      previewUrl: URL.createObjectURL(document.blob),
      proofHash: document.proofHash,
      lockedAt: document.lockedAt,
      retryCount: typeof document.retryCount === "number" ? document.retryCount : 0,
      nextRetryAt: document.nextRetryAt ?? null,
      syncStatus: document.syncStatus,
      syncError: document.syncError,
      cloudinary: document.cloudinary,
    }));
  }

  async function computeProofHash(blob: Blob) {
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function buildDraftRecord() {
    if (!selectedProject || !selectedMilestone || !ngoId || !ngoName || !sessionEmail) {
      return null;
    }

    const draft: ProjectDraft = {
      id: getDraftId(selectedProject.id, ngoId),
      ngoId,
      ngoName,
      sessionEmail,
      deviceId,
      projectId: selectedProject.id,
      projectTitle: selectedProject.title,
      milestoneId: selectedMilestone.id,
      milestoneTitle: selectedMilestone.title,
      milestoneOrder: selectedMilestone.order,
      milestoneStatus: selectedMilestone.status,
      milestoneAmount: selectedMilestone.amount,
      companyName: selectedProject.companyName,
      projectStatus: selectedProject.status,
      acceptanceDate: selectedProject.acceptanceDate,
      progress: selectedProject.progress,
      nextMilestone: selectedProject.nextMilestone,
      nextMilestoneDeadline: selectedProject.nextMilestoneDeadline,
      location: selectedProject.location,
      summary: selectedProject.summary,
      photos: capturedPhotos.map((photo) => ({
        id: photo.id,
        capturedAt: photo.capturedAt,
        latitude: photo.latitude,
        longitude: photo.longitude,
        accuracyMeters: photo.accuracyMeters,
        deviceId: photo.deviceId,
        mimeType: photo.blob.type || "image/jpeg",
        blob: photo.blob,
        proofHash: photo.proofHash,
        lockedAt: photo.lockedAt,
        retryCount: photo.retryCount,
        nextRetryAt: photo.nextRetryAt,
        syncStatus: photo.syncStatus,
        syncError: photo.syncError,
        cloudinary: photo.cloudinary,
      })),
      documents: scannedDocuments.map((document) => ({
        id: document.id,
        name: document.name,
        scannedAt: document.scannedAt,
        size: document.size,
        mimeType: document.mimeType,
        blob: document.blob,
        latitude: document.latitude,
        longitude: document.longitude,
        accuracyMeters: document.accuracyMeters,
        deviceId: document.deviceId,
        proofHash: document.proofHash,
        lockedAt: document.lockedAt,
        retryCount: document.retryCount,
        nextRetryAt: document.nextRetryAt,
        syncStatus: document.syncStatus,
        syncError: document.syncError,
        cloudinary: document.cloudinary,
      })),
      updatedAt: new Date().toISOString(),
    };

    return draft;
  }

  async function persistDraft(mode: "manual" | "auto") {
    const draft = buildDraftRecord();

    if (!draft) {
      return;
    }

    await db.projectDrafts.put(draft);
    setLastSavedAt(draft.updatedAt);
    setAutoSaveMessage(`Offline draft saved at ${new Date(draft.updatedAt).toLocaleTimeString()}.`);

    if (mode === "manual") {
      setSaveNotice(
        `Offline packet saved for ${selectedProject.title} · ${selectedMilestone.title} with ${capturedPhotos.length} photo${capturedPhotos.length === 1 ? "" : "s"} and ${scannedDocuments.length} document scan${scannedDocuments.length === 1 ? "" : "s"}.`,
      );
    }
  }

  useEffect(() => {
    setDeviceId(getDeviceId());
    setIsOnline(window.navigator.onLine);
  }, []);

  useEffect(() => {
    const handleNetworkState = () => setIsOnline(window.navigator.onLine);
    window.addEventListener("online", handleNetworkState);
    window.addEventListener("offline", handleNetworkState);

    return () => {
      window.removeEventListener("online", handleNetworkState);
      window.removeEventListener("offline", handleNetworkState);
    };
  }, []);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }

    setSelectedMilestoneId((current) => {
      const exists = selectedProject.milestones.some((milestone) => milestone.id === current);
      return exists ? current : (selectedProject.milestones[0]?.id ?? "");
    });
  }, [selectedProjectId, selectedProject]);

  useEffect(() => {
    let mounted = true;

    void fetch("/api/session", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    })
      .then(async (response) => {
        const data = (await response.json()) as SessionResponse;

        if (!mounted) {
          return;
        }

        setConfigured(Boolean(data.configured));
        setMissingEnv(Array.isArray(data.missingEnv) ? data.missingEnv : []);

        if (!data.session) {
          setNgoId(null);
          setSessionEmail(null);
          setNgoName(null);
          return;
        }

        setNgoId(data.session.ngoId);
        setSessionEmail(data.session.email);
        setNgoName(data.session.ngoName);
      })
      .catch(() => {
        if (!mounted) {
          return;
        }

        setConfigured(false);
        setMissingEnv(["SUPABASE_SERVICE_ROLE_KEY", "APP_SESSION_SECRET"]);
        setNgoId(null);
        setNgoName(null);
        setSessionEmail(null);
      })
      .finally(() => {
        if (mounted) {
          setSessionLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Load real projects from Supabase; falls back to mock data if none found
  useEffect(() => {
    if (!ngoId) return;

    void fetch("/api/projects", { method: "GET", credentials: "include" })
      .then(async (res) => {
        const data = (await res.json()) as {
          ok: boolean;
          projects: SupabaseProject[];
        };

        if (data.ok && Array.isArray(data.projects) && data.projects.length > 0) {
          const mapped = data.projects.map(mapApiProject);
          setProjects(mapped);
          setSelectedProjectId(mapped[0].id);
          setSelectedMilestoneId(mapped[0].milestones[0]?.id ?? "");
        }
      })
      .catch(() => {
        /* network error: keep mock data */
      });
  }, [ngoId]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      if (autoSaveTimerRef.current) {
        window.clearTimeout(autoSaveTimerRef.current);
      }

      if (syncTimerRef.current) {
        window.clearInterval(syncTimerRef.current);
      }

      revokePhotoUrls(currentDraftPhotosRef.current);
      revokeDocumentUrls(currentDraftDocumentsRef.current);
    };
  }, []);

  useEffect(() => {
    currentDraftPhotosRef.current = capturedPhotos;
  }, [capturedPhotos]);

  useEffect(() => {
    currentDraftDocumentsRef.current = scannedDocuments;
  }, [scannedDocuments]);

  useEffect(() => {
    if (!ngoId || !selectedProject) {
      return;
    }

    let cancelled = false;

    void (async () => {
      isHydratingDraftRef.current = true;
      setDraftLoading(true);
      setSaveNotice(null);
      setAutoSaveMessage(null);

      const draft = await db.projectDrafts.get(getDraftId(selectedProject.id, ngoId));

      if (cancelled) {
        return;
      }

      setCapturedPhotos((current) => {
        revokePhotoUrls(current);
        return draft ? mapDraftPhotos(draft.photos) : [];
      });
      setScannedDocuments((current) => {
        revokeDocumentUrls(current);
        return draft ? mapDraftDocuments(draft.documents) : [];
      });
      setLastSavedAt(draft?.updatedAt ?? null);
      if (draft?.milestoneId) {
        setSelectedMilestoneId(draft.milestoneId);
      }
      if (draft) {
        setSaveNotice(`Loaded offline draft saved on ${new Date(draft.updatedAt).toLocaleString()}.`);
      }
      setDraftLoading(false);
      isHydratingDraftRef.current = false;
    })().catch(() => {
      if (!cancelled) {
        setDraftLoading(false);
        isHydratingDraftRef.current = false;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [ngoId, selectedProjectId, selectedProject]);

  useEffect(() => {
    if (!ngoId || !ngoName || !sessionEmail || !deviceId || !selectedProject || !selectedMilestone) {
      return;
    }

    if (draftLoading || sessionLoading || isHydratingDraftRef.current) {
      return;
    }

    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      void persistDraft("auto").catch((caughtError) => {
        const messageText = caughtError instanceof Error ? caughtError.message : "Unable to auto-save offline draft.";
        setError(messageText);
      });
    }, 700);

    return () => {
      if (autoSaveTimerRef.current) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [
    ngoId,
    ngoName,
    sessionEmail,
    deviceId,
    selectedProjectId,
    selectedMilestoneId,
    capturedPhotos,
    scannedDocuments,
    draftLoading,
    sessionLoading,
    selectedProject,
    selectedMilestone,
  ]);

  useEffect(() => {
    if (!isOnline || !sessionEmail || !ngoId || !selectedProject || !selectedMilestone) {
      return;
    }

    void syncCurrentDraftMedia().catch((caughtError) => {
      const messageText = caughtError instanceof Error ? caughtError.message : "Unable to sync media to Cloudinary.";
      setSyncStatusMessage(messageText);
    });

    syncTimerRef.current = window.setInterval(() => {
      void syncCurrentDraftMedia().catch(() => {
        /* keep retry loop alive */
      });
    }, 20000);

    return () => {
      if (syncTimerRef.current) {
        window.clearInterval(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [isOnline, ngoId, selectedMilestoneId, selectedProjectId, selectedMilestone, selectedProject, sessionEmail]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        debug?: Record<string, unknown>;
        session?: SessionPayload;
      };

      if (!response.ok || !data.ok || !data.session) {
        setError(data.error ?? "Login failed.");
        return;
      }

      setNgoId(data.session.ngoId);
      setSessionEmail(data.session.email);
      setNgoName(data.session.ngoName);
      setMessage(null);
      setSaveNotice(null);
      setAutoSaveMessage(null);
    } catch (caughtError) {
      const fallbackError = caughtError instanceof Error ? caughtError.message : "Unexpected login error.";
      setError(fallbackError);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (pendingSyncCount > 0) {
        if (isOnline) {
          const summary = await syncCurrentDraftMedia(true);
          if (summary.remaining > 0) {
            const shouldLogout = window.confirm(
              `${summary.remaining} media item${summary.remaining === 1 ? " is" : "s are"} still unsynced. Logout anyway?`,
            );
            if (!shouldLogout) {
              return;
            }
          }
        } else {
          const shouldLogout = window.confirm(
            `You are offline and have ${pendingSyncCount} unsynced media item${pendingSyncCount === 1 ? "" : "s"}. Logout anyway?`,
          );
          if (!shouldLogout) {
            return;
          }
        }
      }

      const response = await fetch("/api/logout", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        setError("Logout failed.");
        return;
      }

      setNgoId(null);
      setSessionEmail(null);
      setNgoName(null);
      setMessage(null);
      setSaveNotice(null);
      setAutoSaveMessage(null);
      setLastSavedAt(null);
      setCapturedPhotos((current) => {
        revokePhotoUrls(current);
        return [];
      });
      setScannedDocuments((current) => {
        revokeDocumentUrls(current);
        return [];
      });
      stopCamera();
    } finally {
      setLoading(false);
    }
  }

  async function handleSyncNow() {
    if (!isOnline) {
      setSyncStatusMessage("Device is offline. Connect to internet to sync pending media.");
      return;
    }

    try {
      setSyncStatusMessage("Manual sync started...");
      await syncCurrentDraftMedia(true);
    } catch (caughtError) {
      const messageText = caughtError instanceof Error ? caughtError.message : "Unable to sync media to Cloudinary.";
      setSyncStatusMessage(messageText);
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    if (docVideoRef.current) {
      docVideoRef.current.srcObject = null;
    }

    setCameraReady(false);
    setCameraMode("photo");
  }

  async function requestStoragePermission() {
    if (!("storage" in navigator) || typeof navigator.storage.persist !== "function") {
      setStoragePermission("unsupported");
      return true;
    }

    const granted = await navigator.storage.persist();
    setStoragePermission(granted ? "granted" : "denied");
    return granted;
  }

  async function requestLocationPermission() {
    setLocationPermission("prompt");
    const position = await getCurrentPosition();
    if (position) {
      setLocationPermission("granted");
      return position;
    }

    setLocationPermission("denied");
    return null;
  }

  async function startCameraSession(mode: CameraMode) {
    stopCamera();
    setCameraMode(mode);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: mode === "document" ? 1920 : 1280 },
        height: { ideal: mode === "document" ? 1440 : 720 },
      },
    });

    streamRef.current = stream;

    const targetVideo = mode === "document" ? docVideoRef.current : videoRef.current;
    if (targetVideo) {
      targetVideo.srcObject = stream;
      await targetVideo.play();
    }

    setCameraPermission("granted");
    setCameraReady(true);
  }

  async function uploadMediaAsset(params: {
    fileName: string;
    mimeType: string;
    blob: Blob;
    kind: "photo" | "document";
    capturedAt: string;
    latitude: number | null;
    longitude: number | null;
    accuracyMeters: number | null;
    proofHash: string;
    lockedAt: string | null;
  }) {
    if (!selectedProject || !selectedMilestone) {
      throw new Error("Select a project and milestone before sync.");
    }

    const file = new File([params.blob], params.fileName, { type: params.mimeType || "image/jpeg" });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("kind", params.kind);
    formData.append("projectId", selectedProject.id);
    formData.append("milestoneId", selectedMilestone.id);
    formData.append("capturedAt", params.capturedAt);
    formData.append("deviceId", deviceId);
    if (params.latitude !== null) {
      formData.append("latitude", String(params.latitude));
    }
    if (params.longitude !== null) {
      formData.append("longitude", String(params.longitude));
    }
    if (params.accuracyMeters !== null) {
      formData.append("accuracyMeters", String(params.accuracyMeters));
    }
    formData.append("proofHash", params.proofHash);
    if (params.lockedAt) {
      formData.append("lockedAt", params.lockedAt);
    }

    const response = await fetch("/api/media/upload", {
      method: "POST",
      credentials: "include",
      body: formData,
    });

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      asset?: CloudinaryAssetReference;
    };

    if (!response.ok || !data.ok || !data.asset) {
      throw new Error(data.error ?? "Cloudinary sync failed.");
    }

    return data.asset;
  }

  async function syncCurrentDraftMedia(forceRetry = false) {
    if (!ngoId || !selectedProject || !selectedMilestone || !isOnline || isSyncingDraftsRef.current) {
      return { attempted: 0, synced: 0, failed: 0, deferred: 0, remaining: 0 } satisfies SyncSummary;
    }

    const draftId = getDraftId(selectedProject.id, ngoId);
    const draft = await db.projectDrafts.get(draftId);
    if (!draft) {
      return { attempted: 0, synced: 0, failed: 0, deferred: 0, remaining: 0 } satisfies SyncSummary;
    }

    isSyncingDraftsRef.current = true;
    setSyncingDrafts(true);

    try {
      let attempted = 0;
      let synced = 0;
      let failed = 0;
      let deferred = 0;

      const nextPhotos = [...draft.photos];
      const nextDocuments = [...draft.documents];

      for (let index = 0; index < nextPhotos.length; index += 1) {
        const photo = nextPhotos[index];
        if (photo.syncStatus === "synced") {
          continue;
        }

        if (!forceRetry && shouldDeferRetry(photo.nextRetryAt)) {
          deferred += 1;
          continue;
        }

        attempted += 1;
        nextPhotos[index] = { ...photo, syncStatus: "syncing", syncError: null };
        try {
          const asset = await uploadMediaAsset({
            fileName: `${photo.id}.jpg`,
            mimeType: photo.mimeType,
            blob: photo.blob,
            kind: "photo",
            capturedAt: photo.capturedAt,
            latitude: photo.latitude,
            longitude: photo.longitude,
            accuracyMeters: photo.accuracyMeters,
            proofHash: photo.proofHash,
            lockedAt: photo.lockedAt,
          });
          nextPhotos[index] = {
            ...photo,
            lockedAt: asset.uploadedAt,
            retryCount: 0,
            nextRetryAt: null,
            syncStatus: "synced",
            syncError: null,
            cloudinary: asset,
          };
          synced += 1;
        } catch (error) {
          const nextRetryCount = (photo.retryCount ?? 0) + 1;
          const retryDelayMs = getRetryDelayMs(nextRetryCount);
          nextPhotos[index] = {
            ...photo,
            retryCount: nextRetryCount,
            nextRetryAt: new Date(Date.now() + retryDelayMs).toISOString(),
            syncStatus: "failed",
            syncError: error instanceof Error ? error.message : "Photo sync failed.",
          };
          failed += 1;
        }
      }

      for (let index = 0; index < nextDocuments.length; index += 1) {
        const document = nextDocuments[index];
        if (document.syncStatus === "synced") {
          continue;
        }

        if (!forceRetry && shouldDeferRetry(document.nextRetryAt)) {
          deferred += 1;
          continue;
        }

        attempted += 1;
        nextDocuments[index] = { ...document, syncStatus: "syncing", syncError: null };
        try {
          const asset = await uploadMediaAsset({
            fileName: document.name,
            mimeType: document.mimeType,
            blob: document.blob,
            kind: "document",
            capturedAt: document.scannedAt,
            latitude: document.latitude,
            longitude: document.longitude,
            accuracyMeters: document.accuracyMeters,
            proofHash: document.proofHash,
            lockedAt: document.lockedAt,
          });
          nextDocuments[index] = {
            ...document,
            lockedAt: asset.uploadedAt,
            retryCount: 0,
            nextRetryAt: null,
            syncStatus: "synced",
            syncError: null,
            cloudinary: asset,
          };
          synced += 1;
        } catch (error) {
          const nextRetryCount = (document.retryCount ?? 0) + 1;
          const retryDelayMs = getRetryDelayMs(nextRetryCount);
          nextDocuments[index] = {
            ...document,
            retryCount: nextRetryCount,
            nextRetryAt: new Date(Date.now() + retryDelayMs).toISOString(),
            syncStatus: "failed",
            syncError: error instanceof Error ? error.message : "Document sync failed.",
          };
          failed += 1;
        }
      }

      const nextDraft: ProjectDraft = {
        ...draft,
        photos: nextPhotos,
        documents: nextDocuments,
        updatedAt: new Date().toISOString(),
      };

      const remaining =
        nextPhotos.filter((photo) => photo.syncStatus !== "synced").length
        + nextDocuments.filter((document) => document.syncStatus !== "synced").length;

      await db.projectDrafts.put(nextDraft);
      setCapturedPhotos((current) => {
        revokePhotoUrls(current);
        return mapDraftPhotos(nextDraft.photos);
      });
      setScannedDocuments((current) => {
        revokeDocumentUrls(current);
        return mapDraftDocuments(nextDraft.documents);
      });
      setLastSavedAt(nextDraft.updatedAt);
      setSyncStatusMessage(
        attempted === 0
          ? remaining === 0
            ? "All offline media is already synced to Cloudinary."
            : deferred > 0
              ? `Sync deferred for ${deferred} item${deferred === 1 ? "" : "s"}; retry window is active.`
              : "Sync queue is waiting for the next retry window."
          : `Cloudinary sync finished: ${synced} synced, ${failed} failed${deferred > 0 ? `, ${deferred} deferred` : ""}.`,
      );

      return { attempted, synced, failed, deferred, remaining } satisfies SyncSummary;
    } finally {
      isSyncingDraftsRef.current = false;
      setSyncingDrafts(false);
    }
  }

  async function handleStartCamera(mode: CameraMode = "photo") {
    setCameraLoading(true);
    setCameraError(null);
    setSaveNotice(null);
    setPermissionMessage(null);

    try {
      await requestStoragePermission();
      await startCameraSession(mode);
      const position = await requestLocationPermission();
      setPermissionMessage(
        position
          ? mode === "document"
            ? "Live document scan mode is ready with camera, location, and offline storage."
            : "Camera, location, and offline storage are ready for evidence capture."
          : mode === "document"
            ? "Live document scan mode is ready. Location permission was not granted, so scans may save without geotags."
            : "Camera is ready. Location permission was not granted, so captures may save without geotags.",
      );
    } catch (caughtError) {
      setCameraPermission("denied");
      const messageText = caughtError instanceof Error ? caughtError.message : "Unable to start camera.";
      setCameraError(`Camera access failed: ${messageText}`);
    } finally {
      setCameraLoading(false);
    }
  }

  function getCurrentPosition() {
    return new Promise<GeolocationPosition | null>((resolve) => {
      if (!("geolocation" in navigator)) {
        resolve(null);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => resolve(position),
        () => resolve(null),
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        },
      );
    });
  }

  async function handleCapturePhoto() {
    if (!videoRef.current || !canvasRef.current || !selectedProject) {
      setCameraError("Camera is not ready yet.");
      return;
    }

    setCameraError(null);
    setGeoStatus("Fetching geotag...");
    setSaveNotice(null);

    const position = await getCurrentPosition();
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    const context = canvas.getContext("2d");
    if (!context) {
      setCameraError("Unable to capture the camera frame.");
      setGeoStatus(null);
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const capturedAt = new Date().toISOString();
    const stamp = formatCaptureStamp(position, capturedAt);
    drawCaptureOverlay(context, canvas, stamp, "Live Photo Evidence");
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));

    if (!blob) {
      setCameraError("Unable to generate photo evidence.");
      setGeoStatus(null);
      return;
    }

    const proofHash = await computeProofHash(blob);

    const photoRecord: CapturedPhoto = {
      id: `${selectedProject.id}-${capturedAt}`,
      capturedAt,
      latitude: position?.coords.latitude ?? null,
      longitude: position?.coords.longitude ?? null,
      accuracyMeters: position?.coords.accuracy ?? null,
      deviceId,
      blob,
      imageUrl: URL.createObjectURL(blob),
      proofHash,
      lockedAt: null,
      retryCount: 0,
      nextRetryAt: null,
      syncStatus: "local",
      syncError: null,
      cloudinary: null,
    };

    setCapturedPhotos((current) => [photoRecord, ...current]);
    setGeoStatus(
      position
        ? `Geotag recorded at ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)} with ${Math.round(position.coords.accuracy)}m accuracy.`
        : "Location unavailable. Photo saved without coordinates.",
    );
  }

  async function handleCaptureDocumentScan() {
    if (!docVideoRef.current || !docCanvasRef.current || !selectedProject) {
      setCameraError("Start the document camera before scanning.");
      return;
    }

    setGeoStatus("Capturing document scan with geotag...");
    const position = await getCurrentPosition();
    if (position) {
      setLocationPermission("granted");
    }

    const video = docVideoRef.current;
    const canvas = docCanvasRef.current;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    const context = canvas.getContext("2d");
    if (!context) {
      setCameraError("Unable to capture the document frame.");
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const scannedAt = new Date().toISOString();
    const stamp = formatCaptureStamp(position, scannedAt);
    drawCaptureOverlay(context, canvas, stamp, "Live Document Scan");
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    if (!blob) {
      setCameraError("Unable to create a document scan image.");
      return;
    }

    const proofHash = await computeProofHash(blob);

    const document: ScannedDocument = {
      id: `${selectedProject.id}-doc-${scannedAt}`,
      name: `document-scan-${scannedAt.replace(/[:.]/g, "-")}.jpg`,
      scannedAt,
      sizeLabel: `${(blob.size / 1024 / 1024).toFixed(2)} MB`,
      size: blob.size,
      mimeType: blob.type || "image/jpeg",
      blob,
      latitude: position?.coords.latitude ?? null,
      longitude: position?.coords.longitude ?? null,
      accuracyMeters: position?.coords.accuracy ?? null,
      deviceId,
      previewUrl: URL.createObjectURL(blob),
      proofHash,
      lockedAt: null,
      retryCount: 0,
      nextRetryAt: null,
      syncStatus: "local",
      syncError: null,
      cloudinary: null,
    };

    setScannedDocuments((current) => [document, ...current]);
    setSaveNotice(
      position
        ? "Document scan saved offline with geotag and queued for Cloudinary sync."
        : "Document scan saved offline. Location was unavailable for this capture.",
    );
  }

  function handleSaveMockPacket() {
    void persistDraft("manual").catch((caughtError) => {
      const messageText = caughtError instanceof Error ? caughtError.message : "Unable to save offline draft.";
      setError(messageText);
    });
  }

  // Verified NGO — show field dashboard
  if (sessionEmail && ngoName) {
    return (
      <main className="app">
        {/* ── Header ── */}
        <header className="app-header">
          <div className="header-left">
            <img className="header-logo" src="/logo.svg" alt="Navadrishti logo" />
            <div>
              <p className="header-org">{ngoName}</p>
              <p className="header-meta">
                {sessionEmail}
                {deviceId ? ` · ${deviceId.slice(0, 8)}` : ""}
              </p>
            </div>
          </div>
          <div className="header-right">
            {autoSaveMessage ? <span className="save-chip">✓ Saved</span> : null}
            <button
              type="button"
              className="btn-outline"
              onClick={handleLogout}
              disabled={loading}
            >
              {loading ? "..." : "Logout"}
            </button>
          </div>
        </header>

        {error ? <div className="form-error banner-msg">{error}</div> : null}

        {/* ── Context Panel: project + milestone selectors + facts ── */}
        <section className="context-panel">
          <div className="selectors-row">
            <label className="sel-block">
              <span>Project</span>
              <select
                value={selectedProjectId}
                onChange={(event) => {
                  setSelectedProjectId(event.target.value);
                  setSaveNotice(null);
                }}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="sel-block">
              <span>Milestone</span>
              <select
                value={selectedMilestoneId}
                onChange={(event) => setSelectedMilestoneId(event.target.value)}
              >
                {selectedProject?.milestones.map((milestone) => (
                  <option key={milestone.id} value={milestone.id}>
                    M{milestone.order} · {milestone.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {selectedProject && selectedMilestone ? (
            <div className="context-facts">
              <div className="fact-chip">
                <span>Company</span>
                <strong>{selectedProject.companyName}</strong>
              </div>
              <div className="fact-chip">
                <span>Location</span>
                <strong>{selectedProject.location}</strong>
              </div>
              <div className="fact-chip">
                <span>Progress</span>
                <strong>{selectedProject.progress}%</strong>
              </div>
              <div className="fact-chip">
                <span>Deadline</span>
                <strong>{selectedMilestone.deadline}</strong>
              </div>
              <div className="fact-chip">
                <span>Amount</span>
                <strong>₹{selectedMilestone.amount.toLocaleString("en-IN")}</strong>
              </div>
              <div className="fact-chip">
                <span>Status</span>
                <strong className={`ms-badge ms-${selectedMilestone.status}`}>
                  {selectedMilestone.status}
                </strong>
              </div>
            </div>
          ) : null}

          {selectedMilestone?.evidenceRequirements.length ? (
            <div className="req-row">
              <span className="req-label">Required:</span>
              {selectedMilestone.evidenceRequirements.map((req) => (
                <span key={req} className="req-chip">{req}</span>
              ))}
            </div>
          ) : null}

          {draftLoading ? (
            <p className="status-note">Loading offline draft…</p>
          ) : lastSavedAt ? (
            <p className="status-note">Draft saved {new Date(lastSavedAt).toLocaleTimeString()}</p>
          ) : null}

          {permissionMessage ? <p className="status-note">{permissionMessage}</p> : null}

          {syncStatusMessage ? <p className="status-note">{syncStatusMessage}</p> : null}

          {saveNotice ? <div className="form-message banner-inline">{saveNotice}</div> : null}
        </section>

        {/* ── Evidence Capture ── */}
        {selectedProject ? (
          <div className="evidence-layout">
            {/* Camera */}
            <section className="ev-card camera-section">
              <div className="ev-head">
                <h2>Photo Evidence</h2>
                <button
                  type="button"
                  className="btn-sm"
                  onClick={() => void handleStartCamera("photo")}
                  disabled={cameraLoading}
                >
                  {cameraLoading ? "Opening…" : cameraReady && cameraMode === "photo" ? "Restart" : "Start Photo Camera"}
                </button>
              </div>
              <div className="camera-frame">
                <video ref={videoRef} playsInline muted className="camera-video" />
                {!(cameraReady && cameraMode === "photo") ? (
                  <div className="cam-placeholder">Tap "Start Photo Camera" to capture live geo-tagged evidence.</div>
                ) : null}
              </div>
              <canvas ref={canvasRef} hidden />
              {cameraError ? <div className="form-error">{cameraError}</div> : null}
              {geoStatus ? <div className="geo-note">{geoStatus}</div> : null}
              <button
                type="button"
                className="btn-capture"
                onClick={handleCapturePhoto}
                disabled={!cameraReady}
              >
                Capture Photo
              </button>
              {capturedPhotos.length > 0 ? (
                <div className="photo-strip">
                  {capturedPhotos.map((photo) => (
                    <div key={photo.id} className="photo-thumb">
                      <img src={photo.imageUrl} alt="Field evidence" />
                      <p>
                        {new Date(photo.capturedAt).toLocaleTimeString()}
                        {photo.latitude !== null
                          ? ` · ${photo.latitude.toFixed(4)},${photo.longitude?.toFixed(4)}`
                          : ""}
                      </p>
                      {photo.proofHash && (
                        <p>{photo.lockedAt ? `Locked · ${photo.proofHash.slice(0, 12)}` : `Hash · ${photo.proofHash.slice(0, 12)}`}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-note">No photos captured yet.</p>
              )}
            </section>

            {/* Documents */}
            <section className="ev-card docs-section">
              <div className="ev-head">
                <h2>Documents</h2>
                {scannedDocuments.length > 0 ? (
                  <span className="count-badge">{scannedDocuments.length}</span>
                ) : null}
              </div>
              <p className="empty-note">Camera-only live scan — no gallery or file upload. Geotagged and timestamped.</p>
              <div className="ev-head">
                <button
                  type="button"
                  className="btn-sm"
                  onClick={() => void handleStartCamera("document")}
                  disabled={cameraLoading}
                >
                  {cameraLoading && cameraMode === "document" ? "Opening…" : cameraReady && cameraMode === "document" ? "Restart Doc Camera" : "Start Doc Camera"}
                </button>
              </div>
              <div className="camera-frame camera-frame-document">
                <video ref={docVideoRef} playsInline muted className="camera-video" />
                {!(cameraReady && cameraMode === "document") ? (
                  <div className="cam-placeholder">Tap "Start Doc Camera" — align page in frame, then capture.</div>
                ) : (
                  <div className="cam-guide" aria-hidden="true">
                    <div className="cam-guide-box" />
                    <span className="cam-guide-text">Align the full page inside the frame.</span>
                  </div>
                )}
              </div>
              <canvas ref={docCanvasRef} hidden />
              {cameraError && cameraMode === "document" ? <div className="form-error">{cameraError}</div> : null}
              {geoStatus && cameraMode === "document" ? <div className="geo-note">{geoStatus}</div> : null}
              <button
                type="button"
                className="btn-capture"
                onClick={() => void handleCaptureDocumentScan()}
                disabled={!(cameraReady && cameraMode === "document")}
              >
                Capture Document Scan
              </button>
              <div className="doc-list">
                {scannedDocuments.length ? (
                  scannedDocuments.map((document) => (
                    <div key={document.id} className="doc-item">
                      <div className="doc-info">
                        <strong>{document.name}</strong>
                        <span>
                          {document.sizeLabel}
                          {document.lockedAt ? " · locked" : document.cloudinary ? " · synced" : document.syncStatus === "failed" ? " · retry pending" : " · offline"}
                        </span>
                        {document.proofHash && (
                          <span>SHA-256 {document.proofHash.slice(0, 16)}</span>
                        )}
                      </div>
                      <span className="doc-time">
                        {new Date(document.scannedAt).toLocaleTimeString()}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="empty-note">No document scans captured yet.</p>
                )}
              </div>
            </section>
          </div>
        ) : null}

        {/* ── Action Bar ── */}
        <div className="action-bar">
          <div className="action-info">
            <span className="ev-count">{capturedPhotos.length} photo{capturedPhotos.length !== 1 ? "s" : ""}</span>
            <span className="ev-count">{scannedDocuments.length} doc{scannedDocuments.length !== 1 ? "s" : ""}</span>
            <span className="ev-count">{pendingSyncCount} pending</span>
            <span className="ev-count">{isOnline ? (syncingDrafts ? "syncing" : "online") : "offline"}</span>
          </div>
          <div className="action-buttons">
            <button
              type="button"
              className="btn-sync"
              onClick={() => void handleSyncNow()}
              disabled={!isOnline || syncingDrafts || pendingSyncCount === 0}
            >
              {syncingDrafts ? "Syncing..." : "Sync Now"}
            </button>
            <button type="button" className="btn-save" onClick={handleSaveMockPacket}>
              Save Draft
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-brand">
          <img className="login-brand-logo" src="/logo.svg" alt="Navadrishti logo" />
          <h1>Navadrishti</h1>
        </div>
        {sessionLoading ? <p className="login-status">Checking session...</p> : null}
        {!configured ? (
          <div className="form-error" style={{ marginBottom: 12 }}>
            Server login is not configured yet. Create a <span className="mono">.env.local</span> using values from
            <span className="mono"> .env.example</span>.
            {missingEnv.length ? ` Missing: ${missingEnv.join(", ")}.` : ""}
          </div>
        ) : null}
        <form className="login-form" onSubmit={handleLogin}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            placeholder="********"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={6}
            required
          />

          {error ? <div className="form-error">{error}</div> : null}
          {message ? <div className="form-message">{message}</div> : null}

          <button type="submit" disabled={loading || sessionLoading || !configured}>{loading ? "Please wait..." : "Login"}</button>
          {sessionEmail ? (
            <button type="button" className="button-secondary" onClick={handleLogout} disabled={loading}>
              Logout
            </button>
          ) : null}
        </form>
      </section>
    </main>
  );
}
