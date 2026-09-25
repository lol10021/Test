/*!
 * layout-bounds.js — «границы макета» страницы в HTML-файл (как «Показывать границы макета»
 * в Android или подсветка блоков в DevTools).
 *
 * Каждый видимый элемент — рамка точно по его месту и размеру на экране, внутри — его текст
 * на тех же позициях, построчно. Ничего из вёрстки сайта не копируется: всё измеряется
 * у браузера (getBoundingClientRect, Range.getClientRects), поэтому расположение совпадает
 * с экраном даже на сложных страницах. Обрезка прокручиваемыми блоками учитывается.
 * Наведите мышь на рамку в файле — подсветится, во всплывающей подсказке тег, классы и размер.
 *
 * Использование:
 *   1) Вставить в консоль — сразу скачает «сайт_дата_время_layout.html».
 *   2) <script src="layout-bounds.js" data-manual></script>, затем:
 *        await layoutBounds.download();                                  // видимая область
 *        await layoutBounds.download({ fullPage: true });                // вся страница
 *        await layoutBounds.download({ target: document.querySelector('#table') });
 *        const html = await layoutBounds.toHTML();
 *   Настройки до вставки в консоль: window.LAYOUT_BOUNDS_CONFIG = { fullPage: true, ... }
 */
(function (global) {
  'use strict';

  const currentScript = document.currentScript;

  const DEFAULTS = {
    target: null,            // элемент; по умолчанию вся страница
    fullPage: false,         // false — только то, что видно на экране; true — вся страница
    boxColor: 'depth',       // 'depth' — цвет по глубине вложенности; или один цвет: '#ff4d4f'
    radius: true,            // скругления рамок как у элементов (border-radius)
    fills: true,             // заливать рамку фоном элемента (сплошной цвет) — светлый текст на тёмных плашках остаётся читаемым
    text: true,              // текст элементов
    pseudoElements: true,    // ::before / ::after: absolute-декор (линии, подложки) и иконки-символы
    textColor: 'original',   // 'original' — цвет текста со страницы; или один цвет: '#e5e7eb'
    background: 'page',      // 'page' — фон страницы; или цвет: '#ffffff'
    media: 'box',            // картинки/SVG/canvas/video: 'box' — рамка с крестом; 'real' — само изображение
    margins: false,          // закрашивать внешние отступы (margin), как в Android
    padding: false,          // пунктиром показывать область содержимого (без padding)
    labels: true,            // подсказка при наведении: тег, классы, размер
    iframes: true,           // заходить в same-origin iframe
    shadowDom: true,         // заходить в Shadow DOM
    minSize: 0,              // не рисовать рамки меньше N px по обеим сторонам
    maxDepth: Infinity,      // глубина вложенности
    maxElements: Infinity,   // сколько элементов обойти
    filename: null,          // null — «сайт_2026-09-25_14-30-12_layout.html»
    ui: true,                // всплывающие уведомления при download()
  };

  const PALETTE = ['#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899', '#84cc16'];
  const MEDIA = new Set(['img', 'svg', 'canvas', 'video', 'picture', 'object', 'embed']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'head', 'title', 'base']);
  const IGNORE = 'data-html-shot-ignore';

  /* ---------------- геометрия ---------------- */

  const isect = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) };
  };
  const empty = (c) => c && (c.r <= c.l || c.b <= c.t);
  const px = (n) => Math.round(n * 100) / 100;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Прямоугольник в координатах снимка: окно (+ прокрутка для всей страницы) или цель
  function toOut(r, ctx, frameOrigin) {
    const x = r.left + frameOrigin.x + ctx.shiftX, y = r.top + frameOrigin.y + ctx.shiftY;
    return { l: x, t: y, r: x + r.width, b: y + r.height };
  }

  function clipsContent(cs) {
    return cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || /paint|strict|content/.test(cs.contain || '');
  }
  const makesContainingBlock = (cs) => cs.position !== 'static';
  const trapsFixed = (cs) => cs.transform !== 'none' || (cs.filter && cs.filter !== 'none') ||
    (cs.perspective && cs.perspective !== 'none') || /paint|layout|strict|content/.test(cs.contain || '') ||
    (cs.willChange && /transform|filter|perspective/.test(cs.willChange));

  /* ---------------- текст построчно ---------------- */

  function collapse(text, ws) {
    if (/^pre/.test(ws) || ws === 'break-spaces') return text;
    return text.replace(/[\t\n\r\f ]+/g, ' ');
  }

  // Делит текстовый узел на строки так, как их разложил браузер
  function textLines(node, ws) {
    const doc = node.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return [];
    const text = node.data;
    if (rects.length === 1) {
      const t = collapse(text, ws).trim() ? collapse(text, ws) : '';
      const r = rects[0];
      return t ? [{ text: /^pre/.test(ws) ? t : t.trim(), rect: r }] : [];
    }
    if (text.length > 20000) { // огромный узел: одним блоком
      const r = range.getBoundingClientRect();
      return [{ text: collapse(text, ws).trim(), rect: r }];
    }
    // Несколько строк: идём по символам и начинаем новую строку, когда символ «ушёл вниз»
    const lines = [];
    let cur = null;
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i);
      const len = cp > 0xffff ? 2 : 1;
      range.setStart(node, i);
      range.setEnd(node, i + len);
      const cr = [...range.getClientRects()].find((r) => r.width > 0 || r.height > 0);
      const ch = text.slice(i, i + len);
      i += len;
      if (!cr || cr.width === 0) { // схлопнутый пробел или перенос
        if (cur && !/\s$/.test(cur.text) && /\s/.test(ch)) cur.text += ' ';
        continue;
      }
      if (!cur || cr.top >= cur.b - 1 || cr.left < cur.l - 1 && cr.top > cur.t + 1) {
        cur = { text: '', l: cr.left, t: cr.top, r: cr.right, b: cr.bottom };
        lines.push(cur);
      }
      cur.text += /\s/.test(ch) && !/^pre/.test(ws) ? ' ' : ch;
      cur.l = Math.min(cur.l, cr.left); cur.r = Math.max(cur.r, cr.right);
      cur.t = Math.min(cur.t, cr.top); cur.b = Math.max(cur.b, cr.bottom);
    }
    return lines.filter((l) => l.text.trim()).map((l) => ({
      text: /^pre/.test(ws) ? l.text : l.text.trim(),
      rect: { left: l.l, top: l.t, width: l.r - l.l, height: l.b - l.t },
    }));
  }

  /* ---------------- порядок отрисовки (контексты наложения CSS) ---------------- */
  // Рамки и текст идут в файл в том порядке, в каком браузер рисует их на экране:
  // своё содержимое контекста → отрицательные z-index → обычный поток → позиционированные
  // (z-index: auto/0, в порядке документа) → положительные z-index. Поэтому закреплённые
  // шапки, меню, модалки и ручки-разделители лежат поверх того же, что и на экране.

  const newSC = () => ({ own: [], negs: [], flow: [], pos: [], posz: [] });

  function place(sc, z, entry) {
    if (z < 0) sc.negs.push({ z, entry });
    else if (z > 0) sc.posz.push({ z, entry });
    else sc.pos.push(entry);
  }

  function flattenItems(items, out) {
    for (const it of items) {
      if (typeof it === 'string') out.push(it);
      else if (it.sc) flattenSC(it.sc, out);
      else if (it.layer) flattenItems(it.layer, out);
    }
  }

  function flattenSC(sc, out) {
    flattenItems(sc.own, out);
    sc.negs.sort((a, b) => a.z - b.z).forEach((e) => flattenItems([e.entry], out));
    flattenItems(sc.flow, out);
    flattenItems(sc.pos, out);
    sc.posz.sort((a, b) => a.z - b.z).forEach((e) => flattenItems([e.entry], out));
    return out;
  }

  function createsStackingContext(cs, zApplies) {
    const none = (v) => !v || v === 'none';
    return (zApplies && cs.zIndex !== 'auto') || cs.position === 'fixed' || cs.position === 'sticky' ||
      parseFloat(cs.opacity) < 1 || !none(cs.transform) || !none(cs.translate) || !none(cs.scale) || !none(cs.rotate) ||
      !none(cs.filter) || !none(cs.backdropFilter) || cs.isolation === 'isolate' ||
      (cs.mixBlendMode && cs.mixBlendMode !== 'normal') || /paint|layout|strict|content/.test(cs.contain || '') ||
      !none(cs.clipPath) || !none(cs.maskImage) || /transform|opacity|filter|z-index|position/.test(cs.willChange || '');
  }

  /* ---------------- ::before / ::after ---------------- */
  // Прямоугольник псевдоэлемента браузер не отдаёт. Для absolute/fixed он вычисляется из
  // его left/top/width/height (декоративные линии, подложки, ручки); строчный псевдоэлемент
  // с текстом (иконка-символ) ставится в начало содержимого элемента.

  function pseudoText(content) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(content || '');
    return m ? m[1].replace(/\\(.)/g, '$1') : '';
  }

  function pseudoItems(el, cs, box, clip, depth, ctx) {
    const { opts } = ctx;
    const win = el.ownerDocument.defaultView;
    const items = [];
    const n = (c, p) => parseFloat(c.getPropertyValue(p)) || 0;
    for (const which of ['::before', '::after']) {
      const pcs = win.getComputedStyle(el, which);
      const content = pcs.content;
      if (!content || content === 'none' || content === 'normal' || pcs.display === 'none' || pcs.visibility === 'hidden') continue;
      const text = pseudoText(content);
      let pb = null;
      if ((pcs.position === 'absolute' && cs.position !== 'static') || pcs.position === 'fixed') {
        // containing block — padding-box элемента (для fixed — окно)
        const cb = pcs.position === 'fixed'
          ? { l: ctx.shiftX, t: ctx.shiftY, r: ctx.shiftX + global.innerWidth, b: ctx.shiftY + global.innerHeight }
          : { l: box.l + n(cs, 'border-left-width'), t: box.t + n(cs, 'border-top-width'), r: box.r - n(cs, 'border-right-width'), b: box.b - n(cs, 'border-bottom-width') };
        const extraW = pcs.boxSizing === 'border-box' ? 0 : n(pcs, 'padding-left') + n(pcs, 'padding-right') + n(pcs, 'border-left-width') + n(pcs, 'border-right-width');
        const extraH = pcs.boxSizing === 'border-box' ? 0 : n(pcs, 'padding-top') + n(pcs, 'padding-bottom') + n(pcs, 'border-top-width') + n(pcs, 'border-bottom-width');
        const w = n(pcs, 'width') + extraW, h = n(pcs, 'height') + extraH;
        const L = pcs.left !== 'auto' ? cb.l + n(pcs, 'left') + n(pcs, 'margin-left') : cb.r - n(pcs, 'right') - n(pcs, 'margin-right') - w;
        const T = pcs.top !== 'auto' ? cb.t + n(pcs, 'top') + n(pcs, 'margin-top') : cb.b - n(pcs, 'bottom') - n(pcs, 'margin-bottom') - h;
        if (w > 0 && h > 0) pb = { l: L, t: T, r: L + w, b: T + h };
      } else if (text.trim()) {
        // строчный: иконка-символ в начале содержимого
        const l = box.l + n(cs, 'border-left-width') + n(cs, 'padding-left');
        const t = box.t + n(cs, 'border-top-width') + n(cs, 'padding-top');
        const lh = pcs.lineHeight === 'normal' ? n(pcs, 'font-size') * 1.2 : n(pcs, 'line-height');
        pb = { l, t, r: l + n(pcs, 'font-size') * Math.max(1, text.length) * 0.6, b: t + lh, textOnly: true };
      }
      if (!pb || empty(isect(clip, pb)) || empty(isect(ctx.area, pb))) continue;
      if (!pb.textOnly) {
        const bg = opts.fills && pcs.backgroundColor && !/^(transparent|rgba\([^)]*,\s*0\s*\))$/.test(pcs.backgroundColor) ? `background-color:${pcs.backgroundColor};` : '';
        const radius = opts.radius && pcs.borderRadius && pcs.borderRadius !== '0px' ? `border-radius:${pcs.borderRadius};` : '';
        const title = opts.labels ? ` title="${esc(el.localName + which + '  ' + Math.round(pb.r - pb.l) + '×' + Math.round(pb.b - pb.t))}"` : '';
        items.push(`<b class="b"${title} style="left:${px(pb.l)}px;top:${px(pb.t)}px;width:${px(pb.r - pb.l)}px;height:${px(pb.b - pb.t)}px;` +
          `border-color:${boxColor(depth + 1, opts)};${bg}${radius}${clipCss(pb, clip)}"></b>`);
      }
      if (opts.text && text.trim()) {
        const color = opts.textColor === 'original' ? pcs.color : opts.textColor;
        const h = pb.b - pb.t;
        items.push(`<i class="t" style="left:${px(pb.l)}px;top:${px(pb.t)}px;height:${px(h)}px;line-height:${px(h)}px;` +
          `font:${pcs.fontStyle} ${pcs.fontWeight} ${pcs.fontSize} ${esc(pcs.fontFamily)};color:${color};${clipCss(pb, clip)}">${esc(text)}</i>`);
      }
    }
    return items;
  }

  /* ---------------- обход страницы ---------------- */

  function childNodesOf(node, opts) {
    if (node.shadowRoot && opts.shadowDom) return [...node.shadowRoot.childNodes];
    if (node.localName === 'slot' && node.assignedNodes) {
      const a = node.assignedNodes({ flatten: true });
      if (a.length) return a;
    }
    return [...node.childNodes];
  }

  function describe(el, r) {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 6) : [];
    return el.localName + (el.id ? '#' + el.id : '') + (cls.length ? '.' + cls.join('.') : '') +
      `  ${Math.round(r.r - r.l)}×${Math.round(r.b - r.t)}`;
  }

  function boxColor(depth, opts) {
    return opts.boxColor === 'depth' ? PALETTE[depth % PALETTE.length] : opts.boxColor;
  }

  function clipCss(box, clip) {
    if (!clip) return '';
    const top = clip.t - box.t, left = clip.l - box.l, right = box.r - clip.r, bottom = box.b - clip.b;
    if (top <= 0 && left <= 0 && right <= 0 && bottom <= 0) return '';
    return `clip-path:inset(${px(Math.max(0, top))}px ${px(Math.max(0, right))}px ${px(Math.max(0, bottom))}px ${px(Math.max(0, left))}px);`;
  }

  function mediaSource(el, opts) {
    if (opts.media !== 'real') return null;
    try {
      if (el.localName === 'img') return el.currentSrc || el.src || null;
      if (el.localName === 'canvas') return el.toDataURL();
      if (el.localName === 'video' && el.videoWidth) {
        const c = document.createElement('canvas');
        c.width = el.videoWidth; c.height = el.videoHeight;
        c.getContext('2d').drawImage(el, 0, 0);
        return c.toDataURL();
      }
      if (el.localName === 'svg') {
        const s = new XMLSerializer().serializeToString(el);
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
      }
    } catch (_) { /* чужие пиксели */ }
    return null;
  }

  // state: { clipAll, clipAbs, clipFixed } — какая обрезка действует на обычных, absolute и fixed потомков
  // sc — текущий контекст наложения, flow — куда класть содержимое в обычном потоке
  function walk(node, ctx, state, depth, fo, sc, flow) {
    const { opts } = ctx;
    if (ctx.count >= opts.maxElements) return;

    if (node.nodeType === 3) {
      if (!opts.text || !state.visible) return;
      const parent = node.parentElement || (node.parentNode && node.parentNode.host);
      if (!parent) return;
      const pcs = parent.ownerDocument.defaultView.getComputedStyle(parent);
      for (const line of textLines(node, pcs.whiteSpace)) {
        const box = toOut(line.rect, ctx, fo);
        const clip = state.clipAll;
        if (clip && (empty(isect(clip, box)))) continue;
        if (!ctx.area || empty(isect(ctx.area, box))) continue;
        const color = opts.textColor === 'original' ? pcs.color : opts.textColor;
        flow.push(`<i class="t" style="left:${px(box.l)}px;top:${px(box.t)}px;height:${px(box.b - box.t)}px;` +
          `line-height:${px(box.b - box.t)}px;font:${pcs.fontStyle} ${pcs.fontWeight} ${pcs.fontSize} ${esc(pcs.fontFamily)};` +
          `letter-spacing:${pcs.letterSpacing};text-transform:${pcs.textTransform};color:${color};${clipCss(box, clip)}">` +
          `${esc(line.text)}</i>`);
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.localName;
    if (SKIP.has(tag) || el.hasAttribute(IGNORE)) return;
    const win = el.ownerDocument.defaultView;
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none') return;
    ctx.count++;

    // Какая обрезка действует на этот элемент — по его способу позиционирования
    const pos = cs.position;
    const myClip = pos === 'fixed' ? state.clipFixed : pos === 'absolute' ? state.clipAbs : state.clipAll;
    const visible = cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && parseFloat(cs.opacity) !== 0;
    const subtreeVisible = state.visible && parseFloat(cs.opacity) !== 0;

    // В какой слой рисуется элемент и его потомки
    const zApplies = pos !== 'static' || state.flexItem;
    const z = cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex, 10) || 0);
    let out, childSC = sc, childFlow = flow;
    if (createsStackingContext(cs, zApplies)) {
      const nsc = newSC();
      place(sc, zApplies ? z : 0, { sc: nsc });
      out = nsc.own; childSC = nsc; childFlow = nsc.flow;
    } else if (pos !== 'static') {
      // Позиционированный без z-index: рисуется поверх потока, но z-index его потомков
      // действует в том же контексте, что и он сам
      const layer = [];
      sc.pos.push({ layer });
      out = layer; childFlow = layer;
    } else {
      out = flow;
    }

    let box = null;
    if (cs.display !== 'contents') {
      const r = el.getBoundingClientRect();
      box = toOut(r, ctx, fo);
      const big = (box.r - box.l) >= opts.minSize || (box.b - box.t) >= opts.minSize;
      const shown = box.r - box.l > 0 && box.b - box.t > 0 && big && visible && subtreeVisible &&
        !empty(isect(myClip, box)) && ctx.area && !empty(isect(ctx.area, box)) && depth <= opts.maxDepth;
      if (shown) {
        const isMedia = MEDIA.has(tag);
        const radius = opts.radius && cs.borderRadius && cs.borderRadius !== '0px' ? `border-radius:${cs.borderRadius};` : '';
        let extra = '';
        if (opts.fills && cs.backgroundColor && !/^(transparent|rgba\([^)]*,\s*0\s*\))$/.test(cs.backgroundColor)) {
          extra += `background-color:${cs.backgroundColor};`;
        }
        if (isMedia) {
          const src = mediaSource(el, opts);
          if (src) extra += `background-image:url(&quot;${esc(src)}&quot;);background-size:100% 100%;background-repeat:no-repeat;`;
        }
        const title = opts.labels ? ` title="${esc(describe(el, box))}"` : '';
        const cls = 'b' + (isMedia && opts.media !== 'real' ? ' m' : '') + (tag === 'html' || tag === 'body' ? ' r' : '');
        out.push(`<b class="${cls}"${title} style="left:${px(box.l)}px;top:${px(box.t)}px;` +
          `width:${px(box.r - box.l)}px;height:${px(box.b - box.t)}px;border-color:${boxColor(depth, opts)};${radius}${extra}${clipCss(box, myClip)}"></b>`);
        if (opts.margins) {
          const m = (p) => parseFloat(cs.getPropertyValue('margin-' + p)) || 0;
          const mt = m('top'), mr = m('right'), mb = m('bottom'), ml = m('left');
          if (mt > 0 || mr > 0 || mb > 0 || ml > 0) {
            const mbox = { l: box.l - Math.max(0, ml), t: box.t - Math.max(0, mt), r: box.r + Math.max(0, mr), b: box.b + Math.max(0, mb) };
            out.push(`<b class="g" style="left:${px(mbox.l)}px;top:${px(mbox.t)}px;width:${px(mbox.r - mbox.l)}px;height:${px(mbox.b - mbox.t)}px;` +
              `border-width:${px(Math.max(0, mt))}px ${px(Math.max(0, mr))}px ${px(Math.max(0, mb))}px ${px(Math.max(0, ml))}px;${clipCss(mbox, myClip)}"></b>`);
          }
        }
        if (opts.padding) {
          const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
          const inner = {
            l: box.l + n('border-left-width') + n('padding-left'), t: box.t + n('border-top-width') + n('padding-top'),
            r: box.r - n('border-right-width') - n('padding-right'), b: box.b - n('border-bottom-width') - n('padding-bottom'),
          };
          if (inner.r > inner.l && inner.b > inner.t && (inner.l > box.l + 0.5 || inner.t > box.t + 0.5)) {
            out.push(`<b class="p" style="left:${px(inner.l)}px;top:${px(inner.t)}px;width:${px(inner.r - inner.l)}px;` +
              `height:${px(inner.b - inner.t)}px;border-color:${boxColor(depth, opts)};${clipCss(inner, myClip)}"></b>`);
          }
        }
        // Поля ввода: их значение — тоже текст на экране
        if (opts.text && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
          let v = tag === 'select' ? (el.selectedOptions[0] ? el.selectedOptions[0].text : '') : el.value;
          if (!v && el.placeholder) v = el.placeholder;
          if (v && !/^(checkbox|radio|range|color|file|hidden)$/.test(el.type || '')) {
            const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
            const l = box.l + n('border-left-width') + n('padding-left'), t = box.t + n('border-top-width') + n('padding-top');
            const h = box.b - n('border-bottom-width') - n('padding-bottom') - t;
            out.push(`<i class="t" style="left:${px(l)}px;top:${px(t)}px;height:${px(h)}px;line-height:${px(h)}px;` +
              `font:${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${esc(cs.fontFamily)};` +
              `color:${opts.textColor === 'original' ? cs.color : opts.textColor};${clipCss(box, myClip)}">${esc(v)}</i>`);
          }
        }
      }
    }
    if (MEDIA.has(tag) || tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (opts.pseudoElements && box && subtreeVisible && depth < opts.maxDepth) {
      for (const it of pseudoItems(el, cs, box, myClip, depth, ctx)) out.push(it);
    }

    // Обрезка для потомков
    let clipAll = myClip, clipAbs = state.clipAbs, clipFixed = state.clipFixed;
    if (box && clipsContent(cs) && tag !== 'html' && tag !== 'body') {
      const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
      const padBox = { l: box.l + n('border-left-width'), t: box.t + n('border-top-width'), r: box.r - n('border-right-width'), b: box.b - n('border-bottom-width') };
      clipAll = isect(myClip, padBox);
    }
    if (makesContainingBlock(cs) || trapsFixed(cs)) clipAbs = clipAll;
    if (trapsFixed(cs)) clipFixed = clipAll;
    const next = { clipAll, clipAbs, clipFixed, visible: subtreeVisible, flexItem: /(^|-)(flex|grid)$/.test(cs.display) };

    if (tag === 'iframe') {
      if (!opts.iframes) return;
      let fdoc = null;
      try { fdoc = el.contentDocument; } catch (_) {}
      if (!fdoc || !fdoc.documentElement || !box) return;
      const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
      const r = el.getBoundingClientRect();
      const inner = { x: fo.x + r.left + n('border-left-width') + n('padding-left'), y: fo.y + r.top + n('border-top-width') + n('padding-top') };
      const view = { l: inner.x + ctx.shiftX, t: inner.y + ctx.shiftY, r: inner.x + ctx.shiftX + el.clientWidth, b: inner.y + ctx.shiftY + el.clientHeight };
      const c = isect(myClip, view);
      // Документ во фрейме — отдельный контекст, рисуется целиком на месте iframe
      const fsc = newSC();
      out.push({ sc: fsc });
      walk(fdoc.documentElement, ctx, { clipAll: c, clipAbs: c, clipFixed: c, visible: next.visible }, depth + 1, inner, fsc, fsc.flow);
      return;
    }
    for (const k of childNodesOf(el, opts)) walk(k, ctx, next, depth + 1, fo, childSC, childFlow);
  }

  /* ---------------- сборка файла ---------------- */

  function pageBackground() {
    const t = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\s*\)$/.test(c);
    const h = getComputedStyle(document.documentElement).backgroundColor;
    const b = document.body ? getComputedStyle(document.body).backgroundColor : '';
    return !t(h) ? h : !t(b) ? b : '#ffffff';
  }

  async function toHTML(userOpts = {}) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    if (typeof opts.target === 'string') opts.target = document.querySelector(opts.target);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const de = document.documentElement;
    const isDoc = !opts.target || opts.target === de || opts.target === document.body;
    let width, height, shiftX = 0, shiftY = 0;
    if (!isDoc) {
      const r = opts.target.getBoundingClientRect();
      width = Math.ceil(r.width); height = Math.ceil(r.height);
      shiftX = -r.left; shiftY = -r.top;
    } else if (opts.fullPage) {
      width = Math.max(de.scrollWidth, de.clientWidth);
      height = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, de.clientHeight);
      shiftX = global.scrollX; shiftY = global.scrollY;
    } else {
      width = global.innerWidth; height = global.innerHeight;
    }
    const ctx = { opts, count: 0, shiftX, shiftY, area: { l: 0, t: 0, r: width, b: height } };
    const t0 = performance.now();
    const root = isDoc ? de : opts.target;
    const start = { clipAll: null, clipAbs: null, clipFixed: null, visible: true };
    // fixed-элементы на всей странице стоят там, где их видно сейчас (как на скриншоте)
    const rootSC = newSC();
    walk(root, ctx, start, 0, { x: 0, y: 0 }, rootSC, rootSC.flow);
    const items = flattenSC(rootSC, []);

    const bg = opts.background === 'page' ? pageBackground() : opts.background;
    const html = `<!DOCTYPE html>
<!-- layout bounds of ${esc(location.href)} at ${new Date().toISOString()} by layout-bounds.js -->
<html><head><meta charset="utf-8"><title>Границы макета — ${esc(document.title || location.hostname)}</title>
<style>
html,body{margin:0;background:${bg}}
#L{position:relative;width:${width}px;height:${height}px;overflow:hidden}
.b,.g,.p,.t{position:absolute;box-sizing:border-box;margin:0;padding:0}
.b{border:1px solid;background-clip:padding-box}
.b:hover{box-shadow:inset 0 0 0 999px rgba(255,64,64,.18);border-color:#ff4040!important}
.r{pointer-events:none}
.m{background-image:linear-gradient(to top right,transparent calc(50% - .5px),currentColor calc(50% - .5px),currentColor calc(50% + .5px),transparent calc(50% + .5px)),linear-gradient(to bottom right,transparent calc(50% - .5px),currentColor calc(50% - .5px),currentColor calc(50% + .5px),transparent calc(50% + .5px));color:rgba(128,128,128,.5)}
.g{border-style:solid;border-color:rgba(236,72,153,.28);pointer-events:none}
.p{border:1px dashed;opacity:.55;pointer-events:none}
.t{white-space:pre;overflow:visible;pointer-events:none;font-style:normal}
</style></head><body><div id="L">
${items.join('\n')}
</div></body></html>`;
    api.lastReport = { elements: ctx.count, items: items.length, width, height, ms: Math.round(performance.now() - t0), bytes: html.length };
    return html;
  }

  /* ---------------- сохранение ---------------- */

  function autoFilename() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const host = (location.hostname || 'page').replace(/[^\w.-]+/g, '_');
    return `${host}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_layout.html`;
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

  function toast(text, ok) {
    const el = document.createElement('div');
    el.setAttribute(IGNORE, '');
    el.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:12px 14px;border-radius:10px;' +
      'font:14px/1.35 system-ui,sans-serif;color:#fff;white-space:pre-line;box-shadow:0 6px 24px rgba(0,0,0,.35);background:' +
      (ok ? '#1b5e20' : '#c62828');
    el.textContent = text;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), ok ? 4000 : 10000);
  }

  async function download(userOpts = {}) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    try {
      const html = await toHTML(opts);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const name = opts.filename || autoFilename();
      saveBlob(blob, name);
      const r = api.lastReport;
      if (opts.ui) toast(`✅ Сохранено: ${name}\n${r.items} рамок и строк, ${(blob.size / 1024).toFixed(0)} КБ, ${(r.ms / 1000).toFixed(1)} с`, true);
      return blob;
    } catch (err) {
      if (opts.ui) toast('❌ Не удалось сохранить:\n' + ((err && err.message) || err), false);
      throw err;
    }
  }

  const api = { version: '1.0', toHTML, download, defaults: DEFAULTS, lastReport: null };
  global.layoutBounds = api;

  if (!(currentScript && currentScript.hasAttribute('data-manual'))) {
    const run = () => api.download(global.LAYOUT_BOUNDS_CONFIG || {}).catch(() => { /* показано в уведомлении */ });
    document.readyState === 'complete' ? run() : global.addEventListener('load', run, { once: true });
  }
})(typeof window !== 'undefined' ? window : this);
