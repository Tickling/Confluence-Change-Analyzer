// Шаг 4: разбор «Истории изменений» — e2e через расширение + модульные проверки
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const [SP, DIST, FX, HARNESS] = process.argv.slice(2);
let failed = 0;
const check = (name, cond, got) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ' → ' + JSON.stringify(got)}`); if (!cond) failed++; };
const server = http.createServer((req, res) => {
  const file = path.join(FX, decodeURIComponent(req.url.replace(/^\/pages\//, '').split('?')[0]));
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data); });
});
const EXPECTED = [
  { version: '1', dateISO: '2026-07-14', author: 'Иванов Иван Иванович (Ivan Ivanov)', jiraKeys: ['PLATFORM-9209'], color: null, reasonKeys: [] },
  { version: '2', dateISO: '2026-09-17', author: 'Петрова Анна Сергеевна (Anna Petrova)', jiraKeys: ['PLATFORM-10842'], color: 'D04498', reasonKeys: ['PLATFORM-9135'] },
  { version: '3', dateISO: '2026-09-30', author: 'Сидоров Пётр Павлович (Petr Sidorov)', jiraKeys: ['PLATFORM-11717'], color: '36B37E', reasonKeys: [] },
];
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ctx = await chromium.launchPersistentContext(SP + '/profile-p', {
    channel: 'chromium', headless: true,
    args: ['--disable-extensions-except=' + DIST, '--load-extension=' + DIST],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${id}/popup.html`);
  for (const file of ['clto-15.html', 'clto-15-edit-server.html', 'clto-15-edit-cloud.html']) {
    console.log(`\n=== ${file}`);
    const url = `http://127.0.0.1:${port}/pages/${file}`;
    const page = await ctx.newPage();
    await page.goto(url); await page.waitForTimeout(800);
    const r = await ext.evaluate(async (url) => {
      const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === url);
      return chrome.tabs.sendMessage(tab.id, { type: 'CFA_PARSE_HISTORY' });
    }, url);
    check('ответ получен', r.ok, r);
    console.log('  режим:', r.mode, '| страница:', JSON.stringify(r.page));
    check('3 записи', r.entries.length === 3, r.entries.length);
    EXPECTED.forEach((exp, i) => {
      const e = r.entries[i] || {};
      const pick = { version: e.version, dateISO: e.dateISO, author: e.author, jiraKeys: e.jiraKeys, color: e.color, reasonKeys: e.reasonKeys };
      check(`версия ${i + 1}: № / дата / автор / задача / цвет / причина`, JSON.stringify(pick) === JSON.stringify(exp), pick);
    });
    check('описание версии 3', /^Реализовать развилку/.test(r.entries[2]?.description), r.entries[2]?.description);
    check('варианты фильтра «Артефакт Jira»', JSON.stringify(r.filterOptions.jiraKeys) === '["PLATFORM-9209","PLATFORM-10842","PLATFORM-11717"]', r.filterOptions.jiraKeys);
    check('варианты фильтра «Дата»', r.filterOptions.dates.map((d) => d.value).join() === '2026-07-14,2026-09-17,2026-09-30', r.filterOptions.dates);
    check('варианты фильтра «Автор»: 3', r.filterOptions.authors.length === 3, r.filterOptions.authors);
    check('id страницы', r.page.pageId === '483506343' || r.mode === 'edit-cloud', r.page);
    if (file === 'clto-15.html') console.log('  пример записи:', JSON.stringify(r.entries[2], null, 1));
    await page.close();
  }
  await ctx.close(); server.close();

  // ---------- Модульные проверки ----------
  console.log('\n=== модульные проверки');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<html><body><div id="r"></div></body></html>');
  await page.addScriptTag({ content: fs.readFileSync(HARNESS, 'utf8') });
  const u = await page.evaluate(() => {
    const dates = ['14 июл. 2026 г.', '17 сент. 2026 г.', '3 мая 2026', '1 марта 2025 г.', '14.07.2026', '2026-07-14', 'Jul 14, 2026', '14 Jul 2026', '31.02.2026', 'вчера'].map((d) => [d, P.parseDate(d)]);
    // Таблица с объединённой ячейкой даты (rowspan) и другим порядком колонок
    document.getElementById('r').innerHTML = `<table><tr><th>Автор</th><th>Описание</th><th>Дата</th><th>Задача</th></tr>
      <tr><td>Иванов</td><td><span style="color:#FF5630">Первая правка</span> и чуть-чуть текста</td><td rowspan="2">05.10.2026</td><td><a href="https://jira.x/browse/ABC-1">ABC-1</a></td></tr>
      <tr><td>Петров</td><td><span style="background-color: rgb(255, 250, 230)">Вторая</span> правка</td><td><a href="https://jira.x/browse/ABC-2">ABC-2</a> CLTO-20</td></tr></table>`;
    const t = P.parseHistoryTable(document.getElementById('r'));
    const v = P.parseVersionsResponse({ results: [{ number: 2, when: '2026-09-17T10:00:00.000+03:00', message: 'правка', by: { displayName: 'Петрова' } }, { number: 3, when: '2026-09-30T12:00:00Z', message: '', by: { displayName: 'Сидоров' } }] }, { baseUrl: 'https://c.x', pageId: '42' });
    return { dates, t, v };
  });
  const want = { '14 июл. 2026 г.': '2026-07-14', '17 сент. 2026 г.': '2026-09-17', '3 мая 2026': '2026-05-03', '1 марта 2025 г.': '2025-03-01', '14.07.2026': '2026-07-14', '2026-07-14': '2026-07-14', 'Jul 14, 2026': '2026-07-14', '14 Jul 2026': '2026-07-14', '31.02.2026': null, 'вчера': null };
  u.dates.forEach(([d, got]) => check(`дата «${d}» → ${want[d]}`, got === want[d], got));
  check('rowspan: дата у обеих строк', u.t.length === 2 && u.t.every((e) => e.dateISO === '2026-10-05'), u.t.map((e) => e.dateISO));
  check('другой порядок колонок: автор/описание', u.t[0]?.author === 'Иванов' && /^Первая правка/.test(u.t[0]?.description), u.t[0]);
  check('цвет по преобладающему тексту', u.t[0]?.color === 'FF5630', u.t[0]?.color);
  check('цвет фона описания', u.t[1]?.backgroundColor === 'FFFAE6' && u.t[1]?.color === null, u.t[1]);
  check('CLTO-20 в тексте не считается задачей', JSON.stringify(u.t[1]?.jiraKeys) === '["ABC-2"]', u.t[1]?.jiraKeys);
  check('REST: версии от новых к старым, ссылки', u.v[0].number === 3 && u.v[1].url === 'https://c.x/pages/viewpage.action?pageId=42&pageVersion=2' && u.v[1].dateISO === '2026-09-17', u.v);
  await browser.close();
  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
