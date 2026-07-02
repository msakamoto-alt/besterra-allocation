/**
 * audit.js - 監査ログ（編集履歴）ビュー（admin専用）
 *
 * 記録はDBトリガー（supabase/add_audit_logs.sql）が自動で行う。
 * ここは閲覧のみ：ヘッダーの「監査ログ」ボタン → モーダルで新しい順に表示。
 * フィルタ（対象・操作）・さらに読み込む（100件ずつ）・CSVダウンロード。
 */
const AuditView = {
  PAGE: 100,

  // テーブル名 → 画面上の呼び名
  TABLE_LABELS: {
    assignment_overrides:     '配置（現場人員配置）',
    prospects:                '見込み案件',
    project_status_overrides: '案件の修正',
    employee_tiers:           '階層・稼働形態',
    employee_absences:        '不在予定',
    management_reports:       '経営レポート',
    quiz_questions:           '安全学習の問題',
    learning_goals:           '学習目標',
  },

  OP_LABELS: { INSERT: '登録', UPDATE: '更新', DELETE: '削除' },
  OP_BADGE: {
    INSERT: 'bg-emerald-100 text-emerald-800',
    UPDATE: 'bg-blue-100 text-blue-800',
    DELETE: 'bg-red-100 text-red-800',
  },

  // 主要列 → 日本語ラベル（未定義の列は英語名のまま表示）
  COL_LABELS: {
    emp_name: '氏名', emp_no: '社員番号', project_id: '工事番号', role: '役割',
    join_date: '開始日', planned_end: '終了日', prep_start: '準備開始', op: '操作区分',
    override_key: 'キー',
    status: 'ステータス', customer: '客先', project_name: '工事名', contract_type: '請負区分',
    area: 'エリア', managing_dept: '管轄事務所', start_date: '開始日', end_date: '終了日',
    amount: '見積金額', note: '備考', archived: 'アーカイブ', supervisors: '担当監督',
    prospect_id: '見込みID', sf_project_id: 'SF工事番号',
    completed: '完成扱い', dept: '管轄事務所',
    tier: '階層', work_mode: '稼働形態', work_mode_start: '稼働形態 開始', work_mode_end: '稼働形態 終了',
    kind: '種別',
    report_type: '種類', year_month: '対象年月', title: 'タイトル', html_content: '本文HTML',
    uploaded_by: '操作者', qid: '問題ID', unit: '単元', sub: '中分類', difficulty: '難易度',
    question: '問題文', choice_a: '選択肢A', choice_b: '選択肢B', choice_c: '選択肢C', choice_d: '選択肢D',
    correct: '正答', explanation: '解説', source: '出典', active: '公開',
    daily_goal: '1日の目標', weekly_goal: '週の目標',
    updated_by: '操作者', user_id: 'ユーザーID', id: 'ID',
  },

  rows: [],          // 表示中の全行（追加読込で末尾に足す）
  oldestId: null,    // 追加読込のカーソル
  reachedEnd: false,
  loading: false,

  init() {
    const close = document.getElementById('audit-modal-close');
    if (close) close.addEventListener('click', () => this.close());
    const modal = document.getElementById('audit-modal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) this.close(); });
    const ft = document.getElementById('audit-filter-table');
    if (ft) ft.addEventListener('change', () => this.reload());
    const fo = document.getElementById('audit-filter-op');
    if (fo) fo.addEventListener('change', () => this.reload());
    const more = document.getElementById('audit-load-more');
    if (more) more.addEventListener('click', () => this.loadMore());
    const csv = document.getElementById('audit-csv');
    if (csv) csv.addEventListener('click', () => this.downloadCsv());
  },

  async open() {
    document.getElementById('audit-modal').classList.remove('hidden');
    await this.reload();
  },
  close() { document.getElementById('audit-modal').classList.add('hidden'); },

  async reload() {
    this.rows = []; this.oldestId = null; this.reachedEnd = false;
    this.render();
    await this.loadMore();
  },

  async loadMore() {
    if (this.loading || this.reachedEnd) return;
    this.loading = true;
    this.setStatus('読み込み中…');
    try {
      const table = (document.getElementById('audit-filter-table') || {}).value || '';
      const op = (document.getElementById('audit-filter-op') || {}).value || '';
      const batch = await Sync.fetchAuditLogs({ table, op, beforeId: this.oldestId, limit: this.PAGE });
      this.rows = this.rows.concat(batch);
      if (batch.length) this.oldestId = batch[batch.length - 1].id;
      if (batch.length < this.PAGE) this.reachedEnd = true;
      this.render();
      this.setStatus(this.rows.length
        ? `${this.rows.length}件表示${this.reachedEnd ? '（すべて）' : ''}`
        : 'ログはまだありません（記録は add_audit_logs.sql 実行後の編集から始まります）');
    } catch (err) {
      const msg = String(err.message || err);
      // テーブル未作成（SQL未実行）を分かりやすく案内
      this.setStatus(/audit_logs/.test(msg) && /not exist|find the table|schema cache/i.test(msg)
        ? '監査ログのテーブルがまだありません。Supabase SQL Editor で supabase/add_audit_logs.sql を実行してください。'
        : '読み込みエラー: ' + msg);
    } finally {
      this.loading = false;
      const more = document.getElementById('audit-load-more');
      if (more) more.classList.toggle('hidden', this.reachedEnd);
    }
  },

  setStatus(msg) {
    const el = document.getElementById('audit-status');
    if (el) el.textContent = msg || '';
  },

  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },

  fmtAt(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return String(iso || '');
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // 操作者：メール→SmartHR名簿(organization)一致で氏名を補足表示
  userLabel(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return '（不明）';
    const org = (Sync.cache.organization || []).find(o => String(o.email || '').trim().toLowerCase() === e);
    return org && org.name ? `${org.name}（${email}）` : String(email);
  },

  colLabel(k) { return this.COL_LABELS[k] || k; },

  // changes {列:{old,new}} → 1行ずつ「列: 旧 → 新」
  changesHtml(op, changes) {
    if (!changes || typeof changes !== 'object') return '';
    const items = Object.keys(changes).map(k => {
      const c = changes[k] || {};
      const label = `<span class="text-slate-500">${this.esc(this.colLabel(k))}:</span>`;
      if (op === 'UPDATE') {
        return `<div>${label} <span class="line-through text-slate-400">${this.esc(c.old)}</span> → <span class="font-medium">${this.esc(c.new)}</span></div>`;
      }
      return `<div>${label} <span class="font-medium">${this.esc(op === 'DELETE' ? c.old : c.new)}</span></div>`;
    });
    return items.join('');
  },

  render() {
    const body = document.getElementById('audit-table-body');
    if (!body) return;
    body.innerHTML = this.rows.map(r => `
      <tr class="border-b border-slate-100 align-top">
        <td class="px-3 py-2 whitespace-nowrap text-slate-600">${this.esc(this.fmtAt(r.at))}</td>
        <td class="px-3 py-2 whitespace-nowrap">${this.esc(this.userLabel(r.user_email))}</td>
        <td class="px-3 py-2 whitespace-nowrap">${this.esc(this.TABLE_LABELS[r.table_name] || r.table_name)}</td>
        <td class="px-3 py-2 whitespace-nowrap text-center"><span class="px-2 py-0.5 rounded text-xs font-semibold ${this.OP_BADGE[r.op] || 'bg-slate-100 text-slate-700'}">${this.esc(this.OP_LABELS[r.op] || r.op)}</span></td>
        <td class="px-3 py-2 whitespace-nowrap">${this.esc(r.row_key || '')}</td>
        <td class="px-3 py-2 text-xs leading-relaxed">${this.changesHtml(r.op, r.changes)}</td>
      </tr>`).join('');
  },

  // 表示中の行をCSVで保存（Excelで開けるようBOM付きUTF-8）
  downloadCsv() {
    if (!this.rows.length) return;
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const changesText = (op, changes) => Object.keys(changes || {}).map(k => {
      const c = changes[k] || {};
      return op === 'UPDATE'
        ? `${this.colLabel(k)}: ${c.old ?? ''} → ${c.new ?? ''}`
        : `${this.colLabel(k)}: ${(op === 'DELETE' ? c.old : c.new) ?? ''}`;
    }).join(' / ');
    const lines = [['日時', '操作者', '対象', '操作', '対象キー', '変更内容'].map(q).join(',')];
    this.rows.forEach(r => {
      lines.push([
        this.fmtAt(r.at), this.userLabel(r.user_email),
        this.TABLE_LABELS[r.table_name] || r.table_name,
        this.OP_LABELS[r.op] || r.op, r.row_key || '',
        changesText(r.op, r.changes),
      ].map(q).join(','));
    });
    // 先頭BOM＝Excelで文字化けさせないため（不可視文字を避け fromCharCode で明示）
    const bom = String.fromCharCode(0xFEFF);
    const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date(), p = n => String(n).padStart(2, '0');
    a.download = `監査ログ_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
};
