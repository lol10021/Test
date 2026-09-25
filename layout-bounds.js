/*!
 * layout-bounds.js — «границы макета» страницы (как «Показывать границы макета» в Android
 * или подсветка блоков в DevTools), с панелью настроек и скачиванием в HTML или PNG.
 *
 * Каждый видимый элемент — рамка точно по его месту и размеру на экране, внутри — его текст
 * на тех же позициях, построчно, в том же порядке слоёв, что и на экране. Ничего из вёрстки
 * сайта не копируется: всё измеряется у браузера (getBoundingClientRect, Range.getClientRects).
 *
 * Вставьте в консоль — поверх страницы откроется предпросмотр и панель:
 *   глубина «от» и «до», цвет и яркость рамок, текст, заливка, отступы, поля, «поверх страницы»,
 *   область (экран / вся страница), картинки (рамкой / как есть), «Скачать HTML», «Скачать PNG».
 *   Панель перетаскивается за заголовок, Esc — закрыть. Наведите мышь на рамку — подсказка
 *   с тегом, классами и размером.
 *
 * Без панели (<script src="layout-bounds.js" data-manual></script>):
 *   await layoutBounds.download({ fullPage: true, theme: 'mono', color: '#22c55e' });  // HTML
 *   await layoutBounds.downloadPNG({ depthTo: 6 });                                      // PNG
 *   const html = await layoutBounds.toHTML({ target: document.querySelector('#table') });
 *   layoutBounds.open() / layoutBounds.close()                                           // панель
 * Настройки до вставки в консоль: window.LAYOUT_BOUNDS_CONFIG = { fullPage: true, theme: 'vivid' }
 */
(function (global) {
  'use strict';

  const currentScript = document.currentScript;

  // Что и как собирать со страницы (вид — цвета, глубина, переключатели — в VIEW_DEFAULTS ниже)
  const DEFAULTS = {
    target: null,            // элемент или селектор; по умолчанию вся страница
    fullPage: false,         // false — только то, что видно на экране; true — вся страница
    media: 'box',            // картинки/SVG/canvas/video: 'box' — рамка с крестом; 'real' — само изображение
    radius: true,            // скругления рамок как у элементов (border-radius)
    textColor: 'original',   // 'original' — цвет текста со страницы; или один цвет: '#e5e7eb'
    pseudoElements: true,    // ::before / ::after: absolute-декор (линии, подложки) и иконки-символы
    labels: true,            // подсказка при наведении: тег, классы, размер
    iframes: true,           // заходить в same-origin iframe
    shadowDom: true,         // заходить в Shadow DOM
    minSize: 0,              // не рисовать рамки меньше N px по обеим сторонам
    maxDepth: Infinity,      // глубже не обходить
    maxElements: Infinity,   // сколько элементов обойти
    filename: null,          // имя файла; null — «сайт_дата_время_layout.html/png»
  };

  const VIVID = ['#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899', '#84cc16'];
  const MAX_D = 60; // глубже — один класс
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
        items.push(`<b class="b ${dcls(depth + 1, ctx)}"${title} style="left:${px(pb.l)}px;top:${px(pb.t)}px;width:${px(pb.r - pb.l)}px;height:${px(pb.b - pb.t)}px;` +
          `${bg}${radius}${clipCss(pb, clip)}"></b>`);
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

  // Класс глубины: цвет и видимость рамки задают правила темы (меняются без повторного обхода)
  function dcls(depth, ctx) {
    const d = Math.min(depth, MAX_D);
    if (d > ctx.maxDepthSeen) ctx.maxDepthSeen = d;
    return 'd' + d;
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
        const cls = 'b ' + dcls(depth, ctx) + (isMedia && opts.media !== 'real' ? ' m' : '') + (tag === 'html' || tag === 'body' ? ' r' : '');
        out.push(`<b class="${cls}"${title} style="left:${px(box.l)}px;top:${px(box.t)}px;` +
          `width:${px(box.r - box.l)}px;height:${px(box.b - box.t)}px;${radius}${extra}${clipCss(box, myClip)}"></b>`);
        {  // margin и padding пишутся всегда, показываются переключателями
          const m = (p) => parseFloat(cs.getPropertyValue('margin-' + p)) || 0;
          const mt = m('top'), mr = m('right'), mb = m('bottom'), ml = m('left');
          if (mt > 0 || mr > 0 || mb > 0 || ml > 0) {
            const mbox = { l: box.l - Math.max(0, ml), t: box.t - Math.max(0, mt), r: box.r + Math.max(0, mr), b: box.b + Math.max(0, mb) };
            out.push(`<b class="g" style="left:${px(mbox.l)}px;top:${px(mbox.t)}px;width:${px(mbox.r - mbox.l)}px;height:${px(mbox.b - mbox.t)}px;` +
              `border-width:${px(Math.max(0, mt))}px ${px(Math.max(0, mr))}px ${px(Math.max(0, mb))}px ${px(Math.max(0, ml))}px;${clipCss(mbox, myClip)}"></b>`);
          }
        }
        {
          const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
          const inner = {
            l: box.l + n('border-left-width') + n('padding-left'), t: box.t + n('border-top-width') + n('padding-top'),
            r: box.r - n('border-right-width') - n('padding-right'), b: box.b - n('border-bottom-width') - n('padding-bottom'),
          };
          if (inner.r > inner.l && inner.b > inner.t && (inner.l > box.l + 0.5 || inner.t > box.t + 0.5)) {
            out.push(`<b class="p ${dcls(depth, ctx)}" style="left:${px(inner.l)}px;top:${px(inner.t)}px;width:${px(inner.r - inner.l)}px;` +
              `height:${px(inner.b - inner.t)}px;${clipCss(inner, myClip)}"></b>`);
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

  /* ---------------- сбор данных ---------------- */

  function pageBackground() {
    const t = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\s*\)$/.test(c);
    const h = getComputedStyle(document.documentElement).backgroundColor;
    const b = document.body ? getComputedStyle(document.body).backgroundColor : '';
    return !t(h) ? h : !t(b) ? b : '#ffffff';
  }

  function isDarkColor(c) {
    const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c || '');
    if (!m) return false;
    return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.45;
  }

  // Обходит страницу и собирает рамки и текст. Вид (цвета, глубина, переключатели) сюда
  // не входит — он задаётся правилами CSS и меняется без повторного обхода.
  async function collect(userOpts = {}) {
    const opts = Object.assign({}, DEFAULTS, userOpts, { text: true, fills: true });
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
    const ctx = { opts, count: 0, maxDepthSeen: 0, shiftX, shiftY, area: { l: 0, t: 0, r: width, b: height } };
    const t0 = performance.now();
    const rootSC = newSC();
    // fixed-элементы на всей странице стоят там, где их видно сейчас (как на скриншоте)
    walk(isDoc ? de : opts.target, ctx, { clipAll: null, clipAbs: null, clipFixed: null, visible: true }, 0, { x: 0, y: 0 }, rootSC, rootSC.flow);
    const items = flattenSC(rootSC, []);
    const bg = pageBackground();
    return {
      items, width, height, bg, dark: isDarkColor(bg), maxDepth: ctx.maxDepthSeen,
      elements: ctx.count, ms: Math.round(performance.now() - t0),
      scrollY: isDoc && opts.fullPage ? global.scrollY : 0,
    };
  }

  /* ---------------- вид: темы и переключатели ---------------- */

  const VIEW_DEFAULTS = {
    theme: 'soft',      // 'soft' — спокойные рамки одного оттенка; 'mono' — свой цвет; 'vivid' — яркие по глубине
    color: '#60a5fa',   // цвет для 'mono'
    opacity: 0.55,      // яркость рамок 0..1
    depthFrom: 0,       // показывать рамки с этой глубины…
    depthTo: Infinity,  // …по эту
    text: true,         // текст
    fills: true,        // заливка фоном элемента
    margins: false,     // внешние отступы
    padding: false,     // область содержимого пунктиром
    overlay: false,     // «поверх страницы»: прозрачный фон, только рамки
  };

  function rgba(hex, a) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  }

  function borderColor(d, view, dark) {
    const a = Math.max(0.05, Math.min(1, view.opacity));
    if (view.theme === 'vivid') return rgba(VIVID[d % VIVID.length], a);
    if (view.theme === 'mono') return rgba(view.color, a);
    // soft: один спокойный оттенок, глубина — лёгкая смена светлоты
    const l = dark ? 74 - (d % 5) * 5 : 40 + (d % 5) * 5;
    return `hsla(214,42%,${l}%,${a})`;
  }

  function themeCSS(data, view) {
    let css = `html,body{background:${view.overlay ? 'transparent' : data.bg}}\n`;
    for (let d = 0; d <= data.maxDepth; d++) {
      const on = d >= view.depthFrom && d <= view.depthTo;
      css += on ? `.d${d}{border-color:${borderColor(d, view, data.dark)}}\n`
        : `.d${d}{border-color:transparent}.b.d${d}{pointer-events:none}\n`;
    }
    return css;
  }

  function viewClasses(view) {
    return [!view.text || view.overlay ? 'nt' : '', !view.fills || view.overlay ? 'nf' : '',
      view.margins ? 'sm' : '', view.padding ? 'sp' : ''].filter(Boolean).join(' ');
  }

  const BASE_CSS = `html,body{margin:0}
#L{position:relative;overflow:hidden}
.b,.g,.p,.t{position:absolute;box-sizing:border-box;margin:0;padding:0}
.b{border:1px solid transparent;background-clip:padding-box}
.b:hover{box-shadow:inset 0 0 0 999px rgba(96,165,250,.14);border-color:#60a5fa!important}
.r{pointer-events:none}
.m{background-image:linear-gradient(to top right,transparent calc(50% - .5px),currentColor calc(50% - .5px),currentColor calc(50% + .5px),transparent calc(50% + .5px)),linear-gradient(to bottom right,transparent calc(50% - .5px),currentColor calc(50% - .5px),currentColor calc(50% + .5px),transparent calc(50% + .5px));color:rgba(148,163,184,.35)}
.g{border-style:solid;border-color:rgba(251,191,36,.16);pointer-events:none}
.p{border:1px dashed;pointer-events:none}
.t{white-space:pre;overflow:visible;pointer-events:none;font-style:normal}
#L.nt .t{display:none}
#L.nf .b{background-color:transparent!important}
#L:not(.sm) .g,#L:not(.sp) .p{display:none}`;

  function buildDoc(data, view) {
    return `<!DOCTYPE html>
<!-- layout bounds of ${esc(location.href)} at ${new Date().toISOString()} by layout-bounds.js -->
<html><head><meta charset="utf-8"><title>Границы макета — ${esc(document.title || location.hostname)}</title>
<style id="lb-base">${BASE_CSS}</style>
<style id="lb-theme">${themeCSS(data, view)}</style>
</head><body><div id="L" class="${viewClasses(view)}" style="width:${data.width}px;height:${data.height}px">
${data.items.join('\n')}
</div></body></html>`;
  }

  function applyView(doc, data, view) {
    doc.getElementById('lb-theme').textContent = themeCSS(data, view);
    doc.getElementById('L').className = viewClasses(view);
  }

  /* ---------------- PNG ---------------- */

  async function inlineMedia(root) {
    await Promise.all([...root.querySelectorAll('.b[style*="url("]')].map(async (el) => {
      const m = /url\(["']?((?!data:)[^"')]+)["']?\)/.exec(el.getAttribute('style'));
      if (!m) return;
      try {
        const blob = await (await fetch(m[1], { mode: 'cors' })).blob();
        const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
        el.setAttribute('style', el.getAttribute('style').replace(m[1], data));
      } catch (_) { /* чужой сервер без CORS — останется пустым */ }
    }));
  }

  // Рисует собранный документ в PNG через SVG <foreignObject>: в нём только простые блоки и текст
  async function renderPNG(doc, data) {
    const w = data.width, h = data.height;
    const dpr = global.devicePixelRatio || 1;
    const scale = Math.max(0.1, Math.min(dpr, 32767 / w, 32767 / h, Math.sqrt(268435456 / (w * h))));
    const wrap = doc.createElement('div');
    const st = doc.createElement('style');
    st.textContent = doc.getElementById('lb-base').textContent + '\n' + doc.getElementById('lb-theme').textContent +
      `\ndiv.lb-wrap{width:${w}px;height:${h}px;background:${doc.defaultView.getComputedStyle(doc.body).backgroundColor}}`;
    wrap.className = 'lb-wrap';
    wrap.appendChild(st);
    const L = doc.getElementById('L').cloneNode(true);
    L.querySelectorAll('[title]').forEach((e) => e.removeAttribute('title'));
    wrap.appendChild(L);
    await inlineMedia(wrap);
    const xml = new XMLSerializer().serializeToString(wrap);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Браузер не смог нарисовать PNG')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Не удалось собрать PNG'))), 'image/png'));
  }

  /* ---------------- сохранение ---------------- */

  function autoFilename(ext) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const host = (location.hostname || 'page').replace(/[^\w.-]+/g, '_');
    return `${host}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_layout.${ext}`;
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

  // Документ во временном скрытом iframe — чтобы применить вид и нарисовать PNG без панели
  async function withDoc(html, fn) {
    const f = document.createElement('iframe');
    f.setAttribute(IGNORE, '');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:10px;height:10px;border:0;visibility:hidden';
    document.documentElement.appendChild(f);
    try {
      await new Promise((res) => { f.onload = res; f.srcdoc = html; });
      return await fn(f.contentDocument);
    } finally { f.remove(); }
  }

  const split = (o) => {
    const view = Object.assign({}, VIEW_DEFAULTS);
    const rest = {};
    Object.keys(o || {}).forEach((k) => { if (k in VIEW_DEFAULTS) view[k] = o[k]; else rest[k] = o[k]; });
    return { view, rest };
  };

  async function toHTML(userOpts = {}) {
    const { view, rest } = split(userOpts);
    const data = await collect(rest);
    api.lastReport = { elements: data.elements, items: data.items.length, width: data.width, height: data.height, ms: data.ms };
    return buildDoc(data, view);
  }

  async function toPNG(userOpts = {}) {
    const { view, rest } = split(userOpts);
    const data = await collect(rest);
    return withDoc(buildDoc(data, view), (doc) => renderPNG(doc, data));
  }

  async function download(userOpts = {}) {
    const blob = new Blob([await toHTML(userOpts)], { type: 'text/html;charset=utf-8' });
    saveBlob(blob, userOpts.filename || autoFilename('html'));
    return blob;
  }

  async function downloadPNG(userOpts = {}) {
    const blob = await toPNG(userOpts);
    saveBlob(blob, userOpts.filename || autoFilename('png'));
    return blob;
  }

  /* ---------------- панель ---------------- */

  const PANEL_CSS = `:host{all:initial}
.p{position:fixed;top:12px;right:12px;width:268px;z-index:2147483647;background:rgba(15,18,25,.94);color:#e5e7eb;
  font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;border:1px solid rgba(255,255,255,.08);border-radius:12px;
  box-shadow:0 12px 32px rgba(0,0,0,.45);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);user-select:none}
.h{display:flex;align-items:center;gap:4px;padding:9px 10px 9px 12px;cursor:move;border-bottom:1px solid rgba(255,255,255,.06)}
.h b{flex:1;font-weight:600;font-size:13px;letter-spacing:.01em}
.x{background:none;border:0;color:#9ca3af;cursor:pointer;font:14px system-ui,sans-serif;width:24px;height:22px;border-radius:6px}
.x:hover{background:rgba(255,255,255,.08);color:#fff}
.c{padding:10px 12px 12px;display:grid;gap:11px}
.p.min .c{display:none}
.row{display:grid;gap:5px}
.lab{display:flex;justify-content:space-between;align-items:center;color:#9ca3af}
.v{color:#e5e7eb;font-variant-numeric:tabular-nums}
input[type=range]{width:100%;margin:0;accent-color:#60a5fa}
.seg{display:flex;background:rgba(255,255,255,.05);border-radius:8px;padding:2px;gap:2px}
.seg button{flex:1;background:none;border:0;color:#9ca3af;padding:5px 0;border-radius:6px;cursor:pointer;font:inherit}
.seg button:hover{color:#e5e7eb}
.seg button.on{background:rgba(96,165,250,.2);color:#fff}
.chk{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px}
.chk label{display:flex;align-items:center;gap:6px;cursor:pointer;color:#d1d5db}
.chk label.w{grid-column:1/-1}
input[type=checkbox]{margin:0;accent-color:#60a5fa}
input[type=color]{width:26px;height:18px;border:1px solid rgba(255,255,255,.15);border-radius:4px;background:none;padding:0;cursor:pointer}
.dl{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.btn{background:#2563eb;border:0;color:#fff;border-radius:8px;padding:8px 0;font:600 12px system-ui,sans-serif;cursor:pointer}
.btn:hover{background:#1d4ed8}
.btn.sec{background:rgba(255,255,255,.07);color:#d1d5db;font-weight:500}
.btn.sec:hover{background:rgba(255,255,255,.12)}
.btn:disabled{opacity:.5;cursor:default}
.st{color:#6b7280;font-size:11px;min-height:15px}`;

  const PANEL_HTML = `<div class="p">
  <div class="h"><b>Границы макета</b><button class="x" data-a="min" title="Свернуть">–</button><button class="x" data-a="close" title="Закрыть (Esc)">✕</button></div>
  <div class="c">
    <div class="row"><div class="lab"><span>Глубина от</span><span class="v" id="vf"></span></div><input type="range" id="from" min="0" step="1"></div>
    <div class="row"><div class="lab"><span>Глубина до</span><span class="v" id="vt"></span></div><input type="range" id="to" min="0" step="1"></div>
    <div class="row"><div class="lab"><span>Рамки</span><input type="color" id="color" title="Свой цвет"></div>
      <div class="seg" id="theme"><button data-v="soft">Мягкие</button><button data-v="mono">Свой цвет</button><button data-v="vivid">Яркие</button></div></div>
    <div class="row"><div class="lab"><span>Яркость рамок</span><span class="v" id="vo"></span></div><input type="range" id="opacity" min="5" max="100" step="1"></div>
    <div class="chk">
      <label><input type="checkbox" id="text">Текст</label><label><input type="checkbox" id="fills">Заливка</label>
      <label><input type="checkbox" id="margins">Отступы</label><label><input type="checkbox" id="padding">Поля</label>
      <label class="w" title="Прозрачный фон: только рамки поверх настоящей страницы"><input type="checkbox" id="overlay">Поверх страницы</label>
    </div>
    <div class="row"><div class="lab"><span>Область</span></div><div class="seg" id="scope"><button data-v="view">Экран</button><button data-v="page">Вся страница</button></div></div>
    <div class="row"><div class="lab"><span>Картинки</span></div><div class="seg" id="media"><button data-v="box">Рамкой</button><button data-v="real">Как есть</button></div></div>
    <div class="dl"><button class="btn" id="html">Скачать HTML</button><button class="btn" id="png">Скачать PNG</button></div>
    <div class="dl"><button class="btn sec" id="refresh" title="Снять заново (страница могла измениться)">Обновить</button><span class="st" id="st"></span></div>
  </div>
</div>`;

  let panel = null;

  async function open(userOpts = {}) {
    if (panel) return panel.api;
    const { view, rest } = split(userOpts);
    const opts = Object.assign({ fullPage: false, media: 'box' }, rest);

    const frame = document.createElement('iframe');
    frame.setAttribute(IGNORE, '');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;margin:0;padding:0;z-index:2147483646;background:transparent;color-scheme:normal';
    const host = document.createElement('div');
    host.setAttribute(IGNORE, '');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${PANEL_CSS}</style>${PANEL_HTML}`;
    const $ = (id) => root.getElementById(id);
    const box = root.querySelector('.p');

    let data = null;
    const status = (t) => { $('st').textContent = t; };
    const doc = () => frame.contentDocument;

    function syncControls() {
      const max = data.maxDepth;
      const to = Math.min(view.depthTo, max), from = Math.min(view.depthFrom, max);
      $('from').max = max; $('to').max = max;
      $('from').value = from; $('to').value = to;
      $('vf').textContent = from; $('vt').textContent = to === max ? `${to} (все)` : to;
      $('opacity').value = Math.round(view.opacity * 100); $('vo').textContent = Math.round(view.opacity * 100) + '%';
      $('color').value = view.color;
      ['text', 'fills', 'margins', 'padding', 'overlay'].forEach((k) => { $(k).checked = !!view[k]; });
      root.querySelectorAll('#theme button').forEach((b) => b.classList.toggle('on', b.dataset.v === view.theme));
      root.querySelectorAll('#scope button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'page') === !!opts.fullPage));
      root.querySelectorAll('#media button').forEach((b) => b.classList.toggle('on', b.dataset.v === opts.media));
    }

    function refreshView() {
      if (data && doc() && doc().getElementById('L')) applyView(doc(), data, view);
      syncControls();
    }

    async function capture() {
      status('Снимаю…');
      frame.style.visibility = 'hidden';
      await new Promise((r) => requestAnimationFrame(() => r()));
      data = await collect(opts);
      await new Promise((res) => { frame.onload = res; frame.srcdoc = buildDoc(data, view); });
      if (data.scrollY) frame.contentWindow.scrollTo(0, data.scrollY);
      frame.style.visibility = 'visible';
      refreshView();
      status(`${data.elements} элементов · ${data.ms} мс`);
    }

    // Управление
    $('from').addEventListener('input', (e) => { view.depthFrom = +e.target.value; if (view.depthFrom > view.depthTo) view.depthTo = view.depthFrom; refreshView(); });
    $('to').addEventListener('input', (e) => { const v = +e.target.value; view.depthTo = v >= data.maxDepth ? Infinity : v; if (view.depthFrom > v) view.depthFrom = v; refreshView(); });
    $('opacity').addEventListener('input', (e) => { view.opacity = +e.target.value / 100; refreshView(); });
    $('color').addEventListener('input', (e) => { view.color = e.target.value; view.theme = 'mono'; refreshView(); });
    ['text', 'fills', 'margins', 'padding', 'overlay'].forEach((k) => $(k).addEventListener('change', (e) => { view[k] = e.target.checked; refreshView(); }));
    $('theme').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (v) { view.theme = v; refreshView(); } });
    $('scope').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (v && (v === 'page') !== !!opts.fullPage) { opts.fullPage = v === 'page'; capture(); } });
    $('media').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (v && v !== opts.media) { opts.media = v; capture(); } });
    $('refresh').addEventListener('click', () => capture());
    $('html').addEventListener('click', () => {
      const html = '<!DOCTYPE html>\n' + doc().documentElement.outerHTML;
      saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), autoFilename('html'));
      status('HTML сохранён');
    });
    $('png').addEventListener('click', async () => {
      $('png').disabled = true; status('Рисую PNG…');
      try { saveBlob(await renderPNG(doc(), data), autoFilename('png')); status('PNG сохранён'); }
      catch (err) { status('❌ ' + (err.message || err)); }
      finally { $('png').disabled = false; }
    });

    // Перетаскивание за заголовок, свернуть, закрыть
    root.querySelector('.h').addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => { box.style.left = Math.max(0, ev.clientX - dx) + 'px'; box.style.top = Math.max(0, ev.clientY - dy) + 'px'; box.style.right = 'auto'; };
      const up = () => { removeEventListener('mousemove', move, true); removeEventListener('mouseup', up, true); };
      addEventListener('mousemove', move, true); addEventListener('mouseup', up, true);
      e.preventDefault();
    });
    root.querySelector('[data-a="min"]').addEventListener('click', () => box.classList.toggle('min'));
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    root.querySelector('[data-a="close"]').addEventListener('click', () => close());

    function close() {
      removeEventListener('keydown', onKey, true);
      frame.remove(); host.remove(); panel = null;
    }

    addEventListener('keydown', onKey, true);
    document.documentElement.appendChild(frame);
    document.documentElement.appendChild(host);
    await capture();
    panel = { api: { close, refresh: capture, view, opts } };
    return panel.api;
  }

  function close() { if (panel) panel.api.close(); }

  const api = {
    version: '2.0', open, close, toHTML, toPNG, download, downloadPNG,
    defaults: DEFAULTS, viewDefaults: VIEW_DEFAULTS, lastReport: null,
  };
  global.layoutBounds = api;

  // Вставили в консоль — открывается панель. Настройки: window.LAYOUT_BOUNDS_CONFIG = { fullPage: true, theme: 'mono' }
  if (!(currentScript && currentScript.hasAttribute('data-manual'))) {
    const run = () => open(global.LAYOUT_BOUNDS_CONFIG || {}).catch((e) => console.error('[layoutBounds]', e));
    document.readyState === 'complete' ? run() : global.addEventListener('load', run, { once: true });
  }
})(typeof window !== 'undefined' ? window : this);
