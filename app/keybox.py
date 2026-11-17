"""Хранение и маскирование API-ключа Keitaro.

Ключ никогда не попадает в ответы API, логи и БД: только файл
`.keitaro_api_key` (0600) в корне проекта или переменная окружения
KEITARO_API_KEY из .env как дефолт.
"""

import os
from pathlib import Path

from fastapi import Depends

from .config import get_settings

PROJECT_ROOT = Path(__file__).resolve().parent.parent
KEY_FILE = PROJECT_ROOT / ".keitaro_api_key"

MIN_KEY_LENGTH = 16


class KeyStore:
    """Чтение/запись файла ключа с правами 0600."""

    def __init__(self, path: Path):
        self.path = path

    def read(self) -> str | None:
        try:
            value = self.path.read_text(encoding="utf-8").strip()
        except (FileNotFoundError, NotADirectoryError):
            return None
        except OSError:
            # Файл нечитаем (права/диск) — считаем «не настроено».
            # Содержимое никогда не попадает в исключение наружу.
            return None
        return value or None

    def write(self, key: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(key + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)
        # replace() не сохраняет права исходника, поэтому chmod ещё раз.
        os.chmod(self.path, 0o600)


def get_key_store() -> KeyStore:
    return KeyStore(KEY_FILE)


def mask_key(key: str) -> str:
    """Первые 4 и последние 4 символа. Короткий ключ не раскрываем вовсе."""
    if len(key) >= 10:
        return f"{key[:4]}…{key[-4:]}"
    return "…"


def resolve_key(store: KeyStore | None = None) -> tuple[str, str] | None:
    """Активный ключ и его источник ('file' | 'env') либо None."""
    store = store or get_key_store()
    file_key = store.read()
    if file_key:
        return file_key, "file"
    env_key = (get_settings().keitaro_api_key or "").strip()
    if env_key:
        return env_key, "env"
    return None
