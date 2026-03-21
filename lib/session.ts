import crypto from "node:crypto";

export interface AppSession {
  ngoId: number;
  ngoName: string;
  email: string;
  issuedAt: number;
  expiresAt: number;
}

export const SESSION_COOKIE_NAME = "navadrishti_session";

function getSessionSecret() {
  const secret = process.env.APP_SESSION_SECRET;

  if (!secret) {
    throw new Error("APP_SESSION_SECRET is not configured.");
  }

  return secret;
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(payload: string) {
  return crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
}

export function createSessionToken(session: AppSession) {
  const payload = encode(JSON.stringify(session));
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string | undefined) {
  if (!token) {
    return null;
  }

  const [payload, signature] = token.split(".");

  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = sign(payload);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);

  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(decode(payload)) as AppSession;

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (typeof parsed.expiresAt !== "number" || Date.now() > parsed.expiresAt) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function getSessionCookieMaxAgeSeconds() {
  return 60 * 60 * 24 * 7;
}