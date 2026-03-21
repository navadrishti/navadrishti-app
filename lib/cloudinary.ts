import { v2 as cloudinary, type UploadApiOptions, type UploadApiResponse } from "cloudinary";

const REQUIRED_CLOUDINARY_ENV = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
] as const;

let configured = false;

function ensureCloudinaryConfigured() {
  if (configured) {
    return;
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });

  configured = true;
}

export function getMissingCloudinaryEnv() {
  return REQUIRED_CLOUDINARY_ENV.filter((key) => !process.env[key]);
}

export function hasCloudinaryEnv() {
  return getMissingCloudinaryEnv().length === 0;
}

export function sanitizeCloudinarySegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

export async function uploadBufferToCloudinary(buffer: Buffer, options: UploadApiOptions) {
  ensureCloudinaryConfigured();

  return new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error || !result) {
        reject(error ?? new Error("Cloudinary upload failed."));
        return;
      }

      resolve(result);
    });

    stream.end(buffer);
  });
}

export async function listFolderAssets(prefix: string, maxResults = 100) {
  ensureCloudinaryConfigured();

  return cloudinary.api.resources({
    type: "upload",
    resource_type: "image",
    prefix,
    max_results: Math.min(maxResults, 100),
  });
}