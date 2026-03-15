from functools import lru_cache
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    database_url: str = "sqlite:///./screencopilot.db"
    cors_origins: List[str] | str = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # Reasoning/matching mode
    nova_mode: str = "demo"  # demo | bedrock
    aws_region: str = "us-east-1"
    bedrock_nova_lite_model_id: str = "amazon.nova-lite-v1:0"
    bedrock_nova_embed_model_id: str = "amazon.nova-multimodal-embeddings-v1:0"

    # Browser execution mode
    browser_execution_mode: str = "playwright"  # demo | playwright
    playwright_headless: bool = False

    # Optional AWS credentials for local development.
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    aws_session_token: str | None = None

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_cors(cls, value):
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
