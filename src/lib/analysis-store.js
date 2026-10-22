/**
 * Хранение результатов анализа по страницам в chrome.storage.local.
 * Ключ страницы — её id (pageId), если он известен, иначе адрес без якоря.
 * Хранятся только последние MAX_PAGES страниц.
 */
import { STORAGE_KEYS } from './constants';
import { getItem, setItem } from './storage';

/** Сколько последних проанализированных страниц хранить */
const MAX_PAGES = 30;

/**
 * @typedef {Object} Analysis
 * @property {import('../content/page-context').PageInfo} page - сведения о странице
 * @property {string} mode - режим страницы во время анализа (просмотр / редактор)
 * @property {string} analyzedAt - время анализа (ISO)
 * @property {import('./parser').HistoryEntry[]} entries - записи «Истории изменений»
 * @property {{dates: Array<{value: string, label: string}>, authors: string[], jiraKeys: string[]}} filterOptions - варианты фильтров
 * @property {import('./parser').PageVersion[]} versions - системная история версий (может быть пустой)
 * @property {string|null} versionsError - причина, по которой версии не загрузились
 */

/**
 * Ключ страницы по id.
 * @param {string|null} pageId - id страницы
 * @returns {string|null} ключ или null
 */
export function idKey(pageId) {
  return pageId ? `id:${pageId}` : null;
}

/**
 * Ключ страницы по адресу: id из адреса (если есть) или адрес без якоря и лишних параметров.
 * @param {string} url - адрес вкладки
 * @returns {string|null} ключ или null
 */
export function urlKey(url) {
  try {
    const u = new URL(url);
    const id = u.searchParams.get('pageId') || (u.pathname.match(/\/pages\/(?:edit-v2\/|edit\/)?(\d+)/) || [])[1];
    if (id) return idKey(id);
    return `url:${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Сохраняет результат анализа под ключами страницы (id и адрес).
 * @param {Analysis} analysis - результат анализа
 * @returns {Promise<boolean>} true при успехе
 */
export async function saveAnalysis(analysis) {
  const all = (await getItem(STORAGE_KEYS.ANALYSIS, {})) || {};
  const keys = [idKey(analysis.page.pageId), urlKey(analysis.page.url)].filter(Boolean);
  keys.forEach((k) => { all[k] = analysis; });
  // Оставляем только последние MAX_PAGES записей (по времени анализа)
  const sorted = Object.entries(all).sort((a, b) => String(b[1].analyzedAt).localeCompare(String(a[1].analyzedAt)));
  const pages = new Set();
  const trimmed = {};
  sorted.forEach(([k, v]) => {
    const pk = idKey(v.page?.pageId) || urlKey(v.page?.url);
    if (pages.size < MAX_PAGES || pages.has(pk)) {
      pages.add(pk);
      trimmed[k] = v;
    }
  });
  return setItem(STORAGE_KEYS.ANALYSIS, trimmed);
}

/**
 * Находит сохранённый анализ страницы.
 * @param {Object} params
 * @param {string} [params.url] - адрес вкладки
 * @param {string|null} [params.pageId] - id страницы (если известен)
 * @returns {Promise<Analysis|null>} анализ или null
 */
export async function findAnalysis({ url, pageId }) {
  const all = (await getItem(STORAGE_KEYS.ANALYSIS, {})) || {};
  return all[idKey(pageId)] || all[urlKey(url)] || null;
}
