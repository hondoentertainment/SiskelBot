# SiskelBot — Product Strategy (May 2026)

## Honest Assessment

The codebase contains ~254 mounted route modules, 507 test files, and a full
Stripe billing integration — but no confirmed paying users. The engineering
investment is substantial; what's missing is distribution and a clear ICP.

This document is the source of truth for strategic priorities for the next
30–60 days. It deliberately ignores features. Features are not the constraint.

---

## ICP (pick one, commit to it)

**Target: indie hackers and small dev teams (2–10 people) who:**
- Already use or are curious about Ollama / local models
- Have internal documents they want to query with AI
- Pay for ChatGPT Plus or Claude but are frustrated by data-privacy constraints

**Why this ICP over enterprises:** Enterprise sales cycles run 6–18 months.
This persona pays for tools, can self-serve the install, and gives honest
feedback fast. Enterprise comes after PMF is proven.

---

## What Is Actually Built (the real pitch)

SiskelBot is the only local AI tool that combines:

1. **Local model support** via Ollama/vLLM (data never leaves the machine)
2. **Desktop app** for Windows, macOS, and Linux
3. **Knowledge graph** — auto-extracts entities/relationships from uploaded docs
4. **Multi-agent swarm** — parallel specialist agents (researcher, executor, synthesizer)

No competitor has all four. Jan.ai has the desktop, not agents or RAG.
AnythingLLM has RAG, not swarm or desktop. OpenWebUI has a web UI, not a
knowledge graph or mature agents.

**This intersection is the moat. Market it that way.**

---

## 3–5 Highest-Leverage Moves

### 1. Kill 70% of the surface area

**Why:** 254 routes with stubs inflates the attack surface, confuses users who
explore the API, and makes the product impossible to describe in one sentence.
See `ROUTE_AUDIT.md` for the classification.

**Target:** 40–60 live routes. Everything else returns `501 Not Implemented`
or is removed from `routes/index.js` entirely.

**Time estimate:** 2–3 days. Do this before any distribution work.

---

### 2. Ship 10 paying users in 30 days

**Why:** Stripe is fully wired. Plans are defined ($0 / $29 / $99). The only
missing pieces are real Stripe price IDs and distribution. See
`STRIPE_READINESS.md` for the exact checklist.

**Actions:**
1. Set up real Stripe price IDs (1 hour)
2. Test the full checkout → webhook → plan-upgrade flow end to end
3. Post a "Show HN" or r/LocalLLaMA post with a 90-second screen-recording demo
4. Offer founding-member pricing: $19/mo locked vs. $29 after (first 20 users)
5. Reply to every comment personally — these are your first customer interviews

**Success signal:** 10 paying users = $190–290 MRR. Not meaningful revenue;
proof that strangers pay for this without a sales call.

---

### 3. Double down on the desktop app

**Why:** This is the rarest thing in the AI tooling space. A desktop app with
auto-update, signed binaries, and local model support.

**Actions:**
1. Add a GitHub Actions workflow that builds signed Electron binaries on every
   tag (Windows NSIS, macOS DMG, Linux AppImage)
2. Submit to Homebrew cask and WinGet
3. Make the desktop app the primary distribution artifact — not Docker

**Expected outcome:** Organic discovery from package managers. Desktop apps
retain users better than web apps for productivity tools.

---

### 4. Create one demo that spreads itself

**Why:** Nobody knows what swarm + knowledge graph looks like when both are
working. A wall of text doesn't convert.

**The demo:** Upload a document corpus (e.g. Paul Graham essays). Run a swarm
research query. Show specialists running in parallel. Show the knowledge graph
updating in real time. Record as a 90-second screen capture.

**Where to post:** X/Twitter, HN, r/LocalLLaMA, r/MachineLearning, Ollama and
LangChain Discord servers.

**Make the knowledge graph visualization screenshot-worthy.** It is a shareable
artifact.

---

### 5. Start customer development conversations now

**Why:** The next feature to build is in those conversations, not in a roadmap
doc. Without this, the next 60 days produces more features nobody asked for.

**Actions:**
1. Find 20 people matching the ICP (Ollama power users, devs using Claude/GPT
   for internal docs)
2. Offer 3 months free in exchange for a 30-minute call
3. Do NOT pitch — ask "Walk me through how you use AI tools today"
4. Listen for the repeating pain that SiskelBot already solves

---

## What to STOP Doing Immediately

| Stop | Why |
|---|---|
| Adding new route modules | 254 is 5 years of surface area. Not the constraint. |
| Enterprise infrastructure features | SAML, multi-region HA, post-quantum crypto — zero users need these now |
| XR, VR, blockchain, decentralized storage, NFT gating | Credibility cost + maintenance burden with zero upside |
| LoRA fine-tuning, federated training, differential privacy | Research features; no path to ICP revenue |
| Writing more documentation | 82 docs files already. Write docs for features users actually use. |
| Adding integrations | Slack, Discord, GitHub, Jira, Linear, Vercel is already enough |

---

## What You're Likely Overthinking

- **Multi-region HA:** No early SaaS needs this. Fly.io handles it until
  1,000 paying customers.
- **The plugin marketplace:** Marketplaces need two sides. Get one side first.
- **507 tests as quality signal:** Tests verify code, not whether anyone wants
  the product.
- **OpenAPI spec completeness:** Nobody is integrating with the API yet.
- **Enterprise pricing precision:** The $99 enterprise plan is too cheap for
  real enterprise. Fix it after you have enterprise customers asking.

---

## Biggest Risk

**Running out of energy before distribution starts.**

Building is comfortable. Selling is not. The XR interface and post-quantum
crypto were interesting to build. Getting on a call with a stranger who might
say "this isn't for me" is not. That discomfort is where PMF lives.

If no distribution work happens in the next 14 days, this stays a showcase
project.

---

## 7-Day Execution Plan

| Day | Task |
|---|---|
| 1 | Write one sentence ICP statement. Paste it at the top of the README. Route every decision through it for the next 30 days. |
| 2 | Complete the route audit (see `ROUTE_AUDIT.md`). Mark CORE / SUPPORTING / DEFER / DELETE. |
| 3 | Complete Stripe live-mode setup (see `STRIPE_READINESS.md`). Test checkout flow end to end. |
| 4 | Set up Electron release pipeline on GitHub Actions. Get a signed binary building. |
| 5 | Record 90-second swarm + knowledge graph demo. Real > polished. |
| 6 | Post to HN + r/LocalLLaMA + 3 Discord servers. Respond to every reply same day. |
| 7 | DM 10 people who engaged. Offer free access in exchange for a 30-minute call. Schedule them. |

---

## 30-Day Roadmap (Impact Only)

**Week 1 — Distribution foundations**
- Route cleanup (remove stubs)
- Stripe live mode
- Desktop binary release pipeline
- Demo video + first posts

**Week 2 — First paying users**
- Incorporate friction feedback from the first 5 customer calls (not new
  features — UX clarity and onboarding fixes only)
- Activate Stripe live mode with founding-member offer

**Week 3 — Nail onboarding**
- Map the current flow: download → first swarm result
- Remove every step that isn't essential
- Target: time-to-value under 5 minutes

**Week 4 — Iterate on signal**
- If 10 paying users: ask each one what they'd pay more for. Build that one thing.
- If fewer than 10: something is wrong with the demo, price, or ICP. Diagnose
  before writing any code.

---

## Growth Loop

**Trigger:** User uploads their own documents

1. User uploads docs → knowledge graph auto-generates
2. Swarm query returns a result the user couldn't get any other way
3. User screenshots or shares the knowledge graph visualization
4. New user asks "what tool made that?"
5. New user installs → uploads their docs → loop repeats

**What makes it work:** The knowledge graph is a shareable visual artifact.
Make it beautiful and trivially easy to export as an image.

---

## Monetization Test (run in Week 2)

**SiskelBot Desktop Pro — $29/month or $249/year**

Includes:
- Unlimited local models (Ollama)
- Knowledge graph + semantic search
- Swarm orchestration (up to 5 specialists)
- Desktop app with auto-updates

**Why $29:** Below the $50 psychological barrier. Above "toy" territory.
Comparable to Raycast, CleanMyMac, Linear — tools this audience already pays for.

**Success signal:** 10 paying users in 30 days without a sales call.

---

## Unfair Advantage

**"Your data never leaves your machine."**

This is not a footnote. Make it the headline. Privacy-conscious developers and
small teams will pay specifically to avoid sending data to OpenAI. SiskelBot is
the only tool in this space that combines local inference, a desktop app, RAG,
and agent orchestration. Lead with privacy. Lead with local. Lead with the
intersection nobody else occupies.

---

## Pricing Sanity Check (current `lib/plans.js`)

| Plan | Price | Token limit | Assessment |
|---|---|---|---|
| Free | $0 | 100K/month | Good onramp |
| Pro | $29/month | 1M/month | Correct price point |
| Enterprise | $99/month | Unlimited | **Too cheap.** Real enterprise is $500–2,000+/month. Fix when enterprise customers ask. |
