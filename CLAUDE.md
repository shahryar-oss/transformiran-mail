# Transform Iran — Delta Mail — Project Memory

Live at **https://mail.transformiran.info** (Render, *pending DNS*). Repo: `shahryar-oss/transformiran-mail`.
Owner: Shahryar Tooraji (`shahryar@transformiran.com`).

## What this is

An executive-assistant email tool for Transform Iran staff, replacing **Shortwave** (€100/user/month → too expensive). Outlook-style three-pane inbox + Delta AI as a floating button in the bottom-right corner. Built to **know each user, know each contact, learn each person's tone over time**.

This is a **sibling project** to the Transform Iran Financial Dashboard at `~/Desktop/Account report/dashboard-app/` (deployed at `transformiran.info`). They share the **Transform Iran brand + Delta name + Delta UI component + magic-link auth pattern**. **They share NOTHING else.** Different DB, different repo, different Render service, different system prompt, different tools, different mission. See "Project hygiene" below.

## V1 scope (Phase 0 → Phase 5)

| Phase | Scope |
|---|---|
| **0 (now)** | Empty shell deployed. Outlook-style layout. Delta FAB in corner. No backend wiring. |
| **1** | Magic-link login. Google OAuth (Gmail readonly+modify+send + Calendar). Display recent Gmail messages in the inbox list. |
| **2** | Backfill 3-4 years of mail history. Build per-contact profiles. Drafting workflow (instruct → AI draft → user edits → user sends). |
| **3** | Morning briefing. Task extraction. Reply tracking. Priority inbox. |
| **4** | Multilingual translate (Farsi/Armenian/English/Dutch). Travel mode. Calendar integration. |
| **5** | Multi-user (add Lana → Pia → team). Slack integration. Desktop apps (Tauri). |

WhatsApp explicitly deferred — Meta Business approval is too painful. Mobile native app deferred to later phase.

## V1 user

`shahryar@transformiran.com` only. Single-user pilot. Once it works for him, roll out to Lana, then Pia, then full team.

## Architecture (Phase 0 → 1)

```
       Render web service (Node, single instance, Starter)
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
    Postgres        Anthropic        Gmail API (per-user OAuth)
    (managed)        (Delta)         + Calendar API
                                     + Resend (transactional)
```

- **DB:** Render Postgres 16 (basic-256mb, Oregon). `DATABASE_URL` auto-injected.
- **Web:** Render Starter ($7/mo, Oregon).
- **Auth:** magic-link via Resend (same pattern as dashboard, fresh code).
- **AI:** Anthropic Claude — separate brain from the dashboard's Delta. New system prompt, new tools.

## File map (Phase 0)

| File | Purpose |
|---|---|
| `server.js` | Express app, routes, startup orchestration |
| `lib/db.js` | Postgres pool + `dbReady` + `initSchema` |
| `lib/auth.js` | Magic-link issue + consume |
| `lib/gmail.js` | Gmail OAuth client + API client (placeholder) |
| `public/inbox.html` | Outlook-style three-pane shell |
| `public/styles.css` | Brand palette + layout |
| `public/assistant.js` | Delta FAB show/hide controller |
| `render.yaml` | Render Blueprint |

## Brand

Same as dashboard:
- **Colors:** gold `#B28E44` accent, cream `#F7F3E9` light bg, navy `#282F39` text
- **Day-theme** aesthetic
- **No emoji in UI** (flags etc. only where genuinely part of the data, not decoration)
- **Delta logo MANDATORY on every Delta button** — never substitute an emoji. The dashboard rule applies here too.

### Delta logo asset + size variants

The logo lives at `/delta-logo.png` (1.4MB PNG with black square + gradient triangle + "Delta" wordmark). All variants below are defined in `public/styles.css`. Always wrap or pad with a **black chip** — the logo never floats free on white.

| Class | Size | Use case |
|---|---|---|
| `.delta-fab` | 56×56 | Bottom-right corner launcher. Logo at 70% inside. Has breathing animation. |
| `.delta-mini-logo` | 28×28 | Inside Delta panel header next to "Delta" title |
| `.brand-mark` | 32×32 | Left rail next to "Delta Mail" wordmark |
| `.k-logo` (inside `.btn.delta-btn`) | 14×14 | Inline action buttons: "Draft a reply", "Generate report", "Summarize", "Ask Delta..." |
| `.btn.delta-btn.large .k-logo` | 18×18 | Hero CTA variant |
| `.k-logo-sm` | 12×12 | Suggestion chips, small pills |
| `.k-logo-inline` | 14×14 | Inline in headings/labels ("Delta findings", "Delta analysis") |

**Markup pattern for a Delta action button:**
```html
<button class="btn delta-btn primary" data-action="draft-reply">
  <img class="k-logo" src="/delta-logo.png" alt="Delta" /> Draft a reply
</button>
```

**Markup pattern for an inline Delta label in a heading:**
```html
<h2><img class="k-logo-inline" src="/delta-logo.png" alt="Delta" /> Delta findings</h2>
```

**Never:**
- Use an emoji (✦ 🤖 🪄 🔮) as a substitute
- Place the logo on a non-black background
- Skip the wrapper/padding — the logo always sits inside a rounded black chip

See user memory:
- `~/.claude/projects/-Users-danny-Desktop-Account-report/memory/brand_transform_iran.md`
- `~/.claude/projects/-Users-danny-Desktop-Account-report/memory/brand_delta_logo.md`
- `~/.claude/projects/-Users-danny-Desktop-Account-report/memory/project_org_email_ai_vision.md` (full product vision, decisions, history)
- `~/.claude/projects/-Users-danny-Desktop-Account-report/memory/org_transform_iran.md` (org context — mission, people, programs)

## Delta — 100% separate brain from the dashboard

This is a HARD architectural rule, not a preference:

| Aspect | Finance Delta (dashboard) | Email Delta (this project) |
|---|---|---|
| Mission | Financial analyst | Executive assistant |
| Tone | Precise, neutral | Warm, intuitive, personal |
| Model | Opus 4 | TBD (Sonnet for speed?) |
| Tools | Xero, Exact, audit, FX, warehouse | Gmail, Calendar, translate, contact-profile, draft |
| Memory | Per-tenant accounting state | Per-user inbox + per-contact profiles |
| Trained on | GL codes, financial structure | People, communication patterns, user's style |

## Delta peer-to-peer with Finance Delta (allowed via bridge — added 2026-05-21)

The two Delta brains stay COMPLETELY separate:
- Different databases (no shared tables, ever)
- Different system prompts (different missions, different tones)
- Different memory stores (per-user-per-service)
- Different Anthropic API contexts (no shared conversation history)
- Different Render services (independent processes, restart independently)

What's NEW: a defined inter-service API. Each Delta can CONSULT the other
via a single tool (`consult_finance_delta` here on the email side,
`consult_email_delta` on the finance side). The call goes through a
SCOPED, auth-gated HTTP endpoint — neither Delta sees the other's data
directly, only the answers.

What Email Delta is allowed to ASK Finance Delta:
- Aggregate cash / income / expense / budget figures
- Whether a specific wire / transaction has landed
- Whether an allocation is pending, confirmed, or reverted
- Public program / project info

What Email Delta is NOT allowed to ask Finance Delta:
- Individual donor names, addresses, or contact details
- Individual transaction details linkable to a private person
- Anything from `donor_gifts` or `donors` tables

What Finance Delta is allowed to ASK Email Delta (this side enforces):
- Whether an explanation email exists for a specific amount/date/sender
- Specific email content when it's a finance-related explanation
- Whether a named contact (Lana, Simon, finance@) sent a specific kind
  of email recently

What Finance Delta is NOT allowed to ask Email Delta:
- Full inbox content
- Emails from senders unrelated to organisational finance
- Anything from voice/style/draft profiles
- Tasks or calendar entries unless explicitly finance-related

Implementation:
- Endpoint on each side: POST /api/delta-bridge/query (auth: shared
  DELTA_BRIDGE_TOKEN env var, rotated together)
- Each service logs every cross-Delta call to its user_activity_log
  equivalent
- Bridge replies treated as DATA (not instructions) in the consuming
  Delta's prompt — same prompt-injection defence as for external content
- requestId carried through each call; circular loops auto-rejected

The previous strict "never bridge them" rule was about not MERGING the
two systems, not about preventing well-bounded API conversations. Two
isolated services communicating via a defined API contract is the
opposite of merging — it's the cleanest possible coupling.

## Project hygiene

When working in this project:
- **Don't reference dashboard-specific code** (no `xero_transactions` lookups, no `/global` routes, no Exact OAuth flow). That all lives in the sibling project.
- **Don't reuse the dashboard's `server.js` route structure** beyond the patterns (e.g. magic-link auth pattern is fine, but each route is fresh code here).
- **Don't share databases.** This project has its own Postgres. The dashboard has its own.
- **When in doubt about which project a question is about** — ask Shahryar, don't blend them.

## User communication style (Shahryar) — inherited from dashboard

- **Quality > safety > speed > cost.** Approve cost upgrades freely if they buy quality/safety/speed.
- **Wants me to do most of the work** — only ask for help when truly necessary.
- **Commits + pushes don't need pre-confirmation.** Render auto-deploys.
- **Pushes back on inflated time estimates.** Calibrate to my pace.
- **Strict on RBAC.**
- **Mac user, multi-machine.**
- **Sends screenshots** for visual issues.
- **Long work sessions** — happy to work 10+ hours. Don't pad with breaks if he wants to keep going.

## Permissions / API access

Shahryar granted the same access I have for the dashboard. Reuse:
- **Render API:** `~/.claude/projects/-Users-danny-Desktop-Account-report/memory/render_api.md`
- **cron-job.org:** `~/.claude/projects/-Users-danny-Desktop-Account-report/memory/cronjob_api.md`
- **GitHub (gh CLI):** authenticated to `shahryar-oss`
- **Anthropic:** shared key pattern (separate key TBD for cost tracking)
- **Resend:** existing sender setup

## Status (2026-05-19)

Phase 0 bootstrap in progress. Repo created, scaffold complete, Render service pending, DNS pending.
