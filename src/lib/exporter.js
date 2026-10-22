/**
 * Экспорт в Word (.docx) через библиотеку docx.
 *
 * Режимы экспорта:
 *  1. «Найденные правки» — только фрагменты документа, найденные по фильтру
 *     (по задаче Jira и/или по цвету описания). Каждая правка — отдельный пункт:
 *       • где находится в документе (раздел › подраздел, «после текста …»);
 *       • сам фрагмент с сохранением исходного цвета.
 *  2. «Таблица истории» — таблица записей «Истории изменений»
 *     (Дата | Автор | Версия | Описание | Цвет | Задача | Ссылка на версию).
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { colorToHex, log, safeFileName } from './utils';

/**
 * @typedef {Object} ChangeRun
 * @property {string} text - текст
 * @property {string|null} [color] - CSS-цвет текста
 * @property {string|null} [backgroundColor] - CSS-цвет фона
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [strike] - зачёркнутый (удалённый) текст
 * @property {string|null} [href] - ссылка (если фрагмент — ссылка)
 */

/**
 * @typedef {Object} ChangeLocation
 * @property {string[]} headings - цепочка заголовков, внутри которых найден фрагмент
 *   (например, ["Вариант использования", "Описание алгоритма"])
 * @property {string|null} [container] - уточнение места: «Таблица, строка 8», «Шаг 8» и т.п.
 * @property {string|null} [before] - текст, после которого стоит фрагмент (обрезанный)
 */

/**
 * @typedef {Object} FoundChange
 * @property {number} index - порядковый номер на странице
 * @property {ChangeLocation} location - где в документе находится фрагмент
 * @property {ChangeRun[][]} paragraphs - фрагмент: абзацы, каждый — массив отрезков текста
 * @property {string|null} color - основной цвет фрагмента (по нему найден)
 * @property {string[]} issueKeys - задачи, упомянутые рядом
 */

/**
 * @typedef {Object} ExportFilters
 * @property {string} [date]
 * @property {string} [author]
 * @property {string} [jira]
 */

const FONT = 'Calibri';
const MUTED = '6B778C';

/**
 * Формирует строку с описанием применённых фильтров.
 * @param {ExportFilters} filters - фильтры
 * @returns {string} текст вида «Артефакт Jira: PLATFORM-11717; Автор: …»
 */
function describeFilters(filters = {}) {
  const parts = [];
  if (filters.date) parts.push(`Дата изменения: ${filters.date}`);
  if (filters.author) parts.push(`Автор: ${filters.author}`);
  if (filters.jira) parts.push(`Артефакт Jira: ${filters.jira}`);
  return parts.length ? parts.join('; ') : 'без фильтров';
}

/**
 * Строит абзац «Метка: значение» с приглушённой меткой.
 * @param {string} label - метка
 * @param {string} value - значение
 * @param {Object} [opts] - доп. параметры для значения (italics и т.п.)
 * @returns {Paragraph} абзац
 */
function labeledParagraph(label, value, opts = {}) {
  return new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, color: MUTED, font: FONT }),
      new TextRun({ text: value, font: FONT, ...opts }),
    ],
  });
}

/**
 * Превращает отрезок фрагмента в TextRun (или гиперссылку) с сохранением цвета.
 * @param {ChangeRun} run - отрезок
 * @returns {TextRun|ExternalHyperlink} элемент docx
 */
function toDocxRun(run) {
  const color = colorToHex(run.color);
  const bg = colorToHex(run.backgroundColor);
  const textRun = new TextRun({
    text: run.text,
    font: FONT,
    bold: Boolean(run.bold),
    italics: Boolean(run.italic),
    strike: Boolean(run.strike),
    color: color || undefined,
    underline: run.href ? {} : undefined,
    shading: bg && bg !== 'FFFFFF' ? { type: ShadingType.CLEAR, color: 'auto', fill: bg } : undefined,
  });
  return run.href ? new ExternalHyperlink({ link: run.href, children: [textRun] }) : textRun;
}

/**
 * Строит блок одного пункта «Найденные правки»:
 * заголовок «Пункт N», расположение, «после текста», затем сам цветной фрагмент
 * в рамке слева цвета правки.
 * @param {FoundChange} change - найденная правка
 * @param {number} n - номер пункта
 * @returns {Paragraph[]} абзацы пункта
 */
function buildChangeBlock(change, n) {
  const out = [];
  const loc = change.location || {};
  const accent = colorToHex(change.color) || 'DE350B';

  out.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 80 },
    children: [new TextRun({ text: `Пункт ${n}`, font: FONT })],
  }));

  const path = [...(loc.headings || []), loc.container].filter(Boolean).join(' › ');
  out.push(labeledParagraph('Расположение', path || 'не определено'));
  if (loc.before) out.push(labeledParagraph('После текста', `«${loc.before}»`, { italics: true }));
  if (change.issueKeys?.length) out.push(labeledParagraph('Задача', change.issueKeys.join(', ')));

  out.push(new Paragraph({
    spacing: { before: 80, after: 40 },
    children: [new TextRun({ text: 'Изменение:', bold: true, color: MUTED, font: FONT })],
  }));

  // Сам фрагмент: каждый абзац — с цветной полосой слева, как цитата
  (change.paragraphs || []).forEach((runs) => {
    out.push(new Paragraph({
      indent: { left: 240 },
      spacing: { after: 60 },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: accent, space: 8 } },
      children: runs.filter((r) => r.text).map(toDocxRun),
    }));
  });
  return out;
}

/**
 * Строит в шапке блок «Изменение» по записи таблицы «История изменений»:
 * автор, дата, версия, задачи и описание тем же цветом, что и в истории.
 * @param {import('./parser').HistoryEntry} entry - запись истории
 * @param {boolean} numbered - выводить ли номер версии в подзаголовке (если записей несколько)
 * @returns {Paragraph[]} абзацы блока
 */
function buildEntryHeader(entry, numbered) {
  const out = [];
  if (numbered) {
    out.push(new Paragraph({
      spacing: { before: 120, after: 40 },
      children: [new TextRun({ text: `Версия ${entry.version ?? ''}`, bold: true, font: FONT })],
    }));
  }
  out.push(labeledParagraph('Автор', entry.author || '—'));
  out.push(labeledParagraph('Дата изменения', entry.date || '—'));
  if (entry.jiraKeys?.length) out.push(labeledParagraph('Артефакт Jira', entry.jiraKeys.join(', ')));
  out.push(new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: 'Описание: ', bold: true, color: MUTED, font: FONT }),
      new TextRun({ text: entry.description || '—', font: FONT, color: colorToHex(entry.color) || undefined }),
    ],
  }));
  return out;
}

/**
 * Создаёт документ Word «Найденные правки».
 * Шапка: страница, фильтр, автор/дата/описание изменения (из «Истории изменений»),
 * затем пункты — где правка в документе и сам цветной фрагмент.
 * @param {Object} params
 * @param {string} params.pageTitle - название страницы Confluence
 * @param {string} params.pageUrl - адрес страницы
 * @param {ExportFilters} params.filters - применённые фильтры
 * @param {import('./parser').HistoryEntry[]} [params.entries] - записи истории, попавшие под фильтр
 * @param {FoundChange[]} params.changes - найденные правки
 * @returns {Document} документ docx
 */
export function buildChangesDocument({ pageTitle, pageUrl, filters, entries = [], changes }) {
  const children = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 120 },
      children: [new TextRun({ text: `Изменения: ${pageTitle || 'страница Confluence'}`, font: FONT })],
    }),
    labeledParagraph('Страница', pageUrl || '—'),
    labeledParagraph('Фильтр', describeFilters(filters)),
  ];

  // Сведения об изменении из таблицы «История изменений»
  if (entries.length) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 80 },
      children: [new TextRun({ text: entries.length > 1 ? 'Изменения' : 'Изменение', font: FONT })],
    }));
    entries.forEach((entry) => children.push(...buildEntryHeader(entry, entries.length > 1)));
  }

  children.push(
    labeledParagraph('Найдено пунктов', String(changes.length)),
    labeledParagraph('Дата выгрузки', new Date().toLocaleString('ru-RU')),
  );

  if (!changes.length) {
    children.push(new Paragraph({
      spacing: { before: 240 },
      children: [new TextRun({ text: 'По выбранному фильтру правок не найдено.', italics: true, font: FONT })],
    }));
  }
  changes.forEach((change, i) => children.push(...buildChangeBlock(change, i + 1)));

  return new Document({
    // Автор(ы) изменения — также в свойствах файла Word
    creator: [...new Set(entries.map((e) => e.author).filter(Boolean))].join(', ') || 'Confluence Change Analyzer',
    title: `Изменения: ${pageTitle || ''}`,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ children }],
  });
}

/**
 * Ячейка таблицы истории.
 * @param {string|Paragraph[]} content - текст или готовые абзацы
 * @param {Object} [opts] - bold / fill
 * @returns {TableCell} ячейка
 */
function cell(content, opts = {}) {
  const children = Array.isArray(content)
    ? content
    : [new Paragraph({ children: [new TextRun({ text: content || '', bold: opts.bold, font: FONT, size: 20 })] })];
  return new TableCell({
    children,
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined,
  });
}

/**
 * Создаёт документ Word «Таблица истории изменений».
 * @param {Object} params
 * @param {string} params.pageTitle - название страницы
 * @param {import('./parser').HistoryEntry[]} params.entries - записи истории
 * @param {ExportFilters} params.filters - применённые фильтры
 * @returns {Document} документ docx
 */
export function buildHistoryDocument({ pageTitle, entries, filters }) {
  const header = ['Дата', 'Автор', 'Версия', 'Описание', 'Цвет', 'Задача', 'Ссылка на версию'];
  const rows = [
    new TableRow({ tableHeader: true, children: header.map((h) => cell(h, { bold: true, fill: 'F4F5F7' })) }),
    ...entries.map((e) => {
      const color = colorToHex(e.color);
      return new TableRow({
        children: [
          cell(e.date),
          cell(e.author),
          cell(String(e.version ?? '')),
          cell([new Paragraph({ children: [new TextRun({ text: e.description || '', color: color || undefined, font: FONT, size: 20 })] })]),
          cell(color ? `#${color}` : '—', { fill: color || undefined }),
          cell((e.jiraKeys || []).join(', ')),
          cell(e.versionUrl
            ? [new Paragraph({ children: [new ExternalHyperlink({ link: e.versionUrl, children: [new TextRun({ text: 'Открыть', style: 'Hyperlink', font: FONT, size: 20 })] })] })]
            : '—'),
        ],
      });
    }),
  ];

  return new Document({
    creator: 'Confluence Change Analyzer',
    title: `История изменений: ${pageTitle || ''}`,
    sections: [{
      properties: { page: { size: { orientation: 'landscape' } } },
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `История изменений: ${pageTitle || ''}`, font: FONT })] }),
        labeledParagraph('Фильтр', describeFilters(filters)),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows, alignment: AlignmentType.CENTER }),
      ],
    }],
  });
}

/**
 * Транслитерация кириллицы и замена прочих не-ASCII символов (для запасного имени файла).
 * @param {string} text - текст
 * @returns {string} текст латиницей
 */
function transliterate(text) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return String(text || '').split('').map((ch) => {
    const low = ch.toLowerCase();
    if (map[low] !== undefined) return ch === low ? map[low] : map[low].charAt(0).toUpperCase() + map[low].slice(1);
    return /[\x20-\x7e]/.test(ch) ? ch : '-';
  }).join('');
}

/** MIME-тип .docx */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Упаковывает документ и скачивает его как .docx.
 *
 * В расширении используется chrome.downloads с data:-ссылкой: blob:-ссылка
 * перестаёт работать, если popup закроется до окончания скачивания.
 * Файл сохраняется сразу в папку «Загрузки» (без диалога, который закрыл бы popup).
 * @param {Document} doc - документ docx
 * @param {string} fileName - имя файла без расширения
 * @returns {Promise<string>} итоговое имя файла
 */
export async function downloadDocument(doc, fileName) {
  const name = `${safeFileName(fileName)}.docx`;
  try {
    if (typeof chrome !== 'undefined' && chrome.downloads) {
      const base64 = await Packer.toBase64String(doc);
      const url = `data:${DOCX_MIME};base64,${base64}`;
      try {
        await chrome.downloads.download({ url, filename: name, saveAs: false, conflictAction: 'uniquify' });
      } catch (err) {
        // В некоторых окружениях (Linux без UTF-8 локали) Chrome отклоняет кириллицу в имени —
        // сохраняем под именем латиницей
        if (!/filename/i.test(String(err?.message))) throw err;
        const ascii = `${safeFileName(transliterate(fileName))}.docx`;
        log.warn('Имя файла отклонено, сохраняем как:', ascii);
        await chrome.downloads.download({ url, filename: ascii, saveAs: false, conflictAction: 'uniquify' });
        return ascii;
      }
    } else {
      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    log.info('Word-файл сформирован:', name);
    return name;
  } catch (err) {
    log.error('Ошибка экспорта в Word:', err);
    throw err;
  }
}
