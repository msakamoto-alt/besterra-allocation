/* sf-data.js — 共有モックアップのデータ側。dev6 が実際にサーバーから受け取った応答を返す。
 *
 * 数字は一切こちらで作らない。record_dev6.js が dev6 の通信をそのまま録ったもの（apex.json /
 * records.json / picklists.json / names.json）を、同じ形で部品へ返すだけ。
 * だから画面に出る金額・件数・台帳は dev6 の実物と同じ。
 *
 * 保存（updateRecord / createRecord / deleteRecord）は **手元のデータに書く**。
 *   - dev6 や本番には一切書かない（共有版はレビューの場で、記録の場ではない）
 *   - 書いたあと部品が refreshApex を呼ぶので、A〜I の帯・S字・利益率まで同じ計算で動く
 *     ＝工事部は「入力して数字が動く」ところまで試せる
 *   - 画面を開き直すと元に戻る（入力は残らない）
 *
 * 入っていない応答は黙って空を返さない。何が無いかを言って部品のエラー表示に載せる。
 */
window.SfMockData = (function () {
    'use strict';

    let bundle = null;          // {apex, records, picklists, names, manifest}
    const idIndex = {};         // レコード Id → その Id を持つオブジェクトの実体（複数あり得る）
    const arrayIndex = {};      // レコード Id → {arr, obj}（削除で使う）
    const navSink = [];         // 画面遷移の受け取り先

    // 作成できるもの（部品が createRecord を呼ぶのはここだけ）。親を辿って同じ器の配列へ足す
    const CREATE_TARGETS = {
        Scra__c: { parentField: 'ConstructionDocumentCover__c', parentList: 'covers', container: 'scraps' }
    };

    // record_dev6.js と同じ鍵の作り方（キーの順番に依存しない）
    function stableKey(obj) {
        if (obj === null || obj === undefined) return 'null';
        if (Array.isArray(obj)) return '[' + obj.map(stableKey).join(',') + ']';
        if (typeof obj !== 'object') return JSON.stringify(obj);
        return '{' + Object.keys(obj).sort().map(function (k) {
            return JSON.stringify(k) + ':' + stableKey(obj[k]);
        }).join(',') + '}';
    }

    function mkError(msg) {
        const e = new Error(msg);
        e.body = { message: msg };
        return e;
    }

    // ---- 保存先を引くための索引を作る ----
    function indexAll(value, parentArr) {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach(function (v) { indexAll(v, value); });
            return;
        }
        if (typeof value.Id === 'string') {
            (idIndex[value.Id] = idIndex[value.Id] || []).push(value);
            if (parentArr) (arrayIndex[value.Id] = arrayIndex[value.Id] || []).push({ arr: parentArr, obj: value });
        }
        if (typeof value.id === 'string' && value.fields) {
            (idIndex[value.id] = idIndex[value.id] || []).push(value);
        }
        Object.keys(value).forEach(function (k) { indexAll(value[k], null); });
    }

    // ---- ピッカーの候補（録った範囲の取引先・社員） ----
    function nameOf(id) {
        const n = bundle && bundle.names && bundle.names[id];
        if (n) return n.name;
        const recs = idIndex[id] || [];
        for (let i = 0; i < recs.length; i++) {
            const r = recs[i];
            if (r.Name) return r.Name;
            if (r.fields && r.fields.Name && r.fields.Name.value) return r.fields.Name.value;
        }
        return null;
    }
    function searchNames(objectApiName, q) {
        const src = (bundle && bundle.names) || {};
        const t = String(q || '').trim();
        const out = [];
        Object.keys(src).forEach(function (id) {
            const n = src[id];
            if (objectApiName && n.kind !== objectApiName) return;
            if (t && n.name.indexOf(t) < 0) return;
            out.push({ id: id, name: n.name });
        });
        out.sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });
        return out;
    }

    // ---- 関係項目（__r）の写しも合わせて直す（表示名が古いまま残らないように） ----
    function patchRelation(obj, fieldApi, newId) {
        if (!/__c$/.test(fieldApi)) return;
        const relKey = fieldApi.replace(/__c$/, '__r');
        if (!Object.prototype.hasOwnProperty.call(obj, relKey)) return;
        if (!newId) { obj[relKey] = null; return; }
        const nm = nameOf(newId);
        obj[relKey] = Object.assign({}, obj[relKey] || {}, { Id: newId, Name: nm || newId });
    }

    // ===================== 数式項目（org の定義を四則の範囲で解き直す） =====================
    //
    // Salesforce なら保存のたびにサーバーが数式を計算する。共有版は保存を手元で受けるので、
    // ここで解き直さないと「数量を変えても金額が動かない」＝壊れて見える。
    // 式は org のメタデータの文字列そのもの（record_dev6 の採取 → formulas.json）。書き写していない。
    // 解くのは四則・数値・項目参照・括弧だけ。IF / CASE / ISPICKVAL / 比較 / $User が入った式は
    // **解かずに録った値を残す**（共有版で編集できる項目が効くのは Scra__c の 3 本＝すべて四則）。
    const formulaCache = {};   // "Obj.Field" → AST（解けない式は null）

    function parseFormula(src) {
        const s = String(src === null || src === undefined ? '' : src);
        const toks = [];
        let i = 0;
        while (i < s.length) {
            const c = s.charAt(i);
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
            if (c >= '0' && c <= '9') {
                let j = i;
                while (j < s.length && ((s.charAt(j) >= '0' && s.charAt(j) <= '9') || s.charAt(j) === '.')) j++;
                toks.push({ t: 'num', v: Number(s.slice(i, j)) });
                i = j;
                continue;
            }
            if (/[A-Za-z_]/.test(c)) {
                let j = i;
                while (j < s.length && /[A-Za-z0-9_.]/.test(s.charAt(j))) j++;
                toks.push({ t: 'id', v: s.slice(i, j) });
                i = j;
                continue;
            }
            if ('()+-*/'.indexOf(c) >= 0) { toks.push({ t: c }); i++; continue; }
            return null;   // 四則の外の文字＝解かない
        }
        // 関数呼び出し（識別子のすぐ後ろが "("）は解かない
        for (let k = 0; k < toks.length - 1; k++) {
            if (toks[k].t === 'id' && toks[k + 1].t === '(') return null;
        }
        let p = 0;
        const peek = function () { return toks[p]; };
        const eat = function (t) { if (peek() && peek().t === t) { p++; return true; } return false; };
        const unary = function () {
            if (eat('-')) { const r = unary(); return r ? { op: 'neg', a: r } : null; }
            if (eat('+')) return unary();
            const tk = peek();
            if (!tk) return null;
            if (tk.t === 'num') { p++; return { op: 'num', v: tk.v }; }
            if (tk.t === 'id') { p++; return { op: 'ref', v: tk.v }; }
            if (eat('(')) { const e = expr(); if (!e || !eat(')')) return null; return e; }
            return null;
        };
        const term = function () {
            let n = unary();
            if (!n) return null;
            for (;;) {
                if (eat('*')) { const r = unary(); if (!r) return null; n = { op: '*', a: n, b: r }; }
                else if (eat('/')) { const r = unary(); if (!r) return null; n = { op: '/', a: n, b: r }; }
                else return n;
            }
        };
        function expr() {
            let n = term();
            if (!n) return null;
            for (;;) {
                if (eat('+')) { const r = term(); if (!r) return null; n = { op: '+', a: n, b: r }; }
                else if (eat('-')) { const r = term(); if (!r) return null; n = { op: '-', a: n, b: r }; }
                else return n;
            }
        }
        const ast = expr();
        if (!ast || p !== toks.length) return null;
        return ast;
    }

    function readPath(rec, dotted) {
        const parts = String(dotted).split('.');
        let v = rec;
        for (let i = 0; i < parts.length; i++) {
            if (v === null || v === undefined || typeof v !== 'object') return undefined;
            v = v[parts[i]];
        }
        return v;
    }

    function evalAst(ast, rec, blankAsZero) {
        if (!ast) return null;
        if (ast.op === 'num') return ast.v;
        if (ast.op === 'ref') {
            const raw = readPath(rec, ast.v);
            if (raw === null || raw === undefined || raw === '') return blankAsZero ? 0 : null;
            const n = Number(raw);
            return isNaN(n) ? null : n;
        }
        if (ast.op === 'neg') {
            const a = evalAst(ast.a, rec, blankAsZero);
            return a === null ? null : -a;
        }
        const a = evalAst(ast.a, rec, blankAsZero);
        const b = evalAst(ast.b, rec, blankAsZero);
        if (a === null || b === null) return null;
        if (ast.op === '+') return a + b;
        if (ast.op === '-') return a - b;
        if (ast.op === '*') return a * b;
        if (ast.op === '/') return b === 0 ? null : a / b;
        return null;
    }

    /** レコード Id の先頭 3 文字からオブジェクトを引く（採取時に describe から採った keyPrefix） */
    function objectOf(id) {
        const pre = String(id === null || id === undefined ? '' : id).slice(0, 3);
        const f = (bundle && bundle.formulas) || {};
        const keys = Object.keys(f);
        for (let i = 0; i < keys.length; i++) {
            if (f[keys[i]].keyPrefix === pre) return keys[i];
        }
        return null;
    }

    /** そのレコードの数式項目を解き直す（数式が数式を参照するので、変わらなくなるまで繰り返す） */
    function recalcFormulas(rec, objName) {
        const def = bundle && bundle.formulas && bundle.formulas[objName];
        if (!def || !def.fields) return;
        const fields = def.fields;
        const names = Object.keys(fields);
        for (let pass = 0; pass < 5; pass++) {
            let moved = false;
            for (let i = 0; i < names.length; i++) {
                const fname = names[i];
                // 画面が読んでいない項目（器に無い項目）は増やさない
                if (!Object.prototype.hasOwnProperty.call(rec, fname)) continue;
                const key = objName + '.' + fname;
                if (!Object.prototype.hasOwnProperty.call(formulaCache, key)) {
                    formulaCache[key] = parseFormula(fields[fname].formula);
                }
                const ast = formulaCache[key];
                if (!ast) continue;
                const v = evalAst(ast, rec, fields[fname].blanks === 'BlankAsZero');
                if (rec[fname] !== v) { rec[fname] = v; moved = true; }
            }
            if (!moved) break;
        }
    }

    /** 保存したレコードの数式を解き直す（Apex の器の形＝Id を持つ素のレコードだけ） */
    function afterWrite(rec) {
        if (!rec || typeof rec !== 'object' || rec.fields) return;
        const obj = objectOf(rec.Id);
        if (obj) recalcFormulas(rec, obj);
    }

    // ===================== Apex =====================
    function apexResolver(name) {
        return function (params) {
            const key = name + '|' + stableKey(params === undefined ? {} : params);
            if (bundle && Object.prototype.hasOwnProperty.call(bundle.apex, key)) {
                return Promise.resolve(bundle.apex[key]);
            }
            return Promise.reject(mkError(
                'この共有版には ' + name + ' のこの呼び出しの応答が入っていません。' +
                'dev6 でこの組み合わせが一度も走らなかった分です（引数: ' + stableKey(params === undefined ? {} : params).slice(0, 120) + '）'
            ));
        };
    }

    // ===================== UI API =====================
    function getRecord(cfg) {
        const id = cfg && cfg.recordId;
        if (!id) return Promise.reject(mkError('recordId がありません'));
        const rec = bundle.records[id];
        if (!rec) return Promise.reject(mkError('この共有版には ' + id + ' のレコードが入っていません'));
        return Promise.resolve(rec);
    }

    function getRecords(cfg) {
        const reqs = (cfg && cfg.records) || [];
        const results = [];
        reqs.forEach(function (r) {
            (r.recordIds || (r.recordId ? [r.recordId] : [])).forEach(function (id) {
                const rec = bundle.records[id];
                if (rec) results.push({ result: rec, statusCode: 200 });
                else results.push({ result: null, statusCode: 404 });
            });
        });
        return Promise.resolve({ results: results });
    }

    function updateRecord(input) {
        const fields = (input && input.fields) || {};
        const id = fields.Id || fields.id;
        if (!id) return Promise.reject(mkError('Id がありません'));
        const targets = idIndex[id] || [];
        if (!targets.length) {
            return Promise.reject(mkError('この共有版には ' + id + ' の保存先が入っていません'));
        }
        Object.keys(fields).forEach(function (k) {
            if (k === 'Id' || k === 'id') return;
            targets.forEach(function (t) {
                if (t.fields && typeof t.id === 'string') {
                    // UI API 形式のレコード
                    t.fields[k] = Object.assign({}, t.fields[k] || {}, { value: fields[k], displayValue: null });
                } else {
                    t[k] = fields[k];
                    patchRelation(t, k, fields[k]);
                }
            });
        });
        // Salesforce ならサーバーが計算する数式項目を、ここで解き直す（金額が動かないと壊れて見える）
        targets.forEach(afterWrite);
        return Promise.resolve({ id: id, fields: fields });
    }

    let newIdSeq = 0;
    function createRecord(input) {
        const apiName = input && input.apiName;
        const fields = (input && input.fields) || {};
        const plan = CREATE_TARGETS[apiName];
        if (!plan) return Promise.reject(mkError(apiName + ' の追加はこの共有版では試せません'));
        const parentId = fields[plan.parentField];
        if (!parentId) return Promise.reject(mkError(plan.parentField + ' がありません'));

        // 親（工事書類）を持っている器を探して、その配列へ足す
        let placed = 0;
        const fake = Object.assign({ Id: 'mock' + String(++newIdSeq).padStart(15, '0'), Name: '（新規）' }, fields);
        Object.keys(bundle.apex).forEach(function (k) {
            const v = bundle.apex[k];
            if (!v || typeof v !== 'object') return;
            const parents = v[plan.parentList];
            if (!Array.isArray(parents)) return;
            if (!parents.some(function (p) { return p && p.Id === parentId; })) return;
            if (!Array.isArray(v[plan.container])) v[plan.container] = [];
            v[plan.container].push(fake);
            // 削除できるように、入れた配列も控える（ここを忘れると「追加はできるが消せない」になる）
            (arrayIndex[fake.Id] = arrayIndex[fake.Id] || []).push({ arr: v[plan.container], obj: fake });
            placed++;
        });
        if (!placed) return Promise.reject(mkError('追加先の器（' + plan.container + '）が見つかりませんでした'));
        (idIndex[fake.Id] = idIndex[fake.Id] || []).push(fake);
        recalcFormulas(fake, apiName);
        return Promise.resolve({ id: fake.Id, fields: fields });
    }

    /** 索引に無い行を探し直す（索引漏れで「消せない」が黙って起きないようにする保険） */
    function locateInArrays(id) {
        const hits = [];
        const walk = function (v, parentArr) {
            if (!v || typeof v !== 'object') return;
            if (Array.isArray(v)) {
                v.forEach(function (x) { walk(x, v); });
                return;
            }
            if (v.Id === id && parentArr) hits.push({ arr: parentArr, obj: v });
            Object.keys(v).forEach(function (k) { walk(v[k], null); });
        };
        walk(bundle && bundle.apex, null);
        return hits;
    }

    function deleteRecord(id) {
        let spots = arrayIndex[id] || [];
        if (!spots.length) spots = locateInArrays(id);
        if (!spots.length) return Promise.reject(mkError('この共有版には ' + id + ' の削除先が入っていません'));
        spots.forEach(function (s) {
            const i = s.arr.indexOf(s.obj);
            if (i >= 0) s.arr.splice(i, 1);
        });
        delete arrayIndex[id];
        delete idIndex[id];
        return Promise.resolve();
    }

    function getFieldValue(record, field) {
        if (!record || !record.fields) return undefined;
        const nm = typeof field === 'string' ? field.split('.').pop() : field && field.fieldApiName;
        const f = record.fields[nm];
        return f ? f.value : undefined;
    }
    function getFieldDisplayValue(record, field) {
        if (!record || !record.fields) return undefined;
        const nm = typeof field === 'string' ? field.split('.').pop() : field && field.fieldApiName;
        const f = record.fields[nm];
        return f ? f.displayValue : undefined;
    }

    function getPicklistValuesByRecordType(cfg) {
        const obj = cfg && cfg.objectApiName;
        const nm = typeof obj === 'string' ? obj : obj && obj.objectApiName;
        const got = bundle.picklists && bundle.picklists[nm];
        if (!got) return Promise.reject(mkError('この共有版には ' + nm + ' の選択リストが入っていません'));
        return Promise.resolve(got);
    }
    function getObjectInfo(cfg) {
        const nm = cfg && (typeof cfg.objectApiName === 'string' ? cfg.objectApiName : cfg.objectApiName && cfg.objectApiName.objectApiName);
        return Promise.reject(mkError('この共有版には ' + nm + ' のオブジェクト定義が入っていません'));
    }

    // ===================== 画面遷移・通知 =====================
    const Navigate = Symbol('Navigate');
    const GenerateUrl = Symbol('GenerateUrl');
    function NavigationMixin(Base) {
        const C = class extends Base {};
        C.prototype[Navigate] = function (ref) {
            navSink.forEach(function (f) { f(ref); });
        };
        C.prototype[GenerateUrl] = function () { return Promise.resolve('#'); };
        return C;
    }
    NavigationMixin.Navigate = Navigate;
    NavigationMixin.GenerateUrl = GenerateUrl;
    function onNavigate(fn) { navSink.push(fn); }

    class ShowToastEvent extends CustomEvent {
        constructor(cfg) {
            super('lightning__showtoast', { detail: cfg || {}, bubbles: true, composed: true });
        }
    }

    function encodeDefaultFieldValues(obj) {
        return Object.keys(obj || {}).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] === null || obj[k] === undefined ? '' : obj[k]);
        }).join(',');
    }

    // ===================== 取り付け =====================
    function install(b) {
        bundle = b;
        Object.keys(idIndex).forEach(function (k) { delete idIndex[k]; });
        Object.keys(arrayIndex).forEach(function (k) { delete arrayIndex[k]; });
        indexAll(bundle.apex, null);
        indexAll(bundle.records, null);

        const L = window.SfMockLwc;
        L.define('lightning/uiRecordApi', {
            getRecord: getRecord,
            getRecords: getRecords,
            updateRecord: updateRecord,
            createRecord: createRecord,
            deleteRecord: deleteRecord,
            getFieldValue: getFieldValue,
            getFieldDisplayValue: getFieldDisplayValue,
            createRecordInputFilteredByEditedFields: function (i) { return i; },
            generateRecordInputForUpdate: function (r) { return { fields: { Id: r && r.id } }; },
            getRecordNotifyChange: function () {}
        });
        L.define('lightning/uiObjectInfoApi', {
            getPicklistValuesByRecordType: getPicklistValuesByRecordType,
            getObjectInfo: getObjectInfo
        });
        L.define('lightning/navigation', { NavigationMixin: NavigationMixin, CurrentPageReference: function () {} });
        L.define('lightning/platformShowToastEvent', { ShowToastEvent: ShowToastEvent });
        L.define('lightning/pageReferenceUtils', { encodeDefaultFieldValues: encodeDefaultFieldValues });
        L.define('lightning/empApi', { subscribe: function () { return Promise.resolve({}); }, unsubscribe: function () { return Promise.resolve(); }, onError: function () {} });
        L.define('@salesforce/apex', { refreshApex: function (x) { return L.rerunWire(x && x.__wireRef); } });
        L.defineApexResolver(apexResolver);
        L.setRecordDirectory(nameOf, searchNames);
    }

    /** 数式のうち「解ける／解かない」の内訳（画面の注記と検証で使う） */
    function formulaCoverage() {
        const out = {};
        const f = (bundle && bundle.formulas) || {};
        Object.keys(f).forEach(function (obj) {
            const fields = f[obj].fields || {};
            let ok = 0;
            let skip = 0;
            Object.keys(fields).forEach(function (n) {
                if (parseFormula(fields[n].formula)) ok++; else skip++;
            });
            out[obj] = { keyPrefix: f[obj].keyPrefix, solvable: ok, skipped: skip };
        });
        return out;
    }

    return {
        install: install,
        formulaCoverage: formulaCoverage,
        recalcFormulas: recalcFormulas,
        onNavigate: onNavigate,
        nameOf: nameOf,
        searchNames: searchNames,
        stableKey: stableKey
    };
})();
