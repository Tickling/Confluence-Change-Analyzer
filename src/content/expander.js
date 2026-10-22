/**
 * Автоматическое раскрытие свёрнутых блоков перед поиском правок.
 *
 * Поддерживается:
 *  - Server / DC: макрос Expand (.expand-control), AUI expander (.aui-expander-trigger);
 *  - Cloud: макрос Expand в просмотре и в редакторе (кнопка с aria-expanded="false");
 *  - стандартный <details>/<summary>.
 *
 * Раскрытие идёт волнами: после каждой волны ждём, пока содержимое появится
 * (MutationObserver), и ищем вложенные свёрнутые блоки. Каждый раскрытый блок
 * запоминается, чтобы потом свернуть его обратно.
 */
import { EXPANDER_SELECTORS } from '../lib/constants';
import { log } from '../lib/utils';

/** Контейнер раскрывающегося блока (по нему проверяем, есть ли внутри правки) */
const EXPAND_CONTAINER_SELECTOR = [
  '.expand-container', // Server: макрос Expand
  '.aui-expander-content', // Server: AUI expander
  '[data-node-type="expand"]', '[data-node-type="nestedExpand"]', // Cloud
  '[data-testid="expand-container"]',
  'details',
].join(',');

/**
 * @typedef {Object} ExpandedBlock
 * @property {Element} trigger - элемент, по которому кликнули
 * @property {Element} container - контейнер блока (содержимое внутри него)
 * @property {Function} collapse - свернуть блок обратно
 */

/**
 * Проверяет, свёрнут ли блок, которым управляет элемент.
 * @param {Element} trigger - элемент управления (кнопка/заголовок блока)
 * @returns {boolean} true, если блок свёрнут
 */
function isCollapsed(trigger) {
  // <summary> внутри закрытого <details>
  if (trigger.tagName === 'SUMMARY') return !trigger.parentElement?.open;
  // Server: макрос Expand — содержимое помечено классом expand-hidden
  if (trigger.classList.contains('expand-control')) {
    const content = trigger.closest('.expand-container')?.querySelector('.expand-content');
    return content ? content.classList.contains('expand-hidden') || content.offsetHeight === 0 : false;
  }
  // AUI expander и Cloud: признак — aria-expanded
  const expanded = trigger.getAttribute('aria-expanded');
  if (expanded !== null) return expanded === 'false';
  return false;
}

/**
 * Находит свёрнутые блоки внутри документа.
 * @param {Element} root - корень документа
 * @returns {Element[]} элементы, которые нужно «нажать»
 */
function findCollapsed(root) {
  const triggers = [...root.querySelectorAll(EXPANDER_SELECTORS.join(','))];
  return triggers.filter((t) => {
    try {
      return isCollapsed(t);
    } catch {
      return false;
    }
  });
}

/**
 * Раскрывает один блок и возвращает запись для обратного сворачивания.
 * @param {Element} trigger - элемент управления блоком
 * @returns {ExpandedBlock|null} раскрытый блок или null при ошибке
 */
function expandOne(trigger) {
  try {
    const container = trigger.closest(EXPAND_CONTAINER_SELECTOR) || trigger.parentElement;
    if (trigger.tagName === 'SUMMARY') {
      const details = trigger.parentElement;
      details.open = true;
      return { trigger, container, collapse: () => { details.open = false; } };
    }
    trigger.click();
    return {
      trigger,
      container,
      // Сворачиваем повторным кликом, только если блок всё ещё раскрыт
      collapse: () => { if (trigger.isConnected && !isCollapsed(trigger)) trigger.click(); },
    };
  } catch (err) {
    log.warn('Не удалось раскрыть блок:', err);
    return null;
  }
}

/**
 * Ждёт, пока DOM «успокоится»: нет изменений в течение quietMs (или истёк timeout).
 * Нужно, чтобы дождаться появления содержимого блоков, которое подгружается при раскрытии.
 * @param {Element} root - наблюдаемый элемент
 * @param {number} [quietMs=250] - пауза без изменений, мс
 * @param {number} [timeout=2000] - максимальное ожидание, мс
 * @returns {Promise<void>}
 */
export function waitForDomSettled(root, quietMs = 250, timeout = 2000) {
  return new Promise((resolve) => {
    let quietTimer = null;
    const finish = () => {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    quietTimer = setTimeout(finish, quietMs);
    const hardTimer = setTimeout(finish, timeout);
  });
}

/**
 * Проверяет, пустой ли раскрытый блок (содержимое ещё не подгрузилось).
 * @param {ExpandedBlock} block - раскрытый блок
 * @returns {boolean} true, если кроме заголовка в блоке нет текста
 */
function isEmptyBlock(block) {
  const total = block.container.textContent.trim().length;
  const title = block.trigger.textContent.trim().length;
  return total - title < 2;
}

/**
 * Ждёт, пока в пустых раскрытых блоках появится содержимое
 * (в Cloud оно может подгружаться с сервера только при раскрытии).
 * @param {Element} root - корень документа
 * @param {ExpandedBlock[]} blocks - раскрытые в этой волне блоки
 * @param {number} [timeout=5000] - максимальное ожидание, мс
 * @returns {Promise<void>}
 */
function waitForLazyContent(root, blocks, timeout = 5000) {
  const pending = () => blocks.filter((b) => b.container.isConnected && isEmptyBlock(b));
  if (!pending().length) return Promise.resolve();
  log.info(`Ожидание подгрузки содержимого блоков: ${pending().length}`);
  return new Promise((resolve) => {
    const finish = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
    const observer = new MutationObserver(() => { if (!pending().length) finish(); });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => {
      log.warn('Содержимое части блоков не подгрузилось за отведённое время');
      finish();
    }, timeout);
  });
}

/**
 * Раскрывает все свёрнутые блоки (включая вложенные).
 * @param {Element} root - корень документа
 * @param {Object} [opts]
 * @param {number} [opts.maxRounds=5] - максимум волн (уровней вложенности)
 * @returns {Promise<ExpandedBlock[]>} раскрытые блоки (в порядке раскрытия)
 */
export async function expandAll(root, { maxRounds = 5 } = {}) {
  const opened = [];
  const seen = new WeakSet();
  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const collapsed = findCollapsed(root).filter((t) => !seen.has(t));
      if (!collapsed.length) break;
      const wave = [];
      collapsed.forEach((t) => {
        seen.add(t);
        const block = expandOne(t);
        if (block) wave.push(block);
      });
      opened.push(...wave);
      // Ждём появления содержимого: сначала «тишины» в DOM, затем подгрузки пустых блоков
      await waitForDomSettled(root);
      await waitForLazyContent(root, wave);
    }
    if (opened.length) log.info(`Раскрыто свёрнутых блоков: ${opened.length}`);
  } catch (err) {
    log.error('Ошибка раскрытия блоков:', err);
  }
  return opened;
}

/**
 * Сворачивает обратно блоки (вложенные — первыми).
 * @param {ExpandedBlock[]} blocks - раскрытые блоки
 * @returns {void}
 */
export function collapseBlocks(blocks) {
  [...blocks].reverse().forEach((b) => {
    try {
      b.collapse();
    } catch (err) {
      log.warn('Не удалось свернуть блок:', err);
    }
  });
}

/**
 * Делит раскрытые блоки на нужные (внутри есть найденная правка) и лишние.
 * @param {ExpandedBlock[]} blocks - раскрытые блоки
 * @param {Element[]} matchElements - элементы найденных правок
 * @returns {{keep: ExpandedBlock[], extra: ExpandedBlock[]}} разбиение
 */
export function splitByMatches(blocks, matchElements) {
  const keep = [];
  const extra = [];
  blocks.forEach((b) => {
    const hasMatch = matchElements.some((el) => b.container.contains(el));
    (hasMatch ? keep : extra).push(b);
  });
  return { keep, extra };
}

/**
 * Раскрывает свёрнутые блоки, внутри которых находится элемент (чтобы его стало видно).
 * @param {Element} el - элемент
 * @param {Element} root - корень документа
 * @returns {number} сколько блоков раскрыто
 */
export function expandAncestors(el, root) {
  let opened = 0;
  for (let cur = el.parentElement; cur && cur !== root; cur = cur.parentElement) {
    let trigger = null;
    if (cur.matches('.expand-container')) trigger = cur.querySelector(':scope > .expand-control');
    else if (cur.matches('[data-node-type="expand"], [data-node-type="nestedExpand"]')) trigger = cur.querySelector('button[aria-expanded]');
    else if (cur.tagName === 'DETAILS' && !cur.open) { cur.open = true; opened += 1; }
    if (trigger && isCollapsed(trigger)) {
      trigger.click();
      opened += 1;
    }
  }
  return opened;
}
