/**
 * app.js - アプリ初期化・タブ制御・認証連動
 */

const App = {
  // ログイン時は applyTabVisibility が「先頭の閲覧可能タブ」を選ぶ。
  // null 始まりにすることで、admin/executive は先頭の経営レポートに着地する。
  currentTab: null,

  // 段階E2: ロール別に閲覧できるタブ（編集可否は別途 Sync.canEdit で制御）
  // 経理(accounting)＝経営レポート〜見込み案件を閲覧のみ（編集なし＝canEdit外）。executive相当の閲覧範囲。
  TAB_ROLES: {
    pool:       ['admin', 'editor', 'executive', 'manager', 'accounting'],
    gantt:      ['admin', 'editor', 'executive', 'manager', 'viewer', 'accounting'],
    dash:       ['admin', 'editor', 'executive', 'manager', 'viewer', 'accounting'],  // Point2: 閲覧者(工事監督)は自分のダッシュボードのみ
    prospects:  ['admin', 'editor', 'executive', 'accounting'],
    management: ['admin', 'executive', 'accounting'],   // 段階E3: 経営機密。閲覧は管理者・経営者・経理のみ（RLSでも強制）
    bi:         ['admin', 'executive', 'accounting'],   // 経営分析BI（PowerBI移行）。management_reports と同じ機密モデル
    elearning:  ['admin'],  // 当面 admin 限定（問題の精査が済むまで一般非公開）。精査後に全ロールへ戻す。
    orgchart:   ['admin', 'accounting'],  // 経理は閲覧のみ（階層編集は canEdit=admin/editor でガード＋RLSでも書込不可）
  },
  canViewTab(tab) {
    const allow = this.TAB_ROLES[tab];
    return !!(Sync.role && allow && allow.includes(Sync.role));
  },

  async init() {
    this.setupAuth();
    this.setupOrgButton();
    this.setupTabs();
    this.setupSync();
    this.setupLogout();
    this.setupPwChange();

    PoolView.init();
    GanttView.init();
    DashboardView.init();
    ProspectsView.init();
    MemberAdd.init();
    OrgChartView.init();
    AccountsView.init();
    ManagementView.init();
    BiView.init();
    ELearningView.init();

    // ?board=事務所名 のときは事務所モニターボードモード（監督軸をその事務所だけ全画面表示）
    this._boardOffice = new URLSearchParams(location.search).get('board');
    // ?bi=<id> のときは経営分析ダッシュボードの全画面モード（別タブで開かれる）
    this._biId = new URLSearchParams(location.search).get('bi');
    const biClose = document.getElementById('bi-screen-close');
    if (biClose) biClose.addEventListener('click', () => { window.close(); location.href = location.pathname; });

    // 段階E1: 既存ログインセッションがあれば復元してそのまま入る
    if (await Sync.refreshSession()) {
      await this.proceedAfterAuth();
    }
  },

  // 認証後の遷移：仮パスワードなら変更画面、それ以外はボード/全画面BI/メインへ。
  async proceedAfterAuth() {
    if (Sync.mustChangePw) { this.showPwChange(); return; }
    if (this._biId) { await this.enterBi(this._biId); return; }
    if (this._boardOffice) await this.enterBoard(this._boardOffice);
    else await this.enterApp();
  },

  // ?bi=<id> 全画面モード：ツールのchromeを隠し、ダッシュボードを全ビューポートの iframe で表示。
  async enterBi(id) {
    const canView = Sync.role === 'admin' || Sync.role === 'executive' || Sync.role === 'accounting';
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.add('hidden');
    const screen = document.getElementById('bi-screen');
    const body = document.getElementById('bi-screen-body');
    if (screen) screen.classList.remove('hidden');
    if (!body) return;
    if (!canView) {
      body.innerHTML = '<div class="flex items-center justify-center h-full text-slate-500 text-sm">この画面の閲覧権限がありません。</div>';
      return;
    }
    body.innerHTML = '<div class="flex items-center justify-center h-full text-slate-400 text-sm">ダッシュボードを読み込み中…</div>';
    try {
      const html = await Sync.fetchManagementReportHtml(id);
      if (!html) { body.innerHTML = '<div class="flex items-center justify-center h-full text-slate-500 text-sm">ダッシュボードが見つかりません。</div>'; return; }
      const blob = new Blob([html], { type: 'text/html' });
      const iframe = document.createElement('iframe');
      iframe.src = URL.createObjectURL(blob);
      iframe.setAttribute('sandbox', 'allow-scripts');  // allow-same-origin は付けない（親セッション保護）
      iframe.setAttribute('title', '経営分析ダッシュボード');
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
      body.innerHTML = '';
      body.appendChild(iframe);
    } catch (e) {
      body.innerHTML = `<div class="flex items-center justify-center h-full text-red-600 text-sm">読み込み失敗: ${String(e.message || e)}</div>`;
    }
  },

  // ログイン成功後の共通処理：ロールUI反映 → データ読込
  async enterApp() {
    this.showMain();
    this.updateRoleUI();
    this.applyTabVisibility();
    await this.loadData();
    this.applyRoleLanding();
  },

  // Point2: 工事監督（閲覧者/役職者）を自分の監督ダッシュボードへ着地させる。
  // 閲覧者は自分のみ（プライバシー）、役職者は全員閲覧可だが自分に着地。
  applyRoleLanding() {
    const role = Sync.role;
    let empNo = Sync.empNo;
    // 保存された社員番号が無ければ、ログインメール一致でSmartHR名簿(organization)から導出（自動紐付け）
    if (!empNo && Sync.email) {
      const e = String(Sync.email).trim().toLowerCase();
      const o = (Sync.cache.organization || []).find(x => String(x.email || '').trim().toLowerCase() === e);
      empNo = o ? String(o.emp_no || '') : null;
    }
    // 閲覧者は自分のダッシュボードに限定（社員番号未設定なら何も一致しない値で空表示）
    DashboardView.restrictEmpId = (role === 'viewer') ? (empNo || '___none___') : null;

    const matched = empNo && (Sync.cache.employees || []).some(e =>
      (e.category === '現場監督' || e.category === '準現場監督') &&
      (String(e.id) === String(empNo) || String(e.emp_no) === String(empNo)));

    // 閲覧者は常にダッシュボード着地。役職者は本人が監督として一致するときだけ着地。
    if ((role === 'viewer' || (role === 'manager' && matched)) && this.canViewTab('dash')) {
      this.activateTab('dash');
    }
    if (role === 'viewer' || role === 'manager') {
      try { DashboardView.focusEmployee(empNo); } catch (e) { /* noop */ }
    }
  },

  // Point3: 初回パスワード変更画面を表示（仮パスワードでログインした人）
  showPwChange() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.add('hidden');
    const bs = document.getElementById('board-screen');
    if (bs) bs.classList.add('hidden');
    document.getElementById('pwchange-screen').classList.remove('hidden');
    const inp = document.getElementById('pwchange-new');
    if (inp) inp.focus();
  },

  setupPwChange() {
    const form = document.getElementById('pwchange-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('pwchange-new').value;
      const confirm = document.getElementById('pwchange-confirm').value;
      const err = document.getElementById('pwchange-error');
      const btn = form.querySelector('button[type="submit"]');
      err.classList.add('hidden');
      if (pw.length < 8) { err.textContent = 'パスワードは8文字以上にしてください'; err.classList.remove('hidden'); return; }
      if (pw !== confirm) { err.textContent = '確認用パスワードが一致しません'; err.classList.remove('hidden'); return; }
      if (btn) { btn.disabled = true; btn.textContent = '設定中…'; }
      try {
        await Sync.changeOwnPassword(pw);
        document.getElementById('pwchange-screen').classList.add('hidden');
        if (this._boardOffice) await this.enterBoard(this._boardOffice);
        else await this.enterApp();
      } catch (er) {
        err.textContent = '× ' + (er.message || 'パスワードの設定に失敗しました');
        err.classList.remove('hidden');
        if (btn) { btn.disabled = false; btn.textContent = '設定してはじめる'; }
      }
    });
  },

  // 事務所モニターボード：データを読み込み、Board に委譲して全画面表示
  async enterBoard(office) {
    try { await Sync.syncAll(); } catch (e) { console.error('Sync失敗:', e); }
    try { this.updateLastSync(); } catch (e) { /* noop */ }
    Board.enter(office);
  },

  // 段階E1: 個人アカウント（Supabase Auth）でログイン。ロールが取れて初めて入室。
  setupAuth() {
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('auth-error');
      const btn = e.target.querySelector('button[type="submit"]');
      errorEl.classList.add('hidden');
      if (btn) { btn.disabled = true; btn.textContent = 'ログイン中…'; }
      try {
        await Sync.login(email, password);
        if (!Sync.role) {
          // ログインはできたがロール未割当（権限なし）→ 入れない
          await Sync.logout();
          throw new Error('このアカウントには権限が割り当てられていません。管理者にご連絡ください。');
        }
        await this.proceedAfterAuth();
      } catch (err) {
        errorEl.textContent = '× ' + (err.message || 'ログインに失敗しました');
        errorEl.classList.remove('hidden');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'ログイン'; }
      }
    });
  },

  // ヘッダーの admin 専用ボタン（組織図・アカウント管理）を配線
  setupOrgButton() {
    const orgBtn = document.getElementById('org-toggle');
    if (orgBtn) orgBtn.addEventListener('click', () => this.activateTab('orgchart'));
    const accBtn = document.getElementById('account-toggle');
    if (accBtn) accBtn.addEventListener('click', () => AccountsView.open());
  },

  updateRoleUI() {
    const badge = document.getElementById('role-badge');
    if (badge) { badge.textContent = Sync.roleLabel(); badge.classList.remove('hidden'); }
    // 同期（参照データ取込）・アカウント管理は admin のみ。
    // 組織図ボタンは「組織図を閲覧できるロール」に表示（admin＋経理＝閲覧のみ。編集はcanEditでガード）。
    const adminOnly = Sync.isAdmin();
    const syncBtn = document.getElementById('sync-button');
    if (syncBtn) syncBtn.classList.toggle('hidden', !adminOnly);
    const orgBtn = document.getElementById('org-toggle');
    if (orgBtn) orgBtn.classList.toggle('hidden', !this.canViewTab('orgchart'));
    const accBtn = document.getElementById('account-toggle');
    if (accBtn) accBtn.classList.toggle('hidden', !adminOnly);
  },

  showMain() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');
  },

  setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.activateTab(btn.dataset.tab));
    });
    // 着地タブはログイン後に applyTabVisibility が決める（先頭の閲覧可能タブ）。
  },

  activateTab(name) {
    if (!this.canViewTab(name)) return;  // 段階E2: 許可されていないタブは無視
    this.currentTab = name;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('tab-active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== 'tab-' + name);
    });
    if (name === 'gantt') GanttView.refresh();
    if (name === 'prospects') ProspectsView.refresh();
    if (name === 'orgchart') OrgChartView.refresh();
    if (name === 'management') ManagementView.refresh();
    if (name === 'bi') BiView.refresh();
    if (name === 'elearning') ELearningView.refresh();
  },

  // 段階E2: ロールに応じてタブの表示/非表示を切り替え、見られる最初のタブを開く
  applyTabVisibility() {
    let firstAllowed = null;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const ok = this.canViewTab(btn.dataset.tab);
      btn.classList.toggle('hidden', !ok);
      if (ok && !firstAllowed) firstAllowed = btn.dataset.tab;
    });
    // 現在のタブが見られなければ最初の許可タブへ。view.refresh は直後の loadData が行うので
    // ここでは activateTab を呼ばず（データ未取得での描画を避ける）クラスだけ切り替える。
    let target = this.canViewTab(this.currentTab) ? this.currentTab : firstAllowed;
    // Point2: 閲覧者（工事監督）は自分の監督ダッシュボードを起点にする
    if (Sync.role === 'viewer' && this.canViewTab('dash')) target = 'dash';
    if (!target) return;
    this.currentTab = target;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('tab-active', b.dataset.tab === target));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + target));
  },

  setupLogout() {
    document.getElementById('logout-button').addEventListener('click', async () => {
      await Sync.logout();
      location.reload();
    });
  },

  setupSync() {
    document.getElementById('sync-button').addEventListener('click', async () => {
      const btn = document.getElementById('sync-button');
      const orig = btn.textContent;
      btn.disabled = true;
      try {
        // 編集者が同期したときだけ Sheets→Supabase（参照系3テーブル）を取込み。
        // 閲覧者・編集後の自動再描画(loadData)では実行しない（重い再投入を避ける）。
        if (Sync.USE_SUPABASE && Sync.canEdit() && typeof Sync.syncReferenceFromSheets === 'function') {
          btn.textContent = 'Sheets取込中…';
          try {
            const n = await Sync.syncReferenceFromSheets();
            console.info('参照データ同期:', n);
          } catch (e) {
            console.error('参照データ同期失敗:', e);
            alert('Sheetsからの参照データ取込みに失敗しました（表示の更新は続行します）:\n' + (e.message || e));
          }
        }
        btn.textContent = '更新中…';
        await this.loadData();
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
  },

  async loadData() {
    try { await Sync.syncAll(); } catch (e) { console.error('Sync失敗:', e); }
    try { this.updateLastSync(); } catch (e) { console.error('updateLastSync失敗:', e); }
    try { PoolView.refresh(); } catch (e) { console.error('PoolView失敗:', e); }
    try { GanttView.refresh(); } catch (e) { console.error('GanttView失敗:', e); }
    try { DashboardView.refresh(); } catch (e) { console.error('DashboardView失敗:', e); }
    try { ProspectsView.refresh(); } catch (e) { console.error('ProspectsView失敗:', e); }
    try { OrgChartView.refresh(); } catch (e) { console.error('OrgChartView失敗:', e); }
    try { ManagementView.refresh(); } catch (e) { console.error('ManagementView失敗:', e); }
    try { BiView.refresh(); } catch (e) { console.error('BiView失敗:', e); }
    try { ELearningView.refresh(); } catch (e) { console.error('ELearningView失敗:', e); }
  },

  updateLastSync() {
    const el = document.getElementById('last-sync');
    if (Sync.lastSync) {
      const t = Sync.lastSync;
      el.textContent = `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
    }
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
