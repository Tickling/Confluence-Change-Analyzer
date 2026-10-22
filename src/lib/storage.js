/**
 * Обёртка над chrome.storage.local с промисами и обработкой ошибок.
 */
import { log } from './utils';

/**
 * Читает значение из chrome.storage.local.
 * @param {string} key - ключ
 * @param {*} [defaultValue=null] - значение по умолчанию
 * @returns {Promise<*>} сохранённое значение или defaultValue
 */
export async function getItem(key, defaultValue = null) {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? defaultValue;
  } catch (err) {
    log.error('Ошибка чтения storage:', key, err);
    return defaultValue;
  }
}

/**
 * Записывает значение в chrome.storage.local.
 * @param {string} key - ключ
 * @param {*} value - значение (сериализуемое в JSON)
 * @returns {Promise<boolean>} true при успехе
 */
export async function setItem(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch (err) {
    log.error('Ошибка записи storage:', key, err);
    return false;
  }
}

/**
 * Удаляет значение из chrome.storage.local.
 * @param {string} key - ключ
 * @returns {Promise<boolean>} true при успехе
 */
export async function removeItem(key) {
  try {
    await chrome.storage.local.remove(key);
    return true;
  } catch (err) {
    log.error('Ошибка удаления из storage:', key, err);
    return false;
  }
}
