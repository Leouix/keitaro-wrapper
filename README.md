# Keitaro Wrapper API

Обёртка над Admin API Keitaro (https://tlgk.host): аутентификация по `Api-Key`,
кэш кампаний в SQLite, устойчивость к недоступности Keitaro.

## Быстрый старт

```bash
cp .env.example .env   # вписать настоящий KEITARO_API_KEY (ключ не хранится в репо)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

## Тесты

```bash
pytest -q
```

## API base

- Основной путь — legacy `/admin_api/v1`: работает без белого списка IP
  (проверено 2026-11-16: список кампаний и кампания 211903 = test_leo_camp_1, alias tMsV2N).
- `/admin/api/v1` — новый Admin API, фолбэк через env `KEITARO_API_BASE_FALLBACK`
  и параметр `v2=True` у методов клиента; сейчас с нашего egress IP отдаёт
  403-страницу логина, включится, когда IP добавят в белый список.
- Маппинг ошибок: 403 с JSON `{"error": ...}` → 403 обёртки с текстом Keitaro
  (у ключа права только на кампании); 403 с HTML-страницей логина → 502
  «blocked for this IP».

## Эндпоинты

- `GET /healthz`
- `GET /healthz/keitaro` — пинг Keitaro
- `GET /api/campaigns/by-name/{name}`
- `GET /api/campaigns/{campaign_id}`
