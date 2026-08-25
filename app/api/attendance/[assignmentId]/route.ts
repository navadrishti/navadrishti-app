import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest, markAttendance } from "@/lib/attendance";
import { hasServerEnv } from "@/lib/env";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ assignmentId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  if (!hasServerEnv()) {
    return NextResponse.json({ ok: false, error: "Server is not configured." }, { status: 500 });
  }

  const session = getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!["ngo", "individual"].includes(session.role)) {
    return NextResponse.json(
      { ok: false, error: "Attendance is not available for this account." },
      { status: 403 }
    );
  }

  const { assignmentId } = await context.params;
  if (!assignmentId) {
    return NextResponse.json({ ok: false, error: "Assignment ID is required" }, { status: 400 });
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { ok: false, error: "Attendance must be submitted with sealed photos (multipart)." },
        { status: 400 }
      );
    }

    const form = await request.formData();
    const attendanceStatus =
      typeof form.get("attendanceStatus") === "string"
        ? String(form.get("attendanceStatus"))
        : "present";
    const locationLatitude =
      form.get("locationLatitude") != null ? Number(form.get("locationLatitude")) : null;
    const locationLongitude =
      form.get("locationLongitude") != null ? Number(form.get("locationLongitude")) : null;
    const locationAccuracy =
      form.get("locationAccuracy") != null ? Number(form.get("locationAccuracy")) : null;
    const units = form.get("units") != null ? Number(form.get("units")) : null;

    let proofMeta: Array<{ proofHash?: string; capturedAt?: string }> = [];
    const proofRaw = form.get("photoProofs");
    if (typeof proofRaw === "string" && proofRaw.trim()) {
      try {
        const parsed = JSON.parse(proofRaw);
        if (Array.isArray(parsed)) proofMeta = parsed;
      } catch {
        return NextResponse.json({ ok: false, error: "Invalid photoProofs payload" }, { status: 400 });
      }
    }

    const files = form.getAll("photos").filter((entry): entry is File => entry instanceof File);
    if (files.length < 1 || files.length > 3) {
      return NextResponse.json(
        { ok: false, error: "Attendance requires 1 to 3 sealed photos." },
        { status: 400 }
      );
    }

    const photos = await Promise.all(
      files.map(async (file, index) => {
        const buffer = Buffer.from(await file.arrayBuffer());
        const meta = proofMeta[index] || {};
        return {
          buffer,
          fileName: file.name || `attendance-${index + 1}.jpg`,
          mimeType: file.type || "image/jpeg",
          proofHash: String(meta.proofHash || "").toLowerCase(),
          capturedAt: String(meta.capturedAt || new Date().toISOString()),
        };
      })
    );

    if (photos.some((photo) => !photo.proofHash)) {
      return NextResponse.json(
        { ok: false, error: "Each photo requires a proof hash." },
        { status: 400 }
      );
    }

    const result = await markAttendance({
      session,
      assignmentId,
      attendanceStatus,
      locationLatitude: Number.isFinite(locationLatitude as number) ? locationLatitude : null,
      locationLongitude: Number.isFinite(locationLongitude as number) ? locationLongitude : null,
      locationAccuracy: Number.isFinite(locationAccuracy as number) ? locationAccuracy : null,
      units: Number.isFinite(units as number) ? units : null,
      photos,
    });

    return NextResponse.json({ ok: true, data: result }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mark attendance";
    const status =
      message.includes("already been marked") || message.includes("cannot be edited")
        ? 409
        : message.includes("Location is required") ||
            message.includes("opens when") ||
            message.includes("1 to 3") ||
            message.includes("integrity")
          ? 400
          : message.includes("Only the")
            ? 403
            : 500;

    console.error("[api/attendance/mark]", error);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
