# GRAM Field App — Technical Documentation

> **Version:** 0.1.0 · **Package:** `gram-field-pwa` · **Stack:** Next.js 16 + React 19 PWA  
> Hosted separately from the main GRAM platform; shares the same Supabase schema.  
> Platform gateway: `{PLATFORM}/api/pwa/*` → this app’s `/api/*`. Field capture is install-only (PWA/APK), not a website route.

---

## Quick Start

```bash
npm install
npm run dev -- -p 3001
```

Open `http://localhost:3001`. Configure environment variables per [Environment Variables](#environment-variables) (copy Supabase/Cloudinary/session keys from the main platform `.env`).

---

# SECTION 1: PWA OVERVIEW

## Application Identity

| Attribute | Value |
|-----------|-------|
| **Application Name** | GRAM Field |
| **Package Name** | `gram-field-pwa` (v0.1.0) |
| **Repository** | `Navadrishti-PWA` |
| **Deployment Model** | Next.js 16 Progressive Web App (PWA), installable via Web Manifest + Service Worker |
| **Primary Entry Point** | `/` (`app/page.tsx`) |

## Purpose

The Navadrishti PWA is an **offline-first field evidence capture and synchronization application** designed for NGO field operators and government infrastructure auditors to collect verifiable photographic evidence, GPS coordinates, timestamps, and metadata while disconnected from network, then synchronize immutable evidence records to the main Navadrishti platform backend (Supabase + Cloudinary).

## Problem Solved

| Problem | Solution Implemented |
|---------|---------------------|
| Field teams operate in low-connectivity rural/remote areas | IndexedDB (Dexie) local persistence + sync queue with exponential backoff retry |
| Evidence must be tamper-evident and auditable | Client UUID idempotency, SHA-256 `proofHash` on media blobs, server-side chained `payload_hash` event ledger in Supabase `events` table |
| NGO milestone compliance requires structured submission | Milestone-gated CSR evidence workflow with status transitions (`pending` → `submitted` → `approved` → `payment_initiated` → `paid`) |
| Government AWC infrastructure audits require geo-verification | AWC site + reference point selection with Haversine distance validation against configurable radius |
| Company CA must review evidence before disbursement | Dedicated CA review portal at `/ca/review` with approve/reject/payment receipt upload |

## Target Users

| User Segment | Platform Role (`SessionRole`) | Primary Use |
|--------------|-------------------------------|-------------|
| Lead NGO / NGO Field Operator | `ngo` | CSR milestone evidence capture and sync |
| Legacy Field User Label | `field` | Routed identically to NGO capture UI (not assigned by current login API) |
| Government Field Officer / AWC Auditor | `gov` | AWC site infrastructure verification with geo-fencing |
| Company Chartered Accountant (CA) | `ca` | Milestone evidence review, approval/rejection, payment receipt upload |
| Legacy Manager Role | `manager` | Local remote-mirror dashboard (demo-era role, not assigned by current login API) |

## Major Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| **Authentication & Session** | `lib/ngo-auth.ts`, `lib/session.ts`, `app/api/login/route.ts`, `lib/ngo-gate.ts` | Platform user authentication against Supabase `users` table; HMAC-signed HTTP-only session cookie; verification gates |
| **App State Provider** | `components/app-provider.tsx` | Global session, online/offline state, periodic sync orchestration (20s interval) |
| **Field Capture Console** | `components/field-console.tsx` | Camera capture, GPS at submit, NGO and GOV workflows, local ledger display |
| **Manager/CA Dashboard** | `components/manager-console.tsx` | Read-only synced evidence mirror from IndexedDB `remoteRecords` |
| **CA Review Portal** | `app/ca/review/page.tsx` | Server-backed milestone review queue, evidence inspection, approve/reject, payment |
| **Local Database** | `lib/db.ts` | Dexie IndexedDB schema (v9) with 10 object stores |
| **Sync Engine** | `lib/sync-engine.ts` | Pull projects/AWC sites, process upload queue, pull remote evidence history |
| **Evidence Ingestion API** | `app/api/evidence/route.ts` | Multipart evidence upload → Cloudinary → Supabase `events` ledger |
| **Projects/Sites API** | `app/api/projects/route.ts` | Role-branching data fetch (CSR projects vs AWC sites) |
| **Media Utilities** | `lib/media-utils.ts`, `lib/crypto.ts` | Image compression (unused in UI), SHA-256 hashing |
| **PWA Infrastructure** | `next.config.mjs`, `app/manifest.ts`, `app/offline/page.tsx` | Service worker, offline fallback page, install manifest |
| **Cloudinary Integration** | `lib/cloudinary.ts`, `app/api/media/upload/route.ts`, `app/api/media/list/route.ts` | Server-side media upload/list (not wired to field capture UI) |
| **Payment Lifecycle APIs** | `app/api/payment/complete/route.ts`, `app/api/payment/acknowledge/route.ts` | CA payment receipt upload; NGO payment acknowledgment (API only, no UI) |
| **Review APIs** | `app/api/review/evidence/route.ts`, `app/api/review/milestone/route.ts` | CA evidence fetch and milestone state transitions |
| **Rate Limiting** | `lib/rate-limit.ts` | In-memory rate limits on login and media upload |
| **RLS Policy Reference** | `supabase_rls_setup.sql` | Documented Supabase Row-Level Security policies (not enforced by PWA directly; server uses service role) |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NAVADRISHTI MAIN PLATFORM                           │
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────────────────────┐   │
│  │ Supabase DB  │  │ Supabase Auth    │  │ Cloudinary CDN              │   │
│  │ - users      │  │ (optional client)│  │ - evidence images           │   │
│  │ - ngo_verif. │  │                  │  │ - payment receipts          │   │
│  │ - csr_proj.  │  │                  │  │                             │   │
│  │ - milestones │  │                  │  │                             │   │
│  │ - events     │  │                  │  │                             │   │
│  │ - awc_sites  │  │                  │  │                             │   │
│  └──────┬───────┘  └────────┬─────────┘  └──────────────┬──────────────┘   │
└─────────┼───────────────────┼────────────────────────────┼──────────────────┘
          │    HTTPS (Next.js API Routes)                  │
          ▼                   ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      NAVADRISHTI PWA (Next.js 16 + React 19)              │
│  UI Layer ←→ AppProvider ←→ Sync Engine ←→ IndexedDB (Dexie)              │
│  Service Worker + localStorage (session, device-id)                         │
└─────────────────────────────────────────────────────────────────────────────┘
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              FIELD DEVICE — Camera | Geolocation | IndexedDB                │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Relationship with Main Navadrishti Platform

| Integration Point | Direction | Mechanism | Data Exchanged |
|-------------------|-----------|-----------|----------------|
| **User Authentication** | PWA → Platform | `POST /api/login` queries Supabase `users` + `ngo_verifications` | Email, password, optional `device_id` |
| **NGO Verification Gate** | Platform → PWA | `lib/ngo-auth.ts` multi-step verification checks | Blocks unverified NGOs |
| **CSR Project Assignment** | Platform → PWA | `GET /api/projects` filtered by `ngo_user_id` | Projects, milestones, reference points |
| **AWC Site Assignment** | Platform → PWA | `GET /api/projects` (GOV branch) | Sites, districts, reference points |
| **Evidence Ingestion** | PWA → Platform | `POST /api/evidence` multipart upload | Payload + images → Cloudinary + `events` ledger |
| **Evidence History Pull** | Platform → PWA | `GET /api/sync/evidence/history` | Last 50 events for current user |
| **CA Milestone Review** | CA Portal → Platform | Review + payment API routes | Approve/reject, payment receipts |
| **Device Binding** | Platform ↔ PWA | `users.device_id` locked on first NGO login | Hardware lock for NGO accounts |
| **Event-Sourced Audit Ledger** | PWA → Platform | Chained `payload_hash` in Supabase `events` | Immutable audit trail |

### Platform Tables Referenced

`users`, `ngo_verifications`, `csr_projects`, `csr_project_milestones`, `events`, `awc_sites`, `awc_reference_points`, `reference_points`

---

# SECTION 2: USER TYPES & ACCESS MODEL

## Role Inventory

```typescript
export type SessionRole = "ngo" | "ca" | "field" | "manager" | "gov";
```

The **active login API** (`lib/ngo-auth.ts`) assigns roles from Supabase `users.user_type`:

| Platform `user_type` | Mapped PWA Role | Login Allowed |
|---------------------|-----------------|---------------|
| `ngo` | `ngo` | Yes (full verification gate + device binding) |
| `company` + `profile_data.role = 'company_ca'` | `ca` | Yes |
| `gov` | `gov` | Yes |
| Other types | — | Blocked |

Roles `field` and `manager` exist in the type system but are **not assigned by the production login API** (legacy demo only).

---

## Role 1: Lead NGO (`ngo`)

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Capture CSR milestone evidence and synchronize for CA review |
| **Screens** | `/` → FieldConsole (NgoCaptureView) |
| **Actions Allowed** | Login (if verified); capture photos; seal evidence; view last 5 local records; sign out |
| **Actions Restricted** | No manual project/milestone picker; no reference points; no edit/delete after seal; no CA review; no payment ack UI |

### Login Gate Conditions (all must pass)

1. Valid email/password · 2. `user_type = 'ngo'` · 3. `email_verified` · 4. `phone_verified` · 5. `verification_status = 'verified'` · 6. Account not `pending_verification` · 7. Identity verified · 8. `ngo_verifications.verification_status = 'verified'` · 9. Device binding match (if set)

---

## Role 2: Field Officer — Legacy (`field`)

Same UI as NGO when session exists. **Not assigned by `/api/login`.** API treats `field` identical to `ngo` for project queries.

---

## Role 3: Government Field Officer (`gov`)

| Attribute | Detail |
|-----------|--------|
| **Purpose** | AWC infrastructure verification with geo-fencing |
| **Screens** | `/` → FieldConsole (GovCaptureView) |
| **Actions Allowed** | Select AWC site + reference point; capture geo-validated photos; submit audit log |
| **Actions Restricted** | No milestone workflow; must be within reference point radius; no ML validation |

---

## Role 4: Company CA (`ca`)

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Review evidence; approve/reject; upload payment receipts |
| **Screens** | `/` (ManagerConsole), `/ca/review` (review portal) |
| **Actions Allowed** | View audit queue; inspect evidence; approve/reject; upload payment receipt |
| **Actions Restricted** | Cannot capture field evidence; cannot modify submitted evidence |

---

## Role 5: Manager (`manager`)

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Read-only local mirror of synced evidence (demo dashboard) |
| **Screens** | `/` → ManagerConsole |
| **Actions Allowed** | View metrics, evidence feed, sync log; refresh sync |
| **Actions Restricted** | No server review actions; **not assigned by login API** |

---

## Access Model Summary

| Capability | NGO | GOV | CA | Manager |
|-----------|-----|-----|----|---------|
| Field capture | ✅ | ✅ | ❌ | ❌ |
| Geo-radius validation | ❌ | ✅ | ❌ | ❌ |
| Milestone gating | ✅ | ❌ | ❌ | ❌ |
| Device binding | ✅ | ❌ | ❌ | ❌ |
| CA review | ❌ | ❌ | ✅ | ❌ |
| Payment upload | ❌ | ❌ | ✅ | ❌ |
| Payment acknowledge | ❌ (no UI) | ❌ | ❌ | ❌ |

---

# SECTION 3: COMPLETE FEATURE INVENTORY

| # | Feature | Actors | Status |
|---|---------|--------|--------|
| 1 | Platform Authentication (`POST /api/login`) | NGO, GOV, CA | **Implemented** |
| 2 | Supabase Client Auth (AppProvider) | — | **Partial** — not wired to login UI |
| 3 | Dual Session Storage (cookie + localStorage) | All | **Implemented** |
| 4 | Role-Based Routing | All | **Implemented** |
| 5 | Field Operator Status Dashboard | NGO, GOV | **Implemented** |
| 6 | CSR Project Selection | NGO | **Partial** — auto-select only |
| 7 | CSR Milestone Selection | NGO | **Partial** — auto-select only |
| 8 | AWC Reference Point Selection | GOV | **Implemented** |
| 9 | NGO Reference Point Selection | NGO | **Not Implemented** |
| 10 | Camera Evidence Capture | NGO, GOV | **Implemented** |
| 11 | Multi-Image Capture (max 5) | NGO, GOV | **Implemented** |
| 12 | Video Capture | — | **Not Implemented** |
| 13 | Document Capture | — | **Partial** — API only |
| 14 | Metadata Collection | NGO, GOV | **Implemented** |
| 15 | IndexedDB Offline Persistence | NGO, GOV | **Implemented** |
| 16 | Background Sync Runner (20s) | All | **Implemented** |
| 17 | Exponential Backoff Retry Queue | NGO, GOV | **Implemented** |
| 18 | Server Evidence Submission | NGO, GOV | **Implemented** |
| 19 | Immutable Receipt Mirror | Sync → Manager | **Implemented** |
| 20 | Push/In-App Notifications | — | **Not Implemented** |
| 21 | Recent Device History (last 5) | NGO, GOV | **Implemented** |
| 22 | Remote Evidence History Pull | NGO | **Implemented** |
| 23 | Reporting Module | — | **Not Implemented** |
| 24 | Settings | — | **Not Implemented** |
| 25 | CA Milestone Review Portal | CA | **Implemented** |
| 26 | Payment Lifecycle | CA (UI), NGO (API) | **Partial** |
| 27 | Manager Dashboard (Remote Mirror) | CA, Manager | **Implemented** |
| 28 | PWA Installability | All | **Partial** — SW disabled in dev config |
| 29 | Offline Fallback Page | All | **Implemented** |
| 30 | Image Compression Utility | — | **Partial** — not integrated |
| 31 | ML Validation | — | **Not Implemented** |
| 32 | Automated Flag Generation | — | **Partial** — manual CA reject only |
| 33 | Government Analytics | — | **Not Implemented** |
| 34 | API Rate Limiting | All API | **Implemented** |
| 35 | User Switch Data Wipe | All | **Implemented** (AppProvider path) |
| 36 | Device ID Generation | NGO, GOV | **Partial** — not sent at login |
| 37 | Alternate Sync API (`/api/sync-evidence`) | — | **Partial** — unused by client |
| 38 | Project Drafts System | — | **Partial** — schema only |
| 39 | Standalone Media Upload API | — | **Partial** — not wired to UI |
| 40 | Legacy HomeShell Landing | — | **Orphaned** |

---

# SECTION 4: COMPLETE EVIDENCE CAPTURE SYSTEM

## Two Evidence Domains

| Domain | User | Hierarchy | Geo Validation |
|--------|------|-----------|----------------|
| **CSR Milestone** | NGO | Project → Milestone (auto) | GPS captured, not validated |
| **AWC Infrastructure** | GOV | Site → Reference Point (manual) | Haversine radius check |

## NGO Evidence Lifecycle

```
START → Login → pullProjectData() → Auto-select active milestone
  ↓
DECISION: milestone.status === "pending"?
  ├─ NO → Form locked
  └─ YES → Open camera → Capture 1-5 photos → Fill form → Seal & Sync
       ↓
handleSeal(): GPS poll → SHA-256 hashes → IndexedDB write → syncQueue
  ↓
Online? → processSyncQueue() → POST /api/evidence → Cloudinary + events ledger
  ↓
Status: pending → syncing → synced (or failed with retry)
  ↓
CA Review at /ca/review → approve/reject → payment → (NGO ack via API)
```

## GOV Evidence Lifecycle

```
START → Login → pullAwcData() → Select Site → Select Reference Point
  ↓
Capture photos → Enter observations → Seal Infrastructure Audit
  ↓
GPS + Haversine validation (must be within radius, default 100m)
  ↓
IndexedDB → syncQueue → POST /api/evidence (folder: navadrishti/gov/site-{siteId})
```

## Business Rules

| ID | Rule | Enforced |
|----|------|----------|
| BR-001 | GPS required at seal | ✅ |
| BR-002 | GPS only at submit, not continuously | ✅ |
| BR-003 | Max 5 images per submission | ✅ |
| BR-004 | Camera only — no gallery | ✅ |
| BR-005 | Pre-seal delete only | ✅ |
| BR-006 | Timestamp burned into image | ✅ |
| BR-007 | Context label burned into image | ✅ |
| BR-008 | SHA-256 proofHash per blob | ✅ |
| BR-009 | Client UUID idempotency | ✅ |
| BR-010 | NGO milestone locked when status ≠ pending | ✅ |
| BR-011 | ≥1 photo required to seal | ✅ |
| BR-016 | GOV geo-radius validation | ✅ |
| BR-018 | Evidence immutable after sync | ✅ |
| BR-026 | Document evidence | ❌ |
| BR-027 | Video evidence | ❌ |
| BR-028 | Image compression | ❌ |
| BR-029 | ML validation | ❌ |
| BR-030 | NGO reference points | ❌ |

---

# SECTION 5: LEAD NGO WORKFLOW

## Login

`POST /api/login` → `authenticateNgoWithPassword()` → HMAC cookie + localStorage session → reload → FieldConsole.

## Assigned Projects

`pullProjectData()` → `GET /api/projects` (filtered by `ngo_user_id`) → milestones + referencePoints stored in IndexedDB. **No project picker UI** — first non-`paid` milestone auto-selected.

## Evidence Capture

Camera (environment-facing) → 1-5 JPEG photos with timestamp/context overlay → beneficiary name + interaction type + notes → "Seal & Sync".

## GPS & Timestamps

- GPS: `getCurrentPosition()` at seal only (8s timeout, high accuracy)
- Timestamps: burned into image + ISO on record + server `capturedAtServer`

## Offline Behavior

Seal works offline → queued in `syncQueue` → auto-sync on reconnect (immediate + every 20s).

## Evidence Reaches CA

```
Sync → events (EVIDENCE_SUBMITTED) → milestone status "submitted"
  → CA at /ca/review → inspect → approve/reject → payment receipt
```

## Dashboard (embedded in FieldConsole)

Connectivity chip · Queue count · Media count · Milestone card · Camera · Form · Last 5 history records

---

# SECTION 6: FIELD OFFICER WORKFLOW

> In this codebase, **Government Field Officer** = `session.role === "gov"` (`GovCaptureView`). The `field` role routes to NGO CSR workflow.

## Login

`user_type = 'gov'` — skips NGO verification gate; no device binding.

## AWC Sites

`pullAwcData()` → `awc_sites` + `awc_reference_points` → site/asset dropdowns.

## Reference Point Selection

Site dropdown → reference points filtered by `siteId` → enables camera with reference photo comparison.

## Geo Validation

```typescript
geoDistance = haversine(userLat, userLng, refPoint.lat, refPoint.lng)
geoValidated = geoDistance <= (refPoint.radius ?? 100)
// Throws if outside radius
```

## ML Validation / Deviation Detection / Government Analytics

**Not implemented.**

---

# SECTION 7: CAMERA & EVIDENCE RULES

| Rule | Implementation |
|------|---------------|
| **Camera only** | `getUserMedia({ facingMode: "environment" })` — no file picker |
| **Max 5 images** | Shutter disabled at 5 (`field-console.tsx:479`) |
| **GPS at seal** | Required; throws if unavailable |
| **Timestamps** | Canvas burn-in + ISO record fields |
| **Image format** | JPEG 90% quality from canvas |
| **proofHash** | SHA-256 via `crypto.subtle.digest` |
| **Immutability** | No edit/delete after seal; server append-only ledger |
| **GOV reference photo** | Side-by-side with live viewfinder |
| **Compression** | `compressImage()` exists but **not called** |
| **Documents** | API accepts via `/api/media/upload` — **no field UI** |

---

# SECTION 8: OFFLINE-FIRST ARCHITECTURE

## Storage

| Layer | Technology |
|-------|-----------|
| Primary DB | IndexedDB via Dexie v4 (`navadrishti-field-db`, schema v9) |
| Session | localStorage (`navadrishti.session`, `navadrishti.device-id`) |
| HTTP cache | Workbox service worker (disabled in dev) |
| SQLite | Not used |

## Sync Queue

- Batch size: **5**
- Max attempts: **10**
- Backoff: `min(30000 × 2^attempts, 30min) + jitter(0-5s)`
- Terminal: `FATAL:`, `AUTH_EXPIRED:`, or max attempts (`nextAttemptAt = -1`)
- HTTP 409: treated as success (idempotent)

## Conflict Resolution

Append-only evidence; last-write-wins on milestone status; full IndexedDB wipe on user switch. No operational transform.

## Background Sync

20-second polling while online. No Service Worker Background Sync API.

## Data Wipe Policies

| Trigger | Cleared | Preserved |
|---------|---------|-----------|
| User switch | ALL tables | — |
| Sign out | remoteRecords, milestones, referencePoints | pending records, queue, media |
| pullProjectData | milestones, NGO ref points | records, queue |

---

# SECTION 9: DASHBOARD ARCHITECTURE

## Dashboard 1: Field Console (NGO + GOV)

| Attribute | Value |
|-----------|-------|
| **Route** | `/` |
| **Component** | `components/field-console.tsx` |

**Widgets:** Header · Connectivity/Queue/Media chips · Milestone or Site card · Camera · Form · History (last 5) · Lightbox

**Actions:** Camera · Capture · Seal · Sign out · Preview images

---

## Dashboard 2: Manager Dashboard

| Attribute | Value |
|-----------|-------|
| **Route** | `/` (role = ca or manager) |
| **Component** | `components/manager-console.tsx` |

**Widgets:** Synced count · Latest sync · Audit-ready · Milestone-attached · Sync log (6) · Evidence feed

**Actions:** Refresh sync · Sign out · View media (read-only)

---

## Dashboard 3: CA Audit Portal

| Attribute | Value |
|-----------|-------|
| **Route** | `/ca/review` |
| **Component** | `app/ca/review/page.tsx` |

**Widgets:** Audit queue · Inspection desk · Evidence proofs · Remarks · Payment upload

**Actions:** Approve · Reject · Upload payment receipt · Refresh

---

## Dashboard Comparison

| Capability | Field Console | Manager | CA Review |
|-----------|---------------|---------|-----------|
| Capture | ✅ | ❌ | ❌ |
| Server review | ❌ | ❌ | ✅ |
| Local mirror | ❌ | ✅ | ❌ |
| Approve/reject | ❌ | ❌ | ✅ |

---

# SECTION 10: SCREEN INVENTORY

| Screen | Route | User | Purpose |
|--------|-------|------|---------|
| Field Ops Login | `/` | Unauthenticated | Email/password login |
| Field Console (NGO) | `/` | ngo, field | CSR milestone capture |
| Field Console (GOV) | `/` | gov | AWC infrastructure audit |
| Manager Dashboard | `/` | ca, manager | Local evidence mirror |
| CA Audit Portal | `/ca/review` | ca | Milestone review + payment |
| Offline Fallback | `/offline` | All | SW offline page |
| Image Lightbox | `/` overlay | NGO, GOV | Full-size preview |

**Note:** `/field` and `/manager` routes referenced in orphaned `home-shell.tsx` do **not exist**.

---

# SECTION 11: API INVENTORY

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/api/login` | Public | Authenticate; set session cookie |
| POST | `/api/logout` | — | Clear session cookie |
| GET | `/api/session` | Cookie | Return session + config status |
| GET | `/api/projects` | Cookie | CSR projects (NGO/CA) or AWC sites (GOV) |
| POST | `/api/evidence` | Cookie | Ingest evidence (multipart) — **used by sync engine** |
| GET | `/api/evidence` | — | Health check |
| POST | `/api/sync-evidence` | Cookie | Alternate ingestion — **unused by client** |
| GET | `/api/sync/evidence/history` | Cookie | Pull last 50 evidence events |
| GET | `/api/review/evidence` | Cookie (CA) | Fetch milestone evidence |
| POST | `/api/review/milestone` | Cookie (CA) | Approve/reject milestone |
| POST | `/api/payment/complete` | Cookie (CA) | Upload payment receipt |
| POST | `/api/payment/acknowledge` | Cookie (NGO) | Acknowledge payment — **no UI** |
| POST | `/api/media/upload` | Cookie | Standalone media upload — **not wired** |
| GET | `/api/media/list` | Cookie | List Cloudinary assets — **not wired** |

### POST `/api/evidence` Request

`multipart/form-data`: `payload` (JSON `IngestionPayload`) + `files[]` (images)

### POST `/api/login` Request

```json
{ "email": "string", "password": "string", "device_id": "string (optional)" }
```

See source files in `app/api/` for full request/response schemas.

---

# SECTION 12: LOCAL DATA MODEL

## IndexedDB Tables (Dexie v9)

| Table | PK | Purpose |
|-------|-----|---------|
| `recordsLocal` | `id` | Evidence records |
| `mediaLocal` | `id` | Media blobs (linked by `recordId`) |
| `syncQueue` | `id` | Pending upload queue |
| `syncLog` | `id` | Sync activity log |
| `remoteRecords` | `id` | Server-confirmed immutable mirror |
| `milestones` | `id` | Cached CSR milestones |
| `referencePoints` | `id` | Cached reference points (NGO + GOV) |
| `awcSites` | `id` | Cached AWC sites |
| `projectDrafts` | `id` | Draft storage — **unused** |

## localStorage Keys

| Key | Purpose |
|-----|---------|
| `navadrishti.session` | Client session JSON |
| `navadrishti.lastUserId` | User switch detection |
| `navadrishti.device-id` | Persistent device UUID |

## Record Status State Machine

```
pending → syncing → synced
              ↓
           failed → (retry) → syncing
              ↓
           failed (terminal)
```

## Milestone Status State Machine

```
pending → submitted → approved → payment_initiated → paid
                  ↘ rejected
paid → unlocks next milestone to pending
```

---

# SECTION 13: FRONTEND ARCHITECTURE

## Stack

| Component | Version |
|-----------|---------|
| Next.js | 16.1.6 (App Router) |
| React | 19.0.0 |
| TypeScript | 5.9.3 |
| Dexie | 4.0.10 |
| @ducanh2912/next-pwa | 10.2.9 |

## Folder Structure

```
app/           → pages, API routes, manifest
components/    → app-provider, field-console, manager-console, media-preview
lib/           → db, sync-engine, auth, session, types, crypto, cloudinary
public/        → sw.js, logos, workbox
```

## Routing

| Route | File |
|-------|------|
| `/` | `app/page.tsx` |
| `/offline` | `app/offline/page.tsx` |
| `/ca/review` | `app/ca/review/page.tsx` |
| `/api/*` | `app/api/*/route.ts` |

## State Management

- **Global:** React Context (`AppProvider`)
- **Local DB:** Dexie + `useLiveQuery`
- **No Redux/Zustand**

## Auth Guards

| Location | Check |
|----------|-------|
| `app/page.tsx` | Session required; role routing |
| `manager-console.tsx` | role = ca or manager |
| `ca/review/page.tsx` | role = ca (via `/api/session`) |
| API routes | `verifySessionToken()` on cookie |
| Middleware | **Not implemented** |

## PWA Config

- Manifest: `app/manifest.ts` — standalone, portrait, start_url `/`
- Service worker: `disable: true` in dev (`next.config.mjs`)
- Offline fallback: `/offline`

---

# SECTION 14: SECURITY ARCHITECTURE

| Area | Implementation |
|------|---------------|
| **Authentication** | Supabase `users` table + bcrypt/plain password compare |
| **Session** | HMAC-SHA256 signed cookie (7-day); duplicate in localStorage |
| **Authorization** | Role checks per API route; NGO project filtering by `ngo_user_id` |
| **Rate limiting** | Login: 10/IP/10min · Upload: 120/ngoId:IP/10min |
| **Evidence integrity** | Client SHA-256 per blob; server chained SHA-256 event hashes |
| **Idempotency** | Client UUID as `event_id` |
| **Device binding** | NGO `users.device_id` — server logic exists; login UI doesn't send it |
| **Encryption at rest** | IndexedDB **not encrypted** |
| **RLS** | Documented in `supabase_rls_setup.sql` — **bypassed by service role key** |
| **Secrets** | Server-only: `SUPABASE_SERVICE_ROLE_KEY`, `APP_SESSION_SECRET`, Cloudinary secret |

---

# SECTION 15: REPORTING & ANALYTICS

| Capability | Status |
|-----------|--------|
| CSR compliance reports | ❌ |
| AWC verification reports | ❌ |
| Export (CSV/PDF/JSON) | ❌ |
| Government analytics | ❌ |
| ML analytics | ❌ |
| Basic metrics (ManagerConsole) | ✅ 4 count cards |
| Sync log (last 6) | ✅ ManagerConsole |
| Device history (last 5) | ✅ FieldConsole |

---

# SECTION 16: TECHNICAL DEBT & FUTURE FEATURES

## Mock / Legacy

- ManagerConsole labeled as "demo remote table"
- Orphaned `home-shell.tsx` with `/field`, `/manager` routes that don't exist
- `field` and `manager` roles in types but not assigned by login API

## Partial

- PWA service worker disabled in dev config
- Document capture (API only, no UI)
- Project drafts (schema only)
- Image compression (utility not called)
- Device binding (server only, client doesn't send `device_id`)
- Payment ack (API only, no NGO UI)
- Dual auth paths (`/api/login` vs AppProvider Supabase signIn)
- Dual evidence APIs (`/api/evidence` vs `/api/sync-evidence`)

## Not Implemented

- Notifications · Settings · Reports · ML validation · Government analytics · Video capture · Background Sync API · Capacitor native wrapper

## Scalability Concerns

- In-memory rate limiting (not shared across instances)
- Sync batch size fixed at 5
- History pull limited to 50 events
- No IndexedDB blob cleanup policy
- Service role bypasses RLS on all server queries

## Planned (from README comments)

- Supabase Auth as primary login
- Cloudinary signed uploads
- RLS enforcement
- Capacitor Android/iOS
- Production PWA enablement

---

# SECTION 17: DOCUMENTATION VS REALITY

## Claimed but NOT Implemented

| Claim | Reality |
|-------|---------|
| README: "local demo auth" | Uses Supabase platform auth via `/api/login` |
| README: "video capture" | Still photos from video stream only |
| HomeShell: routes `/field`, `/manager` | Routes don't exist |
| "End-to-End Encrypted Ingestion" (login UI) | HTTPS + hashes only, no E2E encryption |
| ML validation, deviation detection, gov analytics | Not in codebase |
| Notifications, reports, settings | Not in codebase |
| Device-side compression (README) | Utility exists, never called |

## Implemented but Missing from Old README

| Feature | Detail |
|---------|--------|
| GOV AWC audit workflow | Site + reference point + geo-fencing |
| CA Review Portal | `/ca/review` with full review + payment |
| Event-sourced audit ledger | Chained hashes in Supabase `events` |
| Payment lifecycle APIs | Complete + acknowledge (no NGO UI) |
| Device binding | NGO hardware lock on first login |
| NGO verification gate | Multi-step platform verification |
| Rate limiting | Login + upload |
| Haversine geo-validation | GOV only |
| Reference photo comparison | GOV side-by-side UI |
| User switch data wipe | Full IndexedDB clear |
| Idempotency + 409 handling | Client UUID dedup |

---

## Environment Variables

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
APP_SESSION_SECRET=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_UPLOAD_FOLDER=navadrishti
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

Copy from `.env.example` and fill before running in production.

---

## Production Hardening Checklist

1. Enable PWA service worker (`disable: false` in `next.config.mjs`)
2. Consolidate auth to single path (remove dual login)
3. Send `device_id` from login UI for NGO device binding
4. Integrate `compressImage()` before upload
5. Wire NGO payment acknowledgment UI to `/api/payment/acknowledge`
6. Enforce Supabase RLS (move off service role for user-scoped queries)
7. Remove login debug info from 401 responses
8. Add CSRF protection and Content Security Policy headers
9. Consolidate `/api/evidence` and `/api/sync-evidence`
10. Capacitor packaging for native Android/iOS permissions

---

*Generated from full codebase analysis — 54 source files, v0.1.0.*
