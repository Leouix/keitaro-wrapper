# Keitaro Wrapper API

Обёртка над Admin API Keitaro (https://tlgk.host): аутентификация по `Api-Key`,
кэш кампаний в SQLite, устойчивость к недоступности Keitaro.

Документация апи: https://tlgk.host/admin/

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

- Единственный путь — legacy `/admin_api/v1`: работает без белого списка IP
  (проверено 2026-11-16: список кампаний и кампания 211903 = test_leo_camp_1, alias tMsV2N).
- `/admin/api/v1` (новый Admin API) поддерживать перестали: с нашего egress IP он
  отдаёт 403-страницу логина, поэтому фолбэка нет.
- Маппинг ошибок: 403 с JSON `{"error": ...}` → 403 обёртки с текстом Keitaro
  (у ключа права только на кампании); 403 с HTML-страницей логина → 502
  «blocked for this IP».

## Эндпоинты

- `GET /healthz`
- `GET /healthz/keitaro` — пинг Keitaro
- `GET /api/campaigns/by-name/{name}`
- `GET /api/campaigns/{campaign_id}`
- `GET /api/campaigns/{campaign_id}/streams` — потоки кампании, тело как у Keitaro;
  только положительный int; без настроенного ключа — `409 {"detail": "API key is not configured"}`
- `GET /api/offers/{offer_id}` — офер, тело как у Keitaro; только положительный int

## Хранение API-ключа

- Дефолт — `KEITARO_API_KEY` из `.env` (источник `env`).
- Ключ, сохранённый через `POST /api/settings/api-key`, лежит в файле
  `.keitaro_api_key` (0600) в корне проекта (источник `file`) и перекрывает .env.
  Файл в `.gitignore`; в SQLite ключ не пишется.
- `GET /api/settings` → `{"configured", "key_masked" ("8510…e834"), "source": "file"|"env"|null}`;
  полный ключ не возвращается никогда.
- `POST /api/settings/api-key` `{"api_key": "..."}`: ключ проверяется живым
  `GET /campaigns` и сохраняется только при успехе. `400` — Keitaro отверг ключ
  (401/403/HTML-логин), `502` — Keitaro недоступен, `422` — пустой/короткий (<16) ключ.
- Ключ не логируется и не попадает в трейсы ошибок.

## Фронтенд

- `GET /` → `web/index.html`, `GET /fb/campaigns/{id}/streams` → `web/streams.html`,
  `GET /assets/{name}` → статика из `web/` (один уровень, скрытые файлы отдаются 404).
- Браузер ходит в Keitaro только через этот сервис, ключ в JS не попадает.
- Файлы `web/**` — зона Pixel.

