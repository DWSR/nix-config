"""In-process LiteLLM callback that supplies a Session Identity for Fabro.

Fabro sends its conversation discriminator as a ``prompt_cache_key`` in the
request body, while LiteLLM's router reads ``metadata.session_id``. This
callback bridges the two: when no client session header already produced an
identity, it turns the body key into a namespaced ``bridge:v1:...`` identity
and removes the key from the outbound request. It runs inside the gateway
process, next to ``litellm_session_identity``, and never raises so malformed
input can only lose affinity, never fail the request.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from litellm.integrations.custom_logger import CustomLogger

from litellm_session_identity import derive_session_identity, existing_session_id

_CACHE_KEY = "prompt_cache_key"
_USER_AGENT = "user-agent"


def _lookup_header(headers: Any, name: str) -> str | None:
    """Return a header value by case-insensitive name, or ``None``.

    LiteLLM snapshots the inbound request headers as a mapping, but tests and
    other callers may hand over a sequence of ``(name, value)`` pairs. Values
    that are not strings are ignored rather than coerced.
    """
    target = name.lower()
    if isinstance(headers, Mapping):
        for key, value in headers.items():
            if isinstance(key, str) and key.lower() == target and isinstance(value, str):
                return value
        return None
    if isinstance(headers, Sequence) and not isinstance(headers, (str, bytes, bytearray)):
        for item in headers:
            if isinstance(item, (tuple, list)) and len(item) == 2:
                key, value = item
                if isinstance(key, str) and key.lower() == target and isinstance(value, str):
                    return value
    return None


def _remove_cache_key(data: dict) -> None:
    """Drop ``prompt_cache_key`` from the outbound body and its proxy snapshot."""
    data.pop(_CACHE_KEY, None)
    proxy_request = data.get("proxy_server_request")
    if isinstance(proxy_request, Mapping):
        body = proxy_request.get("body")
        if isinstance(body, dict):
            body.pop(_CACHE_KEY, None)


def _user_agent(data: dict) -> str | None:
    """Read the request User-Agent from the proxy's request snapshot."""
    proxy_request = data.get("proxy_server_request")
    if not isinstance(proxy_request, Mapping):
        return None
    return _lookup_header(proxy_request.get("headers"), _USER_AGENT)


def _session_id_holder(data: dict, key: str, *, create: bool) -> dict | None:
    """Return a writable metadata mapping, optionally creating it.

    ``metadata`` is the request's canonical holder and is created when absent;
    ``litellm_metadata`` is only extended when LiteLLM already supplied it.
    A present value that is not a mapping is left untouched: overwriting an
    unexpected shape could break the rest of the request pipeline.
    """
    holder = data.get(key)
    if isinstance(holder, dict):
        return holder
    if holder is None and create:
        holder = {}
        data[key] = holder
        return holder
    return None


class SessionIdentityBridge(CustomLogger):
    """Promote Fabro's body cache key into ``metadata.session_id``."""

    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict,
        call_type: Any,
    ) -> dict:
        """Return ``data`` either untouched or with the bridged session identity.

        Header-derived identities win: LiteLLM writes them before this hook,
        so any existing non-empty ``session_id`` short-circuits the bridge and
        leaves the body key in place.
        """
        if not isinstance(data, dict):
            return data
        try:
            metadata = data.get("metadata")
            litellm_metadata = data.get("litellm_metadata")
            if existing_session_id([metadata, litellm_metadata]) is not None:
                return data
            if _CACHE_KEY not in data:
                return data

            raw_key = data.get(_CACHE_KEY)
            _remove_cache_key(data)

            identity = derive_session_identity(raw_key, _user_agent(data))
            if identity is not None:
                for holder in (
                    _session_id_holder(data, "metadata", create=True),
                    _session_id_holder(data, "litellm_metadata", create=False),
                ):
                    if holder is not None:
                        holder["session_id"] = identity
        except Exception:
            # A proxy request must never fail because affinity input was odd.
            pass
        return data


proxy_handler_instance = SessionIdentityBridge()
