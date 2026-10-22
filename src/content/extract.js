/**
 * Извлечение найденных правок для экспорта в Word.
 * Для каждой правки определяется:
 *  - расположение: цепочка заголовков (+ заголовок раскрывающегося блока, + строка таблицы);
 *  - «после текста»: обычный текст, который стоит прямо перед правкой;
 *  - сам фрагмент: абзацы и пункты списков с цветом, жирным, курсивом и ссылками.
 * Работает одинаково в просмотре и в редакторах (DOM не меняется).
 */
import { getElementColor, log } from '../lib/utils';

/** Элементы, текст которых в выгрузку не попадает (плашки задач, служебные элементы) */
const SKIP_SELECTOR = [
  'script', 'style', 'noscript', 'template', '.aui-lozenge',
  '.jira-issue', '[data-macro-name="jira"]', '[data-inline-card]', '.inlineCardView-content-wrap',
  '.cfa-counter', '.cfa-overlay-layer', '.expand-control', '.ak-editor-expand__title-container',
].join(',');

/** Блочные элементы-«листья», из которых получаются абзацы */
const LEAF_BLOCKS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'DT', 'DD']);

/** Блочные контейнеры, внутрь которых спускаемся */
const CONTAINER_BLOCKS = new Set(['DIV', 'SECTION', 'UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'DETAILS']);

/** Максимальная длина «после текста» */
const BEFORE_MAX = 160;

/**
 * Текст элемента без служебных частей (плашки Jira, «СТАТУС» и т.п.).
 * @param {Element} el - элемент
 * @returns {string} текст
 */
export function cleanText(el) {
  if (!el) return '';
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) text += ` ${n.nodeValue}`;
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Обрезает текст с начала до maxLen символов по границе слова («…конец текста»).
 * @param {string} text - текст
 * @param {number} maxLen - максимальная длина
 * @returns {string} обрезанный текст
 */
function tail(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(text.length - maxLen);
  return `…${cut.slice(cut.indexOf(' ') + 1)}`;
}

/* ======================== Расположение ======================== */

/**
 * Цепочка заголовков, под которыми стоит элемент (h1 › h2 › h3 …).
 * @param {Element} el - элемент правки
 * @param {Element} root - корень документа
 * @returns {string[]} заголовки от старшего к младшему
 */
export function headingChain(el, root) {
  const stack = [];
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    if (!(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || h.contains(el)) return;
    const level = Number(h.tagName[1]);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const text = cleanText(h);
    if (text) stack.push({ level, text });
  });
  return stack.map((s) => s.text);
}

/**
 * Заголовки раскрывающихся блоков, внутри которых находится элемент.
 * @param {Element} el - элемент правки
 * @param {Element} root - корень документа
 * @returns {string[]} заголовки блоков (внешний → внутренний)
 */
export function expandTitles(el, root) {
  const titles = [];
  for (let cur = el.parentElement; cur && cur !== root; cur = cur.parentElement) {
    let title = null;
    if (cur.matches('.expand-container')) title = cur.querySelector(':scope > .expand-control .expand-control-text')?.textContent;
    else if (cur.matches('[data-node-type="expand"], [data-node-type="nestedExpand"]')) title = cur.getAttribute('data-title') || cur.querySelector('[data-testid*="expand-title"], .ak-editor-expand__title-input')?.textContent;
    else if (cur.matches('table.wysiwyg-macro[data-macro-name="expand"]')) title = (cur.getAttribute('data-macro-parameters') || '').match(/title=([^|]*)/)?.[1];
    else if (cur.tagName === 'DETAILS') title = cur.querySelector(':scope > summary')?.textContent;
    if (title?.trim()) titles.unshift(`блок «${title.trim()}»`);
  }
  return titles;
}

/**
 * Описание строки таблицы, в которой стоит элемент: «Шаг 8», «Кого вызывает», «Строка «docStatus»».
 * @param {Element} el - элемент правки (или сама строка)
 * @param {Element} root - корень документа
 * @returns {string|null} описание или null
 */
export function rowLabel(el, root) {
  const tr = el.tagName === 'TR' ? el : el.closest('tr');
  if (!tr || !root.contains(tr)) return null;
  // Макросы редактора Server (Expand, панели) свёрстаны таблицей — это не строки таблицы документа
  if (tr.closest('table')?.matches('.wysiwyg-macro, [data-macro-name]')) return null;
  const first = tr.cells?.[0];
  if (!first || first.contains(el)) {
    // Правка в первой ячейке — сама строка описывает себя
    if (!first || el.tagName !== 'TR') return null;
  }
  const text = cleanText(first);
  if (!text || text.length > 60) return null;
  const table = tr.closest('table');
  const header = cleanText(table?.rows?.[0]).toLowerCase();
  if (/^\d+(\.\d+)*$/.test(text)) return /шаг/.test(header) ? `Шаг ${text}` : `Строка ${text}`;
  if (first.tagName === 'TH') return text;
  return `Строка «${text}»`;
}

/** Селектор «листовых» блоков текста */
const LEAF_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, dt, dd, td, th';

/**
 * Текст последнего непустого абзаца внутри элемента (без чужих правок и служебных элементов).
 * @param {Element} el - элемент
 * @param {Set<Element>} groupEls - элементы правок
 * @returns {string} текст или пустая строка
 */
function lastLeafText(el, groupEls) {
  const isGroup = (n) => [...groupEls].some((g) => g === n || g.contains(n));
  const leaves = [...el.querySelectorAll(LEAF_SELECTOR)]
    .filter((n) => !n.querySelector(LEAF_SELECTOR.replace(/, td, th/, '')) || /^(P|LI|H\d|PRE)$/.test(n.tagName));
  if (!leaves.length) leaves.push(el);
  for (let i = leaves.length - 1; i >= 0; i -= 1) {
    const n = leaves[i];
    if (n.closest(SKIP_SELECTOR) || isGroup(n)) continue;
    const text = cleanText(n);
    if (text) return text;
  }
  return '';
}

/**
 * Обычный текст, который стоит прямо перед правкой: последний абзац перед ней.
 * Для правки-строки таблицы — последний абзац основной (самой длинной) ячейки предыдущей строки.
 * @param {Element} first - первый элемент правки
 * @param {Element} root - корень документа
 * @param {Set<Element>} groupEls - элементы всех правок (их текст как «предыдущий» не берём)
 * @returns {string|null} текст или null
 */
function textBefore(first, root, groupEls) {
  if (first.tagName === 'TR') {
    for (let row = first.previousElementSibling; row; row = row.previousElementSibling) {
      if (groupEls.has(row)) continue;
      const cells = [...row.cells || []];
      const main = cells.sort((a, b) => cleanText(b).length - cleanText(a).length)[0];
      const text = main ? lastLeafText(main, groupEls) : '';
      if (text) return tail(text, BEFORE_MAX);
    }
  }
  // Обёртка подсветки (режим просмотра) — смотрим от неё
  let cur = first.parentElement?.classList.contains('cfa-highlight') ? first.parentElement : first;
  while (cur && cur !== root) {
    for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.matches(SKIP_SELECTOR) || groupEls.has(sib)) continue;
      const text = lastLeafText(sib, groupEls);
      if (text) return tail(text, BEFORE_MAX);
    }
    cur = cur.parentElement;
  }
  return null;
}

/* ======================== Фрагмент ======================== */

/**
 * Форматирование текстового узла: цвет, жирный, курсив, ссылка.
 * @param {Text} node - текстовый узел
 * @param {Element} block - абзац, в котором он стоит (выше не поднимаемся за цветом)
 * @param {Element} root - корень документа
 * @returns {{color: string|null, backgroundColor: string|null, bold: boolean, italic: boolean, strike: boolean, href: string|null}} форматирование
 */
function runFormat(node, block, root) {
  let color = null;
  let backgroundColor = null;
  let bold = false;
  let italic = false;
  let strike = false;
  let href = null;
  let pastBlock = false;
  for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
    // Цвет может быть задан выше абзаца (например, на всём списке <ul style="color: …">)
    if (!color) color = getElementColor(el, false);
    if (pastBlock) continue;
    if (/^(B|STRONG)$/.test(el.tagName) || Number(el.style?.fontWeight) >= 600 || el.style?.fontWeight === 'bold') bold = true;
    if (/^(I|EM)$/.test(el.tagName) || el.style?.fontStyle === 'italic') italic = true;
    // Зачёркнутый текст (удалённое в правке): <s>, <del>, <strike>, text-decoration: line-through
    if (/^(S|DEL|STRIKE)$/.test(el.tagName) || /line-through/.test(el.style?.textDecoration || el.style?.textDecorationLine || '')) strike = true;
    if (!backgroundColor && !/^(TD|TH|TR)$/.test(el.tagName)) {
      const bg = el.getAttribute?.('data-background-custom-color') || el.style?.backgroundColor;
      if (bg && !/transparent|rgba\(0, 0, 0, 0\)/.test(bg)) backgroundColor = bg;
    }
    if (!href && el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#')) {
      try {
        href = new URL(el.getAttribute('href'), el.ownerDocument.baseURI).href;
      } catch { /* некорректная ссылка — без ссылки */ }
    }
    // Оформление (жирный, курсив, зачёркивание, ссылка) берём только в пределах абзаца
    if (el === block) pastBlock = true;
    if (/^(TD|TH)$/.test(el.tagName)) break;
  }
  return { color, backgroundColor, bold, italic, strike, href };
}

/**
 * Отрезки текста абзаца с форматированием (соседние одинаковые склеиваются).
 * @param {Element} block - абзац
 * @param {Element} root - корень документа
 * @param {string} [prefix=''] - префикс абзаца («• » для пунктов списка)
 * @returns {import('../lib/exporter').ChangeRun[]} отрезки
 */
function blockRuns(block, root, prefix = '') {
  const runs = [];
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (p?.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      // Текст вложенных абзацев/списков попадёт в свои абзацы
      const nested = p?.closest('p, li, h1, h2, h3, h4, h5, h6, pre, ul, ol, table');
      if (nested && nested !== block && block.contains(nested)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.replace(/\s+/g, ' ');
    if (!text.trim() && !runs.length) continue;
    const fmt = runFormat(n, block, root);
    const last = runs[runs.length - 1];
    const same = last && ['color', 'backgroundColor', 'bold', 'italic', 'strike', 'href'].every((k) => last[k] === fmt[k]);
    if (same) {
      last.text += text;
    } else {
      runs.push({ text, ...fmt });
    }
  }
  if (runs.length) {
    runs[0].text = prefix + runs[0].text.trimStart();
    runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
  }
  return runs.filter((r) => r.text);
}

/**
 * Раскладывает элемент правки на абзацы.
 * @param {Element} el - элемент правки
 * @param {Element} root - корень документа
 * @returns {import('../lib/exporter').ChangeRun[][]} абзацы
 */
function elementParagraphs(el, root) {
  const out = [];
  const visit = (node) => {
    if (node.matches(SKIP_SELECTOR)) return;
    const tag = node.tagName;
    const hasBlockChildren = [...node.children].some((c) => LEAF_BLOCKS.has(c.tagName) || CONTAINER_BLOCKS.has(c.tagName));
    if (LEAF_BLOCKS.has(tag) || !hasBlockChildren) {
      const prefix = tag === 'LI' ? '• ' : '';
      const runs = blockRuns(node, root, prefix);
      if (runs.some((r) => r.text.trim())) out.push(runs);
      // Вложенные списки внутри пункта списка
      if (tag === 'LI') node.querySelectorAll(':scope > ul > li, :scope > ol > li').forEach(visit);
      return;
    }
    // Строка таблицы: ячейки через « | » не склеиваем — каждая ячейка своими абзацами
    [...node.children].forEach(visit);
  };
  visit(el);
  return out;
}

/**
 * Описание найденных правок для экспорта в Word.
 * @param {import('./highlighter').ChangeGroup[]} groups - найденные правки
 * @param {Element} root - корень документа
 * @returns {import('../lib/exporter').FoundChange[]} правки с расположением и фрагментом
 */
export function describeChanges(groups, root) {
  const groupEls = new Set(groups.flatMap((g) => g.elements));
  return groups.map((g, i) => {
    try {
      const first = g.elements[0];
      const container = [...expandTitles(first, root), rowLabel(first, root)].filter(Boolean).join(' › ') || null;
      return {
        index: i,
        location: {
          headings: headingChain(first, root),
          container,
          before: textBefore(first, root, groupEls),
        },
        paragraphs: g.elements.flatMap((el) => {
          // У правки-строки таблицы первая ячейка («8», «docStatus») уже указана в расположении
          if (el.tagName === 'TR' && rowLabel(el, root) && el.cells?.length > 1) {
            return [...el.cells].slice(1).flatMap((cell) => elementParagraphs(cell, root));
          }
          return elementParagraphs(el, root);
        }),
        color: g.color ? `#${g.color}` : null,
        issueKeys: g.issueKeys,
        cancelledLabel: g.cancelledLabel || null,
      };
    } catch (err) {
      log.error('Ошибка описания правки:', err);
      return { index: i, location: { headings: [], container: null, before: null }, paragraphs: [[{ text: g.text }]], color: g.color, issueKeys: g.issueKeys };
    }
  });
}
