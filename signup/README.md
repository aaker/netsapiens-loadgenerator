# Beta Tester Signup

Single-page signup app that provisions a beta tester onto a NetSapiens server:
claims one of the premade resellers, buys a phone number from Inteliquent near
the tester's area code, creates a domain (named after their email hostname)
with that number as caller ID, creates a Reseller-scope user, and triggers the
platform welcome email.

## Setup

```bash
cd signup
cp .env.example .env    # fill in TARGET_SERVER, APIKEY, INTELIQUENT_* vars
npm install             # also installs client/ deps via postinstall
npm run build           # builds the React client into client/dist
npm start               # serves client + API on :3100
```

## Development

```bash
npm run dev             # terminal 1: API on :3100
npm run dev:client      # terminal 2: Vite dev server on :5173, proxies /api
```

Set `SIGNUP_DRY_RUN=1` to skip Inteliquent entirely (uses a fake number) —
useful for testing the NetSapiens flow without spending money.

## How provisioning works

`POST /api/signup` validates and returns a `jobId`; the client polls
`GET /api/signup/:jobId` for step-by-step progress. Steps:

1. **check-domain** — domain = email hostname. If it already exists, skip to 5
   (just add another user to the existing company domain).
2. **claim-reseller** — a reseller is *available* when its name equals its
   description slugified (spaces/commas/apostrophes → `_`, lowercased — the
   rule the load generator used to create them). Claiming = setting the
   description to the tester's company name, which removes it from the pool.
3. **purchase-number** — Inteliquent `tnInventory` in the exact NPA, falling
   back to same-state NPAs ranked by inventory (`tnInventoryCoverage`). Never
   buys out-of-state. Ordered via `tnOrder` onto `INTELIQUENT_TRUNK_GROUP`.
4. **create-domain** — with the claimed reseller and purchased number as
   caller-id-number / caller-id-number-emergency.
5. **create-user** — extension 1001+ with `user-scope: Reseller`.
6. **send-welcome** — templated welcome email via
   `POST domains/{d}/users/{u}/email` (`WELCOME_TEMPLATE`/`WELCOME_SUBJECT`,
   non-fatal on failure).
7. **add-phonenumber** — number added to domain inventory, unassigned.

## Failure handling & manual recovery

All jobs are serialized in-process, and every step transition is appended to
`data/jobs.jsonl`. **Run exactly one instance of this server** — the
reseller-claim race protection is in-process only (no pm2 cluster, no second
box).

Compensation rules: number purchase failure releases the claimed reseller
(restores a slug-matching description); domain-create failure additionally
logs the purchased number as orphaned (manual `tnDisconnect`); user-create
failure keeps the domain + number (resubmitting the form finishes the job via
the domain-exists path).

Find anything needing manual attention:

```bash
grep -E 'orphaned_tn|recovery_needed|RESELLER_LEAKED' data/jobs.jsonl
```

## Things to verify against your server's swagger (`https://<TARGET_SERVER>/ns-api/docs`)

- The exact `user-scope` string for a reseller-scope user (`Reseller` assumed
  — set in `server/provisioner.js`).

## Abuse guards

No login on the page. Protection: per-IP hourly limit + global daily limit
(`SIGNUP_RATE_LIMIT_*`), free-mail domains rejected (the email hostname
becomes the tenant domain), 4KB body cap, and the finite reseller pool as the
hard ceiling. Set `TRUST_PROXY=1` when running behind nginx/ELB so rate
limiting sees real client IPs.
