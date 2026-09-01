import { randomUUID } from "@/lib/crypto";

/**
 * Get the current GPS position as a promise.
 */
export async function getCurrentPosition() {
  if (typeof window === "undefined" || !("geolocation" in navigator)) {
    return null;
  }

  return new Promise<{
    latitude: number;
    longitude: number;
    accuracy: number | null;
  } | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy:
            typeof position.coords.accuracy === "number" ? position.coords.accuracy : null,
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
}

/** Local YYYY-MM-DD for attendance "already marked today" checks. */
export function getLocalDateStringClient(reference: Date = new Date()) {
  const year = reference.getFullYear();
  const month = String(reference.getMonth() + 1).padStart(2, "0");
  const day = String(reference.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Format bytes into a human-readable string.
 */
export function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const DEVICE_KEY = "navadrishti.device-id";

/** Stable per-device ID for NGO hardware binding. */
export function getDeviceId() {
  if (typeof window === "undefined") {
    return "server-render";
  }

  const existing = window.localStorage.getItem(DEVICE_KEY);
  if (existing) {
    return existing;
  }

  const created = randomUUID();
  window.localStorage.setItem(DEVICE_KEY, created);
  return created;
}

function safeProfileJson(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function urlFromProfileValue(value: unknown): string | null {
  const direct = asNonEmptyString(value);
  if (direct && (direct.startsWith("http://") || direct.startsWith("https://") || direct.startsWith("/"))) {
    return direct;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return (
      asNonEmptyString(record.secure_url) ??
      asNonEmptyString(record.url) ??
      asNonEmptyString(record.public_url) ??
      null
    );
  }

  return null;
}

const PROFILE_PICTURE_KEYS = [
  "profile_picture",
  "profilePicture",
  "profile_photo",
  "profilePhoto",
  "avatar_url",
  "avatarUrl",
  "photo_url",
  "photoUrl",
  "picture_url",
  "pictureUrl",
  "image_url",
  "imageUrl",
  "pfp",
  "picture",
  "avatar",
  "photo",
] as const;

function findProfilePictureUrl(record: Record<string, unknown>): string | null {
  for (const key of PROFILE_PICTURE_KEYS) {
    const match = urlFromProfileValue(record[key]);
    if (match) return match;
  }

  const nestedContainers = ["profile", "media", "photos", "images", "user"];
  for (const containerKey of nestedContainers) {
    const nested = safeProfileJson(record[containerKey]);
    if (Object.keys(nested).length === 0) continue;
    const nestedMatch = findProfilePictureUrl(nested);
    if (nestedMatch) return nestedMatch;
  }

  return null;
}

/** Read avatar URL from users.profile_image and/or users.profile_data JSON. */
export function resolveUserAvatarUrl(input: {
  profileImage?: unknown;
  profileData?: unknown;
}): string | null {
  const directImage = urlFromProfileValue(input.profileImage);
  if (directImage) return directImage;

  const fromProfileData = extractProfilePictureUrl(input.profileData);
  if (fromProfileData) return fromProfileData;

  const profile = safeProfileJson(input.profileData);
  return urlFromProfileValue(profile.profile_image) ?? urlFromProfileValue(profile.logo_url);
}

/** Read a Cloudinary (or other) profile picture URL from users.profile_data JSON. */
export function extractProfilePictureUrl(profileData: unknown): string | null {
  return findProfilePictureUrl(safeProfileJson(profileData));
}

/** Face-cropped Cloudinary avatar delivery, matching main platform styling. */
export function cloudinaryAvatarUrl(url: string, size = 96): string {
  if (!url.includes("res.cloudinary.com") || !url.includes("/upload/")) {
    return url;
  }

  if (/\/upload\/[^/]*w_\d+/.test(url)) {
    return url;
  }

  const transform = `w_${size},h_${size},c_fill,g_face,f_auto,q_auto`;
  return url.replace("/upload/", `/upload/${transform}/`);
}

export function getInitials(name: string | null | undefined): string {
  const parts = String(name || "User")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}
