// Confluence DC 8+: цвета через CSS-переменные темы и CSS-классы (документ «Выплатное дело. Детали события»)
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const [SP, DIST, FX, OUT] = process.argv.slice(2);
let failed = 0;
const check = (name, cond, got) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ' → ' + JSON.stringify(got).slice(0, 700)}`); if (!cond) failed++; };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/pages\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(FX, decodeURIComponent(m[1])), (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); } });
});
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/pages/vyplatnoe-delo-dc.html`;
  const ctx = await chromium.launchPersistentContext(path.join(SP, 'profile-dc'), {
    channel: 'chromium', headless: true, acceptDownloads: true, viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2,
    args: ['--disable-extensions-except=' + DIST, '--load-extension=' + DIST],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const helper = await ctx.newPage(); await helper.goto(`chrome-extension://${id}/popup.html`);
  const page = await ctx.newPage(); await page.goto(url); await page.waitForTimeout(700);
  const tabId = await helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 900 });
  popup.on('pageerror', (e) => { console.log('PAGEERROR', String(e)); failed++; });
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
  await popup.click('#btn-analyze');
  await popup.waitForFunction(() => /is-success|is-error/.test(document.getElementById('analysis-status').className), null, { timeout: 20000 });

  const analysis = await helper.evaluate(async () => Object.values((await chrome.storage.local.get('cfa_analysis')).cfa_analysis).find((a) => a.page.pageId === '445080454'));
  const col = Object.fromEntries(analysis.entries.map((e) => [e.version, e.color]));
  console.log('  цвета описаний:', JSON.stringify(col));
  check('5 записей истории', analysis.entries.length === 5, analysis.entries.length);
  check('версия 11: color: var(--ds-text-accent-orange) без запасного цвета → FF9966', col['11'] === 'FF9966', col);
  check('версия 10: var(--ds-text-accent-red) → DE350B (ссылка внутри описания не мешает)', col['10'] === 'DE350B', col);
  check('версия 7: var(--…, rgb(…)) → фактический цвет темы 5B7F24, а не запасной', col['7'] === '5B7F24', col);
  check('версия 5: цвет задан CSS-классом → 8777D9', col['5'] === '8777D9', col);
  check('версия 1: обычный текст → без цвета', col['1'] === null, col);
  check('автор — @упоминание, дата — плашка <time>', analysis.entries[4].author === 'Иванов Иван Иванович (Ivan Ivanov)' && analysis.entries[4].dateISO === '2026-08-20', analysis.entries[4]);

  const hl = async (filters) => {
    await popup.selectOption('#filter-date', filters.date || '');
    await popup.selectOption('#filter-author', filters.author || '');
    await popup.selectOption('#filter-jira', filters.jira || '');
    await popup.waitForTimeout(300);
    await popup.click('#btn-highlight');
    await popup.waitForFunction(() => { const s = document.getElementById('highlight-status'); return !s.hidden && !/Поиск/.test(s.textContent); }, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    return {
      status: await popup.evaluate(() => document.getElementById('highlight-status').textContent),
      found: await page.evaluate(() => [...document.querySelectorAll('#main-content .cfa-highlight')].map((w) => w.textContent.replace(/\s+/g, ' ').trim())),
    };
  };
  let r = await hl({ jira: 'PLATFORM-9070' });
  check(`PLATFORM-9070 → шаг 5 альтернативного сценария 0: «${r.status}»`, r.found.length === 1 && /Сохранение данных персоны/.test(r.found[0]) && /найдено: 1 правка/.test(r.status), r);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'dc-9070.png') });
  r = await hl({ jira: 'PLATFORM-5619' });
  check('PLATFORM-5619 (красный через var, задача в том же абзаце) → 1', r.found.length === 1 && /payRecipients/.test(r.found[0]), r);
  r = await hl({ jira: 'PROD-54724' });
  check('PROD-54724 (зелёный через var с запасным цветом) → 1', r.found.length === 1 && /Поле «Создал»/.test(r.found[0]), r);
  r = await hl({ author: 'Петрова Анна Сергеевна (Anna Petrova)' });
  check('автор Петрова (версии 5 и 10: класс и var) → 2 правки', r.found.length === 2 && r.found.some((t) => /Реквизиты/.test(t)) && r.found.some((t) => /payRecipients/.test(t)), r);
  r = await hl({});
  check('без фильтров → 4 правки, без ложных: ссылки, @упоминания, даты, заголовок блока, код', r.found.length === 4
    && !r.found.some((t) => /Морозова|Показать пример|POST|1 мар\./.test(t)), r);

  // Выгрузка в Word: цвет и зачёркивание
  await popup.selectOption('#filter-jira', 'PLATFORM-9070'); await popup.waitForTimeout(300);
  const before = await helper.evaluate(async () => (await chrome.downloads.search({})).length);
  await popup.click('#btn-export');
  await popup.waitForFunction(() => { const s = document.getElementById('export-status'); return !s.hidden && !/Формирование/.test(s.textContent); }, null, { timeout: 30000 });
  let item = null;
  for (let i = 0; i < 50 && !item; i += 1) {
    const all = await helper.evaluate(async () => chrome.downloads.search({ orderBy: ['-startTime'] }));
    if (all.length > before && all[0].state === 'complete') item = all[0]; else await popup.waitForTimeout(200);
  }
  const dest = path.join(OUT, 'dc-9070.docx'); fs.copyFileSync(item.filename, dest);
  const xml = execSync(`unzip -p "${dest}" word/document.xml`).toString();
  const paras = xml.split('</w:p>').map((p) => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).filter(Boolean);
  check('Word: расположение «… › Альтернативный сценарий 0. Редактирование персоны › Шаг 5»', paras.includes('Расположение: Варианты использования › Альтернативный сценарий 0. Редактирование персоны › Шаг 5'), paras.filter((p) => /Располож/.test(p)));
  check('Word: оранжевый цвет FF9966 и зачёркнутый пункт', /w:val="FF9966"/.test(xml) && /<w:strike\/>/.test(xml), null);
  check('Word: автор Иванов в шапке', paras.some((p) => /^Автор: Иванов Иван Иванович/.test(p)), null);

  // «Статус задачи»: статус из плашки макроса
  await popup.click('[data-tab="task"]');
  await popup.fill('#task-id', 'PLATFORM-9070');
  await popup.click('#btn-find-task');
  await popup.waitForFunction(() => !document.getElementById('btn-find-task').disabled, null, { timeout: 30000 });
  const st = await popup.evaluate(() => document.getElementById('task-card-status').textContent);
  check('«Статус задачи»: статус PLATFORM-9070 из макроса — «ТЕСТИРОВАНИЕ»', st === 'ТЕСТИРОВАНИЕ', st);

  await ctx.close(); server.close();
  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
