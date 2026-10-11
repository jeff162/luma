# Settings / Administration split

**Status: in progress.** The design below is settled. The stages under *Build order* are worked top to
bottom, and **a stage is deleted from this file when it ships**, so the first one listed is the next one
to do. When the list is empty, retire the file per [`README.md`](README.md).

## What this is

Settings was a parking place for anything built before its home existed, and Import / Export carried
install administration (Backup / Restore) beside the work of bringing transactions in. The main pages
are for day-to-day work; the occasional operations are sorted onto two pages by **who may do them**,
which is the line the server already draws.

## The boundary

**Admin gates the install and the perimeter, not the ledger** (`security-model.md` → *Identity and the
network perimeter*). Everything a member may do lives in Settings; everything behind
`require_admin_or_local` lives in Administration. The two are not mixed on one page. Where an item
genuinely straddles the line, the admin-only part is hidden from a non-admin in place — About's update
check is the only such case.

A ledger-wide setting is **not** thereby an admin setting: Currency and the review flag stay open to
every member. Both are instantly reversible, neither touches the perimeter, the host or a secret, and a
member who could not change them can still delete the ledger's rows. Gating them was considered and
dropped for that reason.

## Where each thing goes

**Settings** — every member:

- Appearance
- Currency
- New transactions (the review flag)
- Own sign-in methods — password, passkeys, 2FA. Present only while sign-in protection is on
- Duplicate detection exceptions — the dismissed duplicate pairs and the distinct account pairs, under
  one heading
- Import storage
- Trash
- About — the update-check controls render for an admin only

**Administration** — admin-or-local; the nav entry is absent for anyone else:

- Startup configuration — the panel currently titled *Configuration*, with its data-location toggle. It
  stays a report of values resolved at startup; in-app settings never join its row list or the
  `app_config` registry, since anything in that registry gains an environment variable that outranks it
- Error log
- Intended usage
- Sign-in protection switch and password policy
- User management
- Backup, Restore and the backup encryption keys — all three, moved off Import / Export
- Developer options, while `LUMA_DEVELOPER_OPTIONS` is on

**Transactions** gains two dialogs:

- **Tags** — the tag list's rename / recolour / delete, moved out of Settings
- **Export…** — the CSV export. It starts from a *copy* of the page's current filter and adds the column
  picker, so adjusting the export never disturbs the filter the rest of the app reads

**Import / Export** keeps Import and Amazon and is renamed **Import**.

## Page layout

Both pages share one layout: the section names in a list down the left, the selected section on the
right, one at a time. A section gets the full content width (several are tables), loads only when
selected, and is addressable as `?section=<key>`. This replaces the collapsible drops.

## Server changes

- Creating a backup becomes `require_admin_or_local`, so the page and the server agree. Restore and the
  backup keys already are.

## Build order

Each section is its own module: member sections under `components/settings/`, admin sections under
`components/administration/`. `pages/Settings.jsx` is the page shell — it still renders every section,
in the collapsible layout, until the first stage below replaces it.

1. **Add the Administration page and the shared section-list layout.** Move the admin sections onto it,
   hide the nav entry from a non-admin, and split `AccountSecuritySection.jsx`: the switch, the password
   policy and the enable form stay in `administration/`, while `SignInFactorsPanel` (own passkeys and
   2FA) becomes a member section in `settings/`. `StickySection` and the `ui.settings.stickySections`
   preference go with the old layout.
2. **Move Backup / Restore to Administration** and gate backup creation on the server. Rename the Import
   page.
3. **Build the Tags and Export dialogs on Transactions** and remove both from where they were
   (`settings/TransactionTagsSection.jsx` is the Tags dialog's body; `importExport/ExportTab.jsx` the
   Export dialog's).
4. **Docs and help.** The admin wording in `security-model.md`, `architecture.md` and
   `authorization.py`; every "Settings → X" reference in the docs and the in-app help topics; the
   `page-settings` / `page-import-export` help topics and `help/navigation.js`; the superseded entry in
   `misc-followups.md` (*Import / Export still needs a reachability pass*).
