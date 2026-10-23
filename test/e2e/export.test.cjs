// Шаг 8: «Скачать Word» в настоящем popup → .docx; проверяем содержимое файла
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const [SP, DIST, FX, OUT] = process.argv.slice(2);
let failed = 0;
const check = (name, cond, got) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ' → ' + JSON.stringify(got).slice(0, 600)}`); if (!cond) failed++; };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.includes('/version')) { res.writeHead(404); return res.end(); }
  const m = u.pathname.match(/^\/pages\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(FX, decodeURIComponent(m[1])), (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); } });
});
/** Текст и цвета из word/document.xml */
const readDocx = (file) => {
  const xml = execSync(`unzip -p "${file}" word/document.xml`).toString();
  const core = execSync(`unzip -p "${file}" docProps/core.xml`).toString();
  const paras = xml.split('</w:p>').map((p) => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).filter(Boolean)
    .map((t) => t.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  const colors = [...new Set([...xml.matchAll(/<w:color w:val="([0-9A-F]{6})"/g)].map((m) => m[1]))];
  return { paras, colors, creator: (core.match(/<dc:creator>([^<]*)/) || [])[1], xml };
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await chromium.launchPersistentContext(SP + '/profile-x', {
    channel: 'chromium', headless: true, acceptDownloads: true, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    args: ['--disable-extensions-except=' + DIST, '--load-extension=' + DIST],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${id}/popup.html`);
  const files = {};

  const run = async (label, file, { jira = '', author = '' }) => {
    const url = `${base}/pages/${file}`;
    const page = await ctx.newPage();
    await page.goto(url); await page.waitForTimeout(700);
    const tabId = await helper.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, url);
    const popup = await ctx.newPage();
    popup.on('pageerror', (e) => { console.log('PAGEERROR', String(e)); failed++; });
    await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
    await popup.click('#btn-analyze');
    await popup.waitForFunction(() => document.getElementById('analysis-status').classList.contains('is-success'), null, { timeout: 20000 });
    await popup.selectOption('#filter-jira', jira);
    await popup.selectOption('#filter-author', author);
    await popup.waitForTimeout(300);
    check('в окне нет выбора режима — только «найденные правки»', (await popup.locator('input[name="export-mode"]').count()) === 0, null);
    const before = await helper.evaluate(async () => (await chrome.downloads.search({})).length);
    await popup.click('#btn-export');
    await popup.waitForFunction(() => {
      const s = document.getElementById('export-status');
      return !s.hidden && !/Формирование/.test(s.textContent);
    }, null, { timeout: 30000 });
    const status = await popup.evaluate(() => document.getElementById('export-status').textContent);
    // Ждём завершения скачивания и берём путь к файлу
    let item = null;
    for (let i = 0; i < 50 && !item; i += 1) {
      const all = await helper.evaluate(async () => chrome.downloads.search({ orderBy: ['-startTime'] }));
      if (all.length > before && all[0].state === 'complete') item = all[0];
      else await popup.waitForTimeout(200);
    }
    check(`${label}: «${status}»`, /Сохранено/.test(status) && item && fs.existsSync(item.filename), { status, item });
    const dest = path.join(OUT, `${label}.docx`);
    if (item) fs.copyFileSync(item.filename, dest);
    files[label] = dest;
    await page.close(); await popup.close();
    return { status, file: dest };
  };

  await run('view-11717', 'clto-15.html', { jira: 'PLATFORM-11717' });
  await run('view-petrova', 'clto-15.html', { author: 'Петрова Анна Сергеевна (Anna Petrova)' });
  await run('server-11717', 'clto-15-edit-server.html', { jira: 'PLATFORM-11717' });
  await run('cloud-11717', 'clto-15-edit-cloud.html', { jira: 'PLATFORM-11717' });
  await ctx.close(); server.close();

  // ---------- Содержимое файлов ----------
  console.log('\n=== содержимое view-11717');
  let d = readDocx(files['view-11717']);
  console.log(d.paras.map((p) => '  | ' + p).join('\n'));
  const has = (re) => d.paras.some((p) => re.test(p));
  check('шапка: автор Сидоров', has(/^Автор: Сидоров Пётр Павлович/), null);
  check('шапка: дата изменения и описание', has(/^Дата изменения: 30 сент\. 2026/) && has(/^Описание: Реализовать развилку/), null);
  check('свойства файла: автор = Сидоров', /Сидоров/.test(d.creator), d.creator);
  check('4 пункта', d.paras.filter((p) => /^Пункт \d$/.test(p)).length === 4, d.paras.filter((p) => /^Пункт/.test(p)));
  check('пункт 1: Вариант использования › Описание алгоритма › Шаг 8', has(/^Расположение: Вариант использования › Описание алгоритма › Шаг 8$/), null);
  check('пункт 1: после текста шага 7', d.paras.some((p) => /^После текста: «.*при выполнении условий\.»$/.test(p)), null);
  check('пункт 1: номер шага не дублируется абзацем «8»', !d.paras.includes('8'), null);
  check('пункт 1: фрагмент и пункты списка', has(/^Проверить task\.parentObjectId/) && has(/^• При возврате ошибки 400 и 404/), null);
  check('пункт 2: в блоке «Ответ при развилке»', has(/^Расположение: Примеры запросов › блок «Ответ при развилке/), null);
  check('пункт 3: вложенный блок', has(/^Расположение: Примеры запросов › блок «Ошибки сценария» › блок «Ошибки шага 8»$/), null);
  check('пункт 3: после текста «Перечень кодов…»', has(/^После текста: «Перечень кодов ошибок сценария\.»$/), null);
  check('пункт 4: «ленивый» блок', has(/блок «Журнал вызовов/) && has(/^Вызов CIA-09 логируется/), null);
  check('цвет правок сохранён (36B37E)', d.colors.includes('36B37E'), d.colors);
  // Пункты списка, у которых цвет задан на <ul>, тоже зелёные
  const liRun = d.xml.split('</w:p>').find((p) => /При возврате ошибки 400/.test(p)) || '';
  check('пункты списка выгружены зелёным (цвет задан на списке)', /w:val="36B37E"/.test(liRun), liRun.slice(0, 300));
  check('нет плашек «СТАТУС» в тексте правок', !d.paras.some((p) => /СТАТУС/.test(p)), null);

  console.log('\n=== view-petrova');
  d = readDocx(files['view-petrova']);
  const rows = d.paras.filter((p) => /^Расположение/.test(p));
  console.log(rows.map((p) => '  | ' + p).join('\n'));
  check('3 пункта: «Кого вызывает», строка docStatus, шаг 7', rows.length === 3 && /Кого вызывает/.test(rows[0]) && /Строка «docStatus»/.test(rows[1]) && /Шаг 7/.test(rows[2]), rows);
  check('автор в шапке и цвет D04498', d.paras.some((p) => /^Автор: Петрова/.test(p)) && d.colors.includes('D04498'), d.colors);

  for (const k of ['server-11717', 'cloud-11717']) {
    console.log(`\n=== ${k}`);
    d = readDocx(files[k]);
    const r = d.paras.filter((p) => /^(Расположение|После текста)/.test(p));
    console.log(r.map((p) => '  | ' + p).join('\n'));
    check(`${k}: в расположении нет «Строка «{…»» (макрос — не строка таблицы)`, !r.some((p) => /Строка «\{/.test(p)), r);
    check(`${k}: 2 пункта, шаг 8 и блок примера`, d.paras.filter((p) => /^Пункт \d$/.test(p)).length === 2 && /Шаг 8/.test(r[0]) && r.some((p) => /блок «Ответ при развилке»/.test(p)), r);
  }

  // ---------- Открывается ли в LibreOffice ----------
  console.log('\n=== LibreOffice');
  for (const [k, f] of Object.entries(files)) {
    try {
      execSync(`soffice --headless --convert-to pdf "${f}" --outdir "${OUT}"`, { stdio: 'ignore', timeout: 120000 });
      const pdf = f.replace(/\.docx$/, '.pdf');
      const pages = execSync(`pdfinfo "${pdf}" | grep Pages`).toString().trim();
      check(`${k}.docx открывается (${pages})`, fs.existsSync(pdf), null);
    } catch (e) { check(`${k}.docx открывается`, false, String(e)); }
  }
  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
