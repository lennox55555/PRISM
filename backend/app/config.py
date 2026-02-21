"""
Application configuration settings.
Load environment variables and define configuration constants.
"""

from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # API Settings
    app_name: str = "Voice to SVG Visualization API"
    debug: bool = True

    # CORS Settings
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # OpenAI / LLM Settings
    openai_api_key: str = ""
    llm_model: str = "gpt-4"

    # Speech-to-Text Settings
    # Options: "openai_whisper", "google", "deepgram"
    stt_provider: str = "openai_whisper"

    # Audio Settings
    sample_rate: int = 16000
    chunk_size: int = 1024

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
