/**
 * Логика popup.
 * ШАГ 2: UI — переключение вкладок, настройки (шестерёнка), открытие инструкции.
 * ШАГ 5: кнопка «Анализ» → background → content script, вывод и сохранение результата.
 * ШАГ 6: фильтры (AND, debounce) → подсветка на странице.
 * ШАГ 8: экспорт в Word (найденные правки по пунктам / таблица истории).
 * ШАГ 9: вкладка «Статус задачи» — упоминания задачи в истории, версиях и документе.
 */
import './popup.css';
import { MESSAGE_TYPES, PAGE_MODES, STORAGE_KEYS } from '../lib/constants';
import { findAnalysis, idKey, urlKey } from '../lib/analysis-store';
import { activeFilters, buildHighlightPlan, filterEntries } from '../lib/filters';
import { getItem, setItem } from '../lib/storage';
import { getByPath, getSettings, normalizeSettings, resetSettings, saveSettings, setByPath } from '../lib/settings';
import { debounce, log } from '../lib/utils';

/** Признак запуска внутри расширения (а не при открытии popup.html напрямую) */
const HAS_CHROME_API = typeof chrome !== 'undefined' && Boolean(chrome.storage);

/**
 * Короткий доступ к элементу по id.
 * @param {string} id - идентификатор элемента
 * @returns {HTMLElement|null} элемент
 */
const $ = (id) => document.getElementById(id);

/** Текущие настройки (загружаются при открытии popup) */
let settings = normalizeSettings(null);

/** Вкладка, на которую вернуться из настроек */
let currentTab = 'analysis';

/** Результат анализа текущей страницы (или null) */
/** @type {import('../lib/analysis-store').Analysis|null} */
let analysis = null;

/** Последний результат подсветки (для экспорта в Word) */
let lastHighlight = null;

/** id вкладки, с которой работает popup */
let targetTabId = null;

/**
 * Переключает активную вкладку popup.
 * @param {'analysis'|'task'} tabName - имя вкладки
 * @returns {void}
 */
function switchTab(tabName) {
  try {
    currentTab = tabName;
    document.body.classList.remove('is-settings');
    $('btn-settings')?.classList.remove('is-active');
    document.querySelectorAll('.tabs__btn').forEach((btn) => {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.panel').forEach((panel) => {
      const active = panel.id === `panel-${tabName}`;
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
    });
    if (HAS_CHROME_API) setItem(STORAGE_KEYS.ACTIVE_TAB, tabName);
  } catch (err) {
    log.error('Ошибка переключения вкладки:', err);
  }
}

/**
 * Показывает экран настроек вместо вкладок.
 * @returns {void}
 */
function openSettings() {
  document.body.classList.add('is-settings');
  $('btn-settings')?.classList.add('is-active');
  document.querySelectorAll('.panel').forEach((panel) => {
    const active = panel.id === 'panel-settings';
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  renderSettings();
}

/**
 * Проставляет переключатели экрана настроек по текущим значениям.
 * @returns {void}
 */
function renderSettings() {
  document.querySelectorAll('[data-setting]').forEach((input) => {
    input.checked = Boolean(getByPath(settings, input.dataset.setting));
  });
}

/**
 * Показывает/скрывает фильтры на вкладке «Анализ» согласно настройкам.
 * Значение выключенного фильтра сбрасывается, чтобы он не участвовал в поиске.
 * @returns {void}
 */
function applyFilterVisibility() {
  document.querySelectorAll('.field[data-filter]').forEach((field) => {
    const enabled = settings.filters[field.dataset.filter] !== false;
    field.classList.toggle('is-off', !enabled);
    if (!enabled) {
      const control = field.querySelector('.field__control');
      if (control) control.value = '';
    }
  });
}

/**
 * Обрабатывает изменение переключателя в настройках и сохраняет его.
 * @param {HTMLInputElement} input - переключатель с data-setting
 * @returns {Promise<void>}
 */
async function onSettingChange(input) {
  try {
    settings = normalizeSettings(setByPath(settings, input.dataset.setting, input.checked));
    applyFilterVisibility();
    renderEntries();
    if (HAS_CHROME_API) await saveSettings(settings);
    flashSettingsStatus('Сохранено');
  } catch (err) {
    log.error('Ошибка сохранения настроек:', err);
    flashSettingsStatus('Не удалось сохранить настройки', true);
  }
}

/**
 * Кратко показывает сообщение на экране настроек.
 * @param {string} text - текст
 * @param {boolean} [isError=false] - признак ошибки
 * @returns {void}
 */
function flashSettingsStatus(text, isError = false) {
  const el = $('settings-status');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle('is-error', isError);
  el.classList.toggle('is-success', !isError);
  clearTimeout(flashSettingsStatus.timer);
  flashSettingsStatus.timer = setTimeout(() => { el.hidden = true; }, 1500);
}

/**
 * Открывает страницу инструкции в новой вкладке.
 * @returns {void}
 */
function openHelp() {
  try {
    if (HAS_CHROME_API && chrome.tabs) {
      chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
    } else {
      window.open('help.html', '_blank');
    }
  } catch (err) {
    log.error('Не удалось открыть инструкцию:', err);
  }
}

/**
 * Показывает строку статуса под кнопкой «Анализ».
 * @param {string} text - текст статуса
 * @param {'info'|'error'|'success'} [kind='info'] - тип сообщения
 * @param {string} [details=''] - вторая строка мелким шрифтом
 * @returns {void}
 */
export function setStatus(text, kind = 'info', details = '') {
  const el = $('analysis-status');
  if (!el) return;
  el.textContent = text;
  if (details) {
    const small = document.createElement('div');
    small.className = 'status__details';
    small.textContent = details;
    el.appendChild(small);
  }
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-success', kind === 'success');
}

/**
 * Включает/выключает индикатор загрузки на кнопке.
 * @param {HTMLButtonElement} btn - кнопка
 * @param {boolean} loading - состояние загрузки
 * @returns {void}
 */
export function setLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  btn.classList.toggle('is-loading', loading);
}

/* ======================== Анализ ======================== */

/**
 * Вкладка, с которой работает popup: активная вкладка окна.
 * Для автотестов можно передать ?tabId=N в адресе popup.html.
 * @returns {Promise<chrome.tabs.Tab|null>} вкладка или null
 */
async function getTargetTab() {
  try {
    const forced = Number(new URLSearchParams(location.search).get('tabId'));
    if (forced) return await chrome.tabs.get(forced);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (err) {
    log.error('Не удалось определить вкладку:', err);
    return null;
  }
}

/**
 * Форматирует дату-время анализа для статуса.
 * @param {string} iso - время в ISO
 * @returns {string} «22.10.2026, 12:40»
 */
function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/**
 * Заполняет выпадающий список вариантами (первый пункт «Все …» сохраняется).
 * @param {HTMLSelectElement} select - список
 * @param {Array<{value: string, label: string}>} options - варианты
 * @returns {void}
 */
function fillSelect(select, options) {
  if (!select) return;
  const keep = select.value;
  while (select.options.length > 1) select.remove(1);
  options.forEach(({ value, label }) => select.add(new Option(label, value)));
  if (options.some((o) => o.value === keep)) select.value = keep;
}

/**
 * Создаёт элемент списка «Записи истории».
 * @param {import('../lib/parser').HistoryEntry} entry - запись
 * @returns {HTMLLIElement} элемент списка
 */
function renderEntry(entry) {
  const li = document.createElement('li');
  li.className = 'entry';
  const color = entry.color ? `#${entry.color}` : null;

  const meta = document.createElement('div');
  meta.className = 'entry__meta';
  const swatch = document.createElement('span');
  swatch.className = 'entry__color';
  swatch.style.background = color || 'transparent';
  swatch.title = color ? `Цвет правок: ${color}` : 'Описание без цвета — правки в документе не выделены цветом';
  if (!color) swatch.classList.add('is-empty');
  meta.append(swatch, document.createTextNode(`Версия ${entry.version} · ${entry.date || '—'} · ${entry.author || '—'}`));

  const desc = document.createElement('div');
  desc.className = 'entry__desc';
  desc.textContent = entry.description || '—';
  if (color) desc.style.color = color;

  const foot = document.createElement('div');
  foot.className = 'entry__foot';
  if (entry.jiraKeys?.length) {
    const keys = document.createElement('span');
    keys.className = 'entry__issue';
    keys.textContent = entry.jiraKeys.join(', ');
    foot.appendChild(keys);
  }
  if (entry.versionUrl) {
    const link = document.createElement('a');
    link.className = 'entry__link';
    link.href = entry.versionUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = entry.pageVersion ? `версия страницы ${entry.pageVersion} ↗` : 'версия страницы ↗';
    foot.appendChild(link);
  }

  li.append(meta, desc);
  if (foot.childNodes.length) li.appendChild(foot);
  return li;
}

/**
 * Показывает результат анализа: статус, варианты фильтров, список записей.
 * @param {import('../lib/analysis-store').Analysis} data - результат анализа
 * @returns {void}
 */
function renderAnalysis(data) {
  analysis = data;
  const n = data.entries.length;
  const edit = data.mode === PAGE_MODES.EDIT_SERVER || data.mode === PAGE_MODES.EDIT_CLOUD;
  const parts = [];
  if (data.versions?.length) parts.push(`версий страницы: ${data.versions.length}`);
  else if (data.versionsError) parts.push(data.versionsError);
  if (edit) parts.push('режим редактирования');
  parts.push(formatTime(data.analyzedAt));
  setStatus(`Записей в «Истории изменений»: ${n}`, 'success', parts.join(' · '));

  fillSelect($('filter-date'), data.filterOptions.dates);
  fillSelect($('filter-author'), data.filterOptions.authors.map((a) => ({ value: a, label: a })));
  fillSelect($('filter-jira'), data.filterOptions.jiraKeys.map((k) => ({ value: k, label: k })));

  $('filters').disabled = false;
  $('btn-export').disabled = false;
  renderEntries();

  // Подсказки для вкладки «Статус задачи»: все задачи из истории
  const keys = [...new Set(data.entries.flatMap((e) => [...(e.jiraKeys || []), ...(e.reasonKeys || [])]))];
  $('task-options')?.replaceChildren(...keys.map((k) => new Option(k)));
}

/* ======================== Фильтры и подсветка ======================== */

/** Значения фильтров, как они выбраны в popup */
function readFilters() {
  return {
    date: $('filter-date')?.value || '',
    author: $('filter-author')?.value || '',
    jira: $('filter-jira')?.value || '',
  };
}

/**
 * Ключ текущей страницы для хранения фильтров.
 * @returns {string|null} ключ
 */
function pageKey() {
  return analysis ? idKey(analysis.page.pageId) || urlKey(analysis.page.url) : null;
}

/**
 * Перерисовывает список «Записи истории» по текущим фильтрам.
 * @returns {void}
 */
function renderEntries() {
  if (!analysis) return;
  const filters = activeFilters(readFilters(), settings);
  const shown = filterEntries(analysis.entries, filters);
  const total = analysis.entries.length;
  const list = $('entries-list');
  if (shown.length) {
    list.replaceChildren(...shown.map(renderEntry));
  } else {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Нет записей по выбранным фильтрам';
    list.replaceChildren(empty);
  }
  $('entries-count').textContent = shown.length === total ? String(total) : `${shown.length} из ${total}`;
}

/**
 * Показывает результат подсветки под кнопками.
 * @param {string} text - текст
 * @param {'success'|'warning'|'error'|'info'} kind - тип
 * @returns {void}
 */
function setHighlightStatus(text, kind = 'info') {
  const el = $('highlight-status');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  ['is-success', 'is-warning', 'is-error'].forEach((c) => el.classList.remove(c));
  if (kind !== 'info') el.classList.add(`is-${kind}`);
}

/**
 * Сохраняет выбранные фильтры для текущей страницы.
 * @returns {Promise<void>}
 */
async function saveFilters() {
  const key = pageKey();
  if (!key || !HAS_CHROME_API) return;
  const all = (await getItem(STORAGE_KEYS.FILTERS, {})) || {};
  all[key] = readFilters();
  await setItem(STORAGE_KEYS.FILTERS, all);
}

/**
 * Восстанавливает фильтры, выбранные на этой странице в прошлый раз.
 * @returns {Promise<void>}
 */
async function restoreFilters() {
  const key = pageKey();
  if (!key || !HAS_CHROME_API) return;
  const saved = ((await getItem(STORAGE_KEYS.FILTERS, {})) || {})[key];
  if (!saved) return;
  [['date', 'filter-date'], ['author', 'filter-author'], ['jira', 'filter-jira']].forEach(([field, id]) => {
    const select = $(id);
    if (select && [...select.options].some((o) => o.value === saved[field])) select.value = saved[field];
  });
  applyFilterVisibility();
  renderEntries();
}

/** Реакция на смену фильтра — с задержкой, чтобы не дёргать список на каждое изменение */
const onFiltersChanged = debounce(() => {
  renderEntries();
  saveFilters().catch((err) => log.warn('Не удалось сохранить фильтры:', err));
}, 250);

/**
 * Отправляет команду подсветки во вкладку через background.
 * @param {string} type - MESSAGE_TYPES.APPLY_HIGHLIGHT | CLEAR_HIGHLIGHT
 * @param {Object} [options] - параметры подсветки
 * @returns {Promise<Object>} ответ content script
 */
async function sendHighlight(type, options) {
  if (!targetTabId) targetTabId = (await getTargetTab())?.id;
  return chrome.runtime.sendMessage({ type, payload: { tabId: targetTabId, options } });
}

/**
 * Склоняет «правка» по числу.
 * @param {number} n - число
 * @returns {string} «правка» / «правки» / «правок»
 */
function pluralChanges(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'правка';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'правки';
  return 'правок';
}

/**
 * Кнопка «Подсветить»: отбирает записи, берёт их цвета и задачу, подсвечивает правки на странице.
 * @returns {Promise<void>}
 */
async function highlight() {
  if (!analysis) return;
  const btn = $('btn-highlight');
  const plan = buildHighlightPlan(analysis.entries, activeFilters(readFilters(), settings), settings);
  if (!plan.ok) {
    setHighlightStatus(plan.reason, 'warning');
    lastHighlight = null;
    await sendHighlight(MESSAGE_TYPES.CLEAR_HIGHLIGHT).catch(() => {});
    return;
  }
  setLoading(btn, true);
  setHighlightStatus('Поиск правок на странице…');
  try {
    const res = await sendHighlight(MESSAGE_TYPES.APPLY_HIGHLIGHT, plan.payload);
    if (!res?.ok) throw new Error(res?.error || 'Не удалось подсветить правки');
    lastHighlight = { ...res, entries: plan.entries, filters: readFilters() };
    if (res.count) {
      setHighlightStatus(`На странице найдено: ${res.count} ${pluralChanges(res.count)}`, 'success');
    } else {
      setHighlightStatus('Правок такого цвета на странице не найдено', 'warning');
    }
  } catch (err) {
    log.error('Ошибка подсветки:', err);
    setHighlightStatus(`Ошибка: ${err?.message || err}`, 'error');
  } finally {
    setLoading(btn, false);
  }
}

/* ======================== Экспорт в Word ======================== */

/**
 * Фильтры для шапки Word: дата — в том виде, как в документе, а не YYYY-MM-DD.
 * @returns {import('../lib/filters').FilterValues} значения для отображения
 */
function displayFilters() {
  const f = activeFilters(readFilters(), settings);
  if (f.date) f.date = $('filter-date')?.selectedOptions[0]?.textContent || f.date;
  return f;
}

/**
 * Короткое описание фильтра для имени файла.
 * @param {import('../lib/filters').FilterValues} f - значения фильтров
 * @returns {string} «PLATFORM-11717» / «Кусков» / «30 сент. 2026 г.»
 */
function filterLabel(f) {
  return [f.jira, f.author?.split(/\s+/)[0], f.date].filter(Boolean).join(' ');
}

/**
 * Показывает результат выгрузки под кнопкой «Скачать Word».
 * @param {string} text - текст
 * @param {'success'|'warning'|'error'|'info'} kind - тип
 * @returns {void}
 */
function setExportStatus(text, kind = 'info') {
  const el = $('export-status');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  ['is-success', 'is-warning', 'is-error'].forEach((c) => el.classList.remove(c));
  if (kind !== 'info') el.classList.add(`is-${kind}`);
}

/**
 * Кнопка «Скачать Word».
 *  - «Только найденные правки»: подсвечивает правки по текущим фильтрам (если ещё не подсвечены)
 *    и выгружает их по пунктам: расположение, «после текста», цветной фрагмент; в шапке — автор(ы).
 *  - «Таблица истории»: записи «Истории изменений» по текущим фильтрам.
 * @returns {Promise<void>}
 */
async function exportWord() {
  if (!analysis) return;
  const btn = $('btn-export');
  const mode = document.querySelector('input[name="export-mode"]:checked')?.value || 'changes';
  const filters = activeFilters(readFilters(), settings);
  const shown = displayFilters();
  const title = analysis.page.title || 'страница Confluence';
  setLoading(btn, true);
  setExportStatus('Формирование файла…');
  try {
    // Библиотека docx тяжёлая — загружаем её только при выгрузке, чтобы popup открывался быстро
    const { buildChangesDocument, buildHistoryDocument, downloadDocument } = await import(
      /* webpackChunkName: "exporter" */ '../lib/exporter'
    );
    let fileName;
    if (mode === 'history') {
      const entries = filterEntries(analysis.entries, filters);
      if (!entries.length) {
        setExportStatus('Нет записей по выбранным фильтрам', 'warning');
        return;
      }
      fileName = await downloadDocument(
        buildHistoryDocument({ pageTitle: title, entries, filters: shown }),
        `История изменений — ${title}`,
      );
    } else {
      const plan = buildHighlightPlan(analysis.entries, filters, settings);
      if (!plan.ok) {
        setExportStatus(plan.reason, 'warning');
        return;
      }
      // Подсвечиваем заново, если фильтры менялись после последней подсветки
      const same = lastHighlight && JSON.stringify(lastHighlight.filters) === JSON.stringify(readFilters());
      if (!same) await highlight();
      if (!lastHighlight?.count) {
        setExportStatus('На странице нет правок по выбранному фильтру — выгружать нечего', 'warning');
        return;
      }
      const res = await sendHighlight(MESSAGE_TYPES.GET_CHANGES);
      if (!res?.ok) throw new Error(res?.error || 'Не удалось получить найденные правки');
      fileName = await downloadDocument(
        buildChangesDocument({
          pageTitle: title,
          pageUrl: res.page?.url || analysis.page.url,
          filters: shown,
          entries: plan.entries,
          changes: res.changes,
        }),
        `Правки ${filterLabel(shown) || 'все'} — ${title}`,
      );
    }
    setExportStatus(`Сохранено в «Загрузки»: ${fileName}`, 'success');
  } catch (err) {
    log.error('Ошибка экспорта:', err);
    setExportStatus(`Ошибка: ${err?.message || err}`, 'error');
  } finally {
    setLoading(btn, false);
  }
}

/* ======================== Статус задачи ======================== */

/** Ключ задачи, найденной последней */
let lastTaskKey = null;

/**
 * Приводит введённый ID задачи к виду PROJ-123.
 * @param {string} value - ввод пользователя (может быть ссылкой на задачу)
 * @returns {string|null} ключ задачи или null
 */
export function normalizeTaskKey(value) {
  const v = String(value || '').trim().toUpperCase();
  const m = v.match(/(?:^|\/BROWSE\/|\/ISSUE\/)([A-Z][A-Z0-9_]+-\d+)\b/) || v.match(/^([A-Z][A-Z0-9_]+-\d+)$/);
  return m ? m[1] : null;
}

/**
 * Показывает сообщение на вкладке «Статус задачи».
 * @param {string} text - текст (пустой — скрыть)
 * @param {'info'|'warning'|'error'} [kind='info'] - тип
 * @returns {void}
 */
function setTaskStatus(text, kind = 'info') {
  const el = $('task-status');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-warning', kind === 'warning');
}

/**
 * Упоминания задачи в «Истории изменений»: в какой колонке и в какой версии.
 * @param {import('../lib/parser').HistoryEntry[]} entries - записи истории
 * @param {string} key - ключ задачи
 * @returns {Array<{entry: Object, roles: string[]}>} записи с ролями упоминания
 */
function historyMentions(entries, key) {
  const re = new RegExp(`(^|[^A-Z0-9_-])${key}(?![0-9])`);
  return entries.map((entry) => {
    const roles = [];
    if ((entry.jiraKeys || []).includes(key)) roles.push('Артефакт Jira');
    if ((entry.reasonKeys || []).includes(key)) roles.push('Причина изменения');
    if (re.test(entry.description || '')) roles.push('Описание');
    return { entry, roles };
  }).filter((m) => m.roles.length)
    // От ранних к поздним — первая запись = «впервые упомянута»
    .sort((a, b) => String(a.entry.dateISO || '').localeCompare(String(b.entry.dateISO || '')));
}

/**
 * Элемент-заголовок группы в списке упоминаний.
 * @param {string} text - заголовок
 * @returns {HTMLLIElement} элемент списка
 */
function groupTitle(text) {
  const li = document.createElement('li');
  li.className = 'group-title';
  li.textContent = text;
  return li;
}

/**
 * Элемент упоминания в списке.
 * @param {Object} p
 * @param {string|null|undefined} p.color - цвет квадратика (HEX без #); undefined — без квадратика
 * @param {string} p.meta - строка сведений
 * @param {string} p.text - основной текст
 * @param {string} [p.role] - роль (колонка истории / вид упоминания)
 * @param {boolean} [p.first] - пометка «впервые»
 * @param {string|null} [p.status] - статус задачи
 * @param {Function} [p.onClick] - действие по клику
 * @param {string|null} [p.href] - ссылка
 * @returns {HTMLLIElement} элемент списка
 */
function mentionItem({ color, meta, text, role, first, status, onClick, href }) {
  const li = document.createElement('li');
  li.className = 'entry';
  const m = document.createElement('div');
  m.className = 'entry__meta';
  // Квадратик цвета — только у записей истории (color === undefined — без квадратика)
  if (color !== undefined) {
    const sw = document.createElement('span');
    sw.className = 'entry__color';
    sw.style.background = color ? `#${color}` : 'transparent';
    if (!color) sw.classList.add('is-empty');
    m.appendChild(sw);
  }
  m.appendChild(document.createTextNode(meta));
  if (first) {
    const f = document.createElement('span');
    f.className = 'entry__first';
    f.textContent = 'впервые';
    m.appendChild(f);
  }
  const d = document.createElement('div');
  d.className = 'entry__desc';
  d.textContent = text || '—';
  if (color) d.style.color = `#${color}`;
  const foot = document.createElement('div');
  foot.className = 'entry__foot';
  if (role) {
    const r = document.createElement('span');
    r.className = 'entry__role';
    r.textContent = role;
    foot.appendChild(r);
  }
  if (status) {
    const st = document.createElement('span');
    st.className = 'lozenge';
    st.textContent = status;
    foot.appendChild(st);
  }
  if (onClick) {
    li.classList.add('is-clickable');
    li.title = 'Показать на странице';
    li.addEventListener('click', onClick);
    const a = document.createElement('span');
    a.className = 'entry__action';
    a.textContent = 'показать на странице →';
    foot.appendChild(a);
  } else if (href) {
    const a = document.createElement('a');
    a.className = 'entry__link';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'открыть ↗';
    foot.appendChild(a);
  }
  li.append(m, d);
  if (foot.childNodes.length) li.appendChild(foot);
  return li;
}

/**
 * Кнопка «Найти»: ищет упоминания задачи в истории, версиях страницы и документе.
 * @returns {Promise<void>}
 */
async function findTask() {
  const key = normalizeTaskKey($('task-id').value);
  if (!key) {
    setTaskStatus('Введите ID задачи в формате PROJ-123 (или вставьте ссылку на задачу)', 'error');
    return;
  }
  $('task-id').value = key;
  const btn = $('btn-find-task');
  setLoading(btn, true);
  setTaskStatus('Поиск упоминаний…');
  try {
    // Без анализа истории нет — запускаем его автоматически
    if (!analysis) {
      await runAnalysis();
      if (!analysis) {
        setTaskStatus($('analysis-status').textContent || 'Не удалось проанализировать страницу', 'error');
        return;
      }
    }
    const history = historyMentions(analysis.entries, key);
    const versions = (analysis.versions || []).filter((v) => (v.message || '').toUpperCase().includes(key));
    const doc = await sendHighlight(MESSAGE_TYPES.FIND_TASK, { key, autoExpand: settings.autoExpand !== false });
    if (!doc?.ok) throw new Error(doc?.error || 'Не удалось выполнить поиск в документе');
    lastTaskKey = key;
    renderTaskResults(key, history, versions, doc);
  } catch (err) {
    log.error('Ошибка поиска задачи:', err);
    setTaskStatus(`Ошибка: ${err?.message || err}`, 'error');
  } finally {
    setLoading(btn, false);
  }
}

/**
 * Показывает результат поиска задачи.
 * @param {string} key - ключ задачи
 * @param {Array<{entry: Object, roles: string[]}>} history - упоминания в истории
 * @param {import('../lib/parser').PageVersion[]} versions - версии страницы с упоминанием
 * @param {{mentions: Object[], status: string|null, href: string|null}} doc - упоминания в документе
 * @returns {void}
 */
function renderTaskResults(key, history, versions, doc) {
  const total = history.length + versions.length + doc.mentions.length;
  setTaskStatus(total ? '' : `Задача ${key} на странице не упоминается`, total ? 'info' : 'warning');

  // Карточка задачи
  $('task-card').hidden = !total;
  const keyEl = $('task-card-key');
  keyEl.textContent = key;
  if (doc.href) keyEl.href = doc.href; else keyEl.removeAttribute('href');
  const st = $('task-card-status');
  st.textContent = doc.status || 'статус не загружен';
  st.classList.toggle('is-unknown', !doc.status);
  st.title = doc.status ? 'Текущий статус из макроса Jira на странице'
    : 'Статус берётся из макроса Jira на странице. Дождитесь его загрузки в режиме просмотра.';
  const first = history.length ? history[0].entry : null;
  $('task-card-meta').textContent = [
    `История: ${history.length}`, `Версии страницы: ${versions.length}`, `Документ: ${doc.mentions.length}`,
    first ? `впервые — версия ${first.version}, ${first.date}` : null,
  ].filter(Boolean).join(' · ');

  const items = [];
  if (history.length) {
    items.push(groupTitle(`История изменений (${history.length})`));
    history.forEach(({ entry, roles }, i) => items.push(mentionItem({
      color: entry.color,
      meta: `Версия ${entry.version} · ${entry.date || '—'} · ${entry.author || '—'}`,
      text: entry.description,
      role: roles.join(', '),
      first: i === 0,
      href: entry.versionUrl,
    })));
  }
  if (versions.length) {
    items.push(groupTitle(`Версии страницы (${versions.length})`));
    versions.forEach((v) => items.push(mentionItem({
      color: undefined,
      meta: `Версия страницы ${v.number} · ${v.dateISO || '—'} · ${v.author || '—'}`,
      text: v.message,
      role: 'Комментарий к версии',
      href: v.url,
    })));
  }
  if (doc.mentions.length) {
    items.push(groupTitle(`Документ (${doc.mentions.length})`));
    const kinds = { macro: 'Макрос Jira', link: 'Ссылка', heading: 'Заголовок раздела', text: 'Текст' };
    doc.mentions.forEach((m) => items.push(mentionItem({
      color: undefined,
      meta: [...m.location.headings, m.location.container].filter(Boolean).join(' › ') || 'Документ',
      text: m.context,
      role: kinds[m.kind] || m.kind,
      status: m.status,
      onClick: () => sendHighlight(MESSAGE_TYPES.REVEAL_MENTION, { index: m.index }).catch((err) => log.warn(err)),
    })));
  }
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Упоминаний не найдено';
    items.push(empty);
  }
  $('task-results').replaceChildren(...items);
  $('task-count').textContent = String(total);
}

/**
 * Кнопка «Подсветить правки по задаче»: переходит на вкладку «Анализ» и подсвечивает
 * правки, связанные с задачей (через фильтр «Артефакт Jira», если задача есть в истории).
 * @returns {Promise<void>}
 */
async function highlightTask() {
  const key = lastTaskKey;
  if (!key || !analysis) return;
  switchTab('analysis');
  const select = $('filter-jira');
  if ([...select.options].some((o) => o.value === key)) {
    $('filter-date').value = '';
    $('filter-author').value = '';
    select.value = key;
    renderEntries();
    await saveFilters().catch(() => {});
    await highlight();
    return;
  }
  // Задачи нет в колонке «Артефакт Jira» — подсвечиваем любые цветные правки рядом с ней
  const knownKeys = [...new Set([key, ...analysis.entries.flatMap((e) => [...(e.jiraKeys || []), ...(e.reasonKeys || [])])])];
  setHighlightStatus('Поиск правок на странице…');
  const res = await sendHighlight(MESSAGE_TYPES.APPLY_HIGHLIGHT, {
    colors: null, issueKey: key, knownKeys, autoExpand: settings.autoExpand !== false, showCounter: settings.showCounter !== false,
  });
  setHighlightStatus(res?.ok && res.count ? `Правки рядом с ${key}: ${res.count}` : `Цветных правок рядом с ${key} не найдено`, res?.count ? 'success' : 'warning');
}

/**
 * Кнопка «Сбросить»: очищает фильтры и убирает подсветку со страницы.
 * @returns {Promise<void>}
 */
async function resetFilters() {
  ['filter-date', 'filter-author', 'filter-jira'].forEach((id) => { if ($(id)) $(id).value = ''; });
  renderEntries();
  setHighlightStatus('');
  lastHighlight = null;
  await saveFilters().catch(() => {});
  await sendHighlight(MESSAGE_TYPES.CLEAR_HIGHLIGHT).catch((err) => log.warn('Не удалось снять подсветку:', err));
}

/**
 * Обработчик кнопки «Анализ»: запускает анализ активной вкладки через background.
 * @returns {Promise<void>}
 */
async function runAnalysis() {
  const btn = $('btn-analyze');
  setLoading(btn, true);
  setStatus('Анализ страницы…');
  try {
    const tab = await getTargetTab();
    if (!tab) throw new Error('Не найдена активная вкладка');
    targetTabId = tab.id;
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RUN_ANALYSIS, payload: { tabId: tab.id } });
    if (!res?.ok) {
      setStatus(res?.error || 'Не удалось выполнить анализ', 'error');
      return;
    }
    renderAnalysis(res.analysis);
    await restoreFilters();
  } catch (err) {
    log.error('Ошибка анализа:', err);
    setStatus(`Ошибка: ${err?.message || err}`, 'error');
  } finally {
    setLoading(btn, false);
  }
}

/**
 * Восстанавливает результат прошлого анализа для страницы в активной вкладке.
 * @returns {Promise<void>}
 */
async function restoreAnalysis() {
  try {
    const tab = await getTargetTab();
    if (!tab?.url) return;
    let saved = await findAnalysis({ url: tab.url });
    if (!saved) {
      // Адрес мог смениться (просмотр ↔ редактирование) — спрашиваем id страницы у content script
      const pong = await chrome.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.PING }).catch(() => null);
      if (pong?.pageId) saved = await findAnalysis({ pageId: pong.pageId });
    }
    if (saved) {
      renderAnalysis(saved);
      await restoreFilters();
    }
  } catch (err) {
    log.warn('Не удалось восстановить анализ:', err);
  }
}

/**
 * Навешивает обработчики на элементы popup.
 * @returns {void}
 */
function bindEvents() {
  document.querySelectorAll('.tabs__btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('btn-settings')?.addEventListener('click', () => {
    if (document.body.classList.contains('is-settings')) switchTab(currentTab);
    else openSettings();
  });
  $('btn-settings-back')?.addEventListener('click', () => switchTab(currentTab));
  $('btn-help')?.addEventListener('click', openHelp);
  document.querySelectorAll('[data-setting]').forEach((input) => {
    input.addEventListener('change', () => onSettingChange(input));
  });
  $('btn-settings-reset')?.addEventListener('click', async () => {
    settings = HAS_CHROME_API ? await resetSettings() : normalizeSettings(null);
    renderSettings();
    applyFilterVisibility();
    renderEntries();
    flashSettingsStatus('Настройки сброшены');
  });

  $('btn-analyze')?.addEventListener('click', runAnalysis);

  $('btn-highlight')?.addEventListener('click', highlight);
  $('btn-clear')?.addEventListener('click', resetFilters);
  ['filter-date', 'filter-author', 'filter-jira'].forEach((id) => $(id)?.addEventListener('change', onFiltersChanged));
  $('btn-export')?.addEventListener('click', exportWord);

  $('btn-find-task')?.addEventListener('click', findTask);
  $('btn-task-highlight')?.addEventListener('click', highlightTask);
  $('task-id')?.addEventListener('input', () => { $('task-status').hidden = true; });
  $('task-id')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-find-task')?.click();
  });
}

/**
 * Инициализация popup: восстановление вкладки и привязка событий.
 * @returns {Promise<void>}
 */
async function init() {
  try {
    bindEvents();
    if (HAS_CHROME_API) settings = await getSettings();
    applyFilterVisibility();
    const savedTab = HAS_CHROME_API ? await getItem(STORAGE_KEYS.ACTIVE_TAB, 'analysis') : 'analysis';
    switchTab(savedTab === 'task' ? 'task' : 'analysis');
    if (HAS_CHROME_API) await restoreAnalysis();
    log.info('Popup открыт');
  } catch (err) {
    log.error('Ошибка инициализации popup:', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
