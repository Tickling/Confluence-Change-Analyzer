/**
 * Фильтрация записей «Истории изменений» и подготовка параметров подсветки.
 *
 * Фильтры (режим AND): «Дата изменения», «Автор», «Артефакт Jira».
 * Отобранные записи дают ЦВЕТА правок (цвет описания), а выбранная задача —
 * дополнительное условие «рядом с правкой есть ссылка на эту задачу».
 */

/**
 * @typedef {Object} FilterValues
 * @property {string} [date] - дата (YYYY-MM-DD или текст, если дата не распознана)
 * @property {string} [author] - автор
 * @property {string} [jira] - ключ задачи
 */

/**
 * Оставляет только значения включённых в настройках фильтров.
 * «Артефакт Jira» включён всегда.
 * @param {FilterValues} filters - значения фильтров
 * @param {{filters: Object<string, boolean>}} settings - настройки
 * @returns {FilterValues} активные значения
 */
export function activeFilters(filters = {}, settings = { filters: {} }) {
  const on = (key) => key === 'jira' || settings.filters?.[key] !== false;
  const out = {};
  ['date', 'author', 'jira'].forEach((key) => {
    if (on(key) && filters[key]) out[key] = filters[key];
  });
  return out;
}

/**
 * Отбирает записи истории по фильтрам (все условия одновременно).
 * @param {import('./parser').HistoryEntry[]} entries - записи истории
 * @param {FilterValues} filters - активные значения фильтров
 * @returns {import('./parser').HistoryEntry[]} подходящие записи
 */
export function filterEntries(entries, filters = {}) {
  return entries.filter((e) => (!filters.date || (e.dateISO || e.date) === filters.date)
    && (!filters.author || e.author === filters.author)
    && (!filters.jira || (e.jiraKeys || []).includes(filters.jira)));
}

/**
 * @typedef {Object} HighlightPlan
 * @property {boolean} ok - можно ли подсвечивать
 * @property {string|null} reason - почему нельзя (для сообщения пользователю)
 * @property {import('./parser').HistoryEntry[]} entries - отобранные записи
 * @property {Object|null} payload - параметры для content script (highlighter.applyHighlight)
 */

/**
 * Готовит параметры подсветки по фильтрам.
 * @param {import('./parser').HistoryEntry[]} allEntries - все записи истории
 * @param {FilterValues} filters - значения фильтров (уже с учётом настроек)
 * @param {{autoExpand?: boolean, showCounter?: boolean}} [settings] - настройки
 * @returns {HighlightPlan} план подсветки
 */
export function buildHighlightPlan(allEntries, filters, settings = {}) {
  const entries = filterEntries(allEntries, filters);
  if (!entries.length) {
    return { ok: false, reason: 'Нет записей «Истории изменений» по выбранным фильтрам', entries, payload: null };
  }
  // Цвет текста описания и (если есть) цвет его заливки — правка в документе может быть отмечена любым из них
  const colors = [...new Set(entries.flatMap((e) => [e.color, e.backgroundColor]).filter(Boolean))];
  if (!colors.length) {
    return {
      ok: false,
      reason: 'Описание выбранных записей написано без цвета — правки в документе не выделены цветом',
      entries,
      payload: null,
    };
  }
  // Известные ключи задач — чтобы находить их и в обычном тексте рядом с правкой
  const knownKeys = [...new Set(allEntries.flatMap((e) => [...(e.jiraKeys || []), ...(e.reasonKeys || [])]))];
  // Цвета отменённых правок (описание в истории зачёркнуто) — подсвечиваются особо, с подписью
  const cancelled = entries.filter((e) => e.cancelled && e.color)
    .filter((e) => !entries.some((o) => !o.cancelled && o.color === e.color))
    .map((e) => ({ color: e.color, label: `Отменено · версия ${e.version}` }));
  return {
    ok: true,
    reason: null,
    entries,
    payload: {
      colors,
      cancelled,
      issueKey: filters.jira || null,
      knownKeys,
      autoExpand: settings.autoExpand !== false,
      showCounter: settings.showCounter !== false,
    },
  };
}
