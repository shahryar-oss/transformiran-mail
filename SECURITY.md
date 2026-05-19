# Security Policy

This repository hosts the source code for **Delta Mail**, an internal email tool for Transform Iran staff. The code is public for tooling reasons (CI/CD access), but the **running service handles sensitive ministry data** — donor information, persecuted-believer communications, financial correspondence.

## Reporting a vulnerability

If you discover a security issue, **please do not open a public GitHub issue.**

Email instead: **shahryar@transformiran.com**

Include:
- A description of the issue
- Steps to reproduce
- Potential impact
- Suggested fix if you have one

We aim to acknowledge reports within 48 hours and ship a fix within 7 days for serious issues.

## What's NOT in this repo

The following are explicitly excluded from version control and **never** appear in code or commit history:

- API keys (Anthropic, Google, Resend, Render)
- OAuth client secrets
- User OAuth tokens (refresh + access)
- Database credentials
- Session secrets
- SYNC_TOKEN values
- Any email content from any user
- Any contact data

All secrets live in Render's encrypted environment variable store. All user data lives in the managed Postgres database, encrypted at rest.

## Scope

In scope for security reports:
- Authentication bypass
- Authorization / RBAC bypass
- SQL injection
- XSS / CSRF
- Secret exposure
- Dependency vulnerabilities with concrete impact
- OAuth misconfiguration

Out of scope:
- Social engineering of Transform Iran staff
- Physical attacks
- DoS attacks
- Issues in third-party services (report to that vendor)

## Acknowledgments

We thank responsible reporters and will credit you in the fix commit unless you prefer to remain anonymous.
