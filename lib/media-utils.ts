/**
 * High-performance image compression for the Navadrishti Field App.
 * Uses the browser's Canvas API to resize and re-encode images to JPEG.
 */

export interface CompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  mimeType?: string;
}

const DEFAULT_OPTIONS: CompressionOptions = {
  maxWidth: 1280, // High-def but reasonable
  maxHeight: 1280,
  quality: 0.7,   // 70% quality is the "sweet spot" for audit evidence
  mimeType: "image/jpeg"
};

/**
 * Compresses an image File or Blob.
 */
export async function compressImage(
  file: File | Blob,
  options: CompressionOptions = {}
): Promise<Blob> {
  const settings = { ...DEFAULT_OPTIONS, ...options };

  // 1. Create an Image object from the file
  const img = new Image();
  const url = URL.createObjectURL(file);
  
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });

  // 2. Calculate new dimensions while maintaining aspect ratio
  let width = img.width;
  let height = img.height;

  if (width > settings.maxWidth!) {
    height = Math.round((height * settings.maxWidth!) / width);
    width = settings.maxWidth!;
  }
  if (height > settings.maxHeight!) {
    width = Math.round((width * settings.maxHeight!) / height);
    height = settings.maxHeight!;
  }

  // 3. Draw to canvas
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  
  if (!ctx) {
    URL.revokeObjectURL(url);
    throw new Error("Could not get canvas context");
  }

  ctx.drawImage(img, 0, 0, width, height);
  URL.revokeObjectURL(url);

  // 4. Export as Blob
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Canvas toBlob failed"));
        }
      },
      settings.mimeType,
      settings.quality
    );
  });
}

/**
 * Utility to check if a file is an image that can be compressed.
 */
export function isCompressibleImage(file: File | Blob): boolean {
  return file.type.startsWith("image/") && file.type !== "image/gif";
}
