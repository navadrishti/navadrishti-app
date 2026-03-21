const DEVICE_KEY = "navadrishti.device-id";

export function getDeviceId() {
  if (typeof window === "undefined") {
    return "server-render";
  }

  const existing = window.localStorage.getItem(DEVICE_KEY);
  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();
  window.localStorage.setItem(DEVICE_KEY, created);
  return created;
}
