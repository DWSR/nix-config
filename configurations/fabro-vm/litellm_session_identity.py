"""Pure session-identity rules for the LiteLLM affinity bridge.

The gateway copies this module verbatim next to the proxy config and imports
it from ``PYTHONPATH``; it therefore imports only the Python standard library
and must never raise on malformed request input.

A body-derived identity always has the shape
``bridge:v1:<producer>:<sha256 hex of the stripped key>``. The namespace keeps
an identical raw key from different producers apart, and the prefix cannot
collide with a client-supplied ``ses_...`` header value.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import hashlib
import re

BRIDGE_PREFIX = "bridge:v1:"
MAX_KEY_LENGTH = 512
MAX_PRODUCER_LENGTH = 32

# Anything outside the safe producer alphabet is removed before namespacing.
_PRODUCER_UNSAFE = re.compile(r"[^a-z0-9._-]")


def existing_session_id(metadata_dicts: Sequence[Mapping]) -> str | None:
    """Return the first non-empty string ``session_id``, else ``None``.

    LiteLLM's header extraction writes the client session header into these
    mappings, so the first usable value is the header-derived identity and
    must take precedence over any body cache key.
    """
    try:
        for metadata in metadata_dicts:
            if not isinstance(metadata, Mapping):
                continue
            value = metadata.get("session_id")
            if isinstance(value, str) and value.strip():
                return value
    except Exception:
        # A malformed metadata container must not turn a request into an 500.
        return None
    return None


def producer_tag(user_agent: str | None) -> str:
    """Return the sanitized product token from ``User-Agent``.

    The product token is everything before the first ``/``, lowercased and
    reduced to ``[a-z0-9._-]``. An absent or unusable value shares the
    ``unknown`` namespace.
    """
    if not isinstance(user_agent, str):
        return "unknown"
    try:
        product = user_agent.split("/", 1)[0].lower()
        tag = _PRODUCER_UNSAFE.sub("", product)[:MAX_PRODUCER_LENGTH]
    except Exception:
        return "unknown"
    return tag or "unknown"


def derive_session_identity(
    prompt_cache_key: object, user_agent: str | None
) -> str | None:
    """Derive a namespaced session identity from a body cache key.

    Returns ``None`` for anything that is not a string, is blank after
    stripping, exceeds 512 characters, or carries CR, LF, or NUL bytes.
    Otherwise returns ``bridge:v1:<producer>:<sha256 hex of stripped key>``.
    """
    if not isinstance(prompt_cache_key, str):
        return None
    if len(prompt_cache_key) > MAX_KEY_LENGTH:
        return None
    # Check control characters before stripping: stripping would hide a
    # trailing CR or LF and let a malformed key through.
    if "\r" in prompt_cache_key or "\n" in prompt_cache_key or "\x00" in prompt_cache_key:
        return None
    key = prompt_cache_key.strip()
    if not key:
        return None
    try:
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    except UnicodeEncodeError:
        # Lone surrogates cannot be UTF-8 encoded; treat them as malformed.
        return None
    return f"{BRIDGE_PREFIX}{producer_tag(user_agent)}:{digest}"
