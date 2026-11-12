// Kept in step with the platform's milestone evidence route (app/api/milestones/[id]/evidence).
export const LOCKED_MILESTONE_STATUSES = ["approved", "completed"] as const;
/** Payment confirmed / milestone closed — only this unlocks the next field milestone. */
export const PAID_COMPLETED_MILESTONE_STATUSES = ["completed"] as const;
export const HISTORY_PROJECT_STATUSES = ["completed", "closed", "finished", "done", "cancelled", "canceled"] as const;

export const EVIDENCE_LIMITS = {
  maxFiles: 10,
  maxFileBytes: 25 * 1024 * 1024,
} as const;

type FileLike = { type?: string | null; size: number };

export type OrderedMilestoneLike = {
  id: string;
  status?: string | null;
  milestoneOrder?: number | null;
  milestone_order?: number | null;
};

export function isLockedMilestoneStatus(status: unknown): boolean {
  return (LOCKED_MILESTONE_STATUSES as readonly string[]).includes(String(status || "").trim().toLowerCase());
}

/** True only after confirmed payment closes the milestone (not CA approval alone). */
export function isPaidCompletedMilestoneStatus(status: unknown): boolean {
  return (PAID_COMPLETED_MILESTONE_STATUSES as readonly string[]).includes(
    String(status || "").trim().toLowerCase()
  );
}

function milestoneOrderValue(milestone: OrderedMilestoneLike): number {
  const raw = milestone.milestoneOrder ?? milestone.milestone_order ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function sortMilestonesByOrder<T extends OrderedMilestoneLike>(milestones: T[]): T[] {
  return milestones.slice().sort((a, b) => milestoneOrderValue(a) - milestoneOrderValue(b));
}

/**
 * Field progress / capture target: first milestone that is not payment-complete.
 * Approved (awaiting payment) stays current so the next milestone is not unlocked early.
 */
export function resolveCurrentFieldMilestone<T extends OrderedMilestoneLike>(milestones: T[]): T | null {
  const ordered = sortMilestonesByOrder(milestones);
  if (ordered.length === 0) return null;
  return ordered.find((m) => !isPaidCompletedMilestoneStatus(m.status)) ?? ordered[ordered.length - 1];
}

/** Earlier milestones in order must all be payment-complete before this one accepts evidence. */
export function priorMilestonesArePaidComplete(
  milestones: OrderedMilestoneLike[],
  milestoneId: string
): boolean {
  const ordered = sortMilestonesByOrder(milestones);
  const index = ordered.findIndex((m) => m.id === milestoneId);
  if (index < 0) return false;
  if (index === 0) return true;
  return ordered.slice(0, index).every((m) => isPaidCompletedMilestoneStatus(m.status));
}

export function fieldMilestoneStepLabel(status: unknown): string {
  const s = String(status || "").trim().toLowerCase();
  if (s === "completed") return "Done";
  if (s === "approved") return "Awaiting payment";
  if (s === "submitted") return "Submitted";
  if (s === "rejected") return "Needs redo";
  return "Open";
}

export function isHistoryProjectStatus(status: unknown): boolean {
  return (HISTORY_PROJECT_STATUSES as readonly string[]).includes(String(status || "").trim().toLowerCase());
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
 * 401 is handled separately (sign in again).
 * 409 is retryable (chain tip moved / conflict) — same event_id replays return 200, not 409.
 */
export function isTerminalSyncStatus(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 413 || status === 422;
}
