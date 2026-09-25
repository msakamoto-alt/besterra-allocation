/* lwc-runtime.js — Salesforce の外で dev6 の Lightning 部品をそのまま動かす小さな土台。
 *
 * 共有モックアップ（工事部レビュー用）は、画面を作り直すのではなく **dev6 の部品そのもの**
 * （koujiKagami / kagamiYukaPage / multiPicklist / kagamiData）を読み込んで描く。
 * だから「dev6 と同じ見た目・同じ計算」がズレない。作り直したのは Salesforce の側だけ。
 *
 * ここでやること（＝Salesforce が本来やっていること）:
 *   1. モジュールの差し替え台    import 先を差し替える（lwc / lightning/* / @salesforce/*）
 *   2. モジュールの読み込み      import・@api・@wire・export default を素の JS に直して class を取り出す
 *   3. テンプレートの解釈        lwc:if / lwc:elseif / lwc:else / for:each / {式} / on* を DOM に起こす
 *   4. 部品の差し替え            lightning-input / combobox / button / button-icon / icon / record-picker
 *   5. 再描画                    プロパティが変わったら次の描画で全部描き直す（入力位置とスクロールは保つ）
 *
 * データ（Apex と UI API の応答）は sf-data.js が受け持つ。ここはデータを知らない。
 */
window.SfMockLwc = (function () {
    'use strict';

    // ===================== 1. モジュールの差し替え台 =====================

    const modules = {};
    let apexResolver = null;   // sf-data.js が入れる（'Class.method' → 関数）
    let errorSink = null;      // 例外の行き先（握り潰さない）

    function define(name, exports) {
        modules[name] = exports;
    }
    function defineApexResolver(fn) {
        apexResolver = fn;
    }
    function onError(fn) {
        errorSink = fn;
    }
    function report(where, e) {
        const msg = (e && e.message) || String(e);
        // eslint-disable-next-line no-console
        console.error('[sfmock] ' + where + ': ' + msg, e);
        if (errorSink) {
            try { errorSink(where, e); } catch (x) { /* ここで落ちては元も子もない */ }
        }
    }

    function req(name) {
        if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
        if (name.indexOf('@salesforce/schema/') === 0) {
            // 項目参照＝{objectApiName, fieldApiName}（本物と同じ形）
            const p = name.slice('@salesforce/schema/'.length);
            const dot = p.lastIndexOf('.');
            return { default: { objectApiName: p.slice(0, dot), fieldApiName: p.slice(dot + 1) } };
        }
        if (name.indexOf('@salesforce/apex/') === 0) {
            if (!apexResolver) throw new Error('Apex の差し替えが未設定です');
            return { default: apexResolver(name.slice('@salesforce/apex/'.length)) };
        }
        if (name.indexOf('@salesforce/label/') === 0) return { default: '' };
        if (name.indexOf('@salesforce/resourceUrl/') === 0) return { default: '' };
        if (name.indexOf('@salesforce/user/') === 0) return { default: null };
        throw new Error('差し替えられていない import: ' + name);
    }

    // ===================== 2. モジュールの読み込み =====================

    // 対応する括弧の位置（@wire(...) の引数を原文のまま取り出すため）
    function matchParen(s, openIdx) {
        let depth = 0;
        let q = null;
        for (let i = openIdx; i < s.length; i++) {
            const c = s[i];
            if (q) {
                if (c === '\\') { i++; continue; }
                if (c === q) q = null;
                continue;
            }
            if (c === '"' || c === "'" || c === '`') { q = c; continue; }
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (depth === 0) return i; }
        }
        return -1;
    }

    /** LWC のモジュール（1 ファイル）を素の JS に直して評価する */
    function loadModule(src, label) {
        const apiProps = [];
        const wires = [];
        let out = src;

        // --- import → __req --------------------------------------------------
        out = out.replace(/import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;?/g, function (m, clause, q, mod) {
            const c = clause.trim();
            if (c.charAt(0) === '{') return 'const ' + c.replace(/\s+/g, ' ') + ' = __req(' + JSON.stringify(mod) + ');';
            return 'const ' + c + ' = __req(' + JSON.stringify(mod) + ').default;';
        });

        // --- @wire(adapter, config) → 控えて外す ------------------------------
        for (;;) {
            const i = out.indexOf('@wire(');
            if (i < 0) break;
            const open = i + '@wire'.length;
            const close = matchParen(out, open);
            if (close < 0) throw new Error(label + ': @wire の括弧が閉じていません');
            const argsSrc = out.slice(open + 1, close);
            const rest = out.slice(close + 1);
            const m = rest.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
            if (!m) throw new Error(label + ': @wire の次がメソッドではありません');
            wires.push({ argsSrc: argsSrc, method: m[1] });
            out = out.slice(0, i) + rest;
        }

        // --- @api / @track → 控えて外す --------------------------------------
        out = out.replace(/@api\s+(get|set)\s+([A-Za-z_$][\w$]*)/g, function (m, kind, nm) {
            if (apiProps.indexOf(nm) < 0) apiProps.push(nm);
            return kind + ' ' + nm;
        });
        out = out.replace(/@api\s+([A-Za-z_$][\w$]*)\s*([;=])/g, function (m, nm, tail) {
            if (apiProps.indexOf(nm) < 0) apiProps.push(nm);
            return nm + ' ' + tail;
        });
        out = out.replace(/@track\s+/g, '');

        // --- export → 戻り値 --------------------------------------------------
        const cm = out.match(/export\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
        if (cm) {
            const nm = cm[1];
            out = out.replace(/export\s+default\s+class\s+([A-Za-z_$][\w$]*)/, 'const $1 = class $1');
            out += '\n' + nm + '.__api = ' + JSON.stringify(apiProps) + ';\n';
            out += nm + '.__wires = [' + wires.map(function (w) {
                return '{ method: ' + JSON.stringify(w.method) + ', args: [' + w.argsSrc + '] }';
            }).join(',\n') + '];\n';
            out += 'return ' + nm + ';\n';
        } else {
            const names = [];
            // export const / let / var / function / class …
            out = out.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g, function (m, kw, n) {
                names.push(n);
                return kw + ' ' + n;
            });
            // export { A, B as C, … };（kagamiData は最後にこの形でまとめて出している）
            out = out.replace(/export\s*\{([^}]*)\}\s*;?/g, function (m, body) {
                body.split(',').forEach(function (part) {
                    const t = part.trim();
                    if (!t) return;
                    const as = t.split(/\s+as\s+/);
                    names.push(as.length > 1 ? as[1].trim() + ': ' + as[0].trim() : t);
                });
                return '';
            });
            if (!names.length) throw new Error(label + ': export が見つかりません');
            out += '\nreturn { ' + names.join(', ') + ' };\n';
        }

        try {
            // eslint-disable-next-line no-new-func
            return new Function('__req', out)(req);
        } catch (e) {
            report('モジュールの読み込み（' + label + '）', e);
            throw e;
        }
    }

    // ===================== 3. テンプレートの解釈 =====================

    const DIRECTIVES = { 'for:each': 1, 'for:item': 1, 'for:index': 1, key: 1 };

    function compileTemplate(htmlText, label) {
        const doc = new DOMParser().parseFromString(htmlText, 'text/html');
        const t = doc.querySelector('template');
        if (!t) throw new Error(label + ': <template> が見つかりません');
        return t.content;
    }

    function camel(s) {
        return s.replace(/-([a-z0-9])/g, function (m, c) { return c.toUpperCase(); });
    }

    // {式} を scope → 部品 の順で引く。関数は呼び出し側で部品に束縛する
    function resolve(expr, scope, comp) {
        const path = String(expr).trim().split('.');
        let base;
        const head = path[0];
        if (scope && Object.prototype.hasOwnProperty.call(scope, head)) base = scope[head];
        else base = comp.proxy[head];
        for (let i = 1; i < path.length; i++) {
            if (base === null || base === undefined) return undefined;
            base = base[path[i]];
        }
        return base;
    }

    // lwc:if / for:each の属性値は "{式}" の形で入っている＝波括弧を外してから引く
    function unwrap(v) {
        const t = String(v === null || v === undefined ? '' : v).trim();
        return t.charAt(0) === '{' && t.charAt(t.length - 1) === '}' ? t.slice(1, -1) : t;
    }

    function childScope(scope) {
        const s = Object.create(null);
        if (scope) Object.keys(scope).forEach(function (k) { s[k] = scope[k]; });
        return s;
    }

    const TEXT_RE = /\{([^{}]+)\}/g;

    function appendText(text, scope, comp, out) {
        if (text.indexOf('{') < 0) {
            out.appendChild(document.createTextNode(text));
            return;
        }
        let last = 0;
        let m;
        TEXT_RE.lastIndex = 0;
        while ((m = TEXT_RE.exec(text))) {
            if (m.index > last) out.appendChild(document.createTextNode(text.slice(last, m.index)));
            let v;
            try { v = resolve(m[1], scope, comp); } catch (e) { v = ''; }
            out.appendChild(document.createTextNode(v === null || v === undefined ? '' : String(v)));
            last = m.index + m[0].length;
        }
        if (last < text.length) out.appendChild(document.createTextNode(text.slice(last)));
    }

    function renderChildren(nodeList, scope, comp, out) {
        const kids = Array.prototype.slice.call(nodeList);
        let i = 0;
        while (i < kids.length) {
            const n = kids[i];
            if (n.nodeType === 8) { i++; continue; }                       // コメント
            if (n.nodeType === 3) { appendText(n.textContent, scope, comp, out); i++; continue; }
            if (n.nodeType !== 1) { i++; continue; }

            // lwc:if / lwc:elseif / lwc:else の連鎖（<template> でも通常要素でも同じ）
            if (n.hasAttribute('lwc:if')) {
                let matched = false;
                let consumed = i;
                let j = i;
                while (j < kids.length) {
                    const e = kids[j];
                    if (e.nodeType === 8 || (e.nodeType === 3 && !e.textContent.trim())) { j++; continue; }
                    if (e.nodeType !== 1) break;
                    const isIf = j === i && e.hasAttribute('lwc:if');
                    const isEi = j > i && e.hasAttribute('lwc:elseif');
                    const isEl = j > i && e.hasAttribute('lwc:else');
                    if (!isIf && !isEi && !isEl) break;
                    let ok = true;
                    if (!isEl) {
                        try { ok = !!resolve(unwrap(e.getAttribute(isIf ? 'lwc:if' : 'lwc:elseif')), scope, comp); } catch (x) { ok = false; }
                    }
                    if (!matched && ok) { matched = true; renderOne(e, scope, comp, out); }
                    consumed = j;
                    j++;
                    if (isEl) break;
                }
                i = consumed + 1;
                continue;
            }
            renderOne(n, scope, comp, out);
            i++;
        }
    }

    function renderOne(el, scope, comp, out) {
        if (el.hasAttribute('for:each')) return renderLoop(el, scope, comp, out);
        if (el.tagName === 'TEMPLATE') return renderChildren(el.content.childNodes, scope, comp, out);
        return renderElement(el, scope, comp, out);
    }

    function renderLoop(el, scope, comp, out) {
        let list;
        try { list = resolve(unwrap(el.getAttribute('for:each')), scope, comp); } catch (e) { list = null; }
        if (!list) return;
        const iname = el.getAttribute('for:item') || 'item';
        const idxname = el.getAttribute('for:index');
        const arr = Array.prototype.slice.call(list);
        for (let k = 0; k < arr.length; k++) {
            const s = childScope(scope);
            s[iname] = arr[k];
            if (idxname) s[idxname] = k;
            if (el.tagName === 'TEMPLATE') renderChildren(el.content.childNodes, s, comp, out);
            else renderElement(el, s, comp, out);
        }
    }

    function renderElement(el, scope, comp, out) {
        const tag = el.tagName.toLowerCase();
        const props = {};
        const data = {};
        const handlers = [];
        let cls = null;
        let style = null;

        const attrs = el.attributes;
        for (let i = 0; i < attrs.length; i++) {
            const nm = attrs[i].name;
            const raw = attrs[i].value;
            if (DIRECTIVES[nm] || nm.indexOf('lwc:') === 0 || nm.indexOf('iterator:') === 0) continue;
            const trimmed = raw.trim();
            const dyn = trimmed.charAt(0) === '{' && trimmed.charAt(trimmed.length - 1) === '}' && trimmed.indexOf('{', 1) < 0;
            let val = raw;
            if (dyn) {
                try { val = resolve(trimmed.slice(1, -1), scope, comp); } catch (e) { val = undefined; }
            }
            if (dyn && /^on[a-z]+$/.test(nm) && typeof val === 'function') {
                handlers.push([nm.slice(2), wrapHandler(val, comp)]);
                continue;
            }
            if (nm === 'class') { cls = val === null || val === undefined ? '' : String(val); continue; }
            if (nm === 'style') { style = val === null || val === undefined ? '' : String(val); continue; }
            if (nm.indexOf('data-') === 0) { data[camel(nm.slice(5))] = val; continue; }
            props[camel(nm)] = val;
        }

        let node;
        if (tag.indexOf('lightning-') === 0) {
            node = makeLightning(tag, props, comp);
        } else if (tag.indexOf('c-') === 0) {
            node = mountChild(tag, props, comp);
        } else {
            // SVG などは元の名前空間で作る（html で createElement すると描かれない）
            node = document.createElementNS(el.namespaceURI, tag);
            for (let i = 0; i < attrs.length; i++) {
                const nm = attrs[i].name;
                if (DIRECTIVES[nm] || nm.indexOf('lwc:') === 0 || nm.indexOf('iterator:') === 0) continue;
                if (nm === 'class' || nm === 'style' || nm.indexOf('data-') === 0) continue;
                const key = camel(nm);
                if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
                const v = props[key];
                if (v === null || v === undefined || v === false) continue;
                node.setAttribute(nm, v === true ? '' : String(v));
            }
            renderChildren(el.childNodes, scope, comp, node);
        }

        // テンプレートの class を入れるときも、土台が付けた印（sfm-lg / sfm-host / sfm-placeholder）は残す。
        // 消すと lightning 部品の display 指定が外れて、入力欄が中身の幅まで縮んでしまう
        if (cls !== null || node.__sfmBase) {
            const base = node.__sfmBase || '';
            const v = [cls || '', base].filter(Boolean).join(' ');
            if (node.namespaceURI === 'http://www.w3.org/2000/svg') node.setAttribute('class', v);
            else node.className = v;
        }
        if (style !== null && style !== '') node.setAttribute('style', style);
        if (node.dataset) {
            Object.keys(node.dataset).forEach(function (k) {
                if (!Object.prototype.hasOwnProperty.call(data, k)) delete node.dataset[k];
            });
        }
        Object.keys(data).forEach(function (k) {
            const v = data[k];
            if (v === null || v === undefined) return;
            node.dataset[k] = v;
        });
        // 子部品は使い回すので、前回の購読を外してから付け直す（二重発火を防ぐ）
        if (node.__sfmOn) {
            node.__sfmOn.forEach(function (h) { node.removeEventListener(h[0], h[1]); });
        }
        node.__sfmOn = handlers;
        handlers.forEach(function (h) { node.addEventListener(h[0], h[1]); });

        out.appendChild(node);
        return node;
    }

    function wrapHandler(fn, comp) {
        return function (ev) {
            try {
                fn.call(comp.proxy, ev);
            } catch (e) {
                report('操作の処理', e);
            } finally {
                markDirty(comp);
            }
        };
    }

    // ===================== 4. 部品の差し替え =====================
    //
    // 部品は描き直しのたびに作り直さず**使い回す**。理由が 2 つある:
    //   - 打っている途中に要素を入れ替えると、文字が消えたり並びが崩れる
    //   - 日本語入力（変換中）は要素が入れ替わると壊れる
    // なので、作るのは 1 回だけにして、次からは update(props) で中身だけ合わせる。
    // 入力中（その要素に焦点がある間）は value を上書きしない＝人の手を邪魔しない。

    // SLDS のアイコンは画像（スプライト）なので、使われている分だけ字と形で代える
    const GLYPH = {
        'utility:check': '✓',
        'utility:close': '×',
        'utility:down': '▾',
        'utility:up': '▴',
        'utility:right': '▸',
        'utility:left': '◂',
        'utility:chevronleft': '‹',
        'utility:chevronright': '›',
        'utility:refresh': '⟳',
        'utility:rows': '☰',
        'utility:add': '＋',
        'utility:delete': '－',
        'utility:edit': '✎',
        'utility:search': '⌕',
        'utility:info': 'i',
        'utility:warning': '!',
        'doctype:folder': '🗀',
        'doctype:pdf': 'PDF'
    };
    function glyphOf(name) {
        return GLYPH[name] || '•';
    }

    // 本物の lightning 部品と同じ形の change（detail 付き）を出す。
    // ⚠️ 素の input/change は host へ上げない（テンプレートの onchange は event.detail.value を読むため、
    //    native の event がそのまま届くと detail が無くて落ちる）
    function fireChange(host, detail) {
        host.dispatchEvent(new CustomEvent('change', { detail: detail }));
    }
    function setAttrIf(el, name, v) {
        if (v === null || v === undefined || v === '') el.removeAttribute(name);
        else el.setAttribute(name, String(v));
    }
    function txt(v) {
        return v === null || v === undefined ? '' : String(v);
    }
    function showLabel(lab, p) {
        const hide = p.variant === 'label-hidden' || !p.label;
        lab.textContent = txt(p.label);
        lab.style.display = hide ? 'none' : '';
    }

    function buildInput(host) {
        let lab = null;
        let inp = null;
        let curType = null;
        const make = function (type) {
            host.textContent = '';
            lab = document.createElement('label');
            lab.className = 'sfm-label';
            host.appendChild(lab);
            inp = document.createElement('input');
            const isCheck = type === 'checkbox' || type === 'toggle';
            inp.className = isCheck ? 'sfm-check' : 'sfm-input';
            inp.type = type === 'toggle' ? 'checkbox' : type;
            const emit = function (ev) {
                ev.stopPropagation();
                fireChange(host, isCheck ? { checked: inp.checked, value: inp.value } : { value: inp.value });
            };
            inp.addEventListener('input', emit);
            inp.addEventListener('change', emit);
            host.appendChild(inp);
            curType = type;
        };
        return {
            host: host,
            update: function (p) {
                const type = p.type || 'text';
                if (type !== curType) make(type);
                showLabel(lab, p);
                inp.placeholder = p.placeholder || '';
                if (p.name) inp.name = p.name;
                setAttrIf(inp, 'step', p.step);
                setAttrIf(inp, 'min', p.min);
                setAttrIf(inp, 'max', p.max);
                inp.disabled = !!p.disabled;
                inp.readOnly = !!(p.readOnly || p.readonly);
                if (document.activeElement === inp) return;   // 打っている間は触らない
                if (inp.type === 'checkbox') inp.checked = !!p.checked;
                else {
                    const v = txt(p.value);
                    if (inp.value !== v) inp.value = v;
                }
            }
        };
    }

    function buildTextarea(host) {
        const lab = document.createElement('label');
        lab.className = 'sfm-label';
        const ta = document.createElement('textarea');
        ta.className = 'sfm-textarea';
        const emit = function (ev) {
            ev.stopPropagation();
            fireChange(host, { value: ta.value });
        };
        ta.addEventListener('input', emit);
        ta.addEventListener('change', emit);
        host.appendChild(lab);
        host.appendChild(ta);
        return {
            host: host,
            update: function (p) {
                showLabel(lab, p);
                ta.placeholder = p.placeholder || '';
                ta.disabled = !!p.disabled;
                if (document.activeElement === ta) return;
                const v = txt(p.value);
                if (ta.value !== v) ta.value = v;
            }
        };
    }

    function buildCombobox(host) {
        const lab = document.createElement('label');
        lab.className = 'sfm-label';
        const sel = document.createElement('select');
        sel.className = 'sfm-select';
        sel.addEventListener('change', function (ev) {
            ev.stopPropagation();
            fireChange(host, { value: sel.value });
        });
        host.appendChild(lab);
        host.appendChild(sel);
        let sig = null;
        return {
            host: host,
            update: function (p) {
                showLabel(lab, p);
                sel.disabled = !!p.disabled;
                const opts = Array.isArray(p.options) ? p.options : [];
                const cur = txt(p.value);
                const ns = JSON.stringify([p.placeholder || '', opts]);
                if (ns !== sig) {
                    sig = ns;
                    sel.textContent = '';
                    if (p.placeholder && !opts.some(function (o) { return txt(o.value) === cur; })) {
                        const o = document.createElement('option');
                        o.value = '';
                        o.textContent = p.placeholder;
                        sel.appendChild(o);
                    }
                    opts.forEach(function (o) {
                        const e = document.createElement('option');
                        e.value = txt(o.value);
                        e.textContent = o.label === null || o.label === undefined ? e.value : String(o.label);
                        sel.appendChild(e);
                    });
                }
                if (sel.value !== cur) sel.value = cur;
            }
        };
    }

    function buildButton(host) {
        const b = document.createElement('button');
        b.type = 'button';
        const ic = document.createElement('span');
        ic.className = 'sfm-glyph';
        const tx = document.createTextNode('');
        b.appendChild(ic);
        b.appendChild(tx);
        host.appendChild(b);
        return {
            host: host,
            update: function (p) {
                b.className = 'sfm-btn sfm-btn-' + (p.variant || 'neutral');
                b.disabled = !!p.disabled;
                b.title = txt(p.title);
                ic.textContent = p.iconName ? glyphOf(p.iconName) : '';
                ic.style.display = p.iconName ? '' : 'none';
                tx.textContent = txt(p.label);
            }
        };
    }

    function buildButtonIcon(host) {
        const b = document.createElement('button');
        b.type = 'button';
        host.appendChild(b);
        return {
            host: host,
            update: function (p) {
                b.className = 'sfm-btn-icon sfm-btn-icon-' + (p.variant || 'border');
                b.title = txt(p.title || p.alternativeText);
                b.disabled = !!p.disabled;
                b.textContent = glyphOf(p.iconName);
            }
        };
    }

    function buildIcon(host) {
        const s = document.createElement('span');
        host.appendChild(s);
        return {
            host: host,
            update: function (p) {
                s.className = 'sfm-glyph sfm-glyph-' + (p.size || 'small');
                s.title = txt(p.title || p.alternativeText);
                s.textContent = glyphOf(p.iconName);
            }
        };
    }

    /** レコード検索のピッカー。候補は「録ったデータの中にある名前」＝モックの範囲は正直に示す */
    let recordNameLookup = function () { return null; };
    let recordSearch = function () { return []; };
    function setRecordDirectory(lookup, search) {
        recordNameLookup = lookup;
        recordSearch = search;
    }

    function buildRecordPicker(host) {
        const box = document.createElement('div');
        box.className = 'sfm-picker';
        const inp = document.createElement('input');
        inp.className = 'sfm-input';
        const list = document.createElement('div');
        list.className = 'sfm-picker-list';
        list.hidden = true;
        const clr = document.createElement('button');
        clr.type = 'button';
        clr.className = 'sfm-picker-clear';
        clr.title = '選択をクリア';
        clr.textContent = '×';
        box.appendChild(inp);
        box.appendChild(list);
        box.appendChild(clr);
        host.appendChild(box);
        let obj = '';
        const draw = function () {
            const q = inp.value.trim();
            const hits = recordSearch(obj, q).slice(0, 12);
            list.textContent = '';
            if (!hits.length) {
                const e = document.createElement('div');
                e.className = 'sfm-picker-empty';
                e.textContent = q ? '候補がありません（モックの候補は録った範囲だけです）' : '文字を入れると候補が出ます';
                list.appendChild(e);
            }
            hits.forEach(function (h) {
                const r = document.createElement('div');
                r.className = 'sfm-picker-row';
                r.textContent = h.name;
                r.addEventListener('mousedown', function (ev) {
                    ev.preventDefault();
                    list.hidden = true;
                    fireChange(host, { recordId: h.id });
                });
                list.appendChild(r);
            });
            list.hidden = false;
        };
        inp.addEventListener('focus', draw);
        inp.addEventListener('input', function (ev) { ev.stopPropagation(); draw(); });
        inp.addEventListener('change', function (ev) { ev.stopPropagation(); });
        inp.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 150); });
        clr.addEventListener('click', function () { fireChange(host, { recordId: null }); });
        return {
            host: host,
            update: function (p) {
                obj = p.objectApiName || '';
                inp.placeholder = p.placeholder || '検索';
                inp.disabled = !!p.disabled;
                clr.style.display = p.value ? '' : 'none';
                if (document.activeElement === inp) return;
                const v = p.value ? (recordNameLookup(p.value) || p.value) : '';
                if (inp.value !== v) inp.value = v;
            }
        };
    }

    function buildLightning(tag) {
        const host = document.createElement(tag);
        host.__sfmBase = 'sfm-lg';
        host.classList.add('sfm-lg');
        const kind = tag.slice('lightning-'.length);
        if (kind === 'input') return buildInput(host);
        if (kind === 'textarea') return buildTextarea(host);
        if (kind === 'combobox') return buildCombobox(host);
        if (kind === 'button') return buildButton(host);
        if (kind === 'button-icon') return buildButtonIcon(host);
        if (kind === 'icon') return buildIcon(host);
        if (kind === 'record-picker') return buildRecordPicker(host);
        if (kind === 'spinner') {
            host.appendChild(document.createTextNode('読み込み中…'));
            return { host: host, update: function () {} };
        }
        // 知らない lightning 部品は、何だったかを隠さずに出す（黙って空白にしない）
        const u = document.createElement('span');
        u.className = 'sfm-unknown';
        u.textContent = '[' + tag + ']';
        host.appendChild(u);
        return { host: host, update: function () {} };
    }

    /** テンプレートの位置ごとに 1 つ作って使い回す（位置は描画順で数える＝テンプレートは毎回同じ順に走る） */
    function makeLightning(tag, props, comp) {
        const n = (comp.lgSeq[tag] = (comp.lgSeq[tag] || 0) + 1);
        const key = tag + '#' + n;
        let rec = comp.lg[key];
        if (!rec) {
            rec = buildLightning(tag);
            comp.lg[key] = rec;
        }
        try {
            rec.update(props);
        } catch (e) {
            report('部品の更新（' + tag + '）', e);
        }
        return rec.host;
    }

    // ===================== 5. 部品の生成と再描画 =====================

    const registry = {};       // 'c-kouji-kagami' → {Klass, template, name}
    const placeholders = {};   // 差し替えない部品の説明（原島さんの部品など）

    function registerComponent(tag, def) {
        registry[tag] = def;
    }
    function registerPlaceholder(tag, text) {
        placeholders[tag] = text;
    }

    /** class フィールドの初期値を得るために一度 new して、その内容を raw へ写す */
    function createComponent(def, tag) {
        const host = document.createElement(tag);
        host.__sfmBase = 'sfm-host';
        host.classList.add('sfm-host');
        const seed = new def.Klass();
        const comp = { def: def, host: host, raw: seed, proxy: null, children: {}, seq: {}, lg: {}, lgSeq: {}, dirty: false, rendered: false, root: null, after: [], wireState: {} };
        seed.template = {
            querySelector: function (s) { return host.querySelector(s); },
            querySelectorAll: function (s) { return host.querySelectorAll(s); },
            get host() { return host; },
            get activeElement() { return host.contains(document.activeElement) ? document.activeElement : null; }
        };
        const dispatch = function (ev) { return host.dispatchEvent(ev); };
        seed.dispatchEvent = dispatch;
        seed.addEventListener = function (t, f) { return host.addEventListener(t, f); };
        seed.removeEventListener = function (t, f) { return host.removeEventListener(t, f); };
        comp.proxy = new Proxy(seed, {
            set: function (t, k, v) {
                const before = t[k];
                t[k] = v;
                if (before !== v) markDirty(comp);
                return true;
            }
        });
        host.__sfmComp = comp;
        return comp;
    }

    function rootOf(comp) {
        let c = comp;
        while (c.parent) c = c.parent;
        return c;
    }

    function markDirty(comp) {
        comp.dirty = true;
        const root = rootOf(comp);
        if (root.scheduled) return;
        root.scheduled = true;
        requestAnimationFrame(function () {
            root.scheduled = false;
            try { flush(root); } catch (e) { report('再描画', e); }
        });
    }

    // ---- 入力位置・選択範囲・スクロールを描き直しの前後で保つ ----
    function pathOf(el, root) {
        const p = [];
        let n = el;
        while (n && n !== root) {
            const parent = n.parentNode;
            if (!parent) return null;
            p.unshift(Array.prototype.indexOf.call(parent.childNodes, n));
            n = parent;
        }
        return n === root ? p : null;
    }
    function nodeAt(root, p) {
        let n = root;
        for (let i = 0; i < p.length; i++) {
            if (!n || !n.childNodes[p[i]]) return null;
            n = n.childNodes[p[i]];
        }
        return n;
    }
    function captureUi(root) {
        const snap = { focus: null, scrolls: [] };
        const a = document.activeElement;
        if (a && root.contains(a)) {
            const p = pathOf(a, root);
            if (p) {
                snap.focus = { path: p, start: null, end: null };
                try { snap.focus.start = a.selectionStart; snap.focus.end = a.selectionEnd; } catch (e) { /* 型によっては読めない */ }
            }
        }
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
            const e = all[i];
            if (e.scrollTop || e.scrollLeft) {
                const p = pathOf(e, root);
                if (p) snap.scrolls.push({ path: p, top: e.scrollTop, left: e.scrollLeft });
            }
        }
        return snap;
    }
    function restoreUi(root, snap) {
        snap.scrolls.forEach(function (s) {
            const n = nodeAt(root, s.path);
            if (n && n.nodeType === 1) { n.scrollTop = s.top; n.scrollLeft = s.left; }
        });
        if (snap.focus) {
            const n = nodeAt(root, snap.focus.path);
            if (n && n.nodeType === 1 && typeof n.focus === 'function') {
                n.focus();
                if (snap.focus.start !== null && snap.focus.start !== undefined) {
                    try { n.setSelectionRange(snap.focus.start, snap.focus.end); } catch (e) { /* 型によっては置けない */ }
                }
            }
        }
    }

    function refreshWires(comp) {
        const list = comp.def.Klass.__wires || [];
        list.forEach(function (w, idx) {
            const adapter = w.args[0];
            const cfgSrc = w.args[1] || {};
            const cfg = {};
            let ready = true;
            Object.keys(cfgSrc).forEach(function (k) {
                const v = cfgSrc[k];
                if (typeof v === 'string' && v.charAt(0) === '$') {
                    const got = comp.proxy[v.slice(1)];
                    if (got === undefined) ready = false;
                    cfg[k] = got;
                } else {
                    cfg[k] = v;
                }
            });
            const sig = ready ? JSON.stringify(cfg) : null;
            if (!ready) return;
            if (comp.wireState[idx] === sig) return;
            comp.wireState[idx] = sig;
            invokeWire(comp, w, adapter, cfg, idx);
        });
    }

    function invokeWire(comp, w, adapter, cfg, idx) {
        if (typeof adapter !== 'function') {
            report('wire の差し替え（' + w.method + '）', new Error('アダプタがありません'));
            return;
        }
        const deliver = function (res) {
            res.__wireRef = { comp: comp, w: w, adapter: adapter, cfg: cfg, idx: idx };
            try {
                comp.proxy[w.method](res);
            } catch (e) {
                report('wire の受け取り（' + w.method + '）', e);
            }
            markDirty(comp);
        };
        let p;
        try { p = adapter(cfg); } catch (e) { deliver({ data: undefined, error: e }); return; }
        Promise.resolve(p).then(function (data) { deliver({ data: data, error: undefined }); },
            function (err) { deliver({ data: undefined, error: err }); });
    }

    function rerunWire(ref) {
        if (!ref || !ref.comp) return Promise.resolve();
        return new Promise(function (done) {
            const deliver = function (res) {
                res.__wireRef = ref;
                try { ref.comp.proxy[ref.w.method](res); } catch (e) { report('wire の読み直し', e); }
                markDirty(ref.comp);
                done();
            };
            Promise.resolve(ref.adapter(ref.cfg)).then(
                function (d) { deliver({ data: d, error: undefined }); },
                function (e) { deliver({ data: undefined, error: e }); }
            );
        });
    }

    function renderComponent(comp) {
        comp.seq = {};
        comp.lgSeq = {};
        const frag = document.createDocumentFragment();
        renderChildren(comp.def.template.childNodes, null, comp, frag);
        comp.host.replaceChildren(frag);
        comp.dirty = false;
        comp.rendered = true;
        const root = rootOf(comp);
        if (typeof comp.raw.renderedCallback === 'function') {
            root.after.push(function () {
                try { comp.proxy.renderedCallback(); } catch (e) { report('renderedCallback', e); }
            });
        }
    }

    const afterRenderSinks = [];
    function onAfterRender(fn) { afterRenderSinks.push(fn); }

    function flush(root) {
        const snap = captureUi(root.host);
        root.after = [];
        refreshWires(root);
        renderComponent(root);
        restoreUi(root.host, snap);
        const q = root.after;
        root.after = [];
        q.forEach(function (f) { f(); });
        afterRenderSinks.forEach(function (f) {
            try { f(root); } catch (e) { report('描き終わりの処理', e); }
        });
    }

    function mountChild(tag, props, comp) {
        const root = rootOf(comp);
        const n = (comp.seq[tag] = (comp.seq[tag] || 0) + 1);
        const key = tag + '#' + n;
        let child = comp.children[key];
        const def = registry[tag];

        if (!def) {
            // 差し替えない部品（原島さん作）は、何の画面かを書いた札を出す。
            // 本来ボタンとして埋め込まれているもの（variant="button"）は、行の中で浮かないよう小さく出す
            const label = placeholders[tag] ? placeholders[tag] : tag + '（この共有版では動かしていません）';
            const box = document.createElement(tag);
            if (props && props.variant === 'button') {
                box.__sfmBase = 'sfm-placeholder inline';
                box.className = 'sfm-placeholder inline';
                box.title = label + '／dev6 では実物が入ります。共有版では押せません。';
                box.textContent = label;
                return box;
            }
            box.__sfmBase = 'sfm-placeholder';
            box.className = 'sfm-placeholder';
            const t = document.createElement('div');
            t.className = 'sfm-placeholder-ttl';
            t.textContent = label;
            box.appendChild(t);
            const m = document.createElement('div');
            m.className = 'sfm-placeholder-msg';
            m.textContent = 'dev6 では実物が入ります。ここは共有版の都合で札に置き換えています。';
            box.appendChild(m);
            return box;
        }

        if (!child) {
            child = createComponent(def, tag);
            child.parent = comp;
            comp.children[key] = child;
            // @api を先に入れてから connectedCallback（本物と同じ順）
            applyProps(child, props, true);
            if (typeof child.raw.connectedCallback === 'function') {
                try { child.proxy.connectedCallback(); } catch (e) { report('connectedCallback（' + tag + '）', e); }
            }
            refreshWires(child);
            renderComponent(child);
            return child.host;
        }
        const changed = applyProps(child, props, false);
        if (changed || child.dirty || !child.rendered) {
            refreshWires(child);
            renderComponent(child);
        }
        return child.host;
    }

    function applyProps(child, props, initial) {
        const allowed = child.def.Klass.__api || [];
        let changed = false;
        Object.keys(props).forEach(function (k) {
            if (allowed.indexOf(k) < 0) return;
            let before;
            try { before = child.raw[k]; } catch (e) { before = undefined; }
            if (!initial && before === props[k]) return;
            try { child.raw[k] = props[k]; } catch (e) { report('@api の設定（' + k + '）', e); }
            changed = true;
        });
        return changed;
    }

    /** 画面に出す（入口） */
    function mount(tag, container, props) {
        const def = registry[tag];
        if (!def) throw new Error('部品が登録されていません: ' + tag);
        const comp = createComponent(def, tag);
        comp.parent = null;
        applyProps(comp, props || {}, true);
        // @api ではないが外から入れる必要のあるもの（initialPage など）も通す
        Object.keys(props || {}).forEach(function (k) {
            if ((def.Klass.__api || []).indexOf(k) < 0) comp.raw[k] = props[k];
        });
        container.replaceChildren(comp.host);
        if (typeof comp.raw.connectedCallback === 'function') {
            try { comp.proxy.connectedCallback(); } catch (e) { report('connectedCallback', e); }
        }
        flush(comp);
        return comp;
    }

    /** 部品を組み立てて登録する */
    function buildComponent(tag, htmlText, jsText, label) {
        const Klass = loadModule(jsText, label + '.js');
        const template = compileTemplate(htmlText, label + '.html');
        registerComponent(tag, { Klass: Klass, template: template, name: label });
        return Klass;
    }

    /** kagamiData のような「値だけのモジュール」を差し替え台に載せる */
    function defineFromSource(name, jsText, label) {
        define(name, loadModule(jsText, label));
        return modules[name];
    }

    // 'lwc' 本体（LightningElement / api / wire）— 装飾子は読み込み時に外すので中身は要らない
    define('lwc', {
        LightningElement: function LightningElement() {},
        api: function () {},
        wire: function () {},
        track: function () {}
    });

    return {
        define: define,
        defineApexResolver: defineApexResolver,
        defineFromSource: defineFromSource,
        buildComponent: buildComponent,
        registerPlaceholder: registerPlaceholder,
        setRecordDirectory: setRecordDirectory,
        mount: mount,
        markDirty: markDirty,
        onAfterRender: onAfterRender,
        rerunWire: rerunWire,
        onError: onError,
        report: report,
        loadModule: loadModule
    };
})();
