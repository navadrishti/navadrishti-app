import { NextRequest, NextResponse } from "next/server";
import { hasCloudinaryEnv, listFolderAssets, sanitizeCloudinarySegment } from "@/lib/cloudinary";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";

export const runtime = "nodejs";

type CloudinaryListAsset = {
  asset_id: string;
  public_id: string;
  secure_url: string;
  bytes: number;
  format?: string;
  created_at: string;
};

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  if (!hasCloudinaryEnv()) {
    return NextResponse.json({ ok: true, assets: [] });
  }

  const projectId = sanitizeCloudinarySegment(request.nextUrl.searchParams.get("projectId") || "");
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId is required." }, { status: 400 });
  }

  const milestoneId = sanitizeCloudinarySegment(request.nextUrl.searchParams.get("milestoneId") || "unassigned");
  const kind = request.nextUrl.searchParams.get("kind") === "document" ? "documents" : "photos";
  const prefix = [
    process.env.CLOUDINARY_UPLOAD_FOLDER || "navadrishti",
    `ngo-${session.ngoId}`,
    `project-${projectId}`,
    `milestone-${milestoneId}`,
    kind,
  ].join("/");

  try {
    const result = await listFolderAssets(prefix);
    return NextResponse.json({
      ok: true,
      assets: (result.resources as CloudinaryListAsset[]).map((asset) => ({
        assetId: asset.asset_id,
        publicId: asset.public_id,
        secureUrl: asset.secure_url,
        bytes: asset.bytes,
        format: asset.format ?? null,
        createdAt: asset.created_at,
      })),
    });
  } catch (error) {
    console.error("[api/media/list]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to list media." },
      { status: 500 },
    );
  }
}