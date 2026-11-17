# Keitaro Wrapper API

Обёртка над Admin API Keitaro (https://tlgk.host): аутентификация по `Api-Key`,
кэш кампаний в SQLite, устойчивость к недоступности Keitaro.

Документация апи: https://tlgk.host/admin/

## Локальный запуск

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8011

cd frontend && npm ci && npm run dev


### Порты

| Порт | Кто его занимает | Что открывать в браузере |
|---|---|---|
| **8011** | uvicorn обёртки | интерфейс + API — в нём всё вместе |
| **8010** | Vite dev (`npm run dev`) | только при разработке фронта, `/api` проксируется на 8011 |
| 8012 | `npm run preview` | проверка прод-сборки, тоже проксирует на 8011 |
