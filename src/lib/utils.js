/**
 * Вспомогательные функции общего назначения.
 */
import { LOG_PREFIX } from './constants';

/**
 * Логгер с префиксом [CFA].
 * @type {{info: Function, warn: Function, error: Function, debug: Function}}
 */
export const log = {
  info: (...args) => console.log(LOG_PREFIX, ...args),
  warn: (...args) => console.warn(LOG_PREFIX, ...args),
  error: (...args) => console.error(LOG_PREFIX, ...args),
  debug: (...args) => console.debug(LOG_PREFIX, ...args),
};

/**
 * Откладывает вызов функции до паузы во входящих вызовах.
 * @param {Function} fn - вызываемая функция
 * @param {number} [wait=300] - задержка в мс
 * @returns {Function} обёрнутая функция
 */
export function debounce(fn, wait = 300) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * Нормализует текст: схлопывает пробелы, обрезает края, приводит к нижнему регистру.
 * @param {string} text - исходный текст
 * @returns {string} нормализованный текст
 */
export function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Выполняет функцию в «простое» браузера (requestIdleCallback с fallback на setTimeout).
 * @param {Function} fn - функция, получающая IdleDeadline
 * @returns {number} идентификатор колбэка
 */
export function runIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(fn, { timeout: 500 });
  }
  return setTimeout(() => fn({ timeRemaining: () => 16, didTimeout: true }), 1);
}

/**
 * Безопасно выполняет функцию, логируя ошибку вместо выброса исключения.
 * @template T
 * @param {() => T} fn - функция
 * @param {T} [fallback] - значение при ошибке
 * @returns {T} результат функции или fallback
 */
export function safe(fn, fallback = undefined) {
  try {
    return fn();
  } catch (err) {
    log.error('Ошибка выполнения:', err);
    return fallback;
  }
}

/**
 * Приводит CSS-цвет (rgb/rgba/#rgb/#rrggbb) к виду RRGGBB для Word.
 * Прозрачные и нераспознанные цвета возвращают null.
 * @param {string|null|undefined} color - CSS-цвет
 * @returns {string|null} цвет в HEX без «#» (например, "36B37E")
 */
export function colorToHex(color) {
  if (!color) return null;
  const value = String(color).trim().toLowerCase();

  // Confluence DC 8+/Cloud с поддержкой тем: color: var(--ds-text-accent-orange, #ff8b00) — берём запасной цвет
  const cssVar = value.match(/^var\(\s*--[\w-]+\s*(?:,\s*(.+))?\)$/);
  if (cssVar) return cssVar[1] ? colorToHex(cssVar[1]) : null;

  const rgb = value.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null;
    return [rgb[1], rgb[2], rgb[3]]
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  const hex = value.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return h.toUpperCase();
  }
  return null;
}

/**
 * Формирует имя файла, которое примет chrome.downloads:
 * без недопустимых символов, без точек/пробелов по краям, не длиннее 100 символов.
 * @param {string} name - исходное имя
 * @returns {string} безопасное имя файла
 */
export function safeFileName(name) {
  const cleaned = (name || 'export')
    .replace(/[\\/:*?"<>|~%\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/^[.\s_]+|[.\s_]+$/g, '');
  return cleaned || 'export';
}

/**
 * Определяет цвет текста элемента с учётом разметки Server, Cloud и редакторов.
 * Порядок: data-text-custom-color (Cloud) → CSS-переменная --custom-palette-color (Cloud)
 * → <font color> → inline style.color → вычисленный цвет.
 * @param {Element} el - элемент
 * @param {boolean} [useComputed=true] - использовать getComputedStyle, если явного цвета нет
 * @returns {string|null} цвет в HEX без «#» или null
 */
export function getElementColor(el, useComputed = true) {
  try {
    if (!el || el.nodeType !== 1) return null;
    const attr = el.getAttribute('data-text-custom-color');
    if (attr) return colorToHex(attr);
    const cssVar = el.style?.getPropertyValue('--custom-palette-color');
    if (cssVar) return colorToHex(cssVar) || computedColor(el);
    if (el.tagName === 'FONT' && el.getAttribute('color')) return colorToHex(el.getAttribute('color'));
    // Цвет задан в style, но записан через CSS-переменную без запасного значения и т.п. —
    // берём цвет, которым браузер фактически рисует текст
    if (el.style?.color) {
      // color: var(--…) — фактический цвет зависит от темы, поэтому берём то, что нарисовал браузер
      if (/var\(/.test(el.style.color)) return computedColor(el) || colorToHex(el.style.color);
      return colorToHex(el.style.color) || computedColor(el);
    }
    if (useComputed) return computedColor(el);
  } catch (err) {
    log.warn('Не удалось определить цвет элемента:', err);
  }
  return null;
}

/**
 * Цвет, которым браузер фактически рисует текст элемента (getComputedStyle).
 * @param {Element} el - элемент
 * @returns {string|null} цвет HEX без # или null
 */
export function computedColor(el) {
  try {
    const view = el?.ownerDocument?.defaultView;
    return view ? colorToHex(view.getComputedStyle(el).color) : null;
  } catch {
    return null;
  }
}

/** Элементы, цвет которых — оформление, а не правка: код, плашки Jira, статусы, упоминания, даты */
const COLOR_SKIP_SELECTOR = [
  'pre', 'code', '.code', '.codeContent', '.syntaxhighlighter', '.CodeMirror',
  '.jira-issue', '[data-macro-name="jira"]', '.aui-lozenge', '.status-macro', '[data-inline-card]',
  '.confluence-userlink', '.user-mention', '[data-mention-id]', '.mentionView-content-wrap',
  'time', '.date-lozenger-container',
  // Служебные элементы с цветом из темы: заголовки свёрнутых блоков, кнопки, заголовки панелей
  'button', '.expand-control', '.aui-expander-trigger', '[data-testid*="expand-title"]', '.panelHeader',
  '.confluence-information-macro-icon',
].join(',');

/**
 * Цвет текстового узла, когда явного цвета в разметке нет (цвет задан CSS-классом или темой):
 * фактический цвет текста, если он заметно отличается от обычного цвета текста вокруг (base).
 * Ссылки рисуются своим цветом — для них берётся цвет окружающего текста.
 * @param {Text} node - текстовый узел
 * @param {Element} scope - граница поиска (ячейка таблицы или корень документа)
 * @param {string|null} base - обычный цвет текста (HEX) в этой области
 * @returns {string|null} цвет HEX или null
 */
export function renderedTextColor(node, scope, base) {
  let el = node.parentElement;
  if (!el || el.closest(COLOR_SKIP_SELECTOR)) return null;
  while (el && el !== scope && el.tagName === 'A') el = el.parentElement;
  const color = computedColor(el);
  if (!color || !base) return null;
  return colorDistance(color, base) > 24 ? color : null;
}

/**
 * Расстояние между двумя цветами (евклидово в RGB).
 * @param {string} a - цвет HEX без #
 * @param {string} b - цвет HEX без #
 * @returns {number} расстояние (0 — одинаковые цвета)
 */
export function colorDistance(a, b) {
  const rgb = (h) => {
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

/**
 * Извлекает ключи задач (PROJ-123) из элемента: из ссылок на трекер,
 * параметров макроса Jira в редакторе Server и карточек Cloud.
 *
 * Из простого текста ключи берутся ТОЛЬКО если передан список известных задач
 * (knownKeys) — иначе названия вида «Сценарий CLTO-20», «CIA-09» ошибочно
 * принимались бы за задачи.
 * @param {Element} el - элемент
 * @param {Iterable<string>} [knownKeys] - известные ключи (например, из колонки «Артефакт Jira»)
 * @returns {string[]} уникальные ключи задач
 */
export function extractIssueKeys(el, knownKeys = null) {
  const keys = new Set();
  const re = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
  const add = (text) => (String(text || '').match(re) || []).forEach((k) => keys.add(k));
  try {
    if (!el) return [];
    // Ссылки на трекер: /browse/KEY (Jira), /issue/KEY (YouTrack)
    el.querySelectorAll('a[href]').forEach((a) => {
      const href = safeDecode(a.getAttribute('href'));
      const m = href.match(/\/(?:browse|issue)\/([A-Z][A-Z0-9_]+-\d+)/);
      if (m) keys.add(m[1]);
    });
    // Server: макрос Jira (в просмотре — span.jira-issue[data-jira-key], в редакторе — img с параметрами)
    el.querySelectorAll('[data-jira-key]').forEach((m) => add(m.getAttribute('data-jira-key')));
    el.querySelectorAll('[data-macro-name="jira"]').forEach((m) => {
      const params = m.getAttribute('data-macro-parameters') || '';
      const k = params.match(/(?:^|\|)key=([A-Z][A-Z0-9_]+-\d+)/);
      if (k) keys.add(k[1]);
    });
    // Cloud: smart-link / inline card
    el.querySelectorAll('[data-card-url], [data-url]').forEach((c) => {
      const url = safeDecode(c.getAttribute('data-card-url') || c.getAttribute('data-url'));
      const m = url.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
      if (m) keys.add(m[1]);
    });
    // Текст — только известные ключи
    if (knownKeys) {
      const known = new Set(knownKeys);
      (el.textContent.match(re) || []).forEach((k) => { if (known.has(k)) keys.add(k); });
    }
  } catch (err) {
    log.warn('Ошибка извлечения ключей задач:', err);
  }
  return [...keys];
}

/**
 * Безопасный decodeURIComponent (не падает на некорректных последовательностях).
 * @param {string|null} value - строка
 * @returns {string} декодированная строка или исходная
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
}
