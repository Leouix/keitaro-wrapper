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

/** Русские окончания: plural(2, 'офер', 'офера', 'оферов') → 'офера'. */
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

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
  const streamsList = $('streams-list');
  const title = $('page-title');
  const campaignIdLine = $('campaign-id-line');
  const sendBtn = $('send-btn');
  const draftCount = $('draft-count');
  const sendStatus = $('send-status');

  const match = window.location.pathname.match(/^\/fb\/campaigns\/(\d+)\/streams\/?$/);
  if (!match) {
    loading.hidden = true;
    showError('Некорректный адрес: ID кампании должен быть числом.', []);
    return;
  }
  const campaignId = match[1];

  // До ответа сервера показываем ID; название подставим, когда придёт.
  title.textContent = `Потоки кампании ${campaignId}`;
  document.title = `Потоки кампании ${campaignId} — Keitaro`;
  campaignIdLine.textContent = `ID кампании: ${campaignId}`;

  let streamsData = [];      // потоки с сервера (последний load())
  let offersMap = new Map(); // offer_id -> тело офера
  let archiveData = [];      // архив оферов, реально удалённых в Keitaro
  // Отложенные изменения кампании — зеркало GET .../streams/pending:
  // [{ stream_id, offer_id, action: 'add' | 'remove', created_at }].
  // Клики «Удалить»/«Bring Back»/«Отменить»/«Добавить» меняют только его
  // (через PUT .../pending); в Keitaro ходит лишь «Отправить в Кейтаро».
  let pending = [];
  let sending = false;
  // Запрос по потоку в полёте: блокируем кнопки только этого потока.
  const busyStreams = new Set();
  // Текст ошибки под таблицей конкретного потока (role=status).
  const streamErrors = new Map();

  // Живой поиск офера — своё состояние (таймер/отмена/найденный офер) у каждого потока.
  const searchState = new Map();
  const stateFor = (streamId) => {
    let st = searchState.get(streamId);
    if (!st) {
      st = { timer: null, controller: null, seq: 0, found: null };
      searchState.set(streamId, st);
    }
    return st;
  };

  /* --- Отложенные изменения (pending): локальная модель + PUT .../pending --- */

  function pendingForStream(streamId) {
    return pending.filter((p) => p.stream_id === streamId);
  }

  function replacePendingForStream(streamId, rows) {
    pending = [...pending.filter((p) => p.stream_id !== streamId), ...rows];
  }

  /** Полный набор ожидающих изменений потока — тело PUT .../pending. */
  function pendingBody(streamId) {
    const rows = pendingForStream(streamId);
    return {
      add: rows.filter((p) => p.action === 'add').map((p) => p.offer_id),
      remove: rows.filter((p) => p.action === 'remove').map((p) => p.offer_id),
    };
  }

  /** PUT .../streams/{sid}/pending — единственная запись при кликах.
   *  Заменяет набор ожидающих изменений потока целиком; в Keitaro не ходит. */
  async function putPending(streamId) {
    return requestJson(`/api/campaigns/${campaignId}/streams/${streamId}/pending`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(pendingBody(streamId)),
    });
  }

  function showError(msg, actions = []) {
    errorText.textContent = msg;
    errorActions.replaceChildren(...actions);
    loading.hidden = true;
    emptyState.hidden = true;
    tableBlock.hidden = true;
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

  function streamName(s) {
    return (s && s.name) || `Поток ${s.id}`;
  }

  /** Бейдж ожидающего изменения («к удалению» / «вернётся в поток» / «черновик»). */
  function makeBadge(text) {
    const badge = document.createElement('span');
    badge.className = 'pending-badge';
    badge.textContent = text;
    return badge;
  }

  function makeRow({ stream, entry, offer, share, isArchived, reason, pendingAction }) {
    const tr = document.createElement('tr');
    if (isArchived) tr.className = 'archived-row';
    else if (pendingAction) tr.className = 'pending-row';

    const tdStream = document.createElement('td');
    // Имя потока не переносится: «Flow 1» должно оставаться одной строкой.
    tdStream.className = 'nowrap';
    tdStream.textContent = stream ? streamName(stream) : '—';

    const tdOffer = document.createElement('td');
    tdOffer.className = 'wrap-anywhere';
    const idSpan = document.createElement('span');
    idSpan.className = 'offer-id';
    idSpan.textContent = `#${entry.offer_id}`;
    tdOffer.append(idSpan, ' ');
    if (isArchived) {
      const badge = document.createElement('span');
      badge.className = 'archived-badge';
      badge.textContent = reason === 'keitaro' ? 'удалён в Keitaro' : 'в архиве';
      tdOffer.append(' ', badge);
    }
    if (offer) {
      tdOffer.appendChild(document.createTextNode(offer.name || ''));
    } else if (!isArchived) {
      const em = document.createElement('em');
      em.textContent = 'не удалось загрузить офер';
      tdOffer.appendChild(em);
    }
    if (pendingAction === 'remove') {
      tdOffer.append(' ', makeBadge('к удалению'));
    } else if (pendingAction === 'add') {
      const fromArchive = stream != null && archiveData.some(
        (a) => a.stream_id === stream.id && a.offer_id === entry.offer_id
      );
      tdOffer.append(' ', makeBadge(fromArchive ? 'вернётся в поток' : 'черновик'));
    }

    const tdState = document.createElement('td');
    tdState.textContent = isArchived
      ? (entry.state || (offer && offer.state) || '—')
      : ((offer && offer.state) || entry.state || '—');

    const tdShare = document.createElement('td');
    tdShare.className = 'num';
    tdShare.textContent = share == null ? '—' : `${share}%`;

    const tdPayout = document.createElement('td');
    tdPayout.className = 'num';
    const payout = offer ? Number(offer.payout_value) : 0;
    tdPayout.textContent = payout ? [payout, offer.payout_currency].filter(Boolean).join(' ') : '';

    const tdAction = document.createElement('td');
    tdAction.className = 'nowrap';
    tdAction.appendChild(makeActionCell({ stream, entry, isArchived, pendingAction }));

    tr.append(tdOffer, tdShare, tdState, tdStream, tdPayout, tdAction);
    return tr;
  }

  /** Кнопка колонки «Действие»: живая строка — «Удалить», ожидающая —
   *  «Отменить», архивная — «Bring Back». Пока по потоку идёт запрос или
   *  идёт отправка, кнопки отключены. */
  function makeActionCell({ stream, entry, isArchived, pendingAction }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm ' + (pendingAction || isArchived ? 'btn-secondary' : 'btn-danger');
    const streamId = stream ? stream.id : null;
    btn.dataset.streamId = streamId == null ? '' : String(streamId);
    btn.dataset.offerId = String(entry.offer_id);
    const disabled = !streamId || sending || busyStreams.has(streamId);
    if (pendingAction) {
      btn.textContent = 'Отменить';
      btn.setAttribute('aria-label',
        `Отменить отложенное изменение офера #${entry.offer_id} в потоке ${streamName(stream)}`);
      btn.disabled = disabled;
      btn.addEventListener('click', () => cancelPendingChange(stream, entry.offer_id));
    } else if (isArchived) {
      btn.textContent = 'Bring Back';
      btn.setAttribute('aria-label', `Вернуть офер #${entry.offer_id} в поток ${streamName(stream)}`);
      btn.disabled = disabled;
      btn.addEventListener('click', () => bringBackOffer(stream, entry));
    } else {
      btn.textContent = 'Удалить';
      btn.setAttribute('aria-label', `Удалить офер #${entry.offer_id} из потока ${streamName(stream)}`);
      btn.disabled = disabled;
      btn.addEventListener('click', () => deleteOffer(stream, entry));
    }
    return btn;
  }

  /** После перерисовки вернуть фокус кнопке этой строки — сама кнопка
   *  пересоздаётся, и без этого фокус улетал бы на body. */
  function focusRowButton(streamId, offerId) {
    const btn = document.querySelector(
      `button[data-stream-id="${streamId}"][data-offer-id="${offerId}"]`
    );
    if (btn) btn.focus();
  }

  /** Таблица одного потока. Итоговый набор = живые оферы без pending-remove
   *  плюс pending-add (черновик и «вернётся в поток»). Пока у потока есть
   *  ожидающие изменения, доли пересчитаны локально: base = floor(100/n),
   *  остаток добирается первым строкам итогового набора (3 офера = 34/33/33).
   *  Строка с pending-remove остаётся на своём месте, её доля — «—».
   *  Архивные строки в пересчёте не участвуют и не дублируют pending-add. */
  function makeStreamTable(s) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const table = document.createElement('table');

    const caption = document.createElement('caption');

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const [name, cls] of [['Офер', ''], ['Доля', 'num'], ['Статус', ''], ['Поток', ''], ['Выплата', 'num'], ['Действие', '']]) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = name;
      if (cls) th.className = cls;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const entries = Array.isArray(s.offers) ? s.offers : [];
    const streamPending = pendingForStream(s.id);
    const removes = new Set(
      streamPending.filter((p) => p.action === 'remove').map((p) => p.offer_id)
    );
    const adds = streamPending.filter((p) => p.action === 'add');
    const streamArchive = archiveData.filter(
      (a) => a.stream_id === s.id && !adds.some((p) => p.offer_id === a.offer_id)
    );

    const rows = [];
    const liveCount = entries.filter((e) => !removes.has(e.offer_id)).length;
    const total = liveCount + adds.length;
    const recalc = streamPending.length > 0 && total > 0;
    let base = 0, rem = 0;
    if (recalc) {
      base = Math.floor(100 / total);
      rem = 100 % total;
    }
    const shareAt = (i) => (i < rem ? base + 1 : base);

    let idx = 0;
    entries.forEach((entry) => {
      const isPendingRemove = removes.has(entry.offer_id);
      rows.push({
        stream: s,
        entry,
        offer: offersMap.get(entry.offer_id) ?? null,
        share: isPendingRemove
          ? null
          : (recalc ? shareAt(idx++) : (entry.share == null ? null : entry.share)),
        pendingAction: isPendingRemove ? 'remove' : null,
      });
    });
    adds.forEach((a) => {
      const archEntry = archiveData.find(
        (x) => x.stream_id === s.id && x.offer_id === a.offer_id
      ) || null;
      rows.push({
        stream: s,
        entry: { offer_id: a.offer_id, state: archEntry && archEntry.state },
        offer: offersMap.get(a.offer_id) ?? null,
        share: recalc ? shareAt(idx++) : null,
        pendingAction: 'add',
      });
    });
    // Архивные строки идут после живых; их поле «Доля» всегда прочерчено.
    for (const a of streamArchive) {
      rows.push({
        stream: s,
        entry: { offer_id: a.offer_id, state: a.state, stream_id: a.stream_id },
        offer: offersMap.get(a.offer_id) ?? null,
        share: null,
        isArchived: true,
        reason: a.reason,
      });
    }

    const tbody = document.createElement('tbody');
    tbody.replaceChildren(...rows.map(makeRow));
    table.append(caption, thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function isDuplicate(streamId, offerId) {
    const s = streamsData.find((x) => x.id === streamId);
    if (s && Array.isArray(s.offers) && s.offers.some((o) => o.offer_id === offerId)) return true;
    return pending.some((p) => p.stream_id === streamId && p.offer_id === offerId);
  }

  function setHint(hintEl, text, kind) {
    if (!hintEl) return;
    hintEl.textContent = text;
    hintEl.className = kind ? `offer-hint ${kind}` : 'offer-hint';
  }

  /** Состояние кнопки «Добавить» одного потока — по текущему DOM (секции перерисовываются). */
  function syncStream(streamId) {
    const st = stateFor(streamId);
    const addBtn = document.getElementById(`add-btn-${streamId}`);
    if (!addBtn) return;
    const duplicate = st.found ? isDuplicate(streamId, st.found.id) : false;

    addBtn.disabled = sending || busyStreams.has(streamId) || !st.found || duplicate;
    addBtn.title = sending || busyStreams.has(streamId) ? 'Идёт запрос…'
      : !st.found ? 'Сначала найдите офер по ID'
      : duplicate ? 'Этот офер уже есть в этом потоке или уже помечен как изменение'
      : 'Помечается как отложенное добавление — уйдёт в Keitaro по «Отправить в Кейтаро»';
  }

  function syncSend() {
    sendBtn.disabled = sending || pending.length === 0;
    sendBtn.title = sending ? 'Идёт отправка…'
      : pending.length === 0 ? 'Нет отложенных изменений'
      : '';
    const adds = pending.filter((p) => p.action === 'add').length;
    const removes = pending.length - adds;
    if (!pending.length) {
      draftCount.textContent = 'Изменений нет';
    } else {
      const parts = [];
      if (adds) parts.push(`+${adds}`);
      if (removes) parts.push(`−${removes}`);
      draftCount.textContent = `Изменений: ${parts.join(' / ')}`;
    }
  }

  function renderStreams() {
    // Сначала потоки с офферами с сервера, пустые — внизу; внутри групп порядок
    // сервера сохраняется (stable sort). Отложенные изменения порядок не двигают:
    // иначе секция прыгает наверх, пока в неё добавляют офер.
    const withOffers = new Set(
      streamsData
        .filter((s) => Array.isArray(s.offers) && s.offers.length > 0)
        .map((s) => s.id)
    );
    const sorted = [...streamsData].sort(
      (a, b) => (withOffers.has(b.id) ? 1 : 0) - (withOffers.has(a.id) ? 1 : 0)
    );
    streamsList.replaceChildren(...sorted.map(renderStreamSection));
    syncSend();
    syncPendingHighlight();
  }

  /** Подсветка несохранённых изменений: пока есть хоть одно ожидающее.
   *  Введённый, но ещё не добавленный ID изменением не считается. */
  function syncPendingHighlight() {
    const card = document.querySelector('main.card');
    if (card) card.classList.toggle('has-draft', pending.length > 0);
  }

  function renderStreamSection(s) {
    const section = document.createElement('section');
    section.className = 'stream-section';

    const h2 = document.createElement('h2');
    h2.textContent = streamName(s);
    const meta = document.createElement('span');
    meta.className = 'stream-meta';
    meta.textContent = `${s.schema || '—'} · ID ${s.id}`;
    h2.appendChild(meta);
    section.appendChild(h2);

    const entries = Array.isArray(s.offers) ? s.offers : [];
    const streamPending = pendingForStream(s.id);
    const streamArchive = archiveData.filter(
      (a) => a.stream_id === s.id
        && !streamPending.some((p) => p.action === 'add' && p.offer_id === a.offer_id)
    );

    if (!entries.length && !streamPending.length && !streamArchive.length) {
      const p = document.createElement('p');
      p.className = 'no-offers';
      p.textContent = 'Без оферов';
      section.appendChild(p);
    } else {
      section.appendChild(makeStreamTable(s));
    }

    // Ошибка последней операции по этому потоку — под таблицей, статусом.
    if (streamErrors.has(s.id)) {
      const err = document.createElement('p');
      err.id = `stream-error-${s.id}`;
      err.className = 'message error stream-error';
      err.setAttribute('role', 'status');
      err.setAttribute('aria-live', 'polite');
      err.textContent = streamErrors.get(s.id);
      section.appendChild(err);
    }

    if (s.schema === 'landings') {
      section.appendChild(makeOfferForm(s));
    } else {
      const p = document.createElement('p');
      p.className = 'no-offers';
      p.textContent = `Поток не принимает оферы (schema=${s.schema || '—'})`;
      section.appendChild(p);
    }
    return section;
  }

  /** Своя форма поиска у каждого landings-потока: поле, подсказка и кнопка — отдельные. */
  function makeOfferForm(s) {
    const streamId = s.id;

    const form = document.createElement('form');
    form.className = 'offer-form';
    form.noValidate = true;
    form.addEventListener('submit', (e) => e.preventDefault());

    const row = document.createElement('div');
    row.className = 'offer-form-row';

    const field = document.createElement('div');
    field.className = 'field offer-search-field';

    const label = document.createElement('label');
    label.htmlFor = `offer-id-${streamId}`;
    label.textContent = `Добавить офер в ${streamName(s)}`;

    const input = document.createElement('input');
    input.id = `offer-id-${streamId}`;
    input.type = 'search';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.placeholder = 'Введите ID оффера';
    input.setAttribute('aria-describedby', `offer-hint-${streamId}`);

    const hint = document.createElement('p');
    hint.id = `offer-hint-${streamId}`;
    hint.className = 'offer-hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');

    field.append(label, input, hint);

    const actions = document.createElement('div');
    actions.className = 'toolbar-actions';
    const addBtn = document.createElement('button');
    addBtn.id = `add-btn-${streamId}`;
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary';
    addBtn.disabled = true;
    addBtn.textContent = 'Добавить';
    addBtn.title = 'Сначала найдите офер по ID';
    actions.appendChild(addBtn);

    row.append(field, actions);
    form.appendChild(row);

    const st = stateFor(streamId);

    function resetSearch() {
      st.seq += 1;
      clearTimeout(st.timer);
      if (st.controller) {
        st.controller.abort();
        st.controller = null;
      }
      st.found = null;
      setHint(hint, '');
      syncStream(streamId);
    }

    // Пауза 300 мс; в поле остаются только цифры положительного целого.
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
      if (digits !== input.value) input.value = digits;

      // Любое новое ввод: устаревшие ответы и таймер больше не нужны.
      st.seq += 1;
      clearTimeout(st.timer);
      if (st.controller) {
        st.controller.abort();
        st.controller = null;
      }

      if (!digits) {
        resetSearch();
        return;
      }

      setHint(hint, 'Ищем оффер…');
      st.timer = setTimeout(() => searchOffer(streamId, digits), 300);
    });

    // Кнопка очистки у <input type="search">.
    input.addEventListener('search', () => {
      if (!input.value) resetSearch();
    });

    /** «Добавить»: офер помечается как отложенное добавление (pending add)
     *  и запоминается через PUT .../pending. В Keitaro не ходим — офер
     *  появится в потоке только по «Отправить в Кейтаро». */
    addBtn.addEventListener('click', async () => {
      if (addBtn.disabled || !st.found || sending) return;
      const offer = st.found;

      busyStreams.add(streamId);
      // Поле очищается, найденный офер «забывается»; строка появится после ререндера.
      st.found = null;
      input.value = '';
      setHint(hint, '');
      pending = [...pending, { stream_id: streamId, offer_id: offer.id, action: 'add', created_at: null }];
      renderStreams();
      focusRowButton(streamId, offer.id);

      const { status, body } = await putPending(streamId);
      if (status === 200 && body && Array.isArray(body.pending)) {
        replacePendingForStream(streamId, body.pending);
      } else {
        pending = pending.filter(
          (p) => !(p.stream_id === streamId && p.offer_id === offer.id && p.action === 'add')
        );
        streamErrors.set(streamId, pendingChangeErrorText(status, body, 'Не удалось пометить офер к добавлению.'));
      }

      busyStreams.delete(streamId);
      renderStreams();

      // Поле пересоздаётся вместе с секцией — возвращаем фокус в него.
      const fresh = document.getElementById(`offer-id-${streamId}`);
      if (fresh) fresh.focus();
    });

    setHint(hint, '');
    syncStream(streamId);
    return form;
  }

  async function searchOffer(streamId, idStr) {
    const st = stateFor(streamId);
    const mySeq = ++st.seq;
    st.controller = new AbortController();
    const { status, body } = await requestJson(`/api/offers/${idStr}`, {
      headers: { Accept: 'application/json' },
      signal: st.controller.signal,
    });

    // Ответ на устаревший (или отменённый) запрос — молча выбрасываем.
    if (mySeq !== st.seq) return;
    st.controller = null;

    // Секция могла перерисоваться — состояние пишем только в текущий DOM.
    const input = document.getElementById(`offer-id-${streamId}`);
    if (!input || input.value.replace(/\D/g, '') !== idStr) {
      st.found = null;
      return;
    }
    const hint = document.getElementById(`offer-hint-${streamId}`);

    if (status === 200 && body && body.id != null) {
      st.found = body;
      let text = `#${body.id}${body.name ? ` — ${body.name}` : ''}`;
      const payout = Number(body.payout_value);
      if (payout) text += ` · ${payout}${body.payout_currency ? ` ${body.payout_currency}` : ''}`;
      if (body.state) text += ` · ${body.state}`;
      setHint(hint, text, 'offer-hint-found');
    } else if (status === 404) {
      st.found = null;
      setHint(hint, `Офер с ID ${parseInt(idStr, 10)} не найден`, 'offer-hint-error');
    } else if (status === 409) {
      st.found = null;
      setHint(hint, 'Сначала укажите API key на главной.', 'offer-hint-error');
    } else if (status === 502) {
      st.found = null;
      setHint(hint, 'Keitaro недоступен, попробуйте позже.', 'offer-hint-error');
    } else if (status === 0) {
      st.found = null;
      setHint(hint, 'Сеть недоступна, попробуйте ещё раз.', 'offer-hint-error');
    } else {
      st.found = null;
      setHint(hint, detailToText(body && body.detail, `Не удалось найти офер (код ${status}).`), 'offer-hint-error');
    }
    syncStream(streamId);
  }

  function applyErrorText(status, body) {
    if (status === 404) return detailToText(body && body.detail, 'Поток или офер не найден в Keitaro.');
    if (status === 409) return detailToText(body && body.detail, 'Поток не принимает оферы или остался бы без оферов.');
    if (status === 502) return 'Keitaro недоступен.';
    if (status === 0) return 'Сеть недоступна.';
    return detailToText(body && body.detail, `Ошибка отправки (код ${status}).`);
  }

  function pendingChangeErrorText(status, body, fallback) {
    if (status === 0) return 'Сеть недоступна, попробуйте ещё раз.';
    // 404 у PUT/GET pending бывает только на старом бэкенде без pending-роутов.
    if (status === 404) return 'Сервер не поддерживает отложенные изменения — нужен бэкенд с коммитом 0e8dc9b.';
    if (status === 400) return detailToText(body && body.detail, fallback);
    return detailToText(body && body.detail, `${fallback} (код ${status}).`);
  }

  function replaceStream(streamId, freshStream) {
    const idx = streamsData.findIndex((x) => x.id === streamId);
    if (idx >= 0 && freshStream) streamsData[idx] = freshStream;
  }

  /** Свежий архив из обёртки (локальные данные, ключ не нужен). */
  async function refreshArchive() {
    const { status, body } = await requestJson(`/api/campaigns/${campaignId}/streams/archive`, {
      headers: { Accept: 'application/json' },
    });
    if (status === 200 && body && Array.isArray(body.archived)) {
      archiveData = body.archived;
      return true;
    }
    return false;
  }

  /** «Удалить» у живого офера: строка остаётся на месте, фон жёлтый,
   *  бейдж «к удалению», доля «—», остальные доли пересчитаны. Единственный
   *  запрос — PUT .../pending; в Keitaro ничего не уходит до «Отправить». */
  async function deleteOffer(stream, entry) {
    const streamId = stream.id;
    const offerId = entry.offer_id;
    if (!streamId || sending || busyStreams.has(streamId)) return;

    // Последний живой офер удалять нельзя (Keitaro пустой поток не принимает).
    // Отложенное добавление оставляет потоку итоговый офер — тогда можно.
    const entries = Array.isArray(stream.offers) ? stream.offers : [];
    const removes = new Set(
      pendingForStream(streamId).filter((p) => p.action === 'remove').map((p) => p.offer_id)
    );
    const liveCount = entries.filter((e) => !removes.has(e.offer_id)).length;
    if (liveCount <= 1 && !pendingForStream(streamId).some((p) => p.action === 'add')) {
      streamErrors.set(streamId, 'Нельзя удалить единственный офер потока.');
      renderStreams();
      return;
    }

    busyStreams.add(streamId);
    streamErrors.delete(streamId);
    pending = [...pending, { stream_id: streamId, offer_id: offerId, action: 'remove', created_at: null }];
    renderStreams();
    focusRowButton(streamId, offerId);

    const { status, body } = await putPending(streamId);
    if (status === 200 && body && Array.isArray(body.pending)) {
      replacePendingForStream(streamId, body.pending);
    } else {
      pending = pending.filter(
        (p) => !(p.stream_id === streamId && p.offer_id === offerId && p.action === 'remove')
      );
      streamErrors.set(streamId, pendingChangeErrorText(status, body, 'Не удалось пометить офер к удалению.'));
    }

    busyStreams.delete(streamId);
    renderStreams();
    focusRowButton(streamId, offerId);
  }

  /** «Bring Back» у архивного офера: строка жёлтая, бейдж «вернётся в поток»,
   *  её доля участвует в пересчёте как живая. Единственный запрос —
   *  PUT .../pending с add; в Keitaro не ходим до «Отправить». */
  async function bringBackOffer(stream, entry) {
    const streamId = stream.id;
    const offerId = entry.offer_id;
    if (!streamId || sending || busyStreams.has(streamId)) return;

    busyStreams.add(streamId);
    streamErrors.delete(streamId);
    pending = [...pending, { stream_id: streamId, offer_id: offerId, action: 'add', created_at: null }];
    renderStreams();
    focusRowButton(streamId, offerId);

    const { status, body } = await putPending(streamId);
    if (status === 200 && body && Array.isArray(body.pending)) {
      replacePendingForStream(streamId, body.pending);
    } else {
      pending = pending.filter(
        (p) => !(p.stream_id === streamId && p.offer_id === offerId && p.action === 'add')
      );
      streamErrors.set(streamId, pendingChangeErrorText(status, body, 'Не удалось пометить офер к возврату.'));
    }

    busyStreams.delete(streamId);
    renderStreams();
    focusRowButton(streamId, offerId);
  }

  /** «Отменить» у ожидающей строки: снимаем отметку (PUT pending уже без
   *  этого офера) и возвращаем строке исходный вид и доли. Без запросов
   *  в Keitaro. */
  async function cancelPendingChange(stream, offerId) {
    const streamId = stream.id;
    if (!streamId || sending || busyStreams.has(streamId)) return;
    const row = pending.find((p) => p.stream_id === streamId && p.offer_id === offerId);
    if (!row) return;

    busyStreams.add(streamId);
    streamErrors.delete(streamId);
    pending = pending.filter((p) => p !== row);
    renderStreams();
    focusRowButton(streamId, offerId);

    const { status, body } = await putPending(streamId);
    if (status === 200 && body && Array.isArray(body.pending)) {
      replacePendingForStream(streamId, body.pending);
    } else {
      pending = [...pending, row];
      streamErrors.set(streamId, pendingChangeErrorText(status, body, 'Не удалось отменить изменение.'));
    }

    busyStreams.delete(streamId);
    renderStreams();
    focusRowButton(streamId, offerId);
  }

  sendBtn.addEventListener('click', async () => {
    if (sendBtn.disabled || sending) return;
    const sendHadFocus = document.activeElement === sendBtn;
    sending = true;
    tableBlock.setAttribute('aria-busy', 'true');
    syncSend();
    for (const s of streamsData) syncStream(s.id);
    sendStatus.hidden = true;

    // Потоки с ожидающими изменениями, в порядке списка; поток вне списка
    // (редкий случай) — в конец, apply проверяет кампанию по самому потоку.
    const targets = streamsData
      .filter((s) => pendingForStream(s.id).length > 0)
      .map((s) => s.id);
    const known = new Set(targets);
    for (const sid of new Set(pending.map((p) => p.stream_id))) {
      if (!known.has(sid)) targets.push(sid);
    }

    let applied = 0;
    let failed = 0;
    const errors = [];
    // Только здесь и только последовательные POST .../apply — по одному
    // на поток, один PUT в Keitaro внутри каждого.
    for (const sid of targets) {
      busyStreams.add(sid);
      const { status, body } = await requestJson(
        `/api/campaigns/${campaignId}/streams/${sid}/apply`,
        { method: 'POST', headers: { Accept: 'application/json' } }
      );
      if (status === 200 && body && body.applied) {
        // Актуальный поток — из ответа; его доли уже пересчитаны Keitaro.
        if (body.stream) replaceStream(sid, body.stream);
        const addedIds = Array.isArray(body.added) ? body.added : [];
        const removedIds = Array.isArray(body.removed) ? body.removed : [];
        // Локальная бухгалтерия архива: возвращённые снимаются с архива,
        // удалённые попадают в него (до сверки с refreshArchive).
        archiveData = archiveData.filter(
          (a) => !(a.stream_id === sid && addedIds.includes(a.offer_id))
        );
        const nowIso = new Date().toISOString();
        for (const oid of removedIds) {
          const offer = offersMap.get(oid) ?? null;
          archiveData = [...archiveData, {
            stream_id: sid,
            offer_id: oid,
            share: null,
            state: (offer && offer.state) || null,
            archived_at: nowIso,
            reason: 'user',
          }];
        }
        replacePendingForStream(sid, []);
        streamErrors.delete(sid);
        applied += 1;
      } else {
        // Ошибка одного потока: его изменения остаются как были, идём дальше.
        failed += 1;
        const text = applyErrorText(status, body);
        streamErrors.set(sid, text);
        errors.push(`Поток ${streamName(streamsData.find((x) => x.id === sid) || { id: sid })}: ${text}`);
      }
      busyStreams.delete(sid);
      renderStreams();
    }
    sending = false;
    tableBlock.removeAttribute('aria-busy');

    const parts = [];
    if (errors.length) parts.push(...errors);
    parts.push(`Потоков обновлено: ${applied}`);
    if (failed) parts.push(`Не отправлено: ${failed}`);
    sendStatus.textContent = parts.join(' · ');
    sendStatus.className = 'status-line' + (errors.length ? ' error' : '');
    sendStatus.hidden = false;

    renderStreams();

    // Кнопка ушла в disabled при отправке — возвращаем фокус на статус, а не в «никуда».
    if (sendHadFocus && sendBtn.disabled) {
      sendStatus.setAttribute('tabindex', '-1');
      sendStatus.focus();
    }

    // Архив — локальные данные обёртки; после успешных применений сверяем.
    if (applied) {
      await refreshArchive();
      renderStreams();
    }
  });

  async function load(opts = {}) {
    const refresh = opts.refresh === true;
    errorState.hidden = true;
    emptyState.hidden = true;
    if (!refresh) {
      tableBlock.hidden = true;
      loading.hidden = false;
    }
    content.setAttribute('aria-busy', 'true');

    // Название кампании и потоки запрашиваем параллельно. Архив запрашиваем
    // ПОСЛЕ ответа /streams: синхронизация «офер пропал в Keitaro → архив
    // reason=keitaro» выполняется в обработчике /streams и коммитится уже
    // после ответа, поэтому параллельный запрос архива не видит свежую
    // архивную строку (бейдж «удалён в Keitaro» и Bring Back появлялись только
    // со второй перезагрузки). Архив — локальные данные обёртки, его ошибка
    // не должна ломать страницу. Pending — тоже локальная БД, идёт следом.
    const [streamsRes, campaignRes] = await Promise.all([
      requestJson(`/api/campaigns/${campaignId}/streams`, { headers: { Accept: 'application/json' } }),
      requestJson(`/api/campaigns/${campaignId}`, { headers: { Accept: 'application/json' } }),
    ]);
    content.removeAttribute('aria-busy');

    const archiveRes = await requestJson(`/api/campaigns/${campaignId}/streams/archive`, {
      headers: { Accept: 'application/json' },
    });
    if (archiveRes.status === 200 && archiveRes.body && Array.isArray(archiveRes.body.archived)) {
      archiveData = archiveRes.body.archived;
    } else if (!refresh) {
      archiveData = []; // ключа нет или список пуст — архива нет
    }

    // Восстановление жёлтых строк из pending: перезагрузка не воскрешает
    // удалённые оферы и не теряет черновики. 404 = старый бэкенд без
    // pending-роутов — считаем изменений нет.
    const pendingRes = await requestJson(`/api/campaigns/${campaignId}/streams/pending`, {
      headers: { Accept: 'application/json' },
    });
    if (pendingRes.status === 200 && pendingRes.body && Array.isArray(pendingRes.body.pending)) {
      pending = pendingRes.body.pending;
    } else if (!refresh) {
      pending = [];
    }

    // body.name || body.campaign?.name — stale-ответ кладёт кампанию внутрь.
    const campaignBody = campaignRes.ok ? campaignRes.body : null;
    const campaignName = campaignBody
      && (campaignBody.name || (campaignBody.campaign && campaignBody.campaign.name));
    if (campaignName) {
      title.textContent = `Потоки кампании ${campaignName}`;
      document.title = `Потоки кампании ${campaignName} — Keitaro`;
    }

    const { status, body } = streamsRes;
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

    streamsData = body;
    if (!refresh) {
      streamErrors.clear();
    }

    // Уникальные offer_id → оферы параллельно; ошибка по одному не рушит остальные.
    // Берём живых оферов, архив И отложенные добавления: строка с бейджем
    // тоже рисует имя и выплату, иначе после перезагрузки офер из pending
    // рисуется как «не удалось загрузить офер».
    const ids = [...new Set([
      ...streamsData.flatMap((s) => (Array.isArray(s.offers) ? s.offers : []).map((o) => o.offer_id)),
      ...archiveData.map((a) => a.offer_id),
      ...pending.filter((p) => p.action === 'add').map((p) => p.offer_id),
    ])];
    const results = await Promise.all(
      ids.map(async (id) => {
        const r = await requestJson(`/api/offers/${id}`, { headers: { Accept: 'application/json' } });
        return [id, r.ok ? r.body : null];
      })
    );
    offersMap = new Map(results);

    loading.hidden = true;

    if (!streamsData.length) {
      // Потоков нет вообще — прежний empty-state.
      emptyState.hidden = false;
      return true;
    }

    renderStreams();
    tableBlock.hidden = false;
    return true;
  }

  load();
}
