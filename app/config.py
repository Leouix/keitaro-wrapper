from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Ключ здесь не хранится: единственный источник — файл .keitaro_api_key
    # (ключ, введённый пользователем через UI). Без него data-эндпоинты
    # отвечают 409 «API key is not configured».
    keitaro_base_url: str = "https://tlgk.host"
    # Единственный путь: legacy /admin_api/v1, работает без белого списка IP.
    keitaro_api_base: str = "https://tlgk.host/admin_api/v1"
    keitaro_timeout: float = 10.0
    keitaro_retries: int = 1
    database_url: str = "sqlite:///./keitaro_wrapper.db"

    # SettingsConfigDict вместо class Config: class-based конфиг помечен
    # deprecated в Pydantic V2 и будет удалён в V3.
    model_config = SettingsConfigDict(env_file=".env")


@lru_cache
def get_settings() -> Settings:
    return Settings()
