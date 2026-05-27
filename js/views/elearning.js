/**
 * elearning.js - 安全Eラーニング（段階E4a）
 *
 * 学習：単元を選び、4択を解く → タップで即判定＋解説＋出典 → 次へ。
 *       解答は1件ずつ quiz_answers に記録（本人のみ書込・RLS強制）。
 * 出題管理（admin のみ）：問題の一覧・公開/非公開・追加・編集・削除＝「ツール上で精査」。
 *
 * 描画は #elearn-body に動的生成。クリックはコンテナへのイベント委譲で処理。
 * loadData による refresh はクイズ/編集の最中は再描画しない（進行中の状態を壊さない）。
 */
const ELearningView = {
  UNITS: ['安全のしおり', '規程類', 'ベステラスタンダード', '過去事例'],
  COUNT_OPTIONS: [10, 20, 0],          // 0 = 全部

  allQuestions: [],                    // admin は非公開も含む全件
  questions: [],                       // 公開問題（学習対象）
  counts: { today: 0, total: 0 },
  screen: 'start',                     // start | quiz | summary | manage | edit
  unit: 'all',                         // 選択中の単元（学習）
  n: 10,                               // 出題数
  queue: [],
  pos: 0,
  revealed: false,
  chosen: null,
  sCount: 0,
  sCorrect: 0,

  init() {
    const body = document.getElementById('elearn-body');
    if (body) body.addEventListener('click', (e) => this.onClick(e));
  },

  isAdmin() { return Sync.isAdmin(); },
  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },
  nl2br(s) { return this.esc(s).replace(/\n/g, '<br>'); },
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  async refresh() {
    if (!Sync.role) return;
    try {
      const all = await Sync.listQuizQuestions(false);   // 非adminはRLSで公開分のみ返る
      this.allQuestions = all;
      this.questions = all.filter(q => q.active);
    } catch (e) {
      console.error('出題取得失敗:', e);
    }
    try { this.counts = await Sync.myQuizCounts(); } catch (e) { /* noop */ }
    // クイズ/編集/インポート/進捗の最中は再描画しない（進行中の状態・自前ロードを保護）
    if (['quiz', 'edit', 'import', 'progress'].includes(this.screen)) return;
    this.render();
  },

  render() {
    const body = document.getElementById('elearn-body');
    if (!body) return;
    if (this.screen === 'manage') return body.innerHTML = this.htmlManage();
    if (this.screen === 'import') return body.innerHTML = this.htmlImport();
    if (this.screen === 'edit') return body.innerHTML = this.htmlEdit();
    if (this.screen === 'quiz') return body.innerHTML = this.htmlQuiz();
    if (this.screen === 'summary') return body.innerHTML = this.htmlSummary();
    if (this.screen === 'progress') return body.innerHTML = this.htmlProgress();
    return body.innerHTML = this.htmlStart();
  },

  // ===== 共通パーツ =====
  countsBar() {
    return `<div class="flex items-center gap-4 text-sm text-slate-600">
      <span>今日 <b class="text-slate-900 text-base">${this.counts.today}</b> 問</span>
      <span>通算 <b class="text-slate-900 text-base">${this.counts.total}</b> 問</span>
    </div>`;
  },
  navBar() {
    const cur = (this.screen === 'manage' || this.screen === 'edit' || this.screen === 'import') ? 'manage'
      : this.screen === 'progress' ? 'progress' : 'learn';
    const items = [['learn', '学習'], ['progress', '進捗']];
    if (this.isAdmin()) items.push(['manage', '出題管理']);
    const btn = ([act, label]) => {
      const on = cur === act;
      return `<button data-act="${act}" class="px-3 py-1.5 rounded text-sm font-medium border ${on
        ? 'bg-red-600 text-white border-red-600' : 'bg-white text-slate-700 border-slate-300'}">${label}</button>`;
    };
    return `<div class="flex gap-2">${items.map(btn).join('')}</div>`;
  },

  // ===== 学習: スタート =====
  htmlStart() {
    const byUnit = {};
    this.questions.forEach(q => { byUnit[q.unit] = (byUnit[q.unit] || 0) + 1; });
    const total = this.questions.length;
    const chip = (val, label, cnt) => {
      const on = this.unit === val;
      return `<button data-act="unit" data-unit="${this.esc(val)}"
        class="px-4 py-2 rounded-lg text-sm font-medium border-2 ${on
          ? 'bg-red-600 text-white border-red-600' : 'bg-white text-slate-700 border-slate-300 hover:border-red-300'}">
        ${this.esc(label)} <span class="opacity-70">(${cnt})</span></button>`;
    };
    const unitChips = ['<div class="flex flex-wrap gap-2">',
      chip('all', '全分野', total),
      ...this.UNITS.filter(u => byUnit[u]).map(u => chip(u, u, byUnit[u])),
      '</div>'].join('');
    const nBtn = (v) => {
      const on = this.n === v;
      const label = v === 0 ? '全部' : `${v}問`;
      return `<button data-act="count" data-n="${v}"
        class="px-3 py-1.5 rounded-lg text-sm font-medium border-2 ${on
          ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300'}">${label}</button>`;
    };
    const avail = this.unit === 'all' ? total : (byUnit[this.unit] || 0);
    const canStart = avail > 0;
    return `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      ${this.countsBar()}
      ${this.navBar()}
    </div>
    <div class="bg-white rounded-lg shadow p-6 max-w-2xl mx-auto">
      <div class="text-center mb-1 text-lg font-bold text-slate-800">毎朝、現場に入る前の安全クイズ</div>
      <div class="text-center text-sm text-slate-500 mb-5">分野と問題数を選んで「はじめる」</div>
      <div class="mb-4"><div class="text-xs text-slate-500 mb-2">分野</div>${unitChips}</div>
      <div class="mb-6"><div class="text-xs text-slate-500 mb-2">問題数</div>
        <div class="flex gap-2">${this.COUNT_OPTIONS.map(nBtn).join('')}</div></div>
      <button data-act="start" ${canStart ? '' : 'disabled'}
        class="w-full py-3 rounded-lg font-bold text-white ${canStart
          ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-300 cursor-not-allowed'}">
        はじめる（${avail}問から${this.n === 0 ? '全部' : Math.min(this.n, avail) + '問'}）</button>
      ${total === 0 ? '<div class="text-center text-sm text-slate-400 mt-4">公開中の問題がまだありません。</div>' : ''}
    </div>`;
  },

  startSession() {
    let pool = this.unit === 'all' ? this.questions : this.questions.filter(q => q.unit === this.unit);
    pool = this.shuffle(pool);
    if (this.n > 0) pool = pool.slice(0, this.n);
    if (!pool.length) return;
    this.queue = pool;
    this.pos = 0; this.sCount = 0; this.sCorrect = 0;
    this.revealed = false; this.chosen = null;
    this.screen = 'quiz';
    this.render();
  },

  // ===== 学習: 設問 =====
  htmlQuiz() {
    const q = this.queue[this.pos];
    if (!q) { this.screen = 'summary'; return this.htmlSummary(); }
    const letters = ['A', 'B', 'C', 'D'];
    const texts = { A: q.choice_a, B: q.choice_b, C: q.choice_c, D: q.choice_d };
    const cards = letters.map(L => {
      let cls = 'border-slate-300 bg-white hover:border-red-300';
      let mark = `<span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-sm font-bold mr-2">${L}</span>`;
      if (this.revealed) {
        if (L === q.correct) { cls = 'border-emerald-500 bg-emerald-50'; mark = `<span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500 text-white text-sm font-bold mr-2">✓</span>`; }
        else if (L === this.chosen) { cls = 'border-red-500 bg-red-50'; mark = `<span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-500 text-white text-sm font-bold mr-2">✕</span>`; }
        else { cls = 'border-slate-200 bg-white opacity-60'; }
      }
      return `<button data-act="choose" data-letter="${L}" ${this.revealed ? 'disabled' : ''}
        class="text-left border-2 rounded-lg p-4 flex items-start ${cls}">
        ${mark}<span class="text-sm text-slate-800 leading-relaxed">${this.esc(texts[L])}</span></button>`;
    }).join('');

    let reveal = '';
    if (this.revealed) {
      const ok = this.chosen === q.correct;
      reveal = `
      <div class="mt-4 rounded-lg ${ok ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'} p-4">
        <div class="font-bold ${ok ? 'text-emerald-700' : 'text-red-700'} mb-2">${ok ? '正解！' : '不正解'}　<span class="text-slate-600 font-normal text-sm">正解は ${q.correct}</span></div>
        <div class="text-sm text-slate-700 leading-relaxed">${this.nl2br(q.explanation)}</div>
        ${q.source ? `<div class="text-xs text-slate-400 mt-2">出典：${this.esc(q.source)}</div>` : ''}
      </div>
      <button data-act="next" class="w-full mt-4 py-3 rounded-lg font-bold text-white bg-red-600 hover:bg-red-700">
        ${this.pos + 1 >= this.queue.length ? '結果を見る' : '次の問題 →'}</button>`;
    }

    const pct = this.sCount ? Math.round(this.sCorrect / this.sCount * 100) : 0;
    return `
    <div class="bg-white rounded-lg shadow p-5 max-w-2xl mx-auto">
      <div class="flex items-center justify-between text-xs text-slate-500 mb-3">
        <span>${this.esc(q.unit)}${q.sub ? ' / ' + this.esc(q.sub) : ''} <span class="text-amber-500">${this.esc(q.difficulty || '')}</span></span>
        <span>${this.pos + 1} / ${this.queue.length}　正答 ${this.sCorrect}/${this.sCount}（${pct}%）</span>
      </div>
      <div class="text-base font-bold text-slate-900 mb-4 leading-relaxed">${this.nl2br(q.question)}</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${cards}</div>
      ${reveal}
    </div>`;
  },

  choose(letter) {
    if (this.revealed) return;
    const q = this.queue[this.pos];
    if (!q) return;
    this.chosen = letter;
    this.revealed = true;
    const ok = letter === q.correct;
    this.sCount++; if (ok) this.sCorrect++;
    this.counts.today++; this.counts.total++;
    // 記録（fire-and-forget・失敗してもUIは進める）
    Sync.recordQuizAnswer({ question_id: q.id, qid: q.qid, unit: q.unit, choice: letter, is_correct: ok })
      .catch(e => console.error('解答記録失敗:', e));
    this.render();
  },

  next() {
    this.pos++;
    this.revealed = false; this.chosen = null;
    if (this.pos >= this.queue.length) { this.screen = 'summary'; }
    this.render();
  },

  // ===== 学習: 結果 =====
  htmlSummary() {
    const pct = this.sCount ? Math.round(this.sCorrect / this.sCount * 100) : 0;
    return `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">${this.countsBar()}${this.navBar()}</div>
    <div class="bg-white rounded-lg shadow p-8 max-w-lg mx-auto text-center">
      <div class="text-lg font-bold text-slate-800 mb-4">おつかれさまでした</div>
      <div class="text-5xl font-extrabold text-red-600 mb-1">${pct}<span class="text-2xl">%</span></div>
      <div class="text-sm text-slate-500 mb-6">${this.sCount}問中 ${this.sCorrect}問 正解</div>
      <div class="flex gap-3 justify-center">
        <button data-act="again" class="px-5 py-2.5 rounded-lg font-bold text-white bg-red-600 hover:bg-red-700">もう一度</button>
        <button data-act="pick" class="px-5 py-2.5 rounded-lg font-medium text-slate-700 bg-white border border-slate-300">分野を選ぶ</button>
      </div>
    </div>`;
  },

  // ===== 出題管理（admin）=====
  htmlManage() {
    const rows = this.allQuestions.map(q => {
      const head = (q.question || '').slice(0, 36);
      return `<tr class="border-t border-slate-100 ${q.active ? '' : 'bg-slate-50 text-slate-400'}">
        <td class="px-2 py-2 text-xs whitespace-nowrap">${this.esc(q.qid)}</td>
        <td class="px-2 py-2 text-xs whitespace-nowrap">${this.esc(q.unit)}</td>
        <td class="px-2 py-2 text-xs whitespace-nowrap">${this.esc(q.sub || '')}</td>
        <td class="px-2 py-2 text-xs text-center">${this.esc(q.difficulty || '')}</td>
        <td class="px-2 py-2 text-sm">${this.esc(head)}${(q.question || '').length > 36 ? '…' : ''}</td>
        <td class="px-2 py-2 text-xs text-center font-bold">${this.esc(q.correct)}</td>
        <td class="px-2 py-2 text-center">
          <button data-act="toggle" data-id="${q.id}" class="text-xs px-2 py-1 rounded ${q.active
            ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}">${q.active ? '公開' : '非公開'}</button>
        </td>
        <td class="px-2 py-2 text-center whitespace-nowrap">
          <button data-act="edit" data-id="${q.id}" class="text-xs text-blue-600 hover:underline mr-2">編集</button>
          <button data-act="del" data-id="${q.id}" class="text-xs text-red-600 hover:underline">削除</button>
        </td>
      </tr>`;
    }).join('');
    return `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <div class="text-sm text-slate-600">登録 <b>${this.allQuestions.length}</b> 問（公開 ${this.questions.length}）</div>
      <div class="flex gap-2 items-center">
        <button data-act="import" class="bg-slate-700 hover:bg-slate-800 text-white px-4 py-1.5 rounded text-sm font-medium">⬆ 一括インポート</button>
        <button data-act="add" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded text-sm font-medium">+ 問題を追加</button>
        ${this.navBar()}
      </div>
    </div>
    <div class="bg-white rounded-lg shadow overflow-x-auto">
      <table class="w-full text-left">
        <thead class="bg-slate-100 text-xs text-slate-600">
          <tr><th class="px-2 py-2">ID</th><th class="px-2 py-2">単元</th><th class="px-2 py-2">中分類</th>
          <th class="px-2 py-2">難易度</th><th class="px-2 py-2">問題</th><th class="px-2 py-2">正解</th>
          <th class="px-2 py-2 text-center">状態</th><th class="px-2 py-2 text-center">操作</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="8" class="px-3 py-6 text-center text-slate-400 text-sm">問題がありません</td></tr>'}</tbody>
      </table>
    </div>`;
  },

  _editing: null,   // 編集中の問題（新規は {}）

  htmlEdit() {
    const q = this._editing || {};
    const isNew = !q.id;
    const unitOpts = this.UNITS.map(u =>
      `<option value="${this.esc(u)}" ${q.unit === u ? 'selected' : ''}>${this.esc(u)}</option>`).join('');
    const diffOpts = ['★', '★★', '★★★'].map(d =>
      `<option value="${d}" ${q.difficulty === d ? 'selected' : ''}>${d}</option>`).join('');
    const corrOpts = ['A', 'B', 'C', 'D'].map(c =>
      `<option value="${c}" ${q.correct === c ? 'selected' : ''}>${c}</option>`).join('');
    const inp = (id, val, ph) =>
      `<input id="${id}" value="${this.esc(val || '')}" placeholder="${ph || ''}" class="border rounded w-full px-2 py-1.5 text-sm">`;
    const ta = (id, val, rows) =>
      `<textarea id="${id}" rows="${rows || 2}" class="border rounded w-full px-2 py-1.5 text-sm">${this.esc(val || '')}</textarea>`;
    return `
    <div class="bg-white rounded-lg shadow p-6 max-w-2xl mx-auto">
      <div class="text-lg font-bold mb-4">${isNew ? '問題を追加' : '問題を編集'}</div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div><label class="block text-xs text-slate-500 mb-1">ID <span class="text-red-500">*</span></label>${inp('eq-qid', q.qid, '例 SHIORI-025')}</div>
        <div><label class="block text-xs text-slate-500 mb-1">単元</label>
          <select id="eq-unit" class="border rounded w-full px-2 py-1.5 text-sm">${unitOpts}</select></div>
        <div><label class="block text-xs text-slate-500 mb-1">中分類</label>${inp('eq-sub', q.sub, '例 高所作業')}</div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="block text-xs text-slate-500 mb-1">難易度</label>
            <select id="eq-diff" class="border rounded w-full px-2 py-1.5 text-sm">${diffOpts}</select></div>
          <div><label class="block text-xs text-slate-500 mb-1">正解</label>
            <select id="eq-correct" class="border rounded w-full px-2 py-1.5 text-sm">${corrOpts}</select></div>
        </div>
      </div>
      <div class="mb-3"><label class="block text-xs text-slate-500 mb-1">問題文 <span class="text-red-500">*</span></label>${ta('eq-question', q.question, 2)}</div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div><label class="block text-xs text-slate-500 mb-1">選択肢A</label>${inp('eq-a', q.choice_a)}</div>
        <div><label class="block text-xs text-slate-500 mb-1">選択肢B</label>${inp('eq-b', q.choice_b)}</div>
        <div><label class="block text-xs text-slate-500 mb-1">選択肢C</label>${inp('eq-c', q.choice_c)}</div>
        <div><label class="block text-xs text-slate-500 mb-1">選択肢D</label>${inp('eq-d', q.choice_d)}</div>
      </div>
      <div class="mb-3"><label class="block text-xs text-slate-500 mb-1">解説</label>${ta('eq-exp', q.explanation, 3)}</div>
      <div class="mb-4"><label class="block text-xs text-slate-500 mb-1">出典</label>${inp('eq-source', q.source, '例 安全のしおり 4-3 高所作業 ②')}</div>
      <label class="flex items-center gap-2 text-sm mb-5"><input type="checkbox" id="eq-active" ${q.active === false ? '' : 'checked'}> 公開する</label>
      <div id="eq-status" class="text-xs text-red-600 min-h-[16px] mb-2"></div>
      <div class="flex gap-3">
        <button data-act="save" class="px-5 py-2 rounded-lg font-bold text-white bg-emerald-600 hover:bg-emerald-700">保存</button>
        <button data-act="cancel" class="px-5 py-2 rounded-lg font-medium text-slate-700 bg-white border border-slate-300">キャンセル</button>
      </div>
    </div>`;
  },

  val(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; },

  async save() {
    const st = document.getElementById('eq-status');
    const q = {
      qid: this.val('eq-qid'), unit: this.val('eq-unit'), sub: this.val('eq-sub'),
      difficulty: this.val('eq-diff'), correct: this.val('eq-correct'),
      question: this.val('eq-question'),
      choice_a: this.val('eq-a'), choice_b: this.val('eq-b'),
      choice_c: this.val('eq-c'), choice_d: this.val('eq-d'),
      explanation: this.val('eq-exp'), source: this.val('eq-source'),
      active: !!(document.getElementById('eq-active') && document.getElementById('eq-active').checked),
    };
    if (!q.qid) return st.textContent = 'ID を入力してください';
    if (!q.question) return st.textContent = '問題文を入力してください';
    if (!q.choice_a || !q.choice_b || !q.choice_c || !q.choice_d) return st.textContent = '選択肢A〜Dをすべて入力してください';
    st.textContent = '保存中…'; st.className = 'text-xs text-slate-500 min-h-[16px] mb-2';
    try {
      await Sync.upsertQuizQuestion(q);
      this._editing = null;
      this.screen = 'manage';
      await this.refresh();
    } catch (e) {
      st.textContent = '× ' + (e.message || e); st.className = 'text-xs text-red-600 min-h-[16px] mb-2';
    }
  },

  // ===== 個人の学習進捗（E4b）=====
  _stats: null,
  _goals: { daily_goal: 10, weekly_goal: 70 },
  _editGoals: false,

  dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  async showProgress() {
    this.screen = 'progress'; this._stats = null; this._editGoals = false;
    this.render();
    try {
      const [ans, goals] = await Promise.all([Sync.fetchMyAnswers(), Sync.getMyGoals()]);
      this._goals = goals || this._goals;
      this._stats = this.computeStats(ans);
    } catch (e) {
      console.error('進捗取得失敗:', e);
      this._stats = { error: String(e.message || e) };
    }
    if (this.screen === 'progress') this.render();
  },

  computeStats(answers) {
    const dayCount = {}, perUnit = {};
    answers.forEach(a => {
      const k = this.dateKey(new Date(a.answered_at));
      dayCount[k] = (dayCount[k] || 0) + 1;
      const u = a.unit || 'その他';
      if (!perUnit[u]) perUnit[u] = { n: 0, c: 0 };
      perUnit[u].n++; if (a.is_correct) perUnit[u].c++;
    });
    const dates = Object.keys(dayCount).sort();
    const total = answers.length;
    const studyDays = dates.length;
    const maxPerDay = dates.reduce((m, k) => Math.max(m, dayCount[k]), 0);
    // 現在の連続日数（今日未実施なら昨日起点）
    let streak = 0; { const d = new Date(); d.setHours(0, 0, 0, 0);
      if (!dayCount[this.dateKey(d)]) d.setDate(d.getDate() - 1);
      while (dayCount[this.dateKey(d)]) { streak++; d.setDate(d.getDate() - 1); } }
    // 最高連続日数
    let maxStreak = 0, run = 0, prev = null;
    dates.forEach(k => {
      const cur = new Date(k + 'T00:00:00');
      run = (prev && (cur - prev) === 86400000) ? run + 1 : 1;
      if (run > maxStreak) maxStreak = run; prev = cur;
    });
    const todayCount = dayCount[this.dateKey(new Date())] || 0;
    // 週（月曜起点）
    const ws = new Date(); ws.setHours(0, 0, 0, 0); ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7));
    const week = []; let weekCount = 0;
    for (let i = 0; i < 7; i++) { const dd = new Date(ws); dd.setDate(ws.getDate() + i);
      const c = dayCount[this.dateKey(dd)] || 0; weekCount += c; week.push({ date: dd, count: c }); }
    // 直近7日（バー用・古→新）
    const last7 = []; for (let i = 6; i >= 0; i--) { const dd = new Date(); dd.setHours(0, 0, 0, 0); dd.setDate(dd.getDate() - i);
      last7.push({ date: dd, count: dayCount[this.dateKey(dd)] || 0 }); }
    return { total, studyDays, maxPerDay, streak, maxStreak, todayCount, weekCount, week, last7, perUnit };
  },

  // SVGドーナツ（中央に数値）
  ring(pct, center, color) {
    const r = 26, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
    return `<svg viewBox="0 0 64 64" class="w-16 h-16">
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="#e9e4d8" stroke-width="6"/>
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 32 32)"/>
      <text x="32" y="37" text-anchor="middle" font-size="16" font-weight="700" fill="#475569">${center}</text></svg>`;
  },

  htmlProgress() {
    const top = `<div class="flex items-center justify-between mb-4 flex-wrap gap-2">${this.countsBar()}${this.navBar()}</div>`;
    if (!this._stats) return top + '<div class="flex items-center justify-center h-48 text-slate-400 text-sm">読み込み中…</div>';
    if (this._stats.error) return top + `<div class="flex items-center justify-center h-48 text-red-600 text-sm text-center px-4">進捗の取得に失敗しました。<br>SQL（phaseE4_elearning.sql / phaseE4b_goals.sql）が未実行の可能性があります。<br><span class="text-xs text-slate-400">${this.esc(this._stats.error)}</span></div>`;
    const s = this._stats, g = this._goals;
    const UNIT_COLORS = { '安全のしおり': '#2563eb', '規程類': '#d97706', 'ベステラスタンダード': '#dc2626', '過去事例': '#7c3aed', 'その他': '#64748b' };

    // 上段カード（今日/今週/連続）
    const card = (val, sub, unit) => `<div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="flex items-end gap-1"><span class="text-3xl font-extrabold text-slate-800">${val}</span>${unit ? `<span class="text-sm text-slate-400 mb-1">${unit}</span>` : ''}</div>
      <div class="text-xs text-slate-500 mt-1">${sub}</div></div>`;
    const cards = `<div class="grid grid-cols-3 gap-3 mb-4">
      ${card(s.todayCount, '今日', `/ ${g.daily_goal}`)}
      ${card(s.weekCount, '今週', `/ ${g.weekly_goal}`)}
      ${card(s.streak, '連続学習日数', '日')}</div>`;

    // 週次達成率＋目標変更
    const wpct = g.weekly_goal ? Math.min(100, Math.round(s.weekCount / g.weekly_goal * 100)) : 0;
    const goalEdit = this._editGoals
      ? `<div class="flex items-center gap-2 flex-wrap">
          <label class="text-xs text-slate-500">今日 <input id="eq-goal-daily" type="number" min="1" value="${g.daily_goal}" class="border rounded w-16 px-2 py-1 text-sm"></label>
          <label class="text-xs text-slate-500">今週 <input id="eq-goal-weekly" type="number" min="1" value="${g.weekly_goal}" class="border rounded w-16 px-2 py-1 text-sm"></label>
          <button data-act="savegoals" class="bg-emerald-600 text-white px-3 py-1 rounded text-sm">保存</button>
          <button data-act="cancelgoals" class="text-slate-500 px-2 py-1 text-sm">取消</button></div>`
      : `<button data-act="editgoals" class="bg-slate-800 text-white px-4 py-1.5 rounded-full text-sm font-medium">目標変更</button>`;
    const weekly = `<div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div class="flex items-center justify-between mb-2"><span class="text-sm font-medium text-slate-600">今週の達成率（${wpct}%）</span>${goalEdit}</div>
      <div class="h-3 rounded-full bg-slate-100 overflow-hidden"><div class="h-full bg-slate-800" style="width:${wpct}%"></div></div>
      <div class="flex justify-between mt-3">${s.week.map((d, i) => {
        const wd = ['月', '火', '水', '木', '金', '土', '日'][i];
        const done = g.daily_goal && d.count >= g.daily_goal;
        const isToday = this.dateKey(d.date) === this.dateKey(new Date());
        const pct = g.daily_goal ? Math.min(100, d.count / g.daily_goal * 100) : (d.count ? 100 : 0);
        const inner = done
          ? `<div class="w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center text-sm">✓</div>`
          : `<div class="w-8 h-8 rounded-full" style="background:conic-gradient(#475569 ${pct * 3.6}deg,#e9e4d8 0)"><div class="w-6 h-6 m-1 rounded-full bg-white"></div></div>`;
        return `<div class="flex flex-col items-center gap-1 ${isToday ? 'font-bold' : ''}">
          <span class="text-[11px] text-slate-400">${wd}</span><span class="text-xs text-slate-600">${d.date.getDate()}</span>${inner}</div>`;
      }).join('')}</div></div>`;

    // 直近7日バー
    const maxC = Math.max(1, ...s.last7.map(x => x.count));
    const bars = s.last7.map(x => {
      const hpx = 8 + Math.round(x.count / maxC * 80);
      return `<div class="flex flex-col items-center justify-end flex-1">
        <div class="text-[10px] text-slate-500 mb-0.5">${x.count || ''}</div>
        <div class="w-5 rounded-t" style="height:${x.count ? hpx : 3}px;background:${x.count ? '#ef6b6b' : '#e9e4d8'}"></div>
        <div class="text-[10px] text-slate-400 mt-1">${x.date.getMonth() + 1}/${x.date.getDate()}</div></div>`;
    }).join('');
    const daily = `<div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div class="text-sm font-medium text-slate-600 mb-3">直近7日の学習量</div>
      <div class="flex items-end gap-2 h-28">${bars}</div></div>`;

    // 通算カード
    const stat = (v, label) => `<div class="bg-white rounded-xl border border-slate-200 p-4 text-center">
      <div class="text-2xl font-extrabold text-slate-800">${v}</div><div class="text-xs text-slate-500 mt-1">${label}</div></div>`;
    const totals = `<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      ${stat(s.total, '通算問題数')}${stat(s.maxStreak, '最高連続学習日数')}${stat(s.studyDays, '通算学習日数')}${stat(s.maxPerDay, '1日の最高問題数')}</div>`;

    // 単元別習得度リング
    const units = this.UNITS.filter(u => s.perUnit[u]);
    const rings = units.length ? `<div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="text-sm font-medium text-slate-600 mb-3">単元別 習得度（正答率）</div>
      <div class="flex flex-wrap gap-5 justify-center">${units.map(u => {
        const p = Math.round(s.perUnit[u].c / s.perUnit[u].n * 100);
        return `<div class="flex flex-col items-center">${this.ring(p, p, UNIT_COLORS[u] || '#64748b')}
          <div class="text-xs text-slate-600 mt-1 text-center max-w-[88px]">${this.esc(u)}</div>
          <div class="text-[10px] text-slate-400">${s.perUnit[u].n}問</div></div>`;
      }).join('')}</div></div>`
      : '<div class="bg-white rounded-xl border border-slate-200 p-4 text-center text-sm text-slate-400">まだ解答がありません。学習を始めましょう。</div>';

    return top + cards + weekly + daily + totals + rings;
  },

  async saveGoals() {
    const d = parseInt(this.val('eq-goal-daily'), 10);
    const w = parseInt(this.val('eq-goal-weekly'), 10);
    if (!(d > 0) || !(w > 0)) { alert('1以上の数値を入力してください'); return; }
    try {
      await Sync.setMyGoals(d, w);
      this._goals = { daily_goal: d, weekly_goal: w };
      this._editGoals = false;
      this.render();
    } catch (e) { alert('目標の保存に失敗しました: ' + (e.message || e)); }
  },

  // ===== 一括インポート（admin・CSV）=====
  _impRows: null,   // 解析済みの取込候補
  _impMsg: '',

  htmlImport() {
    const cols = 'qid, unit, sub, difficulty, question, choice_a, choice_b, choice_c, choice_d, correct, explanation, source, active';
    const preview = this._impRows ? `
      <div class="mt-3 text-sm text-emerald-700">解析OK：<b>${this._impRows.length}</b> 問を取込みます（既存IDは上書き）。</div>
      <div class="mt-2 max-h-48 overflow-auto border rounded text-xs">
        <table class="w-full"><thead class="bg-slate-100"><tr><th class="px-2 py-1 text-left">ID</th><th class="px-2 py-1 text-left">単元</th><th class="px-2 py-1 text-left">問題（冒頭）</th><th class="px-2 py-1">正解</th></tr></thead>
        <tbody>${this._impRows.slice(0, 50).map(r => `<tr class="border-t border-slate-100"><td class="px-2 py-1">${this.esc(r.qid)}</td><td class="px-2 py-1">${this.esc(r.unit)}</td><td class="px-2 py-1">${this.esc((r.question || '').slice(0, 30))}…</td><td class="px-2 py-1 text-center font-bold">${this.esc(r.correct)}</td></tr>`).join('')}</tbody></table>
      </div>` : '';
    return `
    <div class="bg-white rounded-lg shadow p-6 max-w-2xl mx-auto">
      <div class="text-lg font-bold mb-1">問題の一括インポート（CSV）</div>
      <div class="text-xs text-slate-500 mb-4">1行目はヘッダ。列：<code class="bg-slate-100 px-1 rounded">${cols}</code><br>
        active は空/1/true/公開 で公開、0/false/非公開 で非公開。既存IDは上書き（差替）されます。</div>
      <label class="block text-xs text-slate-500 mb-1">CSVファイルを選択</label>
      <input type="file" id="eq-imp-file" accept=".csv,text/csv" class="block w-full text-sm mb-3">
      <label class="block text-xs text-slate-500 mb-1">またはCSVを貼り付け</label>
      <textarea id="eq-imp-text" rows="5" class="border rounded w-full px-2 py-1.5 text-xs font-mono" placeholder="qid,unit,sub,...（ヘッダ行から貼り付け）"></textarea>
      <div id="eq-imp-status" class="text-xs min-h-[16px] mt-2 ${this._impMsg.startsWith('×') ? 'text-red-600' : 'text-slate-500'}">${this.esc(this._impMsg)}</div>
      ${preview}
      <div class="flex gap-3 mt-4">
        <button data-act="imp-parse" class="px-4 py-2 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800">解析プレビュー</button>
        <button data-act="imp-run" ${this._impRows && this._impRows.length ? '' : 'disabled'} class="px-4 py-2 rounded-lg font-bold text-white ${this._impRows && this._impRows.length ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-300 cursor-not-allowed'}">取込実行</button>
        <button data-act="imp-cancel" class="px-4 py-2 rounded-lg font-medium text-slate-700 bg-white border border-slate-300">キャンセル</button>
      </div>
    </div>`;
  },

  // RFC4180 風 CSV パーサ（引用符・カンマ・改行・"" エスケープに対応）
  parseCSV(text) {
    const rows = []; let row = []; let f = ''; let q = false;
    const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f.length || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.length && !(r.length === 1 && r[0].trim() === ''));
  },

  rowsToQuestions(rows) {
    if (!rows.length) throw new Error('データがありません');
    const header = rows[0].map(h => h.trim().toLowerCase());
    const need = ['qid', 'unit', 'question', 'choice_a', 'choice_b', 'choice_c', 'choice_d', 'correct'];
    const miss = need.filter(k => !header.includes(k));
    if (miss.length) throw new Error('必要な列が不足：' + miss.join(', '));
    const idx = {}; header.forEach((h, i) => idx[h] = i);
    const get = (r, k) => (idx[k] != null && r[idx[k]] != null) ? String(r[idx[k]]).trim() : '';
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const qid = get(r, 'qid');
      if (!qid) continue;
      const correct = get(r, 'correct').toUpperCase();
      if (!['A', 'B', 'C', 'D'].includes(correct)) throw new Error(`${qid}: 正解は A/B/C/D（現在 "${correct}"）`);
      const activeRaw = get(r, 'active').toLowerCase();
      const active = !(activeRaw === '0' || activeRaw === 'false' || activeRaw === '非公開' || activeRaw === 'no');
      out.push({
        qid, unit: get(r, 'unit'), sub: get(r, 'sub'), difficulty: get(r, 'difficulty'),
        question: get(r, 'question'), choice_a: get(r, 'choice_a'), choice_b: get(r, 'choice_b'),
        choice_c: get(r, 'choice_c'), choice_d: get(r, 'choice_d'), correct,
        explanation: get(r, 'explanation'), source: get(r, 'source'), active,
      });
    }
    if (!out.length) throw new Error('取込める行がありません');
    return out;
  },

  async impParse() {
    this._impRows = null; this._impMsg = '解析中…';
    const fileInput = document.getElementById('eq-imp-file');
    const text = (document.getElementById('eq-imp-text') || {}).value || '';
    try {
      let raw = text.trim();
      if (!raw && fileInput && fileInput.files && fileInput.files[0]) raw = await fileInput.files[0].text();
      if (!raw) { this._impMsg = '× CSVファイルを選ぶか、貼り付けてください'; return this.render(); }
      this._impRows = this.rowsToQuestions(this.parseCSV(raw));
      this._impMsg = '';
    } catch (e) {
      this._impRows = null; this._impMsg = '× ' + (e.message || e);
    }
    this.render();
  },

  async impRun() {
    if (!this._impRows || !this._impRows.length) return;
    this._impMsg = '取込中…'; this.render();
    try {
      const res = await Sync.bulkUpsertQuizQuestions(this._impRows);
      this._impRows = null; this._impMsg = '';
      this.screen = 'manage';
      await this.refresh();
      alert(`${res.count}問を取込みました。`);
    } catch (e) {
      this._impMsg = '× ' + (e.message || e); this.render();
    }
  },

  // ===== クリック委譲 =====
  onClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'unit') { this.unit = t.dataset.unit; return this.render(); }
    if (act === 'count') { this.n = parseInt(t.dataset.n, 10); return this.render(); }
    if (act === 'start') return this.startSession();
    if (act === 'choose') return this.choose(t.dataset.letter);
    if (act === 'next') return this.next();
    if (act === 'again') return this.startSession();
    if (act === 'pick') { this.screen = 'start'; return this.render(); }
    if (act === 'learn') { this.screen = 'start'; return this.render(); }
    if (act === 'progress') return this.showProgress();
    if (act === 'editgoals') { this._editGoals = true; return this.render(); }
    if (act === 'cancelgoals') { this._editGoals = false; return this.render(); }
    if (act === 'savegoals') return this.saveGoals();
    if (act === 'manage') { if (!this.isAdmin()) return; this.screen = 'manage'; return this.render(); }
    if (act === 'add') { if (!this.isAdmin()) return; this._editing = {}; this.screen = 'edit'; return this.render(); }
    if (act === 'import') { if (!this.isAdmin()) return; this._impRows = null; this._impMsg = ''; this.screen = 'import'; return this.render(); }
    if (act === 'imp-parse') return this.impParse();
    if (act === 'imp-run') return this.impRun();
    if (act === 'imp-cancel') { this._impRows = null; this._impMsg = ''; this.screen = 'manage'; return this.render(); }
    if (act === 'edit') {
      if (!this.isAdmin()) return;
      this._editing = this.allQuestions.find(x => String(x.id) === t.dataset.id) || {};
      this.screen = 'edit'; return this.render();
    }
    if (act === 'cancel') { this._editing = null; this.screen = 'manage'; return this.render(); }
    if (act === 'save') return this.save();
    if (act === 'toggle') return this.toggle(t.dataset.id);
    if (act === 'del') return this.del(t.dataset.id);
  },

  async toggle(id) {
    if (!this.isAdmin()) return;
    const q = this.allQuestions.find(x => String(x.id) === String(id));
    if (!q) return;
    try { await Sync.setQuizActive(q.id, !q.active); await this.refresh(); }
    catch (e) { alert('変更に失敗しました: ' + (e.message || e)); }
  },

  async del(id) {
    if (!this.isAdmin()) return;
    const q = this.allQuestions.find(x => String(x.id) === String(id));
    if (!q) return;
    if (!confirm(`問題「${q.qid}」を削除します。よろしいですか？`)) return;
    try { await Sync.deleteQuizQuestion(q.id); await this.refresh(); }
    catch (e) { alert('削除に失敗しました: ' + (e.message || e)); }
  },
};
