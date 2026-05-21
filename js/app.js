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
    try { await Sync.syncAll(); } catch (e) { console.error('Sync失敗:', e); }
    try { this.updateLastSync(); } catch (e) { console.error('updateLastSync失敗:', e); }
    try { PoolView.refresh(); } catch (e) { console.error('PoolView失敗:', e); }
    try { GanttView.refresh(); } catch (e) { console.error('GanttView失敗:', e); }
    try { DashboardView.refresh(); } catch (e) { console.error('DashboardView失敗:', e); }
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
