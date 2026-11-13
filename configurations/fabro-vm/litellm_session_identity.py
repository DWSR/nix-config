from __future__ import annotations

import hashlib
import re
from typing import Literal, Mapping, NamedTuple, Optional, Sequence


class Resolution(NamedTuple):
    session_id: str
    source: Literal["header", "body"]


_DISALLOWED_PRODUCER_CHARS = re.compile(r"[^a-z0-9._-]")
_MAX_PRODUCER_LENGTH = 32
_MAX_KEY_LENGTH = 512
_FORBIDDEN_KEY_CHARS = ("\r", "\n", "\x00")


def existing_session_id(metadata_dicts: Sequence[Mapping]) -> Optional[str]:
    try:
        for metadata in metadata_dicts:
            if not isinstance(metadata, Mapping):
                continue
            try:
                value = metadata.get("session_id")
            except Exception:
                continue
            if value is None:
                continue
            try:
                text = str(value)
            except Exception:
                continue
            if text:
                return text
    except Exception:
        return None
    return None


def producer_tag(user_agent: Optional[str]) -> str:
    try:
        if not isinstance(user_agent, str) or not user_agent:
            return "unknown"
        token = _DISALLOWED_PRODUCER_CHARS.sub("", user_agent.split("/", 1)[0].lower())
        return token[:_MAX_PRODUCER_LENGTH] or "unknown"
    except Exception:
        return "unknown"


def derive_session_identity(
    prompt_cache_key: object, user_agent: Optional[str]
) -> Optional[str]:
    try:
        if not isinstance(prompt_cache_key, str):
            return None
        if len(prompt_cache_key) > _MAX_KEY_LENGTH:
            return None
        if any(char in prompt_cache_key for char in _FORBIDDEN_KEY_CHARS):
            return None
        stripped = prompt_cache_key.strip()
        if not stripped:
            return None
        digest = hashlib.sha256(stripped.encode("utf-8")).hexdigest()
        return "bridge:v1:%s:%s" % (producer_tag(user_agent), digest)
    except Exception:
        return None


def resolve_session_identity(
    metadata_dicts: Sequence[Mapping],
    prompt_cache_key: object,
    user_agent: Optional[str],
) -> Optional[Resolution]:
    try:
        existing = existing_session_id(metadata_dicts)
        if existing is not None:
            return Resolution(existing, "header")
        derived = derive_session_identity(prompt_cache_key, user_agent)
        if derived is not None:
            return Resolution(derived, "body")
        return None
    except Exception:
        return None
