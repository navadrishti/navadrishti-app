import { NextRequest, NextResponse } from "next/server";
import { uploadBufferToCloudinary, hasCloudinaryEnv, sanitizeCloudinarySegment } from "@/lib/cloudinary";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function stringValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  if (!hasCloudinaryEnv()) {
    return NextResponse.json(
      { ok: false, error: "Cloudinary is not configured on the server." },
      { status: 500 },
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "A media file is required." }, { status: 400 });
  }

  const kindValue = stringValue(formData.get("kind"));
  if (kindValue !== "photo" && kindValue !== "document") {
    return NextResponse.json({ ok: false, error: "Invalid media kind." }, { status: 400 });
  }

  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return NextResponse.json({ ok: false, error: "Only JPEG, PNG, and WebP uploads are allowed." }, { status: 400 });
  }

  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return NextResponse.json({ ok: false, error: "File is too large. Maximum upload size is 8 MB." }, { status: 413 });
  }

  const clientIp = getClientIp(request);
  const rateLimit = checkRateLimit({
    key: `upload:${session.ngoId}:${clientIp}`,
    limit: 120,
    windowMs: 10 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Upload rate limit reached. Please retry in a minute." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      },
    );
  }

  const kind = kindValue === "document" ? "documents" : "photos";
  const projectId = sanitizeCloudinarySegment(stringValue(formData.get("projectId")));
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId is required." }, { status: 400 });
  }
  const milestoneId = sanitizeCloudinarySegment(stringValue(formData.get("milestoneId")) || "unassigned");
  const capturedAt = stringValue(formData.get("capturedAt"));
  const latitude = stringValue(formData.get("latitude"));
  const longitude = stringValue(formData.get("longitude"));
  const accuracyMeters = stringValue(formData.get("accuracyMeters"));
  const deviceId = sanitizeCloudinarySegment(stringValue(formData.get("deviceId")) || "unknown-device");
  const proofHash = stringValue(formData.get("proofHash"));
  const lockedAt = stringValue(formData.get("lockedAt"));

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const upload = await uploadBufferToCloudinary(buffer, {
      folder: [
        process.env.CLOUDINARY_UPLOAD_FOLDER || "navadrishti",
        `ngo-${session.ngoId}`,
        `project-${projectId}`,
        `milestone-${milestoneId}`,
        kind,
      ].join("/"),
      resource_type: "image",
      use_filename: false,
      unique_filename: true,
      overwrite: false,
      tags: [
        "navadrishti",
        `ngo-${session.ngoId}`,
        `project-${projectId}`,
        `milestone-${milestoneId}`,
        kind,
      ],
      context: {
        ngoId: String(session.ngoId),
        ngoName: session.ngoName,
        projectId,
        milestoneId,
        kind,
        deviceId,
        capturedAt,
        latitude,
        longitude,
        accuracyMeters,
        proofHash,
        lockedAt,
      },
    });

    return NextResponse.json({
      ok: true,
      asset: {
        assetId: upload.asset_id,
        publicId: upload.public_id,
        secureUrl: upload.secure_url,
        resourceType: upload.resource_type,
        format: upload.format ?? null,
        bytes: upload.bytes,
        version: upload.version ? String(upload.version) : null,
        uploadedAt: upload.created_at,
        proofHash: proofHash || null,
      },
    });
  } catch (error) {
    console.error("[api/media/upload]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 },
    );
  }
}