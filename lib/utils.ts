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
