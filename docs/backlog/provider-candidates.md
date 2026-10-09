# Provider candidates

**Status: research, nothing started (2026-10-09).** No code, no commitment to any of the services below.
Recorded so the question is not re-derived, and because the research produced one structural finding that
is worth acting on before any particular provider is: **SimpleFIN is a protocol with several independent
servers, and this repo currently treats it as one product.**

[`../building-a-connector.md`](../building-a-connector.md) is the *how* — the seam, the declarations, and
the traits that turned out to be one provider's. This file is the *which*: the candidate services, what
each one actually is, and what adding it would cost. The two answer different questions and neither
replaces the other.

## The finding that organizes this

SimpleFIN's own protocol page describes a three-party model — users, applications, and **servers**, plural,
run by whoever wants to run one — with a `GET /info` endpoint whose job is to report which protocol
versions a given server speaks. SimpleFIN Bridge is one such server, not the protocol.

That matters here because four of the seven candidates below need no protocol of their own: each
aggregates its own regional or global sources and **also exposes a SimpleFIN server** as one egress among
several. Each one is reached with the claim flow, the access URL, and the account/transaction mapping this
repo already has. The marginal cost of a second SimpleFIN server is therefore *not* the cost of a second
adapter — provided the adapter separates the protocol from the one server it was written against.

It does not, yet. The audit is below, and the conclusion is narrow: the **mapping** is reusable as it
stands, the **policy** is not, because it lives in module constants and module globals that no subclass can
reach.

## Audit: what in the SimpleFIN adapter is the protocol, and what is the Bridge

### Genuinely protocol, and already isolated

Every protocol-shaped decision already sits in a free function or a small method with no knowledge of which
server answered, which is why this half needs nothing done to it:

| Piece | What it encodes |
| --- | --- |
| `_claim_url` / `_split_access_url` / `_basic_auth_header` | The base64 setup token, the single-use claim, credentials inline in the access URL and lifted into a header |
| `_normalize_txn` | The field mapping, including that `description` is the only guaranteed name field and that `memo` carries the raw descriptor |
| `_to_amount` | The protocol's negative-for-money-out sign convention, inverted at the seam |
| `_epoch_to_iso_date` | `posted` being required and degrading to a `0` sentinel for a pending charge |
| `_account_currency` | A currency that is either ISO-4217 or a URL naming a custom unit |
| `_problem_messages` / `_USER_ACTIONABLE_CODE_PREFIXES` | `errlist` (v2) and `errors` (older servers) both read, split by the protocol's own code namespaces |
| `_org_names` | `conn_id` → institution, with the pre-v2 per-account `org` object as fallback |

Nothing outside the adapter needs touching either. `get_adapter` is the only lookup the routers and the
sync loop use, the non-adapter backend mentions SimpleFIN only in comments, and both frontend label maps
(`connectionSummary.js`, `importSourceFields.js`) fall back to a capitalized provider key. The one literal
list is `SUPPORTED_DATA_PROVIDERS` in [`appConfig.js`](../../frontend/src/lib/appConfig.js), which is a
catalog entry per provider and is meant to be edited.

### The Bridge's policy, wearing the protocol's name

These are facts about one server, and all of them live in
[`simplefin.py`](../../backend/services/providers/simplefin.py) as module-level constants or module
globals — so they are not overridable by a subclass and not selectable per connection. None of them is
wrong today:

- **`SIMPLEFIN_BRIDGE_HOSTS`** — checked in `_claim_url`, `_get_accounts` and again inside `_http`. A
  setup token from any other server is
  refused with "That setup token is not from SimpleFIN Bridge", which is correct behaviour for an adapter
  whose provider key means the Bridge and the thing most obviously in the way of a second server. The
  module comment already anticipates the case and answers it with "a different server speaking the protocol
  would be a different product" — which this file agrees with, and which is exactly why the list has to
  belong to the *adapter class* rather than to the protocol module.
- **`WINDOW_DAYS`** — derived from what the Bridge's live server says about range width, which has
  already changed once. Another server has its own answer, or none.
- **`REQUEST_BUDGET_CAPACITY`, `REQUEST_BUDGET_REFILL_PER_HOUR`** — the Bridge's published
  daily allowance, read as a refilling bucket. Read directly by `_refill` and `_take_request`. A server
  that meters nothing would still be walked as though it were metered, which costs depth for no reason; a
  server that meters *harder* would be overrun.
- **`FILTERED_WALK_MAX_ACCOUNTS`** — rests on the Bridge granting each `?account=` call its own
  allowance, confirmed with SimpleFIN directly rather than published. On a server with one pool the
  filtered round is a pure loss: N round trips for the depth one would have bought.
- **`_MIN_REQUEST_INTERVAL_SECONDS`, `_pace_lock`, `_last_request_at`** — pacing is deliberately
  process-wide because the limiter being avoided keys on the caller. The limiter in question is the CDN in
  front of *the Bridge*, so with two servers in play the global interval throttles each against the other's
  rate limit. The key should be the host, not the process.
- **`_USER_AGENT`** — naming the client is required because the Bridge's CDN rejects anonymous
  ones. Harmless everywhere, but it is a transport property of one deployment, not of the protocol.
- **`_ACCOUNT_ID_PREFIX`** — account ids are namespaced by *protocol*, not by server. Two servers
  under one provider key would both mint `simplefin:<id>` from id spaces that have no reason to be
  disjoint, and `account.external_account_id` is what `record_provider_accounts` adopts on. This is the
  strongest argument for one provider key per server: the namespace then follows the key for free.
- **`_adopt_legacy_budget`** — a one-time migration of this repo's own pre-bucket checkpoint. A
  new server has no such history and should not inherit the code path.
- **`zero_amount_rows = REJECT_ZERO_AMOUNT`** — the reasoning is about the Bridge's observed behaviour (a
  settling charge sometimes re-sent under its original id, sometimes arriving as a new one). A server
  proxying live from the bank at sync time may answer differently. The declaration has **no default**, so a
  new adapter class is forced to answer rather than inherit — the seam already handles this correctly.
- **User-facing strings** — `connect_spec`'s `help_url` and hint, the `institution` literal returned by
  `connect`, and every error message name the Bridge. All per-server.

### Not implemented, and newly relevant

`GET /info` is never called and `version: 2` is sent unconditionally. Against one known server that is a
reasonable shortcut; against a set of servers of varying vintage, version negotiation is the protocol's
own answer to the question, and the `errlist`/`errors` double-read is already the symptom of not asking.

### Verdict

The protocol/server split exists as *functions* but not as a *seam*. Adding a second SimpleFIN server today
means either editing the module (so one server's limits silently govern another's) or copying it (so the
mapping forks).

## The shape that fixes it: a server profile, not an adapter per server

The intuitive framing is *named servers* versus *let the user paste any token*, as though those were
alternatives. They are the same mechanism at two settings, because what distinguishes one SimpleFIN server
from another is **a profile**, not code: a label, the host or hosts, the window width, the budget shape,
the pacing key, and the zero-amount policy. Every one of those is a value the audit above found sitting in
a module constant.

So the refactor is: a protocol core — transport, pacing, claim, mapping, the walk — reading those six from
a profile rather than from module scope, and one entry per server. The generic entry is the same structure
with the host unknown, conservative values, and a name the user supplies. A measured server is then a row,
not a class, which is what makes four candidates cheap instead of four times as expensive as one.

**The unknowns all fail toward slow, not wrong.** This is what makes a generic entry viable at all. The
protocol specifies the data — the claim, the field mapping, the sign convention, the `posted` zero
sentinel, currency per account, the error channel — and the adapter's protocol half already absorbs server
*version* drift on its own (`errlist` and the older `errors`, the pre-v2 per-account `org` fallback). What
it does not specify is the operating envelope, and that is exactly the list of constants: budget, refill
rate, window width, whether `?account=` draws on its own allowance, the minimum request interval. Guessing
each one conservatively costs **depth per day** and nothing else. Against a server that meters nothing, a
generic connection would walk at the Bridge's pace, turning a multi-year backfill into days of resumed
syncs rather than minutes — which is the entire price of the generic path, and an argument for profiling a
server once someone has one, not for refusing to connect to it.

The one unknown that is not purely a speed tradeoff is `zero_amount_rows`, and the conservative answer is
still `reject`: a stranded $0 placeholder is visible junk in the ledger, where a dropped pending row simply
arrives later as a settled one.

**Two details are easy to miss.**

- **The account-id namespace becomes per-server, and the Bridge's must be grandfathered.** Ids are
  namespaced by protocol (`simplefin:<id>`) rather than by server, so two servers with overlapping id
  spaces would collide on `account.external_account_id` — which is what mappings adopt on. Changing the
  existing prefix would strand every current mapping, so the Bridge keeps the bare prefix and other
  servers take a host-derived one.
- **`GET /info` stops being optional.** Asking which protocol versions a server speaks is the spec's own
  answer to meeting a stranger, and it is skippable only while there is exactly one known server.

## The candidates

Regions are what each service sells; the access model is the question that actually decides feasibility
here, because this app has no business relationship to offer and a self-hoster has to be able to obtain a
credential alone. (Plaid's BYOK path is the precedent: the user brings their own app credential.)

### Speaks SimpleFIN

| Service | Region | What it is | Access model |
| --- | --- | --- | --- |
| **SimpleFIN Bridge** | US, CA | The reference server; in use today | Setup token, consumer subscription |
| **Redbark** | AU (CDR), NZ (via Akahu), US (via Plaid) | Regional aggregator exposing a SimpleFIN server; states that it proxies balances and transactions live at sync time and keeps no copy | Setup token from its own settings; per-app credentials, so revoking one app leaves others working. Consumer subscription tiered by account count |
| **Lunch Flow** | 30+ countries — UK, EU, US, CA, BR, MENA, APAC | Aggregator whose "Actual Budget destination" *is* a SimpleFIN server | Setup token, single-use, 7-day validity. Consumer subscription; the entry tier caps connections |
| **Synci** | EU (via GoCardless), NZ (via Akahu); also investment and crypto accounts | Aggregator that added a SimpleFIN egress in July 2026 | Setup token; connection is read-only, scoped to chosen accounts, revocable at the source |
| **BankSync** | 40+ countries, 11,000+ banks, brokerages and crypto exchanges | The broadest claimed coverage of the four. SimpleFIN is one egress beside a REST API, an MCP server, a CLI and a long list of spreadsheet/database/automation destinations | Setup token; a grant is read-only, limitable to chosen accounts, and rotatable or revocable per app. Stated as included on every plan with no separate SimpleFIN subscription |

The four non-Bridge entries are the cheap coverage, and they overlap deliberately: Europe is reachable
through Synci, Lunch Flow or BankSync, Australia through Redbark or BankSync, New Zealand through
Redbark or Synci (both of which buy it from Akahu).

**Scoped, revocable, per-app grants are the shape to prefer where a service offers them.** Redbark,
Synci and BankSync all issue a credential per connected app and let it be narrowed to chosen accounts and
revoked on its own. That is strictly better than the Bridge's position for this repo, because
`revokes_on_disconnect = False` is forced today by there being no revocation call at all — a server that
has one in its own UI does not change the declaration (the app still cannot make the call), but it does
change what the disconnect confirmation can honestly tell the user to go and do.

### Own API — a real adapter each

| Service | Region | Why it is interesting | Access model |
| --- | --- | --- | --- |
| **Akahu** | NZ | The upstream behind two of the SimpleFIN servers above, so a direct adapter removes a middleman rather than adding one | A **personal app** grants immediate API access to the holder's own accounts with no approval step — the closest thing to this app's ideal shape of any candidate here |
| **Enable Banking** | EU/EEA — 2,700+ banks across 30 countries, PSD2 AIS, itself a registered AISP | The only European candidate that is not reached through a reseller | A free **restricted-production** tier covers accounts the developer links themselves; full production needs a contract and business verification. Restricted production is precisely the self-hosted case |
| **Pluggy** | BR — 220+ institutions, Open Finance plus direct access | The only Brazil coverage on the list that is not a re-export | Self-serve dashboard and sandbox, client id/secret plus a Connect widget, no sales call. Production pricing is not published |

Each would be an ordinary `ProviderAdapter`: a non-Link connect flow, no cursor, a range pull, per-account
coverage — all of which the seam already supports because SimpleFIN needed them.

## Obstacles

- **Accepting an unlisted host costs less than it looks, and the reason is worth writing down so the
  fixed list is not re-imposed out of caution.** [`../building-a-connector.md`](../building-a-connector.md)
  → *Where requests may go* explains the list as a defence: the token and the access URL arrive from
  outside, so an unfixed destination aims the server's own requests anywhere, and a quoted error reply
  reads the answer back. Re-examined against who is actually involved, **nothing of the user's leaks
  outward**. No stored secret travels to the new host — the access URL it issued is the only credential
  sent to it, and the vault's other contents are never in the request. The reply-quoting path does read
  back, but it reads back *to the person who pasted the token*: connecting requires an unlocked vault
  (`establish_connection`), and anyone holding that already holds the workspace DEK and every bank
  credential in it. Note the asymmetry with the watched folder while relying on the analogy — that path is
  behind `require_admin_or_local` and connecting a source is not, so the two grant the same *kind* of reach
  to differently sized groups. The capability that is genuinely added is reaching an HTTP endpoint on the host's own
  network — which is the same capability a watched import folder grants over the filesystem, accepted and
  documented there on the same reasoning (`../security-model.md` → *Reading and deleting outside the data
  directory*: nothing defends an administrator against themselves). **What should not be relaxed** are the
  three transport properties already in place and doing the real work: HTTPS only, redirects refused, and
  certificate verification against the system trust store — which rules out a bare internal address,
  though not a public name holding a valid certificate and resolving to one. The condition that would reopen this is the one already recorded for the
  watched folder — a role less trusted than the operator gaining the ability to connect a source.
- **A reseller's coverage is bought, not owned.** Redbark's US coverage is Plaid and its NZ coverage is
  Akahu; Synci's EU coverage is GoCardless. A credential obtained from one of these is one more party in
  the chain and one more place for the coverage to change without notice. Where the upstream sells direct
  access to individuals — Akahu does — the direct adapter is the more durable answer even though it costs
  more to build.
- **Two of the services' own account-count caps sit below what a multi-bank ledger uses**, so the tier a
  user would actually need is not the advertised entry price. Worth checking per service at pick-up rather
  than recording a number here that will be wrong.

## Open

- **Which of the two tracks is wanted first** — breadth through the SimpleFIN refactor plus one or more
  server entries, or depth through a direct adapter where the upstream sells to individuals (Akahu,
  Enable Banking's restricted production). The refactor is a prerequisite for the first and irrelevant to
  the second.
- **The conservative profile's actual values** — the window width, budget and refill rate a server nobody
  has measured is walked at. Each is a guess until a second server exists to calibrate against, and each
  trades backfill depth per day for staying inside an unpublished limit.
- **Whether a generic connection discloses what it cannot know.** A profiled server can state its refresh
  behaviour; a generic one is being walked on guesses, and the connect flow is the only place to say so.
- **Whether `GET /info` negotiation is adopted with the refactor** or deferred until a server is found that
  needs it.

## Sources

Every claim about a third-party service above is from that service's own pages, read 2026-10-09, except
where noted. They change without notice, so re-read before acting on a figure.

- SimpleFIN protocol — <https://www.simplefin.org/protocol.html>; Bridge developer guide —
  <https://beta-bridge.simplefin.org/info/developers>
- Redbark — <https://redbark.com/simplefin>
- Lunch Flow — <https://www.lunchflow.app/docs/guides/destinations/actual-budget>
- Synci — <https://synci.featurebase.app/changelog/connect-your-bank-to-actual-budget-and-simplefin-powered-apps>
- BankSync — <https://banksync.io/integrations/simplefin>, <https://banksync.io/product/api>
- Akahu — <https://www.akahu.nz/>
- Enable Banking — <https://enablebanking.com/>; the free restricted-production tier is described by a
  third party (<https://www.openbankingtracker.com/guides/free-open-banking-apis>) rather than on the
  pricing page, so confirm it directly before relying on it
- Pluggy — <https://pluggy.ai/en>
