/**
 * Общие константы расширения "Confluence Change Analyzer".
 * Используются в popup, background и content script.
 */

/** Префикс для всех логов в консоли */
export const LOG_PREFIX = '[CFA]';

/** Ключи chrome.storage.local */
export const STORAGE_KEYS = {
  /** Результаты анализа по страницам: { [ключ страницы]: Analysis } */
  ANALYSIS: 'cfa_analysis',
  /** Последние выбранные фильтры по страницам: { [ключ страницы]: FilterValues } */
  FILTERS: 'cfa_filters',
  /** Активная вкладка popup */
  ACTIVE_TAB: 'cfa_active_tab',
  /** Пользовательские настройки (шестерёнка в popup) */
  SETTINGS: 'cfa_settings',
};

/**
 * Типы сообщений между popup ↔ background ↔ content script.
 * Используются в chrome.runtime.sendMessage / chrome.tabs.sendMessage.
 */
export const MESSAGE_TYPES = {
  RUN_ANALYSIS: 'CFA_RUN_ANALYSIS',
  ANALYSIS_DONE: 'CFA_ANALYSIS_DONE',
  PARSE_HISTORY: 'CFA_PARSE_HISTORY',
  APPLY_HIGHLIGHT: 'CFA_APPLY_HIGHLIGHT',
  CLEAR_HIGHLIGHT: 'CFA_CLEAR_HIGHLIGHT',
  FIND_TASK: 'CFA_FIND_TASK',
  FETCH_VERSIONS: 'CFA_FETCH_VERSIONS',
  GET_CHANGES: 'CFA_GET_CHANGES',
  PING: 'CFA_PING',
};

/**
 * Фильтры popup — соответствуют колонкам таблицы
 * «История изменений» в документе Confluence.
 * Режим комбинирования — AND.
 */
export const FILTER_FIELDS = {
  DATE: 'date', // Дата изменения
  AUTHOR: 'author', // Автор
  JIRA: 'jira', // Артефакт Jira
};

/**
 * Настройки по умолчанию.
 * Фильтр «Артефакт Jira» отключить нельзя — он всегда true.
 */
export const DEFAULT_SETTINGS = {
  filters: {
    date: true,
    author: true,
    jira: true,
  },
  /** Раскрывать свёрнутые блоки перед поиском (шаг 7) */
  autoExpand: true,
  /** Показывать на странице плавающий счётчик «Найдено N совпадений» */
  showCounter: true,
};

/**
 * Варианты заголовков колонок таблицы «История изменений»
 * (рус./англ., Server и Cloud). Сравнение — без учёта регистра и пробелов.
 */
export const HISTORY_COLUMN_ALIASES = {
  version: ['№', '#', 'n', 'версия', 'version'],
  date: ['дата изменения', 'дата', 'date'],
  reason: ['причина изменения', 'причина', 'reason'],
  description: ['описание', 'описание изменения', 'description'],
  author: ['автор', 'author'],
  review: ['ревью', 'review'],
  jira: ['артефакт jira', 'jira', 'задача', 'issue'],
};

/** Заголовки раздела с таблицей истории изменений */
export const HISTORY_HEADING_PATTERNS = [/история\s+изменений/i, /change\s+history/i];

/** Ключ задачи вида PROJ-123 (Jira / YouTrack) */
export const ISSUE_KEY_REGEX = /\b[A-Z][A-Z0-9_]+-\d+\b/g;

/** Паттерны URL трекеров задач */
export const ISSUE_URL_PATTERNS = [
  /\/browse\/[A-Z][A-Z0-9_]+-\d+/i, // Jira
  /\/issue\/[A-Z][A-Z0-9_]+-\d+/i, // YouTrack
  /\/issues\/\d+/i, // Redmine / GitLab
];

/**
 * Селекторы элементов, раскрывающих свёрнутые секции
 * (Confluence Server 6.x+ и Cloud).
 */
export const EXPANDER_SELECTORS = [
  '.expand-control',
  '.aui-expander-trigger',
  '[aria-expanded="false"][data-testid*="expand"]',
  'button[aria-expanded="false"][data-testid*="expand"]',
  'details:not([open]) > summary',
  // Cloud-редактор: макрос Expand в режиме редактирования
  '[data-node-type="expand"] button[aria-expanded="false"]',
  '[data-node-type="nestedExpand"] button[aria-expanded="false"]',
];

/** CSS-класс обёртки подсвеченного блока */
export const HIGHLIGHT_CLASS = 'cfa-highlight';

/**
 * Правила подсветки (выполняются только локально в браузере пользователя:
 * меняется лишь DOM открытой вкладки, сама страница Confluence не изменяется).
 *
 *  - Фильтр «Артефакт Jira»: обводятся блоки, рядом с которыми есть
 *    ссылка/упоминание выбранной задачи (например, PLATFORM-11717).
 *  - Фильтры «Дата изменения» / «Автор»: выбирают строку(и) таблицы
 *    «История изменений»; берётся цвет, которым написано описание этих строк,
 *    и обводятся все блоки документа, написанные этим цветом
 *    (правки в документе вносятся тем же цветом, что и описание в истории).
 */
export const HIGHLIGHT_MATCH = {
  BY_ISSUE: 'issue', // по ключу задачи
  BY_COLOR: 'color', // по цвету описания изменения
};

/**
 * Режимы страницы Confluence.
 * В режиме редактирования DOM документа менять НЕЛЬЗЯ (изменения попадут
 * в сохранённую страницу), поэтому подсветка рисуется отдельным слоем поверх
 * текста (overlay), а уход со страницы запрещён (потеря несохранённых правок).
 */
export const PAGE_MODES = {
  VIEW: 'view', // просмотр (Server и Cloud)
  EDIT_SERVER: 'edit-server', // редактор TinyMCE в iframe (Server / Data Center)
  EDIT_CLOUD: 'edit-cloud', // редактор ProseMirror (Cloud)
  UNKNOWN: 'unknown',
};

/** Способ подсветки: обёртка div.cfa-highlight (просмотр) или слой поверх (редактирование) */
export const HIGHLIGHT_STRATEGY = {
  WRAP: 'wrap',
  OVERLAY: 'overlay',
};

/** Селекторы области содержимого документа в режиме просмотра */
export const VIEW_CONTENT_SELECTORS = [
  '#main-content', // Server / DC
  '.wiki-content',
  '[data-testid="pageContentRendererTestId"]', // Cloud
  '.ak-renderer-document', // Cloud renderer
];

/** Селекторы редакторов */
export const EDITOR_SELECTORS = {
  /** Server / DC: iframe TinyMCE и тело документа внутри него */
  serverIframe: '#wysiwygTextarea_ifr, iframe.wysiwyg-editor, iframe[id$="_ifr"]',
  serverBody: 'body#tinymce, body.mce-content-body',
  /** Cloud: редактор ProseMirror */
  cloudEditor: '.ProseMirror[contenteditable="true"], #ak-editor-textarea',
};

/** URL страниц редактирования (подсказка, пока редактор ещё не загрузился) */
export const EDIT_URL_PATTERNS = [
  /\/pages\/(editpage|createpage|resumedraft)\.action/i, // Server / DC
  /\/pages\/edit-v2\//i, // Cloud
  /\/pages\/edit\//i,
  /\/pages\/create\b/i,
];
