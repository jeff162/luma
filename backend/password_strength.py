# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
How hard a secret would be to guess: the one estimator behind both the vault passphrase floor
(`services/crypto_service.py`) and the "Strong" sign-in password policy (`db/control_database.py`), so the
app has a single meaning of strong (`docs/security-model.md` -> *Best practices*).

zxcvbn scores 0-4 from its own dictionaries, offline. It catches what a length or character-class rule
cannot — dictionary words, repeats, keyboard runs, substitutions — and a character-class rule, which NIST
SP 800-63B advises against, accepts `Password1234567!`.
"""

from importlib.metadata import version as _distribution_version

from zxcvbn import zxcvbn

# The top score: "strong protection from an offline slow-hash attack".
TOP_SCORE = 4

# The installed estimator release, since a new one can move a score as surely as a new threshold can.
ESTIMATOR_VERSION = _distribution_version("zxcvbn")

# zxcvbn refuses longer input, because its matching cost grows with length, so a longer secret is judged on
# its first this-many characters. A guessable one shows itself well within that.
_MAX_CHARS = 72


def estimate(secret: str) -> dict:
    """`score` (0-4), and the estimator's own `warning` and `suggestions`, which say what made a secret
    guessable — advice someone can act on where a bare refusal is not."""
    if not secret:
        return {"score": 0, "warning": "", "suggestions": []}
    result = zxcvbn(secret[:_MAX_CHARS])
    feedback = result.get("feedback") or {}
    return {
        "score": result["score"],
        "warning": feedback.get("warning") or "",
        "suggestions": list(feedback.get("suggestions") or []),
    }


def is_strong(secret: str) -> bool:
    return estimate(secret)["score"] >= TOP_SCORE
