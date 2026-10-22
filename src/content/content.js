/**
 * Content script: внедряется в страницы Confluence.
 * Работает и в режиме просмотра, и в режиме редактирования
 * (Server / DC — TinyMCE в iframe, Cloud — ProseMirror).
 * Принимает команды от popup/background (подсветка, поиск задачи).
 */
import './content.css';
import { MESSAGE_TYPES } from '../lib/constants';
import { log } from '../lib/utils';
import { getContentContext, getPageInfo, isEditUrl, waitForContentContext } from './page-context';
import { collectFilterOptions, parseHistoryTable } from '../lib/parser';
import { applyHighlight, clearHighlight, getCurrentHighlight, summarize } from './highlighter';
import { describeChanges } from './extract';
import { findTaskMentions, revealMention } from './task-search';
import { fetchPageVersions, linkEntriesToVersions } from './versions';

/** Текущий контекст страницы (режим + корень документа) */
let context = null;

/**
 * Проверяет, что текущая страница — Confluence (Server или Cloud, просмотр или редактор).
 * @returns {boolean} true, если это Confluence
 */
function isConfluencePage() {
  try {
    return Boolean(
      document.querySelector('meta[name="ajs-page-id"], meta[name="confluence-base-url"], meta[name="ajs-base-url"]')
      || getContentContext().root
      || isEditUrl()
    );
  } catch (err) {
    log.error('Ошибка определения Confluence:', err);
    return false;
  }
}

/**
 * Возвращает актуальный контекст: редактор мог перезагрузиться
 * (например, при переключении просмотр ↔ редактирование в Cloud без перезагрузки страницы).
 * @returns {import('./page-context').ContentContext} контекст
 */
export function getContext() {
  if (!context?.root?.isConnected) context = getContentContext();
  return context;
}

/**
 * Анализ страницы: разбор «Истории изменений» и (по желанию) загрузка версий страницы.
 * @param {{withVersions?: boolean}} opts - параметры
 * @returns {Promise<Object>} результат для background (ok, page, entries, filterOptions, versions)
 */
async function analyzePage({ withVersions = true } = {}) {
  let ctx = getContext();
  if (!ctx.root) ctx = await waitForContentContext(document, 5000);
  if (!ctx.root) return { ok: false, error: 'Не найдено содержимое страницы Confluence' };
  const page = getPageInfo();
  let entries = parseHistoryTable(ctx.root);
  let versions = [];
  let versionsError = null;
  if (withVersions) {
    ({ versions, error: versionsError } = await fetchPageVersions(page));
    if (versions.length) entries = linkEntriesToVersions(entries, versions);
  }
  return {
    ok: true,
    mode: ctx.mode,
    page,
    entries,
    filterOptions: collectFilterOptions(entries),
    versions,
    versionsError,
  };
}

/**
 * Обработчик сообщений от popup/background.
 * @param {{type: string, payload?: *}} message - сообщение
 * @param {chrome.runtime.MessageSender} sender - отправитель
 * @param {Function} sendResponse - функция ответа
 * @returns {boolean} true, если ответ асинхронный
 */
function onMessage(message, sender, sendResponse) {
  try {
    switch (message?.type) {
      case MESSAGE_TYPES.PING: {
        const ctx = getContext();
        sendResponse({ ok: true, from: 'content', url: location.href, mode: ctx.mode, editable: ctx.editable, pageId: getPageInfo().pageId });
        return false;
      }
      case MESSAGE_TYPES.PARSE_HISTORY: {
        // Таблица «История изменений» читается прямо со страницы (в т.ч. из редактора) —
        // уходить со страницы не нужно
        analyzePage(message.payload || {})
          .then(sendResponse)
          .catch((err) => {
            log.error('Ошибка анализа:', err);
            sendResponse({ ok: false, error: String(err?.message || err) });
          });
        return true; // ответ асинхронный
      }
      case MESSAGE_TYPES.APPLY_HIGHLIGHT: {
        const ctx = getContext();
        applyHighlight(ctx, message.payload || {})
          .then((groups) => sendResponse({ ok: true, mode: ctx.mode, count: groups.length, items: summarize(groups) }))
          .catch((err) => {
            log.error('Ошибка подсветки:', err);
            sendResponse({ ok: false, error: String(err?.message || err) });
          });
        return true; // ответ асинхронный
      }
      case MESSAGE_TYPES.GET_CHANGES: {
        // Подробности подсвеченных сейчас правок — для выгрузки в Word
        const { groups, ctx } = getCurrentHighlight();
        if (!ctx?.root) {
          sendResponse({ ok: false, error: 'Сначала нажмите «Подсветить»' });
          return false;
        }
        sendResponse({ ok: true, page: getPageInfo(), changes: describeChanges(groups, ctx.root) });
        return false;
      }
      case MESSAGE_TYPES.FIND_TASK: {
        // Упоминания задачи в теле документа (вкладка «Статус задачи»)
        const ctx = getContext();
        if (!ctx.root) {
          sendResponse({ ok: false, error: 'Не найдено содержимое страницы Confluence' });
          return false;
        }
        findTaskMentions(ctx, message.payload?.key, message.payload || {})
          .then((res) => sendResponse({ ok: true, ...res }))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true;
      }
      case MESSAGE_TYPES.REVEAL_MENTION:
        sendResponse({ ok: revealMention(getContext(), message.payload?.index) });
        return false;
      case MESSAGE_TYPES.CLEAR_HIGHLIGHT:
        clearHighlight();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  } catch (err) {
    log.error('Ошибка обработки сообщения:', err);
    sendResponse({ ok: false, error: String(err) });
    return false;
  }
}

/**
 * Инициализация: работаем только во фрейме верхнего уровня —
 * iframe редактора TinyMCE обрабатывается из него через contentDocument.
 * Если скрипт внедрён по кнопке «Анализ» (адрес страницы не попал в manifest),
 * проверка «это Confluence?» пропускается — пользователь явно запустил анализ.
 * @returns {Promise<void>}
 */
async function init() {
  if (window !== window.top) return;
  // Защита от повторного внедрения (manifest + chrome.scripting)
  if (window.__CFA_CONTENT_LOADED__) return;
  const forced = Boolean(window.__CFA_FORCE__);
  if (!forced && !isConfluencePage()) return;
  window.__CFA_CONTENT_LOADED__ = true;
  chrome.runtime.onMessage.addListener(onMessage);
  context = await waitForContentContext();
  log.info('Content script загружен. Режим страницы:', context.mode, location.href);
}

init();
