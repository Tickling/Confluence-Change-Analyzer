/**
 * Service worker расширения (Manifest V3).
 * Координирует popup ↔ content script: запуск анализа, сохранение результата.
 *
 * Важно: если пользователь в режиме редактирования, со страницы уходить НЕЛЬЗЯ
 * (потеряются несохранённые правки). Поэтому анализ выполняется на месте:
 * таблица «История изменений» читается прямо со страницы (или из редактора),
 * а системная история версий загружается фоном через REST API того же Confluence.
 */
import { MESSAGE_TYPES } from '../lib/constants';
import { saveAnalysis } from '../lib/analysis-store';
import { log } from '../lib/utils';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  log.info('Расширение установлено/обновлено:', reason);
});

/**
 * Проверяет, что content script отвечает во вкладке; если нет — внедряет его.
 * Нужно для Confluence с нестандартными адресами, не попавшими в manifest,
 * и для вкладок, открытых до установки/обновления расширения.
 * @param {number} tabId - id вкладки
 * @returns {Promise<void>}
 */
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.PING });
    if (pong?.ok) return;
  } catch {
    // content script не загружен — внедряем ниже
  }
  log.info('Внедрение content script во вкладку', tabId);
  await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__CFA_FORCE__ = true; } });
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

/**
 * Отправляет сообщение content script во вкладке (с автоматическим внедрением).
 * @param {number} tabId - id вкладки
 * @param {{type: string, payload?: *}} message - сообщение
 * @returns {Promise<*>} ответ content script
 */
export async function sendToTab(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

/**
 * Запускает анализ страницы во вкладке и сохраняет результат.
 * @param {number} tabId - id вкладки
 * @returns {Promise<Object>} результат анализа (ok, analysis | error)
 */
async function runAnalysis(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:/.test(tab.url || '')) {
      return { ok: false, error: 'Откройте страницу Confluence и повторите анализ' };
    }
    const res = await sendToTab(tabId, { type: MESSAGE_TYPES.PARSE_HISTORY, payload: { withVersions: true } });
    if (!res?.ok) return { ok: false, error: res?.error || 'Не удалось проанализировать страницу' };
    if (!res.entries.length) {
      return { ok: false, error: 'На странице не найдена таблица «История изменений»', mode: res.mode };
    }
    const analysis = {
      page: res.page,
      mode: res.mode,
      analyzedAt: new Date().toISOString(),
      entries: res.entries,
      filterOptions: res.filterOptions,
      versions: res.versions || [],
      versionsError: res.versionsError || null,
    };
    await saveAnalysis(analysis);
    log.info(`Анализ сохранён: ${analysis.entries.length} записей, ${analysis.versions.length} версий`);
    return { ok: true, analysis };
  } catch (err) {
    log.error('Ошибка анализа:', err);
    const msg = String(err?.message || err);
    if (/Cannot access|cannot be scripted|chrome:\/\//i.test(msg)) {
      return { ok: false, error: 'Эту страницу нельзя анализировать. Откройте страницу Confluence.' };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Обработчик сообщений от popup.
 * @param {{type: string, payload?: *}} message - сообщение
 * @param {chrome.runtime.MessageSender} sender - отправитель
 * @param {Function} sendResponse - функция ответа
 * @returns {boolean} true, если ответ асинхронный
 */
function onMessage(message, sender, sendResponse) {
  try {
    switch (message?.type) {
      case MESSAGE_TYPES.PING:
        sendResponse({ ok: true, from: 'background' });
        return false;
      case MESSAGE_TYPES.RUN_ANALYSIS:
        runAnalysis(message.payload?.tabId).then(sendResponse);
        return true;
      case MESSAGE_TYPES.APPLY_HIGHLIGHT:
      case MESSAGE_TYPES.CLEAR_HIGHLIGHT:
      case MESSAGE_TYPES.GET_CHANGES:
      case MESSAGE_TYPES.FIND_TASK:
      case MESSAGE_TYPES.REVEAL_MENTION:
        // Пересылаем команду подсветки во вкладку (content script внедряется при необходимости)
        sendToTab(message.payload?.tabId, { type: message.type, payload: message.payload?.options })
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true;
      default:
        return false;
    }
  } catch (err) {
    log.error('Ошибка обработки сообщения:', err);
    sendResponse({ ok: false, error: String(err) });
    return false;
  }
}

chrome.runtime.onMessage.addListener(onMessage);
