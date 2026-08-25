import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest, listAttendanceAssignments } from "@/lib/attendance";
import { hasServerEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
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

  try {
    const userId = Number(session.ngoId || session.id);
    const data = await listAttendanceAssignments(userId);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("[api/attendance/assignments]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to load attendance" },
      { status: 500 }
    );
  }
}
