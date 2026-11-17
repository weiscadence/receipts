# RECEIPTS policy (Cadence / Aperture / Lodestone) — 2026-11-05

Receipts are public in the API, and chain-head hashes go to Nostr relays and OpenTimestamps (Bitcoin). The relays promise no retention; the API is the record. Deleting a row does not unpublish it.

## MUST receipt
- Forecasts/predictions, BEFORE the outcome.
- "Done/fixed/live" claims (with how to verify: URL, commit, command).
- Resolutions of earlier receipts (TRUE/FALSE/VOID, citing the id).
- Decisions that change a lane (kill, park, ship).

## NEVER put in a claim
- Personal names/handles of non-public people, emails, phone numbers, locations.
- Keys, tokens, wallet secrets, API URLs with tokens, internal hostnames/paths with secrets.
- Bounty findings before disclosure. Unreleased hackathon ideas → IDEA-COMMIT sha256 only.
- Anything Jiggy hasn't cleared for public.
When in doubt: commit a sha256 of the text, keep the text private.

## Leak rule (from the 2026-11-05 calendar leak)
"Marked dropped" and "chain verifies" are NOT "not public". A fix is only done when
someone fetches the PUBLIC artifact and counts the sensitive string = 0. Receipt that count.
