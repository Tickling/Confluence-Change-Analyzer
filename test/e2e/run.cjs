/**
 * Запуск сквозных (e2e) тестов расширения в Chromium через Playwright.
 *
 * Перед запуском: npm run build (тестируется собранное расширение из dist/).
 * Каждый тест загружает расширение, открывает тестовые страницы из test/fixtures
 * (Confluence Server: просмотр и редактор, Confluence Cloud: редактор) и проверяет
 * поведение через настоящий popup и content script.
 *
 * Запуск: npm run test:e2e            — все тесты
 *         npm run test:e2e -- export   — только тесты, в имени которых есть «export»
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const webpack = require('webpack');

const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'dist');
const FIXTURES = path.join(ROOT, 'test/fixtures');
const TESTS = ['highlight', 'parser', 'analyze', 'filters', 'export', 'doc2'];

/**
 * Собирает модуль парсера для модульных проверок в браузере.
 * @param {string} outDir - папка для сборки
 * @returns {Promise<string>} путь к собранному файлу
 */
function buildParserHarness(outDir) {
  return new Promise((resolve, reject) => {
    webpack({
      mode: 'development',
      devtool: false,
      target: 'web',
      entry: path.join(__dirname, 'harness/parser-entry.js'),
      output: { path: outDir, filename: 'harness-parser.js' },
    }, (err, stats) => {
      if (err || stats.hasErrors()) reject(err || new Error(stats.toString('errors-only')));
      else resolve(path.join(outDir, 'harness-parser.js'));
    });
  });
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    console.error('[CFA] Нет сборки dist/. Сначала выполните: npm run build');
    process.exit(1);
  }
  const filter = process.argv[2];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cfa-e2e-'));
  const out = path.join(work, 'out');
  fs.mkdirSync(out);
  const harness = await buildParserHarness(path.join(work, 'build'));

  let failedSuites = 0;
  for (const name of TESTS.filter((t) => !filter || t.includes(filter))) {
    // Каждый тест получает: рабочую папку (профили браузера), dist, fixtures, папку результатов
    const args = [path.join(__dirname, `${name}.test.cjs`), work, DIST, FIXTURES, name === 'parser' ? harness : out];
    console.log(`\n########## ${name}`);
    const res = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    });
    if (res.status !== 0) failedSuites += 1;
  }
  console.log(failedSuites ? `\n[CFA] Наборов с ошибками: ${failedSuites}` : '\n[CFA] Все e2e-тесты пройдены');
  console.log(`[CFA] Результаты (скриншоты, .docx): ${out}`);
  process.exit(failedSuites ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
