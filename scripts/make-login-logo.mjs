import sharp from "sharp";

// White wordmark + orange ND — for navy login background (Android-safe PNG).
await sharp("public/logo.svg", { density: 200 })
  .resize(600)
  .png()
  .toFile("public/login-logo.png");

console.log("Wrote public/login-logo.png");
