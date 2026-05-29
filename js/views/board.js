/**
 * board.js - 事務所単独モニタービュー（?board=事務所名 で起動）
 *
 * その事務所の監督ごとの配置予定を、画面いっぱいに使う複数列レイアウトで表示する。
 * 列数は画面サイズに合わせて自動最適化（縦長になりすぎないよう横に並べる）。
 * 表示モードは2種：
 *   month    … 月次（全期間：当月〜+9か月）
 *   monthday … 当月だけ日次＋先々は月次
 * 用途＝事務所モニター掲示。認証は既存ログインセッション（localStorage 共有）を再利用。
 * データ取得・描画は App.enterBoard から呼ばれる（データ読込後に enter）。
 */
const Board = {
  office: null,
  mode: 'month',
  _timer: null,
  _bound: false,

  enter(office) {
    this.office = office;
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.add('hidden');
    const screen = document.getElementById('board-screen');
    if (screen) screen.classList.remove('hidden');

    // 表示窓：当月〜+9か月（先々の予定・空きが一望できる範囲）
    const now = new Date();
    GanttView.displayStart = new Date(now.getFullYear(), now.getMonth(), 1);
    GanttView.displayEnd = new Date(now.getFullYear(), now.getMonth() + 9, 0);
    GanttView.showCompleted = false;
    GanttView.showProspects = true;

    document.title = office + ' 監督配置ボード';
    const nameEl = document.getElementById('board-office-name');
    if (nameEl) nameEl.textContent = office;

    this.bindModeButtons();
    this.render();

    if (!this._bound) {
      window.addEventListener('resize', () => this.fit());
      this._bound = true;
    }
    // 5分ごとに最新データへ更新（モニター掲示の鮮度維持）
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this.refreshData(), 5 * 60 * 1000);
  },

  bindModeButtons() {
    document.querySelectorAll('.board-mode-btn').forEach(btn => {
      btn.onclick = () => this.setMode(btn.dataset.mode);
    });
  },

  setMode(mode) {
    this.mode = mode;
    this.render();
  },

  // モードに応じて当月の日次展開を切替（displayStart/End は enter で設定済み）
  applyMode() {
    GanttView.expandedMonths.clear();
    if (this.mode === 'monthday') {
      GanttView.expandedMonths.add(GanttView.monthKey(new Date()));
    }
  },

  render() {
    const content = document.getElementById('board-content');
    if (!content) return;
    this.applyMode();

    // モードボタンの選択状態を反映
    document.querySelectorAll('.board-mode-btn').forEach(btn => {
      const on = btn.dataset.mode === this.mode;
      btn.classList.toggle('bg-white', on);
      btn.classList.toggle('text-slate-900', on);
      btn.classList.toggle('bg-slate-700', !on);
      btn.classList.toggle('text-slate-200', !on);
    });

    const stage = document.getElementById('board-stage');
    const stageW = stage ? stage.clientWidth : window.innerWidth;
    const stageH = stage ? stage.clientHeight : window.innerHeight;
    let numCols = 1;
    try { numCols = GanttView.pickColumnCount(this.office, stageW, stageH); } catch (e) { numCols = 1; }
    try {
      content.innerHTML = GanttView.renderOfficeMonitor(this.office, numCols);
    } catch (e) {
      content.innerHTML = '<div class="p-4 text-red-600">描画エラー: ' + (e.message || e) + '</div>';
      console.error('ボード描画失敗:', e);
    }

    const now = new Date();
    const d = document.getElementById('board-date');
    if (d) d.textContent = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} 現在`;
    const u = document.getElementById('board-updated');
    if (u) u.textContent = `更新 ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

    // レイアウト確定後にフィット（Tailwind CDN が動的要素にスタイルを当てる遅延に備え二度実行）
    requestAnimationFrame(() => this.fit());
    setTimeout(() => this.fit(), 400);
  },

  // 自然サイズのガントを画面に収まるよう transform: scale で縮小/拡大
  fit() {
    const stage = document.getElementById('board-stage');
    const content = document.getElementById('board-content');
    if (!stage || !content) return;
    content.style.transform = 'none';
    const availW = stage.clientWidth;
    const availH = stage.clientHeight;
    const cw = content.scrollWidth || content.offsetWidth;
    const ch = content.scrollHeight || content.offsetHeight;
    if (!cw || !ch) return;
    const scale = Math.min(availW / cw, availH / ch, 2.5) * 0.97;
    content.style.transform = 'scale(' + scale + ')';
  },

  async refreshData() {
    try {
      await Sync.syncAll();
      this.render();
    } catch (e) {
      console.error('ボード更新失敗:', e);
    }
  },
};
