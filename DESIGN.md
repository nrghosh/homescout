# HomeScout — MVP Design

## User Flow

1. Land on homepage → "Find your perfect home"
2. Pick city (SF only for MVP, dropdown disabled for others)
3. Set preferences via **priority buckets**:
   - User drags/assigns each preference into: **Must Have** / **Important** / **Nice to Have** / **Not Important**
   - Preferences: Neighborhood(s), Price range, Bedrooms, Bathrooms, Sqft, Property type (SFH/Condo/TIC), Parking, Walkability/Transit, Condition (move-in ready vs fixer)
4. Select neighborhoods (checklist grouped by area, with "popular" defaults)
5. Enter email → "Get your daily scan"
6. Daily email arrives with scored top 10 + changes + trends
7. Email links to a web dashboard with full history

## Priority Bucket → Score Weight Mapping

Backend converts user buckets to weights automatically:

| Bucket | Weight multiplier | Example |
|--------|------------------|---------|
| **Must Have** | 3x (and acts as hard filter) | "2+ bathrooms" = auto-disqualify if < 2 |
| **Important** | 2x | "Parking" = 10 pts instead of 5 |
| **Nice to Have** | 1x (default) | "Walkability" = 5 pts |
| **Not Important** | 0x (ignored in scoring) | "Condition" = 0 pts |

Base weights (at 1x):
- Neighborhood: 10
- Price: 10
- Property type: 7
- Size (sqft): 7
- Bedrooms: 5
- Bathrooms: 3
- Parking: 3
- Walkability: 3
- Condition: 3

Total at default (all Nice to Have): 51. Normalized to 0-100 scale.

"Must Have" items also act as **hard filters** — listings that fail a Must Have are auto-disqualified (score = 0).

## Tech Stack

### Frontend (Cloudflare Pages)
- Next.js or plain HTML/JS (keep it simple for MVP)
- Preference configuration UI
- Dashboard page (linked from email)
- No auth for MVP — email-based identification

### Backend (Cloudflare Workers)
- `POST /api/users` — create user with preferences
- `GET /api/dashboard/:userId` — return scored listings + history
- `POST /api/scan` — triggered by cron, runs the daily scan

### Database (Cloudflare D1)
Tables:
- `users` (id, email, city, preferences JSON, created_at)
- `listings` (id, address, price, beds, baths, sqft, neighborhood, type, url, features, red_flags, status, first_seen, last_checked, raw_data)
- `user_scores` (user_id, listing_id, score, breakdown JSON, created_at)
- `scan_log` (id, scan_date, new_count, removed_count, summary)

### Scraping (Cloudflare Browser Rendering)
- Cron trigger runs daily
- Workers spawn Browser Rendering sessions
- Scrape Redfin neighborhood pages (most structured data)
- Fallback to Zillow/Compass if Redfin blocks
- Parse listing cards: address, price, beds, baths, sqft, status, URL
- Deduplicate against existing listings in D1

### Scoring (Cloudflare Workers AI)
- Model: @cf/meta/llama-3.3-70b-instruct-fp8-fast (free on Workers AI)
- Input: listing data + user preferences + priority buckets
- Output: 0-100 score + natural language explanation
- Rule-based pre-filter first (hard filters from Must Have), then LLM for nuanced scoring + explanation

### Email (Resend)
- Daily batch after scan completes
- HTML email: top 10 table, daily changes, weekly trends, dashboard link
- Resend free tier: 100 emails/day (fine for MVP)

## File Structure

```
homescout/
├── README.md
├── DESIGN.md
├── wrangler.toml          # Cloudflare Workers config
├── package.json
├── src/
│   ├── worker/
│   │   ├── index.ts        # Main worker entry (routes + cron)
│   │   ├── scraper.ts      # Browser Rendering scraping logic
│   │   ├── scorer.ts       # Workers AI scoring
│   │   ├── email.ts        # Resend email formatting
│   │   └── db.ts           # D1 database helpers
│   └── frontend/
│       ├── index.html       # Landing page + preference setup
│       ├── dashboard.html   # User dashboard
│       ├── style.css
│       └── app.js           # Frontend logic
├── schema.sql              # D1 database schema
└── .dev.vars               # Local env vars (Resend key etc.)
```

## MVP Scope

### In
- Single city (San Francisco)
- Priority bucket preference UI
- Neighborhood checklist
- Daily cron scraping
- Workers AI scoring with explanations
- Email notifications
- Simple web dashboard
- Listing status tracking (active/pending/sold)

### Out (V2+)
- Map-based neighborhood selection
- Multiple cities
- Real-time alerts
- User accounts / auth
- Payment / tiers
- Agent/B2B features
- Mobile app
