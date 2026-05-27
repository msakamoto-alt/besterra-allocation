/**
 * app.js - アプリ初期化・タブ制御・認証連動
 */

const App = {
  // ログイン時は applyTabVisibility が「先頭の閲覧可能タブ」を選ぶ。
  // null 始まりにすることで、admin/executive は先頭の経営レポートに着地する。
  currentTab: null,

  // 段階E2: ロール別に閲覧できるタブ（編集可否は別途 Sync.canEdit で制御）
  TAB_ROLES: {
    pool:       ['admin', 'editor', 'executive', 'manager'],
    gantt:      ['admin', 'editor', 'executive', 'manager', 'viewer'],
    dash:       ['admin', 'editor', 'executive', 'manager'],
    prospects:  ['admin', 'editor', 'executive'],
    management: ['admin', 'executive'],   // 段階E3: 経営機密。閲覧は管理者・経営者のみ（RLSでも強制）
    elearning:  ['admin', 'editor', 'executive', 'manager', 'viewer'],  // 段階E4a: 安全学習はログイン者全員
    orgchart:   ['admin'],
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

    PoolView.init();
    GanttView.init();
    DashboardView.init();
    ProspectsView.init();
    MemberAdd.init();
    OrgChartView.init();
    AccountsView.init();
    ManagementView.init();
    ELearningView.init();

    // 段階E1: 既存ログインセッションがあれば復元してそのまま入る
    if (await Sync.refreshSession()) {
      await this.enterApp();
    }
  },

  // ログイン成功後の共通処理：ロールUI反映 → データ読込
  async enterApp() {
    this.showMain();
    this.updateRoleUI();
    this.applyTabVisibility();
    await this.loadData();
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
        await this.enterApp();
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
    // 同期（参照データ取込）・組織図（階層判定）は admin のみ
    const adminOnly = Sync.isAdmin();
    const syncBtn = document.getElementById('sync-button');
    if (syncBtn) syncBtn.classList.toggle('hidden', !adminOnly);
    const orgBtn = document.getElementById('org-toggle');
    if (orgBtn) orgBtn.classList.toggle('hidden', !adminOnly);
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
    const target = this.canViewTab(this.currentTab) ? this.currentTab : firstAllowed;
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
