/**
 * Поиск цветных правок в документе и их подсветка красной рамкой.
 *
 * Алгоритм поиска:
 *  1. Обходим текстовые узлы документа (порциями в requestIdleCallback).
 *  2. Для каждого узла берём «явный» цвет ближайшего предка (style / font / Cloud-разметка).
 *  3. Узлы нужного цвета поднимаем до максимального блока, который почти целиком
 *     (≥ 80% текста) написан этим цветом, но не выше контейнера (ячейка, раскрывающийся блок).
 *  4. Соседние блоки одного цвета в одном контейнере склеиваем в одну правку;
 *     полностью цветную строку таблицы считаем одной правкой.
 *  5. Для каждой правки собираем задачи Jira рядом (в правке, у соседей, в строке таблицы).
 *
 * Подсветка:
 *  - просмотр — обёртка div.cfa-highlight (span для правки внутри строки текста);
 *  - редактор — отдельный слой рамок поверх текста, DOM документа не меняется.
 */
import { HIGHLIGHT_CLASS, HIGHLIGHT_STRATEGY } from '../lib/constants';
import { findHistoryTables } from '../lib/parser';
import { colorToHex, debounce, extractIssueKeys, getElementColor, log, runIdle } from '../lib/utils';
import { collapseBlocks, expandAll, splitByMatches } from './expander';

/** Элементы, текст которых не считается правкой (макросы задач, служебные элементы) */
const SKIP_SELECTOR = [
  'script', 'style', 'noscript', 'template',
  '.jira-issue', '[data-macro-name="jira"]', '.aui-lozenge', '[data-inline-card]', '.inlineCardView-content-wrap',
  '.cfa-counter', '.cfa-overlay-layer',
].join(',');

/** Контейнеры, выше которых правка не поднимается */
const CONTAINER_SELECTOR = [
  'td', 'th', 'blockquote', 'details',
  '.expand-content', '.wysiwyg-macro-body', '.ak-editor-expand__content', '[data-node-type="expand"]',
  '.panelContent', '.confluence-information-macro-body',
].join(',');

/** Родители, внутрь которых нельзя вставить div-обёртку (рамка ставится классом на сам элемент) */
const NO_WRAP_PARENTS = new Set(['UL', 'OL', 'DL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'SELECT']);

/** Доля текста нужного цвета, при которой блок считается целиком цветным */
const COLORED_RATIO = 0.8;

/** Допустимое отклонение цвета (евклидово расстояние в RGB) — на случай близких оттенков */
const COLOR_TOLERANCE = 10;

/**
 * @typedef {Object} HighlightOptions
 * @property {string[]|null} [colors] - цвета правок (HEX без #); null — все не нейтральные цвета
 * @property {string|null} [issueKey] - оставить только правки, рядом с которыми есть эта задача
 * @property {string[]} [knownKeys] - известные ключи задач (из «Истории изменений») для поиска в тексте
 * @property {boolean} [includeHistory=false] - искать и в самой таблице «История изменений»
 * @property {boolean} [showCounter=true] - показывать панель «Найдено N совпадений»
 * @property {boolean} [autoExpand=true] - раскрывать свёрнутые блоки перед поиском
 */

/**
 * @typedef {Object} ChangeGroup
 * @property {number} index - порядковый номер правки
 * @property {Element[]} elements - элементы правки (идут подряд в документе)
 * @property {string} color - цвет правки (HEX)
 * @property {string[]} issueKeys - задачи рядом с правкой
 * @property {string} text - текст правки
 */

/* ======================== Цвета ======================== */

/**
 * Переводит HEX в компоненты RGB.
 * @param {string} hex - цвет RRGGBB
 * @returns {number[]} [r, g, b]
 */
function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Проверяет, что цвет «нейтральный» (чёрный, серый, белый) — такой текст не считается правкой.
 * @param {string} hex - цвет RRGGBB
 * @returns {boolean} true для нейтрального цвета
 */
export function isNeutralColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) < 30;
}

/**
 * Ищет среди целевых цветов совпадающий с данным (с допуском).
 * @param {string} hex - цвет текста
 * @param {string[]|null} targets - целевые цвета; null — любой не нейтральный
 * @returns {string|null} совпавший целевой цвет (или сам цвет при targets = null)
 */
export function matchColor(hex, targets) {
  if (!hex) return null;
  if (!targets) return isNeutralColor(hex) ? null : hex;
  const [r, g, b] = hexToRgb(hex);
  for (const t of targets) {
    const [tr, tg, tb] = hexToRgb(t);
    if (Math.hypot(r - tr, g - tg, b - tb) <= COLOR_TOLERANCE) return t;
  }
  return null;
}

/**
 * Определяет явный цвет текстового узла: цвет ближайшего предка, у которого он задан.
 * @param {Text} node - текстовый узел
 * @param {Element} root - корень документа (выше не поднимаемся)
 * @returns {string|null} цвет HEX или null
 */
function getTextNodeColor(node, root) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const color = getElementColor(el, false);
    if (color) return color;
    if (el === root) break;
  }
  return null;
}

/**
 * Явный цвет фона (маркер) текстового узла: ближайший предок с заданным фоном.
 * @param {Text} node - текстовый узел
 * @param {Element} root - корень документа
 * @returns {string|null} цвет HEX или null
 */
function getTextNodeBackground(node, root) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    // Фон ячеек таблицы и заголовков — оформление, а не маркер правки
    if (/^(TD|TH|TR|TABLE)$/.test(el.tagName)) break;
    const attr = el.getAttribute('data-background-custom-color');
    const bg = attr ? colorToHex(attr) : colorToHex(el.style?.backgroundColor);
    if (bg && bg !== 'FFFFFF') return bg;
    if (el === root) break;
  }
  return null;
}

/* ======================== Поиск ======================== */

/**
 * Собирает текстовые узлы документа порциями в «простое» браузера.
 * @param {Element} root - корень документа
 * @param {(el: Element) => boolean} shouldSkip - пропустить ли узлы внутри элемента
 * @returns {Promise<Text[]>} текстовые узлы
 */
function collectTextNodes(root, shouldSkip) {
  return new Promise((resolve, reject) => {
    try {
      const doc = root.ownerDocument;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return shouldSkip(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      const step = (deadline) => {
        try {
          let n;
          // Обрабатываем, пока у браузера есть свободное время (минимум 200 узлов за порцию)
          for (let i = 0; (i < 200 || deadline.timeRemaining() > 2) && (n = walker.nextNode()); i += 1) nodes.push(n);
          if (n) runIdle(step);
          else resolve(nodes);
        } catch (err) {
          reject(err);
        }
      };
      runIdle(step);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Проверяет, что элемент — контейнер (выше него правка не поднимается).
 * @param {Element} el - элемент
 * @param {Element} root - корень документа
 * @returns {boolean} true для контейнера
 */
function isContainer(el, root) {
  return el === root || el.matches(CONTAINER_SELECTOR);
}

/**
 * Следующий/предыдущий соседний элемент, пропуская пустые (без текста и картинок).
 * @param {Element} el - элемент
 * @param {'next'|'prev'} dir - направление
 * @returns {Element|null} сосед
 */
function siblingSkippingEmpty(el, dir) {
  const prop = dir === 'next' ? 'nextElementSibling' : 'previousElementSibling';
  let s = el[prop];
  while (s && !s.textContent.trim() && !s.querySelector('img')) s = s[prop];
  return s;
}

/**
 * Ближайший заголовок раздела перед элементом (заголовок, под которым стоит правка).
 * @param {Element} el - элемент правки
 * @param {Element[]} headings - все заголовки документа в порядке следования
 * @returns {Element|null} заголовок или null
 */
function sectionHeading(el, headings) {
  let found = null;
  for (const h of headings) {
    if (h.contains(el)) continue;
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
    else break;
  }
  return found;
}

/**
 * Следующий соседний элемент, если между ними нет обычного текста
 * (иначе два цветных фрагмента одной строки, разделённые обычным текстом, склеились бы в одну правку).
 * @param {Element} el - элемент
 * @returns {Element|null} соседний элемент или null
 */
function adjacentNext(el) {
  for (let n = el.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n.nodeValue.trim()) return null;
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      if (n.textContent.trim() || n.querySelector('img')) return n;
    }
  }
  return null;
}

/**
 * Находит цветные правки в документе.
 * @param {Element} root - корень документа (тело статьи или редактора)
 * @param {HighlightOptions} [opts] - параметры поиска
 * @returns {Promise<ChangeGroup[]>} найденные правки в порядке документа
 */
export async function findChanges(root, opts = {}) {
  const targets = opts.colors?.length ? opts.colors.map((c) => c.toUpperCase()) : null;
  const historyTables = opts.includeHistory ? [] : findHistoryTables(root);
  const shouldSkip = (el) => Boolean(el.closest(SKIP_SELECTOR)) || historyTables.some((t) => t.contains(el));

  const nodes = await collectTextNodes(root, shouldSkip);

  // Длина всего текста и текста нужного цвета для каждого предка (для расчёта доли)
  const total = new Map();
  const colored = new Map();
  const matched = [];
  for (const node of nodes) {
    const len = node.nodeValue.trim().length;
    // Правка может быть отмечена цветом текста или заливкой фона (маркером)
    const color = matchColor(getTextNodeColor(node, root), targets) || matchColor(getTextNodeBackground(node, root), targets);
    if (color) matched.push({ node, color });
    for (let el = node.parentElement; el; el = el.parentElement) {
      total.set(el, (total.get(el) || 0) + len);
      if (color) colored.set(el, (colored.get(el) || 0) + len);
      if (el === root) break;
    }
  }
  const ratio = (el) => (colored.get(el) || 0) / (total.get(el) || 1);

  // Поднимаем каждый цветной узел до максимального «целиком цветного» блока
  const blocks = new Map(); // элемент → цвет
  for (const { node, color } of matched) {
    let el = node.parentElement;
    while (el !== root && el.parentElement && !isContainer(el.parentElement, root) && ratio(el.parentElement) >= COLORED_RATIO) {
      el = el.parentElement;
    }
    if (!blocks.has(el)) blocks.set(el, color);
  }

  // Убираем вложенные блоки и сортируем в порядке документа
  let list = [...blocks.keys()].filter((el) => ![...blocks.keys()].some((o) => o !== el && o.contains(el)));
  list.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  // Полностью цветная строка таблицы — одна правка
  const rows = new Map();
  list = list.map((el) => {
    const tr = el.closest('tr');
    if (tr && root.contains(tr) && tr !== el && ratio(tr) >= COLORED_RATIO && !historyTables.includes(tr.closest('table'))) {
      if (!rows.has(tr)) rows.set(tr, blocks.get(el));
      return tr;
    }
    return el;
  }).filter((el, i, arr) => arr.indexOf(el) === i);

  // Склеиваем соседние блоки одного цвета в одну правку
  const groups = [];
  for (const el of list) {
    const color = blocks.get(el) || rows.get(el);
    const last = groups[groups.length - 1];
    const lastEl = last?.elements[last.elements.length - 1];
    if (last && last.color === color && adjacentNext(lastEl) === el) {
      last.elements.push(el);
    } else {
      groups.push({ elements: [el], color });
    }
  }

  // Задачи рядом с правкой: в самой правке, у соседних блоков, в строке таблицы, в заголовке раздела
  const known = opts.knownKeys || null;
  const headings = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  const result = groups.map((g, index) => {
    const keys = new Set();
    const scan = (el) => el && extractIssueKeys(el, known).forEach((k) => keys.add(k));
    g.elements.forEach(scan);
    const first = g.elements[0];
    const lastEl = g.elements[g.elements.length - 1];
    // Соседние строки таблицы — это уже другие правки (другой шаг), их не смотрим
    if (first.tagName !== 'TR') {
      const scanAround = (a, b) => {
        scan(siblingSkippingEmpty(a, 'prev'));
        const next = siblingSkippingEmpty(b, 'next');
        scan(next);
        scan(next && siblingSkippingEmpty(next, 'next'));
      };
      scanAround(first, lastEl);
      // Правка внутри строки текста: задача часто стоит отдельным абзацем рядом с этим абзацем
      if (isInline(first)) {
        const block = first.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, td, th, div');
        if (block && block !== root && root.contains(block)) {
          scan(block);
          if (!/^(TD|TH)$/.test(block.tagName)) scanAround(block, block);
        }
      }
      const tr = first.closest('tr');
      if (tr && root.contains(tr)) scan(tr);
    }
    // Задача в заголовке раздела («PLATFORM-12096 … Переход в состояние …») относится к его содержимому
    scan(sectionHeading(first, headings));
    return {
      index,
      elements: g.elements,
      color: g.color,
      issueKeys: [...keys],
      text: g.elements.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' '),
    };
  });

  return opts.issueKey ? result.filter((g) => g.issueKeys.includes(opts.issueKey)).map((g, i) => ({ ...g, index: i })) : result;
}

/* ======================== Подсветка: обёртка (просмотр) ======================== */

/**
 * Проверяет, является ли элемент строчным (inline).
 * @param {Element} el - элемент
 * @returns {boolean} true для inline-элемента
 */
function isInline(el) {
  const view = el.ownerDocument.defaultView;
  return view ? view.getComputedStyle(el).display.startsWith('inline') : false;
}

/**
 * Оборачивает правку в div.cfa-highlight (или span — для правки внутри строки текста).
 * Если обёртку вставить нельзя (элементы списка, строки таблицы) — класс ставится на сами элементы.
 * @param {ChangeGroup} group - правка
 * @returns {{targets: Element[], undo: Function}} элементы с рамкой и функция отмены
 */
function wrapGroup(group) {
  const first = group.elements[0];
  const doc = first.ownerDocument;
  if (NO_WRAP_PARENTS.has(first.parentElement?.tagName) || first.tagName === 'TR' || first.tagName === 'LI') {
    group.elements.forEach((el) => el.classList.add(HIGHLIGHT_CLASS));
    return {
      targets: group.elements,
      undo: () => group.elements.forEach((el) => {
        el.classList.remove(HIGHLIGHT_CLASS, `${HIGHLIGHT_CLASS}--active`);
        if (!el.classList.length) el.removeAttribute('class');
      }),
    };
  }
  const inline = group.elements.length === 1 && isInline(first);
  const wrapper = doc.createElement(inline ? 'span' : 'div');
  wrapper.className = inline ? `${HIGHLIGHT_CLASS} ${HIGHLIGHT_CLASS}--inline` : HIGHLIGHT_CLASS;
  wrapper.dataset.cfaIndex = String(group.index);
  first.before(wrapper);
  group.elements.forEach((el) => wrapper.appendChild(el));
  return {
    targets: [wrapper],
    undo: () => { if (wrapper.isConnected) wrapper.replaceWith(...wrapper.childNodes); },
  };
}

/* ======================== Подсветка: слой поверх (редактор) ======================== */

/**
 * Слой рамок поверх документа. Рамки — отдельные элементы в документе верхнего уровня
 * (вне редактора), их позиции пересчитываются при прокрутке, изменении размеров и правках текста.
 */
class OverlayLayer {
  /**
   * @param {import('./page-context').ContentContext} ctx - контекст страницы
   * @param {ChangeGroup[]} groups - правки
   */
  constructor(ctx, groups) {
    this.ctx = ctx;
    this.groups = groups;
    this.layer = document.createElement('div');
    this.layer.className = 'cfa-overlay-layer';
    this.boxes = groups.map(() => {
      const box = document.createElement('div');
      box.className = 'cfa-overlay-box';
      this.layer.appendChild(box);
      return box;
    });
    document.body.appendChild(this.layer);
    this.scheduled = false;
    this.update = this.update.bind(this);
    this.schedule = this.schedule.bind(this);
    this.windows = [window];
    const frameWin = ctx.frame?.contentWindow;
    if (frameWin) this.windows.push(frameWin);
    this.windows.forEach((w) => {
      w.addEventListener('scroll', this.schedule, true);
      w.addEventListener('resize', this.schedule);
    });
    this.resizeObserver = new ResizeObserver(this.schedule);
    this.resizeObserver.observe(ctx.root);
    if (ctx.frame) this.resizeObserver.observe(ctx.frame);
    this.update();
  }

  /** Планирует пересчёт позиций на следующий кадр */
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => { this.scheduled = false; this.update(); });
  }

  /** Пересчитывает позиции рамок (координаты окна верхнего уровня, с обрезкой по iframe редактора) */
  update() {
    try {
      let offX = 0;
      let offY = 0;
      let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      if (this.ctx.frame) {
        const fr = this.ctx.frame.getBoundingClientRect();
        offX = fr.left + this.ctx.frame.clientLeft;
        offY = fr.top + this.ctx.frame.clientTop;
        clip = {
          left: Math.max(fr.left, 0), top: Math.max(fr.top, 0),
          right: Math.min(fr.right, window.innerWidth), bottom: Math.min(fr.bottom, window.innerHeight),
        };
      }
      this.groups.forEach((g, i) => {
        const box = this.boxes[i];
        const rects = g.elements.filter((el) => el.isConnected).map((el) => el.getBoundingClientRect())
          .filter((r) => r.width || r.height);
        if (!rects.length) { box.style.display = 'none'; return; }
        const pad = 3;
        const left = Math.min(...rects.map((r) => r.left)) + offX - pad;
        const top = Math.min(...rects.map((r) => r.top)) + offY - pad;
        const right = Math.max(...rects.map((r) => r.right)) + offX + pad;
        const bottom = Math.max(...rects.map((r) => r.bottom)) + offY + pad;
        // Обрезаем рамку по видимой области редактора
        const l = Math.max(left, clip.left);
        const t = Math.max(top, clip.top);
        const r = Math.min(right, clip.right);
        const b = Math.min(bottom, clip.bottom);
        if (r <= l || b <= t) { box.style.display = 'none'; return; }
        Object.assign(box.style, { display: 'block', left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` });
      });
    } catch (err) {
      log.error('Ошибка пересчёта рамок:', err);
    }
  }

  /**
   * Отмечает активную рамку.
   * @param {number} index - номер правки
   */
  setActive(index) {
    this.boxes.forEach((b, i) => b.classList.toggle('cfa-overlay-box--active', i === index));
  }

  /** Удаляет слой и подписки */
  destroy() {
    this.windows.forEach((w) => {
      try {
        w.removeEventListener('scroll', this.schedule, true);
        w.removeEventListener('resize', this.schedule);
      } catch { /* окно iframe могло быть уже выгружено */ }
    });
    this.resizeObserver.disconnect();
    this.layer.remove();
  }
}

/* ======================== Панель-счётчик ======================== */

/**
 * Склоняет слово «совпадение» по числу.
 * @param {number} n - число
 * @returns {string} «совпадение» / «совпадения» / «совпадений»
 */
function pluralMatches(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'совпадение';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'совпадения';
  return 'совпадений';
}

/* ======================== Управление подсветкой ======================== */

/** Текущее состояние подсветки */
const state = {
  /** @type {ChangeGroup[]} */ groups: [],
  /** @type {Array<{targets: Element[], undo: Function}>} */ wraps: [],
  /** @type {OverlayLayer|null} */ overlay: null,
  /** @type {HTMLElement|null} */ counter: null,
  /** @type {MutationObserver|null} */ observer: null,
  /** Блоки, раскрытые расширением (сворачиваются обратно при сбросе) */
  /** @type {import('./expander').ExpandedBlock[]} */ expanded: [],
  active: -1,
  /** Параметры последнего поиска и контекст — для повторного поиска при правках в редакторе */
  lastOpts: null,
  lastCtx: null,
};

/**
 * Показывает плавающую панель «Найдено N совпадений» с переходом ↑ ↓ и закрытием ✕.
 * @param {number} count - число найденных правок
 * @returns {void}
 */
function renderCounter(count, expandedCount = 0) {
  state.counter?.remove();
  const panel = document.createElement('div');
  panel.className = 'cfa-counter';
  panel.innerHTML = `
    <span class="cfa-counter__dot"></span>
    <span class="cfa-counter__text"></span>
    <button class="cfa-counter__btn" data-act="prev" title="Предыдущее">↑</button>
    <button class="cfa-counter__btn" data-act="next" title="Следующее">↓</button>
    <button class="cfa-counter__btn" data-act="close" title="Убрать подсветку">✕</button>`;
  panel.querySelector('.cfa-counter__text').textContent = `Найдено ${count} ${pluralMatches(count)}`;
  if (expandedCount) {
    const hint = document.createElement('span');
    hint.className = 'cfa-counter__hint';
    hint.textContent = `раскрыто блоков: ${expandedCount}`;
    panel.querySelector('.cfa-counter__text').after(hint);
  }
  panel.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'prev') goTo(state.active - 1);
    if (act === 'next') goTo(state.active + 1);
    if (act === 'close') clearHighlight();
  });
  if (!count) panel.querySelectorAll('[data-act="prev"], [data-act="next"]').forEach((b) => { b.disabled = true; });
  document.body.appendChild(panel);
  state.counter = panel;
}

/**
 * Прокручивает к правке с номером index и отмечает её активной.
 * @param {number} index - номер правки (по кругу)
 * @returns {void}
 */
export function goTo(index) {
  const n = state.groups.length;
  if (!n) return;
  const i = ((index % n) + n) % n;
  state.active = i;
  try {
    state.wraps.forEach((w, k) => w.targets.forEach((t) => t.classList.toggle(`${HIGHLIGHT_CLASS}--active`, k === i)));
    state.overlay?.setActive(i);
    state.groups[i].elements[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    const text = state.counter?.querySelector('.cfa-counter__text');
    if (text) text.textContent = `Совпадение ${i + 1} из ${n}`;
  } catch (err) {
    log.error('Ошибка перехода к правке:', err);
  }
}

/**
 * Убирает подсветку и восстанавливает документ.
 * @param {boolean} [keepOptions=false] - сохранить параметры поиска (для повторного поиска)
 * @param {boolean} [keepExpanded=false] - не сворачивать раскрытые блоки (повторный поиск в редакторе)
 * @returns {void}
 */
export function clearHighlight(keepOptions = false, keepExpanded = false) {
  try {
    state.observer?.disconnect();
    state.observer = null;
    // Отменяем в обратном порядке, чтобы вложенные обёртки снимались корректно
    [...state.wraps].reverse().forEach((w) => w.undo());
    state.wraps = [];
    state.overlay?.destroy();
    state.overlay = null;
    state.counter?.remove();
    state.counter = null;
    state.groups = [];
    state.active = -1;
    if (!keepExpanded) {
      collapseBlocks(state.expanded);
      state.expanded = [];
    }
    if (!keepOptions) { state.lastOpts = null; state.lastCtx = null; }
  } catch (err) {
    log.error('Ошибка снятия подсветки:', err);
  }
}

/**
 * В редакторе следит за правками текста и повторяет поиск (рамки остаются актуальными).
 * @returns {void}
 */
function watchEditor() {
  const ctx = state.lastCtx;
  if (!ctx?.editable) return;
  const rerun = debounce(() => {
    if (state.lastOpts) applyHighlight(ctx, state.lastOpts, true).catch((err) => log.error(err));
  }, 600);
  state.observer = new MutationObserver((mutations) => {
    // Игнорируем изменения, вызванные самим расширением
    if (mutations.every((m) => m.target.closest?.('.cfa-overlay-layer'))) return;
    rerun();
  });
  state.observer.observe(ctx.root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'data-text-custom-color'] });
}

/**
 * Находит правки и подсвечивает их.
 * @param {import('./page-context').ContentContext} ctx - контекст страницы
 * @param {HighlightOptions} opts - параметры поиска
 * @param {boolean} [silent=false] - повторный поиск (не прокручивать к первой правке)
 * @returns {Promise<ChangeGroup[]>} найденные правки
 */
export async function applyHighlight(ctx, opts = {}, silent = false) {
  if (!ctx?.root) throw new Error('Не найдено содержимое страницы Confluence');
  clearHighlight(true, silent);
  state.lastOpts = opts;
  state.lastCtx = ctx;

  // 1. Раскрываем свёрнутые блоки (содержимое может подгружаться только при раскрытии)
  if (opts.autoExpand !== false) {
    state.expanded.push(...await expandAll(ctx.root));
  }

  // 2. Ищем правки уже в раскрытом документе
  const groups = await findChanges(ctx.root, opts);
  state.groups = groups;

  // 3. Блоки без правок сворачиваем обратно — открытыми остаются только нужные
  if (state.expanded.length) {
    const { keep, extra } = splitByMatches(state.expanded, groups.flatMap((g) => g.elements));
    collapseBlocks(extra);
    state.expanded = keep;
  }

  if (ctx.strategy === HIGHLIGHT_STRATEGY.WRAP) {
    state.wraps = groups.map(wrapGroup);
  } else {
    state.overlay = new OverlayLayer(ctx, groups);
  }
  if (opts.showCounter !== false) renderCounter(groups.length, state.expanded.length);
  watchEditor();
  if (groups.length && !silent) goTo(0);
  log.info(`Подсвечено правок: ${groups.length} (режим: ${ctx.mode}, способ: ${ctx.strategy})`);
  return groups;
}

/**
 * Текущие найденные правки и контекст (для экспорта).
 * @returns {{groups: ChangeGroup[], ctx: Object|null}} правки и контекст
 */
export function getCurrentHighlight() {
  return { groups: state.groups, ctx: state.lastCtx };
}

/**
 * Краткое описание найденных правок для передачи в popup.
 * @param {ChangeGroup[]} groups - правки
 * @returns {Array<{index: number, color: string, issueKeys: string[], text: string}>} сериализуемый список
 */
export function summarize(groups) {
  return groups.map(({ index, color, issueKeys, text }) => ({ index, color, issueKeys, text: text.slice(0, 300) }));
}
