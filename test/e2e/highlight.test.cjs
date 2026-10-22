// E2E: расширение из dist/ + тестовые страницы по http (путь /pages/... совпадает с manifest)
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const [SP, DIST, FX, OUT] = process.argv.slice(2);
let failed = 0;
const check = (name, cond, got) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ' → ' + JSON.stringify(got)}`); if (!cond) failed++; };

const server = http.createServer((req, res) => {
  const file = path.join(FX, decodeURIComponent(req.url.replace(/^\/pages\//, '').split('?')[0]));
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data); });
});

const G = '36B37E', P = 'D04498';
const CASES = {
  'clto-15.html':             { all: 7, green: 4, greenKey: 4, pink: 3, pinkKey: 2 },
  'clto-15-edit-server.html': { all: 4, green: 2, greenKey: 2, pink: 2, pinkKey: 2 },
  'clto-15-edit-cloud.html':  { all: 3, green: 2, greenKey: 2, pink: 1, pinkKey: 1 },
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ctx = await chromium.launchPersistentContext(SP + '/profile-e2e', {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 850 },
    args: ['--disable-extensions-except=' + DIST, '--load-extension=' + DIST],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${id}/popup.html`);
  const send = (url, msg) => ext.evaluate(async ({ url, msg }) => {
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === url);
    return chrome.tabs.sendMessage(tab.id, msg);
  }, { url, msg });

  for (const [file, exp] of Object.entries(CASES)) {
    console.log(`\n=== ${file}`);
    const url = `http://127.0.0.1:${port}/pages/${file}`;
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (m.text().includes('[CFA]')) logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push('PAGEERROR ' + e));
    await page.goto(url);
    await page.waitForFunction(() => true);
    await page.waitForTimeout(800);
    const ping = await send(url, { type: 'CFA_PING' });
    console.log('  режим:', ping.mode);
    // Снимок документа до подсветки (для редактора — внутри iframe)
    const snap = () => page.evaluate(() => {
      const f = document.querySelector('#wysiwygTextarea_ifr');
      const root = f ? f.contentDocument.body : (document.querySelector('.ProseMirror') || document.querySelector('#main-content'));
      return root.innerHTML;
    });
    const before = await snap();
    // Состояние раскрывающихся блоков: Server-просмотр и Cloud-редактор
    const expState = () => page.evaluate(() => {
      const srv = [...document.querySelectorAll('#main-content .expand-container')].map((b) => ({
        title: b.querySelector('.expand-control-text').textContent,
        open: !b.querySelector('.expand-content').classList.contains('expand-hidden'),
      }));
      const cloud = [...document.querySelectorAll('.ProseMirror [data-node-type="expand"]')].map((b) => ({
        title: b.dataset.title, open: b.querySelector('button').getAttribute('aria-expanded') === 'true',
      }));
      return srv.concat(cloud);
    });

    const run = async (label, payload, expected) => {
      const r = await send(url, { type: 'CFA_APPLY_HIGHLIGHT', payload });
      check(`${label}: найдено ${expected}`, r.ok && r.count === expected, r);
      return r;
    };
    await run('все цветные', { colors: null }, exp.all);
    await run('зелёный', { colors: [G] }, exp.green);
    await run('зелёный + PLATFORM-11717', { colors: [G], issueKey: 'PLATFORM-11717' }, exp.greenKey);
    await run('розовый', { colors: [P] }, exp.pink);
    if (ping.mode !== 'edit-server') {
      const ex = await expState();
      check('розовый: в блоках нет розовых правок — все свёрнуты обратно', ex.every((b) => !b.open), ex);
    }
    const rp = await run('розовый + PLATFORM-10842', { colors: [P], issueKey: 'PLATFORM-10842' }, exp.pinkKey);
    check('у розовых правок нет зелёной задачи', rp.items.every((i) => !i.issueKeys.includes('PLATFORM-11717')), rp.items);

    // Финальный кадр: зелёный по задаче 11717
    const rg = await run('зелёный + PLATFORM-11717 (для скриншота)', { colors: [G], issueKey: 'PLATFORM-11717' }, exp.greenKey);
    check('шаг 8 связан только с PLATFORM-11717', JSON.stringify(rg.items[0].issueKeys) === '["PLATFORM-11717"]', rg.items[0].issueKeys);
    const gw = await send(url, { type: 'CFA_APPLY_HIGHLIGHT', payload: { colors: [G], issueKey: 'PLATFORM-10842' } });
    check('зелёный + чужая задача PLATFORM-10842: найдено 0', gw.count === 0, gw);
    await send(url, { type: 'CFA_APPLY_HIGHLIGHT', payload: { colors: [G], issueKey: 'PLATFORM-11717' } });
    console.log('  правки:', rg.items.map((i) => `[${i.issueKeys}] ${i.text.slice(0, 60)}…`));
    await page.waitForTimeout(900);
    const state = await page.evaluate(() => {
      const f = document.querySelector('#wysiwygTextarea_ifr');
      const root = f ? f.contentDocument.body : (document.querySelector('.ProseMirror') || document.querySelector('#main-content'));
      return {
        inDocument: root.querySelectorAll('.cfa-highlight').length,
        boxesVisible: [...document.querySelectorAll('.cfa-overlay-box')].filter((b) => b.style.display === 'block').length,
        boxesTotal: document.querySelectorAll('.cfa-overlay-box').length,
        counter: document.querySelector('.cfa-counter__text')?.textContent,
      };
    });
    console.log('  состояние:', JSON.stringify(state));
    if (ping.editable) {
      check('редактор: в документе нет обёрток/классов', state.inDocument === 0, state);
      check('редактор: рамки нарисованы слоем поверх', state.boxesTotal === exp.greenKey && state.boxesVisible >= 1, state);
      // Во время подсветки допускается только смена признака «блок развёрнут»
      const norm = (h) => h.replace(/ (aria-expanded|data-expanded)="[^"]*"/g, '');
      check('редактор: текст и разметка документа не изменились', norm(await snap()) === norm(before), 'diff');
    } else {
      check('просмотр: рамки-обёртки в документе', state.inDocument === exp.greenKey, state);
    }
    check('счётчик на странице', new RegExp(`Совпадение 1 из ${exp.greenKey}`).test(state.counter || ''), state.counter);
    if (ping.mode !== 'edit-server') {
      const ex = await expState();
      console.log('  блоки:', JSON.stringify(ex));
      const open = (re) => ex.filter((b) => re.test(b.title)).every((b) => b.open);
      check('раскрыт блок с правкой «Ответ при развилке»', open(/Ответ при развилке/), ex);
      check('блок без правок свёрнут обратно', ex.filter((b) => /без изменений/.test(b.title)).every((b) => !b.open), ex);
      if (ping.mode === 'view') {
        check('вложенный блок раскрыт (внешний и внутренний)', open(/Ошибки сценария/) && open(/Ошибки шага 8/), ex);
        check('«ленивый» блок раскрыт и его содержимое найдено', open(/Журнал вызовов/) && rg.items.some((i) => /insActId/.test(i.text)), rg.items.map((i) => i.text.slice(0, 40)));
      }
      check('рамки видны во всех найденных правках', state.boxesVisible === exp.greenKey || state.inDocument === exp.greenKey, state);
    }
    await page.screenshot({ path: `${OUT}/${file.replace('.html', '')}.png` });
    if (ping.mode === 'view') {
      await page.evaluate(() => window.scrollTo(0, document.getElementById('primery').getBoundingClientRect().top + scrollY - 60));
      await page.waitForTimeout(400);
      await page.waitForTimeout(800); await page.evaluate(() => window.scrollTo({ top: document.getElementById('primery').getBoundingClientRect().top + scrollY - 20, behavior: 'instant' })); await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/view-expanded.png` });
    }

    // Редактор: правим текст — рамки должны пересчитаться
    if (ping.mode === 'edit-cloud') {
      await page.evaluate(() => {
        const p = document.createElement('p');
        p.innerHTML = '<span class="fabric-text-color-mark" style="--custom-palette-color: #36B37E" data-text-custom-color="#36b37e">Новая строка правки</span> <span data-inline-card="true" data-card-url="https://example.atlassian.net/browse/PLATFORM-11717"><a href="https://example.atlassian.net/browse/PLATFORM-11717">PLATFORM-11717</a></span>';
        document.querySelector('.ProseMirror').appendChild(p);
      });
      await page.waitForTimeout(1200);
      const boxes = await page.evaluate(() => document.querySelectorAll('.cfa-overlay-box').length);
      check('редактор: новая правка подхвачена автоматически', boxes === exp.greenKey + 1, boxes);
      await page.evaluate(() => document.querySelector('.ProseMirror').lastElementChild.remove());
    }

    await send(url, { type: 'CFA_CLEAR_HIGHLIGHT' });
    const after = await page.evaluate(() => ({ boxes: document.querySelectorAll('.cfa-overlay-box, .cfa-counter').length }));
    check('сброс: рамки и счётчик убраны', after.boxes === 0, after);
    // «Ленивый» блок после раскрытия хранит подгруженное содержимое — это поведение самой страницы
    // Атрибуты, которые ставят скрипты самой тестовой страницы (не расширение)
    const stripLazy = (h) => h.replace(/ data-(loaded|expanded)="[^"]*"/g, '')
      .replace(/(id="exp-lazy"[^>]*>[\s\S]*?<div class="expand-content[^"]*">)[\s\S]*?(<\/div>\s*<\/div>)/, '$1$2');
    const a1 = stripLazy(before), a2 = stripLazy(await snap());
    let di = 0; while (di < a1.length && a1[di] === a2[di]) di++;
    check('сброс: HTML документа восстановлен', a1 === a2, { было: a1.slice(di - 80, di + 120), стало: a2.slice(di - 80, di + 120) });
    if (ping.mode !== 'edit-server') {
      const ex = await expState();
      check('сброс: все блоки свёрнуты как были', ex.every((b) => !b.open), ex);
    }
    const errs = logs.filter((l) => /PAGEERROR|Ошибка/.test(l));
    check('без ошибок в консоли', errs.length === 0, errs);
    await page.close();
  }
  await ctx.close(); server.close();
  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
