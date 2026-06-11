# RepoScout — Implementation Roadmap

> Continuous GitHub secret scanning platform built on Cloudflare free tier.
> SecretScout pattern engine + LangGraph AI verification + ArxivExplorer terminal-green dashboard.

---

## Phase 1 — Engine & Database `Week 1`

- [ ] Run D1 migration — `wrangler d1 execute reposcout --file=migrations/schema.sql`
- [ ] Seed `scan_tokens` with 7 GitHub PATs from `secretscout/.env` (hashed + masked)
- [ ] Build YAML → JSON pattern compiler — `scripts/compile-patterns.ts` walks `secretscout/templates/**/*.yaml`, emits `src/scan-worker/patterns.json`
- [ ] Implement zipball streaming scanner — `src/scan-worker/scanner.ts` with fflate `Unzip`, `SKIP_EXTENSIONS`, `SKIP_DIRS`, 1000-char line cap
- [ ] Port SecretScout types to TypeScript — `src/lib/types.ts` (`Template`, `Pattern`, `PatternKind`, `Match`, `Severity`, `ScanResult`) from `secretscout-types/src/lib.rs`
- [ ] Port SecretScout scanner logic — `src/lib/scanner.ts` (regex / literal / entropy matching, suppression, dedup, cascade) from `secretscout-core/src/scanner.rs`
- [ ] Port validator to TypeScript — `src/lib/validator.ts` (30+ providers: GitHub, Stripe, Slack, Anthropic, AWS…) from `secretscout-core/src/validator.rs`
- [ ] Port `mask_secret` utility — `src/lib/masking.ts` (prefix/suffix reveal with `***` middle) from `secretscout-core/src/utils/masking.rs`
- [ ] Port entropy module — `src/lib/entropy.ts` (Shannon entropy, charset detection, thresholds) from `secretscout-core/src/entropy.rs`
- [ ] Unit-test scanner against fixture files — verify regex hits, entropy thresholds, suppression

---

## Phase 2 — LangGraph AI Pipeline `Week 2`

- [ ] Upgrade `pipeline.ts` to spec — replace `SUSPICIOUS` with `NEEDS_HUMAN_REVIEW`; wire conditional edges per spec §4 graph wiring
- [ ] Implement Node 1 — context gatherer: normalise matched text, annotate file extension + variable name from surrounding lines
- [ ] Implement Node 2 — heuristic filter: `PLACEHOLDER_TERMS` list + low-entropy hex check; short-circuit to `FALSE_POSITIVE`
- [ ] Implement Node 3 — external API validator: GitHub PAT, Slack webhook, Stripe, AWS STS SigV4; route `UNVERIFIABLE` → Node 4
- [ ] Implement Node 4 — Workers AI LLM classifier: `@cf/meta/llama-3.1-8b-instruct`; chain-of-thought JSON prompt; confidence < 0.65 → `NEEDS_HUMAN_REVIEW`
- [ ] Implement Node 5 — risk scorer: `SEVERITY_WEIGHT × VERDICT_MULTIPLIER`; update repo `risk_score` in D1
- [ ] Add KV daily neuron quota guard — mirror ArxivExplorer `llm_quota:{date}` pattern; cap at 263 calls/day; fallback to `NEEDS_HUMAN_REVIEW`
- [ ] Wire pipeline into scan worker handlers — plug `createScanValidationGraph` into `fetch` + `scheduled` in `src/scan-worker/index.ts`
- [ ] Tune Llama prompt — iterate until valid JSON rate ≥ 95% across ≥ 50 test samples; log failures to KV

---

## Phase 3 — Dashboard `Week 3`

- [x] Copy `globals.css` from ArxivExplorer — terminal-green palette, `bg-grid`, glow classes, `card-scanlines`, `stagger-list`, shimmer; adapted for red/amber severity colours
- [ ] Copy `tailwind.config.ts` tokens — `neon-green`, `dark-bg`, `font-mono`, `glow-pulse`, `dot-ping`, `count-slide`, `border-beam` animations
- [ ] Copy `ParticleBackground.tsx` — Three.js particle rain; dual neon-green + neon-blue streams
- [ ] Copy `DecryptedText.tsx` + hooks — `TextScrambler`, `useTextScramble`, `textAnimation.ts`; used for repo names + risk scores on load
- [ ] Copy `ScrollProgress.tsx` — fixed top scan-line progress bar with neon-green glow
- [ ] Build `app/layout.tsx` — JetBrains Mono font, `bg-grid`, radial neon glow, dark mode; ported from ArxivExplorer layout
- [ ] Build hero strip — live counters: total repos, critical findings, analyst queue count, next scan HH:MM:SS countdown
- [ ] Build `RepositoryRiskGrid` — cards sorted by `risk_score` desc; colour-coded risk meter; `TRUE_POSITIVE` / `NEEDS_HUMAN_REVIEW` badges
- [ ] Build `FindingsInspector` panel — file path + GitHub blob link; masked value; code snippet with highlighted match line; AI verdict + reasoning
- [ ] Build `AnalystQueue` — `/review` page listing all `NEEDS_HUMAN_REVIEW` sorted by severity; one-click triage; updates `analyst_reviewed = 1` in D1
- [ ] Add `/api/trigger` route — manual scan trigger for dev; returns `scan_run` id + status

---

## Phase 4 — Deploy & Validate `Week 4`

- [ ] Deploy scan worker — `wrangler deploy --config wrangler.scan.toml`; verify cron fires at `:00`
- [ ] Deploy web app — `npm run pages:build && wrangler deploy --config wrangler.jsonc`; verify D1 + KV bindings resolve
- [ ] Seed 3 test repositories — add one with a dummy PAT in a test branch; verify full pipeline hit
- [ ] Verify end-to-end flow — pattern match → LangGraph → D1 → dashboard verdict display; check masked token rendering
- [ ] Load-test token pool — simulate rate-limit exhaustion on all 7 tokens; verify fallback + queue behaviour
- [ ] Seed GRAYHATWARFARE + URLSCAN keys — copy 18 GHW keys + 12 urlscan keys from `secretscout/.env` into D1 or `wrangler secret put`
- [ ] Add PROTONVPN credentials — `wrangler secret put PROTONVPN_USERNAME` / `PROTONVPN_PASSWORD` for stealth scanning

---

## Architecture Quick Reference

```
Cron (hourly)
  └── Scan Worker
        ├── Pick GitHub PAT (round-robin, rate-limit-aware)
        ├── Fetch repo zipball → fflate stream decompress
        ├── Line-by-line regex/entropy match (SecretScout patterns)
        └── Each match → LangGraph 5-node pipeline
              ├── Node 1: Context Gatherer
              ├── Node 2: Heuristic Filter       → FALSE_POSITIVE (skip)
              ├── Node 3: External API Validator  → TRUE_POSITIVE / FALSE_POSITIVE
              ├── Node 4: Workers AI LLM          → TRUE_POSITIVE / NEEDS_HUMAN_REVIEW
              └── Node 5: Risk Scorer             → write to D1

Next.js Dashboard
  ├── /            RepositoryRiskGrid (sorted by risk_score)
  ├── /repo/[id]   FindingsInspector
  └── /review      AnalystQueue (NEEDS_HUMAN_REVIEW triage)
```

## Verdict Logic

| Verdict | Meaning | Multiplier |
|---|---|---|
| `TRUE_POSITIVE` | Confirmed live credential | 2.0 |
| `NEEDS_HUMAN_REVIEW` | Ambiguous — analyst queue | 1.0 |
| `FALSE_POSITIVE` | Placeholder / revoked | 0.0 |

## Severity Weights

| Severity | Weight |
|---|---|
| `critical` | 100 |
| `high` | 40 |
| `medium` | 15 |
| `low` | 5 |
| `info` | 1 |

`risk_score = Σ (severity_weight × verdict_multiplier)` across all findings for a repo.

## Key Files

| File | Purpose |
|---|---|
| `src/scan-worker/index.ts` | Worker entry — `fetch` + `scheduled` handlers |
| `src/scan-worker/scanner.ts` | Zipball streaming + pattern matching |
| `src/scan-worker/pipeline.ts` | LangGraph 5-node AI verification |
| `src/scan-worker/patterns.json` | Compiled SecretScout templates (build artifact) |
| `src/lib/types.ts` | Shared types (Template, Match, Severity…) |
| `src/lib/validator.ts` | External API credential checks |
| `src/lib/entropy.ts` | Shannon entropy + charset detection |
| `src/lib/masking.ts` | Secret masking utility |
| `scripts/compile-patterns.ts` | YAML → JSON pattern compiler |
| `migrations/schema.sql` | D1 schema (5 tables) |
| `app/components/ParticleBackground.tsx` | Three.js particle rain |
| `app/components/DecryptedText.tsx` | Scramble animation for repo names |

## Cloudflare Resources

| Resource | Binding | ID |
|---|---|---|
| D1 Database | `DB` | `67fa825b-9f3e-478c-99d2-3e5cc1b0f3de` |
| KV Namespace | `CACHE` | `ed3c323de9cc48a4b332beec939597a4` |
| Workers AI | `AI` | — |
| Account | — | `b1dea8ea21722d03763e3eff6ab8c5c1` |
