/**
 * Настройки расширения (открываются шестерёнкой в popup).
 * Хранятся в chrome.storage.local, всегда дополняются значениями по умолчанию.
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants';
import { getItem, setItem, removeItem } from './storage';

/**
 * Объединяет сохранённые настройки со значениями по умолчанию.
 * Фильтр «Артефакт Jira» принудительно включён.
 * @param {Object|null} saved - сохранённые настройки
 * @returns {typeof DEFAULT_SETTINGS} полные настройки
 */
export function normalizeSettings(saved) {
  const s = saved || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    filters: { ...DEFAULT_SETTINGS.filters, ...(s.filters || {}), jira: true },
  };
}

/**
 * Читает настройки.
 * @returns {Promise<typeof DEFAULT_SETTINGS>} настройки
 */
export async function getSettings() {
  return normalizeSettings(await getItem(STORAGE_KEYS.SETTINGS, null));
}

/**
 * Сохраняет настройки.
 * @param {typeof DEFAULT_SETTINGS} settings - настройки
 * @returns {Promise<boolean>} true при успехе
 */
export async function saveSettings(settings) {
  return setItem(STORAGE_KEYS.SETTINGS, normalizeSettings(settings));
}

/**
 * Сбрасывает настройки к значениям по умолчанию.
 * @returns {Promise<typeof DEFAULT_SETTINGS>} настройки по умолчанию
 */
export async function resetSettings() {
  await removeItem(STORAGE_KEYS.SETTINGS);
  return normalizeSettings(null);
}

/**
 * Читает значение по пути вида "filters.date".
 * @param {Object} obj - объект
 * @param {string} path - путь через точку
 * @returns {*} значение
 */
export function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Возвращает копию объекта с изменённым значением по пути "filters.date".
 * @param {Object} obj - объект
 * @param {string} path - путь через точку
 * @param {*} value - новое значение
 * @returns {Object} новый объект
 */
export function setByPath(obj, path, value) {
  const copy = structuredClone(obj);
  const keys = path.split('.');
  let cur = copy;
  keys.slice(0, -1).forEach((k) => { cur[k] = cur[k] ?? {}; cur = cur[k]; });
  cur[keys[keys.length - 1]] = value;
  return copy;
}
