from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    keitaro_api_key: str
    keitaro_api_key_fallback: str | None = None
    keitaro_base_url: str = "https://tlgk.host"
    # Единственный путь: legacy /admin_api/v1, работает без белого списка IP.
    keitaro_api_base: str = "https://tlgk.host/admin_api/v1"
    keitaro_timeout: float = 10.0
    keitaro_retries: int = 1
    database_url: str = "sqlite:///./keitaro_wrapper.db"

    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()
