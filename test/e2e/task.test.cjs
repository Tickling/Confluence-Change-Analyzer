// Шаг 9: вкладка «Статус задачи» в настоящем popup
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const [SP, DIST, FX, OUT] = process.argv.slice(2);
let failed = 0;
const check = (name, cond, got) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ' → ' + JSON.stringify(got).slice(0, 700)}`); if (!cond) failed++; };
const V = (number, when, name, message = '') => ({ number, when, message, by: { displayName: name } });
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/rest/experimental/content/483506343/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ results: [V(3, '2026-09-30T11:00:00Z', 'Сидоров Пётр', 'PLATFORM-11717: развилка «Принять решение» / «Проверить неоплаченный СА»'), V(2, '2026-09-17T10:00:00Z', 'Петрова Анна'), V(1, '2026-07-14T09:00:00Z', 'Иванов Иван')] }));
  }
  const m = u.pathname.match(/^\/pages\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(FX, decodeURIComponent(m[1])), (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); } });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await chromium.launchPersistentContext(path.join(SP, 'profile-task'), {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 850 }, deviceScaleFactor: 2,
    args: ['--disable-extensions-except=' + DIST, '--load-extension=' + DIST],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const helper = await ctx.newPage(); await helper.goto(`chrome-extension://${id}/popup.html`);
  const open = async (file) => {
    const url = `${base}/pages/${file}`;
    const page = await ctx.newPage(); await page.goto(url); await page.waitForTimeout(700);
    const tabId = await helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 380, height: 900 });
    popup.on('pageerror', (e) => { console.log('PAGEERROR', String(e)); failed++; });
    await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
    await popup.click('[data-tab="task"]');
    return { page, popup };
  };
  const find = async (popup, value) => {
    await popup.fill('#task-id', value);
    await popup.click('#btn-find-task');
    await popup.waitForFunction(() => !document.getElementById('btn-find-task').disabled, null, { timeout: 30000 });
    return popup.evaluate(() => {
      const groups = {};
      let cur = null;
      document.querySelectorAll('#task-results li').forEach((li) => {
        if (li.classList.contains('group-title')) { cur = li.textContent.replace(/ \(\d+\)$/, ''); groups[cur] = []; return; }
        if (cur) groups[cur].push({ meta: li.querySelector('.entry__meta')?.textContent, role: li.querySelector('.entry__role')?.textContent, text: li.querySelector('.entry__desc')?.textContent, first: Boolean(li.querySelector('.entry__first')) });
      });
      return {
        value: document.getElementById('task-id').value,
        status: document.getElementById('task-status').hidden ? '' : document.getElementById('task-status').textContent,
        card: document.getElementById('task-card').hidden ? null : {
          key: document.getElementById('task-card-key').textContent, href: document.getElementById('task-card-key').href,
          status: document.getElementById('task-card-status').textContent, meta: document.getElementById('task-card-meta').textContent,
        },
        count: document.getElementById('task-count').textContent,
        groups,
      };
    });
  };

  // ---------- CLTO-15, просмотр ----------
  console.log('\n=== CLTO-15');
  let { page, popup } = await open('clto-15.html');
  let r = await find(popup, 'platform-11717');   // строчными — должно нормализоваться; анализ запустится сам
  console.log(JSON.stringify(r.groups, null, 1).split('\n').slice(0, 40).join('\n'));
  check('ввод нормализован, анализ запущен автоматически', r.value === 'PLATFORM-11717' && r.card?.key === 'PLATFORM-11717', r);
  check('история: версия 3, колонка «Артефакт Jira», «впервые»', r.groups['История изменений']?.length === 1 && /Версия 3/.test(r.groups['История изменений'][0].meta) && r.groups['История изменений'][0].role === 'Артефакт Jira' && r.groups['История изменений'][0].first, r.groups['История изменений']);
  check('версии страницы: комментарий к версии 3', r.groups['Версии страницы']?.length === 1 && /Версия страницы 3/.test(r.groups['Версии страницы'][0].meta), r.groups['Версии страницы']);
  const docLoc = (r.groups['Документ'] || []).map((d) => d.meta);
  check('документ: 4 упоминания (шаг 8 + 3 в свёрнутых блоках, включая подгружаемый)', docLoc.length === 4
    && docLoc.some((m) => /Описание алгоритма › Шаг 8$/.test(m)) && docLoc.some((m) => /блок «Ошибки шага 8»/.test(m)) && docLoc.some((m) => /Журнал вызовов/.test(m)), docLoc);
  const docText = (r.groups['Документ'] || []).map((d) => d.text);
  check('у упоминаний есть текст рядом (шаг 8 — текст шага, блоки — их содержимое)', docText.every((t) => t && t !== '—') && /^Проверить task\.parentObjectId/.test(docText[0]) && /CHECK_UNPAID_INSURANCE_ACT/.test(docText[1]), docText);
  check('таблица «История изменений» в «Документ» не дублируется', !docLoc.some((m) => /История изменений/.test(m)), docLoc);
  check('статус не загружен (в макросе заглушка «СТАТУС»)', r.card.status === 'статус не загружен', r.card);
  check('ссылка на задачу в карточке', /jira\.example\/browse\/PLATFORM-11717/.test(r.card.href), r.card.href);
  await popup.screenshot({ path: path.join(OUT, 'task-11717.png'), fullPage: true });

  // «Показать на странице» для упоминания во вложенном свёрнутом блоке
  await page.evaluate(() => document.querySelectorAll('.expand-content').forEach((c) => c.classList.add('expand-hidden'))); // всё свернули вручную
  const idx = docLoc.findIndex((m) => /Ошибки шага 8/.test(m));
  await popup.locator('#task-results li.is-clickable').nth(idx).click();
  await page.waitForTimeout(700);
  const shown = await page.evaluate(() => {
    const inner = [...document.querySelectorAll('.expand-container')].find((b) => /Ошибки шага 8/.test(b.querySelector('.expand-control-text').textContent));
    return { open: !inner.querySelector('.expand-content').classList.contains('expand-hidden'), outerOpen: !inner.parentElement.closest('.expand-container').querySelector('.expand-content').classList.contains('expand-hidden'), flash: document.querySelectorAll('.cfa-flash').length };
  });
  check('«показать на странице»: раскрыты внешний и внутренний блоки, рамка-вспышка', shown.open && shown.outerOpen && shown.flash === 1, shown);
  await page.waitForTimeout(2300);
  check('вспышка снимается через 2 с', (await page.evaluate(() => document.querySelectorAll('.cfa-flash').length)) === 0, null);

  r = await find(popup, 'PLATFORM-9135');
  check('PLATFORM-9135: найдена в «Причине изменения» версии 2', r.groups['История изменений']?.[0]?.role === 'Причина изменения' && /Версия 2/.test(r.groups['История изменений'][0].meta), r.groups);
  r = await find(popup, 'https://jira.example/browse/PLATFORM-10842');
  check('ссылка на задачу → PLATFORM-10842: история v2 + 2 места в документе («Кого вызывает», шаг 7)', r.value === 'PLATFORM-10842' && r.groups['Документ']?.length === 2 && r.groups['Документ'].some((d) => /Кого вызывает/.test(d.meta)) && r.groups['Документ'].some((d) => /Шаг 7/.test(d.meta)), r.groups);
  r = await find(popup, 'PLATFORM-99999');
  check('несуществующая задача → «не упоминается»', /не упоминается/.test(r.status) && !r.card && r.count === '0', r);
  r = await find(popup, 'проверка');
  check('неверный формат → подсказка', /формате PROJ-123/.test(r.status), r.status);

  // Кнопка «Подсветить правки по задаче»
  await find(popup, 'PLATFORM-11717');
  await popup.click('#btn-task-highlight');
  await popup.waitForFunction(() => { const s = document.getElementById('highlight-status'); return !s.hidden && !/Поиск/.test(s.textContent); }, null, { timeout: 15000 });
  const hl = await popup.evaluate(() => ({ tab: document.querySelector('.tabs__btn.is-active').dataset.tab, jira: document.getElementById('filter-jira').value, status: document.getElementById('highlight-status').textContent }));
  check('«Подсветить правки по задаче» → вкладка «Анализ», фильтр задачи, 4 правки', hl.tab === 'analysis' && hl.jira === 'PLATFORM-11717' && /4 правки/.test(hl.status), hl);
  await page.close(); await popup.close();

  // ---------- Редактор Server: макрос Jira — картинка с параметрами ----------
  console.log('\n=== редактор Server');
  ({ page, popup } = await open('clto-15-edit-server.html'));
  r = await find(popup, 'PLATFORM-11717');
  check('редактор Server: 2 упоминания макросом в документе', r.groups['Документ']?.length === 2 && r.groups['Документ'].every((d) => d.role === 'Макрос Jira'), r.groups['Документ']);
  await popup.locator('#task-results li.is-clickable').first().click();
  await page.waitForTimeout(600);
  const ed = await page.evaluate(() => ({ boxes: document.querySelectorAll('.cfa-flash-box').length, inDoc: document.querySelector('#wysiwygTextarea_ifr').contentDocument.querySelectorAll('[style*="outline"], .cfa-flash').length }));
  check('редактор: вспышка слоем поверх, документ не тронут', ed.boxes === 1 && ed.inDoc === 0, ed);
  await page.close(); await popup.close();

  // ---------- Документ «Принять решение»: задача в заголовке, статус из макроса ----------
  console.log('\n=== «Принять решение»');
  ({ page, popup } = await open('prinyat-reshenie.html'));
  r = await find(popup, 'PLATFORM-12096');
  console.log(JSON.stringify(r.card), JSON.stringify(r.groups['Документ']));
  check('статус из макроса: «В работе»', r.card?.status === 'В работе', r.card);
  check('упоминание в заголовке раздела', r.groups['Документ']?.some((d) => d.role === 'Заголовок раздела' && /Блок «Решение по выплате»/.test(d.meta)), r.groups['Документ']);
  check('история: версия 17, Новиков', /Версия 17 .*Новиков/.test(r.groups['История изменений']?.[0]?.meta || ''), r.groups['История изменений']);
  r = await find(popup, 'PLATFORM-10119');
  const h10119 = r.groups['История изменений'] || [];
  check('PLATFORM-10119: «Причина изменения» в версиях 10 и 12, «впервые» — версия 10', h10119.length === 2 && h10119.every((h) => /^Причина изменения/.test(h.role)) && /Версия 10/.test(h10119[0].meta) && h10119[0].first, h10119);
  check('версия 10 помечена «правка отменена», версия 12 — нет', h10119[0]?.role === 'Причина изменения · правка отменена' && h10119[1]?.role === 'Причина изменения', h10119.map((h) => h.role));
  await popup.screenshot({ path: path.join(OUT, 'task-10119.png'), fullPage: true });

  await ctx.close(); server.close();
  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
