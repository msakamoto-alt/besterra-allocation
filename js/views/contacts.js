/**
 * contacts.js - 社内連絡先タブ（電話番号表）
 *
 * データ = Supabase `contacts` テーブル（閲覧のみ・書込UIなし）。
 * 出典は総務発行の電話番号表PDF。改版時は Box 側の seed SQL を再実行する
 * （⚠️Publicリポジトリのため実データはコミットしない。supabase/add_contacts.sql 参照）。
 * 並び順は原本を尊重（内線=番号順・携帯=五十音順）＝ sort_order 列で保持。
 *
 * ツール化での上乗せ（2026-07-15 v2〜v3）:
 * - PDF原本風の罫線付き表・多段組
 * - 内線表/携帯のON/OFF・所属フィルタ（事務所のみ/本社のみ/個別部署）＝localStorageに記憶
 * - 所属列 = SmartHR名簿(employees)と氏名照合（Sync.normEmpKeyで異体字・空白ゆらぎ吸収）
 * - メール列 = SmartHR名簿(organization)と氏名照合（mailto:リンク・表示ON/OFF可）
 * - 事業所（本社＋各事務所・作業所）の住所/TEL/FAX＝会社公式サイト出典・地図リンク付き
 * - 番号ワンクリックコピー・tel:リンク（携帯/外線のみ）
 */
const ContactsView = {
  rows: null,   // 初回表示時に取得してキャッシュ（同期ボタンの対象外・独立データ）
  query: '',
  showBranch: true,
  showExt: true,
  showMob: true,
  showMail: true,
  dept: '',     // '' 全て / '__office__' 事務所のみ / '__hq__' 本社のみ / その他=部署名
  PREFS_KEY: 'contactsPrefs',

  init() {
    this.loadPrefs();
    const inp = document.getElementById('contacts-search');
    if (inp) {
      let timer = null;
      inp.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { this.query = inp.value; this.render(); }, 200);
      });
    }
    const clear = document.getElementById('contacts-search-clear');
    if (clear) clear.addEventListener('click', () => {
      const i = document.getElementById('contacts-search');
      if (i) i.value = '';
      this.query = '';
      this.render();
    });
    const branch = document.getElementById('contacts-show-branch');
    const ext = document.getElementById('contacts-show-ext');
    const mob = document.getElementById('contacts-show-mob');
    const mail = document.getElementById('contacts-show-mail');
    const dept = document.getElementById('contacts-dept');
    if (branch) { branch.checked = this.showBranch; branch.addEventListener('change', () => { this.showBranch = branch.checked; this.savePrefs(); this.render(); }); }
    if (ext) { ext.checked = this.showExt; ext.addEventListener('change', () => { this.showExt = ext.checked; this.savePrefs(); this.render(); }); }
    if (mob) { mob.checked = this.showMob; mob.addEventListener('change', () => { this.showMob = mob.checked; this.savePrefs(); this.render(); }); }
    if (mail) { mail.checked = this.showMail; mail.addEventListener('change', () => { this.showMail = mail.checked; this.savePrefs(); this.render(); }); }
    if (dept) dept.addEventListener('change', () => { this.dept = dept.value; this.savePrefs(); this.render(); });
    // 番号コピー（イベント委譲・再描画に強い）
    const box = document.getElementById('contacts-container');
    if (box) box.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-copy]');
      if (btn) this.copyNumber(btn);
    });
  },

  loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(this.PREFS_KEY) || '{}');
      if (typeof p.showBranch === 'boolean') this.showBranch = p.showBranch;
      if (typeof p.showExt === 'boolean') this.showExt = p.showExt;
      if (typeof p.showMob === 'boolean') this.showMob = p.showMob;
      if (typeof p.showMail === 'boolean') this.showMail = p.showMail;
      if (typeof p.dept === 'string') this.dept = p.dept;
    } catch (e) { /* 壊れた保存値は無視して既定値 */ }
  },

  savePrefs() {
    try {
      localStorage.setItem(this.PREFS_KEY, JSON.stringify({ showBranch: this.showBranch, showExt: this.showExt, showMob: this.showMob, showMail: this.showMail, dept: this.dept }));
    } catch (e) { /* プライベートモード等は諦める */ }
  },

  async refresh() {
    const box = document.getElementById('contacts-container');
    if (this.rows === null) {
      if (box) box.innerHTML = '<p class="p-4 text-slate-500 text-sm">連絡先を読み込み中…</p>';
      try {
        const sb = Sync.getSupabase();
        const res = await sb.from('contacts').select('*').order('sort_order');
        if (res.error) throw new Error(res.error.message);
        this.rows = res.data || [];
      } catch (e) {
        if (box) box.innerHTML = `<p class="p-4 text-red-600 text-sm">連絡先の読み込みに失敗しました: ${this.esc(String(e.message || e))}</p>`;
        return;
      }
    }
    this.render();
  },

  // ===== 名簿(employees)との氏名照合 =====

  normKey(s) {
    return Sync.normEmpKey ? Sync.normEmpKey(s) : String(s || '').normalize('NFKC').replace(/[\s　]+/g, '');
  },

  // normEmpKey(氏名) → 所属部署。役員・「会長/社長」等の役職名は一致しない＝空所属（本社扱い）
  deptMap() {
    if (this._deptMap) return this._deptMap;
    const map = {};
    (Sync.cache.employees || []).forEach(e => {
      const k = this.normKey(e.name);
      if (k && !map[k]) map[k] = String(e.department || '');
    });
    this._deptMap = map;
    return map;
  },

  deptOf(r) {
    // 「（兼務）」等の注記を除いた氏名で照合
    const name = String(r.name || '').replace(/[（(].*?[）)]/g, '');
    return this.deptMap()[this.normKey(name)] || '';
  },

  // normEmpKey(氏名) → メールアドレス（SmartHR名簿 organization と照合）
  emailMap() {
    if (this._emailMap) return this._emailMap;
    const map = {};
    (Sync.cache.organization || []).forEach(o => {
      const k = this.normKey(`${o.last_name || ''}${o.first_name || ''}`);
      const em = String(o.email || '').trim();
      if (k && em && !map[k]) map[k] = em;
    });
    this._emailMap = map;
    return map;
  },

  emailOf(r) {
    const name = String(r.name || '').replace(/[（(].*?[）)]/g, '');
    return this.emailMap()[this.normKey(name)] || '';
  },

  matchesDept(r) {
    if (!this.dept) return true;
    const d = this.deptOf(r);
    if (this.dept === '__office__') return d.includes('事務所');
    if (this.dept === '__hq__') return !d.includes('事務所');
    return d === this.dept || r.group_name === this.dept;
  },

  // ===== 検索 =====

  norm(s) {
    return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s　-]+/g, '');
  },

  matches(r, q) {
    if (!this.matchesDept(r)) return false;
    if (!q) return true;
    return this.norm(r.name).includes(q) || this.norm(r.number).includes(q)
      || this.norm(r.group_name).includes(q) || this.norm(this.deptOf(r)).includes(q)
      || this.norm(this.emailOf(r)).includes(q);
  },

  // ===== 描画部品 =====

  telHtml(number, mobile) {
    if (!number) return '<span class="text-slate-300">—</span>';
    const copyBtn = `<button data-copy="${this.esc(number)}" title="番号をコピー" class="ml-1 text-slate-300 hover:text-slate-600 text-xs align-middle">⧉</button>`;
    // 内線(3桁)は発信リンクにしない。外線・携帯は tel: リンク（スマホから直接発信できる）
    if (!mobile && !/^0/.test(number)) return `<span class="tabular-nums">${this.esc(number)}</span>${copyBtn}`;
    return `<a href="tel:${this.esc(number.replace(/-/g, ''))}" class="text-blue-700 hover:underline tabular-nums">${this.esc(number)}</a>${copyBtn}`;
  },

  async copyNumber(btn) {
    const num = btn.getAttribute('data-copy') || '';
    try {
      await navigator.clipboard.writeText(num);
      const prev = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('text-emerald-600');
      setTimeout(() => { btn.textContent = prev; btn.classList.remove('text-emerald-600'); }, 1200);
    } catch (e) { alert('コピーできませんでした: ' + num); }
  },

  // 部署/五十音ブロック1つ＝罫線付き小表（PDF原本の見た目に寄せる）
  blockHtml(title, rows, opts) {
    const th = opts.mobile
      ? '<tr><th class="border border-slate-300 bg-slate-100 px-2 py-1 text-left font-medium w-[38%]">氏名</th>' +
        '<th class="border border-slate-300 bg-slate-100 px-2 py-1 text-left font-medium">所属</th>' +
        '<th class="border border-slate-300 bg-slate-100 px-2 py-1 text-right font-medium whitespace-nowrap">携帯番号</th></tr>'
      : '<tr><th class="border border-slate-300 bg-slate-100 px-2 py-1 text-left font-medium">氏名</th>' +
        '<th class="border border-slate-300 bg-slate-100 px-2 py-1 text-right font-medium whitespace-nowrap w-20">内線</th></tr>';
    const body = rows.map(r => {
      let nameCell = this.esc(r.name);
      if (opts.mobile && this.showMail) {
        const em = this.emailOf(r);
        if (em) {
          nameCell += `<div class="text-[11px] leading-tight"><a href="mailto:${this.esc(em)}" class="text-slate-400 hover:text-blue-700 hover:underline">${this.esc(em)}</a>` +
            `<button data-copy="${this.esc(em)}" title="メールアドレスをコピー" class="ml-1 text-slate-300 hover:text-slate-600 text-xs align-middle">⧉</button></div>`;
        }
      }
      const cells = opts.mobile
        ? `<td class="border border-slate-200 px-2 py-1">${nameCell}</td>` +
          `<td class="border border-slate-200 px-2 py-1 text-xs text-slate-500">${this.esc(this.deptOf(r)) || '<span class="text-slate-300">—</span>'}</td>` +
          `<td class="border border-slate-200 px-2 py-1 text-right whitespace-nowrap align-top">${this.telHtml(r.number, true)}</td>`
        : `<td class="border border-slate-200 px-2 py-1">${nameCell}</td>` +
          `<td class="border border-slate-200 px-2 py-1 text-right whitespace-nowrap">${this.telHtml(r.number, false)}</td>`;
      return `<tr class="hover:bg-amber-50">${cells}</tr>`;
    }).join('');
    return `<div class="break-inside-avoid mb-3">` +
      (title ? `<div class="bg-slate-700 text-white text-xs font-bold px-2 py-1 rounded-t">${this.esc(title)}</div>` : '') +
      `<table class="w-full text-sm border-collapse ${title ? '' : 'rounded-t'}"><thead>${th}</thead><tbody>${body}</tbody></table></div>`;
  },

  // 事業所（本社・事務所・作業所）＝住所/TEL/FAX＋地図リンク。出典=会社公式サイト
  branchHtml(rows) {
    if (!rows.length) return '';
    const body = rows.map(r => {
      const mapUrl = r.address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(r.address).replace(/^〒[\d-]+\s*/, ''))}` : '';
      return `<tr class="hover:bg-amber-50">` +
        `<td class="border border-slate-200 px-2 py-1 font-medium whitespace-nowrap">${this.esc(r.name)}</td>` +
        `<td class="border border-slate-200 px-2 py-1 text-xs">${this.esc(r.address)}` +
          (mapUrl ? ` <a href="${mapUrl}" target="_blank" rel="noopener" class="text-blue-600 hover:underline whitespace-nowrap">地図</a>` : '') +
          `<button data-copy="${this.esc(r.address)}" title="住所をコピー" class="ml-1 text-slate-300 hover:text-slate-600 text-xs align-middle">⧉</button></td>` +
        `<td class="border border-slate-200 px-2 py-1 text-right whitespace-nowrap">${this.telHtml(r.number, true)}</td>` +
        `<td class="border border-slate-200 px-2 py-1 text-right whitespace-nowrap text-slate-500">${r.fax ? this.esc(r.fax) : '<span class="text-slate-300">—</span>'}</td>` +
      '</tr>';
    }).join('');
    return '<table class="w-full text-sm border-collapse"><thead><tr>' +
      '<th class="border border-slate-300 bg-slate-100 px-2 py-1 text-left font-medium">拠点</th>' +
      '<th class="border border-slate-300 bg-slate-100 px-2 py-1 text-left font-medium">所在地</th>' +
      '<th class="border border-slate-300 bg-slate-100 px-2 py-1 text-right font-medium whitespace-nowrap">TEL</th>' +
      '<th class="border border-slate-300 bg-slate-100 px-2 py-1 text-right font-medium whitespace-nowrap">FAX</th>' +
      `</tr></thead><tbody>${body}</tbody></table>`;
  },

  // group_name の出現順を保ったブロック列
  sectionHtml(rows, opts) {
    const order = [];
    const byGroup = {};
    rows.forEach(r => {
      const g = r.group_name || '';
      if (!(g in byGroup)) { byGroup[g] = []; order.push(g); }
      byGroup[g].push(r);
    });
    return order.map(g => this.blockHtml(g ? (opts.gyo ? `${g} 行` : g) : (opts.mobile ? '' : '役員・本部'), byGroup[g], opts)).join('');
  },

  render() {
    const box = document.getElementById('contacts-container');
    const countEl = document.getElementById('contacts-count');
    if (!box || this.rows === null) return;
    this._deptMap = null;    // employees/organization 再同期に追随
    this._emailMap = null;

    // ログイン直後は名簿(organization/employees)の読込完了前に描画されることがあり、
    // その場合は所属・メール列が空になる → 名簿が届き次第、自動で再描画（最大10回リトライ）
    if (!(Sync.cache.organization || []).length || !(Sync.cache.employees || []).length) {
      if ((this._joinRetry || 0) < 10) {
        this._joinRetry = (this._joinRetry || 0) + 1;
        setTimeout(() => this.render(), 800);
      }
    } else {
      this._joinRetry = 0;
    }

    const q = this.norm(this.query);
    const asOf = (this.rows.find(r => r.section === 'meta' && r.name === 'as_of') || {}).number || '';
    const branch = this.rows.filter(r => r.section === 'branch');
    const office = this.rows.filter(r => r.section === 'office');
    const extAll = this.rows.filter(r => r.section === 'extension');
    const mobAll = this.rows.filter(r => r.section === 'mobile');
    const ext = extAll.filter(r => this.matches(r, q));
    const mob = mobAll.filter(r => this.matches(r, q));

    this.populateDeptSelect(extAll, mobAll);

    if (countEl) {
      countEl.textContent = (q || this.dept)
        ? `内線 ${ext.length}/${extAll.length}件・携帯 ${mob.length}/${mobAll.length}件` : '';
    }

    // 事業所＋本社フロア直通（検索・フィルタ対象外・「事業所」トグルで表示切替）
    let headerCard = '';
    if (this.showBranch) {
      const officeCards = office.map(r =>
        `<div class="border border-slate-200 rounded px-3 py-1.5">` +
          `<div class="text-[11px] text-slate-500">${this.esc(r.name)}</div>` +
          `<div class="text-sm font-bold whitespace-nowrap">${this.telHtml(r.number, true)}</div>` +
        '</div>').join('');
      headerCard =
        `<div class="bg-white rounded shadow p-4 mb-4">` +
          `<div class="flex items-center gap-2 mb-2"><h3 class="font-bold text-sm">事業所</h3>` +
            (asOf ? `<span class="text-xs text-slate-400 ml-auto">電話番号表 ${this.esc(asOf)} 現在・事業所情報は公式サイトより</span>` : '') +
          '</div>' +
          (branch.length ? this.branchHtml(branch) : '') +
          (officeCards ? `<div class="mt-2 flex flex-wrap items-center gap-2"><span class="text-xs text-slate-500">本社フロア直通:</span>${officeCards}</div>` : '') +
        '</div>';
    }

    const sections = [];
    if (this.showExt) {
      const body = ext.length
        ? `<div class="columns-1 sm:columns-2 2xl:columns-3 gap-3">${this.sectionHtml(ext, { mobile: false })}</div>`
        : '<p class="text-sm text-slate-400 py-3">表示条件に一致する内線はありません</p>';
      sections.push(`<div class="bg-white rounded shadow p-4"><h3 class="font-bold text-sm mb-2">本社 内線番号</h3>${body}` +
        '<p class="text-[11px] text-slate-400 mt-1">※内線番号は基本的に番号の早いものから順に記載（原本準拠）</p></div>');
    }
    if (this.showMob) {
      const body = mob.length
        ? `<div class="columns-1 lg:columns-2 gap-3">${this.sectionHtml(mob, { mobile: true, gyo: true })}</div>`
        : '<p class="text-sm text-slate-400 py-3">表示条件に一致する携帯はありません</p>';
      sections.push(`<div class="bg-white rounded shadow p-4"><h3 class="font-bold text-sm mb-2">携帯番号</h3>${body}` +
        '<p class="text-[11px] text-slate-400 mt-1">※社用携帯の番号は五十音順に記載（原本準拠）。所属・メールはSmartHR名簿との氏名照合による自動付与</p></div>');
    }
    if (!sections.length && !headerCard) sections.push('<p class="text-sm text-slate-400 p-4">すべてのセクションが非表示になっています。上のチェックで表示するものを選んでください。</p>');

    box.innerHTML = headerCard + `<div class="space-y-4">${sections.join('')}</div>`;
  },

  // 所属フィルタの選択肢＝固定3種＋名簿照合で実在した部署（五十音順）。選択値は維持する
  populateDeptSelect(extAll, mobAll) {
    const sel = document.getElementById('contacts-dept');
    if (!sel) return;
    const depts = new Set();
    extAll.concat(mobAll).forEach(r => {
      const d = this.deptOf(r);
      if (d) depts.add(d);
      if (r.group_name) depts.add(r.group_name);
    });
    const list = [...depts].sort((a, b) => a.localeCompare(b, 'ja'));
    const options =
      '<option value="">所属: すべて</option>' +
      '<option value="__office__">事務所のみ</option>' +
      '<option value="__hq__">本社のみ</option>' +
      list.map(d => `<option value="${this.esc(d)}">${this.esc(d)}</option>`).join('');
    if (sel.dataset.built !== options) {   // 変化がなければ再構築しない（選択中のちらつき防止）
      sel.innerHTML = options;
      sel.dataset.built = options;
    }
    sel.value = this.dept;
    if (sel.value !== this.dept) { this.dept = ''; sel.value = ''; }  // 保存値の部署が消えた場合
  },

  esc(text) { return Util.esc(text); },
};
