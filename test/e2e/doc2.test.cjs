// Документ №2 «Принять решение»: задачи в заголовках, зачёркнутый текст, маркер, много цветов
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
  const url = `http://127.0.0.1:${server.address().port}/pages/prinyat-reshenie.html`;
  const ctx = await chromium.launchPersistentContext(SP + '/profile-d2', {
    channel: 'chromium', headless: true, acceptDownloads: true, viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2,
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
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

  const analysis = await helper.evaluate(async () => Object.values((await chrome.storage.local.get('cfa_analysis')).cfa_analysis).find((a) => a.page.pageId === '454687494'));
  const E = analysis.entries;
  check('7 записей истории', E.length === 7, E.length);
  check('цвета: зачёркнутое описание версии 10 → оранжевый, список версии 12 → маджента, версия 17 → жёлтый',
    E.find((e) => e.version === '10').color === 'FF8B00' && E.find((e) => e.version === '12').color === 'E774BB' && E.find((e) => e.version === '17').color === 'FFC400', E.map((e) => [e.version, e.color]));
  check('версия 10 (описание зачёркнуто) — отменена, остальные — нет', E.filter((e) => e.cancelled).map((e) => e.version).join() === '10', E.map((e) => [e.version, e.cancelled]));
  check('причина изменения версии 10 → PLATFORM-10119', JSON.stringify(E.find((e) => e.version === '10').reasonKeys) === '["PLATFORM-10119"]', null);

  const hl = async (filters) => {
    await popup.selectOption('#filter-date', filters.date || '');
    await popup.selectOption('#filter-author', filters.author || '');
    await popup.selectOption('#filter-jira', filters.jira || '');
    await popup.waitForTimeout(300);
    await popup.click('#btn-highlight');
    await popup.waitForFunction(() => { const s = document.getElementById('highlight-status'); return !s.hidden && !/Поиск/.test(s.textContent); }, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    return page.evaluate(() => [...document.querySelectorAll('#main-content .cfa-highlight')].map((w) => w.textContent.replace(/\s+/g, ' ').trim()));
  };
  const cases = [
    ['PLATFORM-12096 (задача в заголовке раздела)', { jira: 'PLATFORM-12096' }, 1, /Отобразить список получателей/],
    ['PLATFORM-10491 (зачёркнутые правки шага 7)', { jira: 'PLATFORM-10491' }, 1, /документов-файлов.*Заметки/],
    ['PLATFORM-10661 (список в шаге 4)', { jira: 'PLATFORM-10661' }, 1, /для каждого объекта/],
    ['PLATFORM-5754 (фрагмент внутри строки, шаг 1)', { jira: 'PLATFORM-5754' }, 1, /CLTO-09\.03/],
    ['PLATFORM-8943 (два фрагмента в строке, задача абзацем ниже)', { jira: 'PLATFORM-8943' }, 2, /fractionSimple/],
    ['PLATFORM-5587 (в свёрнутом блоке)', { jira: 'PLATFORM-5587' }, 1, /Страховой акт/],
    ['PLATFORM-12154 (задача в том же абзаце)', { jira: 'PLATFORM-12154' }, 1, /пересчитывается/],
    ['автор Петрова (3 версии, 3 цвета)', { author: 'Петрова Анна Сергеевна (Anna Petrova)' }, 5, /./],
  ];
  for (const [label, f, n, re] of cases) {
    const found = await hl(f);
    check(`${label}: ${n}`, found.length === n && found.some((t) => re.test(t)), found);
  }
  // ---------- Отменённая правка (версия 10) ----------
  await hl({ jira: 'PLATFORM-10491' });
  const canc = await page.evaluate(() => {
    const w = document.querySelector('#main-content .cfa-highlight');
    return {
      cls: w.className, label: w.dataset.cfaLabel,
      badge: getComputedStyle(w, '::before').content,
      counter: document.querySelector('.cfa-counter__hint--cancelled')?.textContent,
    };
  });
  check('отменённая правка: пунктирная рамка с подписью «✕ Отменено · версия 10»', /cfa-highlight--cancelled/.test(canc.cls) && canc.label === 'Отменено · версия 10' && /Отменено · версия 10/.test(canc.badge), canc);
  check('счётчик на странице: «отменено: 1»', canc.counter === 'отменено: 1', canc.counter);
  const pop = await popup.evaluate(() => ({
    status: document.getElementById('highlight-status').textContent,
    badge: document.querySelector('#entries-list .entry__cancelled')?.textContent,
    struck: document.querySelector('#entries-list .entry__desc.is-cancelled') !== null,
  }));
  check('popup: «из них отменено: 1», у записи пометка «отменена»', /из них отменено: 1/.test(pop.status) && pop.badge === 'отменена' && pop.struck, pop);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/doc2-cancelled.png` });
  const ryab = await hl({ author: 'Козлов Дмитрий Викторович (Dmitry Kozlov)' });
  const ryabCancelled = await page.evaluate(() => document.querySelectorAll('#main-content .cfa-highlight--cancelled').length);
  check('автор Козлов (версии 10 и 12): 2 правки, отменена только одна', ryab.length === 2 && ryabCancelled === 1, { ryab, ryabCancelled });

  // Шаг 4: в одной ячейке маджента (10661) и бирюзовый (5754) — бирюзовый абзац не относится к 10661
  const t5754 = await hl({ jira: 'PLATFORM-5754' });
  check('бирюзовый абзац шага 4 рядом с задачей 10661 не попадает в 5754', !t5754.some((t) => /damagedObjects/.test(t)), t5754);
  await hl({ jira: 'PLATFORM-12096' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/doc2-12096.png` });

  // Экспорт: зачёркивание и расположение под заголовком с задачей
  const exportDocx = async (jira, name) => {
    await popup.selectOption('#filter-jira', jira); await popup.waitForTimeout(300);
    const before = await helper.evaluate(async () => (await chrome.downloads.search({})).length);
    await popup.click('#btn-export');
    await popup.waitForFunction(() => { const s = document.getElementById('export-status'); return !s.hidden && !/Формирование/.test(s.textContent); }, null, { timeout: 30000 });
    let item = null;
    for (let i = 0; i < 50 && !item; i += 1) {
      const all = await helper.evaluate(async () => chrome.downloads.search({ orderBy: ['-startTime'] }));
      if (all.length > before && all[0].state === 'complete') item = all[0]; else await popup.waitForTimeout(200);
    }
    const dest = path.join(OUT, name); fs.copyFileSync(item.filename, dest);
    const xml = execSync(`unzip -p "${dest}" word/document.xml`).toString();
    const paras = xml.split('</w:p>').map((p) => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).filter(Boolean).map((t) => t.replace(/&quot;/g, '"'));
    return { xml, paras, dest };
  };
  let d = await exportDocx('PLATFORM-10491', 'doc2-10491.docx');
  console.log(d.paras.filter((p) => /^(Расположение|После текста|При |Заметки|Автор|Описание)/.test(p)).map((p) => '  | ' + p).join('\n'));
  check('Word: зачёркнутый текст сохранён (<w:strike/>)', /<w:strike\/>|<w:strike w:val="true"\/>/.test(d.xml), null);
  check('Word: оранжевый цвет FF8B00', /w:val="FF8B00"/.test(d.xml), null);
  check('Word: расположение «Варианты использования › Основной сценарий › Шаг 7»', d.paras.includes('Расположение: Варианты использования › Основной сценарий › Шаг 7'), d.paras.filter((p) => /Располож/.test(p)));
  check('Word: после текста «Сохранить изменения, вызвав…»', d.paras.some((p) => /^После текста: «Сохранить изменения, вызвав Сценарий CLTO-11\.03\.»$/.test(p)), null);
  check('Word: автор Козлов в шапке', d.paras.some((p) => /^Автор: Козлов/.test(p)), null);
  check('Word: в шапке «Статус: правка отменена»', d.paras.includes('Статус: правка отменена'), d.paras.slice(0, 12));
  check('Word: у пункта «Статус: правка отменена (версия 10)…»', d.paras.some((p) => /^Статус: правка отменена \(версия 10\) — описание в «Истории изменений» зачёркнуто$/.test(p)), d.paras.filter((p) => /Статус/.test(p)));
  d = await exportDocx('PLATFORM-12096', 'doc2-12096.docx');
  console.log(d.paras.filter((p) => /^(Расположение|После текста)/.test(p)).map((p) => '  | ' + p).join('\n'));
  check('Word: заголовок с задачей очищен от плашки Jira', d.paras.includes('Расположение: Варианты использования › Блок «Решение по выплате» › Переход в состояние "Частичная выплата"'), d.paras.filter((p) => /Располож/.test(p)));
  check('Word: после текста «При выборе варианта…»', d.paras.some((p) => /^После текста: «При выборе варианта «Частичная выплата»:»$/.test(p)), null);
  for (const f of ['doc2-10491.docx', 'doc2-12096.docx']) {
    execSync(`soffice --headless --convert-to pdf "${path.join(OUT, f)}" --outdir "${OUT}"`, { stdio: 'ignore', timeout: 120000 });
    check(`${f} открывается в LibreOffice`, fs.existsSync(path.join(OUT, f.replace('.docx', '.pdf'))), null);
  }
  // Редактор Server: отменённая правка рисуется слоем поверх с подписью, слой остаётся position: fixed
  const edUrl = url.replace('prinyat-reshenie.html', 'clto-15-edit-server.html');
  const ed = await ctx.newPage(); await ed.goto(edUrl); await ed.waitForTimeout(700);
  const edTab = await helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, edUrl);
  const edRes = await helper.evaluate(async (tabId) => chrome.runtime.sendMessage({ type: 'CFA_APPLY_HIGHLIGHT', payload: { tabId, options: { colors: ['36B37E'], cancelled: [{ color: '36B37E', label: 'Отменено · версия 3' }] } } }), edTab);
  await ed.waitForTimeout(500);
  const box = await ed.evaluate(() => {
    const b = document.querySelector('.cfa-overlay-box--cancelled');
    return b && { label: b.dataset.cfaLabel, pos: getComputedStyle(b).position, border: getComputedStyle(b).borderTopStyle, visible: b.style.display === 'block', inDoc: document.querySelector('#wysiwygTextarea_ifr').contentDocument.querySelectorAll('[data-cfa-label]').length };
  });
  check('редактор: отменённая правка — пунктирная рамка слоем поверх, position: fixed, документ не тронут', edRes.ok && box && box.label === 'Отменено · версия 3' && box.pos === 'fixed' && box.border === 'dashed' && box.visible && box.inDoc === 0, { edRes, box });

  await ctx.close(); server.close();
  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
