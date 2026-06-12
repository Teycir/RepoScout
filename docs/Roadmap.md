# RepoScout — Implementation Roadmap

> Continuous GitHub secret scanning platform built on Cloudflare free tier.
> SecretScout pattern engine + LangGraph AI verification + ArxivExplorer terminal-green dashboard.

---

## Phase 1 — Engine & Database ✅ `DONE`

- [x] D1 schema — `migrations/schema.sql` (5 tables: repositories, scan_runs, findings, ai_evaluations, scan_tokens)
- [x] Seed `scan_tokens` script — `scripts/seed-tokens.ts` (SHA-256 hash + masked display, INSERT OR IGNORE)
- [x] YAML → JSON pattern compiler — `scripts/compile-patterns.ts` (walks `secretscout/templates/**/*.yaml`, emits `src/scan-worker/patterns.json`)
- [x] Built-in patterns stub — `src/scan-worker/patterns.json` (27 templates: GitHub PAT, Stripe, OpenAI, Anthropic, AWS, Slack, SendGrid, npm, PyPI, HuggingFace, Discord, Telegram, Cloudflare, Vercel, Netlify, Heroku, Datadog, Twilio, PEM keys, high-entropy generic)
- [x] Zipball streaming scanner — `src/scan-worker/scanner.ts` (fflate Unzip, SKIP_EXTENSIONS, SKIP_DIRS, 1000-char line cap, token D1 helpers)
- [x] TypeScript types — `src/lib/types.ts` (Template, Pattern, Match, Severity, Verdict, Env, risk helpers)
- [x] Scanner logic — `src/lib/scanner.ts` (regex / literal / entropy / composite modes, suppression, dedup, SSH pub-key guard)
- [x] Validator — `src/lib/validator.ts` (30+ providers: GitHub, Stripe, Slack, Anthropic, OpenAI, AWS, DigitalOcean, Mailchimp, Square, Datadog, NewRelic, npm, PyPI, DockerHub, Firebase, Algolia, Okta, Cloudflare, Heroku, Netlify, Vercel, Linear, Notion, Discord, Telegram…)
- [x] Masking utility — `src/lib/masking.ts` (prefix/suffix reveal with `***` middle)
- [x] Entropy module — `src/lib/entropy.ts` (Shannon entropy, charset detection, thresholds, `findHighEntropyStrings`)

---

## Phase 2 — LangGraph AI Pipeline ✅ `DONE`

- [x] 5-node LangGraph pipeline — `src/scan-worker/pipeline.ts`
  - Node 1: Context Gatherer — normalises surrounding context
  - Node 2: Heuristic Filter — placeholder terms + low-entropy hex; short-circuits to FALSE_POSITIVE
  - Node 3: External API Validator — dispatches to 30+ provider validators; ACTIVE → TRUE_POSITIVE, REVOKED → FALSE_POSITIVE
  - Node 4: Workers AI LLM Classifier — `@cf/meta/llama-3.1-8b-instruct`; confidence < 0.65 → NEEDS_HUMAN_REVIEW
  - Node 5: Risk Scorer — `SEVERITY_WEIGHT × VERDICT_MULTIPLIER`
- [x] Conditional edges — heuristic → skip API+LLM; API confirmed → skip LLM
- [x] KV daily quota guard — `llm_quota:{date}` key; cap 263 calls/day; fallback NEEDS_HUMAN_REVIEW
- [x] D1 persistence — `persistEvaluation()` with UPSERT on `finding_id`
- [x] Scan worker entry — `src/scan-worker/index.ts` with round-robin token picking via `pickNextToken()`

---

## Phase 3 — Dashboard ✅ `DONE`

- [x] `globals.css` — terminal-green palette, `bg-grid`, glow classes, shimmer, badge variants
- [x] `tailwind.config.ts` — `neon-green`, `neon-red`, `neon-amber`, `dark-bg`, all animations
- [x] `ParticleBackground.tsx` — Three.js particle rain (20k movers, dual green + blue streams)
- [x] `DecryptedText.tsx` + hooks — `TextScrambler`, `useTextScramble`, `textAnimation.ts`
- [x] `ScrollProgress.tsx` — fixed neon scan-line progress bar
- [x] `app/layout.tsx` — JetBrains Mono, `bg-grid`, radial neon glow, dark mode, security headers
- [x] `app/page.tsx` — dashboard, `HeroStrip` + `RepositoryRiskGrid`
- [x] `HeroStrip.tsx` — live counters (total repos, critical findings, analyst queue, next scan HH:MM:SS countdown)
- [x] `RepositoryRiskGrid.tsx` — cards sorted by `risk_score` desc; colour-coded risk meter; DecryptedText on hover
- [x] `Navbar.tsx` — sticky nav with Dashboard + Review Queue links, live scanning dot
- [x] `app/repo/[id]/page.tsx` — FindingsInspector: severity groups, code snippet with highlighted hit line, masked token, AI reasoning, analyst override display
- [x] `app/review/page.tsx` — AnalystQueue: all NEEDS_HUMAN_REVIEW sorted by severity, mini snippet, confidence bar
- [x] `app/review/TriageButtons.tsx` — confirm leak / false positive buttons, optimistic done state
- [x] `app/api/review/route.ts` — Edge route: validates evalId + verdict, calls `markAnalystReviewed()`
- [x] `app/api/trigger/route.ts` — Edge route: Service Binding (SCAN_WORKER) → HTTP fallback (SCAN_WORKER_URL)
- [x] `lib/db.ts` — D1 query helpers: `getDashboardStats`, `getRepositories`, `getFindingsForRepo`, `getAnalystQueue`, `markAnalystReviewed`, `getRecentScanRuns`

---

## Phase 4 — Deploy & Validate `TODO`

Run in this order:

```bash
# 1. Install deps (three.js was added)
npm install

# 2. Push D1 schema to remote
npm run db:migrate:remote

# 3. Compile SecretScout YAML patterns into patterns.json
#    (requires ../secretscout/templates/ to exist — or use the built-in stub)
npm run compile-patterns

# 4. Seed GitHub PATs from .env into D1 scan_tokens
npm run db:seed-tokens:remote

# 5. Seed repositories to monitor
npm run db:seed-repos:remote
#    → edit scripts/seed-repos.ts REPOS[] first

# 6. Set wrangler secrets (raw PATs — never stored in D1 as-is)
wrangler secret put GITHUB_TOKEN_1 --config wrangler.scan.toml
# ... repeat for GITHUB_TOKEN_2..7

# 7. Deploy scan worker first (web app service binding needs it)
npm run deploy:scan

# 8. Deploy web app
npm run deploy

# 9. Smoke-test
curl -X POST https://reposcout-web.<account>.workers.dev/api/trigger
```

### Remaining checklist

- [ ] `npm install` — pulls in `three@0.169.0` + `@types/three`
- [ ] Run `npm run db:migrate:remote` — push 5-table schema to D1
- [ ] Run `npm run compile-patterns` — regenerate `patterns.json` from real secretscout YAML templates (if `../secretscout/templates/` exists; otherwise the built-in stub covers 27 templates)
- [ ] Set `GITHUB_TOKEN_1..n` wrangler secrets on scan worker
- [ ] Edit `scripts/seed-repos.ts` REPOS[] — add the repos you want to monitor
- [ ] Run `npm run db:seed-repos:remote`
- [ ] Run `npm run db:seed-tokens:remote`
- [ ] `npm run deploy:scan` — deploy scan worker
- [ ] `npm run deploy` — build Next.js + deploy web app
- [ ] Verify cron fires at `:00` (check Worker logs in Cloudflare dashboard)
- [ ] Seed 1 test repo that has a dummy PAT in a branch — verify full pipeline hit end-to-end
- [ ] Optionally seed GRAYHATWARFARE / URLSCAN keys via `wrangler secret put` (not yet wired to scanner)
- [ ] Optionally set `PROTONVPN_USERNAME` / `PROTONVPN_PASSWORD` for stealth scanning

---

## Architecture Quick Reference

```
Cron (hourly)
  └── Scan Worker (reposcout-scan-worker)
        ├── pickNextToken()  — D1 rate-limit-aware round-robin
        ├── Fetch repo zipball → fflate stream decompress
        ├── scanSource()     — regex / literal / entropy matching
        └── Each match → LangGraph 5-node pipeline
              ├── Node 1: Context Gatherer
              ├── Node 2: Heuristic Filter       → FALSE_POSITIVE (skip)
              ├── Node 3: External API Validator  → TRUE_POSITIVE / FALSE_POSITIVE
              ├── Node 4: Workers AI LLM          → TRUE_POSITIVE / NEEDS_HUMAN_REVIEW
              └── Node 5: Risk Scorer             → write to D1

Next.js Dashboard (reposcout-web)
  ├── /            RepositoryRiskGrid (sorted by risk_score)
  ├── /repo/[id]   FindingsInspector
  ├── /review      AnalystQueue (NEEDS_HUMAN_REVIEW triage)
  ├── POST /api/trigger   → SCAN_WORKER service binding → scan worker
  └── POST /api/review    → markAnalystReviewed() in D1
```

## Cloudflare Resources

| Resource      | Binding       | ID                                      |
|---------------|---------------|-----------------------------------------|
| D1 Database   | `DB`          | `67fa825b-9f3e-478c-99d2-3e5cc1b0f3de` |
| KV Namespace  | `CACHE`       | `ed3c323de9cc48a4b332beec939597a4`      |
| Workers AI    | `AI`          | —                                       |
| Service       | `SCAN_WORKER` | reposcout-scan-worker                   |
| Account       | —             | `b1dea8ea21722d03763e3eff6ab8c5c1`      |
