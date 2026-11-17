'use strict';

const $ = (id) => document.getElementById(id);

/** fetch + разбор JSON; сетевая ошибка → status 0, исключений наружу нет. */
async function requestJson(url, options = {}) {
  try {
    const res = await fetch(url, options);
    let body = null;
    try { body = await res.json(); } catch (e) { /* не JSON — оставляем null */ }
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    return { status: 0, ok: false, body: null };
  }
}

/** detail от FastAPI бывает строкой или массивом объектов {msg}. */
function detailToText(detail, fallback) {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => (d && d.msg ? String(d.msg) : null)).filter(Boolean);
    if (parts.length) return parts.join('; ');
  }
  return fallback;
}

/* ---------------------------------- Главная ---------------------------------- */

function initHome() {
  const keyInput = $('api-key');
  const saveBtn = $('save-btn');
  const errEl = $('key-error');
  const statusEl = $('key-status');

  let configured = false;

  // Пустое поле при ненастроенном ключе → кнопка неактивна.
  // Пустое поле при настроенном ключе → кнопка активна, просто ведёт на /campaigns.
  function syncButton() {
    saveBtn.disabled = keyInput.value.trim() === '' && !configured;
  }
  syncButton();
  keyInput.addEventListener('input', syncButton);

  function showConfigured(mask) {
    configured = true;
    if (mask) {
      statusEl.hidden = false;
    }
    syncButton();
  }

  (async () => {
    const { ok, body } = await requestJson('/api/settings');
    if (ok && body && body.configured) showConfigured(body.key_masked);
  })();

  $('key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = keyInput.value.trim();

    if (!value) {
      // Ключ уже настроен — просто идём к списку кампаний.
      if (configured) window.location.href = '/campaigns';
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохраняем…';
    keyInput.setAttribute('aria-busy', 'true');
    errEl.hidden = true;

    const { status, body } = await requestJson('/api/settings/api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ api_key: value }),
    });

    if (status === 200 && body && body.configured) {
      // Успех: сразу к списку кампаний, введённое не стираем на случай сбоя перехода.
      keyInput.removeAttribute('aria-invalid');
      window.location.href = '/campaigns';
      return;
    }

    const fallback =
      status === 400 ? 'Ключ отклонён Keitaro, проверьте его значение.' :
      status === 409 ? 'Ключ не сохранён, попробуйте ещё раз.' :
      status === 422 ? 'Ключ слишком короткий или в неверном формате.' :
      status === 502 ? 'Keitaro недоступен, попробуйте позже.' :
      status === 0 ? 'Сеть недоступна, попробуйте ещё раз.' :
      detailToText(body && body.detail, `Не удалось сохранить ключ (код ${status}).`);
    errEl.textContent = fallback;
    errEl.hidden = false;
    keyInput.setAttribute('aria-invalid', 'true');
    keyInput.focus();

    // Возвращаем кнопку в рабочее состояние, введённое значение остаётся.
    saveBtn.disabled = false;
    saveBtn.textContent = 'Далее';
    keyInput.removeAttribute('aria-busy');
  });
}

/* -------------------------------- Кампании --------------------------------- */

function initCampaigns() {
  const loading = $('loading');
  const errorState = $('error-state');
  const errorText = $('error-text');
  const errorActions = $('error-actions');
  const hint = $('hint');
  const emptyState = $('empty-state');
  const tableBlock = $('table-block');
  const tbody = $('table-body');
  const countEl = $('campaign-count');
  const searchInput = $('campaign-query');

  let timer = null;
  let controller = null;
  let seq = 0;

  function hideAll() {
    loading.hidden = true;
    errorState.hidden = true;
    hint.hidden = true;
    emptyState.hidden = true;
    tableBlock.hidden = true;
  }

  /** Пустое поле — никаких запросов и пустая страница. */
  function showIdle() {
    hideAll();
    hint.hidden = false;
    tbody.replaceChildren();
    countEl.textContent = '';
  }

  function showError(msg, actions = []) {
    hideAll();
    errorText.textContent = msg;
    errorActions.replaceChildren(...actions);
    errorState.hidden = false;
    errorState.focus();
  }

  function homeLink() {
    const a = document.createElement('a');
    a.href = '/';
    a.className = 'link';
    a.textContent = 'Указать API key на главной';
    return a;
  }

  function retryButton(query) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-secondary';
    b.textContent = 'Повторить';
    b.addEventListener('click', () => search(query));
    return b;
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function makeRow(c) {
    const tr = document.createElement('tr');
    const href = `/fb/campaigns/${c.id}/streams`;

    const tdId = document.createElement('td');
    tdId.className = 'num';
    tdId.textContent = String(c.id);

    const tdName = document.createElement('td');
    tdName.className = 'wrap-anywhere';
    const a = document.createElement('a');
    a.className = 'row-link';
    a.href = href;
    a.textContent = c.name || `Кампания ${c.id}`;
    tdName.appendChild(a);
    if (c.alias) {
      const alias = document.createElement('span');
      alias.className = 'alias';
      alias.textContent = c.alias;
      tdName.appendChild(alias);
    }

    const tdGroup = document.createElement('td');
    tdGroup.className = 'wrap-anywhere';
    tdGroup.textContent = c.group || '—';

    const tdState = document.createElement('td');
    tdState.textContent = c.state || '—';

    const tdUpdated = document.createElement('td');
    tdUpdated.textContent = c.updated_at || '—';

    tr.append(tdId, tdName, tdGroup, tdState, tdUpdated);
    return tr;
  }

  /** Каждый ввод — свежий запрос в Keitaro (фильтрация там, на сервере). */
  async function search(query) {
    const mySeq = ++seq;
    if (controller) controller.abort();
    controller = new AbortController();

    hideAll();
    loading.hidden = false;

    const { status, body } = await requestJson(
      `/api/campaigns?query=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal }
    );

    // Ответ на устаревший (или отменённый) запрос — молча выбрасываем.
    if (mySeq !== seq) return;

    if (status !== 200 || !body || !Array.isArray(body.campaigns)) {
      let msg, actions;
      if (status === 409) {
        msg = 'Сначала укажите API key.';
        actions = [homeLink()];
      } else if (status === 502) {
        msg = 'Keitaro недоступен.';
        actions = [retryButton(query)];
      } else if (status === 0) {
        msg = 'Сеть недоступна.';
        actions = [retryButton(query)];
      } else {
        msg = detailToText(body && body.detail, `Ошибка загрузки (код ${status}).`);
        actions = [retryButton(query)];
      }
      showError(msg, actions);
      return;
    }

    hideAll();
    if (!body.campaigns.length) {
      emptyState.textContent = `Ничего не найдено по «${query}».`;
      emptyState.hidden = false;
      return;
    }

    const rows = body.campaigns.map(makeRow);
    tbody.replaceChildren(...rows);
    const n = rows.length;
    countEl.textContent = `Найдено: ${n} ${plural(n, 'кампания', 'кампании', 'кампаний')}`;
    tableBlock.hidden = false;
  }

  function reset() {
    seq += 1;
    if (controller) controller.abort();
    showIdle();
  }

  // Пауза 300 мс, чтобы не дёргать Keitaro на каждую букву.
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    clearTimeout(timer);
    if (!q) {
      reset();
      return;
    }
    timer = setTimeout(() => search(q), 300);
  });

  // Кнопка очистки у <input type="search">.
  searchInput.addEventListener('search', () => {
    if (!searchInput.value.trim()) reset();
  });

  showIdle();
}

/* ----------------------------------- Точка входа ---------------------------------- */

switch (document.body.dataset.page) {
  case 'home': initHome(); break;
  case 'campaigns': initCampaigns(); break;
  case 'streams': initStreams(); break;
}

/* ------------------------------- Потоки кампании ------------------------------ */

function initStreams() {
  const content = $('content');
  const loading = $('loading');
  const errorState = $('error-state');
  const errorText = $('error-text');
  const errorActions = $('error-actions');
  const emptyState = $('empty-state');
  const emptyList = $('empty-streams');
  const tableBlock = $('table-block');
  const tbody = $('table-body');
  const caption = $('table-caption');
  const noOffersLine = $('no-offers-line');
  const title = $('page-title');

  const match = window.location.pathname.match(/^\/fb\/campaigns\/(\d+)\/streams\/?$/);
  if (!match) {
    loading.hidden = true;
    showError('Некорректный адрес: ID кампании должен быть числом.', []);
    return;
  }
  const campaignId = match[1];
  title.textContent = `Потоки кампании ${campaignId}`;
  document.title = `Потоки кампании ${campaignId} — Keitaro`;

  function showError(msg, actions = []) {
    errorText.textContent = msg;
    errorActions.replaceChildren(...actions);
    loading.hidden = true;
    emptyState.hidden = true;
    tableBlock.hidden = true;
    noOffersLine.hidden = true;
    errorState.hidden = false;
    errorState.focus();
  }

  function homeLink() {
    const a = document.createElement('a');
    a.href = '/';
    a.className = 'link';
    a.textContent = 'Указать API key на главной';
    return a;
  }

  function campaignsLink() {
    const a = document.createElement('a');
    a.href = '/campaigns';
    a.className = 'link';
    a.textContent = 'К списку кампаний';
    return a;
  }

  function retryButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-secondary';
    b.textContent = 'Повторить';
    b.addEventListener('click', load);
    return b;
  }

  function makeRow({ stream, entry, offer }) {
    const tr = document.createElement('tr');

    const tdOffer = document.createElement('td');
    tdOffer.className = 'wrap-anywhere';
    const idSpan = document.createElement('span');
    idSpan.className = 'offer-id';
    idSpan.textContent = `#${entry.offer_id}`;
    tdOffer.append(idSpan, ' ');
    if (offer) {
      tdOffer.appendChild(document.createTextNode(offer.name || ''));
    } else {
      const em = document.createElement('em');
      em.textContent = 'не удалось загрузить офер';
      tdOffer.appendChild(em);
    }

    const tdState = document.createElement('td');
    tdState.textContent = (offer && offer.state) || entry.state || '—';

    const tdShare = document.createElement('td');
    tdShare.className = 'num';
    tdShare.textContent = entry.share == null ? '—' : `${entry.share}%`;

    const tdStream = document.createElement('td');
    tdStream.className = 'wrap-anywhere';
    tdStream.textContent = stream.name || `Поток ${stream.id}`;

    const tdWeight = document.createElement('td');
    tdWeight.className = 'num';
    tdWeight.textContent = stream.weight == null ? '—' : String(stream.weight);

    const tdPayout = document.createElement('td');
    tdPayout.className = 'num';
    const payout = offer ? Number(offer.payout_value) : 0;
    tdPayout.textContent = payout ? [payout, offer.payout_currency].filter(Boolean).join(' ') : '';

    tr.append(tdOffer, tdState, tdShare, tdStream, tdWeight, tdPayout);
    return tr;
  }

  async function load() {
    errorState.hidden = true;
    emptyState.hidden = true;
    tableBlock.hidden = true;
    noOffersLine.hidden = true;
    loading.hidden = false;
    content.setAttribute('aria-busy', 'true');

    const { status, body } = await requestJson(
      `/api/campaigns/${campaignId}/streams`,
      { headers: { Accept: 'application/json' } }
    );
    content.removeAttribute('aria-busy');

    if (status !== 200 || !Array.isArray(body)) {
      let msg, actions;
      if (status === 409) {
        msg = 'Сначала укажите API key.';
        actions = [homeLink()];
      } else if (status === 404) {
        msg = 'Кампания не найдена.';
        actions = [campaignsLink()];
      } else if (status === 502) {
        msg = 'Keitaro недоступен.';
        actions = [retryButton()];
      } else if (status === 0) {
        msg = 'Сеть недоступна.';
        actions = [retryButton()];
      } else {
        msg = detailToText(body && body.detail, `Ошибка загрузки (код ${status}).`);
        actions = [retryButton()];
      }
      showError(msg, actions);
      return;
    }

    const streams = body;

    // Уникальные offer_id → оферы параллельно; ошибка по одному не рушит остальные.
    const ids = [...new Set(streams.flatMap((s) => (Array.isArray(s.offers) ? s.offers : []).map((o) => o.offer_id)))];
    const results = await Promise.all(
      ids.map(async (id) => {
        const r = await requestJson(`/api/offers/${id}`, { headers: { Accept: 'application/json' } });
        return [id, r.ok ? r.body : null];
      })
    );
    const offers = new Map(results);

    const rows = [];
    const noOfferStreams = [];
    for (const s of streams) {
      const entries = Array.isArray(s.offers) ? s.offers : [];
      if (!entries.length) {
        noOfferStreams.push(s);
        continue;
      }
      for (const entry of entries) {
        rows.push({ stream: s, entry, offer: offers.get(entry.offer_id) ?? null });
      }
    }

    loading.hidden = true;

    if (!rows.length) {
      // Ни у одного потока нет оферов: сообщение + список имён потоков.
      emptyList.replaceChildren(
        ...streams.map((s) => {
          const li = document.createElement('li');
          li.textContent = s.name || `Поток ${s.id}`;
          return li;
        })
      );
      emptyState.hidden = false;
      return;
    }

    caption.textContent = `Потоки и оферы кампании ${campaignId}`;
    tbody.replaceChildren(...rows.map(makeRow));

    if (noOfferStreams.length) {
      noOffersLine.hidden = false;
      noOffersLine.textContent =
        'Без оферов: ' + noOfferStreams.map((s) => s.name || `Поток ${s.id}`).join(', ');
    }
    tableBlock.hidden = false;
  }

  load();
}

/* ----------------------------------- Точка входа ---------------------------------- */

switch (document.body.dataset.page) {
  case 'home': initHome(); break;
  case 'streams': initStreams(); break;
}
