# HomeScout Action Plan — Post-Debate Synthesis

**Derived from:** PRD v0.1 + 4 parallel agent debates (engineering, product, GTM, economics)
**Last updated:** 2026-04-15

---

## Consensus across agents

All four agents independently converged on these themes:

1. **Don't rewrite — instrument and iterate.** Current architecture is correct for pre-scale. The next 6 months are about data quality, retention signals, and funnel optimization — not rebuilds.
2. **Retention > ARPU at this stage.** Real estate is episodic; users who churn before they transact are the core business risk.
3. **Status-change tracking is the retention engine.** Price cuts, withdrawals, newly-sold — this is the content Zillow can't easily replicate with personalization.
4. **Time-to-value must be <7 days** or subscription doesn't work for this vertical.
5. **COGS reality check: $0.75/user/mo is the realistic target**, not $0.30. Plan accordingly.
6. **Affiliate is the real monetization engine at scale**, but subscription is Y1 survival.

## Cross-agent disagreements resolved

| Topic | Engineering | Product | GTM | Economics | Consensus |
|-------|------------|---------|-----|-----------|-----------|
| Scraping | Hybrid + start MLS talks | — | — | Capped by tier | **Hybrid now, MLS conversations begin this week** |
| LLM vs template | Llama + template fallback | Gate explanations | — | Cap LLM/tier | **Llama with template fallback, instrument A/B per user** |
| Wizard length | — | Compress to 3 steps | <5 min onboarding | — | **3 steps + smart defaults button** |
| Locked top 3 | — | Soften (unblur addresses) | Build trust | — | **Unblur addresses, gate explanations + daily email** |
| Email cadence | — | Weekly default, daily toggle | — | — | **Weekly default, daily toggle, ≥95 instant alerts opt-in** |
| Pricing | — | — | Freemium | $9 Pro + $19 Plus | **Free + $9 Pro + $19 Plus at launch** |
| Beachhead | — | — | SF tech wedge | — | **SF tech buyers, 3 neighborhoods, $1-2M** |
| Positioning | — | — | "AI copilot" externally | — | **"AI home search assistant that saves your Saturdays"** |

---

## P0 — Ship this week (feature flags + funnel + trust)

These are the 6 highest-ROI items across all four debates. Each is a small, git-checkpointable change.

### P0.1: Feature flag infrastructure
**Why:** Prerequisite for safely shipping the rest. All experimental changes must be flaggable.
**Scope:** D1 `feature_flags` table + helper + env var override. Per-user hashing for A/B.
**Effort:** 2hrs
**Flag:** N/A (this IS the flag system)
**Owner concern:** All agents want safe rollouts.

### P0.2: `listing_source_snapshots` append-only log
**Why:** Engineering agent's "cheapest insurance policy" — unblocks every future data quality debate.
**Scope:** Add table + write snapshot on every scrape, no merge logic.
**Effort:** 1hr
**Flag:** `LOG_SOURCE_SNAPSHOTS=on`

### P0.3: Compress wizard to 3 steps + smart defaults
**Why:** Product agent says biggest funnel fix. Merge Basics + Neighborhoods. Add "Use smart defaults" toggle on Priorities.
**Scope:** Single-page merge, defaults button, progress bar updates.
**Effort:** 6-8hrs
**Flag:** `WIZARD_STEPS=3` (default) vs. `WIZARD_STEPS=4`
**Success:** ≥55% wizard completion rate.

### P0.4: Soften the lock — gate explanations, not addresses
**Why:** Product agent calls this trust win with minimal downside. Real estate is high-trust.
**Scope:** Show all 10 addresses + scores + neighborhoods. Lock explanations + daily email upgrades.
**Effort:** 3-4hrs
**Flag:** `LOCK_MODE=soft` (default) vs. `LOCK_MODE=hard`
**Success:** Email capture ≥40%, first-7d unsubscribe ≤8%.

### P0.5: Data freshness label ("Updated X min ago")
**Why:** Engineering agent says turn staleness from bug into transparency feature.
**Scope:** Return `last_checked` relative time in API; render on each listing card.
**Effort:** 2hrs
**Flag:** `SHOW_FRESHNESS_LABELS=on`

### P0.6: Status-change hero section in daily email
**Why:** Product agent's single biggest retention lever. Elevate "price cuts, withdrawals, sold" above "new listings" in email template.
**Scope:** Reorder email sections; detect changes from last scan; add visual hierarchy.
**Effort:** 4-5hrs
**Flag:** `EMAIL_CHANGES_FIRST=on`
**Success:** ≥35% of daily-email users click a status-change card.

**P0 total effort:** ~18-22 hours. Each shippable independently with flags.

---

## P1 — Next 2 weeks (core UX + first monetization groundwork)

### P1.1: Hybrid enrichment with CF Queue + freshness tracking
**Why:** Engineering agent's "real UX bug worth fixing now." 10s cold preview is a funnel killer.
**Scope:** Cache-first preview; async enrich via CF Queue; top-10/neighborhood refresh every 2h.
**Effort:** 12-16hrs
**Flag:** `ENRICHMENT_MODE=sync|async|hybrid`

### P1.2: Weekly default email + daily toggle + instant alerts
**Why:** Product agent: cadence matches intent. Prevents "quiet Monday" unsubscribes.
**Scope:** Preference field, weekly digest template, instant alert worker for ≥95 scores in preferred neighborhoods.
**Effort:** 10-12hrs
**Flag:** `DEFAULT_CADENCE=weekly|daily`

### P1.3: Mobile-first 2-3 listing compare view
**Why:** Product agent: turns scores into decisions. Table stakes vs. Redfin.
**Scope:** Vertical stack, sticky headers, up to 3 listings, score breakdown rows.
**Effort:** 14-18hrs
**Flag:** `COMPARE_VIEW=on`

### P1.4: 3 canned AI prompts per listing ("Is this priced right?" etc.)
**Why:** Product agent: moat without unbounded cost. Deterministic + cacheable.
**Scope:** 3 prompt templates, Workers AI integration, 24h cache, per-user rate limit.
**Effort:** 16-20hrs
**Flag:** `AI_CANNED_PROMPTS=on`

### P1.5: Scraper health + LLM A/B instrumentation
**Why:** Engineering agent: "stop guessing, start measuring."
**Scope:** `scraper_health` table (per-source 7d success rate + alert), `EXPLANATION_BACKEND` flag per-user hash.
**Effort:** 6hrs
**Flag:** N/A (instrumentation is always on)

### P1.6: Initiate SFAR MLS sponsorship conversation
**Why:** Engineering agent: 60-90 day lead time. Not code — calendar.
**Scope:** Outreach email, contact 3 brokers, get SFAR paperwork requirements.
**Effort:** 2hrs ops
**Flag:** N/A

**P1 total effort:** ~60-74 hours of eng + ~2 hrs ops.

---

## P2 — Month 1-3 (monetization + scale)

### P2.1: Rocket Mortgage / Better affiliate integration
**Why:** Economics agent: real monetization engine at scale. RESPA-clean.
**Scope:** Opt-in post-scoring flow ("Want us to intro you to a lender?"), partner API, conversion tracking.
**Effort:** 1 week

### P2.2: Share-with-agent feature
**Why:** GTM agent: build the referral lane early, agent tier later.
**Scope:** "Share my shortlist" button → public link with read-only view, agent CTA.
**Effort:** 1 week

### P2.3: Multi-city expansion — Peninsula first
**Why:** GTM agent's "expand to Peninsula or Agent tier?" decision.
**Scope:** Add Palo Alto, Mountain View, Redwood City to neighborhoods config, test scrapers.
**Effort:** 1 week

### P2.4: Dashboard history + trends charts
**Why:** Product agent: roadmap item for retention.
**Scope:** 30/60/90-day score trends per listing, neighborhood velocity charts.
**Effort:** 2 weeks

### P2.5: Pro/Plus tier with Stripe + $19 Plus launch
**Why:** Economics agent: test willingness-to-pay at scale.
**Scope:** Stripe subscriptions, entitlement checks, paywall UI for tier-gated features.
**Effort:** 1-2 weeks

---

## Explicitly deferred (don't build now)

- **Free-form AI chat.** Canned prompts first; free-form only if canned prompts show strong usage.
- **Mobile apps.** Responsive web covers MVP.
- **Agent B2B tier.** Phase 2 after consumer ships 30-day retention.
- **Multi-state expansion.** Stay focused on Bay Area signal quality.
- **Property photo pipeline.** Nice-to-have, not retention driver.
- **Rebuild on MLS API.** Only after broker sponsorship lands AND hybrid shows strain.

---

## Success criteria to "graduate" each phase

### P0 → P1 gate
- Deployment successful, 0 regressions
- Wizard completion ≥55%
- Email capture ≥40%
- Source snapshot log collecting data

### P1 → P2 gate
- 50+ weekly active users sustained for 4 weeks
- ≥30% email open rate
- ≥5 qualitative "I toured this home because of your email" replies
- Enrichment completion ≥80%
- Top-10 precision ≥70% (manual audit)

### P2 → Post-PMF
- 500+ paid users OR $10K MRR
- <5% monthly paid churn
- Demonstrated affiliate revenue path

---

## Unit economics plan

- Budget COGS at **$0.75/user/month** (not $0.30) — covers realistic LLM scale-up
- Cap LLM usage per tier: Free 20 queries/mo, Pro 100, Plus soft-throttle at 500
- Target **2% free→paid conversion** as realistic base case
- Treat affiliate revenue as upside, not plan, for Year 1
- Break-even at 10K users × $0.75 COGS = $7,500/mo; requires 833 paid at $9 (8.3% conversion) OR 394 Plus at $19 (3.9% conversion) OR affiliate revenue

---

## Commit/branching discipline

- Each P0 item = own branch `feat/p0-<short-name>`, squash-merged to main with passing build
- Feature flag must be on `main` before UI code that depends on it
- `schema.sql` changes = dedicated migration commit
- Every schema migration adds a new table or column — never modify existing columns in place
- Tag `v0.1.0` after all P0 items ship
- Tag `v0.2.0` after all P1 items ship

---

## Open items for future debate

- **Billing:** Stripe direct vs. Lemon Squeezy vs. Paddle — decide before P2.5
- **Observability:** Log drain to Axiom vs. self-serve D1 queries — decide before P1.5
- **Authentication:** Stay email-only vs. add passwordless magic links — decide when >1 device matters
- **Address canonicalization:** We match by lowercased string. Need formal normalization if dedup fails.

---

*This plan is live. Update after each P0/P1/P2 item ships, or when new data contradicts assumptions.*
