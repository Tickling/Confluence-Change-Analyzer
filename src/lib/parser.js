/**
 * Парсер истории изменений Confluence.
 *
 * 1. Таблица «История изменений» внутри документа
 *    (№ | Дата изменения | Причина изменения | Описание | Автор | Ревью | Артефакт Jira).
 *    Работает одинаково в просмотре, в редакторе Server (TinyMCE) и в редакторе Cloud (ProseMirror):
 *    колонки определяются по заголовкам, объединённые ячейки (rowspan/colspan) учитываются.
 * 2. Системная история версий страницы — ответ REST API Confluence
 *    (Server 6.x+: /rest/experimental/content/{id}/version, Cloud: /wiki/rest/api/content/{id}/version).
 */
import { HISTORY_COLUMN_ALIASES } from './constants';
import { colorToHex, extractIssueKeys, getElementColor, log, normalizeText } from './utils';

/**
 * @typedef {Object} HistoryEntry
 * @property {string} version - номер версии / строки (колонка «№»)
 * @property {string} date - дата изменения (как в документе)
 * @property {string|null} dateISO - дата в формате YYYY-MM-DD (если распознана)
 * @property {string} reason - причина изменения (текст)
 * @property {string[]} reasonKeys - задачи из колонки «Причина изменения»
 * @property {string} description - описание
 * @property {string} author - автор
 * @property {string} review - ревью
 * @property {string[]} jiraKeys - ключи задач из колонки «Артефакт Jira»
 * @property {string|null} color - цвет текста описания (HEX без #)
 * @property {string|null} backgroundColor - цвет фона описания (HEX без #)
 * @property {string|null} [versionUrl] - ссылка на версию страницы
 * @property {boolean} cancelled - правка отменена (описание в истории зачёркнуто)
 */

/**
 * @typedef {Object} PageVersion
 * @property {number} number - номер версии страницы
 * @property {string|null} when - дата и время (ISO)
 * @property {string|null} dateISO - дата YYYY-MM-DD
 * @property {string} author - автор версии
 * @property {string} message - комментарий к версии
 * @property {string|null} url - ссылка на версию
 */

/* ======================== Даты ======================== */

/** Месяцы: начало слова (рус./англ.) → номер */
const MONTHS = [
  [/^янв|^jan/, 1], [/^фев|^feb/, 2], [/^мар|^mar/, 3], [/^апр|^apr/, 4],
  [/^мая|^май|^may/, 5], [/^июн|^jun/, 6], [/^июл|^jul/, 7], [/^авг|^aug/, 8],
  [/^сен|^sep/, 9], [/^окт|^oct/, 10], [/^ноя|^nov/, 11], [/^дек|^dec/, 12],
];

/**
 * Номер месяца по его названию (полному или сокращённому, рус./англ.).
 * @param {string} word - название месяца
 * @returns {number|null} 1..12 или null
 */
function monthNumber(word) {
  const w = word.toLowerCase();
  const found = MONTHS.find(([re]) => re.test(w));
  return found ? found[1] : null;
}

/**
 * Собирает дату YYYY-MM-DD с проверкой корректности.
 * @param {number} y - год
 * @param {number} m - месяц
 * @param {number} d - день
 * @returns {string|null} дата или null
 */
function toISO(y, m, d) {
  const year = y < 100 ? 2000 + y : y;
  const date = new Date(Date.UTC(year, m - 1, d));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Распознаёт дату из текста в разных форматах:
 * «14 июл. 2026 г.», «14 июля 2026», «14.07.2026», «2026-07-14», «Jul 14, 2026», «14 Jul 2026».
 * @param {string} text - текст с датой
 * @returns {string|null} дата YYYY-MM-DD или null
 */
export function parseDate(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return toISO(+m[1], +m[2], +m[3]);
  m = t.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) return toISO(+m[3], +m[2], +m[1]);
  m = t.match(/(\d{1,2})\s+([A-Za-zА-Яа-яЁё]+)\.?,?\s+(\d{4})/);
  if (m && monthNumber(m[2])) return toISO(+m[3], monthNumber(m[2]), +m[1]);
  m = t.match(/([A-Za-zА-Яа-яЁё]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && monthNumber(m[1])) return toISO(+m[3], monthNumber(m[1]), +m[2]);
  return null;
}

/**
 * Достаёт дату из ячейки: сначала из машиночитаемых атрибутов
 * (<time datetime>, плашка даты Cloud с timestamp), затем из текста.
 * @param {Element} cell - ячейка таблицы
 * @returns {string|null} дата YYYY-MM-DD или null
 */
function parseCellDate(cell) {
  const time = cell.querySelector('time[datetime]');
  if (time) {
    const iso = parseDate(time.getAttribute('datetime'));
    if (iso) return iso;
  }
  const lozenge = cell.querySelector('[timestamp], [data-timestamp]');
  if (lozenge) {
    const ts = Number(lozenge.getAttribute('timestamp') || lozenge.getAttribute('data-timestamp'));
    if (ts) return new Date(ts).toISOString().slice(0, 10);
  }
  return parseDate(cell.textContent);
}

/* ======================== Таблица истории ======================== */

/**
 * Возвращает тексты ячеек первой строки таблицы (заголовки).
 * @param {HTMLTableElement} table - таблица
 * @returns {string[]} нормализованные заголовки
 */
export function getHeaderCells(table) {
  const firstRow = table.querySelector('tr');
  if (!firstRow) return [];
  return [...firstRow.children].map((cell) => normalizeText(cell.textContent));
}

/**
 * Проверяет, является ли таблица таблицей «История изменений»:
 * в заголовке есть «Описание», «Автор» и «Артефакт Jira» или «Дата изменения».
 * @param {HTMLTableElement} table - таблица
 * @returns {boolean} true для таблицы истории
 */
export function isHistoryTable(table) {
  const headers = getHeaderCells(table);
  const has = (aliases) => headers.some((h) => aliases.includes(h));
  return has(HISTORY_COLUMN_ALIASES.description)
    && has(HISTORY_COLUMN_ALIASES.author)
    && (has(HISTORY_COLUMN_ALIASES.jira) || has(['дата изменения']));
}

/**
 * Находит все таблицы «История изменений» в документе (вложенные таблицы не учитываются).
 * @param {Element} root - корень документа (тело статьи или редактора)
 * @returns {HTMLTableElement[]} таблицы истории
 */
export function findHistoryTables(root) {
  if (!root) return [];
  return [...root.querySelectorAll('table')].filter(isHistoryTable);
}

/**
 * Сопоставляет колонки таблицы с полями записи по заголовкам.
 * @param {string[]} headers - нормализованные заголовки
 * @returns {Object<string, number>} поле → индекс колонки
 */
function mapColumns(headers) {
  const map = {};
  Object.entries(HISTORY_COLUMN_ALIASES).forEach(([field, aliases]) => {
    const idx = headers.findIndex((h, i) => aliases.includes(h) && !Object.values(map).includes(i));
    if (idx >= 0) map[field] = idx;
  });
  return map;
}

/**
 * Раскладывает таблицу в сетку с учётом rowspan/colspan:
 * объединённая ячейка попадает во все строки/колонки, которые она занимает.
 * @param {HTMLTableElement} table - таблица
 * @returns {Element[][]} сетка ячеек (строка → колонка → ячейка)
 */
function tableToGrid(table) {
  // Только строки этой таблицы (не вложенных)
  const rows = [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
  const grid = [];
  rows.forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    [...tr.children].filter((el) => el.tagName === 'TD' || el.tagName === 'TH').forEach((cell) => {
      while (grid[r][c]) c += 1;
      const rs = Math.max(1, Number(cell.getAttribute('rowspan')) || 1);
      const cs = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
      for (let i = 0; i < rs; i += 1) {
        for (let j = 0; j < cs; j += 1) {
          grid[r + i] = grid[r + i] || [];
          grid[r + i][c + j] = cell;
        }
      }
      c += cs;
    });
  });
  return grid;
}

/**
 * Определяет основной цвет текста ячейки — цвет, которым написано больше всего текста.
 * Нейтральные цвета (чёрный, серый) не учитываются.
 * @param {Element} cell - ячейка
 * @param {'color'|'background'} [kind='color'] - цвет текста или цвет фона
 * @returns {string|null} цвет HEX или null
 */
export function dominantColor(cell, kind = 'color') {
  const weights = new Map();
  const doc = cell.ownerDocument;
  const walker = doc.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.nodeValue.trim().length;
    if (!len) continue;
    let color = null;
    for (let el = n.parentElement; el && !color; el = el.parentElement) {
      color = kind === 'color' ? getElementColor(el, false) : getBackground(el);
      if (el === cell) break;
    }
    if (color && !isNeutral(color, kind)) weights.set(color, (weights.get(color) || 0) + len);
  }
  let best = null;
  weights.forEach((w, c) => { if (!best || w > weights.get(best)) best = c; });
  return best;
}

/**
 * Явный цвет фона элемента (style / атрибут Cloud).
 * @param {Element} el - элемент
 * @returns {string|null} цвет HEX или null
 */
function getBackground(el) {
  const attr = el.getAttribute?.('data-background-custom-color');
  if (attr) return colorToHex(attr);
  return colorToHex(el.style?.backgroundColor);
}

/**
 * Нейтральный ли цвет: для текста — чёрный/серый, для фона — белый/прозрачный.
 * @param {string} hex - цвет
 * @param {'color'|'background'} kind - тип цвета
 * @returns {boolean} true для нейтрального цвета
 */
function isNeutral(hex, kind) {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  if (kind === 'background') return r > 245 && g > 245 && b > 245;
  return Math.max(r, g, b) - Math.min(r, g, b) < 30;
}

/** Доля зачёркнутого текста, начиная с которой запись считается отменённой */
const CANCELLED_RATIO = 0.6;

/**
 * Зачёркнут ли текстовый узел (<s>, <del>, <strike>, text-decoration: line-through) в пределах ячейки.
 * @param {Text} node - текстовый узел
 * @param {Element} cell - ячейка (выше не поднимаемся)
 * @returns {boolean} true, если текст зачёркнут
 */
function isStruck(node, cell) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (/^(S|DEL|STRIKE)$/.test(el.tagName)) return true;
    if (/line-through/.test(el.style?.textDecoration || el.style?.textDecorationLine || '')) return true;
    if (el === cell) break;
  }
  return false;
}

/**
 * Отменена ли правка: описание в «Истории изменений» зачёркнуто целиком (или почти целиком).
 * @param {Element} cell - ячейка «Описание»
 * @returns {boolean} true для отменённой правки
 */
export function isCancelledDescription(cell) {
  let total = 0;
  let struck = 0;
  const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.nodeValue.trim().length;
    total += len;
    if (len && isStruck(n, cell)) struck += len;
  }
  return total > 0 && struck / total >= CANCELLED_RATIO;
}

/**
 * Текст ячейки без лишних пробелов.
 * @param {Element|undefined} cell - ячейка
 * @returns {string} текст
 */
function cellText(cell) {
  return cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Имя автора: текст ссылки на пользователя / упоминания (без «@»).
 * @param {Element|undefined} cell - ячейка «Автор»
 * @returns {string} имя автора
 */
function cellAuthor(cell) {
  if (!cell) return '';
  const user = cell.querySelector('.confluence-userlink, [data-username], [data-mention-id], .mentionView-content-wrap, a[href*="/people/"], a[href*="viewuserprofile"]');
  return cellText(user || cell).replace(/^@/, '').trim();
}

/**
 * Разбирает одну таблицу «История изменений».
 * @param {HTMLTableElement} table - таблица
 * @returns {HistoryEntry[]} записи
 */
export function parseHistoryTableElement(table) {
  const grid = tableToGrid(table);
  if (grid.length < 2) return [];
  const headers = grid[0].map((c) => normalizeText(c?.textContent));
  const col = mapColumns(headers);
  const get = (row, field) => (col[field] !== undefined ? row[col[field]] : undefined);

  const entries = [];
  grid.slice(1).forEach((row, i) => {
    // Строка-заголовок, повторённая внутри таблицы, — пропускаем
    if (row.every((c) => c?.tagName === 'TH')) return;
    const descCell = get(row, 'description');
    const entry = {
      version: cellText(get(row, 'version')) || String(i + 1),
      date: cellText(get(row, 'date')),
      dateISO: get(row, 'date') ? parseCellDate(get(row, 'date')) : null,
      reason: cellText(get(row, 'reason')),
      reasonKeys: get(row, 'reason') ? extractIssueKeys(get(row, 'reason')) : [],
      description: cellText(descCell),
      author: cellAuthor(get(row, 'author')),
      review: cellText(get(row, 'review')),
      jiraKeys: get(row, 'jira') ? extractIssueKeys(get(row, 'jira')) : [],
      color: descCell ? dominantColor(descCell, 'color') : null,
      backgroundColor: descCell ? dominantColor(descCell, 'background') : null,
      versionUrl: null,
      cancelled: descCell ? isCancelledDescription(descCell) : false,
    };
    // Пустые строки (шаблон таблицы без заполнения) не нужны
    if (!entry.description && !entry.date && !entry.author && !entry.jiraKeys.length) return;
    entries.push(entry);
  });
  return entries;
}

/**
 * Разбирает все таблицы «История изменений» в документе.
 * @param {Element} root - корень документа (тело статьи или редактора)
 * @returns {HistoryEntry[]} записи всех таблиц истории
 */
export function parseHistoryTable(root) {
  try {
    const tables = findHistoryTables(root);
    const entries = tables.flatMap(parseHistoryTableElement);
    log.info(`Таблиц «История изменений»: ${tables.length}, записей: ${entries.length}`);
    return entries;
  } catch (err) {
    log.error('Ошибка разбора таблицы «История изменений»:', err);
    return [];
  }
}

/**
 * Собирает уникальные значения для фильтров popup.
 * @param {HistoryEntry[]} entries - записи истории
 * @returns {{dates: Array<{value: string, label: string}>, authors: string[], jiraKeys: string[]}} варианты фильтров
 */
export function collectFilterOptions(entries) {
  const dates = new Map();
  entries.forEach((e) => {
    const value = e.dateISO || e.date;
    if (value && !dates.has(value)) dates.set(value, e.date || value);
  });
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  return {
    dates: [...dates].map(([value, label]) => ({ value, label })),
    authors: uniq(entries.map((e) => e.author)),
    jiraKeys: uniq(entries.flatMap((e) => e.jiraKeys)),
  };
}

/* ======================== Системная история версий (REST) ======================== */

/**
 * Разбирает ответ REST API со списком версий страницы.
 * Формат одинаков для Server (/rest/experimental/content/{id}/version) и Cloud (/wiki/rest/api/content/{id}/version):
 * { results: [{ number, when, message, by: { displayName } }] }.
 * @param {Object} json - ответ API
 * @param {Object} params
 * @param {string} params.baseUrl - базовый адрес Confluence (с /wiki для Cloud)
 * @param {string} params.pageId - идентификатор страницы
 * @returns {PageVersion[]} версии (от новых к старым)
 */
export function parseVersionsResponse(json, { baseUrl, pageId }) {
  try {
    return (json?.results || []).map((v) => ({
      number: Number(v.number),
      when: v.when || null,
      dateISO: v.when ? String(v.when).slice(0, 10) : null,
      author: v.by?.displayName || v.by?.publicName || v.by?.username || '',
      message: v.message || '',
      url: baseUrl && pageId ? `${baseUrl}/pages/viewpage.action?pageId=${pageId}&pageVersion=${v.number}` : null,
    })).sort((a, b) => b.number - a.number);
  } catch (err) {
    log.error('Ошибка разбора истории версий:', err);
    return [];
  }
}
