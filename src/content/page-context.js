/**
 * Определение режима страницы Confluence (просмотр / редактирование)
 * и области документа, в которой нужно искать правки.
 *
 * Поддерживается:
 *  - просмотр: Server / DC (#main-content) и Cloud (renderer);
 *  - редактирование Server / DC: TinyMCE внутри iframe (#wysiwygTextarea_ifr);
 *  - редактирование Cloud: ProseMirror (.ProseMirror[contenteditable]).
 */
import {
  EDIT_URL_PATTERNS,
  EDITOR_SELECTORS,
  HIGHLIGHT_STRATEGY,
  PAGE_MODES,
  VIEW_CONTENT_SELECTORS,
} from '../lib/constants';
import { log } from '../lib/utils';

/**
 * @typedef {Object} ContentContext
 * @property {string} mode - режим страницы (PAGE_MODES)
 * @property {Element|null} root - корневой элемент документа (тело статьи / редактора)
 * @property {Document} doc - документ, которому принадлежит root (для iframe — документ iframe)
 * @property {HTMLIFrameElement|null} frame - iframe редактора (Server), иначе null
 * @property {boolean} editable - true, если это редактор (менять DOM нельзя)
 * @property {string} strategy - способ подсветки (HIGHLIGHT_STRATEGY)
 */

/**
 * Проверяет, похож ли URL на страницу редактирования.
 * @param {string} [url=location.href] - адрес страницы
 * @returns {boolean} true для URL редактора
 */
export function isEditUrl(url = location.href) {
  return EDIT_URL_PATTERNS.some((re) => re.test(url));
}

/**
 * Возвращает тело редактора TinyMCE (Server / DC) из iframe.
 * @param {Document} doc - документ верхнего уровня
 * @returns {{frame: HTMLIFrameElement, body: HTMLElement}|null} iframe и его body или null
 */
function findServerEditor(doc) {
  const frames = doc.querySelectorAll(EDITOR_SELECTORS.serverIframe);
  for (const frame of frames) {
    try {
      // iframe редактора того же origin — доступ к contentDocument разрешён
      const body = frame.contentDocument?.querySelector(EDITOR_SELECTORS.serverBody);
      if (body) return { frame, body };
    } catch (err) {
      log.warn('Нет доступа к iframe редактора:', err);
    }
  }
  return null;
}

/**
 * Определяет режим страницы и корневой элемент документа.
 * @param {Document} [doc=document] - документ верхнего уровня
 * @returns {ContentContext} контекст для поиска и подсветки
 */
export function getContentContext(doc = document) {
  try {
    const server = findServerEditor(doc);
    if (server) {
      return {
        mode: PAGE_MODES.EDIT_SERVER,
        root: server.body,
        doc: server.body.ownerDocument,
        frame: server.frame,
        editable: true,
        strategy: HIGHLIGHT_STRATEGY.OVERLAY,
      };
    }

    const cloud = doc.querySelector(EDITOR_SELECTORS.cloudEditor);
    if (cloud) {
      return {
        mode: PAGE_MODES.EDIT_CLOUD,
        root: cloud,
        doc,
        frame: null,
        editable: true,
        strategy: HIGHLIGHT_STRATEGY.OVERLAY,
      };
    }

    const view = doc.querySelector(VIEW_CONTENT_SELECTORS.join(','));
    if (view) {
      return {
        mode: PAGE_MODES.VIEW,
        root: view,
        doc,
        frame: null,
        editable: false,
        strategy: HIGHLIGHT_STRATEGY.WRAP,
      };
    }
  } catch (err) {
    log.error('Ошибка определения режима страницы:', err);
  }
  return {
    mode: PAGE_MODES.UNKNOWN,
    root: null,
    doc,
    frame: null,
    editable: isEditUrl(),
    strategy: HIGHLIGHT_STRATEGY.OVERLAY,
  };
}

/**
 * Ждёт появления области документа (редактор грузится асинхронно).
 * @param {Document} [doc=document] - документ верхнего уровня
 * @param {number} [timeout=10000] - максимальное ожидание, мс
 * @returns {Promise<ContentContext>} контекст (mode=unknown, если не дождались)
 */
export function waitForContentContext(doc = document, timeout = 10000) {
  return new Promise((resolve) => {
    let ctx = getContentContext(doc);
    if (ctx.root) {
      resolve(ctx);
      return;
    }
    const started = Date.now();
    // iframe TinyMCE наполняется без мутаций верхнего документа — поэтому
    // кроме MutationObserver проверяем периодически
    const check = () => {
      ctx = getContentContext(doc);
      if (ctx.root || Date.now() - started > timeout) {
        observer.disconnect();
        clearInterval(timer);
        resolve(ctx);
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    const timer = setInterval(check, 300);
  });
}

/**
 * @typedef {Object} PageInfo
 * @property {string|null} pageId - идентификатор страницы
 * @property {string} title - название страницы
 * @property {string} url - адрес текущей вкладки
 * @property {string|null} baseUrl - базовый адрес Confluence (для Cloud — с /wiki)
 */

/**
 * Читает сведения о странице: id, название, базовый адрес.
 * Источники: meta-теги Confluence (Server и Cloud), затем URL и заголовок вкладки.
 * @param {Document} [doc=document] - документ верхнего уровня
 * @returns {PageInfo} сведения о странице
 */
export function getPageInfo(doc = document) {
  const meta = (name) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || null;
  try {
    const url = doc.location?.href || location.href;
    const fromUrl = url.match(/[?&]pageId=(\d+)/) || url.match(/\/pages\/(?:edit-v2\/|edit\/)?(\d+)/);
    const pageId = meta('ajs-page-id') || meta('ajs-content-id') || (fromUrl ? fromUrl[1] : null);
    const title = meta('ajs-page-title')
      || doc.querySelector('#title-text, [data-testid="title-text"], #content-title, textarea[data-test-id="editor-title"]')?.textContent?.trim()
      || doc.querySelector('#content-title')?.value
      || doc.title.replace(/\s*[-–]\s*Confluence\s*$/i, '').replace(/^Редактирование\s*-\s*/i, '');
    let baseUrl = meta('confluence-base-url') || meta('ajs-base-url');
    if (!baseUrl) {
      const u = new URL(url);
      baseUrl = u.hostname.endsWith('.atlassian.net') ? `${u.origin}/wiki` : u.origin;
    }
    return { pageId, title: String(title || '').trim(), url, baseUrl: baseUrl.replace(/\/$/, '') };
  } catch (err) {
    log.error('Ошибка чтения сведений о странице:', err);
    return { pageId: null, title: doc.title, url: location.href, baseUrl: null };
  }
}
