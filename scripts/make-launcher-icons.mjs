import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resDir = resolve(rootDir, "android/app/src/main/res");
const assetsDir = resolve(rootDir, "assets");

mkdirSync(assetsDir, { recursive: true });

const CANVAS = 1024;
const LOGO_MAX = 380; // keep orange mark well inside the safe zone

const SIZES = {
  "mipmap-ldpi": 36,
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};

async function buildMasterIcon() {
  const trimmed = await sharp("public/small-logo.svg", { density: 300 })
    .trim({ threshold: 8 })
    .resize(LOGO_MAX, LOGO_MAX, {
      fit: "inside",
      background: { r: 255, g: 255, b: 255 },
    })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();

  const meta = await sharp(trimmed).metadata();
  const left = Math.floor((CANVAS - meta.width) / 2);
  const top = Math.floor((CANVAS - meta.height) / 2);

  return sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: trimmed, left, top }])
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .png()
    .toBuffer();
}

async function writeMipmaps(master) {
  for (const [folder, px] of Object.entries(SIZES)) {
    const dir = join(resDir, folder);
    mkdirSync(dir, { recursive: true });

    const resized = await sharp(master)
      .resize(px, px, { kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();

    for (const name of ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]) {
      writeFileSync(join(dir, name), resized);
    }
  }
}

function removeBackgroundMipmaps() {
  for (const entry of readdirSync(resDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("mipmap-")) continue;
    const bg = join(resDir, entry.name, "ic_launcher_background.png");
    try {
      rmSync(bg, { force: true });
    } catch {
      // ignore
    }
  }
}

const master = await buildMasterIcon();
writeFileSync(join(assetsDir, "icon-only.png"), master);
writeFileSync(join(assetsDir, "icon-foreground.png"), master);
writeFileSync(
  join(assetsDir, "icon-background.png"),
  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .removeAlpha()
    .png()
    .toBuffer()
);

await writeMipmaps(master);
removeBackgroundMipmaps();

const adaptiveIconXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_foreground" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;

writeFileSync(join(resDir, "mipmap-anydpi-v26/ic_launcher.xml"), adaptiveIconXml);
writeFileSync(join(resDir, "mipmap-anydpi-v26/ic_launcher_round.xml"), adaptiveIconXml);

console.log("Launcher icons rebuilt — opaque white, no alpha halo.");
