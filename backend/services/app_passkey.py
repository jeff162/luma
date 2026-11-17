# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WebAuthn for the *login perimeter*: registering a passkey against an account, and proving one.

This is authentication, and that is the whole difference from the vault's passkeys. A vault slot is
self-verifying — a wrong PRF output fails at the AEAD tag exactly as a wrong passphrase does, so
`crypto_service` deliberately verifies no assertion and stores no public keys (`architecture.md` →
*Token vault & transport security*). Signing in has no such backstop: nothing downstream would notice a forged
assertion, so the signature is the only thing standing between a request and a session. Hence stored
public keys, server-issued challenges, and real verification here.

**The two ceremonies must never become one.** They look identical on screen and mean different things —
one crosses the perimeter, the other opens encrypted credentials — so they have separate endpoints,
separate storage (`app_passkey` vs `vault_slot`) and separate copy. Signing in with a passkey confers no
vault authority, and a user who has both will be prompted twice. That is the intended cost.

Verification is delegated to `py_webauthn` rather than hand-rolled. What this module owns is the policy
around it: which origins count as this deployment, that user verification is mandatory, and how a sign
counter is allowed to move.
"""

import hashlib
import json

import webauthn
from webauthn.helpers import bytes_to_base64url
from webauthn.helpers.exceptions import (
    InvalidAuthenticationResponse,
    InvalidRegistrationResponse,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    AuthenticatorTransport,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from backend.db.control_database import (
    add_app_passkey,
    get_app_passkey_by_credential,
    list_all_app_passkey_credentials,
    list_app_passkey_credential_ids,
    list_app_passkeys,
    record_app_passkey_use,
)
from backend.runtime_config import app_name


class PasskeyRejected(Exception):
    """A ceremony that did not verify. The message is shown to the user, so it says what to do next
    rather than which check failed — a caller who presented a bad assertion learns nothing useful from
    the distinction, and an attacker probing the endpoint learns something from every distinction."""


# User verification is required on both ceremonies, and it is the load-bearing setting in this file:
# it is what makes the authenticator demand a biometric or a PIN, so a passkey proves possession *and*
# something known or inherent. That is why a passkey sign-in stands in for a second factor (see
# `security-model.md`); a passkey registered without it would be possession alone, and the TOTP step it
# replaces would be silently lost.
_USER_VERIFICATION = UserVerificationRequirement.REQUIRED


def sign_in_user_handle(user_id: str) -> bytes:
    """The WebAuthn user handle a sign-in passkey is registered under — deliberately *not* the account id.

    The vault's passkeys use the account id itself as their handle, and a handle is how an authenticator
    decides two passkeys belong to the same account: the authenticator protocol lets it replace a stored
    passkey when a new one arrives for the same site and handle, and the synced password managers do
    exactly that. Sharing the vault's handle would therefore let adding a sign-in passkey silently delete
    that person's vault passkey from the device, or the reverse. Derived rather than stored because it
    only has to differ from the vault's and stay stable per account; a hash also keeps the internal id
    off the authenticator and out of synced keychains.
    """
    return hashlib.sha256(b"sign-in:" + user_id.encode()).digest()


def passkey_account_names(user: dict, purpose: str) -> tuple[str, str]:
    """The name and display name a passkey is registered under, which is what a device's passkey chooser
    and its saved-passkey list show. Every Luma install served on one host shares that host's passkey
    list, and both the vault and sign-in keep one per person, so a bare username leaves several identical
    entries and no way to tell which one to pick or delete. `purpose` is "sign-in" or "vault"; the vault's
    params call this too, so the two always read as a pair."""
    username = user["username"]
    display = user.get("display_name") or username
    return f"{username} ({app_name()} {purpose})", f"{display} ({app_name()} {purpose})"


def registration_options(user: dict, rp_id: str) -> tuple[str, str]:
    """Options for `navigator.credentials.create()`, and the challenge to hold until it comes back.

    Resident (discoverable) keys are *required* rather than preferred, which is the difference between
    "sign in with a passkey" being a button someone can press on the sign-in screen and being something
    they can only reach after typing a username. The vault's own registration asks only for `preferred`
    because its ceremony always starts from a signed-in user who is already known.
    """
    existing = [
        PublicKeyCredentialDescriptor(id=webauthn.base64url_to_bytes(credential_id))
        for credential_id in list_app_passkey_credential_ids(user["id"])
    ]
    name, display_name = passkey_account_names(user, "sign-in")
    options = webauthn.generate_registration_options(
        rp_id=rp_id,
        rp_name=app_name(),
        user_id=sign_in_user_handle(user["id"]),
        user_name=name,
        user_display_name=display_name,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=_USER_VERIFICATION,
        ),
        # Nothing here inspects an attestation statement, and asking for one would mean deciding which
        # authenticator makes and models are acceptable and maintaining that list. `none` is also what
        # keeps the ceremony free of a "this site wants to identify your security key" prompt.
        exclude_credentials=existing,
    )
    return webauthn.options_to_json(options), bytes_to_base64url(options.challenge)


def authentication_options(rp_id: str) -> tuple[str, str]:
    """Options for `navigator.credentials.get()` on the sign-in screen.

    **`allow_credentials` names every sign-in passkey in this workspace** that can answer at `rp_id` (one
    registered under another host name never can, `list_all_app_passkey_credentials`), and this reverses a deliberate
    first choice. Sending none let the browser offer *every* passkey it holds for the host — and a device
    holds one list per host, not per install or per port, so the chooser filled with vault passkeys and
    with passkeys from other Luma databases served on the same host, all under the same name, and only
    one of them could work. Naming the credentials cuts that to this install's sign-in passkeys, and to
    no chooser at all where there is one.

    The cost is that an unauthenticated caller learns how many sign-in passkeys exist and their ids. An
    id is not a secret — it cannot produce an assertion — and the perimeter exists to keep non-users out
    rather than to hide the size of the household (`security-model.md` → *Passkeys and the second
    factor*). Still no username needed: the list is workspace-wide, so the account falls out of the
    credential that answers, exactly as before.
    """
    allowed = [
        PublicKeyCredentialDescriptor(
            id=webauthn.base64url_to_bytes(row["credential_id"]),
            transports=_known_transports(row["transports"]),
        )
        for row in list_all_app_passkey_credentials(rp_id)
    ]
    if not allowed:
        # An empty list does not mean "none" to a browser — it means "any", which is the whole-host
        # chooser this list exists to prevent.
        raise PasskeyRejected("No passkeys are registered here. Sign in with a password.")
    options = webauthn.generate_authentication_options(
        rp_id=rp_id,
        allow_credentials=allowed,
        user_verification=_USER_VERIFICATION,
    )
    return webauthn.options_to_json(options), bytes_to_base64url(options.challenge)


def _known_transports(stored: str | None) -> list[AuthenticatorTransport] | None:
    """The transports a registration reported, as hints for the browser. Values this library does not
    know are dropped rather than failing the ceremony: a transport is advice about which radio to try,
    and a browser newer than the library may well report one."""
    known = {t.value: t for t in AuthenticatorTransport}
    values = [known[v] for v in (json.loads(stored) if stored else []) if v in known]
    return values or None


def register_credential(
    user: dict,
    *,
    credential: dict,
    challenge: str,
    rp_id: str,
    origin: str,
    label: str | None = None,
) -> dict:
    """Verify a completed registration and store the credential against this user."""
    try:
        verified = webauthn.verify_registration_response(
            credential=credential,
            expected_challenge=webauthn.base64url_to_bytes(challenge),
            expected_rp_id=rp_id,
            expected_origin=origin,
            require_user_verification=True,
        )
    except InvalidRegistrationResponse as exc:
        raise PasskeyRejected(f"That passkey could not be registered: {exc}")

    credential_id = bytes_to_base64url(verified.credential_id)
    if get_app_passkey_by_credential(credential_id):
        # `exclude_credentials` asks the authenticator not to re-register one it already holds, but that
        # is a request to a device rather than a guarantee to the server, and the same credential
        # arriving twice must not become two rows that disagree about the sign counter.
        raise PasskeyRejected("That passkey is already registered")

    transports = (credential.get("response") or {}).get("transports")
    return add_app_passkey(
        user["id"],
        credential_id=credential_id,
        public_key=bytes_to_base64url(verified.credential_public_key),
        sign_count=verified.sign_count,
        transports=json.dumps(transports) if transports else None,
        label=(label or "").strip() or None,
        rp_id=rp_id,
    )


def verify_assertion(*, credential: dict, challenge: str, rp_id: str, origin: str) -> dict:
    """Verify a sign-in assertion and return the account it authenticates.

    Raises `PasskeyRejected` for every failure. The ids are no secret — the sign-in options list them —
    so the messages are worded for the person at the screen, who needs to know what to do rather than
    which check said no.
    """
    credential_id = credential.get("id") or ""
    stored = get_app_passkey_by_credential(credential_id)
    if not stored or stored["user_status"] != "active":
        raise PasskeyRejected("That passkey is not registered here")

    try:
        verified = webauthn.verify_authentication_response(
            credential=credential,
            expected_challenge=webauthn.base64url_to_bytes(challenge),
            expected_rp_id=rp_id,
            expected_origin=origin,
            credential_public_key=webauthn.base64url_to_bytes(stored["public_key"]),
            credential_current_sign_count=stored["sign_count"],
            require_user_verification=True,
        )
    except InvalidAuthenticationResponse as exc:
        raise PasskeyRejected(f"That passkey did not verify: {exc}")

    # The WebAuthn verification procedure's owner check, which the library leaves to the caller: a user
    # handle that comes back must be the one this credential's owner was registered under. It is not
    # covered by the signature, so this is a consistency check rather than a cryptographic one — but it is
    # what refuses a passkey registered under the account id itself, the handle the vault uses and the one
    # sign-in passkeys stopped sharing (`sign_in_user_handle`), instead of letting it sign in regardless.
    user_handle = (credential.get("response") or {}).get("userHandle")
    if user_handle and webauthn.base64url_to_bytes(user_handle) != sign_in_user_handle(stored["user_id"]):
        raise PasskeyRejected(
            "That passkey does not match its account here. Remove it under Security in Settings and add it again."
        )

    # A counter that stayed at 0 is not a regression: an authenticator is free to keep no counter at
    # all, and the platform ones backed by a synced keychain do exactly that. `py_webauthn` already
    # refuses a genuine regression above; this only decides what is worth writing back.
    record_app_passkey_use(stored["id"], max(verified.new_sign_count, stored["sign_count"]), rp_id)
    return stored


def registered_passkeys(user_id: str) -> list[dict]:
    """What the settings list renders: one entry per device, with no key material."""
    entries = []
    for row in list_app_passkeys(user_id):
        entry = dict(row)
        entry["transports"] = json.loads(row["transports"]) if row["transports"] else []
        entries.append(entry)
    return entries
