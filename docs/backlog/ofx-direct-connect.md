# Connecting straight to the bank (OFX Direct Connect)

## What it is

A connection that downloads transactions directly from the bank, with no service in the middle. Plaid and
SimpleFIN are both middlemen: a third party that holds a credential and sees the ledger. OFX Direct Connect
is the one protocol that talks to the institution itself, a natural fit for a local-first, self-hosted
app. The catch is that the user hands Luma their actual bank login.

**Where it stands:** researched and parked; not planned. Few banks still support it, and none of the ones
in use here did when checked. If picked up, the library is `ofxtools`, and what the user is told about
their login is settled before any code.

## Start with the coverage check

`ofxtools` ships a database of US institutions known to speak OFX (`ofxtools/config/fi.cfg`). When last
checked, it matched none of the institutions in use on this install, so the protocol would have covered no
real accounts here.

**Read `fi.cfg`, compare it against the live account list, and re-run that check first.** It is an
afternoon's answer to "is this worth building yet". The specific institutions are not recorded here:
they are personal financial data and they change.

The protocol is shrinking. Quicken's successor, Express Web Connect+, is proprietary aggregation over FDX
and closed to third parties. Bank of America discontinued all OFX on 2025-09-30; Chase and Schwab moved to
EWC+. What remains is Fidelity, Wells Fargo, and a long tail of credit unions and mid-size banks whose
core processors (Fiserv, Jack Henry, Digital Insight) still expose OFX endpoints. The trend runs one way,
so re-check rather than trust this list.

## Technology: `ofxtools`, not aqbanking

OFX Direct Connect is an HTTPS POST with an SGML (1.x) or XML (2.x) body, and the response is an OFX
document. A native dependency buys nothing:

- aqbanking needs gwenhywfar, libofx and libxml2 built and shipped per platform, against the
  cross-platform (Windows, Pi) constraint. GnuCash, its largest consumer, documents that its OFX
  auto-setup hangs because it depends on the defunct ofxhome.com.
- `node_aqbanking` is a Node addon untouched for over a decade, irrelevant to a Python backend.

[`ofxtools`](https://github.com/csingley/ofxtools) is pure Python, stdlib-only, maintained, Python 3.10+,
GPL-3.0-only (compatible with this project's AGPL-3.0-or-later through GPLv3 §13 and AGPLv3 §13). It has
the bundled institution database (no dependency on ofxhome.com), `ACCTINFO` account discovery and
statement requests, and a `scan` for servers whose OFX version and quirks are unknown. It defaults
`APPID`/`APPVER` to a recent Quicken for Windows, which most institution servers check for.

## Settle the disclosure first

Every provider credential is already protected as though it carried full account and identity access
([`../security-model.md`](../security-model.md) → *Why provider credentials are the only things
encrypted*), so storage does not change. What changes is what the user must be told:

- **The credential is the bank login.** Not a scoped read-only token, but the username and password for
  full web banking. Some institutions issue a separate Direct Connect PIN; many do not.
- **It cannot be revoked from inside the app.** There is no equivalent of an item-remove call.
  Disconnecting deletes the local copy; killing the credential means changing the password at the bank.

Neither forces a redesign: the passphrase floor is unconditional, and `revokes_on_disconnect = False`
already gives the disconnect confirmation its wording (as for SimpleFIN). What is **not** modelled is a
connect flow that tells the user it is taking their banking login. There is no sandbox in which to ask
later.

## The adapter

The provider seam already has what OFX needs (a non-Link connect flow, a range pull for providers with no
cursor, no app-level credential; see [`../building-a-connector.md`](../building-a-connector.md)). What is
left is a `ProviderAdapter` over `ofxtools`, normalizing to the contract in
`backend/services/providers/base.py`. Notes, not a spec:

- **Sign flip.** `TRNAMT` is negative for a debit; the contract is positive for money out.
- `FITID` → `external_transaction_id` (a bank-assigned per-account id and a strong dedupe key);
  `CHECKNUM` → `check_number`, which the `Check #<n>` fold already reads.
- **`external_account_id` is a hash** of `BANKID` + `ACCTID`. It joins `account.external_account_id`,
  stored in the clear, and the raw `ACCTID` is a real account number; the last four already live in
  `mask`.
- `is_pending` is always false (statements are posted-only), and there is **no second date**, so
  `posted_date` adds nothing. `base.py` calls that field the most valuable one for duplicate detection,
  so deduping an OFX connection against a CSV of the same account falls back to the date heuristics
  alone and will raise more soft flags than Plaid.
- `remove()` is a documented no-op.
- **MFA is unknown.** Some institutions return an `MFACHALLENGE` on signon, which needs a
  challenge/response round trip. Whether it matters depends on which institutions are in scope, another
  reason the coverage check comes first.

## Related

- [`import-input-formats.md`](import-input-formats.md) — OFX / QFX / QBO **file** import, a separate and
  much cheaper track with no credential custody (`ofxtools` is a parser candidate there too).
- [`../security-model.md`](../security-model.md) → *Revocation, in both directions* — the disclosure this
  owes.
