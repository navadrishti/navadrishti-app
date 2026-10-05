// Kept in step with the platform's milestone evidence route (app/api/milestones/[id]/evidence).
export const LOCKED_MILESTONE_STATUSES = ["approved", "completed"] as const;

export const EVIDENCE_LIMITS = {
  maxFiles: 10,
  maxFileBytes: 25 * 1024 * 1024,
} as const;

type FileLike = { type?: string | null; size: number };

export function isLockedMilestoneStatus(status: unknown): boolean {
  return (LOCKED_MILESTONE_STATUSES as readonly string[]).includes(String(status || "").trim().toLowerCase());
}

export function evidenceMediaType(mimeType: string | null | undefined): "image" | "video" | "document" | null {
  const type = String(mimeType || "").toLowerCase();
  if (type === "image/svg+xml") return null;
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "document";
  return null;
}

export function validateEvidenceFiles(files: FileLike[]): string | null {
  if (files.length > EVIDENCE_LIMITS.maxFiles) {
    return `Attach at most ${EVIDENCE_LIMITS.maxFiles} files per submission.`;
  }
  for (const file of files) {
    if (!evidenceMediaType(file.type)) return "Only photos, videos and PDF files can be attached.";
    if (file.size > EVIDENCE_LIMITS.maxFileBytes) return "Each file must be 25 MB or smaller.";
  }
  return null;
}

/** Stable per-capture key so offline retries never create a second evidence row. */
export function evidenceImmutableHash(eventId: string): string {
  return `field_event:${eventId}`;
}

/**
 * Sync outcomes the field app should stop retrying: the server understood the request and refused it.
 * 401 is handled separately (sign in again); 409 means it was already recorded.
 */
export function isTerminalSyncStatus(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 413 || status === 422;
}
