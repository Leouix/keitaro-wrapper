/* Живая проверка React-фронта против uvicorn:8011 через vite dev:8010.
   Только чтение + PUT pending (локальная БД обёртки); POST apply не вызываем.
   Чужой сохранённый черновик кампании 212502 (поток 1313478, add 19958) не трогаем. */
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8010';
const results = [];
const requests = [];
const apiRequests = () => requests.filter((r) => r.includes('/api/'));

function ok(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  console.log(results[results.length - 1]);
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('422')) results.push(`CONSOLE-ERROR ${m.text()}`);
  });

  /* ---------- 1. Главная ---------- */
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  ok('home: заголовок', (await page.locator('h1').first().textContent()) === 'Keitaro — потоки кампаний');
  ok('home: статус «Ключ настроен»', (await page.locator('text=Ключ настроен').count()) === 1);
  const nextBtn = page.getByRole('button', { name: 'Далее' });
  ok('home: кнопка «Далее» активна при настроенном ключе', await nextBtn.isEnabled());

  await page.locator('#api-key').fill('ab');
  await nextBtn.click();
  await page.waitForSelector('[role=alert]', { timeout: 4000 });
  const errText = await page.locator('[role=alert]').textContent();
  ok('home: 422 показан текстом', /Ключ слишком короткий/.test(errText), errText.trim());
  ok('home: aria-invalid на поле', (await page.locator('#api-key').getAttribute('aria-invalid')) === 'true');

  /* ---------- 2. Кампании ---------- */
  await page.goto(BASE + '/campaigns', { waitUntil: 'networkidle' });
  const reqCountBefore = apiRequests().length;
  ok('campaigns: пустой запрос — пустое состояние', (await page.locator('text=Начните вводить название кампании').count()) === 1);
  await page.locator('#campaign-query').fill('');
  await page.waitForTimeout(700);
  const apiNow = apiRequests();
  ok('campaigns: ни одного запроса при пустом поле', apiNow.length === reqCountBefore, apiNow.slice(reqCountBefore).join('; ') || 'нет запросов');

  const searchRequests = [];
  page.on('request', (r) => { if (r.url().includes('/api/campaigns?')) searchRequests.push(r.url()); });
  await page.locator('#campaign-query').fill('test_leo');
  await page.waitForTimeout(100);
  ok('campaigns: debounce — запроса ещё нет', searchRequests.length === 0);
  await page.waitForSelector('.counter', { timeout: 6000 });
  const counter = await page.locator('.counter').textContent();
  ok('campaigns: счётчик со склонением', /^Найдено: \d+ кампани/.test(counter), counter);
  const rowLink = page.locator('a[href="/fb/campaigns/211903/streams"]').first();
  ok('campaigns: есть ссылка на потоки кампании 211903', (await rowLink.count()) === 1);

  /* ---------- 3. Потоки кампании 211903 (чистая, без pending) ---------- */
  await page.goto(BASE + '/fb/campaigns/211903/streams', { waitUntil: 'networkidle' });
  const title = await page.locator('h1').first().textContent();
  ok('streams: заголовок с названием кампании', /^Потоки кампании /.test(title) && title.trim().length > 'Потоки кампании '.length, title);
  ok('streams: ID в шапке', (await page.locator('text=ID кампании: 211903').count()) === 1);
  const sendBtn = page.locator('button:has-text("Отправить в Кейтаро")');
  ok('streams: «Изменений нет»', (await page.locator('text=Изменений нет').count()) === 1);
  ok('streams: кнопка отправки disabled без изменений', await sendBtn.isDisabled());
  // сортировка: поток с оферами вперёд
  const headings = await page.locator('section[class*="section"] h2').allTextContents();
  ok('streams: поток с оферами первый', headings[0].includes('Flow 2'), headings.join(' | '));
  ok('streams: redirect-поток — «не принимает оферы»', (await page.locator('text=Поток не принимает оферы (schema=redirect)').count()) === 1);

  const apiSnap = apiRequests();
  const sec211903 = page.locator('section[class*="section"]:has-text("ID 1313077")');
  await sec211903.locator('button:has-text("Удалить")').first().click();
  await page.waitForTimeout(700);
  ok('draft: бейдж «к удалению»', (await page.locator('text=к удалению').count()) >= 1);
  ok('draft: счётчик «Изменений: −1»', (await page.locator('text=Изменений: −1').count()) === 1);
  ok('draft: кнопка отправки активна', await sendBtn.isEnabled());
  ok('draft: янтарная рамка карточки', (await page.locator('section[class*="hasDraft"]').count()) === 1);
  const cancelBtn = sec211903.locator('button:has-text("Отменить")').first();
  ok('draft: кнопка стала «Отменить»', (await cancelBtn.count()) === 1);
  ok('draft: фокус на кнопке строки', await page.evaluate(() => document.activeElement?.textContent === 'Отменить'));
  // доля удалённой строки — прочерк, остальные пересчитаны
  const shareCells = await sec211903.locator('tbody tr').allTextContents();
  ok('draft: строка с прочерком доли', shareCells.some((t) => t.includes('—')), shareCells.join(' ; ').slice(0, 200));

  const apiCalls = apiRequests().slice(apiSnap.length);
  ok('draft: единственный запрос — PUT .../pending', apiCalls.length === 1 && /PUT .*\/pending/.test(apiCalls[0]), apiCalls.join('; '));
  ok('draft: нет запросов apply в Keitaro', apiCalls.every((r) => !/apply/.test(r)));

  await cancelBtn.click();
  await page.waitForTimeout(700);
  ok('draft: отмена — счётчик «Изменений нет»', (await page.locator('text=Изменений нет').count()) === 1);
  ok('draft: бейдж исчез', (await page.locator('text=к удалению').count()) === 0);
  const apiCalls2 = apiRequests().slice(apiSnap.length + apiCalls.length);
  ok('draft: отмена — второй PUT .../pending', apiCalls2.length === 1 && /PUT .*\/pending/.test(apiCalls2[0]), apiCalls2.join('; '));

  /* ---------- 4. Восстановление чужого черновика (кампания 212502) ---------- */
  await page.goto(BASE + '/fb/campaigns/212502/streams', { waitUntil: 'networkidle' });
  ok('restore: счётчик «Изменений: +1»', (await page.locator('text=Изменений: +1').count()) === 1);
  ok('restore: бейдж «вернётся в поток»', (await page.locator('text=вернётся в поток').count()) >= 1);
  ok('restore: кнопка отправки активна', await sendBtn.isEnabled());

  /* ---------- 5. Предупреждение: поток 1313230 с единственным офером ---------- */
  const secSingle = page.locator('section[class*="section"]:has-text("ID 1313230")');
  const apiSnap5 = apiRequests();
  await secSingle.locator('button:has-text("Удалить")').first().click();
  await page.waitForTimeout(600);
  ok('warning: счётчик «+1 / −1»', (await page.locator('text=Изменений: +1 / −1').count()) === 1);
  await sendBtn.click();
  await page.waitForTimeout(300);
  const warning = page.locator('text=останется без оферов и перестанет принимать трафик');
  ok('warning: блок показан', (await warning.count()) === 1);
  const warnText = (await page.locator('[class*="sendWarning"]').first().textContent()) ?? '';
  ok('warning: текст по потоку 1313230', warnText.includes('1313230') || /Поток «/.test(warnText), warnText.trim());
  await page.locator('button:has-text("Отмена")').press('Escape');
  await page.waitForTimeout(200);
  ok('warning: Esc скрыл блок', (await warning.count()) === 0);
  ok('warning: фокус на кнопке отправки', await page.evaluate(() => document.activeElement?.textContent === 'Отправить в Кейтаро'));
  await sendBtn.click();
  await page.waitForTimeout(200);
  await page.locator('button:has-text("Отмена")').click();
  await page.waitForTimeout(200);
  ok('warning: «Отмена» скрыла блок', (await warning.count()) === 0);
  const apiCalls5 = apiRequests().slice(apiSnap5.length);
  ok('warning: apply не вызывался', apiCalls5.every((r) => !/apply/.test(r)), apiCalls5.filter((r) => /apply/.test(r)).join('; '));
  // вернуть состояние потока 1313230 (чужой черновик 1313478 остаётся)
  await secSingle.locator('button:has-text("Отменить")').first().click();
  await page.waitForTimeout(700);
  ok('warning: изменение отменено, черновик 212502 цел', (await page.locator('text=Изменений: +1').count()) === 1);

  /* ---------- 6. Нечисловой id ---------- */
  await page.goto(BASE + '/fb/campaigns/not-a-number/streams', { waitUntil: 'networkidle' });
  ok('bad id: текст ошибки', (await page.locator('text=Некорректный адрес: ID кампании должен быть числом.').count()) === 1);

  /* ---------- 7. Мобильная вёрстка ---------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(BASE + '/campaigns', { waitUntil: 'networkidle' });
  await page.locator('#campaign-query').fill('test_leo');
  await page.waitForSelector('.counter', { timeout: 6000 });
  const theadVisible = await page.locator('thead').isVisible();
  ok('mobile: шапка таблицы скрыта', !theadVisible);

  await page.screenshot({ path: '/home/leouix/apps/keitaro/frontend/verify-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE + '/fb/campaigns/211903/streams', { waitUntil: 'networkidle' });
  await page.screenshot({ path: '/home/leouix/apps/keitaro/frontend/verify-streams.png', fullPage: true });
} finally {
  const fails = results.filter((r) => r.startsWith('FAIL') || r.startsWith('PAGEERROR') || r.startsWith('CONSOLE-ERROR'));
  console.log('---');
  console.log(`ИТОГ: ${results.length - fails.length} pass, ${fails.length} fail`);
  if (fails.length) console.log(fails.join('\n'));
  await browser.close();
}
