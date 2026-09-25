/*!
 * inline.js v8 — точный скриншот страницы или элемента.
 *
 * Два движка:
 *   • Пиксели вкладки (по умолчанию) — как «Capture node screenshot» в DevTools: берёт готовое
 *     изображение вкладки (getDisplayMedia) и вырезает экран, элемент или всю страницу
 *     (склейкой при прокрутке). Видит всё: картинки с любых сайтов, чужие iframe, видео,
 *     WebGL, закрытый Shadow DOM. Браузер спросит разрешение — выберите эту вкладку.
 *   • DOM-рендер (если разрешения нет) — копия страницы с вычисленными стилями, встроенными
 *     картинками и шрифтами, через SVG <foreignObject>; раскладка сверяется с оригиналом.
 *
 * Использование:
 *   1) Вставить в консоль — сразу скачает скриншот того, что видно на экране.
 *   2) <script src="inline.js" data-manual></script>, затем:
 *        await htmlShot.download();                               // видимая область
 *        await htmlShot.download({ fullPage: true });             // вся страница целиком
 *        await htmlShot.download({ target: document.querySelector('#app') });  // элемент
 *        const canvas = await htmlShot.captureNode('#chart');     // элемент → canvas
 *        const blob   = await htmlShot.toBlob({ type: 'image/jpeg', quality: 0.9 });
 *   Настройки до вставки в консоль: window.HTML_SHOT_CONFIG = { fullPage: true, ... }
 *     method: 'auto' | 'pixel' | 'dom'   — 'dom' снимает без разрешений браузера
 *     keepStream: true                   — спросить разрешение один раз на несколько снимков
 *                                          (закрыть захват: htmlShot.stop())
 *   Элементы с атрибутом data-html-shot-ignore не попадают в DOM-снимок.
 */
(function (global) {
  'use strict';

  const currentScript = document.currentScript;
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';

  const DEFAULTS = {
    target: null,             // элемент; по умолчанию вся страница
    fullPage: false,          // false — только то, что видно на экране; true — вся страница
    scale: global.devicePixelRatio || 1,
    backgroundColor: null,    // null — взять фон страницы
    type: 'image/png',
    quality: 0.95,
    filename: null,           // null — «сайт_2026-09-25_14-30-12.png»
    embedFonts: true,
    timeout: 15000,           // таймаут загрузки одного ресурса, мс
    corsProxy: null,          // 'https://my-proxy/?url=' | 'https://p/?u={url}' | (url) => proxiedUrl
    concurrency: 6,           // одновременных загрузок ресурсов
    placeholder: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', // прозрачный пиксель
    filter: null,             // (element) => false, чтобы исключить элемент
    frameBudget: 12,          // мс непрерывной работы, после которых отдаём управление браузеру
    lazyImages: true,         // догрузить loading="lazy" картинки до снимка
    freezeAnimations: true,   // пауза анимаций на время обхода
    contentVisibility: true,  // раскрыть content-visibility:auto на время снимка
    jsFonts: true,            // встраивать шрифты, добавленные через FontFace API
    fallbackHtml2canvas: true,// если SVG-рендер не удался и на странице есть window.html2canvas
    method: 'auto',           // 'auto' — пиксели вкладки (как «Capture node screenshot» в DevTools),
                              //   а если браузер не дал разрешения — DOM-рендер; 'pixel' — только пиксели; 'dom' — без разрешений
    keepStream: false,        // не закрывать захват вкладки между снимками: разрешение спросят один раз (htmlShot.stop())
    lockLayout: true,         // сверить копию с оригиналом и поставить съехавшие элементы на место
    ui: true,                 // всплывающие уведомления при download()
  };

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'head', 'title', 'base', 'object', 'embed', 'track']);
  const NO_CHILDREN = new Set(['img', 'canvas', 'video', 'audio', 'iframe', 'input', 'textarea']);
  const SKIP_PROPS = /^(--|transition|animation|cursor|pointer-events|will-change|user-select|-webkit-user-select|caret-color|content-visibility|contain-intrinsic|view-transition)/;
  // Свойства, у которых вычисленное значение зависит от другого: border-style:solid без
  // явной ширины даёт medium (3px). Поэтому ширину переносим всегда вместе со стилем.
  const DEPENDENT_STYLE = /^(border(-[a-z]+)*|outline|column-rule)-style$/;
  const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  /* ---------------- отдаём управление браузеру ---------------- */

  function yieldToBrowser() {
    return new Promise((r) => setTimeout(r, 0));
  }

  async function breathe(ctx) {
    if (performance.now() - ctx.lastYield > ctx.opts.frameBudget) {
      await yieldToBrowser();
      ctx.lastYield = performance.now();
    }
  }

  /* ---------------- ресурсы ---------------- */

  const resourceCache = new Map();   // absUrl -> Promise<dataURL|null>
  const textCache = new Map();       // absUrl -> Promise<string|null>
  const failed = new Map();          // absUrl -> тип ('image' | 'font' | 'css' | 'svg')
  let queue = [], active = 0, concurrency = 6;

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => { active--; pump(); });
    }
  }
  function enqueue(fn) {
    return new Promise((resolve) => {
      queue.push(() => fn().then(resolve, () => resolve(null)));
      pump();
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function absolute(url, base) {
    try { return new URL(url, base || document.baseURI).href; } catch (_) { return null; }
  }

  function proxied(url, proxy) {
    if (typeof proxy === 'function') return proxy(url);
    if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(url));
    return proxy + encodeURIComponent(url);
  }

  async function fetchOnce(url, init, timeout) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal }, init));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.blob();
    } finally { clearTimeout(t); }
  }

  // Свой сайт — с куками. Чужой — CORS-запрос; при неудаче повтор в обход кэша
  // (частый случай: <img> закэшировал ответ без Access-Control-Allow-Origin); затем прокси.
  async function fetchBlob(abs, opts) {
    if (/^(data|blob):/i.test(abs)) return fetchOnce(abs, {}, opts.timeout);
    let sameOrigin = false;
    try { sameOrigin = new URL(abs).origin === location.origin; } catch (_) {}
    if (sameOrigin) return fetchOnce(abs, { credentials: 'include' }, opts.timeout);
    try { return await fetchOnce(abs, { mode: 'cors', credentials: 'omit' }, opts.timeout); } catch (_) {}
    try { return await fetchOnce(abs, { mode: 'cors', credentials: 'omit', cache: 'reload' }, opts.timeout); } catch (e) {
      if (!opts.corsProxy) throw e;
    }
    return fetchOnce(proxied(abs, opts.corsProxy), { mode: 'cors', credentials: 'omit' }, opts.timeout);
  }

  function toDataURL(url, opts, kind = 'image') {
    if (!url) return Promise.resolve(null);
    if (url.startsWith('data:')) return Promise.resolve(url);
    const abs = absolute(url);
    if (!abs) return Promise.resolve(null);
    if (resourceCache.has(abs)) return resourceCache.get(abs);
    const p = enqueue(() => fetchBlob(abs, opts).then(blobToDataURL)).then((d) => {
      if (!d) { failed.set(abs, kind); resourceCache.delete(abs); } // в следующий раз попробуем снова
      return d;
    });
    resourceCache.set(abs, p);
    return p;
  }

  function fetchText(url, opts, kind = 'css') {
    const abs = absolute(url);
    if (!abs) return Promise.resolve(null);
    if (textCache.has(abs)) return textCache.get(abs);
    const p = enqueue(() => fetchBlob(abs, opts).then((b) => b.text())).then((t) => {
      if (t == null) { failed.set(abs, kind); textCache.delete(abs); }
      return t;
    });
    textCache.set(abs, p);
    return p;
  }

  function drawToDataURL(source, w, h) {
    try {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(source, 0, 0, w, h);
      return c.toDataURL();
    } catch (_) { return null; } // tainted canvas
  }

  const looksLikeImage = (d) => !!d && /^data:(image\/|application\/octet-stream|;base64)/i.test(d);

  // Заменяет url(...) на data:URL. Ссылки на #id этой же страницы превращает в url(#id).
  async function inlineUrls(css, base, ctx, kind = 'image') {
    if (!css.includes('url(')) return css;
    const pageNoHash = location.href.split('#')[0];
    const found = new Map();
    css.replace(URL_RE, (m, q, u) => { found.set(u, null); return m; });

    await Promise.all([...found.keys()].map(async (u) => {
      if (u.startsWith('data:')) return;
      if (u.startsWith('#')) { ctx.refIds.add(u.slice(1)); found.set(u, u); return; }
      let abs;
      try { abs = new URL(u, base).href; } catch (_) { return; }
      const [noHash, hash] = abs.split('#');
      if (hash && noHash === pageNoHash) { ctx.refIds.add(hash); found.set(u, '#' + hash); return; }
      found.set(u, await toDataURL(abs, ctx.opts, kind));
    }));

    return css.replace(URL_RE, (m, q, u) => {
      const v = found.get(u);
      return v ? `url("${v}")` : m;
    });
  }

  /* ---------------- список свойств и стили по умолчанию ---------------- */

  let PROPS = null;     // имена CSS-свойств, которые переносим
  let WIDTH_OF = null;  // для *-style: индекс соответствующего *-width, иначе -1

  function initProps() {
    if (PROPS) return;
    const cs = getComputedStyle(document.documentElement);
    PROPS = [];
    for (let i = 0; i < cs.length; i++) if (!SKIP_PROPS.test(cs[i])) PROPS.push(cs[i]);
    const index = new Map(PROPS.map((p, i) => [p, i]));
    WIDTH_OF = PROPS.map((p) => {
      if (!DEPENDENT_STYLE.test(p)) return -1;
      const w = index.get(p.replace(/-style$/, '-width'));
      return w === undefined ? -1 : w;
    });
  }

  function readValues(cs) {
    const n = PROPS.length, out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = cs.getPropertyValue(PROPS[i]);
    return out;
  }

  let sandbox = null;
  const defaultStyleCache = new Map();

  function getSandbox() {
    if (sandbox) return sandbox;
    sandbox = document.createElement('iframe');
    sandbox.setAttribute('aria-hidden', 'true');
    sandbox.setAttribute('data-html-shot-ignore', '');
    sandbox.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:10px;height:10px;visibility:hidden;border:0';
    (document.body || document.documentElement).appendChild(sandbox);
    try {
      const d = sandbox.contentDocument;
      d.open(); d.write('<!DOCTYPE html><html><head></head><body></body></html>'); d.close();
    } catch (_) { /* Trusted Types / CSP — используем about:blank как есть */ }
    return sandbox;
  }

  function getDefaultStyle(ns, tag) {
    const key = ns + '|' + tag;
    let vals = defaultStyleCache.get(key);
    if (vals) return vals;
    const doc = getSandbox().contentDocument;
    const el = doc.createElementNS(ns, tag);
    (doc.body || doc.documentElement).appendChild(el);
    vals = readValues(doc.defaultView.getComputedStyle(el));
    el.remove();
    defaultStyleCache.set(key, vals);
    return vals;
  }

  function cleanupSandbox() {
    if (sandbox) { sandbox.remove(); sandbox = null; }
  }

  // Берём свойство, если оно отличается от дефолта ИЛИ от родителя (важно для наследуемых).
  function styleText(vals, def, parent) {
    let out = '';
    let widths = null;
    for (let i = 0, n = PROPS.length; i < n; i++) {
      const v = vals[i];
      if (!v) continue;
      if (v === def[i] && (!parent || v === parent[i])) continue;
      out += PROPS[i] + ':' + v + ';';
      if (WIDTH_OF[i] >= 0 && v !== 'none' && v !== 'hidden') (widths || (widths = [])).push(WIDTH_OF[i]);
    }
    if (widths) for (const w of widths) if (vals[w]) out += PROPS[w] + ':' + vals[w] + ';';
    return out;
  }

  function setStyle(el, style, base, ctx) {
    if (!style) return;
    el.setAttribute('style', style);
    if (style.includes('url(')) {
      ctx.tasks.push(inlineUrls(style, base, ctx).then((s) => el.setAttribute('style', s)));
    }
  }

  /* ---------------- шрифты ---------------- */

  const cleanFamily = (f) => f.trim().replace(/^['"]|['"]$/g, '').toLowerCase();

  function addFonts(fontFamily, ctx) {
    if (!fontFamily || ctx.fontStrings.has(fontFamily)) return;
    ctx.fontStrings.add(fontFamily);
    fontFamily.split(',').forEach((f) => ctx.fonts.add(cleanFamily(f)));
  }

  function addChars(text, ctx) {
    if (!text || ctx.chars.size > 20000) return;
    for (const ch of text) ctx.chars.add(ch.codePointAt(0));
  }

  function rangeMatches(unicodeRange, chars) {
    if (!unicodeRange || !chars.size) return true;
    const ranges = unicodeRange.split(',').map((s) => {
      s = s.trim().replace(/^u\+/i, '');
      if (s.includes('?')) return [parseInt(s.replace(/\?/g, '0'), 16), parseInt(s.replace(/\?/g, 'F'), 16)];
      const [a, b] = s.split('-');
      return [parseInt(a, 16), parseInt(b || a, 16)];
    });
    for (const c of chars) for (const [a, b] of ranges) if (c >= a && c <= b) return true;
    return false;
  }

  async function collectFontCSS(ctx) {
    const faces = [];
    const fetched = new Set();

    async function rulesOf(sheet) {
      try { return sheet.cssRules; } catch (_) { /* cross-origin */ }
      if (!sheet.href || fetched.has(sheet.href)) return [];
      fetched.add(sheet.href);
      try {
        const text = await fetchText(sheet.href, ctx.opts, 'css');
        if (text == null) return [];
        const s = new CSSStyleSheet();
        s.replaceSync(text);
        return s.cssRules;
      } catch (_) { return []; }
    }

    async function walk(rules, base) {
      for (const rule of rules || []) {
        if (rule.type === 5 /* FONT_FACE */) faces.push({ rule, base });
        else if (rule.type === 3 /* IMPORT */ && rule.styleSheet) {
          await walk(await rulesOf(rule.styleSheet), rule.styleSheet.href || base);
        } else if (rule.cssRules) await walk(rule.cssRules, base);
      }
    }

    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
    for (const sheet of sheets) await walk(await rulesOf(sheet), sheet.href || document.baseURI);

    const parts = faces
      .filter(({ rule }) => ctx.fonts.has(cleanFamily(rule.style.getPropertyValue('font-family'))))
      .filter(({ rule }) => rangeMatches(rule.style.getPropertyValue('unicode-range'), ctx.chars))
      .map(({ rule, base }) => inlineUrls(rule.cssText, base, ctx, 'font'));
    if (ctx.opts.jsFonts) {
      const cssFamilies = new Set(faces.map(({ rule }) => cleanFamily(rule.style.getPropertyValue('font-family'))));
      parts.push(collectJsFonts(ctx, cssFamilies));
    }
    return (await Promise.all(parts)).join('\n');
  }

  // Шрифты из new FontFace(name, url): у объекта FontFace нельзя узнать URL, поэтому
  // сопоставляем загруженные файлы шрифтов (Resource Timing) с именами семейств.
  const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const WEIGHT_WORDS = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };

  async function collectJsFonts(ctx, cssFamilies) {
    if (!document.fonts) return '';
    const jsFaces = [];
    document.fonts.forEach((f) => {
      const fam = cleanFamily(f.family);
      if (f.status === 'loaded' && !cssFamilies.has(fam) && ctx.fonts.has(fam)) jsFaces.push(f);
    });
    if (!jsFaces.length) return '';

    const fontFiles = [...new Set((performance.getEntriesByType ? performance.getEntriesByType('resource') : [])
      .map((e) => e.name)
      .filter((u) => /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(u)))];
    if (!fontFiles.length) { jsFaces.forEach((f) => ctx.missingFonts.add(f.family)); return ''; }

    const used = new Set();
    const score = (face, url) => {
      const file = normName(url.split(/[?#]/)[0].split('/').pop().replace(/\.[a-z0-9]+$/i, ''));
      const fam = normName(face.family);
      if (!file || !fam) return 0;
      let sc = 0;
      if (file.includes(fam)) sc += 10;
      else if (fam.includes(file)) sc += 8;
      else {
        // частичное совпадение: общий префикс не короче 4 символов
        let k = 0; while (k < file.length && k < fam.length && file[k] === fam[k]) k++;
        if (k >= 4) sc += 4;
      }
      if (!sc) return 0;
      const w = parseInt(face.weight, 10) || 400;
      if (file.includes(String(w)) || file.includes(WEIGHT_WORDS[w] || '~')) sc += 2;
      if (/italic/.test(face.style) === /italic|oblique/.test(file)) sc += 1;
      return sc;
    };

    const out = await Promise.all(jsFaces.map(async (face) => {
      let best = null, bestScore = 0;
      for (const u of fontFiles) {
        if (used.has(u)) continue;
        const sc = score(face, u);
        if (sc > bestScore) { best = u; bestScore = sc; }
      }
      // Один безымянный шрифт и один непонятный файл — считаем, что это пара
      if (!best && jsFaces.length === 1 && fontFiles.length - used.size === 1) best = fontFiles.find((u) => !used.has(u));
      if (!best) { ctx.missingFonts.add(face.family); return ''; }
      used.add(best);
      const data = await toDataURL(best, ctx.opts, 'font');
      if (!data) { ctx.missingFonts.add(face.family); return ''; }
      const props = [`font-family:"${face.family.replace(/^['"]|['"]$/g, '')}"`, `src:url("${data}")`,
        `font-weight:${face.weight}`, `font-style:${face.style}`, `font-stretch:${face.stretch}`];
      if (face.unicodeRange && face.unicodeRange !== 'U+0-10FFFF') props.push(`unicode-range:${face.unicodeRange}`);
      return `@font-face{${props.join(';')}}`;
    }));
    return out.filter(Boolean).join('\n');
  }

  /* ---------------- SVG-ссылки (спрайты, градиенты) ---------------- */

  async function externalSymbol(href, ctx) {
    let abs;
    try { abs = new URL(href, document.baseURI); } catch (_) { return null; }
    const id = abs.hash.slice(1);
    abs.hash = '';
    if (!ctx.sprites.has(abs.href)) {
      ctx.sprites.set(abs.href, fetchText(abs.href, ctx.opts, 'svg')
        .then((t) => t && new DOMParser().parseFromString(t, 'image/svg+xml'))
        .catch(() => null));
    }
    const doc = await ctx.sprites.get(abs.href);
    const node = doc && doc.getElementById(id);
    if (!node) return null;
    const newId = 'hs-ext-' + id;
    if (!ctx.extraIds.has(newId)) {
      ctx.extraIds.add(newId);
      const c = ctx.doc.importNode(node, true);
      c.setAttribute('id', newId);
      ctx.extraDefs.push(c);
    }
    return newId;
  }

  function ensureRefs(root, ctx) {
    const defs = [...ctx.extraDefs];
    for (const id of ctx.refIds) {
      let exists = false;
      try { exists = !!root.querySelector('#' + CSS.escape(id)); } catch (_) {}
      if (exists) continue;
      const src = document.getElementById(id);
      if (src && src.namespaceURI === SVGNS) defs.push(ctx.doc.importNode(src, true));
    }
    if (!defs.length) return;
    const svg = ctx.doc.createElementNS(SVGNS, 'svg');
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
    const d = ctx.doc.createElementNS(SVGNS, 'defs');
    defs.forEach((n) => d.appendChild(n));
    svg.appendChild(d);
    root.insertBefore(svg, root.firstChild);
  }

  /* ---------------- клонирование DOM ---------------- */

  function childNodesOf(node) {
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    if (node.localName === 'slot' && node.assignedNodes) {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(node.childNodes);
  }

  function copyAttributes(src, dst, replaced) {
    for (const a of Array.from(src.attributes)) {
      const n = a.name;
      if (replaced && n !== 'id' && n !== 'class') continue;
      if (/^on/i.test(n) || n === 'style' || n === 'src' || n === 'srcset' || n === 'sizes' || n === 'loading') continue;
      try {
        if (a.namespaceURI) dst.setAttributeNS(a.namespaceURI, n, a.value);
        else dst.setAttribute(n, a.value);
      } catch (_) { /* невалидное имя атрибута (@click, :class и т.п.) */ }
    }
  }

  async function imageSource(node, ctx) {
    const src = node.currentSrc || node.src;
    let data = src ? await toDataURL(src, ctx.opts) : null;
    if (!looksLikeImage(data)) data = null; // сервер вернул HTML/JSON вместо картинки
    if (!data && node.complete && node.naturalWidth) {
      data = drawToDataURL(node, node.naturalWidth, node.naturalHeight);
      if (data) { const abs = absolute(src); if (abs) failed.delete(abs); }
    }
    if (!data && src) { const abs = absolute(src); if (abs) failed.set(abs, 'image'); }
    return data || ctx.opts.placeholder;
  }

  const isScrollable = (v) => v === 'auto' || v === 'scroll' || v === 'overlay';
  const BLOCKISH = /^(block|flex|grid|flow-root|list-item|table|table-row|table-row-group|table-cell|inline-block|inline-flex|inline-grid)$/;
  const intersects = (r, c) => r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom;
  const clipTo = (r, c) => ({
    left: Math.max(r.left, c ? c.left : -Infinity), top: Math.max(r.top, c ? c.top : -Infinity),
    right: Math.min(r.right, c ? c.right : Infinity), bottom: Math.min(r.bottom, c ? c.bottom : Infinity),
  });

  const REPLACED = new Set(['img', 'canvas', 'video', 'iframe', 'input', 'textarea', 'select', 'svg', 'object', 'embed']);
  // transform действует не на всё: не на обычные inline и не на строки/группы таблиц
  function canTranslate(tag, display) {
    if (display === 'contents' || display === 'none') return false;
    if (display === 'inline') return REPLACED.has(tag);
    if (display.startsWith('table-')) return display === 'table-cell' || display === 'table-caption';
    return true;
  }

  // Блок за краем может держать внутри то, что всё равно видно: «прилипший» заголовок,
  // absolute-полоску (ручка-разделитель), сдвинутый transform-ом элемент. Такое поддерево
  // выкидывать нельзя. Большие поддеревья не проверяем до конца и считаем, что такое там есть.
  function hasEscapingInside(node, win) {
    const it = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let n = it.nextNode(), budget = 300; n; n = it.nextNode()) {
      if (--budget < 0) return true;
      const cs = win.getComputedStyle(n);
      if (cs.position !== 'static' || cs.transform !== 'none' || (cs.translate || 'none') !== 'none') return true;
    }
    return false;
  }

  async function cloneNode(node, ctx, parentVals, offset, flags = {}, clip = null) {
    if (node.nodeType === 3) {
      addChars(node.data, ctx);
      return ctx.doc.createTextNode(node.data);
    }
    if (node.nodeType !== 1 || !node.isConnected) return null;

    await breathe(ctx);
    if (!node.isConnected) return null; // страница могла измениться, пока мы ждали

    const tag = node.localName;
    const ns = node.namespaceURI || XHTML;
    const isHTML = ns === XHTML;
    const doc = node.ownerDocument;
    const win = doc.defaultView;

    if (!flags.isRoot) {
      if (isHTML && SKIP_TAGS.has(tag)) return null;
      if (tag === 'source' && node.parentElement && node.parentElement.localName === 'picture') return null;
      if (node.hasAttribute('data-html-shot-ignore')) return null;
      if (ctx.opts.filter && ctx.opts.filter(node) === false) return null;
    }

    const cs = win.getComputedStyle(node);
    if (isHTML && !flags.isRoot && cs.display === 'none') return null;

    // Элемент целиком вне видимой области своего обрезающего предка: оставляем «коробку»
    // (размеры уже зафиксированы в стилях, раскладка не поедет), но не клонируем содержимое.
    // Если он ниже видимой области в обычном потоке — он ни на что не влияет, выкидываем совсем.
    // absolute/fixed не трогаем: они часто вылезают за overflow предка и остаются видимыми
    // (выпадающие меню, подсказки, бейджи). Выкидываем только то, что не сдвинуто
    // transform/relative-смещением — иначе «под экраном» может оказаться видимый элемент.
    let rect = null, culled = false;
    const inFlow = cs.position === 'static' || cs.position === 'relative' || cs.position === 'sticky';
    if (clip && isHTML && !flags.isRoot && inFlow && BLOCKISH.test(cs.display)) {
      rect = node.getBoundingClientRect();
      // Блок нулевой ширины/высоты весь состоит из «вылезающего» содержимого — не выкидываем
      culled = rect.width > 0 && rect.height > 0 && !intersects(rect, clip) && !hasEscapingInside(node, win);
      const untransformed = cs.transform === 'none' && (cs.translate || 'none') === 'none';
      if (culled && flags.dropBelow && rect.top >= clip.bottom && untransformed &&
          (cs.position === 'static' || (cs.position === 'relative' && /^(auto|0px)$/.test(cs.top)))) return null;
    }
    const vals = readValues(cs);

    let cloneTag = tag;
    if (isHTML) {
      if (tag === 'html' || tag === 'body' || tag === 'iframe') cloneTag = 'div';
      else if (tag === 'canvas' || tag === 'video') cloneTag = 'img';
      else if (tag === 'slot') cloneTag = 'span';
    }
    const el = ctx.doc.createElementNS(ns, cloneTag);
    copyAttributes(node, el, cloneTag !== tag);
    let pairIdx = -1;
    // Элемент без «чистого» сдвига (scale/rotate/zoom): поправки для его потомков
    // пришлось бы пересчитывать через матрицу — их не двигаем.
    const warps = cs.transform !== 'none' && !/^matrix\(1, 0, 0, 1, /.test(cs.transform) ||
      (cs.scale || 'none') !== 'none' || (cs.rotate || 'none') !== 'none' || (cs.zoom && cs.zoom !== '1');
    if (ctx.pairs) {
      pairIdx = ctx.pairs.push({
        node, el, parent: flags.pIdx === undefined ? -1 : flags.pIdx, frame: flags.frame || null,
        rtl: cs.direction === 'rtl',
        movable: isHTML && !flags.warped && canTranslate(cloneTag, cs.display),
      }) - 1;
    }

    // Корень документа внутри iframe не должен ничего наследовать от внешней страницы — пишем все свойства
    let style = flags.isFrameRoot ? styleText(vals, [], null)
      : styleText(vals, getDefaultStyle(ns, cloneTag), flags.isRoot ? null : parentVals);
    if (tag === 'iframe' && isHTML && cs.display === 'inline') style += 'display:inline-block;vertical-align:' + cs.verticalAlign + ';';
    addFonts(cs.fontFamily, ctx);

    const isDocRoot = isHTML && (tag === 'html' || (tag === 'body' && node === doc.body));
    if (isDocRoot) {
      style += 'overflow:visible;';
      if (ctx.opts.fullPage && doc === document) style += 'height:auto;max-height:none;';
      if (tag === 'html' && doc === document) style += `min-height:${ctx.height}px;`;
    }
    if (flags.isRoot && !isDocRoot) {
      style += 'margin:0;position:relative;left:auto;top:auto;right:auto;bottom:auto;transform:none;';
    }

    // Скроллбары в копии: стили ::-webkit-scrollbar теряются, поэтому auto/scroll → hidden,
    // а место под классический скроллбар резервируем через scrollbar-gutter.
    if (isHTML && !isDocRoot && (isScrollable(cs.overflowX) || isScrollable(cs.overflowY))) {
      style += `overflow-x:${isScrollable(cs.overflowX) ? 'hidden' : cs.overflowX};` +
               `overflow-y:${isScrollable(cs.overflowY) ? 'hidden' : cs.overflowY};`;
      const borders = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
      style += node.offsetWidth - node.clientWidth - borders > 0 ? 'scrollbar-gutter:stable;' : 'scrollbar-width:none;';
    }
    // sticky внутри <foreignObject> ведёт себя не так, как на странице (прокрутки там нет):
    // ставим элемент в обычный поток, а на «прилипшее» место его переносит сверка раскладки.
    if (ctx.pairs && cs.position === 'sticky') {
      style += 'position:relative;top:auto;right:auto;bottom:auto;left:auto;';
    }
    if (tag === 'textarea') style += 'resize:none;';
    if (node === doc.activeElement && !isDocRoot) style += 'outline:none;';

    // Сдвиг за прокрутку. transform создаёт у элемента свой слой, и z-index потомков
    // (ручки-разделители, меню поверх соседней панели) перестаёт работать — поэтому при
    // сверке раскладки сдвигаем только корень снимка, остальное ставит на место сверка.
    let tx = 0, ty = 0;
    const lockOn = !!ctx.pairs;
    if (offset && (!lockOn || (flags.isRoot && !flags.isFrameRoot))) { tx -= offset.x; ty -= offset.y; }
    if (!lockOn && ctx.viewportFix && doc === document && cs.position === 'fixed') {
      tx += ctx.viewportFix.x; ty += ctx.viewportFix.y;
    }
    if (tx || ty) {
      const base = flags.isRoot && !isDocRoot ? '' : (cs.transform === 'none' ? '' : cs.transform);
      style += `transform:translate(${tx}px,${ty}px) ${base};`;
    }
    setStyle(el, style, doc.baseURI, ctx);

    if (culled) return el;

    // Псевдоэлементы ::before / ::after
    if (isHTML && !NO_CHILDREN.has(tag)) {
      for (const pseudo of ['::before', '::after']) {
        const pcs = win.getComputedStyle(node, pseudo);
        const content = pcs.content;
        if (!content || content === 'none' || content === 'normal' || pcs.display === 'none') continue;
        const cls = 'hs' + ctx.uid++;
        el.setAttribute('class', ((el.getAttribute('class') || '') + ' ' + cls).trim());
        const rule = `.${cls}${pseudo}{${styleText(readValues(pcs), getDefaultStyle(XHTML, 'span'), vals)}content:${content};}`;
        addFonts(pcs.fontFamily, ctx);
        addChars(content, ctx);
        const slot = ctx.pseudo.push(rule) - 1;
        if (rule.includes('url(')) ctx.tasks.push(inlineUrls(rule, doc.baseURI, ctx).then((r) => { ctx.pseudo[slot] = r; }));
      }
    }

    // Специальные элементы
    if (isHTML) {
      if (tag === 'img') {
        el.setAttribute('src', ctx.opts.placeholder);
        ctx.tasks.push(imageSource(node, ctx).then((s) => el.setAttribute('src', s)));
      } else if (tag === 'canvas') {
        let data = null;
        try { data = node.toDataURL(); } catch (_) { ctx.taintedCanvases++; }
        el.setAttribute('src', data || ctx.opts.placeholder);
      } else if (tag === 'video') {
        const frame = node.readyState >= 2 && node.videoWidth ? drawToDataURL(node, node.videoWidth, node.videoHeight) : null;
        el.setAttribute('src', frame || ctx.opts.placeholder);
        if (!frame && node.poster) {
          ctx.tasks.push(toDataURL(node.poster, ctx.opts).then((d) => { if (looksLikeImage(d)) el.setAttribute('src', d); }));
        }
      } else if (tag === 'iframe') {
        let fdoc = null;
        try { fdoc = node.contentDocument; } catch (_) {}
        if (fdoc && fdoc.documentElement) {
          const fwin = fdoc.defaultView;
          // Окно фрейма: absolute/fixed внутри iframe отсчитываются от его угла, а не от угла
          // снимка. contain делает обёртку их «окном» и обрезает всё, что за краем фрейма.
          const pad = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
          const vw = Math.max(0, node.clientWidth - pad('padding-left') - pad('padding-right'));
          const vh = Math.max(0, node.clientHeight - pad('padding-top') - pad('padding-bottom'));
          const view = ctx.doc.createElementNS(XHTML, 'div');
          view.setAttribute('style', `display:block;position:relative;width:${vw}px;height:${vh}px;` +
            'margin:0;padding:0;border:0;overflow:hidden;contain:strict;');
          el.appendChild(view);
          const inner = await cloneNode(fdoc.documentElement, ctx, null, { x: fwin.scrollX, y: fwin.scrollY }, {
            isRoot: true, isFrameRoot: true,
            pIdx: pairIdx >= 0 ? pairIdx : flags.pIdx, warped: !!flags.warped || warps,
            frame: { el: node, parent: flags.frame || null },
          });
          if (inner) view.appendChild(inner);
          // фон body в iframe заливает всё окно фрейма
          const hb = fwin.getComputedStyle(fdoc.documentElement).backgroundColor;
          const bb = fdoc.body ? fwin.getComputedStyle(fdoc.body).backgroundColor : '';
          const frameBg = !isTransparent(hb) ? hb : !isTransparent(bb) ? bb : '';
          el.setAttribute('style', (el.getAttribute('style') || '') + 'overflow:hidden;' + (frameBg ? 'background-color:' + frameBg + ';' : ''));
        } else {
          el.setAttribute('style', (el.getAttribute('style') || '') + 'background:#e5e7eb;');
        }
      } else if (tag === 'input') {
        const type = (node.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          node.checked ? el.setAttribute('checked', '') : el.removeAttribute('checked');
        } else if (type !== 'file') {
          el.setAttribute('value', node.value);
          addChars(node.value, ctx);
        }
      } else if (tag === 'textarea') {
        el.textContent = node.value;
        addChars(node.value, ctx);
      } else if (tag === 'option') {
        node.selected ? el.setAttribute('selected', '') : el.removeAttribute('selected');
      }
    } else if (ns === SVGNS) {
      const href = node.getAttribute('href') || node.getAttributeNS(XLINK, 'href');
      if (tag === 'image' && href) {
        ctx.tasks.push(toDataURL(href, ctx.opts).then((d) => {
          if (d) { el.removeAttributeNS(XLINK, 'href'); el.setAttribute('href', d); }
        }));
      } else if (tag === 'use' && href) {
        if (href.startsWith('#')) ctx.refIds.add(href.slice(1));
        else if (href.includes('#')) {
          ctx.tasks.push(externalSymbol(href, ctx).then((id) => {
            if (id) { el.removeAttributeNS(XLINK, 'href'); el.setAttribute('href', '#' + id); }
          }));
        }
      }
    }

    // Дети — последовательно, чтобы обход можно было прерывать (breathe)
    if (!(isHTML && NO_CHILDREN.has(tag))) {
      const scrolled = isHTML && !isDocRoot && (node.scrollLeft || node.scrollTop)
        ? { x: node.scrollLeft, y: node.scrollTop } : null;
      // Потомки absolute/fixed могут быть видны за пределами обрезающего предка
      let childClip = cs.position === 'absolute' || cs.position === 'fixed' ? null : clip;
      if (isHTML && !isDocRoot && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') && cs.display !== 'contents') {
        childClip = clipTo(rect || node.getBoundingClientRect(), clip);
      }
      const d = cs.display;
      const dropBelow = isHTML && (d === 'block' || d === 'flow-root' || d === 'list-item' ||
        (d === 'flex' && cs.flexDirection === 'column' && /^(normal|flex-start|start)$/.test(cs.justifyContent)));
      const childFlags = { dropBelow, pIdx: pairIdx >= 0 ? pairIdx : flags.pIdx, warped: !!flags.warped || warps, frame: flags.frame };
      for (const k of childNodesOf(node)) {
        const c = await cloneNode(k, ctx, vals, scrolled, childFlags, childClip);
        if (c) el.appendChild(c);
      }
    }
    return el;
  }

  /* ---------------- рендер ---------------- */

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('[htmlShot] Браузер не смог отрисовать SVG-снимок'));
      img.src = src;
    }).then(async (img) => {
      try { await img.decode(); } catch (_) {}
      return img;
    });
  }

  const isTransparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\s*\)$/.test(c);

  function clampScale(w, h, s) {
    const MAX_SIDE = 32767, MAX_AREA = 268435456;
    return Math.max(0.1, Math.min(s, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h))));
  }

  // encodeURIComponent на мегабайтах текста блокирует поток — кодируем кусками
  async function encodeChunked(str, ctx) {
    const CHUNK = 200000;
    let out = '';
    for (let i = 0; i < str.length; i += CHUNK) {
      let end = Math.min(i + CHUNK, str.length);
      const code = str.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end++; // не разрываем суррогатную пару
      out += encodeURIComponent(str.slice(i, end));
      i = end - CHUNK;
      await breathe(ctx);
    }
    return out;
  }

  async function buildClone(opts, withPairs) {
    const target = opts.target || document.documentElement;
    const isDoc = target === document.documentElement;

    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    initProps();

    const ctx = {
      opts, doc: document.implementation.createHTMLDocument(''),
      fonts: new Set(), fontStrings: new Set(), chars: new Set(),
      pseudo: [], tasks: [], refIds: new Set(), extraDefs: [], extraIds: new Set(),
      sprites: new Map(), uid: 0, viewportFix: null, height: 0, lastYield: performance.now(),
      missingFonts: new Set(), taintedCanvases: 0, moved: 0,
      pairs: withPairs ? [] : null,
    };

    let width, height, rootOffset = null;
    if (isDoc) {
      const de = document.documentElement;
      if (opts.fullPage) {
        width = Math.max(de.scrollWidth, de.clientWidth);
        height = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, de.clientHeight);
      } else {
        ({ width, height } = viewportSize());
        ctx.viewportFix = { x: global.scrollX, y: global.scrollY };
        rootOffset = ctx.viewportFix;
      }
    } else {
      const r = target.getBoundingClientRect();
      width = Math.ceil(r.width);
      height = Math.ceil(r.height);
    }
    width = Math.max(1, width); height = Math.max(1, height);
    ctx.height = height;

    let rootClip = null;
    if (isDoc && !opts.fullPage) rootClip = { left: 0, top: 0, right: width, bottom: height };
    const root = await cloneNode(target, ctx, null, rootOffset, { isRoot: true }, rootClip);
    await Promise.all(ctx.tasks);   // картинки/фоны грузились параллельно с обходом
    ensureRefs(root, ctx);

    let css = ctx.pseudo.join('\n');
    if (opts.embedFonts) css = (await collectFontCSS(ctx)) + '\n' + css;
    if (css.trim()) {
      const st = ctx.doc.createElementNS(XHTML, 'style');
      st.textContent = css;
      root.insertBefore(st, root.firstChild);
    }
    return { root, ctx, width, height, isDoc, target };
  }

  /* ---------------- размер видимой области ---------------- */

  // Видимая область без полос прокрутки. В quirks-режиме (нет <!DOCTYPE>) окном служит
  // body, а documentElement.clientHeight там — высота всей страницы.
  function viewportSize() {
    const de = document.documentElement;
    const quirks = document.compatMode === 'BackCompat' && document.body;
    const w = (quirks ? document.body.clientWidth : de.clientWidth) || global.innerWidth;
    const h = (quirks ? document.body.clientHeight : de.clientHeight) || global.innerHeight;
    return { width: Math.min(w, global.innerWidth), height: Math.min(h, global.innerHeight) };
  }

  /* ---------------- сверка раскладки копии с оригиналом ---------------- */

  // Где каждый элемент стоит в оригинале — в координатах снимка. Как у html2canvas:
  // fixed/sticky там, где их видно при текущей прокрутке.
  function expectedPositions(pairs, opts, isDoc, target) {
    const tRect = !isDoc ? target.getBoundingClientRect() : null;
    const sx = global.scrollX, sy = global.scrollY;
    // Угол окна iframe (content-box) в координатах главного окна, с учётом вложенности
    const origins = new Map();
    const frameOrigin = (frame) => {
      if (!frame) return { x: 0, y: 0 };
      let o = origins.get(frame.el);
      if (o) return o;
      const up = frameOrigin(frame.parent);
      const r = frame.el.getBoundingClientRect();
      const cs = frame.el.ownerDocument.defaultView.getComputedStyle(frame.el);
      const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
      o = { x: up.x + r.left + n('border-left-width') + n('padding-left'), y: up.y + r.top + n('border-top-width') + n('padding-top') };
      origins.set(frame.el, o);
      return o;
    };
    return pairs.map((pair) => {
      if (!pair.node.isConnected) return null;
      const r = pair.node.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      const fo = frameOrigin(pair.frame);
      let x = r.left + fo.x, y = r.top + fo.y;
      if (tRect) { x -= tRect.left; y -= tRect.top; }
      else if (opts.fullPage) { x += sx; y += sy; }
      return { x, y, w: r.width, h: r.height };
    });
  }

  // Раскладывает копию в скрытом iframe размером со снимок (как в <foreignObject>).
  async function layoutInFrame(root, width, height, opts) {
    const frame = document.createElement('iframe');
    frame.setAttribute('data-html-shot-ignore', '');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;` +
      'visibility:hidden;pointer-events:none;z-index:-2147483647';
    (document.body || document.documentElement).appendChild(frame);
    const fdoc = frame.contentDocument;
    try { fdoc.open(); fdoc.write('<!DOCTYPE html><html><head></head><body></body></html>'); fdoc.close(); } catch (_) {}
    fdoc.documentElement.style.cssText = 'margin:0;padding:0;overflow:hidden';
    fdoc.body.style.cssText = 'margin:0;padding:0';
    fdoc.body.appendChild(fdoc.adoptNode(root));
    void fdoc.body.offsetHeight; // запустить загрузку встроенных шрифтов
    if (fdoc.fonts && fdoc.fonts.ready) await Promise.race([fdoc.fonts.ready, sleep(opts.timeout)]);
    return { frame, fdoc };
  }

  const PX = /^-?\d*\.?\d+(?:e[-+]?\d+)?px$/i;
  const round2 = (n) => +n.toFixed(2);

  // Сдвигает элемент копии на (dx, dy), не создавая нового слоя отрисовки (в отличие от
  // transform, при котором z-index потомков начинает действовать только внутри элемента).
  // Возвращает 'pos' — сдвинут вместе со всем поддеревом; 'cb' — стал position:relative,
  // и у absolute-потомков мог смениться отсчёт (их проверит следующий проход); null — не сдвинут.
  function nudge(pair, dx, dy) {
    const st = pair.el.style;
    const pos = st.getPropertyValue('position') || 'static';
    // Логические дубли (inset-block-*, inset-inline-*) при записи стиля в SVG встают после
    // физических и перебивают новые left/top — убираем их, физические значения остаются.
    const dropLogical = () => ['inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end']
      .forEach((p) => st.removeProperty(p));
    if (pair.rtl) {
      const cur = st.getPropertyValue('transform');
      st.setProperty('transform', `translate(${round2(dx)}px,${round2(dy)}px)` + (cur && cur !== 'none' ? ' ' + cur : ''));
      return 'pos';
    }
    if (pos === 'static') {
      dropLogical();
      st.setProperty('position', 'relative');
      st.setProperty('left', round2(dx) + 'px');
      st.setProperty('top', round2(dy) + 'px');
      st.setProperty('right', 'auto');
      st.setProperty('bottom', 'auto');
      return 'cb';
    }
    if (pos !== 'relative' && pos !== 'absolute' && pos !== 'fixed') return null;
    // Для relative «auto» равно 0; для absolute/fixed «auto» — статическое место, его не знаем
    const read = (p) => {
      const v = st.getPropertyValue(p);
      if (!v || v === 'auto') return pos === 'relative' ? 0 : null;
      return PX.test(v) ? parseFloat(v) : null;
    };
    const L = read('left'), T = read('top');
    if (L === null || T === null) return null;
    dropLogical();
    st.setProperty('left', round2(L + dx) + 'px');
    st.setProperty('top', round2(T + dy) + 'px');
    return 'pos';
  }

  // Ставит съехавшие элементы копии точно туда, где они в оригинале. Обход в порядке
  // документа: сдвиг родителя уже учтён, дочерний элемент двигаем только на остаток.
  // Если родитель стал position:relative, его потомков проверяем на следующем проходе,
  // после новой раскладки. Возвращает число поправленных элементов.
  function alignToOriginal(pairs, expected) {
    const ZERO = { x: 0, y: 0 };
    let moved = 0;
    for (let pass = 0; pass < 6; pass++) {
      const actual = pairs.map((pair) => pair.el.getBoundingClientRect()); // одна раскладка на проход
      const shift = new Array(pairs.length); // null — «пересчитать на следующем проходе»
      let movedNow = 0;
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const base = pair.parent >= 0 ? shift[pair.parent] : ZERO;
        shift[i] = base;
        if (!base) continue;
        const e = expected[i];
        if (!e || !pair.movable || pair.parent < 0) continue;
        const a = actual[i];
        const dx = e.x - (a.left + base.x), dy = e.y - (a.top + base.y);
        if (Math.abs(dx) < 0.75 && Math.abs(dy) < 0.75) continue;
        const how = nudge(pair, dx, dy);
        if (!how) continue;
        shift[i] = how === 'cb' ? null : { x: base.x + dx, y: base.y + dy };
        movedNow++;
      }
      moved += movedNow;
      if (!movedNow) break;
    }
    return moved;
  }

  /* ---------------- подготовка страницы ---------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const twoFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  // Временно меняет страницу так, чтобы копия получилась точной; возвращает функцию отката.
  async function preparePage(opts) {
    const undo = [];
    const sx = global.scrollX, sy = global.scrollY;

    // Снимаем только экран — не трогаем то, что за его пределами: раскрытие
    // content-visibility и догрузка lazy-картинок меняют высоту блоков выше экрана,
    // и страница «уезжает» относительно того, что видит пользователь.
    const offscreen = opts.fullPage || !!opts.target;

    if (opts.contentVisibility && offscreen) {
      // content-visibility:auto не раскладывает содержимое вне экрана — размеры в копии были бы неверны
      const st = document.createElement('style');
      st.setAttribute('data-html-shot-ignore', '');
      st.textContent = '*{content-visibility:visible!important}';
      (document.head || document.documentElement).appendChild(st);
      undo.push(() => st.remove());
    }

    if (opts.lazyImages) {
      if (offscreen) {
        for (const img of document.querySelectorAll('img[loading="lazy"]')) {
          img.loading = 'eager';
          undo.push(() => { img.loading = 'lazy'; });
        }
      }
      const vp = viewportSize();
      const onScreen = (i) => {
        if (offscreen) return true;
        const r = i.getBoundingClientRect();
        return r.bottom > 0 && r.right > 0 && r.top < vp.height && r.left < vp.width;
      };
      const pending = [...document.images].filter((i) => !i.complete && onScreen(i)).map((i) => new Promise((r) => {
        i.addEventListener('load', r, { once: true });
        i.addEventListener('error', r, { once: true });
      }));
      if (pending.length) await Promise.race([Promise.all(pending), sleep(opts.timeout)]);
    }

    await twoFrames();
    if (global.scrollX !== sx || global.scrollY !== sy) global.scrollTo(sx, sy);

    if (opts.freezeAnimations && document.getAnimations) {
      // Обход идёт порциями по несколько кадров — без паузы верх и низ снимка были бы из разных моментов
      let running = [];
      try { running = document.getAnimations().filter((a) => a.playState === 'running'); } catch (_) {}
      running.forEach((a) => { try { a.pause(); } catch (_) {} });
      undo.push(() => running.forEach((a) => { try { a.play(); } catch (_) {} }));
    }

    return () => {
      undo.reverse().forEach((f) => { try { f(); } catch (_) {} });
      if (global.scrollX !== sx || global.scrollY !== sy) global.scrollTo(sx, sy);
    };
  }

  /* ---------------- рендер SVG → canvas ---------------- */

  function pageBackground(opts, isDoc) {
    let bg = opts.backgroundColor;
    if (!bg && isDoc) {
      const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
      const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : null;
      bg = !isTransparent(htmlBg) ? htmlBg : !isTransparent(bodyBg) ? bodyBg : '#ffffff';
    }
    return bg;
  }

  async function drawSvg(src, width, height, opts, isDoc) {
    let img = await loadImage(src);
    if (isSafari) { // Safari иногда не успевает подгрузить встроенные ресурсы с первого раза
      await sleep(150);
      img = await loadImage(src);
    }
    const scale = clampScale(width, height, opts.scale);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const c2d = canvas.getContext('2d');
    const bg = pageBackground(opts, isDoc);
    if (bg) { c2d.fillStyle = bg; c2d.fillRect(0, 0, canvas.width, canvas.height); }
    c2d.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (isSafari) c2d.drawImage(img, 0, 0, canvas.width, canvas.height);
    c2d.getImageData(0, 0, 1, 1); // бросит SecurityError, если браузер «заразил» canvas
    return canvas;
  }

  async function captureSvg(opts) {
    const { root, ctx, width, height, isDoc, target } = await buildClone(opts, opts.lockLayout);
    await breathe(ctx);
    let xml;
    if (opts.lockLayout && ctx.pairs.length) {
      // Позиции оригинала снимаем до того, как на странице появится iframe
      const expected = expectedPositions(ctx.pairs, opts, isDoc, target);
      let frame = null;
      try {
        ({ frame } = await layoutInFrame(root, width, height, opts));
        ctx.moved = alignToOriginal(ctx.pairs, expected);
        await breathe(ctx);
        xml = new XMLSerializer().serializeToString(root);
      } catch (_) {
        // сверка не удалась — снимаем без неё
      } finally {
        if (frame) frame.remove();
      }
    }
    if (xml === undefined) xml = new XMLSerializer().serializeToString(root);
    await breathe(ctx);
    const svg = `<svg xmlns="${SVGNS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`;

    // Только data:URL: SVG с <foreignObject>, загруженный через blob:, Chrome считает
    // «чужим» и запрещает читать canvas (проверено).
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + await encodeChunked(svg, ctx);
    try {
      return { canvas: await drawSvg(dataUrl, width, height, opts, isDoc), ctx };
    } catch (e) {
      if (e.name === 'SecurityError') {
        throw new Error('[htmlShot] Браузер запретил читать SVG-снимок (так делает Safari). ' +
          'Помогут захват вкладки (htmlShot.captureTab) или html2canvas на странице.');
      }
      throw e;
    }
  }

  async function captureHtml2canvas(opts) {
    const target = opts.target || document.documentElement;
    const isDoc = target === document.documentElement;
    const de = document.documentElement;
    const h2cOpts = {
      scale: opts.scale, useCORS: true, logging: false,
      backgroundColor: pageBackground(opts, isDoc) || null,
      ignoreElements: (el) => el.hasAttribute && el.hasAttribute('data-html-shot-ignore'),
    };
    if (isDoc) {
      if (opts.fullPage) {
        h2cOpts.width = Math.max(de.scrollWidth, de.clientWidth);
        h2cOpts.height = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, de.clientHeight);
      } else {
        Object.assign(h2cOpts, { x: global.scrollX, y: global.scrollY }, viewportSize());
      }
      h2cOpts.scale = clampScale(h2cOpts.width, h2cOpts.height, opts.scale);
    }
    if (opts.corsProxy && typeof opts.corsProxy === 'string') h2cOpts.fixes = { proxy: opts.corsProxy.includes('{url}') ? opts.corsProxy : opts.corsProxy + '{url}' };
    return global.html2canvas(target, h2cOpts);
  }

  // Снимок без разрешений: копия DOM → SVG → canvas
  async function captureDom(userOpts = {}) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    concurrency = Math.max(1, opts.concurrency | 0 || 6);
    failed.clear();
    const restore = await preparePage(opts);
    let canvas, ctx = null, engine = 'svg';
    try {
      ({ canvas, ctx } = await captureSvg(opts));
    } catch (err) {
      if (!(opts.fallbackHtml2canvas && typeof global.html2canvas === 'function')) throw err;
      canvas = await captureHtml2canvas(opts);
      engine = 'html2canvas';
    } finally {
      restore();
      cleanupSandbox();
    }
    const report = {
      engine,
      failed: [...failed].map(([url, kind]) => ({ url, kind })),
      missingFonts: ctx ? [...ctx.missingFonts] : [],
      taintedCanvases: ctx ? ctx.taintedCanvases : 0,
      moved: ctx ? ctx.moved : 0,   // сколько элементов копии поправила сверка раскладки
    };
    if (engine === 'html2canvas' && canvas.h2cFailed) {
      canvas.h2cFailed.forEach((url) => report.failed.push({ url, kind: 'image' }));
    }
    report.problems = report.failed.length + report.missingFonts.length + report.taintedCanvases;
    canvas.htmlShotReport = report;
    api.lastReport = report;
    return canvas;
  }

  // Главный вход: пиксели вкладки, а если их не дали (method: 'auto') — DOM-рендер
  async function capture(userOpts = {}) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    if (opts.method === 'dom' || (opts.method === 'auto' && !pixelSupported())) return captureDom(opts);
    try {
      return await capturePixels(opts);
    } catch (err) {
      if (opts.method !== 'auto') throw err;
      const canvas = await captureDom(opts);
      canvas.htmlShotReport.pixelError = err && err.name;
      return canvas;
    }
  }

  function canvasToBlob(canvas, opts) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('[htmlShot] toBlob вернул null'))), opts.type, opts.quality);
      } catch (e) { reject(e); }
    });
  }

  async function toBlob(userOpts = {}) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    return canvasToBlob(await capture(opts), opts);
  }

  async function toDataURLApi(userOpts = {}) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    return (await capture(opts)).toDataURL(opts.type, opts.quality);
  }

  /* ---------------- сохранение и уведомления ---------------- */

  function autoFilename(type, suffix = '') {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const host = (location.hostname || 'page').replace(/[^\w.-]+/g, '_');
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type] || 'png';
    return `${host}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
      `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}${suffix}.${ext}`;
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  const TOAST = 'data-html-shot-toast';

  function removeToast() {
    const el = document.querySelector('[' + TOAST + ']');
    if (el) el.remove();
  }

  // toast(текст, 'info'|'ok'|'warn'|'error', [{label, onClick, secondary}], автозакрытие мс)
  function toast(text, kind, buttons, autoClose) {
    removeToast();
    const el = document.createElement('div');
    el.setAttribute(TOAST, '');
    el.setAttribute('data-html-shot-ignore', '');
    const bg = { info: '#222', ok: '#1b5e20', warn: '#8a5a00', error: '#c62828' }[kind || 'info'];
    el.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:12px 14px;' +
      'border-radius:10px;font:14px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;background:' + bg +
      ';box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:380px;display:block;box-sizing:border-box';
    const msg = document.createElement('div');
    msg.style.cssText = 'all:initial;font:inherit;color:inherit;display:block;white-space:pre-line';
    msg.textContent = text;
    el.appendChild(msg);
    if (buttons && buttons.length) {
      const row = document.createElement('div');
      row.style.cssText = 'all:initial;display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = b.label;
        btn.style.cssText = 'all:initial;cursor:pointer;font:600 13px system-ui,sans-serif;padding:6px 10px;' +
          'border-radius:6px;border:1px solid #fff;background:' + (b.secondary ? 'transparent' : '#fff') +
          ';color:' + (b.secondary ? '#fff' : '#111');
        btn.addEventListener('click', (e) => { e.stopPropagation(); b.onClick(); });
        row.appendChild(btn);
      }
      el.appendChild(row);
    }
    document.documentElement.appendChild(el);
    if (autoClose) setTimeout(() => { if (el.isConnected) el.remove(); }, autoClose);
    return el;
  }

  function describeProblems(report) {
    const parts = [];
    const imgs = report.failed.filter((f) => f.kind === 'image').length;
    const fonts = report.failed.filter((f) => f.kind === 'font').length + report.missingFonts.length;
    const other = report.failed.length - imgs - report.failed.filter((f) => f.kind === 'font').length;
    if (imgs) parts.push(`${imgs} картин(ок/ки) с других сайтов браузер не отдал (CORS)`);
    if (fonts) parts.push(`${fonts} шрифт(ов) не удалось встроить`);
    if (other) parts.push(`${other} стил(ей)/спрайт(ов) не загрузилось`);
    if (report.taintedCanvases) parts.push(`${report.taintedCanvases} <canvas> с чужими картинками не прочитать`);
    return parts.join(';\n');
  }

  function errorText(err) {
    if (err && err.name === 'NotAllowedError') return 'Захват вкладки отменён.';
    return (err && err.message) || String(err);
  }

  async function saveCanvas(canvas, opts, t0) {
    const blob = await canvasToBlob(canvas, opts);
    const name = opts.filename || autoFilename(opts.type);
    saveBlob(blob, name);
    const report = canvas.htmlShotReport;
    if (opts.ui) {
      const head = `✅ Сохранено: ${name}\n${Math.round(blob.size / 1024)} КБ, ${((performance.now() - t0) / 1000).toFixed(1)} с` +
        (report.engine === 'pixel' ? '' : report.engine === 'svg' ? ' (DOM)' : ` (${report.engine})`);
      if (report.problems && pixelSupported()) {
        offerPixel(head + '\n⚠️ ' + describeProblems(report) + '.\nТочный снимок (пиксели вкладки) видит всё.', 'warn', opts);
      } else if (report.problems) {
        toast(head + '\n⚠️ ' + describeProblems(report) + '.', 'warn', null, 8000);
      } else {
        toast(head, 'ok', null, 4000);
      }
    }
    return blob;
  }

  async function downloadPixel(opts) {
    const t0 = performance.now();
    return saveCanvas(await capturePixels(opts), opts, t0);
  }

  async function downloadDom(opts) {
    const t0 = performance.now();
    if (opts.ui) toast('📸 Снимаю ' + (opts.target ? 'элемент' : opts.fullPage ? 'страницу' : 'видимую область') + '…');
    return saveCanvas(await captureDom(opts), opts, t0);
  }

  function offerPixel(text, kind, opts) {
    toast(text, kind, [
      { label: '📸 Снять точно', onClick: () => downloadPixel(opts).catch((e) => toast('❌ ' + errorText(e), 'error', null, 8000)) },
      { label: 'Закрыть', secondary: true, onClick: removeToast },
    ], 20000);
  }

  async function download(userOpts = {}) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    try {
      if (opts.method === 'dom' || (opts.method === 'auto' && !pixelSupported())) return await downloadDom(opts);
      try {
        return await downloadPixel(opts);
      } catch (err) {
        // Захват вкладки браузер разрешает только по клику (из консоли DevTools клик не нужен)
        if (err && err.name === 'InvalidStateError' && opts.ui) {
          return await new Promise((resolve, reject) => toast('Для точного снимка браузеру нужен клик.', 'info', [
            { label: '📸 Снять точно', onClick: () => downloadPixel(opts).then(resolve, (e) =>
              (opts.method === 'auto' ? downloadDom(opts) : Promise.reject(e)).then(resolve, reject)) },
            { label: 'Без разрешения', secondary: true, onClick: () => downloadDom(opts).then(resolve, reject) },
          ]));
        }
        if (opts.method !== 'auto') throw err;
        return await downloadDom(opts); // отказались, выбрали не ту вкладку, браузер не умеет
      }
    } catch (err) {
      if (opts.ui) toast('❌ Не удалось сделать скриншот:\n' + errorText(err), 'error', [{ label: 'Закрыть', secondary: true, onClick: removeToast }], 10000);
      throw err;
    }
  }

  /* ---------------- пиксельный захват: как «Capture node screenshot» в DevTools ---------------- */
  // Берёт готовые пиксели вкладки (getDisplayMedia) и вырезает нужное: экран, элемент или
  // всю страницу (склейкой при прокрутке). Видно всё, что видит пользователь: картинки с
  // любых сайтов, чужие iframe, видео, WebGL, закрытый Shadow DOM. Нужно разрешение браузера.

  let live = null; // { stream, track, video } — открытый захват вкладки

  function pixelSupported() {
    const md = navigator.mediaDevices;
    return !!(md && md.getDisplayMedia) && global.isSecureContext !== false;
  }

  function namedError(name, message) {
    const e = new Error(message);
    e.name = name;
    return e;
  }

  function stop() {
    if (live) { live.stream.getTracks().forEach((t) => t.stop()); live = null; }
  }

  async function openStream() {
    if (live && live.track.readyState === 'live') return live;
    live = null;
    if (!pixelSupported()) throw namedError('NotSupportedError', 'Браузер не умеет захватывать вкладку (нужен Chrome/Edge/Firefox по https).');
    const dpr = global.devicePixelRatio || 1;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'browser', frameRate: { ideal: 30 },
        width: { ideal: Math.round(screen.width * dpr) }, height: { ideal: Math.round(screen.height * dpr) },
      },
      audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude',
    });
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    try {
      await video.play();
      for (let i = 0; i < 60 && !video.videoWidth; i++) await sleep(50);
      // Панель «идёт демонстрация» уменьшает окно не сразу — ждём, пока кадр и окно совпадут
      const settings = track.getSettings ? track.getSettings() : {};
      const matches = () => {
        const vw = global.innerWidth, vh = global.innerHeight;
        return video.videoWidth && Math.abs(vw / vh - video.videoWidth / video.videoHeight) / (vw / vh) < 0.02;
      };
      let ok = false;
      for (let i = 0; i < 25 && !(ok = matches()); i++) await sleep(100);
      if (!ok || (settings.displaySurface && settings.displaySurface !== 'browser')) {
        throw namedError('WrongSurfaceError', 'Выбрана не эта вкладка. Запустите снова и выберите текущую вкладку.');
      }
      await sleep(150);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
    live = { stream, track, video };
    track.addEventListener('ended', () => { if (live && live.track === track) live = null; });
    return live;
  }

  function waitVideoFrame(video) {
    return new Promise((resolve) => {
      if (!video.requestVideoFrameCallback) return setTimeout(resolve, 150);
      let done = false;
      video.requestVideoFrameCallback(() => { done = true; resolve(); });
      setTimeout(() => { if (!done) resolve(); }, 600);
    });
  }

  // Свежий кадр: после прокрутки/скрытия уведомления вкладка должна перерисоваться
  async function grabFrame(video) {
    await twoFrames();
    await sleep(120);
    await waitVideoFrame(video);
    await waitVideoFrame(video);
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return c;
  }

  // При склейке фиксированные/липкие элементы остаются только на первом кадре.
  // Предков снимаемого элемента не прячем — иначе спрячется и он сам.
  function hideFixedElements(keep) {
    const hidden = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.hasAttribute(TOAST) || (keep && el.contains(keep))) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    }
    return () => hidden.forEach(([el, v, p]) => (v ? el.style.setProperty('visibility', v, p) : el.style.removeProperty('visibility')));
  }

  function scrollToXY(x, y) {
    try { global.scrollTo({ left: x, top: y, behavior: 'instant' }); } catch (_) { global.scrollTo(x, y); }
  }

  // Запоминает прокрутку всех прокручиваемых предков элемента, чтобы вернуть её после снимка
  function rememberScroll(el) {
    const saved = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.scrollTop || n.scrollLeft || n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth) {
        saved.push([n, n.scrollLeft, n.scrollTop]);
      }
    }
    const wx = global.scrollX, wy = global.scrollY;
    return () => {
      saved.forEach(([n, x, y]) => { n.scrollLeft = x; n.scrollTop = y; });
      scrollToXY(wx, wy);
    };
  }

  function pixelReport(canvas) {
    const report = { engine: 'pixel', failed: [], missingFonts: [], taintedCanvases: 0, moved: 0, problems: 0 };
    canvas.htmlShotReport = report;
    api.lastReport = report;
    return canvas;
  }

  async function capturePixels(userOpts = {}) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    const target = opts.target && opts.target !== document.documentElement && opts.target !== document.body ? opts.target : null;
    const s = await openStream();
    const restoreScroll = target ? rememberScroll(target) : (() => { const x = global.scrollX, y = global.scrollY; return () => scrollToXY(x, y); })();
    let restoreFixed = () => {};
    removeToast();
    try {
      const video = s.video;
      const kx = () => video.videoWidth / global.innerWidth, ky = () => video.videoHeight / global.innerHeight;

      // 1) Только экран — кадр целиком, ровно то, что видит пользователь
      if (!target && !opts.fullPage) return pixelReport(await grabFrame(video));

      const vp = viewportSize(); // без полос прокрутки
      // 2) Элемент помещается в окно — докручиваем до него (и внутри прокручиваемых блоков) и вырезаем
      if (target) {
        let r = target.getBoundingClientRect();
        if (r.width <= vp.width && r.height <= vp.height) {
          if (r.left < 0 || r.top < 0 || r.right > vp.width || r.bottom > vp.height) {
            target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
            await twoFrames();
            r = target.getBoundingClientRect();
          }
          const frame = await grabFrame(video);
          const x0 = Math.max(0, Math.floor(r.left)), y0 = Math.max(0, Math.floor(r.top));
          const w = Math.max(1, Math.min(vp.width, Math.ceil(r.right)) - x0), h = Math.max(1, Math.min(vp.height, Math.ceil(r.bottom)) - y0);
          const out = document.createElement('canvas');
          out.width = Math.round(w * kx()); out.height = Math.round(h * ky());
          out.getContext('2d').drawImage(frame, x0 * kx(), y0 * ky(), out.width, out.height, 0, 0, out.width, out.height);
          return pixelReport(out);
        }
      }

      // 3) Больше окна (вся страница или крупный элемент) — склейка кадров при прокрутке окна
      const de = document.documentElement;
      let region;
      if (target) {
        const r = target.getBoundingClientRect();
        const x = Math.floor(r.left + global.scrollX), y = Math.floor(r.top + global.scrollY);
        region = { x, y, w: Math.ceil(r.right + global.scrollX) - x, h: Math.ceil(r.bottom + global.scrollY) - y };
      } else {
        region = {
          x: 0, y: 0,
          w: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0, vp.width),
          h: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, vp.height),
        };
      }
      let W = Math.round(region.w * kx()), H = Math.round(region.h * ky());
      if (W > 32767) { W = 32767; region.w = Math.floor(W / kx()); }
      const maxH = Math.floor(Math.min(32767, 268435456 / W));
      if (H > maxH) { H = maxH; region.h = Math.floor(H / ky()); } // лимит размера canvas
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const c2d = out.getContext('2d');
      let tiles = 0;
      for (let ty = region.y; ty < region.y + region.h; ty += vp.height) {
        for (let tx = region.x; tx < region.x + region.w; tx += vp.width) {
          const bw = Math.min(vp.width, region.x + region.w - tx), bh = Math.min(vp.height, region.y + region.h - ty);
          const inView = tx >= global.scrollX && ty >= global.scrollY &&
            tx + bw <= global.scrollX + vp.width && ty + bh <= global.scrollY + vp.height;
          if (!inView) scrollToXY(tx, ty);
          const frame = await grabFrame(video);
          const ax = global.scrollX, ay = global.scrollY; // браузер мог упереться в край страницы
          c2d.drawImage(frame, (tx - ax) * kx(), (ty - ay) * ky(), bw * kx(), bh * ky(),
            (tx - region.x) * kx(), (ty - region.y) * ky(), bw * kx(), bh * ky());
          if (++tiles === 1) restoreFixed = hideFixedElements(target);
          if (tiles > 400) break;
        }
      }
      return pixelReport(out);
    } finally {
      restoreFixed();
      restoreScroll();
      if (!opts.keepStream) stop();
    }
  }

  // Снимок одного элемента по-пиксельно — аналог «Capture node screenshot»
  function captureNode(el, userOpts = {}) {
    return capture(Object.assign({}, userOpts, { target: typeof el === 'string' ? document.querySelector(el) : el }));
  }

  const api = {
    version: '8.0', capture, captureNode, capturePixels, captureDom, toBlob, toDataURL: toDataURLApi, download,
    captureTab: capturePixels, stop, defaults: DEFAULTS, lastReport: null,
  };
  global.htmlShot = api;

  // Автозапуск (если вставили в консоль или подключили без data-manual)
  if (!(currentScript && currentScript.hasAttribute('data-manual'))) {
    const run = () => {
      // Настройки без правки файла: window.HTML_SHOT_CONFIG = { fullPage: true, method: 'dom' }
      api.download(global.HTML_SHOT_CONFIG || {})
        .catch(() => { /* ошибка уже показана в уведомлении */ });
    };
    document.readyState === 'complete' ? run() : global.addEventListener('load', run, { once: true });
  }
})(typeof window !== 'undefined' ? window : this);
