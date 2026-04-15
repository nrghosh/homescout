# HomeScout — Product Requirements Document

**Version:** v0.1 (draft)
**Status:** Pre-MVP → MVP transition
**Owner:** Nikhil
**Last updated:** 2026-04-15

---

## 1. Problem

Buying a home in a hot market (SF, NYC, LA, Boston) is broken:
- **Zillow/Redfin alerts are dumb filters** — they email whenever anything matches, regardless of fit. Most notifications are noise.
- **No product explains why a listing is good for you specifically.** Users must mentally re-rank every email against their own preferences.
- **Listings go stale quickly.** Pending/sold listings pollute saved searches for days.
- **Market intelligence is fragmented.** Days-on-market, price history, and negotiation signals exist but aren't synthesized.

Buyers end up with bloated email inboxes, open-tab chaos, and mental overhead that doesn't translate to better decisions.

## 2. Target Users

### Primary (MVP)
**Active SF homebuyers** — have a target neighborhood, budget, and bed/bath minimums. Actively touring homes. Checking Zillow/Redfin daily. Value time more than money at the $20-50/mo tier.

Typical profile:
- Ages 30-45, dual-income household
- Budget $1M-$3M (median SF SFH range)
- Has been searching 1-6 months
- Works with an agent or plans to

### Secondary (V1+)
**Relocation buyers** researching a new city remotely
**Investors** (mostly Bay Area) scanning for under-priced properties

### Non-targets (for now)
**Renters** — different problem, higher volume, lower willingness to pay
**Agents/brokers** — B2B sale is a different GTM motion

## 3. Value Proposition

**"Your personal home scout — it reads every listing in SF daily, scores them against what you actually care about, and sends you only the ones worth looking at, with the reasoning."**

Three core differentiators:

1. **Opinionated scoring with YOUR weights.** Not filters — weighted priorities with explanations. "This home is an 87 for you because you said parking is Must Have and this has a 2-car garage."

2. **Verified freshness.** Every morning we re-verify every listing. Sold/pending drop off immediately.

3. **Negotiation intelligence.** DOM tracking, price drop history, neighborhood velocity trends. "This home has been listed 48 days with 2 price cuts — strong negotiation position."

## 4. MVP Scope (current state)

### ✅ Built (end of April 14)
- **Frontend**: 4-step wizard (Basics → Neighborhoods → Priorities → Preview), polished design with Inter/Fraunces
- **Priority buckets**: Must Have / Important / Nice to Have / Not Important
- **Rule-based scoring**: 0-100 weighted score with hard filters
- **LLM explanations**: Llama 3.3 70B on Workers AI, post-processed, 2-sentence max
- **Preview with locked teaser**: top 3 locked, 4-6 visible, unlocks on email signup
- **Multi-source enrichment**: Redfin/Compass/Coldwell/Realtor/Zillow with priority + reliability
- **Daily cron + on-demand verification**: Hybrid HTTP-then-BR scraping, stale listings marked likely_sold after 2 misses
- **Security**: input validation, disposable email blocking, rate limiting, CSP/HSTS
- **Caching**: preview cache (1hr), explanation cache (7 days), edge cache on verify fetches
- **Notion sync + email**: via existing `/scan-houses` skill infrastructure

### 🚧 Known gaps
- Only SF. No multi-city support.
- No user auth (email-based ID only).
- No dashboard history view (current/historical only — no trends chart).
- Status reconciliation tested manually, not yet validated at scale.
- No billing, no tiering, no unsubscribe.
- No observability beyond `scan_log`.
- 62 listings have null price/baths even after enrichment — data completeness gap.

## 5. V1 Roadmap

### Core UX
- [ ] User can unsubscribe / pause alerts
- [ ] Dashboard shows historical scoring (how did THIS listing score over time?)
- [ ] Neighborhood velocity charts (avg DOM, avg sold-over-ask, inventory)
- [ ] Compare 2-3 listings side-by-side
- [ ] Listing detail page with full history (price changes, status changes, open houses)

### Data
- [ ] Multi-city: add Oakland, Berkeley, Palo Alto, Alameda in parallel
- [ ] Enrichment fallback to Zillow when Redfin detail lacks data
- [ ] Surface source attribution in UI ("Price confirmed via Redfin + Coldwell Banker")
- [ ] Walk Score / Transit Score API integration (currently a stub)

### Engineering
- [ ] Feature flag system (D1 flags + environment overrides)
- [ ] Observability: error tracking, scan success rate, enrichment completion rate
- [ ] Retry/queue for failed scrapes
- [ ] Image extraction (property photos) for richer emails

## 6. V2 Ideas (post product-market fit)

- Cross-city markets (LA, Seattle, NYC, Boston)
- Agent B2B tier (client-facing reports, $99/mo/seat)
- Mortgage pre-qual partnership (revenue share)
- AI assistant inline ("Is this a good deal?" → full analysis)
- Commute-time scoring with Google Maps API
- School quality weighting
- Mobile apps (iOS/Android)

## 7. Success Metrics

### Leading (weekly cadence)
- Signups per week
- % who complete the 4-step wizard (funnel conversion)
- % who click a listing link in email
- Avg session duration on dashboard
- Enrichment completion rate (% listings with price + baths)
- Preview cache hit rate

### Lagging (monthly)
- Weekly active users (opened email or visited dashboard)
- Retention (% still active after 4 weeks)
- Listing-to-pending conversion (did any of our top 5 go pending this week?)
- NPS / survey: "Would you recommend HomeScout?"

### North-star
**Homes toured** — a user tells us they toured a home they learned about from us. This is the real value moment.

## 8. Technical Architecture (current)

```
Cloudflare Workers (Hono app)
├── Frontend: static HTML/CSS/JS served via Assets binding
├── API:
│   ├── POST /api/preview      — unauth, rule-scored, cached 1h
│   ├── POST /api/users         — create/update with validation
│   ├── POST /api/enrich        — batch fill missing fields
│   ├── POST /api/scan          — manual cron trigger
│   ├── GET  /api/dashboard/:id — user's scored top 10
│   └── GET  /api/debug/*       — diagnostics
├── Cron: 15 UTC daily (8am PT)
│   1. Scrape 12 neighborhoods → D1 listings
│   2. Reconcile (status for listings missing from scrape)
│   3. Enrich (fill missing price/baths from multi-source registry)
│   4. Score all active listings per user
│   5. LLM explanations for top 10 per user
│   6. Resend daily email
└── Bindings:
    ├── D1 (SQLite) — users, listings, scores, caches, attribution
    ├── Workers AI — Llama 3.3 70B for explanations
    ├── Browser — Browser Rendering (fallback when HTTP blocked)
    └── ASSETS — static file serving

External:
└── Resend (email, 100/day free tier)
```

### Data Model

Tables in D1:
- `users` (id, email, city, preferences JSON, active, timestamps)
- `listings` (id, city, address, price, beds, baths, sqft, status, url, features, timestamps)
- `price_history` (listing_id, price, recorded_at)
- `user_scores` (user_id, listing_id, score, breakdown, explanation)
- `scan_log` (scan_date, new_listings, removed_listings, summary)
- `explanation_cache` (listing_id + priority_hash → explanation, 7d TTL)
- `preview_cache` (pref_hash → response, 1h TTL)
- `source_attribution` (listing_id + field → source, value, confidence, fetched_at)

## 9. Unit Economics (at current architecture)

**Cost per active user per month** (based on research + observed scan performance):

| Component | Cost | Notes |
|-----------|------|-------|
| LLM (Workers AI Llama 3.3) | ~$0.10-0.20 | 10 LLM calls/user/day after caching |
| Email (Resend) | $0.02 | Daily at 100/day = free tier |
| D1 database | ~$0 | Free tier covers 1K users |
| Workers compute | ~$0 | Free tier (100K req/day) |
| Browser Rendering | ~$0-0.05 | Only when HTTP fails |
| **Total at scale** | **~$0.20-0.30/user/mo** | |

**Break-even pricing:**
- Free tier: sustainable via ad-free, pure acquisition
- $5/mo Pro: 25x margin
- $10/mo Plus (unlimited cities, real-time alerts): 50x margin
- Agent B2B at $50/mo/seat: 250x margin

**At 10K users:** $2-3K/mo COGS. Gross margin at $5/mo pricing: 96%.

## 10. Pricing & GTM Hypothesis (to debate)

### Pricing tiers (draft)
| Tier | Price | Features |
|------|-------|----------|
| **Free** | $0 | 1 city, daily email, top 10, 30-day history |
| **Pro** | $9/mo | Unlimited cities, real-time alerts, full history, priority bucket customization |
| **Plus** | $19/mo | Multiple saved searches, share with partner, CSV/Notion export, concierge questions |
| **Agent** | $49/mo | Client-facing reports, multi-client dashboard, market reports |

### GTM channels (to prioritize)
- Organic: SEO for "best home search tools in SF", "Zillow alternatives"
- Reddit r/SanFrancisco, r/bayarea, r/homeowners
- Twitter/X real estate + startup communities
- Referral: $5 credit per signup
- Partnerships: buyer-agent white-label deals

## 11. Key Open Questions (→ debate agents)

### Engineering
- Do we keep hybrid scraping or invest in broker-MLS partnership ($$ but reliable)?
- Is LLM-generated explanation worth the cost/latency, or switch to templated?
- Should on-demand enrichment run in preview (latency hit) or background only?

### Product
- Is the 4-step wizard too long? Drop steps? Progressive onboarding?
- Preview showing locked top 3 — genius UX or dark pattern?
- Should we push mobile-first or desktop-first for V1?

### GTM
- Freemium or time-gated trial? SaaS conventional wisdom vs. trust-building in RE
- Consumer-first or agent-first GTM motion?
- Is SF the right beachhead or should we go for commuter suburbs where competition is weaker?

### Economics
- What's the realistic ceiling on consumer willingness to pay? ($0? $10? $30?)
- Can referral revenue (mortgage, agents) subsidize the consumer tier entirely?
- Does a $50 agent tier cannibalize the consumer tier or complement it?

## 12. Risks

1. **MLS data access** — without broker partnership, scraping can be throttled/blocked. We have on-demand verification as mitigation but it's fragile at scale.
2. **Zillow/Redfin add scoring features** — they have 100x our resources. Our only moat is speed + opinionation + personalized explanations.
3. **Consumer pays for search = zero base rate.** Zillow is free. Must prove value before paywalls.
4. **Trust** — real estate is high-stakes. Stale listings or wrong scores = churn + bad reviews.
5. **Localize.city cautionary tale** — raised $70M, shut down SF ops in 2024 citing macro. Consumer proptech is graveyard-adjacent.

## 13. Success Criteria for "Graduate to V1"

Before investing in V1 features, we need:
- ≥ 50 weekly active users (sustained for 4 weeks)
- ≥ 30% email open rate
- ≥ 5 qualitative signals: users reply saying "I toured this home because of your email"
- Enrichment completion rate ≥ 80% (currently ~45%)
- Top 10 precision ≥ 70% (top 10 matches really are top matches — manual audit)

---

*This is a living doc. Update after each major shipping milestone.*
