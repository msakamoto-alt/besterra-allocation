/**
 * app.js — SF 案件・工事管理モックアップ（工事部レビュー用）の外側。
 *
 * 中身は **dev6 の部品そのもの**（koujiKagami を起点に辿って集めた 13 部品＋共通 CSS）。
 * lwc-runtime.js が Salesforce の代わりに描き、sf-data.js が dev6 から録った応答を返す。
 * だから画面の移動・入力・計算は dev6 と同じ手つきで試せる（保存だけは手元で止まる）。
 *
 * ここが受け持つのは 4 つ:
 *   1. ログイン（統合管理ツールと同じアカウント・同一オリジンでセッション共有）
 *   2. 素材の取得（非公開バケット sfmock ＝ ログイン済みだけ。工事名・取引先・金額・氏名が入るため）
 *   3. 工事の切替（dev6 のレコードページを開き直すのと同じ＝部品を作り直す）
 *   4. コメント（画面のどこでもクリックしてピン・返信・対応済み・Realtime で同時に何人でも）
 *
 * 画面の移動そのものは部品の左メニューで行う（＝実物の導線をそのまま試してもらう）。
 * 共有版は左に帯を置かない（部品が自前の左メニューを持つうえ、dev6 の画面は Lightning の 1 画面ぶんの
 * 横幅を前提に組まれている＝帯を置くと列が潰れる）。工事の切替は上の帯、画面ごとのコメント件数は
 * コメント欄の目次に出し、押せば部品の移動メソッドを呼ぶ（段階ゲートも本物のまま）。
 */
(function () {
    'use strict';

    const BUCKET = 'sfmock';
    const $ = (id) => document.getElementById(id);

    // 部品の一覧は**目次（manifest）から来る**。採取が koujiKagami を起点にテンプレートの c- タグと
    // import 'c/…' を辿って集めたもので、dev6 に部品が増えてもこちら側を直さなくていい。
    //   parts   … .html を持つ＝画面の部品（タグ名つき）
    //   modules … .js だけ＝値のモジュール（c/kagamiData）
    //   styles  … .css だけ＝共通スタイル（c/kagamiCss ＝配色トークンと共有クラス）
    // 組み立てに失敗した部品だけ、その場で札に置き換える（黙って空白にしない）。
    // コメントの目次に並べる画面 → 部品自身の移動メソッド（段階ゲートを通すため直接 currentPage は触らない）
    const PAGES = [
        { key: 'anken', label: '案件管理', go: 'goAnken' },
        { key: 'mitsumori', label: '見積管理', go: 'goMitsumori' },
        { key: 'kagami', label: '工事管理', go: 'goKagami' },
        { key: 'jikko', label: '実行予算', go: 'goJikkoYosan' },
        { key: 'hacchu', label: '発注管理', go: 'goHacchu' },
        { key: 'dekidaka', label: '出来高検収', go: 'goDekidaka' },
        { key: 'yuka', label: '有価物管理', go: 'goYukabutsu' },
        { key: 'jinhaichi', label: '人員配置', go: 'goJinhaichiPage' }
    ];
    // 画面ごとの一言。原島さん作の 3 画面は「表示は本物・保存はできない」ことを先に伝える
    const HARASHIMA_NOTE = 'この画面（実行予算・発注管理・出来高検収）は原島さん作の部品です。'
        + '表示は dev6 の実物どおりですが、保存・承認・発行は共有版では動きません。'
        + '実際の動きは dev6 でご確認ください。';
    const PAGE_NOTES = { jikko: HARASHIMA_NOTE, hacchu: HARASHIMA_NOTE, dekidaka: HARASHIMA_NOTE };
    const ALL_SITES = { key: 'all', label: '人員配置（全工事）', no: '全工事のガント', note: '左の帯なしの全画面表示' };

    const S = {
        sb: null,
        bundle: null,
        comp: null,
        projKey: null,
        screenId: null,
        comments: [],
        user: null,
        scope: 'this',
        openOnly: false,
        commenting: false,
        activeRoot: null,
        tableReady: true,
        built: false
    };

    // ===================== 小物 =====================
    function toast(msg, kind, ms) {
        const el = document.createElement('div');
        el.className = 'sfm-toast' + (kind ? ' ' + kind : '');
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), ms || 3600);
    }
    function esc(s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function when(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        const now = new Date();
        const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        return d.toDateString() === now.toDateString() ? '今日 ' + hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
    }
    // コメントを置くモード。ON の間は画面全体に受け皿を被せるので、画面の操作はできなくなる。
    // 付けっぱなしにすると「押しても何も起きない」になるため、1 か所置いたら自動で戻す。
    function setCommenting(on) {
        S.commenting = !!on;
        $('sfm-btn-comment').className = 'sfm-btn2 ' + (S.commenting ? 'on' : 'ghost');
        $('sfm-btn-comment').textContent = S.commenting ? '置くのをやめる' : 'コメントを置く';
        placePins();
    }

    function showErr(msg) {
        const bar = $('sfm-errbar');
        $('sfm-errbar-text').textContent = msg;
        bar.classList.remove('sfm-hidden');
    }

    // ===================== 認証 =====================
    async function initSupabase() {
        if (!window.Sync || !Sync.SUPABASE_URL || !Sync.SUPABASE_ANON_KEY) {
            alert('Supabase の接続設定（js/config.js）が読めませんでした。管理者へご連絡ください。');
            throw new Error('no config');
        }
        S.sb = window.supabase.createClient(Sync.SUPABASE_URL, Sync.SUPABASE_ANON_KEY);
    }
    async function currentUser() {
        const { data } = await S.sb.auth.getSession();
        if (!data || !data.session) return null;
        const u = data.session.user;
        let name = (u.user_metadata && u.user_metadata.display_name) || '';
        let role = null;
        try {
            const r = await S.sb.from('user_roles').select('display_name, role').eq('user_id', u.id).maybeSingle();
            if (r && r.data) { name = r.data.display_name || name; role = r.data.role; }
        } catch (e) { /* user_roles が読めなくてもレビューはできる */ }
        return { id: u.id, email: u.email, name: name || (u.email || '').split('@')[0], role };
    }
    function showLogin(show) { $('sfm-login').classList.toggle('sfm-hidden', !show); }
    async function handleLogin(ev) {
        ev.preventDefault();
        const err = $('sfm-login-err');
        err.classList.add('sfm-hidden');
        const { error } = await S.sb.auth.signInWithPassword({ email: $('sfm-email').value.trim(), password: $('sfm-pw').value });
        if (error) {
            err.textContent = 'ログインできませんでした（メールアドレスかパスワードをご確認ください）';
            err.classList.remove('sfm-hidden');
            return;
        }
        S.user = await currentUser();
        showLogin(false);
        await start();
    }

    // ===================== 素材（非公開バケット） =====================
    async function grab(path, asJson) {
        const { data, error } = await S.sb.storage.from(BUCKET).download(path);
        if (error || !data) return null;
        const text = await data.text();
        if (!asJson) return text;
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    async function loadBundle() {
        const manifest = await grab('manifest.json', true);
        if (!manifest) return null;
        const names = ['apex.json', 'records.json', 'picklists.json', 'names.json', 'formulas.json'];
        const optional = ['listview.json']; // 入口の一覧（無ければ案件の帯で代用）
        const srcNames = [];
        (manifest.styles || []).forEach((x) => srcNames.push(x.css));
        (manifest.modules || []).forEach((m) => srcNames.push(m.js));
        (manifest.parts || []).forEach((p) => [p.html, p.js, p.css].forEach((f) => { if (f) srcNames.push(f); }));

        const jsons = await Promise.all(names.concat(optional).map((n) => grab(n, true)));
        const srcs = await Promise.all(srcNames.map((n) => grab('src/' + n, false)));
        const src = {};
        srcNames.forEach((n, i) => { src[n] = srcs[i]; });

        const missing = names.filter((n, i) => !jsons[i]).concat(srcNames.filter((n) => !src[n]));
        return {
            manifest,
            apex: jsons[0] || {},
            records: jsons[1] || {},
            picklists: jsons[2] || {},
            names: jsons[3] || {},
            formulas: jsons[4] || {},
            listview: jsons[5] || null,
            src,
            missing
        };
    }

    // ===================== dev6 の CSS を #sfm-mount の中だけに効かせる =====================
    function matchBrace(s, open) {
        let d = 0;
        for (let i = open; i < s.length; i++) {
            if (s[i] === '{') d++;
            else if (s[i] === '}') { d--; if (!d) return i; }
        }
        return -1;
    }
    // LWC の :host（部品そのもの）は共有版では入れ物の #sfm-mount にあたる。
    // :host([data-theme='dark']) のような形も、括弧の中をそのまま付けて同じ意味にする。
    function prefixSel(sel, scope) {
        if (sel.indexOf(':host') !== 0) return scope + ' ' + sel;
        const m = /^:host\(([^)]*)\)\s*(.*)$/.exec(sel);
        if (m) return scope + m[1] + (m[2] ? ' ' + m[2] : '');
        return scope + sel.slice(5);
    }

    function scopeCss(src, scope) {
        src = String(src || '').replace(/\/\*[\s\S]*?\*\//g, '');
        let out = '';
        let i = 0;
        while (i < src.length) {
            const open = src.indexOf('{', i);
            if (open < 0) { out += src.slice(i); break; }
            const close = matchBrace(src, open);
            if (close < 0) { out += src.slice(i); break; }
            let prelude = src.slice(i, open);
            const body = src.slice(open + 1, close);
            // @charset / @import のような「;で終わる文」は前に出しておく
            const semi = prelude.lastIndexOf(';');
            if (semi >= 0) { out += prelude.slice(0, semi + 1); prelude = prelude.slice(semi + 1); }
            prelude = prelude.trim();
            if (/^@(media|supports|layer|container|document)/i.test(prelude)) {
                out += prelude + '{' + scopeCss(body, scope) + '}';
            } else if (prelude.charAt(0) === '@') {
                out += prelude + '{' + body + '}';
            } else {
                out += prelude.split(',').map((s) => s.trim()).filter(Boolean).map((s) => prefixSel(s, scope)).join(',') + '{' + body + '}';
            }
            i = close + 1;
        }
        return out;
    }
    function injectCss() {
        // @import 'c/kagamiCss'; は LWC の書き方（ブラウザは辿れない）＝落として、共通 CSS を先頭に置く
        const strip = (t) => String(t || '').replace(/@import\s+['"]c\/[^'"]+['"]\s*;?/g, '');
        const m = S.bundle.manifest;
        const files = (m.styles || []).map((x) => x.css).concat((m.parts || []).map((p) => p.css).filter(Boolean));
        const css = files.map((n) => '/* ' + n + ' */\n' + scopeCss(strip(S.bundle.src[n]), '#sfm-mount')).join('\n');
        const st = document.createElement('style');
        st.id = 'sfm-part-css';
        st.textContent = css;
        document.head.appendChild(st);
    }

    // ===================== 部品を組み立てる =====================
    function buildParts() {
        window.SfMockLwc.onError((where, e) => showErr('画面の処理でつまずきました（' + where + '）: ' + ((e && e.message) || e)));
        const man = S.bundle.manifest;
        (man.modules || []).forEach((mod) => {
            try {
                window.SfMockLwc.defineFromSource(mod.name, S.bundle.src[mod.js], mod.js);
            } catch (e) {
                showErr('モジュールを読めませんでした: ' + mod.name + '（' + e.message + '）');
            }
        });
        window.SfMockData.install(S.bundle);
        const failed = [];
        (man.parts || []).forEach((p) => {
            try {
                window.SfMockLwc.buildComponent(p.tag, S.bundle.src[p.html], p.js ? S.bundle.src[p.js] : '', p.bundle);
            } catch (e) {
                failed.push(p.tag);
                window.SfMockLwc.registerPlaceholder(p.tag, p.bundle + '（この共有版では組み立てられませんでした）');
            }
        });
        (man.missing || []).forEach((b) => window.SfMockLwc.registerPlaceholder('c-' + b, b + '（dev6 に見つからない部品）'));
        if (failed.length) showErr('組み立てられなかった部品 ' + failed.length + ' 個: ' + failed.join(' / ') + '（その場所は札になります）');
        window.SfMockData.onNavigate(navNotice);
        window.SfMockLwc.onAfterRender(afterRender);
        $('sfm-mount').addEventListener('lightning__showtoast', (e) => {
            const d = e.detail || {};
            const kind = d.variant === 'error' ? 'err' : d.variant === 'success' ? 'ok' : '';
            toast([d.title, d.message].filter(Boolean).join(' — '), kind, d.variant === 'error' ? 7000 : 3600);
        });
        S.built = true;
    }

    function navNotice(ref) {
        const a = (ref && ref.attributes) || {};
        const what = a.objectApiName || a.apiName || a.recordId || (ref && ref.type) || '別の画面';
        toast('dev6 ではここから「' + what + '」へ移動します。共有版では移動しません。', '', 4200);
    }

    // ===================== 入口＝案件のリストビュー（dev6 のまま） =====================
    // 上の帯（工事のタブ）は SF に無い見た目で誤解を生む（2026-09-26 坂本さん）。dev6 の「案件」タブの
    // リストビュー「すべての案件・工事」を、列・並び・表示値そのままに描く。案件名を押すと案件が開く（＝SF と同じ動き）
    const LIST_KEY = 'list';

    function mountList() {
        S.projKey = LIST_KEY;
        S.comp = null;
        S.activeRoot = null;
        S.screenId = LIST_KEY + '|anken-list';
        $('sfm-mount').replaceChildren(buildListView());
        renderChrome();
        renderComments();
        $('sfm-title').textContent = ''; // パンくずが「案件一覧」を出すので重ねない
        $('sfm-pagenote').classList.add('sfm-hidden');
    }

    function buildListView() {
        const lv = S.bundle.listview;
        const projs = S.bundle.manifest.projects;
        const byId = {};
        projs.forEach((x) => { byId[x.ankenId] = x; });
        const wrap = document.createElement('div');
        wrap.className = 'sfl';
        // 採れていないときは、案件の帯と同じ中身を最小の列で（列は当てない＝dev6 の列が採れるまでの代用）
        const view = lv || {
            objectLabel: '案件', listLabel: '共有版に採ってある案件', themeColor: '', sortBy: 'Name', capturedAt: S.bundle.manifest.capturedAt,
            columns: [{ label: '案件名', field: 'Name' }, { label: 'tera 工事番号', field: 'TeraProjectNo__c' }],
            rows: projs.map((x) => ({ id: x.ankenId, fields: { Name: { display: x.label }, TeraProjectNo__c: { display: x.no } } }))
        };
        const cols = view.columns || [];
        const sortField = String(view.sortBy || 'Name').split(',')[0].replace(/^-/, '');
        const sortDesc = /^-/.test(String(view.sortBy || ''));
        const sortLabel = (cols.find((c) => c.field === sortField) || {}).label || sortField;
        const text = (r, c) => { const f = (r.fields || {})[c.field] || {}; return f.display !== null && f.display !== undefined ? String(f.display) : (f.value !== null && f.value !== undefined ? String(f.value) : ''); };
        const th = cols.map((c) => `<th class="sfl-th${c.field === sortField ? ' sorted' : ''}" title="${esc(c.label)}"><span class="sfl-th-lab">${esc(c.label)}</span>${c.field === sortField ? `<span class="sfl-sort">${sortDesc ? '↓' : '↑'}</span>` : ''}<span class="sfl-chev">⌄</span></th>`).join('');
        const tr = (view.rows || []).map((r, i) => {
            const proj = byId[r.id];
            const tds = cols.map((c) => {
                const t = text(r, c);
                if (c.field === 'Name') {
                    return proj
                        ? `<td class="sfl-td"><a class="sfl-link" data-proj="${esc(proj.key)}" href="#" title="${esc(proj.note || '')}">${esc(t)}</a></td>`
                        : `<td class="sfl-td"><span class="sfl-dim" title="この案件は共有版に採っていません（dev6 で確認してください）">${esc(t)}</span></td>`;
                }
                if (c.lookupId && t) return `<td class="sfl-td"><a class="sfl-link sfl-look" href="#" data-look="${esc(c.label)}">${esc(t)}</a></td>`;
                return `<td class="sfl-td">${esc(t)}</td>`;
            }).join('');
            return `<tr class="sfl-tr"><td class="sfl-num">${i + 1}</td><td class="sfl-chk"><span class="sfl-box"></span></td>${tds}<td class="sfl-act"><span class="sfl-actbtn" title="dev6 では行の操作（編集・削除）が開きます。共有版では開きません">▾</span></td></tr>`;
        }).join('');
        const color = view.themeColor ? '#' + String(view.themeColor).replace(/^#/, '') : '#5867e8';
        wrap.innerHTML = `
            <div class="sfl-head">
              <div class="sfl-icon" style="background:${esc(color)}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="#fff" d="M4 5h16v3H4zm0 5h16v3H4zm0 5h16v3H4z"/></svg></div>
              <div class="sfl-head-txt">
                <div class="sfl-obj">${esc(view.objectLabel || '案件')}</div>
                <div class="sfl-name">${esc(view.listLabel || '')} <span class="sfl-chev">▾</span></div>
              </div>
              <div class="sfl-head-r">${lv ? 'dev6 のリストビューを列・並び・値そのままに（' + esc(when(view.capturedAt)) + ' 採取）' : 'dev6 のリストビューはまだ採れていません（列は仮）'}</div>
            </div>
            <div class="sfl-sub">
              <span>${(view.rows || []).length} 個の項目・並び替え基準: ${esc(sortLabel)}・${esc(when(view.capturedAt))} に採取</span>
              <input class="sfl-search" type="search" placeholder="このリストを検索..." aria-label="このリストを検索">
            </div>
            <div class="sfl-tablewrap"><table class="sfl-table"><thead><tr><th class="sfl-num"></th><th class="sfl-chk"><span class="sfl-box"></span></th>${th}<th class="sfl-act"></th></tr></thead><tbody>${tr}</tbody></table></div>
            <div class="sfl-foot">
              <span class="nt">共有版</span><span>案件名を押すと、その案件の画面（dev6 の部品そのもの）が開きます。共有版に採ってある案件は ${projs.length} 件。</span>
              <a href="#" class="sfl-all" data-proj="all">人員配置（全工事のガント）を開く</a>
            </div>`;
        wrap.querySelectorAll('[data-proj]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); mountProject(a.dataset.proj); }));
        wrap.querySelectorAll('[data-look]').forEach((a) => a.addEventListener('click', (e) => {
            e.preventDefault();
            toast('dev6 ではここから「' + a.dataset.look + '」のレコードへ移動します。共有版では移動しません。', '', 4200);
        }));
        const search = wrap.querySelector('.sfl-search');
        search.addEventListener('input', () => {
            const q = search.value.trim();
            wrap.querySelectorAll('tbody tr').forEach((row) => { row.style.display = !q || row.textContent.indexOf(q) >= 0 ? '' : 'none'; });
        });
        return wrap;
    }

    // ===================== 工事の切替（＝部品を作り直す） =====================
    function mountProject(key) {
        S.projKey = key;
        S.activeRoot = null;
        const proj = S.bundle.manifest.projects.find((p) => p.key === key);
        const props = key === ALL_SITES.key ? { initialPage: 'jinhaichi' } : { recordId: proj.ankenId };
        $('sfm-mount').replaceChildren();
        try {
            S.comp = window.SfMockLwc.mount('c-kouji-kagami', $('sfm-mount'), props);
        } catch (e) {
            showErr('画面を組み立てられませんでした: ' + e.message);
            return;
        }
        S.screenId = key + '|' + (S.comp.raw.currentPage || 'anken');
        renderChrome();
        renderComments();
    }

    function currentLabel() {
        const proj = S.projKey === ALL_SITES.key ? ALL_SITES : S.bundle.manifest.projects.find((p) => p.key === S.projKey);
        const page = S.comp ? S.comp.raw.currentPage : '';
        const view = S.comp ? S.comp.raw.currentView : '';
        const pg = PAGES.find((p) => pageKeyOf(page) === p.key);
        const viewName = page === 'kagami' && view ? '（' + ({ parent: '親案件', main: '本体工事', add: '追加工事' }[view] || view) + '）' : '';
        return (proj ? proj.label : '') + '／' + ((pg && pg.label) || page || '—') + viewName;
    }

    // 部品の currentPage は画面ごとに名前が違う（'jikkoyosan' 等）ので、レールの key に寄せる
    function pageKeyOf(cur) {
        const map = { anken: 'anken', mitsumori: 'mitsumori', kagami: 'kagami', jikkoyosan: 'jikko', jikko: 'jikko', hacchu: 'hacchu', dekidaka: 'dekidaka', yukabutsu: 'yuka', yuka: 'yuka', jinhaichi: 'jinhaichi' };
        return map[cur] || cur;
    }

    // 部品が描き終わるたびに、左レールの位置とピンを合わせる
    function afterRender(root) {
        if (root !== S.comp) return;
        const id = S.projKey + '|' + pageKeyOf(S.comp.raw.currentPage);
        if (id !== S.screenId) {
            S.screenId = id;
            S.activeRoot = null;
            renderChrome();
            renderComments();
        } else {
            renderIndex();
        }
        $('sfm-title').textContent = currentLabel();
        const note = PAGE_NOTES[pageKeyOf(S.comp.raw.currentPage)] || '';
        $('sfm-pagenote').textContent = note;
        $('sfm-pagenote').classList.toggle('sfm-hidden', !note);
        placePins();
    }

    // ===================== 上の帯とコメントの目次 =====================
    // 左に帯を置かない（部品が自前の左メニューを持っていて重複するうえ、dev6 の画面は
    // Lightning の 1 画面ぶんの横幅を前提に組まれている＝帯を置くと列が潰れる）。
    // 工事の切替は上の帯、画面ごとのコメント件数はコメント欄の目次に出す。
    function renderChrome() {
        // 工事のタブは置かない（SF に無い見た目＝誤解のもと・2026-09-26）。SF と同じく「一覧 › 案件」のパンくずだけ
        const onList = S.projKey === LIST_KEY;
        const proj = S.projKey === ALL_SITES.key ? ALL_SITES : S.bundle.manifest.projects.find((p) => p.key === S.projKey);
        $('sfm-projs').innerHTML = onList
            ? '<span class="sfm-crumb on">案件一覧</span>'
            : `<button class="sfm-back" id="sfm-back" title="dev6 の「案件」タブのリストビューに戻る">‹ 案件一覧</button><span class="sfm-crumb-sep">›</span><span class="sfm-crumb on">${esc(proj ? proj.label : '')}<span class="sub">${esc(proj ? (proj.no || '') : '')}</span></span>`;
        const back = $('sfm-back');
        if (back) back.addEventListener('click', () => mountList());
        renderIndex();
    }

    function renderIndex() {
        const cur = pageKeyOf(S.comp ? S.comp.raw.currentPage : '');
        const list = S.projKey === ALL_SITES.key || S.projKey === LIST_KEY ? [] : PAGES;
        $('sfm-index').innerHTML = list.map((p) => {
            const sid = S.projKey + '|' + p.key;
            const roots = S.comments.filter((c) => c.screen_id === sid && !c.parent_id);
            const open = roots.filter((c) => c.status !== 'resolved').length;
            const badge = roots.length ? `<span class="sfm-badge-n${open ? '' : ' done'}">${open || roots.length}</span>` : '';
            return `<button class="sfm-ix${p.key === cur ? ' on' : ''}" data-page="${esc(p.key)}">${esc(p.label)}${badge}</button>`;
        }).join('');
        $('sfm-index').querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
            const p = PAGES.find((x) => x.key === b.dataset.page);
            if (!p || !S.comp) return;
            try {
                S.comp.proxy[p.go]();          // 部品自身の移動＝段階ゲートも本物のまま
                window.SfMockLwc.markDirty(S.comp);
            } catch (e) {
                toast('この画面へは移動できませんでした: ' + e.message, 'err');
            }
        }));
    }

    // ===================== ピン（画面の上の位置） =====================
    function wrapSize() {
        const w = $('sfm-mount');
        return { w: w.scrollWidth || w.clientWidth, h: w.scrollHeight || w.clientHeight };
    }
    function placePins() {
        const box = $('sfm-pins');
        const sz = wrapSize();
        box.style.width = sz.w + 'px';
        box.style.height = sz.h + 'px';
        const roots = S.comments.filter((c) => c.screen_id === S.screenId && !c.parent_id && c.x_pct !== null && c.x_pct !== undefined);
        box.innerHTML = roots.map((c, i) => {
            const stale = c.capture_version && c.capture_version !== S.bundle.manifest.capturedAt;
            const cls = 'sfm-pin' + (c.status === 'resolved' ? ' resolved' : stale ? ' stale' : '') + (S.activeRoot === c.id ? ' active' : '');
            return `<div class="${cls}" data-pin="${c.id}" title="${esc(c.user_name || '')}：${esc((c.body || '').slice(0, 60))}"
                style="left:${(c.x_pct / 100 * sz.w).toFixed(1)}px;top:${(c.y_pct / 100 * sz.h).toFixed(1)}px"><span>${i + 1}</span></div>`;
        }).join('');
        box.querySelectorAll('[data-pin]').forEach((el) => el.addEventListener('click', (e) => {
            e.stopPropagation();
            S.activeRoot = Number(el.dataset.pin);
            S.scope = 'this';
            syncTabs();
            placePins();
            renderComments();
            const t = document.querySelector('.sfm-thread.active');
            if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }));

        const catcher = $('sfm-catch');
        catcher.classList.toggle('sfm-hidden', !S.commenting);
        catcher.style.width = sz.w + 'px';
        catcher.style.height = sz.h + 'px';
    }

    // クリックした場所の「目印になる文字」を拾う（撮り直しでピンがずれても何の話か分かるように）
    function anchorAt(clientX, clientY) {
        const c = $('sfm-catch');
        const keep = c.style.pointerEvents;
        c.style.pointerEvents = 'none';
        const el = document.elementFromPoint(clientX, clientY);
        c.style.pointerEvents = keep;
        let n = el;
        for (let i = 0; i < 5 && n; i++) {
            const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && t.length <= 40) return t;
            n = n.parentElement;
        }
        const t2 = ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
        return t2 ? t2.slice(0, 40) : '';
    }

    function openPopover(xPct, yPct, anchor, clientX, clientY) {
        closePopover();
        const pop = document.createElement('div');
        pop.className = 'sfm-pop';
        pop.id = 'sfm-pop';
        pop.innerHTML = `<div class="lab">この場所へのコメント${anchor ? '（' + esc(anchor) + ' のあたり）' : ''}</div>
            <textarea id="sfm-pop-text" placeholder="気になったこと・直してほしいこと・確認したいこと"></textarea>
            <div class="act">
                <button class="sfm-btn2 ghost" id="sfm-pop-cancel">やめる</button>
                <button class="sfm-btn2 primary" id="sfm-pop-save">置く</button>
            </div>`;
        document.body.appendChild(pop);
        pop.style.left = Math.min(window.innerWidth - 312, Math.max(8, clientX + 12)) + 'px';
        pop.style.top = Math.min(window.innerHeight - 170, Math.max(8, clientY + 8)) + 'px';
        $('sfm-pop-text').focus();
        $('sfm-pop-cancel').addEventListener('click', () => { closePopover(); setCommenting(false); });
        $('sfm-pop-save').addEventListener('click', async () => {
            const body = $('sfm-pop-text').value.trim();
            if (!body) return;
            closePopover();
            setCommenting(false);   // 1 か所置いたら操作に戻す（受け皿を被せたままにしない）
            await addComment(body, xPct, yPct, null, anchor);
        });
        pop.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closePopover();
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('sfm-pop-save').click();
        });
    }
    function closePopover() { const p = $('sfm-pop'); if (p) p.remove(); }

    // ===================== コメント =====================
    async function loadComments() {
        const { data, error } = await S.sb.from('sf_mock_comments').select('*').order('id', { ascending: true });
        if (error) { S.tableReady = false; S.comments = []; return; }
        S.tableReady = true;
        S.comments = data || [];
    }

    async function addComment(body, xPct, yPct, parentId, anchor) {
        const row = {
            user_id: S.user.id,
            user_name: S.user.name,
            screen_id: S.screenId,
            screen_label: currentLabel(),
            x_pct: xPct === null || xPct === undefined ? null : Number(xPct.toFixed(3)),
            y_pct: yPct === null || yPct === undefined ? null : Number(yPct.toFixed(3)),
            body,
            parent_id: parentId || null,
            capture_version: S.bundle.manifest.capturedAt
        };
        if (anchor) row.anchor_label = anchor;
        let { data, error } = await S.sb.from('sf_mock_comments').insert(row).select().single();
        // 器が古くて anchor_label の列が無いことがある（SQL を流し直せば入る）。
        // 目印ひとつのためにコメントを失わせない＝目印を落として入れ直し、直し方を帯で伝える
        if (error && /anchor_label/.test(error.message || '')) {
            delete row.anchor_label;
            ({ data, error } = await S.sb.from('sf_mock_comments').insert(row).select().single());
            if (!error) showErr('コメントの器が古いままです（ピンの目印が残りません）。supabase/add_sf_mock_comments.sql を流し直すと直ります。');
        }
        if (error) {
            toast(S.tableReady ? '投稿できませんでした（' + error.message + '）' : 'コメントの器がまだありません（管理者が SQL を流すと使えます）', 'err', 7000);
            return;
        }
        upsertLocal(data);
        S.activeRoot = data.parent_id || data.id;
        renderChrome();
        placePins();
        renderComments();
    }

    async function setStatus(id, status) {
        const { error } = await S.sb.from('sf_mock_comments').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) { toast('変えられませんでした（' + error.message + '）', 'err'); return; }
        const c = S.comments.find((x) => x.id === id);
        if (c) c.status = status;
        renderChrome();
        placePins();
        renderComments();
    }

    async function removeComment(id) {
        if (!window.confirm('このコメントを削除します。よろしいですか？')) return;
        const { error } = await S.sb.from('sf_mock_comments').delete().eq('id', id);
        if (error) { toast('削除できませんでした（' + error.message + '）', 'err'); return; }
        S.comments = S.comments.filter((c) => c.id !== id && c.parent_id !== id);
        renderChrome();
        placePins();
        renderComments();
    }

    function upsertLocal(row) {
        const i = S.comments.findIndex((c) => c.id === row.id);
        if (i >= 0) S.comments[i] = row; else S.comments.push(row);
        S.comments.sort((a, b) => a.id - b.id);
    }

    function renderComments() {
        const list = $('sfm-clist');
        if (!S.tableReady) {
            list.innerHTML = `<div class="sfm-warn">コメントの保存先（テーブル）がまだ作られていません。<br>
                管理者が <code>supabase/add_sf_mock_comments.sql</code> を Supabase の SQL Editor で流すと、この場で書けるようになります。
                <br><br>画面を見て回ることは今でもできます。</div>`;
            $('sfm-ccount').textContent = '';
            return;
        }
        const scoped = S.comments.filter((c) => !c.parent_id && (S.scope === 'all' || c.screen_id === S.screenId));
        const roots = S.openOnly ? scoped.filter((c) => c.status !== 'resolved') : scoped;
        const pinNo = {};
        S.comments.filter((c) => !c.parent_id && c.x_pct !== null && c.x_pct !== undefined).forEach((c) => {
            pinNo[c.screen_id] = (pinNo[c.screen_id] || 0) + 1;
            c._no = pinNo[c.screen_id];
        });
        const allRoots = S.comments.filter((c) => !c.parent_id);
        $('sfm-ccount').textContent = `未対応 ${allRoots.filter((c) => c.status !== 'resolved').length} 件／全 ${allRoots.length} 件`;

        if (!roots.length) {
            list.innerHTML = `<p class="sfm-empty">${S.scope === 'all' ? 'まだコメントはありません。' : 'この画面へのコメントはまだありません。'}<br>
                場所を指したいときは上の「コメントを置く」を押してから、画面をクリックしてください。</p>`;
            return;
        }
        list.innerHTML = roots.slice().reverse().map(thread).join('');
        bindThreadEvents();
    }

    function thread(c) {
        const replies = S.comments.filter((r) => r.parent_id === c.id);
        const mine = S.user && (c.user_id === S.user.id || S.user.role === 'admin');
        const stale = c.capture_version && c.capture_version !== S.bundle.manifest.capturedAt;
        return `<div class="sfm-thread${S.activeRoot === c.id ? ' active' : ''}${c.status === 'resolved' ? ' resolved' : ''}" data-root="${c.id}">
            <div class="sfm-c-head">
                ${c._no ? `<span class="sfm-chip no">#${c._no}</span>` : ''}
                <span class="sfm-c-who">${esc(c.user_name || '—')}</span><span>${when(c.created_at)}</span>
                <span class="sfm-chip ${c.status === 'resolved' ? 'done' : 'open'}">${c.status === 'resolved' ? '対応済み' : '未対応'}</span>
                ${stale ? '<span class="sfm-chip stale" title="このコメントの後で素材が採り直されています">素材更新後</span>' : ''}
            </div>
            ${S.scope === 'all' ? `<div class="sfm-c-where" data-jump="${esc(c.screen_id)}">${esc(c.screen_label || c.screen_id)}</div>` : ''}
            ${c.anchor_label ? `<div class="sfm-c-anchor">${esc(c.anchor_label)} のあたり</div>` : ''}
            <div class="sfm-c-body">${esc(c.body)}</div>
            ${replies.map((r) => `<div class="sfm-c-reply">
                <div class="sfm-c-head"><span class="sfm-c-who">${esc(r.user_name || '—')}</span><span>${when(r.created_at)}</span>
                ${S.user && (r.user_id === S.user.id || S.user.role === 'admin') ? `<button class="sfm-act danger" style="margin-left:auto" data-del="${r.id}">削除</button>` : ''}</div>
                <div class="sfm-c-body">${esc(r.body)}</div></div>`).join('')}
            <div class="sfm-acts">
                <button class="sfm-act" data-reply="${c.id}">返信</button>
                <button class="sfm-act" data-status="${c.id}" data-to="${c.status === 'resolved' ? 'open' : 'resolved'}">${c.status === 'resolved' ? '未対応に戻す' : '対応済みにする'}</button>
                ${mine ? `<button class="sfm-act danger" data-del="${c.id}">削除</button>` : ''}
            </div>
            <div class="sfm-reply sfm-hidden" data-replybox="${c.id}">
                <textarea rows="2" placeholder="返信"></textarea>
                <div class="act"><button class="sfm-btn2 primary" data-replysend="${c.id}">返信する</button></div>
            </div>
        </div>`;
    }

    function bindThreadEvents() {
        const list = $('sfm-clist');
        list.querySelectorAll('[data-root]').forEach((el) => el.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('textarea')) return;
            S.activeRoot = Number(el.dataset.root);
            placePins();
            renderComments();
        }));
        list.querySelectorAll('[data-jump]').forEach((el) => el.addEventListener('click', (e) => {
            e.stopPropagation();
            const parts = String(el.dataset.jump).split('|');
            if (parts[0] !== S.projKey) mountProject(parts[0]);
            const p = PAGES.find((x) => x.key === parts[1]);
            if (p && S.comp) {
                try { S.comp.proxy[p.go](); window.SfMockLwc.markDirty(S.comp); } catch (x) { /* ゲートで止まることもある */ }
            }
        }));
        list.querySelectorAll('[data-status]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); setStatus(Number(el.dataset.status), el.dataset.to); }));
        list.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); removeComment(Number(el.dataset.del)); }));
        list.querySelectorAll('[data-reply]').forEach((el) => el.addEventListener('click', (e) => {
            e.stopPropagation();
            const box = list.querySelector(`[data-replybox="${el.dataset.reply}"]`);
            box.classList.toggle('sfm-hidden');
            if (!box.classList.contains('sfm-hidden')) box.querySelector('textarea').focus();
        }));
        list.querySelectorAll('[data-replysend]').forEach((el) => el.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(el.dataset.replysend);
            const ta = list.querySelector(`[data-replybox="${id}"] textarea`);
            const body = ta.value.trim();
            if (!body) return;
            ta.value = '';
            await addComment(body, null, null, id, null);
        }));
    }

    function syncTabs() {
        $('sfm-tab-this').className = 'sfm-btn2 small ' + (S.scope === 'this' ? 'primary' : 'ghost');
        $('sfm-tab-all').className = 'sfm-btn2 small ' + (S.scope === 'all' ? 'primary' : 'ghost');
    }

    // ===================== Realtime =====================
    function subscribe() {
        S.sb.channel('sfmock-comments')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sf_mock_comments' }, (p) => {
                if (p.eventType === 'DELETE') {
                    const id = p.old && p.old.id;
                    S.comments = S.comments.filter((c) => c.id !== id && c.parent_id !== id);
                } else {
                    upsertLocal(p.new);
                    if (p.eventType === 'INSERT' && S.user && p.new.user_id !== S.user.id) {
                        toast((p.new.user_name || '誰か') + ' さんがコメントしました');
                    }
                }
                renderChrome();
                placePins();
                renderComments();
            })
            .subscribe();
    }

    // ===================== 管理者：dev6 の採取を取り込む =====================
    function setupUploader() {
        if (!S.user || S.user.role !== 'admin') return;
        $('sfm-admin').classList.remove('sfm-hidden');
        $('sfm-import-btn').addEventListener('click', () => $('sfm-import').click());
        $('sfm-import').addEventListener('change', async (e) => {
            const files = [...e.target.files];
            const want = ['manifest.json', 'apex.json', 'records.json', 'picklists.json', 'names.json', 'formulas.json'];
            const top = want.map((n) => files.find((f) => f.name === n && !/src[\\/]/.test(f.webkitRelativePath || ''))).filter(Boolean);
            const extra = files.filter((f) => f.name === 'listview.json' && !/src[\\/]/.test(f.webkitRelativePath || '')); // 任意（入口の一覧）
            const src = files.filter((f) => /src[\\/]/.test(f.webkitRelativePath || ''));
            if (top.length !== want.length || !src.length) {
                toast('採取フォルダ（' + want.join(' / ') + ' と src/ が入っているもの）を選んでください', 'err', 7000);
                return;
            }
            const bar = $('sfm-import-stat');
            bar.classList.remove('sfm-hidden');
            let done = 0;
            const total = top.length + src.length;
            const up = async (path, file, type) => {
                const { error } = await S.sb.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: type });
                if (error) throw new Error(path + ': ' + error.message);
                bar.textContent = `取り込み中… ${++done}/${total}　${path}`;
            };
            try {
                for (const f of top.concat(extra)) await up(f.name, f, 'application/json');
                for (const f of src) {
                    const type = /\.css$/.test(f.name) ? 'text/css' : /\.html$/.test(f.name) ? 'text/html' : 'text/javascript';
                    await up('src/' + f.name, f, type);
                }
                // 画像方式の名残（screens/）が残っていたら片付ける
                const { data: old } = await S.sb.storage.from(BUCKET).list('screens', { limit: 500 });
                if (old && old.length) await S.sb.storage.from(BUCKET).remove(old.map((o) => 'screens/' + o.name));
                bar.textContent = `取り込みました（${total} ファイル）`;
                setTimeout(() => location.reload(), 1200);
            } catch (x) {
                bar.textContent = '取り込みに失敗しました: ' + x.message;
            }
        });
    }

    // ===================== 起動 =====================
    function showNote(html) {
        $('sfm-mount').innerHTML = `<div class="sfm-note"><div class="ttl">画面がまだ入っていません</div>${html}</div>`;
    }

    async function start() {
        $('sfm-user').textContent = S.user.name + (S.user.role ? '（' + S.user.role + '）' : '');
        setupUploader();
        S.bundle = await loadBundle();
        await loadComments();
        if (!S.bundle) {
            $('sfm-sub').textContent = '素材が未取り込み';
            showNote(S.user.role === 'admin'
                ? 'SF リポジトリで <code>node scripts/mockup/run_record.js</code> を流すと <code>scripts/mockup/out</code> ができます。<br>上の「dev6 の採取を取り込む」でそのフォルダを選んでください。<br><br>先に <code>supabase/add_sf_mock_comments.sql</code> を Supabase の SQL Editor で流しておいてください（置き場所とコメントの器を作ります）。'
                : '管理者が dev6 の素材を取り込むと、ここで見られるようになります。');
            renderComments();
            return;
        }
        if (S.bundle.missing.length) {
            showErr('素材が足りません: ' + S.bundle.missing.join(' / ') + '（管理者が採り直して取り込むと直ります）');
        }
        injectCss();
        buildParts();
        $('sfm-sub').textContent = 'dev6 の部品と応答を ' + when(S.bundle.manifest.capturedAt) + ' に採取／工事 ' +
            S.bundle.manifest.projects.length + ' 件';
        syncTabs();
        mountList(); // 入口は dev6 と同じ案件の一覧
        subscribe();
        if (!S.tableReady) toast('コメントの保存先がまだ作られていません（管理者が SQL を流すと書けます）', 'err', 7000);
        toast('dev6 と同じ画面です。入力も試せますが、保存はされません（開き直すと戻ります）。', '', 6500);
    }

    window.addEventListener('DOMContentLoaded', async () => {
        await initSupabase();
        $('sfm-login-form').addEventListener('submit', handleLogin);
        $('sfm-logout').addEventListener('click', async () => { await S.sb.auth.signOut(); location.reload(); });
        $('sfm-errbar-close').addEventListener('click', () => $('sfm-errbar').classList.add('sfm-hidden'));
        $('sfm-btn-comment').addEventListener('click', () => {
            if (S.projKey === LIST_KEY) { toast('案件一覧にはコメントを置けません。案件を開いてから置いてください。'); return; }
            setCommenting(!S.commenting);
            if (S.commenting) toast('画面の気になるところをクリックしてください（1 か所置くと操作に戻ります）');
        });
        $('sfm-catch').addEventListener('click', (e) => {
            if (!S.commenting) return;
            const r = $('sfm-mount').getBoundingClientRect();
            const sz = wrapSize();
            const x = (e.clientX - r.left) / sz.w * 100;
            const y = (e.clientY - r.top) / sz.h * 100;
            openPopover(x, y, anchorAt(e.clientX, e.clientY), e.clientX, e.clientY);
        });
        $('sfm-tab-this').addEventListener('click', () => { S.scope = 'this'; syncTabs(); renderComments(); });
        $('sfm-tab-all').addEventListener('click', () => { S.scope = 'all'; syncTabs(); renderComments(); });
        $('sfm-openonly').addEventListener('change', (e) => { S.openOnly = e.target.checked; renderComments(); });
        $('sfm-csend').addEventListener('click', async () => {
            const ta = $('sfm-cnew');
            const body = ta.value.trim();
            if (!body || !S.screenId) return;
            ta.value = '';
            await addComment(body, null, null, null, null);
        });
        // コメント欄をたたむと画面が広くなる（dev6 の横幅に近づく）＝好みを覚えておく
        const setPanel = (folded) => {
            $('sfm-panel').classList.toggle('folded', folded);
            $('sfm-btn-panel').textContent = folded ? 'コメント欄を出す' : 'コメント欄をたたむ';
            try { localStorage.setItem('sfmock.panel', folded ? 'folded' : 'open'); } catch (e) { /* 使えなくても動く */ }
            if (S.comp) setTimeout(placePins, 60);
        };
        let foldedInit = false;
        try { foldedInit = localStorage.getItem('sfmock.panel') === 'folded'; } catch (e) { /* 使えなくても動く */ }
        setPanel(foldedInit);
        $('sfm-btn-panel').addEventListener('click', () => setPanel(!$('sfm-panel').classList.contains('folded')));

        const setGuide = (folded) => {
            $('sfm-guide').classList.toggle('folded', folded);
            try { localStorage.setItem('sfmock.guide', folded ? 'folded' : 'open'); } catch (e) { /* 使えなくても動く */ }
        };
        let guideInit = false;
        try { guideInit = localStorage.getItem('sfmock.guide') === 'folded'; } catch (e) { /* 使えなくても動く */ }
        setGuide(guideInit);
        $('sfm-guide-close').addEventListener('click', () => setGuide(true));

        window.addEventListener('resize', () => { if (S.comp) placePins(); });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            closePopover();
            if (S.commenting) setCommenting(false);
        });

        S.user = await currentUser();
        if (!S.user) { showLogin(true); return; }
        showLogin(false);
        await start();
    });
})();
