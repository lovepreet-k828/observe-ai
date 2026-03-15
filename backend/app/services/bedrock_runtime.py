from __future__ import annotations

import json
from typing import Any, Dict

from app.core.config import get_settings


class BedrockRuntime:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._client = None

    def is_enabled(self) -> bool:
        return self.settings.nova_mode == "bedrock"

    def _get_client(self):
        if self._client is not None:
            return self._client
        try:
            import boto3
        except Exception:
            return None

        kwargs: Dict[str, Any] = {"region_name": self.settings.aws_region}
        if self.settings.aws_access_key_id and self.settings.aws_secret_access_key:
            kwargs["aws_access_key_id"] = self.settings.aws_access_key_id
            kwargs["aws_secret_access_key"] = self.settings.aws_secret_access_key
        if self.settings.aws_session_token:
            kwargs["aws_session_token"] = self.settings.aws_session_token

        self._client = boto3.client("bedrock-runtime", **kwargs)
        return self._client

    def converse_json(self, model_id: str, system_prompt: str, user_payload: Dict[str, Any]) -> Dict[str, Any] | None:
        client = self._get_client()
        if client is None:
            return None
        try:
            response = client.converse(
                modelId=model_id,
                system=[{"text": system_prompt}],
                messages=[
                    {
                        "role": "user",
                        "content": [{"text": json.dumps(user_payload)}],
                    }
                ],
                inferenceConfig={"temperature": 0.1, "maxTokens": 3000},
            )
            content = response.get("output", {}).get("message", {}).get("content", [])
            text = "".join(block.get("text", "") for block in content if isinstance(block, dict))
            return json.loads(text) if text else None
        except Exception:
            return None
