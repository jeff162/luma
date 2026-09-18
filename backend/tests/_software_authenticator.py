# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A WebAuthn authenticator in software, for testing passkey sign-in.

It produces exactly the bytes a browser hands back from `navigator.credentials.create()` and `.get()`,
so the endpoints under test run their real verification against real signatures. Every parameter a test
might want to get *wrong* — the origin, the RP id, the signing key, the user-verification flag, the sign
counter — is an argument here, because a guard is only proven by watching it refuse.
"""

import hashlib
import json
import os

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

FLAG_USER_PRESENT = 0x01
FLAG_USER_VERIFIED = 0x04
FLAG_ATTESTED_DATA = 0x40


def b64url(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


class SoftwareAuthenticator:
    """One credential on one imaginary device."""

    def __init__(self, *, user_handle: bytes = b"user", sign_count: int = 0):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = os.urandom(32)
        self.user_handle = user_handle
        self.sign_count = sign_count

    @property
    def cose_public_key(self) -> bytes:
        numbers = self.key.public_key().public_numbers()
        return cbor2.dumps({
            1: 2,    # kty: EC2
            3: -7,   # alg: ES256
            -1: 1,   # crv: P-256
            -2: numbers.x.to_bytes(32, "big"),
            -3: numbers.y.to_bytes(32, "big"),
        })

    def _client_data(self, *, ceremony: str, challenge: str, origin: str) -> bytes:
        # The challenge is echoed exactly as the server sent it (base64url), which is what the browser
        # does — re-encoding it here would make every test fail for a reason unrelated to its subject.
        return json.dumps({
            "type": ceremony,
            "challenge": challenge,
            "origin": origin,
            "crossOrigin": False,
        }, separators=(",", ":")).encode()

    def _authenticator_data(self, *, rp_id: str, flags: int, attested: bytes = b"") -> bytes:
        return (
            hashlib.sha256(rp_id.encode()).digest()
            + bytes([flags])
            + self.sign_count.to_bytes(4, "big")
            + attested
        )

    def create(self, *, rp_id: str, challenge: str, origin: str, user_verified: bool = True) -> dict:
        client_data = self._client_data(ceremony="webauthn.create", challenge=challenge, origin=origin)
        attested = (
            b"\x00" * 16                                     # AAGUID: none, as an unattested credential
            + len(self.credential_id).to_bytes(2, "big")
            + self.credential_id
            + self.cose_public_key
        )
        flags = FLAG_USER_PRESENT | FLAG_ATTESTED_DATA | (FLAG_USER_VERIFIED if user_verified else 0)
        auth_data = self._authenticator_data(rp_id=rp_id, flags=flags, attested=attested)
        attestation = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})
        return {
            "id": b64url(self.credential_id),
            "rawId": b64url(self.credential_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(client_data),
                "attestationObject": b64url(attestation),
                "transports": ["internal"],
            },
            "clientExtensionResults": {},
        }

    def get(
        self,
        *,
        rp_id: str,
        challenge: str,
        origin: str,
        user_verified: bool = True,
        signing_key=None,
        sign_count: int | None = None,
    ) -> dict:
        if sign_count is not None:
            self.sign_count = sign_count
        else:
            self.sign_count += 1
        client_data = self._client_data(ceremony="webauthn.get", challenge=challenge, origin=origin)
        flags = FLAG_USER_PRESENT | (FLAG_USER_VERIFIED if user_verified else 0)
        auth_data = self._authenticator_data(rp_id=rp_id, flags=flags)
        key = signing_key or self.key
        signature = key.sign(
            auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256())
        )
        return {
            "id": b64url(self.credential_id),
            "rawId": b64url(self.credential_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(client_data),
                "authenticatorData": b64url(auth_data),
                "signature": b64url(signature),
                "userHandle": b64url(self.user_handle),
            },
            "clientExtensionResults": {},
        }
