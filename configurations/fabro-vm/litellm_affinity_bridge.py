from __future__ import annotations

from collections.abc import Mapping
from typing import Optional

from litellm.integrations.custom_logger import CustomLogger

from litellm_session_identity import resolve_session_identity


def _metadata_dicts(data: Mapping) -> list:
    metadata_dicts = []
    for field in ("litellm_metadata", "metadata"):
        value = data.get(field)
        if isinstance(value, Mapping):
            metadata_dicts.append(value)
    return metadata_dicts


def _user_agent(data: Mapping) -> Optional[str]:
    request = data.get("proxy_server_request")
    if not isinstance(request, Mapping):
        return None
    headers = request.get("headers")
    if not isinstance(headers, Mapping):
        return None
    for name, value in headers.items():
        if isinstance(name, str) and name.lower() == "user-agent":
            return value if isinstance(value, str) else None
    return None


def _request_body(data: Mapping) -> object:
    request = data.get("proxy_server_request")
    if not isinstance(request, Mapping):
        return None
    return request.get("body")


def _drop_body_key(container: object) -> None:
    if isinstance(container, dict):
        container.pop("prompt_cache_key", None)


class SessionIdentityBridge(CustomLogger):
    async def async_pre_call_hook(
        self, user_api_key_dict, cache, data: dict, call_type
    ) -> dict:
        try:
            if not isinstance(data, dict):
                return data
            resolution = resolve_session_identity(
                _metadata_dicts(data), data.get("prompt_cache_key"), _user_agent(data)
            )
            if resolution is None:
                _drop_body_key(data)
                _drop_body_key(_request_body(data))
                return data
            if resolution.source == "header":
                return data
            body = _request_body(data)
            _drop_body_key(data)
            _drop_body_key(body)
            metadata = data.get("metadata")
            if not isinstance(metadata, dict):
                metadata = {}
                data["metadata"] = metadata
            metadata["session_id"] = resolution.session_id
            litellm_metadata = data.get("litellm_metadata")
            if isinstance(litellm_metadata, dict):
                litellm_metadata["session_id"] = resolution.session_id
            return data
        except Exception:
            return data


proxy_handler_instance = SessionIdentityBridge()
