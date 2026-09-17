# OFX Direct Connect

**Status: researched, parked (2026-08-07) — not planned for implementation.** The research is recorded
here so the question is not re-derived from scratch: the technology choice is settled (`ofxtools`, not
aqbanking), the reason for parking is *coverage*, not cost, and there is a threat-model consequence that
must be settled before any future pick-up.

## Why it is interesting at all

Every aggregator on the connection roadmap — Plaid, Teller, SimpleFIN — is a middleman: a third party
that holds a credential and sees the ledger. **OFX Direct Connect is the only transaction-pull protocol
that talks to the institution directly.** For a local-first, self-hosted app that is a real
philosophical fit, and it is the only reason this is worth revisiting rather than dismissing.

## Why it is parked: coverage, not cost

`ofxtools` ships a database of US institutions known to speak OFX (`ofxtools/config/fi.cfg`). Checking
that list against the institutions actually in use on this install matched **none of them** — so the
protocol would cover approximately no real accounts here, and the implementation cost is beside the
point.

The method is the durable part, not the answer: **read `fi.cfg`, compare against the live account list,
and re-check coverage first.** That is one afternoon's answer to "is this worth building yet," and it is
where any future pick-up starts. (The specific institutions are deliberately not recorded — they are
personal financial data and they change; the check is cheap enough to re-run.)

## The technology call, if picked up: `ofxtools`, not aqbanking

The initial premise was [aqbanking](https://github.com/aqbanking/aqbanking) (with the
`node_aqbanking` wrapper). Both are the wrong vehicle:

- `node_aqbanking` is a Node native addon, untouched for over a decade, and irrelevant to a Python
  backend regardless.
- aqbanking is a C library requiring gwenhywfar + libofx + libxml2 built and shipped per platform, which
  cuts directly against the cross-platform (Windows/Pi) constraint the rest of the ingestion work is
  held to. GnuCash — aqbanking's largest consumer — documents that its OFX auto-setup *hangs*, because
  it depends on ofxhome.com, which no longer exists.
- Most importantly, the capability is not in the C code. **OFX Direct Connect is an HTTPS POST with an
  SGML (OFX 1.x) or XML (2.x) body**, and the response is an OFX document. A native dependency buys
  nothing.

[`ofxtools`](https://github.com/csingley/ofxtools) covers it in pure Python: stdlib-only (no external
dependencies), actively maintained, Python 3.10+, GPL-3.0-only — compatible with this project's
AGPL-3.0-or-later via the explicit combination permissions in GPLv3 §13 and AGPLv3 §13. It carries the
three pieces that matter: the bundled FI database above (so there is no dependency on the defunct
ofxhome.com), `ACCTINFO` account discovery plus statement requests, and a `scan` capability for
servers whose OFX version and formatting quirks are unknown. It also defaults `APPID`/`APPVER` to a
recent Quicken for Windows, which most institution servers check for.

## The protocol is being retired, not held stable by Quicken

The premise that Quicken's dependence on OFX keeps it alive at the larger institutions no longer holds.
Quicken's own migration path is **Express Web Connect+**, which is Quicken/Intuit-proprietary
aggregation over FDX and closed to third parties — so the successor protocol is a door that does not
open for an app like this one. Bank of America discontinued all OFX (Direct Connect *and* Web Connect)
on 2025-09-30; Chase and Schwab moved to EWC+.

What remains is a shrinking but real surface: Fidelity, Wells Fargo, and a long tail of credit unions
and mid-size banks whose core processors (Fiserv, Jack Henry, Digital Insight) still expose OFX
endpoints. Since the trend is one-directional, the coverage check above needs re-running at pick-up
time rather than trusting anything recorded here.

## The threat-model consequence — read this first

Every provider credential is already protected as though it carried full account and identity access
([`../security-model.md`](../security-model.md) → *Why provider credentials are the only things
encrypted*), so nothing here changes how one is stored. What OFX changes is what the user must be told,
because it is the one candidate whose credential is knowably the widest kind:

- **It is the bank login.** Not a scoped read-only token — the same username and password that grants
  full web banking. Some institutions issue a separate Direct Connect PIN; many do not.
- **It cannot be revoked from inside the app.** There is no analog to the provider item-remove call the
  disconnect flow relies on. Disconnecting would delete a local copy only; actually killing the
  credential means changing the password at the institution.

Neither fact forces a redesign — the passphrase floor is already unconditional and a provider with no
revocation call is an ordinary supported case. Both are **disclosure** obligations, and they are the
thing to settle before writing any code: the disconnect confirmation has to say what disconnect does and
does not do, and the connect flow has to be honest that the credential being handed over is live bank
access rather than a scoped token. There is no sandbox mode in which to ask later.

## What would remain adapter-side

The provider-seam work OFX would need — a connect flow that is not Link, a range-pull fallback for
providers with no cursor API, and support for a provider with no app-level credential — is **not**
OFX-specific. **All three now exist** (built with the SimpleFIN adapter, 2026-08-07; see
[`security-and-deployment-model.md`](security-and-deployment-model.md) → phase 6c): `connect_spec` +
the shared `establish_connection`, the base adapter's range-pull `fetch_transactions_sync`, and
`requires_app_config = False`. OFX would declare the same capabilities rather than add new ones, which
removes most of what made this look expensive.

Two of its remaining differences are also already modelled. `revokes_on_disconnect = False` is exactly
the SimpleFIN case — a provider whose disconnect deletes only the local copy — so the confirm-dialog
disclosure comes for free. And `connect_requires_production_vault` already gates a provider with no
sandbox, which OFX is. What is **not** modelled is a connect flow that has to
tell the user it is taking their banking login.

Assuming that seam work exists, what is left is a `ProviderAdapter` over `ofxtools`, normalizing to the
neutral contract in `backend/services/providers/base.py`. Notes, not a spec:

- **Sign flip.** OFX `TRNAMT` is negative-for-debit; the neutral contract carries Plaid's
  positive-for-money-out. The adapter is where a provider's convention is normalized.
- `FITID` → `external_transaction_id` (a bank-assigned per-account id, and a strong dedupe key);
  `CHECKNUM` → `check_number`, which the existing `Check #<n>` fold already consumes.
- **`external_account_id` should be a hash** of `BANKID` + `ACCTID`. It joins `account.external_account_id`,
  which is stored in the clear, and the raw `ACCTID` is a real account number — the last four already
  live in `mask`.
- `is_pending` is always false (OFX statements are posted-only) and there is **no second date** — OFX has
  no transaction/posted split, so `date` is the posting and `posted_date` adds nothing. `base.py` calls
  that field "the single most valuable one for duplicate detection," so deduping an OFX connection against
  a CSV covering the same account would fall back to the date heuristics alone, and should be expected to produce more soft flags than Plaid.
- `remove()` is a documented no-op, per the threat-model section above.
- **MFA is an open unknown.** Some institutions return an `MFACHALLENGE` on signon, which needs a
  challenge/response round trip rather than a single form post. Whether that matters depends entirely on
  which institutions are in scope — another reason the coverage check comes first.

## Cross-refs

- [`import-input-formats.md`](import-input-formats.md) — the SimpleFIN entry owns the provider-seam
  generalizations OFX would also need; its Tier-2 entry covers OFX/QFX/QBO **file** import, which is a
  separate, much cheaper track with no credential custody at all (`ofxtools` is a parser candidate there
  too).
- [`../security-model.md`](../security-model.md) — the custody rule this inherits, and *Revocation, in
  both directions* for the disclosure it owes.
