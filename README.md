# Navadrishti Field App MVP

This repo now contains a beginner-friendly offline-first PWA MVP for field evidence capture.

## What is included

- Field login flow with local demo auth and role routing.
- Offline field submission form with project ID, project name, milestone ID, beneficiary interaction, timestamp, optional GPS captured only at submit time, device ID, and media capture.
- IndexedDB storage via Dexie for:
  records_local
  media_local
  sync_queue
  sync_log
- Background sync runner with batched uploads, retry and exponential backoff.
- UUID dedupe and immutable receipt confirmation in the synced remote mirror records.
- Manager dashboard backed by a demo remote mirror table so you can validate company, milestone, and audit review before wiring a real backend.
- PWA manifest and service worker setup using `@ducanh2912/next-pwa`.

## Install and run

```bash
npm install
npm run dev
```

Then open `http://localhost:3000` in Chrome, install the PWA, and test airplane mode on Android.

## How this maps to your target architecture

Current implementation:

- Auth: local demo adapter in [components/app-provider.tsx](c:/Users/chaks/Desktop/Navadrishti-PWA/components/app-provider.tsx)
- Local DB: [lib/db.ts](c:/Users/chaks/Desktop/Navadrishti-PWA/lib/db.ts)
- Sync worker: [lib/sync-engine.ts](c:/Users/chaks/Desktop/Navadrishti-PWA/lib/sync-engine.ts)
- Field UI: [components/field-console.tsx](c:/Users/chaks/Desktop/Navadrishti-PWA/components/field-console.tsx)
- Manager UI: [components/manager-console.tsx](c:/Users/chaks/Desktop/Navadrishti-PWA/components/manager-console.tsx)

Recommended next replacements:

1. Replace the local auth adapter with Supabase Auth.
2. Replace the demo remote mirror in the sync engine with:
   - Cloudinary signed upload for media
   - Supabase or your API for metadata
3. Add row-level security and role policies in Supabase.
4. Add Capacitor after the PWA flow is stable.

## Suggested environment variables for the next step

These are not required for the current local demo, but they are the env names you should add when moving from demo storage to production services:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_API_BASE_URL=
```

For signed Cloudinary uploads, keep the Cloudinary secret on the server only.

## Production hardening checklist

1. Supabase auth session persistence.
2. Server-issued Cloudinary signatures.
3. Idempotency on client UUID.
4. Device-side image and video compression before upload.
5. Manager dashboard backed by real remote tables instead of the local mirror.
6. Capacitor packaging and device permission prompts for Android and iOS.
