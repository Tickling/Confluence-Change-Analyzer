/**
 * Поиск упоминаний задачи (PROJ-123) в теле документа для вкладки «Статус задачи».
 *
 * Находит: ссылки на трекер, макрос Jira (просмотр и редактор Server), карточки Cloud,
 * задачи в заголовках разделов и упоминания простым текстом. Таблицы «История изменений»
 * пропускаются — их разбирает парсер истории. Текущий статус задачи читается из плашки
 * макроса Jira на странице (без запросов к Jira — данные никуда не отправляются).
 */
import { findHistoryTables } from '../lib/parser';
import { log } from '../lib/utils';
import { collapseBlocks, expandAll, expandAncestors, splitByMatches } from './expander';
import { cleanText, expandTitles, headingChain, rowLabel } from './extract';

/** Контейнеры одного упоминания задачи (макрос/карточка целиком, а не ссылка внутри) */
const MENTION_CONTAINER = '.jira-issue, [data-macro-name="jira"], [data-inline-card], .inlineCardView-content-wrap';

/** Плашка статуса в макросе Jira (Server) и в карточке Cloud */
const STATUS_SELECTOR = '.aui-lozenge, [data-testid*="lozenge"], .status-lozenge, [class*="lozenge"]';

/** Заглушки, которые макрос показывает, пока статус не загружен */
const STATUS_PLACEHOLDERS = /^(статус|status|загрузка|loading)\.*$/i;

/** Блоки текста, в которых показываем контекст упоминания */
const CONTEXT_BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre';

/** Последние найденные упоминания (для «показать на странице») */
let lastMentions = [];
let expandedBlocks = [];

/**
 * @typedef {Object} TaskMention
 * @property {number} index - номер упоминания
 * @property {'link'|'macro'|'heading'|'text'} kind - вид упоминания
 * @property {{headings: string[], container: string|null}} location - расположение в документе
 * @property {string} context - текст абзаца, где стоит упоминание
 * @property {string|null} status - статус задачи из плашки (если загружен)
 * @property {string|null} href - ссылка на задачу
 */

/**
 * Экранирует строку для регулярного выражения.
 * @param {string} s - строка
 * @returns {string} экранированная строка
 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Статус из плашки внутри контейнера упоминания.
 * @param {Element} container - макрос / карточка задачи
 * @returns {string|null} статус или null, если не загружен
 */
function readStatus(container) {
  const lozenge = container.querySelector(STATUS_SELECTOR);
  const text = lozenge?.textContent.replace(/\s+/g, ' ').trim();
  return text && !STATUS_PLACEHOLDERS.test(text) ? text : null;
}

/**
 * Находит элементы-упоминания задачи в документе.
 * @param {Element} root - корень документа
 * @param {string} key - ключ задачи
 * @returns {Array<{el: Element, kind: string, href: string|null}>} упоминания в порядке документа
 */
function collectMentionElements(root, key) {
  const history = findHistoryTables(root);
  const inHistory = (el) => history.some((t) => t.contains(el));
  const found = new Map();
  const add = (el, kind, href = null) => {
    if (!el || inHistory(el)) return;
    const container = el.closest(MENTION_CONTAINER) || el;
    if (!found.has(container)) found.set(container, { el: container, kind, href });
  };
  const re = new RegExp(`/(?:browse|issue)/${escapeRe(key)}(?![0-9])`);

  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (re.test(href)) add(a, a.closest(MENTION_CONTAINER) ? 'macro' : 'link', a.href);
  });
  root.querySelectorAll(`[data-jira-key="${key}"]`).forEach((el) => add(el, 'macro'));
  root.querySelectorAll('[data-macro-name="jira"]').forEach((el) => {
    if (new RegExp(`(?:^|\\|)key=${escapeRe(key)}(?:\\||$)`).test(el.getAttribute('data-macro-parameters') || '')) add(el, 'macro');
  });
  root.querySelectorAll('[data-card-url], [data-url]').forEach((el) => {
    const url = el.getAttribute('data-card-url') || el.getAttribute('data-url') || '';
    if (re.test(url)) add(el, 'macro', url);
  });

  // Упоминания простым текстом (вне макросов и ссылок)
  const textRe = new RegExp(`(^|[^A-Z0-9_-])${escapeRe(key)}(?![0-9])`);
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!textRe.test(n.nodeValue)) continue;
    const p = n.parentElement;
    if (!p || p.closest(`${MENTION_CONTAINER}, a, script, style`)) continue;
    add(p.closest(CONTEXT_BLOCK) || p, 'text');
  }

  // Упоминание в заголовке раздела — отдельный вид
  const list = [...found.values()].map((m) => ({ ...m, kind: m.el.closest('h1, h2, h3, h4, h5, h6') ? 'heading' : m.kind }));
  list.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return list;
}

/**
 * Текст рядом с упоминанием, чтобы было понятно, о чём речь.
 * Если плашка задачи стоит отдельным абзацем/ячейкой — берётся соседний абзац
 * или основная (самая длинная) ячейка той же строки таблицы.
 * @param {Element} el - элемент упоминания
 * @param {Element} root - корень документа
 * @returns {string} текст (до 200 символов)
 */
function mentionContext(el, root) {
  const block = el.closest(CONTEXT_BLOCK) || el;
  let text = cleanText(block);
  if (!text) {
    const tr = el.closest('tr');
    if (tr && root.contains(tr) && !tr.closest('table')?.matches('.wysiwyg-macro, [data-macro-name]')) {
      const main = [...tr.cells].filter((c) => !c.contains(el)).sort((a, b) => cleanText(b).length - cleanText(a).length)[0];
      text = cleanText(main);
    }
  }
  for (let sib = block.previousElementSibling, i = 0; !text && sib && i < 3; sib = sib.previousElementSibling, i += 1) {
    text = cleanText(sib);
  }
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * Ищет упоминания задачи в документе.
 * @param {import('./page-context').ContentContext} ctx - контекст страницы
 * @param {string} key - ключ задачи (PROJ-123)
 * @param {{autoExpand?: boolean}} [opts] - раскрывать ли свёрнутые блоки
 * @returns {Promise<{mentions: TaskMention[], status: string|null, href: string|null}>} результат
 */
export async function findTaskMentions(ctx, key, { autoExpand = true } = {}) {
  const { root } = ctx;
  collapseBlocks(expandedBlocks);
  expandedBlocks = [];
  // Свёрнутые блоки раскрываем (содержимое может подгружаться только при раскрытии)
  const opened = autoExpand ? await expandAll(root) : [];
  const elements = collectMentionElements(root, key);
  // Блоки без упоминаний сворачиваем обратно
  const { keep, extra } = splitByMatches(opened, elements.map((m) => m.el));
  collapseBlocks(extra);
  expandedBlocks = keep;

  lastMentions = elements.map((m) => m.el);
  const mentions = elements.map((m, index) => {
    const container = m.el.closest(MENTION_CONTAINER);
    return {
      index,
      kind: m.kind,
      location: {
        headings: m.kind === 'heading' ? headingChain(m.el.closest('h1, h2, h3, h4, h5, h6'), root) : headingChain(m.el, root),
        container: [...expandTitles(m.el, root), rowLabel(m.el, root)].filter(Boolean).join(' › ') || null,
      },
      context: mentionContext(m.el, root),
      status: container ? readStatus(container) : null,
      href: m.href || container?.querySelector('a[href]')?.href || null,
    };
  });
  const withStatus = mentions.find((m) => m.status);
  log.info(`Упоминаний ${key} в документе: ${mentions.length}`);
  return {
    mentions,
    status: withStatus?.status || null,
    href: mentions.find((m) => m.href)?.href || null,
  };
}

/**
 * Временная рамка поверх элемента (режим редактирования): позиция считается
 * с учётом iframe редактора Server, через 2 секунды рамка удаляется.
 * @param {import('./page-context').ContentContext} ctx - контекст страницы
 * @param {Element} target - элемент
 * @returns {void}
 */
function flashOverlay(ctx, target) {
  const r = target.getBoundingClientRect();
  const fr = ctx.frame ? ctx.frame.getBoundingClientRect() : { left: 0, top: 0 };
  const box = document.createElement('div');
  box.className = 'cfa-overlay-box cfa-overlay-box--active cfa-flash-box';
  Object.assign(box.style, {
    display: 'block',
    left: `${r.left + fr.left - 3}px`,
    top: `${r.top + fr.top - 3}px`,
    width: `${r.width + 6}px`,
    height: `${r.height + 6}px`,
    zIndex: '2147482500',
    pointerEvents: 'none',
  });
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 2000);
}

/**
 * Показывает упоминание на странице: раскрывает блоки, прокручивает и подсвечивает на 2 секунды.
 * @param {import('./page-context').ContentContext} ctx - контекст страницы
 * @param {number} index - номер упоминания
 * @returns {boolean} true, если упоминание найдено
 */
export function revealMention(ctx, index) {
  const el = lastMentions[index];
  if (!el?.isConnected) return false;
  try {
    expandAncestors(el, ctx.root);
    const target = el.closest(CONTEXT_BLOCK) || el;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (ctx.editable) {
      // В редакторе документ не трогаем — рамка рисуется отдельным элементом поверх текста
      setTimeout(() => flashOverlay(ctx, target), 400);
    } else {
      target.classList.add('cfa-flash');
      setTimeout(() => {
        target.classList.remove('cfa-flash');
        if (!target.classList.length) target.removeAttribute('class');
      }, 2000);
    }
    return true;
  } catch (err) {
    log.error('Ошибка показа упоминания:', err);
    return false;
  }
}
