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
  const tableBlock = $('table-block');
  const tbody = $('table-body');
  const caption = $('table-caption');
  const noOffersLine = $('no-offers-line');
  const title = $('page-title');

  const toolbar = $('offer-toolbar');
  const offerIdInput = $('offer-id');
  const offerHint = $('offer-hint');
  const streamSelect = $('stream-select');
  const streamsHint = $('streams-hint');
  const addBtn = $('add-btn');
  const sendBtn = $('send-btn');
  const sendStatus = $('send-status');

  const match = window.location.pathname.match(/^\/fb\/campaigns\/(\d+)\/streams\/?$/);
  if (!match) {
    loading.hidden = true;
    showError('Некорректный адрес: ID кампании должен быть числом.', []);
    return;
  }
  const campaignId = match[1];
  console.log('match', match)
  title.textContent = `Потоки кампании ${campaignId}`;
  document.title = `Потоки кампании ${campaignId} — Keitaro`;

  let streamsData = [];      // потоки с сервера (последний load())
  let offersMap = new Map(); // offer_id -> тело офера
  let foundOffer = null;     // офер, найденный живым поиском
  let draft = [];            // [{ streamId, offer }] — локальный черновик
  let sending = false;

  let offerSearchTimer = null;
  let offerSearchController = null;
  let offerSearchSeq = 0;

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

  function makeRow({ stream, entry, offer, share, isDraft }) {
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
    if (isDraft) {
      const badge = document.createElement('span');
      badge.className = 'draft-badge';
      badge.textContent = 'черновик';
      tdOffer.append(' ', badge);
    }

    const tdState = document.createElement('td');
    tdState.textContent = (offer && offer.state) || entry.state || '—';

    const tdShare = document.createElement('td');
    tdShare.className = 'num';
    tdShare.textContent = share == null ? '—' : `${share}%`;

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

  /** Таблица: данные сервера + локальный черновик; для затронутых потоков доли пересчитаны. */
  function renderTable() {
    const rows = [];
    const noOfferNames = [];
    for (const s of streamsData) {
      const entries = Array.isArray(s.offers) ? s.offers : [];
      const streamDraft = draft.filter((d) => d.streamId === s.id);
      if (!entries.length && !streamDraft.length) {
        noOfferNames.push(s.name || `Поток ${s.id}`);
        continue;
      }
      // Пересчёт долей только у затронутого потока: объединённый список
      // (существующие + черновик) получает share = floor(100 / n), порядок сохранён.
      const hasDraft = streamDraft.length > 0;
      const share = hasDraft ? Math.floor(100 / (entries.length + streamDraft.length)) : null;
      for (const entry of entries) {
        rows.push({
          stream: s,
          entry,
          offer: offersMap.get(entry.offer_id) ?? null,
          share: hasDraft ? share : (entry.share == null ? null : entry.share),
          isDraft: false,
        });
      }
      for (const d of streamDraft) {
        rows.push({ stream: s, entry: { offer_id: d.offer.id, share }, offer: d.offer, share, isDraft: true });
      }
    }

    caption.textContent = `Потоки и оферы кампании ${campaignId}`;
    tbody.replaceChildren(...rows.map(makeRow));

    noOffersLine.hidden = noOfferNames.length === 0;
    if (noOfferNames.length) {
      noOffersLine.textContent = 'Без оферов: ' + noOfferNames.join(', ');
    }
  }

  /** В select — только потоки со схемой landings: только они принимают оферы. */
  function populateStreamSelect() {
    const landings = streamsData.filter((s) => s.schema === 'landings');
    const prev = streamSelect.value;
    streamSelect.replaceChildren(
      ...landings.map((s) => {
        const opt = document.createElement('option');
        opt.value = String(s.id);
        opt.textContent = s.name || `Поток ${s.id}`;
        return opt;
      })
    );
    streamsHint.hidden = landings.length > 0;
    streamSelect.disabled = landings.length === 0;
    if (landings.length) {
      if (landings.some((s) => String(s.id) === prev)) streamSelect.value = prev;
      else streamSelect.selectedIndex = 0;
    }
    syncDraftButtons();
  }

  function isDuplicate(streamId, offerId) {
    const s = streamsData.find((x) => x.id === streamId);
    if (s && Array.isArray(s.offers) && s.offers.some((o) => o.offer_id === offerId)) return true;
    return draft.some((d) => d.streamId === streamId && d.offer.id === offerId);
  }

  function syncDraftButtons() {
    const streamId = Number(streamSelect.value || 0);
    const duplicate = foundOffer && streamId ? isDuplicate(streamId, foundOffer.id) : false;

    addBtn.disabled = sending || !foundOffer || !streamId || duplicate;
    addBtn.title = sending ? 'Идёт отправка…'
      : !foundOffer ? 'Сначала найдите офер по ID'
      : !streamId ? 'Выберите поток'
      : duplicate ? 'Этот офер уже есть в выбранном потоке или в черновике'
      : 'Добавляется только в локальный черновик — до «Отправить в Кейтаро» ничего не уходит на сервер';

    sendBtn.disabled = sending || draft.length === 0;
    sendBtn.title = sending ? 'Идёт отправка…'
      : draft.length === 0 ? 'Сначала добавьте офер в черновик кнопкой «Добавить»'
      : '';
  }

  function setOfferHint(text, kind) {
    offerHint.textContent = text;
    offerHint.className = kind ? `offer-hint ${kind}` : 'offer-hint';
  }

  function resetOfferSearch() {
    foundOffer = null;
    setOfferHint('Введите ID оффера');
    syncDraftButtons();
  }

  async function searchOffer(idStr) {
    const mySeq = ++offerSearchSeq;
    offerSearchController = new AbortController();
    const { status, body } = await requestJson(`/api/offers/${idStr}`, {
      headers: { Accept: 'application/json' },
      signal: offerSearchController.signal,
    });

    // Ответ на устаревший (или отменённый) запрос — молча выбрасываем.
    if (mySeq !== offerSearchSeq) return;
    offerSearchController = null;

    if (status === 200 && body && body.id != null) {
      foundOffer = body;
      let text = `#${body.id}${body.name ? ` — ${body.name}` : ''}`;
      const payout = Number(body.payout_value);
      if (payout) text += ` · ${payout}${body.payout_currency ? ` ${body.payout_currency}` : ''}`;
      if (body.state) text += ` · ${body.state}`;
      setOfferHint(text, 'offer-hint-found');
    } else if (status === 404) {
      foundOffer = null;
      setOfferHint(`Офер с ID ${parseInt(idStr, 10)} не найден`, 'offer-hint-error');
    } else if (status === 409) {
      foundOffer = null;
      setOfferHint('Сначала укажите API key на главной.', 'offer-hint-error');
    } else if (status === 502) {
      foundOffer = null;
      setOfferHint('Keitaro недоступен, попробуйте позже.', 'offer-hint-error');
    } else if (status === 0) {
      foundOffer = null;
      setOfferHint('Сеть недоступна, попробуйте ещё раз.', 'offer-hint-error');
    } else {
      foundOffer = null;
      setOfferHint(detailToText(body && body.detail, `Не удалось найти офер (код ${status}).`), 'offer-hint-error');
    }
    syncDraftButtons();
  }

  // Пауза 300 мс; в поле остаются только цифры положительного целого.
  offerIdInput.addEventListener('input', () => {
    const digits = offerIdInput.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    if (digits !== offerIdInput.value) offerIdInput.value = digits;

    // Любое новое ввод: устаревшие ответы и таймер больше не нужны.
    offerSearchSeq += 1;
    clearTimeout(offerSearchTimer);
    if (offerSearchController) {
      offerSearchController.abort();
      offerSearchController = null;
    }

    if (!digits) {
      resetOfferSearch();
      return;
    }

    setOfferHint('Ищем оффер…');
    offerSearchTimer = setTimeout(() => searchOffer(digits), 300);
  });

  // Кнопка очистки у <input type="search">.
  offerIdInput.addEventListener('search', () => {
    if (!offerIdInput.value) {
      offerSearchSeq += 1;
      clearTimeout(offerSearchTimer);
      if (offerSearchController) {
        offerSearchController.abort();
        offerSearchController = null;
      }
      resetOfferSearch();
    }
  });

  streamSelect.addEventListener('change', syncDraftButtons);

  addBtn.addEventListener('click', () => {
    if (addBtn.disabled || !foundOffer) return;
    const streamId = Number(streamSelect.value || 0);
    if (!streamId) return;
    draft.push({ streamId, offer: foundOffer });
    renderTable();
    syncDraftButtons();
  });

  function sendErrorText(status, body) {
    if (status === 404) return detailToText(body && body.detail, 'Поток или офер не найден.');
    if (status === 403) return detailToText(body && body.detail, 'Ключ не даёт прав на изменение потока.');
    if (status === 502) return 'Keitaro недоступен.';
    if (status === 0) return 'Сеть недоступна.';
    return detailToText(body && body.detail, `Ошибка отправки (код ${status}).`);
  }

  sendBtn.addEventListener('click', async () => {
    if (sendBtn.disabled) return;
    const sendHadFocus = document.activeElement === sendBtn;
    sending = true;
    toolbar.setAttribute('aria-busy', 'true');
    syncDraftButtons();
    sendStatus.hidden = true;

    let added = 0;
    let failed = 0;
    const errors = [];
    const remaining = [];
    // Только здесь и только POST /api/streams/{id}/offers — «Добавить» ничего не отправляет.
    for (const item of draft) {
      const { status, body } = await requestJson(`/api/streams/${item.streamId}/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ offer_id: item.offer.id }),
      });
      if (status === 200 && body && body.added) {
        added += 1;
      } else {
        failed += 1;
        remaining.push(item);
        const s = streamsData.find((x) => x.id === item.streamId);
        const name = (s && s.name) || `Поток ${item.streamId}`;
        errors.push(`Поток ${name}: ${sendErrorText(status, body)}`);
      }
    }
    draft = remaining;
    sending = false;
    toolbar.removeAttribute('aria-busy');

    const parts = [];
    if (errors.length) parts.push(...errors);
    parts.push(`Добавлено: ${added}`);
    if (failed) parts.push(`Не отправлено: ${failed}`);
    sendStatus.textContent = parts.join(' · ');
    sendStatus.className = 'status-line' + (errors.length ? ' error' : '');
    sendStatus.hidden = false;

    renderTable();
    syncDraftButtons();

    // Кнопка ушла в disabled при отправке — возвращаем фокус на статус, а не в «никуда».
    if (sendHadFocus && sendBtn.disabled) {
      sendStatus.setAttribute('tabindex', '-1');
      sendStatus.focus();
    }

    // Обновляем данные с сервера; при сбое оставляем таблицу и черновик как есть.
    const refreshed = await load({ refresh: true });
    if (!refreshed) {
      sendStatus.textContent += ' · Данные с сервера не обновились, черновик сохранён.';
    }
  });

  async function load(opts = {}) {
    const refresh = opts.refresh === true;
    errorState.hidden = true;
    emptyState.hidden = true;
    noOffersLine.hidden = true;
    if (!refresh) {
      tableBlock.hidden = true;
      loading.hidden = false;
    }
    content.setAttribute('aria-busy', 'true');

    const { status, body } = await requestJson(
      `/api/campaigns/${campaignId}/streams`,
      { headers: { Accept: 'application/json' } }
    );
    content.removeAttribute('aria-busy');

    if (status !== 200 || !Array.isArray(body)) {
      if (refresh) return false;
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
      return false;
    }

    const streams = body;
    streamsData = streams;

    // Уникальные offer_id → оферы параллельно; ошибка по одному не рушит остальные.
    const ids = [...new Set(streams.flatMap((s) => (Array.isArray(s.offers) ? s.offers : []).map((o) => o.offer_id)))];
    const results = await Promise.all(
      ids.map(async (id) => {
        const r = await requestJson(`/api/offers/${id}`, { headers: { Accept: 'application/json' } });
        return [id, r.ok ? r.body : null];
      })
    );
    offersMap = new Map(results);

    loading.hidden = true;

    if (!streams.length) {
      // Потоков нет вообще — прежний empty-state.
      emptyState.hidden = false;
      return true;
    }

    // Потоки есть: тулбар и таблица видны всегда, даже если оферов пока нет.
    populateStreamSelect();
    renderTable();
    tableBlock.hidden = false;
    return true;
  }

  load();
}
