# Action Token Rotation Runbook

## Overview

GAP-05 from architecture.md openGaps. Manual rotation procedure for `ACTION_TOKEN_SECRET`.

The `HmacActionTokenVerifier` reads both `ACTION_TOKEN_SECRET` (primary) and the optional
`ACTION_TOKEN_SECRET_PREV`. When both are set, verification is attempted against the primary
secret first, then the prev secret on signature failure. This enables a zero-downtime rotation
with a finite rollover window.

## When to Rotate

- On a compromise or suspected compromise of the current secret
- Scheduled quarterly (recommended baseline)
- Before deprecating or decommissioning an environment

## The Four Steps

### Step 1 — Deploy with both secrets

Set the environment variables:

```
ACTION_TOKEN_SECRET_PREV = <current value of ACTION_TOKEN_SECRET>
ACTION_TOKEN_SECRET      = <new secret — generate with `openssl rand -hex 32`>
```

Deploy. The verifier now accepts tokens signed by **either** secret (primary tried first,
prev tried on signature failure). In-flight tokens issued before the rotation continue
to work.

### Step 2 — Wait for the rollover window

**Wait 5 minutes.**

This equals `ACTION_TOKEN_TTL_SECONDS` (300 seconds) — the maximum lifetime of any
in-flight action token. After 5 minutes, any token signed by the previous secret has
necessarily expired and can no longer be presented. No valid prev-signed tokens remain.

### Step 3 — Remove the prev secret

Unset `ACTION_TOKEN_SECRET_PREV` from the environment configuration. Redeploy.

The verifier now only accepts tokens signed by the new primary secret.

### Step 4 — Confirm

Run the verification steps below to confirm the rotation is complete.

## Verification

```bash
# With BOTH secrets deployed (after Step 1), mint a token signed by the PREV secret
# using a dev script or the same signing logic as the issuer endpoint but with
# ACTION_TOKEN_SECRET_PREV as the signing key. Then:

curl -X POST https://<host>/v1/scores:increment \
  -H "Authorization: Bearer <jwt>" \
  -H "Action-Token: <token-signed-by-prev>" \
  -H "Content-Type: application/json" \
  -d '{"actionId": "<uuid>", "delta": 5}'

# Expect: 200 with the score credit applied.
# If you get 401: the prev key is not set correctly or the token was signed
# with a different key — check your deploy configuration.
```

After Step 3 (prev secret removed), the same token signed by the prev secret must
return `401 UNAUTHENTICATED`. Confirm this to close the rotation.

## Safety Notes

- The verifier tries the **primary secret first**. Prev is only consulted on signature
  failure. There is no ambiguity even if primary and prev are the same value (which
  would be a configuration error anyway, caught by the rotation intent itself).
- `ACTION_TOKEN_SECRET` is **required** (no `.optional()` in the Zod schema). A
  prev-only deploy is impossible by construction — the app will refuse to boot at config
  parse time if `ACTION_TOKEN_SECRET` is missing or shorter than 32 chars.
- Both secrets must be **≥32 chars** (enforced by Zod `z.string().min(32)`).
- Rotation is a **manual** procedure for v1 per `IMPROVEMENTS.md I-SEC-04`. Automated
  rotation is out of scope for this version.

## Backlink

Origin: [`_bmad-output/planning-artifacts/architecture.md`](../../_bmad-output/planning-artifacts/architecture.md) → `openGaps.GAP-05`
