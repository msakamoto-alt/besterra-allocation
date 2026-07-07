/**
 * db.js - Supabase書込: 配置/見込みCRUD・階層/不在/稼働形態・経営レポート・Eラーニング
 *
 * js/sync.js の Sync オブジェクトに責務を追加するモジュール（2026-07 刷新で分割）。
 * メソッド本体は旧 sync.js から無変更で移動。sync.js より後に読み込むこと。
 */
Object.assign(Sync, {
  // 書込エントリポイント（配属期間 override / 見込み案件 / 案件状態 の upsert / delete）。
  // supabase-js で直接書き込む。RLS により書込は authenticated（編集ログイン済み）のみ許可される。
  // ※旧GAS(Apps Script)フォールバックは 2026-07 刷新で削除（Supabase移行済のため）。
  async postOverride(payload) {
    if (!(this.USE_SUPABASE && this.SUPABASE_URL && this.SUPABASE_ANON_KEY)) {
      throw new Error('Supabase 未設定です（config.js を確認）');
    }
    return await this.writeToSupabase(payload);
  },

  // 'P' + 12桁hex（GAS uuidShort 相当・新規 prospect の採番）
  uuidShortProspect() {
    const hex = '0123456789abcdef';
    let s = 'P';
    for (let i = 0; i < 12; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  },

  // GAS doPost の各 action を supabase-js で再現。返り値は { ok:true, action, ... }。
  // エラー時は throw（呼び出し側は従来どおり try/catch でハンドリング）。
  async writeToSupabase(payload) {
    const sb = this.getSupabase();
    const action = payload.action || 'upsert';
    const nowIso = new Date().toISOString();
    const fail = (msg) => { throw new Error(msg); };
    const check = (res) => { if (res && res.error) fail(res.error.message || JSON.stringify(res.error)); return res; };

    if (action === 'upsert') {
      const key = String(payload.override_key || '').trim();
      if (!key) fail('override_key required');
      const row = {
        override_key: key,
        emp_name: payload.emp_name || '',
        emp_no: payload.emp_no || '',   // 社員番号で恒久紐付け（氏名照合のフォールバック先）
        project_id: payload.project_id || '',
        join_date: payload.join_date || '',
        planned_end: payload.planned_end || '',
        prep_start: payload.prep_start || '',  // 準備期間開始日（準備期間 = prep_start〜join_date）
        role: payload.role || '',
        note: payload.note || '',
        updated_at: nowIso,
        updated_by: payload.updated_by || '',
        op: String(payload.op || 'update').trim(),
      };
      check(await sb.from('assignment_overrides').upsert(row, { onConflict: 'override_key' }));
      return { ok: true, action: 'upserted', key };
    }

    if (action === 'delete') {
      const key = String(payload.override_key || '').trim();
      if (!key) fail('override_key required');
      check(await sb.from('assignment_overrides').delete().eq('override_key', key));
      return { ok: true, action: 'deleted', key };
    }

    if (action === 'prospect_upsert') {
      const id = String(payload.prospect_id || '').trim();
      const isNew = !id;
      const pid = isNew ? this.uuidShortProspect() : id;
      const row = {
        prospect_id: pid,
        status: payload.status || '見込み',
        customer: payload.customer || '',
        project_name: payload.project_name || '',
        contract_type: payload.contract_type || '',
        area: payload.area || '',
        managing_dept: payload.managing_dept || '',
        start_date: payload.start_date || '',
        end_date: payload.end_date || '',
        amount: payload.amount || '',
        note: payload.note || '',
        updated_at: nowIso,
        updated_by: payload.updated_by || 'web',
        archived: (payload.archived === true || payload.archived === 'true') ? 'TRUE' : 'FALSE',
      };
      if (isNew) {
        row.created_at = payload.created_at || nowIso;
        check(await sb.from('prospects').insert(row));
        return { ok: true, action: 'inserted', prospect_id: pid };
      }
      // 既存更新：created_at は触らない
      check(await sb.from('prospects').update(row).eq('prospect_id', pid));
      return { ok: true, action: 'updated', prospect_id: pid };
    }

    if (action === 'prospect_delete') {
      const id = String(payload.prospect_id || '').trim();
      if (!id) fail('prospect_id required');
      check(await sb.from('prospects').delete().eq('prospect_id', id));
      return { ok: true, action: 'deleted', prospect_id: id };
    }

    if (action === 'prospect_archive') {
      const id = String(payload.prospect_id || '').trim();
      if (!id) fail('prospect_id required');
      check(await sb.from('prospects').update({
        status: '受注済み',
        updated_at: nowIso,
        updated_by: payload.updated_by || 'web',
        archived: 'TRUE',
      }).eq('prospect_id', id));
      return { ok: true, action: 'archived', prospect_id: id };
    }

    if (action === 'project_status_upsert') {
      const pid = String(payload.project_id || '').trim();
      if (!pid) fail('project_id required');
      const c = payload.completed;
      let completedStr = '';   // '' = 状態は自動（上書きしない）。管轄事務所だけ上書きするケースを許容
      if (c === true || c === 'true' || c === 'TRUE') completedStr = 'TRUE';
      else if (c === false || c === 'false' || c === 'FALSE') completedStr = 'FALSE';
      check(await sb.from('project_status_overrides').upsert({
        project_id: pid,
        completed: completedStr,
        dept: payload.dept || '',   // '' = 管轄事務所は自動（Salesforce元値）
        note: payload.note || '',
        updated_at: nowIso,
        updated_by: payload.updated_by || 'web',
      }, { onConflict: 'project_id' }));
      return { ok: true, action: 'upserted', project_id: pid, completed: completedStr };
    }

    if (action === 'project_status_delete') {
      const pid = String(payload.project_id || '').trim();
      if (!pid) fail('project_id required');
      check(await sb.from('project_status_overrides').delete().eq('project_id', pid));
      return { ok: true, action: 'deleted', project_id: pid };
    }

    throw new Error('unknown_action: ' + action);
  },

  // 編集権限：編集ログイン済み（admin / editor）のみ true
  canEdit() {
    return this.role === 'admin' || this.role === 'editor';
  },

  // tier（監督職/準監督職/広義監督職/対象外）→ 画面が使う category（現場監督/準現場監督/監督サポート/対象外）
  TIER_TO_CATEGORY: {
    '監督職': '現場監督',
    '準監督職': '準現場監督',
    '広義監督職': '監督サポート',
    '対象外': '対象外',
    // 監督リスト表記（category）を直接保存しても通るように識別マップに含める
    '現場監督': '現場監督',
    '準現場監督': '準現場監督',
    '監督サポート': '監督サポート',
  },

  // 稼働形態（work_mode）：tier とは独立した運用状態。空/未設定 = 通常（現場配置可）。
  // ガントでは個人行を背景色＋ラベルで表現し、案件バーは出さない。配色はここで一元管理。
  WORK_MODES: {
    '監督派遣':   { label: '監督派遣（送出）', short: '派遣中（送出）', bg: '#eef1f5', line: '#cbd5e1', text: '#334155', accent: '#64748b', badge: 'bg-slate-200 text-slate-700 border border-slate-400' },
    '事務所専従': { label: '事務所専従',       short: '事務所専従',     bg: '#dbeafe', line: '#93c5fd', text: '#1d4ed8', accent: '#3b82f6', badge: 'bg-blue-100 text-blue-700 border border-blue-300' },
    '構内専従':   { label: '構内専従',         short: '構内専従',       bg: '#dcfce7', line: '#86efac', text: '#15803d', accent: '#22c55e', badge: 'bg-green-100 text-green-700 border border-green-300' },
  },

  // 不在の種別（employee_absences.kind）。監督ダッシュボードのプルダウンとガントのラベルで使用。
  // short = ガント帯の表記語幹（「産育休中 約6か月」のように後ろに「約Nか月」が付く）。
  // ※ 育休・産休は1区分（産休・育休）に統合。旧データ（育休/産休）も帯表記できるよう SHORT に残置。
  ABSENCE_KINDS: ['長期休暇', '休職', '産休・育休', 'その他'],
  ABSENCE_SHORT: { '長期休暇': '長期休暇', '休職': '休職中', '産休・育休': '産育休中', '育休': '育休中', '産休': '産休中', 'その他': '不在' },
  // 通常以外の稼働形態か（''/'通常'/null は false）
  isSpecialWorkMode(mode) {
    const m = String(mode || '').trim();
    return !!(m && m !== '通常' && this.WORK_MODES[m]);
  },

  // 稼働形態を保存（監督ダッシュボードから）。tier 列には触れない（onConflict で work_mode のみ更新）。
  // 空文字 = 通常（NULL に戻す）。
  async setEmployeeWorkMode(empNo, mode, start, end) {
    const sb = this.getSupabase();
    const isSpecial = !!(String(mode || '').trim() && mode !== '通常');
    const slash = (s) => { const v = String(s || '').trim().replace(/-/g, '/'); return v || null; };
    const res = await sb.from('employee_tiers').upsert({
      emp_no: String(empNo).trim(),
      work_mode: isSpecial ? String(mode).trim() : null,
      // 期間は色帯の表示範囲のみ（空＝全期間）。通常に戻したら期間もクリア。
      work_mode_start: isSpecial ? slash(start) : null,
      work_mode_end: isSpecial ? slash(end) : null,
      updated_at: new Date().toISOString(),
      updated_by: 'web',
    }, { onConflict: 'emp_no' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 不在を1件追加（監督ダッシュボードから）。1人が複数期間を持てる別テーブル。
  // start/end は YYYY/MM/DD のテキストに正規化（ガントの parseDate と整合）。
  async addAbsence(empNo, kind, start, end, note) {
    const sb = this.getSupabase();
    const slash = (s) => { const v = String(s || '').trim().replace(/-/g, '/'); return v || null; };
    const res = await sb.from('employee_absences').insert({
      emp_no: String(empNo).trim(),
      kind: String(kind || '').trim(),
      start_date: slash(start),
      end_date: slash(end),
      note: String(note || '').trim() || null,
      updated_at: new Date().toISOString(),
      updated_by: 'web',
    });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 不在を1件更新（id 指定）。種別・期間・メモを上書き。
  async updateAbsence(id, kind, start, end, note) {
    const sb = this.getSupabase();
    const slash = (s) => { const v = String(s || '').trim().replace(/-/g, '/'); return v || null; };
    const res = await sb.from('employee_absences').update({
      kind: String(kind || '').trim(),
      start_date: slash(start),
      end_date: slash(end),
      note: String(note || '').trim() || null,
      updated_at: new Date().toISOString(),
      updated_by: 'web',
    }).eq('id', id);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 不在を1件削除（id 指定）。
  async deleteAbsence(id) {
    const sb = this.getSupabase();
    const res = await sb.from('employee_absences').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 段階D: 階層の手動判定を保存（組織図画面から）。tier は監督リスト表記でよい。
  async setEmployeeTier(empNo, tier) {
    const sb = this.getSupabase();
    const res = await sb.from('employee_tiers').upsert({
      emp_no: String(empNo).trim(),
      tier: tier,
      note: '',
      updated_at: new Date().toISOString(),
      updated_by: 'web',
    }, { onConflict: 'emp_no' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 手動判定を削除して自動判定に戻す
  async clearEmployeeTier(empNo) {
    const sb = this.getSupabase();
    const res = await sb.from('employee_tiers').delete().eq('emp_no', String(empNo).trim());
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // ===== 段階E3: 経営ドッキング（management_reports）=====
  // 経営機密。RLS で SELECT=admin/executive・書込=admin に制限済み（phaseE3_management_reports.sql）。
  // html_content は重い（1本約75KB）ので、一覧はメタのみ取得し、本文は選択時に個別取得する。

  // レポート一覧（メタのみ・html_content を含めない）。admin/executive 以外は RLS で 0 件。
  async listManagementReports() {
    const sb = this.getSupabase();
    const { data, error } = await sb.from('management_reports')
      .select('id, report_type, year_month, title, uploaded_at, uploaded_by')
      .order('year_month', { ascending: false });
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data || [];
  },

  // 指定レポートの HTML 本文を取得（選択時に遅延ロード）。
  async fetchManagementReportHtml(id) {
    const sb = this.getSupabase();
    const { data, error } = await sb.from('management_reports')
      .select('html_content').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message || JSON.stringify(error));
    return (data && data.html_content) || '';
  },

  // レポートのアップロード/差替（admin のみ・(report_type, year_month) で upsert）。
  async upsertManagementReport({ report_type, year_month, title, html_content }) {
    const sb = this.getSupabase();
    const { data: u } = await sb.auth.getUser();
    const email = (u && u.user && u.user.email) || 'admin';
    const res = await sb.from('management_reports').upsert({
      report_type,
      year_month: String(year_month).trim(),
      title: title || null,
      html_content,
      uploaded_at: new Date().toISOString(),
      uploaded_by: email,
    }, { onConflict: 'report_type,year_month' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // レポート削除（admin のみ）。
  async deleteManagementReport(id) {
    const sb = this.getSupabase();
    const res = await sb.from('management_reports').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // ===== 段階E4a: 安全Eラーニング（quiz_questions / quiz_answers）=====
  // 出題は RLS で「公開問題は全員・非公開は admin のみ」。解答ログは本人INSERT・本人/管理職SELECT。

  // 出題一覧。activeOnly=true なら公開問題のみ（学習用）。admin の精査では false で非公開も取得。
  async listQuizQuestions(activeOnly) {
    const sb = this.getSupabase();
    let q = sb.from('quiz_questions')
      .select('id, qid, unit, sub, difficulty, question, choice_a, choice_b, choice_c, choice_d, correct, explanation, source, active')
      .order('qid', { ascending: true });
    if (activeOnly) q = q.eq('active', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data || [];
  },

  // 解答を1件記録（user_id は default auth.uid()・answered_at は default now()）。fire-and-forget 用途。
  async recordQuizAnswer({ question_id, qid, unit, choice, is_correct }) {
    const sb = this.getSupabase();
    const res = await sb.from('quiz_answers').insert({
      question_id: question_id != null ? question_id : null,
      qid: qid || null,
      unit: unit || null,
      choice: choice || null,
      is_correct: !!is_correct,
    });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 自分の学習カウント（今日 / 通算 の解答数）。ヘッダ表示用の軽量集計。
  async myQuizCounts() {
    const sb = this.getSupabase();
    const uid = this.userId;
    if (!uid) return { today: 0, total: 0 };
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const total = await sb.from('quiz_answers').select('id', { count: 'exact', head: true }).eq('user_id', uid);
    const today = await sb.from('quiz_answers').select('id', { count: 'exact', head: true })
      .eq('user_id', uid).gte('answered_at', start.toISOString());
    return { today: today.count || 0, total: total.count || 0 };
  },

  // 自分の解答ログ（進捗集計用）。直近 limit 件（既定3000）を新しい順で取得。
  async fetchMyAnswers(limit) {
    const sb = this.getSupabase();
    const uid = this.userId;
    if (!uid) return [];
    const { data, error } = await sb.from('quiz_answers')
      .select('unit, is_correct, answered_at')
      .eq('user_id', uid)
      .order('answered_at', { ascending: false })
      .limit(limit || 3000);
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data || [];
  },

  // 学習目標（今日/今週のノルマ）。未設定は既定値。
  async getMyGoals() {
    const sb = this.getSupabase();
    const uid = this.userId;
    if (!uid) return { daily_goal: 10, weekly_goal: 70 };
    const { data, error } = await sb.from('learning_goals')
      .select('daily_goal, weekly_goal').eq('user_id', uid).maybeSingle();
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data || { daily_goal: 10, weekly_goal: 70 };
  },

  async setMyGoals(daily_goal, weekly_goal) {
    const sb = this.getSupabase();
    const res = await sb.from('learning_goals').upsert(
      { daily_goal, weekly_goal, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // ----- 出題管理（admin のみ・RLSで強制）-----
  async upsertQuizQuestion(q) {
    const sb = this.getSupabase();
    const row = {
      qid: String(q.qid || '').trim(),
      unit: q.unit, sub: q.sub || null, difficulty: q.difficulty || null,
      question: q.question, choice_a: q.choice_a, choice_b: q.choice_b,
      choice_c: q.choice_c, choice_d: q.choice_d, correct: q.correct,
      explanation: q.explanation || null, source: q.source || null,
      active: q.active !== false, updated_at: new Date().toISOString(),
    };
    const res = await sb.from('quiz_questions').upsert(row, { onConflict: 'qid' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 一括 upsert（CSVインポート用・admin のみ）。rows は upsertQuizQuestion と同じ形の配列。
  async bulkUpsertQuizQuestions(rows) {
    const sb = this.getSupabase();
    const now = new Date().toISOString();
    const payload = rows.map(q => ({
      qid: String(q.qid || '').trim(),
      unit: q.unit, sub: q.sub || null, difficulty: q.difficulty || null,
      question: q.question, choice_a: q.choice_a, choice_b: q.choice_b,
      choice_c: q.choice_c, choice_d: q.choice_d, correct: q.correct,
      explanation: q.explanation || null, source: q.source || null,
      active: q.active !== false, updated_at: now,
    }));
    const res = await sb.from('quiz_questions').upsert(payload, { onConflict: 'qid' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true, count: payload.length };
  },

  async setQuizActive(id, active) {
    const sb = this.getSupabase();
    const res = await sb.from('quiz_questions').update({ active: !!active, updated_at: new Date().toISOString() }).eq('id', id);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  async deleteQuizQuestion(id) {
    const sb = this.getSupabase();
    const res = await sb.from('quiz_questions').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },
});
