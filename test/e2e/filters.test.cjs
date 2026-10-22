// Шаг 6: фильтры в настоящем popup → подсветка на странице
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const [SP, DIST, FX, OUT] = process.argv.slice(2);
let failed = 0;
const check = (name, cond, got) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ' → ' + JSON.stringify(got)}`); if (!cond) failed++; };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/rest/experimental/content/483506343/version') {
    const V = (number, when, name) => ({ number, when, message: '', by: { displayName: name } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ results: [V(3, '2026-09-30T11:00:00Z', 'Кусков Евгений'), V(2, '2026-09-17T10:00:00Z', 'Кедрова Татьяна'), V(1, '2026-07-14T09:00:00Z', 'Изюмский Иван')] }));
  }
  if (u.pathname.includes('/version')) { res.writeHead(404); return res.end(); }
  const m = u.pathname.match(/^\/pages\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(FX, decodeURIComponent(m[1])), (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); } });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await chromium.launchPersistentContext(SP + '/profile-f', {
    channel: 'chromium', headless: true, deviceScaleFactor: 2, viewport: { width: 1100, height: 850 },
    args: ['--disable-extensions-except=' + DIST, '--load-extension=' + DIST],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${id}/popup.html`);

  const open = async (file) => {
    const url = `${base}/pages/${file}`;
    const page = await ctx.newPage();
    await page.goto(url); await page.waitForTimeout(700);
    const tabId = await helper.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, url);
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 380, height: 900 });
    popup.on('pageerror', (e) => { console.log('PAGEERROR', e); failed++; });
    await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
    await popup.click('#btn-analyze');
    await popup.waitForFunction(() => document.getElementById('analysis-status').classList.contains('is-success'), null, { timeout: 20000 });
    return { page, popup, tabId };
  };
  const select = async (popup, { date = '', author = '', jira = '' }) => {
    await popup.selectOption('#filter-date', date);
    if (await popup.isVisible('#filter-author')) await popup.selectOption('#filter-author', author);
    await popup.selectOption('#filter-jira', jira);
    await popup.waitForTimeout(350); // debounce
  };
  const highlight = async (popup) => {
    await popup.click('#btn-highlight');
    await popup.waitForFunction(() => {
      const s = document.getElementById('highlight-status');
      return !s.hidden && !/Поиск правок/.test(s.textContent);
    }, null, { timeout: 15000 });
    return popup.evaluate(() => ({
      status: document.getElementById('highlight-status').textContent,
      count: document.getElementById('entries-count').textContent,
      shown: [...document.querySelectorAll('#entries-list .entry')].map((li) => li.querySelector('.entry__meta').textContent.match(/Версия (\d+)/)[1]),
    }));
  };
  const onPage = (page) => page.evaluate(() => {
    const f = document.querySelector('#wysiwygTextarea_ifr');
    const root = f ? f.contentDocument.body : document.querySelector('.ProseMirror, #main-content');
    return {
      wraps: root.querySelectorAll('.cfa-highlight').length,
      boxes: document.querySelectorAll('.cfa-overlay-box').length,
      texts: [...root.querySelectorAll('.cfa-highlight')].map((w) => w.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)),
    };
  });

  // ---------- Просмотр ----------
  console.log('\n=== просмотр');
  let { page, popup, tabId } = await open('clto-15.html');
  await select(popup, { jira: 'PLATFORM-11717' });
  let r = await highlight(popup);
  let p = await onPage(page);
  check('задача PLATFORM-11717 → в списке версия 3', r.shown.join() === '3' && r.count === '1 из 3', r);
  check(`подсвечено 4 зелёные правки: «${r.status}»`, p.wraps === 4 && /найдено: 4 правки/.test(r.status), p);
  await popup.screenshot({ path: `${OUT}/popup-filter-jira.png`, fullPage: true });
  await page.waitForTimeout(1200); await page.screenshot({ path: `${OUT}/page-filter-jira.png` });

  await select(popup, { author: 'Кедрова Татьяна Сергеевна (Tatyana Kedrova)' });
  r = await highlight(popup); p = await onPage(page);
  check('автор Кедрова → версия 2 → 3 розовые правки (вкл. строку docStatus)', r.shown.join() === '2' && p.wraps === 3 && p.texts.some((t) => /docStatus/.test(t)), { r, p });

  await select(popup, { author: 'Кедрова Татьяна Сергеевна (Tatyana Kedrova)', jira: 'PLATFORM-10842' });
  r = await highlight(popup); p = await onPage(page);
  check('автор Кедрова И задача 10842 → 2 правки (docStatus без задачи исключён)', p.wraps === 2 && !p.texts.some((t) => /docStatus/.test(t)), p);

  await select(popup, { date: '2026-09-30' });
  r = await highlight(popup); p = await onPage(page);
  check('дата 30 сент. → версия 3 → 4 зелёные правки', r.shown.join() === '3' && p.wraps === 4, { r, p });

  await select(popup, { date: '2026-07-14', author: 'Кедрова Татьяна Сергеевна (Tatyana Kedrova)' });
  r = await highlight(popup); p = await onPage(page);
  check('И: дата 14 июл. + автор Кедрова → нет записей, подсветка снята', /Нет записей/.test(r.status) && p.wraps === 0 && r.count === '0 из 3', { r, p });

  await select(popup, { jira: 'PLATFORM-9209' });
  r = await highlight(popup);
  check('задача 9209 (описание без цвета) → понятное предупреждение', /без цвета/.test(r.status), r.status);

  await select(popup, {});
  r = await highlight(popup); p = await onPage(page);
  check('без фильтров → все цветные правки (розовые + зелёные = 7)', p.wraps === 7 && r.count === '3', { r, p });

  // Сохранение фильтров: выбрали задачу, закрыли и открыли popup
  await select(popup, { jira: 'PLATFORM-11717' });
  await popup.close();
  popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
  await popup.waitForTimeout(600);
  const restored = await popup.evaluate(() => ({ jira: document.getElementById('filter-jira').value, count: document.getElementById('entries-count').textContent }));
  check('фильтр запомнился для страницы', restored.jira === 'PLATFORM-11717' && restored.count === '1 из 3', restored);

  // Настройки: выключаем фильтр «Автор» — его значение не учитывается
  await popup.selectOption('#filter-author', 'Кедрова Татьяна Сергеевна (Tatyana Kedrova)');
  await popup.waitForTimeout(350);
  await popup.click('#btn-settings');
  await popup.click('label.switch:has([data-setting="filters.author"])');
  await popup.click('#btn-settings-back');
  await popup.waitForTimeout(200);
  r = await highlight(popup);
  check('фильтр «Автор» выключен в настройках → учитывается только задача', r.shown.join() === '3' && /4 правки/.test(r.status), r);
  await popup.click('#btn-settings');
  await popup.click('label.switch:has([data-setting="filters.author"])');
  await popup.click('#btn-settings-back');

  // Сброс
  await popup.click('#btn-clear');
  await popup.waitForTimeout(400);
  p = await onPage(page);
  const ui = await popup.evaluate(() => ({ jira: document.getElementById('filter-jira').value, count: document.getElementById('entries-count').textContent, hs: document.getElementById('highlight-status').hidden }));
  check('«Сбросить»: фильтры очищены, подсветка снята', p.wraps === 0 && ui.jira === '' && ui.count === '3' && ui.hs, { p, ui });

  // ---------- Редакторы ----------
  for (const [file, expected] of [['clto-15-edit-server.html', 2], ['clto-15-edit-cloud.html', 2]]) {
    console.log(`\n=== ${file}`);
    ({ page, popup } = await open(file));
    await select(popup, { jira: 'PLATFORM-11717' });
    r = await highlight(popup); p = await onPage(page);
    check(`редактор: ${expected} правки слоем поверх, документ не тронут`, p.boxes === expected && p.wraps === 0 && /2 правки/.test(r.status), { r, p });
    await popup.click('#btn-clear'); await popup.waitForTimeout(400);
    p = await onPage(page);
    check('редактор: «Сбросить» убирает рамки', p.boxes === 0, p);
  }

  await ctx.close(); server.close();
  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
