# Beta Tester Signup

Single-page signup app that provisions a beta tester onto a NetSapiens server:
claims one of the premade resellers, buys a phone number from Inteliquent near
the tester's area code, creates a domain (named after their email hostname)
with that number as caller ID, creates a Reseller-scope user, and sends a
welcome email directly via SMTP.

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
   caller-id-number / caller-id-number-emergency. Also sets the **User Email
   Security** flags (`allow_user_primary_email_edit`,
   `account_recovery_user_primary_email`, `require_unique_primary_user_email`
   on; `allow_sso_with_additional_emails` off). These aren't in the published
   create-domain swagger, so the domain is read back and any flag that didn't
   take is corrected with a PUT (logged as `email_security_corrected`).
   Account-recovery-by-primary-email being on is what lets the welcome email's
   "Forgot password" login flow work.
5. **create-user** — extension 1001+ with `user-scope: Reseller`.
6. **send-welcome** — welcome email sent **directly via SMTP** (`server/mailer.js`),
   rendered from `email-templates/welcome_email.html`. Shows the login, the
   domain we created, the reseller we claimed and its new description (the
   tester's company name), the purchased phone number, and a notice that the
   environment and its traffic are fake test data. Non-fatal on failure. (The
   old NetSapiens platform-email call, `ns.sendWelcomeEmail`, is left in
   `server/nsclient.js` unused.)
7. **send-reset** — triggers the NetSapiens **password-recovery email** (the
   same `POST .../email` with `action:create` the Horizon forgot-password page
   makes), so the tester gets a working "set your password" link. NetSapiens
   generates the `auth_code`; we authenticate with the API key (Bearer), not
   the portal `client_id`/secret. Non-fatal. (Deliverability depends on the
   NetSapiens server/domain having its own outbound email configured — this is
   separate from the SMTP settings above, which only send our welcome email.)
8. **add-phonenumber** — number added to domain inventory, unassigned.

## Email / SMTP configuration

The welcome email is sent by this app over SMTP (nodemailer), not by the
NetSapiens platform. Add these to `signup/.env` (or the repo root `.env`):

```bash
SMTP_HOST=smtp.example.com          # required to send; without it the step fails (non-fatal)
SMTP_PORT=587                       # 465 = implicit TLS, 587/25 = STARTTLS (default 587)
SMTP_SECURE=                        # 1/0 to force; defaults to true only when port is 465
SMTP_USER=beta@example.com          # optional; omit for an unauthenticated relay
SMTP_PASS=your-smtp-password
SMTP_FROM="NetSapiens Beta <beta@example.com>"   # defaults to SMTP_USER
SMTP_TLS_REJECT_UNAUTHORIZED=       # set 0 to allow self-signed certs (dev only)

WELCOME_SUBJECT="Your beta test account is ready"   # optional
PORTAL_FQDN=                        # FQDN used in portal/API links; defaults to TARGET_SERVER
SUPPORT_LINK=                       # footer support URL; defaults to https://<PORTAL_FQDN>/
EMAIL_POWERED_BY="NetSapiens Beta"  # footer "Sent by" label
```

The **password-recovery email** (send-reset step) is sent by NetSapiens, not
by us, so it uses the NS server's own mail config — the `SMTP_*` vars above do
not affect it. Optional overrides:

```bash
RESET_SUBJECT="Your password recovery"       # email subject
RESET_TEMPLATE=password_reset_email.php      # NS template name
RESET_APP_URI=                               # reset-link target; defaults to
                                             #   https://<PORTAL_FQDN>/auth/password-reset?auth_code=<AUTH_CODE>&username=<USERNAME>&r=horizon
                                             #   (NS substitutes <AUTH_CODE>/<USERNAME>)
RESET_CLIENT_ID=                             # only if your server scopes the reset auth_code to a specific OAuth client
```

The recipient is the tester's signup email; the template placeholders are
filled from the provisioning result — the NetSapiens server renders nothing.

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
(`SIGNUP_RATE_LIMIT_*`), public/free/disposable email domains rejected (the
email hostname becomes the tenant domain, so only real company mail is
accepted), 4KB body cap, and the finite reseller pool as the hard ceiling. Set
`TRUST_PROXY=1` when running behind nginx/ELB so rate limiting sees real client
IPs.

### Email blocklist (`server/freemail.js`)

`isFreeMail(hostname)` rejects ~130k known public providers, merged at boot
from the `free-email-domains` and `disposable-email-domains` packages plus
`server/freemail-extra.txt` (checked-in, one host per line, easy to extend).
Matching covers subdomains (`mail.gmail.com` → `gmail.com`). Env knobs:

```bash
FREEMAIL_EXTRA_FILE=   # path to an additional blocklist file (one host per line)
FREEMAIL_ALLOW=        # comma-separated hosts to force-allow even if a list flags them
```
