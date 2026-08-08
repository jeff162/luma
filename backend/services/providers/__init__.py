# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Provider-adapter registry: `get_adapter(provider)` is the one lookup the routers/sync path use to reach
an aggregator, so adding Teller or SimpleFIN is registering an adapter here, not touching the callers.
"""

from __future__ import annotations

from backend.services.providers.base import ProviderAdapter
from backend.services.providers.config import (
    get_provider_config_status,
    resolve_app_config,
    set_provider_config,
)
from backend.services.providers.plaid import PlaidAdapter
from backend.services.providers.simplefin import SimpleFinAdapter


class UnknownProviderError(ValueError):
    """No adapter is registered for the requested provider discriminator."""


_ADAPTERS: dict[str, ProviderAdapter] = {
    PlaidAdapter.provider: PlaidAdapter(),
    SimpleFinAdapter.provider: SimpleFinAdapter(),
}


def get_adapter(provider: str) -> ProviderAdapter:
    try:
        return _ADAPTERS[provider]
    except KeyError as exc:
        raise UnknownProviderError(f"no adapter registered for provider {provider!r}") from exc


def supported_providers() -> list[str]:
    return sorted(_ADAPTERS)


__all__ = [
    "ProviderAdapter", "get_adapter", "supported_providers", "UnknownProviderError",
    "resolve_app_config", "set_provider_config", "get_provider_config_status",
]
