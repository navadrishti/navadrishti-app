# GRAM App (field PWA)

Installable Next.js PWA for NGO / individual field attendance and evidence capture.  
Hosted separately from the main GRAM platform; shares the same Supabase project.

## Local

```bash
npm install
cp .env.example .env.local   # fill from the platform .env
npm run dev -- -p 3001
```

## Deploy (Vercel)

1. Connect this repo (`main` via PR from `feature`)
2. Set env vars from `.env.example` (production values)
3. Set `NEXT_PUBLIC_APP_URL` to the deployed URL
4. On the main platform, set `NEXT_PUBLIC_PWA_URL` (and optional `PWA_UPSTREAM_URL`) to that same URL

## Env

See `.env.example`. Required: Supabase URL + keys, `SESSION_SECRET`, Cloudinary keys.
