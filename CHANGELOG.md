# Changelog

All notable changes to Luma are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

### Changed

- Auth system — optional multi-user mode with session-based login and 2FA
- Docker support via `docker-compose.yml`
- Nightly sync via `scripts/sync.sh` (cron-compatible)

### Removed

- Pre-auth security UI in Settings: the security-profile picker, the
  sign-in protection toggle, and the password-policy picker were removed
  pending decisions on the eventual security model. Supporting backend
  endpoints (`/auth/enable`, `/auth/security-profile`,
  `/auth/password-policy`) and the `securityProfiles.js` / `passwordPolicy.js`
  lib helpers remain in place. The 2FA, user management, and Plaid token
  protection sections — all gated on auth-enabled mode — are unchanged.
  See `docs/backlog/pre-auth-security-ui.md` for rebuild notes.
