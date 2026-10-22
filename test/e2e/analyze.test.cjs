// Шаг 5: кнопка «Анализ» в настоящем popup → background → content script → storage
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const [SP, DIST, FX, OUT] = process.argv.slice(2);
let failed = 0;
const check = (name, cond, got) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ' → ' + JSON.stringify(got)}`); if (!cond) failed++; };
const V = (number, when, name) => ({ number, when, message: '', by: { displayName: name } });
const ALL = [V(4, '2026-09-30T15:00:00Z', 'Иванов Иван'), V(3, '2026-09-30T11:00:00Z', 'Сидоров Пётр'), V(2, '2026-09-17T10:00:00Z', 'Петрова Анна'), V(1, '2026-07-14T09:00:00Z', 'Иванов Иван')];
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const html = (f) => fs.readFile(path.join(FX, f), (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); } });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/rest/experimental/content/483506343/version') return json({ results: ALL });
  if (u.pathname === '/wiki/rest/api/content/483506343/version') {
    const start = Number(u.searchParams.get('start') || 0);
    return json(start === 0
      ? { results: ALL.slice(0, 2), _links: { base: 'https://example.atlassian.net/wiki', next: '/rest/api/content/483506343/version?start=2&limit=200' } }
      : { results: ALL.slice(2), _links: { base: 'https://example.atlassian.net/wiki' } });
  }
  if (u.pathname === '/wiki/spaces/CL/pages/edit-v2/483506343') return html('clto-15-edit-cloud.html');
  if (u.pathname === '/other/blank.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<html><body><h1>Обычный сайт</h1></body></html>'); }
  const m = u.pathname.match(/^\/(pages|other)\/(.+)$/);
  if (m) return html(decodeURIComponent(m[2]));
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await chromium.launchPersistentContext(SP + '/profile-a', {
    channel: 'chromium', headless: true, deviceScaleFactor: 2,
    args: ['--disable-extensions-except=' + DIST, '--load-extension=' + DIST],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${id}/popup.html`);
  const tabIdOf = (url) => helper.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, url);

  const analyze = async (url, { expectOk = true } = {}) => {
    const page = await ctx.newPage();
    await page.goto(url); await page.waitForTimeout(700);
    const tabId = await tabIdOf(url);
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 380, height: 760 });
    const errors = [];
    popup.on('pageerror', (e) => errors.push(String(e)));
    await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
    await popup.click('#btn-analyze');
    await popup.waitForFunction(() => {
      const s = document.getElementById('analysis-status');
      return s.classList.contains('is-success') || s.classList.contains('is-error');
    }, null, { timeout: 20000 });
    const ui = await popup.evaluate(() => ({
      status: document.getElementById('analysis-status').innerText.replace(/\n/g, ' | '),
      ok: document.getElementById('analysis-status').classList.contains('is-success'),
      count: document.getElementById('entries-count').textContent,
      dates: [...document.querySelectorAll('#filter-date option')].map((o) => o.textContent),
      authors: document.querySelectorAll('#filter-author option').length,
      jira: [...document.querySelectorAll('#filter-jira option')].map((o) => o.value).filter(Boolean),
      filtersEnabled: !document.getElementById('filters').disabled,
      entries: [...document.querySelectorAll('#entries-list .entry')].map((li) => ({
        color: li.querySelector('.entry__desc').style.color,
        link: li.querySelector('.entry__link')?.textContent || null,
        href: li.querySelector('.entry__link')?.href || null,
      })),
    }));
    check(`${expectOk ? 'успех' : 'ошибка'}: «${ui.status}»`, ui.ok === expectOk && errors.length === 0, { ui, errors });
    return { page, popup, ui, tabId };
  };

  // 1. Просмотр (Server): адрес из manifest, версии через /rest/experimental
  console.log('\n=== просмотр Server');
  let r = await analyze(`${base}/pages/clto-15.html`);
  check('3 записи, фильтры активны', r.ui.count === '3' && r.ui.filtersEnabled, r.ui);
  check('даты в фильтре', r.ui.dates.join('|') === 'Все даты|14 июл. 2026 г.|17 сент. 2026 г.|30 сент. 2026 г.', r.ui.dates);
  check('авторы (3 + «Все»)', r.ui.authors === 4, r.ui.authors);
  check('задачи в фильтре', r.ui.jira.join() === 'PLATFORM-9209,PLATFORM-10842,PLATFORM-11717', r.ui.jira);
  check('цвета описаний в списке', r.ui.entries[1].color === 'rgb(208, 68, 152)' && r.ui.entries[2].color === 'rgb(54, 179, 126)', r.ui.entries);
  check('версия 3 → версия страницы 3 (по автору, не 4)', r.ui.entries[2].link === 'версия страницы 3 ↗' && /pageId=483506343&pageVersion=3/.test(r.ui.entries[2].href), r.ui.entries[2]);
  check('статус: число версий', /версий страницы: 4/.test(r.ui.status), r.ui.status);
  await r.popup.screenshot({ path: `${OUT}/popup-analysis.png`, fullPage: true });
  const stored = await helper.evaluate(() => chrome.storage.local.get('cfa_analysis'));
  check('результат в chrome.storage.local', Boolean(stored.cfa_analysis?.['id:483506343']?.entries?.length === 3), Object.keys(stored.cfa_analysis || {}));
  check('вкладка осталась на той же странице', r.page.url() === `${base}/pages/clto-15.html`, r.page.url());
  // Повторное открытие popup — результат восстанавливается без нажатия «Анализ»
  const again = await ctx.newPage();
  await again.goto(`chrome-extension://${id}/popup.html?tabId=${r.tabId}`);
  await again.waitForTimeout(500);
  const restored = await again.evaluate(() => document.getElementById('entries-count').textContent);
  check('при повторном открытии результат восстановлен', restored === '3', restored);

  // 2. Редактор Server
  console.log('\n=== редактор Server');
  r = await analyze(`${base}/pages/clto-15-edit-server.html`);
  check('3 записи, отмечен режим редактирования', r.ui.count === '3' && /режим редактирования/.test(r.ui.status), r.ui.status);
  // Тот же pageId → при открытии popup на странице редактора находится анализ (по id)

  // 3. Редактор Cloud по «настоящему» адресу: id из URL, версии через /wiki/rest/api с догрузкой
  console.log('\n=== редактор Cloud');
  r = await analyze(`${base}/wiki/spaces/CL/pages/edit-v2/483506343`);
  check('3 записи, режим редактирования', r.ui.count === '3' && /режим редактирования/.test(r.ui.status), r.ui.status);
  check('версии Cloud загружены двумя порциями', /версий страницы: 4/.test(r.ui.status) && requests.some((q) => q.includes('start=2')), requests.filter((q) => q.includes('/version')));

  // 4. Нестандартный адрес (не в manifest) — content script внедряется по кнопке
  console.log('\n=== нестандартный адрес');
  r = await analyze(`${base}/other/clto-15.html`);
  check('анализ работает после внедрения content script', r.ui.count === '3', r.ui);

  // 5. Не Confluence
  console.log('\n=== обычный сайт');
  r = await analyze(`${base}/other/blank.html`, { expectOk: false });
  check('понятное сообщение об ошибке', /не найдено содержимое|не найдена таблица/i.test(r.ui.status), r.ui.status);

  // 6. Служебная страница Chrome
  console.log('\n=== chrome://');
  const ch = await ctx.newPage(); await ch.goto('chrome://version');
  const chId = await helper.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.startsWith('chrome://version')).id);
  const p6 = await ctx.newPage();
  await p6.goto(`chrome-extension://${id}/popup.html?tabId=${chId}`);
  await p6.click('#btn-analyze');
  await p6.waitForFunction(() => document.getElementById('analysis-status').classList.contains('is-error'));
  const st = await p6.evaluate(() => document.getElementById('analysis-status').innerText);
  check(`chrome:// — «${st}»`, /Откройте страницу Confluence/.test(st), st);

  await ctx.close(); server.close();
  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
