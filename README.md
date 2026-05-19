# Transform Iran — Delta Mail

Executive-assistant email tool for Transform Iran staff. Replaces Shortwave with a custom Outlook-style inbox + Delta AI that knows the org, the people, and the user's style.

Live: https://mail.transformiran.info *(pending DNS)*

## Status

🟡 **Phase 0 — bootstrap.** Empty shell, deploys to Render, ready for feature work.

## What it is

- Outlook-style three-pane inbox (folders | list | reading pane)
- Delta AI as a floating button in the bottom-right corner — same pattern as the financial dashboard
- Per-user executive assistant: learns each user's tone, knows every contact deeply, drafts replies in the recipient's preferred language
- Backfills 3-4 years of Gmail history on first connect so the AI knows you from day one
- Languages: Farsi, Armenian, English, Dutch — auto-translated per recipient

See `CLAUDE.md` for full project context and `~/.claude/projects/.../memory/project_org_email_ai_vision.md` for the original brainstorm.

## Tech stack

| Layer | Tool |
|---|---|
| Runtime | Node 20 + Express 4 |
| DB | Postgres 16 (Render managed) |
| AI | Anthropic Claude (Delta) |
| Email API | Gmail OAuth + googleapis |
| Transactional email | Resend |
| Auth | Magic-link pattern (same as dashboard) |
| Hosting | Render (Starter $7/mo + Postgres $7/mo) |

## V1 user

`shahryar@transformiran.com` only — single-user pilot. Multi-user comes later.

## Sibling project

The financial dashboard lives at `~/Desktop/Account report/dashboard-app/` and is deployed at `transformiran.info`. **Same brand, same Delta name + logo, but 100% separate brain** — different system prompt, different DB, different tools. Do not mix.
