/**
 * app.js - アプリ初期化・タブ制御・認証連動
 */

const App = {
  currentTab: 'pool',

  async init() {
    this.setupAuth();
    this.setupTabs();
    this.setupSync();
    this.setupLogout();

    PoolView.init();
    GanttView.init();
    DashboardView.init();

    if (Auth.getSession()) {
      this.showMain();
      await this.loadData();
    }
  },

  setupAuth() {
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('auth-error');
      if (await Auth.verify(password)) {
        Auth.saveSession(password);
        errorEl.classList.add('hidden');
        this.showMain();
        await this.loadData();
      } else {
        errorEl.classList.remove('hidden');
      }
    });
  },

  showMain() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');
  },

  setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.activateTab(btn.dataset.tab));
    });
    this.activateTab('pool');
  },

  activateTab(name) {
    this.currentTab = name;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('tab-active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== 'tab-' + name);
    });
    // ガントタブを最初に開いた時はデフォルト軸を有効化
    if (name === 'gantt') GanttView.refresh();
  },

  setupLogout() {
    document.getElementById('logout-button').addEventListener('click', () => {
      Auth.clearSession();
      location.reload();
    });
  },

  setupSync() {
    document.getElementById('sync-button').addEventListener('click', async () => {
      await this.loadData();
    });
  },

  async loadData() {
    try {
      await Sync.syncAll();
      this.updateLastSync();
      PoolView.refresh();
      GanttView.refresh();
      DashboardView.refresh();
    } catch (err) {
      console.error('データ取得失敗:', err);
      alert('データ取得に失敗しました: ' + err.message);
    }
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
