/**
 * torihikisaki_bank.js - 取引先マスタ：銀行マスタ（銀行・店）の画面と、口座の入力・表示・CSV 取込の点検
 *   見本＝画面の見本_銀行マスタと口座の入力_今と案_2026-11-26。DB＝supabase/bank_master.sql。
 *   ・銀行マスタの表が無い／空のあいだは、口座の入力・表示・CSV 取込は今までどおりに動く（bmReady() が false）。
 *     学習用DB につないでいるあいだも同じ（bmCanUse() が false＝銀行マスタは見に行かない）。
 *   ・銀行マスタの表は直接は触らない。DB の関数（rpc）だけを呼ぶ。
 *   ・tera の取込ファイルの読み書きと、探す言葉の整えは torihikisaki_bank_csv.js（TorihikisakiBankCsv）。
 *   torihikisaki.js のあとに読む（Object.assign で TorihikisakiView に足す）。実データなし。
 */
Object.assign(TorihikisakiView, {
  bm: { exists: false, ready: false, state: null, names: {} },   // exists＝DB に銀行マスタがある／ready＝店が 1 つ以上入っている／names＝コードから引いた名前の控え
  _bmLoading: null,
  bmImp: null,              // 取込の途中 { run, name }
  bmChkSuspended: false,    // 口座の点検で、停止した会社も出すか
  BM_REASONS: ['銀行コード・支店コードが空', 'コードの形が違う', '銀行マスタに無い店', '廃止の店'],
  BM_KIND_CLS: { '新設': 'b-green', '復活': 'b-green', '改称': 'b-amber', '変更': 'b-slate', '廃止': 'b-red', '取込': 'b-slate' },
  BM_FIELD: { name: '名前', kana: 'カナ', postal_code: '郵便番号', address: '所在地', phone: '電話番号', clearing_no: '手形交換所番号' },

  async bmRpc(name, args) {
    const res = await this.getClient().rpc(name, args || {});
    if (res.error) throw new Error(res.error.message || String(res.error));
    return res.data;
  },

  // 学習用DB（config.local.js の Sync.TORIHIKISAKI_DB＝匿名の接続）につないでいるか。見分け方は getClient() と同じ
  bmOnLearningDb() { const c = Sync.TORIHIKISAKI_DB; return !!(c && c.url && c.anonKey); },
  // 銀行マスタの SQL は管理者・経理の役割が前提（匿名の接続には何も開けていない）＝学習用DB では使えない。あるかどうかの問い合わせもしない
  bmCanUse() { return !this.bmOnLearningDb(); },

  // 銀行マスタが使えるかを確かめる（1 回読んだら覚えておく。force＝取り込んだあとの読み直し）
  bmLoad(force) {
    if (!this.bmCanUse()) { this.bmNavShow(); return Promise.resolve(this.bm); }
    if (this._bmLoading && !force) return this._bmLoading;
    const names = force ? {} : this.bm.names;
    const p = (async () => {
      try {
        const st = await this.bmRpc('bank_master_state', {});
        this.bm = { exists: true, ready: Number(st.branches) > 0, state: st, names };
      } catch (e) {
        this.bm = { exists: false, ready: false, state: null, names: {} };
        if (this._bmLoading === p) this._bmLoading = null;   // 読めなかったときは覚えない（次に開いたときにもう一度見る）
      }
      this.bmNavShow();
      return this.bm;
    })();
    this._bmLoading = p;
    return p;
  },
  bmReady() { return !!(this.bm && this.bm.ready); },
  bmNavShow() {
    const nav = this.el('tmk-snav');
    const a = nav && nav.querySelector('a[data-v="bank"]');
    if (a) a.style.display = this.bm.exists ? '' : 'none';
  },

  // ===== コードから名前を引く =====
  bmKeyOf(acc) {
    const b = String(acc && acc.bank_code != null ? acc.bank_code : '').trim();
    const s = String(acc && acc.branch_code != null ? acc.branch_code : '').trim();
    return /^\d{4}$/.test(b) && /^\d{3}$/.test(s) ? b + '-' + s : '';
  },
  // keys＝「銀行コード-支店コード」（「銀行コード-」なら銀行だけ）。引いた名前は覚えておく
  async bmLookup(keys) {
    const names = this.bm.names;
    const need = Array.from(new Set((keys || []).filter(k => k && !(k in names))));
    for (let i = 0; i < need.length; i += 500) {   // 1 回に 500 件まで（API は 1 回の返事を 1,000 行で切る。多い分は分けて引く）
      const part = need.slice(i, i + 500);
      const rows = await this.bmRpc('bank_branch_lookup', { p_keys: part });
      (rows || []).forEach(r => { names[r.k] = r; });
      part.forEach(k => { if (!(k in names)) names[k] = { k, bank_name: null, branch_name: null }; });
    }
    return names;
  },
  // 会社の詳細を開くときに、口座のコードの名前を先に引いておく（引けなくても詳細は開く）
  async bmWarm(accs) {
    try {
      await this.bmLoad();
      if (this.bmReady()) await this.bmLookup((accs || []).map(a => this.bmKeyOf(a)));
    } catch (e) { /* 引けなければ、口座は入っている銀行名で出す */ }
  },
  // 口座のコードに当たる銀行マスタの名前（銀行も店もあるときだけ）
  bmNameOf(acc) {
    if (!this.bmReady()) return null;
    const m = this.bm.names[this.bmKeyOf(acc)];
    return m && m.bank_name && m.branch_name ? m : null;
  },
  // 口座カードの 1 行（銀行マスタの名前があれば「銀行名　支店名（支店コード）」、無ければ今までどおり）
  bankLineParts(acc) {
    const m = this.bmNameOf(acc);
    return (m
      ? [m.bank_name, `${m.branch_name}（${String(acc.branch_code).trim()}）`, acc.account_type, acc.account_number]
      : [acc.bank_name, acc.branch_code ? `支店${acc.branch_code}` : '', acc.account_type, acc.account_number]).filter(Boolean);
  },
  bmJudge(b, s, m) {
    if (!m || !m.bank_name) return { error: `銀行コード ${b} は銀行マスタにありません` };
    if (!m.branch_name) return { error: `${m.bank_name}に支店コード ${s} はありません` };
    if (m.abolished) return { error: `${m.bank_name} ${m.branch_name}（${b}-${s}）は廃止の印が付いています。今の支店コードを確かめてください` };
    return m;
  },
  // 口座に入れてよいコードか。だめなら { error }、よければ銀行マスタの行（bank_name・branch_name ほか）
  async bmCheckCodes(bank, branch) {
    const b = String(bank || '').trim(), s = String(branch || '').trim();
    if (!b || !s) return { error: '銀行コードと支店コードは必須です' };
    if (!/^\d{4}$/.test(b)) return { error: '銀行コードは4桁の数字です' };
    if (!/^\d{3}$/.test(s)) return { error: '支店コードは3桁の数字です' };
    let names;
    try { names = await this.bmLookup([b + '-' + s]); }
    catch (e) { return { error: `銀行マスタを読めませんでした（${String(e.message || e).slice(0, 60)}）` }; }
    return this.bmJudge(b, s, names[b + '-' + s]);
  },

  // ===== 口座の入力（銀行マスタが使えるとき）=====
  bankCodeFieldsHtml(acc) {
    const v = c => (acc && acc[c] !== null && acc[c] !== undefined ? String(acc[c]).trim() : '');
    const inp = (c, ph, len) => `<input class="inp" data-bank="${c}" value="${this.esc(v(c))}" placeholder="${ph}" maxlength="${len}" inputmode="numeric" autocomplete="off" style="width:100%;min-width:0">`;
    const must = '<span style="color:var(--primary)">*</span>';
    return `<div style="font-size:11px;font-weight:700;margin-bottom:3px">銀行コード${must}・支店コード${must}</div>
      <div style="display:flex;gap:6px;align-items:center">${inp('bank_code', '銀行コード(4桁)', 4)}${inp('branch_code', '支店コード(3桁)', 3)}<button type="button" class="btn btn-sm" data-bfind style="white-space:nowrap;flex:none">名前から探す</button></div>
      <div id="tmk-bname" style="min-height:17px;margin:4px 0 8px;font-size:12px"></div>`;
  },
  // コードを打つたびに、銀行マスタの名前（か、保存できない理由）をコードの下に出す
  bankFormWire(box) {
    const bc = box.querySelector('[data-bank="bank_code"]'), sc = box.querySelector('[data-bank="branch_code"]'), out = box.querySelector('#tmk-bname');
    if (!bc || !sc || !out) return;
    const acc = this.bankEdit === 'new' ? null
      : ((this.detail && this.detail.bank_account) || []).find(a => String(a.account_id) === String(this.bankEdit));
    const half = el => TorihikisakiBankCsv.halfAlnum(el.value).trim();
    const stop = msg => `<span data-bstop style="color:var(--primary);font-weight:700">${this.esc(msg)}</span>`;
    let seq = 0;
    const show = async () => {
      const my = ++seq;
      const b = half(bc), s = half(sc);
      let html = '';
      if (/^\d{4}$/.test(b) && /^\d{3}$/.test(s)) {
        const r = await this.bmCheckCodes(b, s);
        html = r.error ? stop(r.error)
          : `<b>${this.esc(r.bank_name)}　${this.esc(r.branch_name)}</b>　<span class="mf">${this.esc(r.bank_kana || '')}　${this.esc(r.branch_kana || '')}</span>`;
      } else if (/^\d{4}$/.test(b)) {
        let m = null, failed = false;
        try { m = (await this.bmLookup([b + '-']))[b + '-']; } catch (e) { failed = true; }
        if (!failed) html = m && m.bank_name ? `<b>${this.esc(m.bank_name)}</b>　<span class="mf">${this.esc(m.bank_kana || '')}</span>` : stop(`銀行コード ${b} は銀行マスタにありません`);
      } else if (!b && !s && acc && acc.bank_name) {
        html = `<span class="mf">入っている銀行名: ${this.esc(acc.bank_name)}</span>`;
      }
      if (my === seq) out.innerHTML = html;
    };
    bc.addEventListener('input', show);
    sc.addEventListener('input', show);
    const find = box.querySelector('[data-bfind]');
    if (find) find.onclick = () => this.openBankPicker((b, s) => { bc.value = b; sc.value = s; show(); });
    show();
  },

  // ===== 銀行・支店を探す窓 =====
  openBankPicker(onPick) {
    const ov = this.el('tmk-ov-bank'), body = this.el('tmk-bank-body');
    if (!ov || !body) return;
    body.innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input class="inp" id="tmk-bank-q" placeholder="例: みずほ まるのうち" autocomplete="off" style="flex:1;min-width:0"><span class="mf" id="tmk-bank-n" style="font-size:11.5px;white-space:nowrap"></span></div><div id="tmk-bank-list"></div>`;
    ov.classList.add('on');
    const q = this.el('tmk-bank-q');
    let timer = null;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.bmSearchInto(q.value, false, this.el('tmk-bank-list'), this.el('tmk-bank-n'), r => {
        ov.classList.remove('on');
        onPick(r.bank_code, r.branch_code);
      }), 250);
    });
    q.focus();
  },
  // 探した結果を listEl に出す。onPick があれば行を選べる。withAbolished＝廃止の店も出す（印を付ける）
  async bmSearchInto(text, withAbolished, listEl, countEl, onPick) {
    if (!listEl || !countEl) return;
    const my = listEl._seq = (listEl._seq || 0) + 1;
    const terms = TorihikisakiBankCsv.searchTerms(text);
    if (!terms.length) { listEl.innerHTML = ''; countEl.textContent = ''; return; }
    let res;
    try { res = await this.bmRpc('bank_branch_search', { p_terms: terms, p_with_abolished: !!withAbolished, p_limit: 30 }); }
    catch (e) {
      if (my === listEl._seq) { listEl.innerHTML = `<div class="alert warn">探せませんでした: ${this.esc(String(e.message || e).slice(0, 80))}</div>`; countEl.textContent = ''; }
      return;
    }
    if (my !== listEl._seq) return;
    const rows = (res && res.rows) || [], total = Number((res && res.total) || 0);
    countEl.textContent = `${total.toLocaleString()} 店` + (total > rows.length ? `（先頭の ${rows.length} 店）` : '');
    listEl.innerHTML = !rows.length ? '' :
      `<div class="tblwrap"><table class="tbl${onPick ? '' : ' ro'}"><thead><tr><th>コード</th><th>銀行</th><th>支店</th><th>カナ</th>${withAbolished ? '<th></th>' : ''}</tr></thead><tbody>` +
      rows.map((r, i) => `<tr data-i="${i}"><td class="tnum">${this.esc(r.bank_code)}-${this.esc(r.branch_code)}</td><td>${this.esc(r.bank_name)}</td><td>${this.esc(r.branch_name)}</td><td class="mf">${this.esc(r.branch_kana)}</td>` +
        (withAbolished ? `<td>${r.abolished ? '<span class="badge b-red">廃止</span>' : ''}</td>` : '') + '</tr>').join('') + '</tbody></table></div>';
    if (onPick) listEl.querySelectorAll('tr[data-i]').forEach(tr => { tr.onclick = () => onPick(rows[+tr.dataset.i]); });
  },

  // ===== 銀行マスタの画面（左の並び）=====
  async renderBankGlobal() {
    const wrap = this.el('tmk-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<p class="mf" style="padding:20px">読み込み中…</p>';
    const n = v => Number(v || 0).toLocaleString();
    const my = this._bmRenderSeq = (this._bmRenderSeq || 0) + 1;
    const stale = () => this.view !== 'bank' || my !== this._bmRenderSeq;   // 読んでいるあいだに別のページへ移った・描き直しが重なった
    let st, last;
    try {
      last = await this.bmLastExport();
      st = await this.bmRpc('bank_master_state', last ? { p_since: last.at } : {});
    } catch (e) {
      if (!stale()) wrap.innerHTML = `<div class="alert warn">銀行マスタを読めませんでした: ${this.esc(String(e.message || e))}</div>`;
      return;
    }
    if (stale()) return;
    this.bm = { exists: true, ready: Number(st.branches) > 0, state: st, names: this.bm.names };
    this.bmNavShow();
    const empty = !this.bm.ready;
    const since = empty ? '' : !last ? 'まだ書き出していません'
      : Number(st.changes_since) > 0 ? `前に書き出してから ${n(st.changes_since)} 件変わっています` : '前に書き出してから変わっていません';
    const h = t => `<div style="font-weight:800;font-size:13px;margin:16px 0 6px">${t}</div>`;
    wrap.innerHTML =
      `<div class="fcard">` +
        `<div id="tmk-bm-stat" style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px"><span><b class="tnum">${n(st.banks)}</b> 銀行</span><span><b class="tnum">${n(st.branches)}</b> 店</span>` +
        `<span>うち廃止 <b class="tnum">${n(st.abolished_branches)}</b> 店</span><span>基準日 <b class="tnum">${this.esc(st.as_of || '—')}</b></span></div>` +
        `<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn" id="tmk-bm-exp"${empty ? ' disabled' : ''}>tera の形式で書き出す</button>` +
        `<button class="btn" id="tmk-bm-imp">CSV で取り込む</button><input type="file" id="tmk-bm-impf" accept=".csv" style="display:none">` +
        `<span class="mf" id="tmk-bm-since" style="font-size:11.5px">${this.esc(since)}</span></div>` +
      `</div>` +
      (empty ? '' :
        `<div style="display:flex;gap:8px;align-items:center;margin:14px 0 8px"><input class="inp" id="tmk-bm-q" placeholder="銀行名 支店名で探す" autocomplete="off" style="width:260px"><span class="mf" id="tmk-bm-n" style="font-size:11.5px"></span></div>` +
        `<div id="tmk-bm-list"></div>` +
        h('変更の記録') + '<div id="tmk-bm-log"><p class="mf">読み込み中…</p></div>' +
        h('口座の点検 <span class="mf" id="tmk-bm-chk-n" style="font-weight:400;font-size:11.5px"></span>') + '<div id="tmk-bm-chk"><p class="mf">読み込み中…</p></div>');
    this.el('tmk-bm-exp').onclick = () => this.bmExport();
    const impf = this.el('tmk-bm-impf');
    this.el('tmk-bm-imp').onclick = () => impf.click();
    impf.onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) this.bmImportFile(f); };
    if (empty) return;
    const q = this.el('tmk-bm-q');
    let timer = null;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.bmSearchInto(q.value, true, this.el('tmk-bm-list'), this.el('tmk-bm-n'), null), 250);
    });
    const [lv, ck] = await Promise.all([
      this.bmRpc('bank_master_log_view', { p_limit: 100 }).catch(e => ({ failed: String(e.message || e) })),
      this.bmRpc('bank_account_check', {}).catch(e => ({ failed: String(e.message || e) })),
    ]);
    if (stale()) return;
    const logEl = this.el('tmk-bm-log');
    if (logEl) {
      logEl.innerHTML = lv.failed ? `<div class="alert warn">変更の記録を読めませんでした: ${this.esc(lv.failed)}</div>`
        : !lv.length ? '<div class="fcard mf">まだ記録はありません。</div>'
        : '<div class="tblwrap"><table class="tbl ro"><thead><tr><th>日時</th><th>種類</th><th>銀行・店</th><th>中身</th></tr></thead><tbody>' +
          lv.map(r => this.bmLogRowHtml(r)).join('') + '</tbody></table></div>';
    }
    this.bmChkRows = ck.failed ? null : ck;
    this.bmChkFailed = ck.failed || '';
    this.bmRenderCheck();
  },
  // 前と後で違う項目（名前は「前 → 後」、ほかは「項目: 前 → 後」）
  bmDiffText(before, after) {
    const b = before || {}, a = after || {}, show = v => (v === null || v === undefined || v === '' ? '（空）' : String(v));
    return Object.keys(this.BM_FIELD).filter(k => (k in a) && show(b[k]) !== show(a[k]))
      .map(k => (k === 'name' ? '' : this.BM_FIELD[k] + ': ') + show(b[k]) + ' → ' + show(a[k])).join('／');
  },
  bmLogRowHtml(r) {
    const n = v => Number(v || 0).toLocaleString();
    let who, what;
    if (r.target === '一覧') {
      const c = r.counts || {};
      who = r.bank_name || '';
      what = c['店:新設'] ? `${n(c['銀行:新設'])} 銀行・${n(c['店:新設'])} 店を入れた` : `変わった所なし（${n(c['置いた行'])} 行）`;
    } else if (r.target === '銀行') {
      who = `${r.bank_code} ${r.bank_name || ''}`;
      what = r.kind === '改称' ? this.bmDiffText(r.before, r.after) : `${n(r.stores)} 店`;
    } else {
      who = `${r.bank_code}-${r.branch_code} ${r.bank_name || ''}`;
      what = r.kind === '改称' || r.kind === '変更' ? this.bmDiffText(r.before, r.after) : ((r.after || r.before || {}).name || '');
    }
    return `<tr><td class="tnum">${this.esc(this.jstStamp(r.at))}</td><td><span class="badge ${this.BM_KIND_CLS[r.kind] || 'b-slate'}">${this.esc(r.kind)}</span></td>` +
      `<td>${this.esc(who)}</td><td style="white-space:normal;word-break:break-word">${this.esc(what)}</td></tr>`;
  },
  // 口座の点検（銀行マスタと合わない口座）。既定は有効な会社だけ
  bmRenderCheck() {
    const el = this.el('tmk-bm-chk'), head = this.el('tmk-bm-chk-n');
    if (!el) return;
    if (!this.bmChkRows) { el.innerHTML = `<div class="alert warn">口座の点検を読めませんでした: ${this.esc(this.bmChkFailed)}</div>`; return; }
    const n = v => Number(v || 0).toLocaleString();
    const rows = this.bmChkRows, act = rows.filter(r => !r.is_suspended), sus = rows.filter(r => r.is_suspended);
    if (head) head.textContent = `有効な会社 ${n(act.length)} 件・停止した会社 ${n(sus.length)} 件`;
    const cnt = (list, reason) => list.filter(r => r.reason === reason).length;
    const list = this.bmChkSuspended ? rows : act;
    el.innerHTML =
      '<div class="tblwrap" style="max-width:520px"><table class="tbl ro"><thead><tr><th>理由</th><th>有効な会社</th><th>停止した会社</th></tr></thead><tbody>' +
      this.BM_REASONS.map(x => `<tr><td>${this.esc(x)}</td><td class="num">${n(cnt(act, x))}</td><td class="num">${n(cnt(sus, x))}</td></tr>`).join('') + '</tbody></table></div>' +
      `<label style="display:flex;align-items:center;gap:5px;font-size:11.5px;margin:10px 0 6px"><input type="checkbox" id="tmk-bm-chk-sus"${this.bmChkSuspended ? ' checked' : ''}>停止した会社も出す</label>` +
      (!list.length ? '<div class="fcard mf">並ぶ口座はありません。</div>'
        : '<div class="tblwrap"><table class="tbl" id="tmk-bm-chk-list"><thead><tr><th>取引先</th><th>口座</th><th>入っている銀行名</th><th>コード</th><th>理由</th></tr></thead><tbody>' +
          list.slice(0, 300).map(r => `<tr data-cid="${this.esc(r.company_id)}"><td><span class="tnum mf">${this.esc(r.company_id)}</span> <span class="nm">${this.esc(r.official_name || '')}</span>${r.is_suspended ? ' <span class="badge b-slate">停止</span>' : ''}</td>` +
            `<td>第${this.esc(String(r.priority || 1))}口座</td><td>${this.esc(r.bank_name || '')}</td><td class="tnum">${this.esc([r.bank_code, r.branch_code].filter(Boolean).join('-'))}</td><td>${this.esc(r.reason)}</td></tr>`).join('') +
          '</tbody></table></div>' + (list.length > 300 ? `<div class="mf" style="font-size:11px;margin-top:4px">…ほか ${n(list.length - 300)} 件</div>` : ''));
    const cb = this.el('tmk-bm-chk-sus');
    if (cb) cb.onchange = () => { this.bmChkSuspended = cb.checked; this.bmRenderCheck(); };
    el.querySelectorAll('tr[data-cid]').forEach(tr => { tr.onclick = () => this.openDetail(tr.dataset.cid); });
  },

  // ===== tera の形式で書き出す =====
  // 連携ログの置き場（本体のログイン済みの接続）。学習用DB につないでいるあいだは使わない（手元の試しを本番の連携ログに残さない）
  bmLogClient() { return this.bmOnLearningDb() ? null : Sync.getSupabase(); },
  async bmLastExport() {
    const sb = this.bmLogClient();
    if (!sb) return null;
    try {
      const res = await sb.from('integration_log').select('at,actor,message').eq('system', 'tera').eq('action', 'bank_master_export').order('at', { ascending: false }).limit(1);
      return res.error ? null : ((res.data || [])[0] || null);
    } catch (e) { return null; }
  },
  // 書き出した記録を連携ログに残す（日時と記録者は DB が付ける）。残せなかったら理由を返す
  async bmLogExport(rows, bytes) {
    const sb = this.bmLogClient();
    if (!sb) return '';
    try {
      const res = await sb.from('integration_log').insert({
        system: 'tera', kind: 'note', action: 'bank_master_export',
        message: `銀行マスタを tera の形式で書き出した（${rows.toLocaleString()} 行）`, counts: { rows, bytes },
      });
      return res.error ? String(res.error.message || res.error).slice(0, 80) : '';
    } catch (e) { return String(e.message || e).slice(0, 80); }
  },
  async bmExport() {
    if (this.busy) return;
    const btn = this.el('tmk-bm-exp');
    this.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = '書き出し中…'; }
    try {
      const data = await this.bmRpc('bank_master_export', {});
      if (!data || !data.length) throw new Error('銀行マスタが空です');
      const out = TorihikisakiBankCsv.build(data.map(a => TorihikisakiBankCsv.fromArray(a)));
      if (out.bad.length) throw new Error(`Shift_JIS に無い字があります（${out.bad.slice(0, 10).join(' ')}）`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([out.bytes], { type: 'text/csv' }));
      a.download = `tera取込用_金融機関店舗マスタ_${this.jstToday().replace(/-/g, '')}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      const logErr = await this.bmLogExport(data.length, out.bytes.length);
      this.toast(logErr ? `書き出しました（連携ログには残せませんでした: ${logErr}）` : `書き出しました（${data.length.toLocaleString()} 行）`);
    } catch (e) {
      alert('書き出せませんでした: ' + (e.message || e));
    }
    this.busy = false;
    if (this.view === 'bank') this.renderBankGlobal();
  },

  // ===== CSV で取り込む（tera の形式の 12 列）=====
  async bmImportCancel() {
    const imp = this.bmImp;
    this.bmImp = null;
    if (imp) { try { await this.bmRpc('bank_master_cancel', { p_run: imp.run }); } catch (e) { /* 置き場は、次の反映のときに DB が片付ける */ } }
  },
  async bmImportFile(file) {
    const ov = this.el('tmk-ov-bankimp'), body = this.el('tmk-bankimp-body');
    if (!ov || !body || this.busy) return;
    if (!ov._bmWired) {   // 窓が閉じたら（✕・背景・やめる・Esc のどれでも）、置いた行を片付ける
      ov._bmWired = true;
      new MutationObserver(() => { if (!ov.classList.contains('on')) this.bmImportCancel(); }).observe(ov, { attributes: true, attributeFilter: ['class'] });
    }
    await this.bmImportCancel();
    const n = v => Number(v || 0).toLocaleString();
    const closeBtn = '<div style="margin-top:12px"><button class="btn" data-tmk-ovclose>閉じる</button></div>';
    body.innerHTML = '<p class="mf" id="tmk-bankimp-msg">読み込んでいます…</p>';
    ov.classList.add('on');
    let parsed;
    try { parsed = TorihikisakiBankCsv.parse(await file.arrayBuffer()); }
    catch (e) { body.innerHTML = `<div class="alert warn">ファイルを読めませんでした: ${this.esc(String(e.message || e))}</div>` + closeBtn; return; }
    if (parsed.errorCount) {
      body.innerHTML = `<div style="font-size:12.5px;margin-bottom:8px"><b>${this.esc(file.name)}</b> は取り込めません。直す所が <b id="tmk-bankimp-errn">${n(parsed.errorCount)}</b> 件あります。</div>` +
        '<div id="tmk-bankimp-errs" style="max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:8px;font-size:11.5px">' +
        parsed.errors.map(e => `<div style="padding:5px 10px;border-bottom:1px solid var(--muted)">${e.line ? n(e.line) + ' 行目: ' : ''}${this.esc(e.message)}</div>`).join('') +
        (parsed.errorCount > parsed.errors.length ? `<div class="mf" style="padding:5px 10px">…ほか ${n(parsed.errorCount - parsed.errors.length)} 件</div>` : '') + '</div>' + closeBtn;
      return;
    }
    const rows = parsed.rows, total = rows.length;
    const msg = t => { const m = this.el('tmk-bankimp-msg'); if (m) m.textContent = t; };
    this.busy = true;
    let run = null;
    try {
      const guess = TorihikisakiBankCsv.dateFromName(file.name);
      const asOf = guess && guess <= this.jstToday() ? guess : null;
      run = await this.bmRpc('bank_master_begin', { p_file_name: file.name, p_as_of: asOf, p_actor: this.whoAmI() });
      this.bmImp = { run, name: file.name };
      for (let i = 0; i < total; i += 2000) {
        if (!ov.classList.contains('on') || !this.bmImp || this.bmImp.run !== run) throw new Error('closed');
        msg(`${n(i)} / ${n(total)} 行を置いています…`);
        const part = rows.slice(i, i + 2000);
        const placed = await this.bmRpc('bank_master_stage_rows', { p_run: run, p_rows: part.map(r => TorihikisakiBankCsv.toArray(r)) });
        if (Number(placed) !== part.length) throw new Error('行を置けませんでした（途中で止まりました）');
      }
      msg('今の銀行マスタとの違いを調べています…');
      const pv = await this.bmRpc('bank_master_preview', { p_run: run });
      if (!ov.classList.contains('on') || !this.bmImp || this.bmImp.run !== run) throw new Error('closed');
      this.bmImportPreview(file.name, total, asOf || this.jstToday(), pv);
    } catch (e) {
      const closed = String(e && e.message) === 'closed';
      this.bmImp = null;
      // 途中でやめた・止まったときは、置いた行を片付ける（片付けられなくても、次の反映のときに DB が片付ける）
      if (run !== null) { try { await this.bmRpc('bank_master_cancel', { p_run: run }); } catch (e2) { /* 上のとおり */ } }
      if (!closed) body.innerHTML = `<div class="alert warn">取り込めませんでした: ${this.esc(String(e.message || e))}</div>` + closeBtn;
    }
    this.busy = false;
  },
  // 下見の窓: 何がいくつ変わるかを見せてから、［取り込む］で 1 回でまとめて反映する
  bmImportPreview(name, total, asOf, pv) {
    const body = this.el('tmk-bankimp-body');
    const n = v => Number(v || 0).toLocaleString();
    const c = pv.counts || {};
    const KINDS = [['銀行:新設', '銀行の新設'], ['銀行:改称', '銀行の改称'], ['店:新設', '店の新設'], ['店:改称', '店の改称'], ['店:変更', '店の変更（所在地・電話など）']];
    const lines = KINDS.filter(([k]) => Number(c[k]) > 0).map(([k, t]) => `<tr><td>${t}</td><td class="num" data-k="${k}">${n(c[k])}</td></tr>`).join('') +
      `<tr><td>変更なし</td><td class="num" data-k="same">${n(pv.same)}</td></tr>`;
    const samples = Number(pv.master_branches) > 0 ? (pv.samples || []) : [];   // 最初の取込（全部が新設）は例を並べない
    const sample = r => {
      const code = r.target === '銀行' ? r.bank_code : `${r.bank_code}-${r.branch_code}`;
      const what = r.kind === '新設' ? ((r.after || {}).name || '') : this.bmDiffText(r.before, r.after);
      return `<div style="padding:5px 10px;border-bottom:1px solid var(--muted);font-size:11.5px"><span class="badge ${this.BM_KIND_CLS[r.kind] || 'b-slate'}">${this.esc(r.kind)}</span> ${this.esc(r.target)} <span class="tnum">${this.esc(code)}</span>　${this.esc(what)}</div>`;
    };
    const changed = KINDS.reduce((s, [k]) => s + Number(c[k] || 0), 0);
    body.innerHTML =
      `<div style="font-size:12.5px;margin-bottom:8px"><b>${this.esc(name)}</b>　${n(total)} 行</div>` +
      (pv.problem ? `<div class="alert warn" id="tmk-bankimp-problem">${this.esc(pv.problem)}</div>` : '') +
      `<div class="tblwrap" style="max-width:360px;margin-bottom:10px"><table class="tbl ro" id="tmk-bankimp-counts"><tbody>${lines}</tbody></table></div>` +
      (samples.length ? `<div style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;margin-bottom:10px">${samples.map(sample).join('')}` +
        (changed > samples.length ? `<div class="mf" style="padding:5px 10px;font-size:11px">…ほか ${n(changed - samples.length)} 件</div>` : '') + '</div>' : '') +
      `<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;font-size:12px"><span>基準日（この一覧の日付）</span><input type="date" class="inp" id="tmk-bankimp-asof" value="${this.esc(asOf)}" max="${this.esc(this.jstToday())}" style="width:150px;min-width:0"></div>` +
      `<div style="display:flex;gap:8px"><button class="btn" data-tmk-ovclose>やめる</button><span style="flex:1"></span>` +
      (pv.problem ? '' : '<button class="btn btn-primary" id="tmk-bankimp-apply">取り込む</button>') + '</div>';
    const btn = this.el('tmk-bankimp-apply');
    if (btn) btn.onclick = () => this.bmImportApply();
  },
  async bmImportApply() {
    const imp = this.bmImp;
    if (!imp || this.busy) return;
    const asOf = (this.el('tmk-bankimp-asof') || {}).value || null;
    const btn = this.el('tmk-bankimp-apply');
    this.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = '取り込み中…'; }
    let c;
    try {
      c = await this.bmRpc('bank_master_apply', { p_run: imp.run, p_allow_big_drop: false, p_as_of: asOf });
    } catch (e) {
      this.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '取り込む'; }
      alert('取り込めませんでした: ' + (e.message || e));
      return;
    }
    this.busy = false;
    this.bmImp = null;
    this.el('tmk-ov-bankimp').classList.remove('on');
    const n = v => Number(v || 0).toLocaleString();
    const parts = [['店:新設', '店の新設'], ['店:改称', '店の改称'], ['店:変更', '店の変更'], ['銀行:新設', '銀行の新設'], ['銀行:改称', '銀行の改称']]
      .filter(([k]) => Number((c || {})[k]) > 0).map(([k, t]) => `${t} ${n(c[k])}`);
    this.toast(`銀行マスタに取り込みました（${parts.length ? parts.join('・') : '変わった所なし'}）`);
    await this.bmLoad(true);
    if (this.view === 'bank') this.renderBankGlobal();
  },

  // ===== 振込先口座の CSV 取込の点検 =====
  //   変わる口座は、銀行マスタにある店（廃止でない）のコードを持っていること。銀行名は銀行マスタの名前で入れる（CSV の銀行名は使わない）。
  //   合わない口座は errs に移す（下見の窓の「取り込めない行」に出る）
  async bmCheckCsvItems(items, errs) {
    const codeOf = (it, col) => {
      const ch = it.changes.find(x => x.column === col);
      const v = ch ? ch.newV : (it.acc ? it.acc[col] : null);
      return String(v === null || v === undefined ? '' : v).trim();
    };
    const key = it => (/^\d{4}$/.test(it._b) && /^\d{3}$/.test(it._s) ? it._b + '-' + it._s : '');
    items.forEach(it => { it._b = codeOf(it, 'bank_code'); it._s = codeOf(it, 'branch_code'); });
    let names;
    try { names = await this.bmLookup(items.map(key)); }
    catch (e) {
      errs.push(`銀行マスタを読めませんでした（${String(e.message || e).slice(0, 60)}）。口座は 1 件も取り込みません`);
      items.length = 0;
      return;
    }
    const keep = [];
    items.forEach(it => {
      const r = (!it._b || !it._s) ? { error: '銀行コードと支店コードは必須です' } : this.bmJudge(it._b, it._s, names[key(it)]);
      if (r.error) { errs.push(`${it.line}行目（${it.name}・第${it.priority}口座）: ${r.error}`); return; }
      const cur = it.acc ? it.acc.bank_name : null;
      it.changes = it.changes.filter(x => x.column !== 'bank_name');
      if (!this.sameVal(cur, r.bank_name)) it.changes.unshift({ column: 'bank_name', oldV: cur, newV: r.bank_name });
      if (it.changes.length) keep.push(it);
    });
    items.length = 0;
    keep.forEach(it => items.push(it));
  },
});
