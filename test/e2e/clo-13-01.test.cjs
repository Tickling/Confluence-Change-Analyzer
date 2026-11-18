// Документ «Сценарий CLO-13.01»: описание версии несколькими оттенками (v34)
// и «похожий, но другой оттенок» — часть правки не перекрасили (v35)
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const [SP, DIST, FX, OUT] = process.argv.slice(2);
let failed = 0;
const check = (name, cond, got) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ' → ' + JSON.stringify(got).slice(0, 900)}`); if (!cond) failed++; };
const server = http.createServer((req, res) => {
  const m = req.url.match(/^\/pages\/([^?]+)/);
  if (!m) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(FX, decodeURIComponent(m[1])), (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); } });
});
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/pages/`;
  const ctx = await chromium.launchPersistentContext(path.join(SP, 'profile-clo'), {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2,
    args: ['--disable-extensions-except=' + DIST, '--load-extension=' + DIST],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const helper = await ctx.newPage(); await helper.goto(`chrome-extension://${id}/popup.html`);

  const run = async (file) => {
    const url = base + file;
    const page = await ctx.newPage(); await page.goto(url); await page.waitForTimeout(600);
    const tabId = await helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 380, height: 900 });
    popup.on('pageerror', (e) => { console.log('PAGEERROR', String(e)); failed++; });
    await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
    await popup.click('#btn-analyze');
    await popup.waitForFunction(() => /is-success|is-error/.test(document.getElementById('analysis-status').className), null, { timeout: 20000 });
    const analysis = await helper.evaluate(async () => Object.values((await chrome.storage.local.get('cfa_analysis')).cfa_analysis).find((a) => a.page.pageId === '461230011'));
    await popup.selectOption('#filter-jira', 'PLATFORM-14298');
    await popup.waitForTimeout(300);
    await popup.click('#btn-highlight');
    await popup.waitForFunction(() => { const s = document.getElementById('highlight-status'); return !s.hidden && !/Поиск/.test(s.textContent); }, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    const res = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('tr.cfa-highlight')].map((tr) => tr.cells[0].textContent.trim()),
      all: [...document.querySelectorAll('#main-content .cfa-highlight:not(.cfa-highlight--near)')].map((w) => (w.closest('tr')?.cells[0].textContent.trim() || '?') + ': ' + w.textContent.replace(/\s+/g, ' ').trim().slice(0, 45)),
      near: [...document.querySelectorAll('#main-content .cfa-highlight--near')].map((w) => ({ step: w.closest('tr')?.cells[0].textContent.trim(), label: w.dataset.cfaLabel || w.querySelector('[data-cfa-label]')?.dataset.cfaLabel, text: w.textContent.replace(/\s+/g, ' ').trim().slice(0, 50) })),
      counter: document.querySelector('.cfa-counter')?.innerText.replace(/\n/g, ' '),
    }));
    res.status = await popup.evaluate(() => document.getElementById('highlight-status').textContent);
    res.v6 = analysis.entries.find((e) => e.version === '6');
    console.log(`\n=== ${file}\n  v6:`, JSON.stringify({ color: res.v6.color, colors: res.v6.colors }));
    console.log('  правки:', JSON.stringify(res.all, null, 1));
    console.log('  похожий оттенок:', JSON.stringify(res.near));
    console.log('  статус:', JSON.stringify(res.status), '| счётчик:', res.counter);
    await page.evaluate(() => document.getElementById('step6').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, file.replace('.html', '.png')) });
    await popup.screenshot({ path: path.join(OUT, file.replace('.html', '-popup.png')), fullPage: true });
    return res;
  };

  // v34: описание двумя оттенками → оба оттенка — цвета этой версии, шаги 6–9 обводятся целиком
  let r = await run('clo-13-01-v34.html');
  check('v34: у версии 6 два оттенка описания (227D9B и 206A83)', r.v6.colors.length === 2 && r.v6.colors.includes('227D9B') && r.v6.colors.includes('206A83'), r.v6.colors);
  check('v34: шаги 6, 7, 8, 9 обведены целиком, каждый — отдельной правкой', r.rows.join() === '6,7,8,9' && r.all.length === 4, r);
  check('v34: предупреждений о похожем оттенке нет', r.near.length === 0 && !/⚠/.test(r.status), r);

  // v35: перекрашено в 2898BD, но в шаге 6 абзац «Вызвать …» остался в 227D9B
  r = await run('clo-13-01-v35.html');
  check('v35: цвет версии 6 — 2898BD', r.v6.colors.join() === '2898BD', r.v6.colors);
  check('v35: шаги 7 и 8 обведены целиком', r.rows.includes('7') && r.rows.includes('8'), r.rows);
  const call = r.near.find((n) => /Вызвать Сценарий CLAP-38\.03/.test(n.text));
  check('v35: абзац «Вызвать Сценарий CLAP-38.03…» шага 6 отмечен как похожий оттенок (#227D9B, в истории #2898BD)', call && call.step === '6' && call.label === '≈ оттенок #227D9B, в истории #2898BD', r.near);
  const link7 = r.near.find((n) => n.step === '7');
  check('v35: ссылка «DocumentRules …» старого оттенка внутри обведённого шага 7 тоже отмечена', link7 && /DocumentRules/.test(link7.text) && link7.label === '≈ оттенок #206A83, в истории #2898BD', r.near);
  check('v35: цвет другой версии (8270DB, версия 4) похожим оттенком не считается', !r.near.some((n) => /RiskElRiskReason/.test(n.text)), r.near);
  check('v35: в окне расширения предупреждение «похожий, но другой оттенок … #227D9B вместо #2898BD»', /⚠ Рядом с правками похожий, но другой оттенок: \d+ \(.*#227D9B вместо #2898BD/.test(r.status), r.status);
  check('v35: счётчик на странице — «≈ другой оттенок»', /≈ другой оттенок: \d+/.test(r.counter || ''), r.counter);

  await ctx.close(); server.close();
  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
