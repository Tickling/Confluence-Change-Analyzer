/**
 * Загрузка системной истории версий страницы через REST API Confluence.
 * Запрос выполняется из content script — к тому же серверу Confluence, на котором
 * открыта страница, с сессией пользователя. Никуда наружу данные не уходят.
 *
 * Порядок попыток:
 *  - /rest/experimental/content/{id}/version — Server / DC 6.x+;
 *  - /rest/api/content/{id}/version — Cloud и новые версии DC.
 */
import { parseVersionsResponse } from '../lib/parser';
import { log } from '../lib/utils';

/** Максимум страниц ответа (по 200 версий) */
const MAX_PAGES = 10;

/** Таймаут одного запроса, мс */
const REQUEST_TIMEOUT = 8000;

/**
 * Базовый адрес API на том же origin, что и открытая страница
 * (meta confluence-base-url может указывать на другой хост за прокси).
 * @param {string|null} baseUrl - базовый адрес из сведений о странице
 * @returns {string} базовый адрес на текущем origin
 */
function sameOriginBase(baseUrl) {
  try {
    const path = baseUrl ? new URL(baseUrl, location.origin).pathname.replace(/\/$/, '') : '';
    return `${location.origin}${path}`;
  } catch {
    return location.origin;
  }
}

/**
 * GET-запрос JSON с таймаутом.
 * @param {string} url - адрес
 * @returns {Promise<Object>} ответ
 */
async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Загружает все версии страницы (с постраничной догрузкой).
 * @param {import('./page-context').PageInfo} page - сведения о странице
 * @returns {Promise<{versions: import('../lib/parser').PageVersion[], error: string|null}>} версии или причина ошибки
 */
export async function fetchPageVersions(page) {
  if (!page?.pageId) return { versions: [], error: 'Не удалось определить id страницы' };
  const base = sameOriginBase(page.baseUrl);
  const endpoints = [
    `${base}/rest/experimental/content/${page.pageId}/version`,
    `${base}/rest/api/content/${page.pageId}/version`,
  ];
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const results = [];
      let url = `${endpoint}?limit=200`;
      for (let i = 0; url && i < MAX_PAGES; i += 1) {
        const json = await getJson(url);
        results.push(...(json.results || []));
        // Cloud отдаёт относительную ссылку на следующую порцию — от базового адреса (с /wiki)
        const next = json._links?.next;
        const apiBase = json._links?.base ? sameOriginBase(json._links.base) : base;
        url = next ? (/^https?:/.test(next) ? next : `${apiBase}${next}`) : null;
      }
      const versions = parseVersionsResponse({ results }, { baseUrl: page.baseUrl, pageId: page.pageId });
      log.info(`Загружено версий страницы: ${versions.length}`);
      return { versions, error: null };
    } catch (err) {
      lastError = err;
      log.warn('Не удалось получить версии:', endpoint, err?.message || err);
    }
  }
  return { versions: [], error: `История версий недоступна (${lastError?.message || 'ошибка'})` };
}

/**
 * Проставляет записям «Истории изменений» ссылку на версию страницы
 * той же даты (если версий в этот день несколько — последнюю за день).
 * @param {import('../lib/parser').HistoryEntry[]} entries - записи истории
 * @param {import('../lib/parser').PageVersion[]} versions - версии страницы
 * @returns {import('../lib/parser').HistoryEntry[]} записи со ссылками
 */
export function linkEntriesToVersions(entries, versions) {
  return entries.map((e) => {
    if (!e.dateISO) return e;
    const sameDay = versions.filter((v) => v.dateISO === e.dateISO);
    if (!sameDay.length) return e;
    // Если автор версии совпадает (по фамилии) — берём её, иначе последнюю за день
    const surname = e.author.split(/\s+/)[0]?.toLowerCase();
    const byAuthor = sameDay.find((v) => surname && v.author.toLowerCase().includes(surname));
    const v = byAuthor || sameDay[0];
    return { ...e, versionUrl: v.url, pageVersion: v.number };
  });
}
