/**
 * sheets.js - Sheets取込（管理者「同期」ボタン）: gviz CSV取得・SmartHR名簿整形・参照系テーブルの全置換
 *
 * js/sync.js の Sync オブジェクトに責務を追加するモジュール（2026-07 刷新で分割）。
 * メソッド本体は旧 sync.js から無変更で移動。sync.js より後に読み込むこと。
 */
Object.assign(Sync, {
  // シート名の候補。テンプレ命名 と Box CSV ファイル名（数字接頭辞）の両方を試す
  SHEET_CANDIDATES: {
    employees: ['employees', '01_employees'],
    departments: ['departments', '02_departments'],
    qualifications: ['qualifications', '05_qualifications'],
    employee_qualifications: ['employee_qualifications', '06_employee_qualifications'],
    salesforce_imports: ['salesforce_imports', '09_salesforce_imports'],
    prospects: ['prospects', '11_prospects'],
    assignment_overrides: ['assignment_overrides', '12_assignment_overrides'],
    g_work_logs: ['g_work_logs', '07_G_work_logs', '07_g_work_logs'],
    project_status_overrides: ['project_status_overrides', '13_project_status_overrides'],
  },

  // 各シートの形式バリデータ（先頭行で判定）
  SHEET_VALIDATORS: {
    employees: txt => /employee_id|社員番号|名前/i.test((txt || '').split('\n')[0] || ''),
    departments: txt => /department_id|department_name|事務所|部署/i.test((txt || '').split('\n')[0] || ''),
    // 厳密化：employees と被らないよう qualification_id 必須
    qualifications: txt => {
      const head = (txt || '').split('\n')[0] || '';
      return /qualification_id/i.test(head);
    },
    employee_qualifications: txt => {
      const head = (txt || '').split('\n')[0] || '';
      // emp_id × qual_id の組み合わせを必須（社員リスト誤認を防ぐ）
      return /qualification_id|qual_id/i.test(head) && /emp_id|社員番号/i.test(head);
    },
    salesforce_imports: txt => /工事部員|工事番号|人事配置一覧|現場管理表/i.test((txt || '').split('\n')[0] || ''),
    prospects: txt => /prospect_id|project_name|customer|見込み/i.test((txt || '').split('\n')[0] || ''),
    assignment_overrides: txt => /override_key|emp_name|project_id/i.test((txt || '').split('\n')[0] || ''),
    g_work_logs: txt => /社員コード|プロジェクトコード|作業時間|emp_id|hours/i.test((txt || '').split('\n')[0] || ''),
    project_status_overrides: txt => {
      const head = (txt || '').split('\n')[0] || '';
      // project_id ＋ completed の組み合わせを必須（他のシート誤認防止）
      return /project_id/i.test(head) && /completed/i.test(head);
    },
  },

  csvUrl(sheetName) {
    if (!this.SHEET_ID) throw new Error('SHEET_ID 未設定');
    return `https://docs.google.com/spreadsheets/d/${this.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  },

  async fetchSheetRaw(sheetName) {
    const response = await fetch(this.csvUrl(sheetName));
    if (!response.ok) throw new Error(`Sheet取得失敗: ${sheetName} (${response.status})`);
    return await response.text();
  },

  // 候補リストから「正しい形式」のシートを順次試す
  async fetchSheetWithValidation(key) {
    const candidates = this.SHEET_CANDIDATES[key] || [key];
    const validator = this.SHEET_VALIDATORS[key];
    for (const sheet of candidates) {
      try {
        const text = await this.fetchSheetRaw(sheet);
        if (!validator || validator(text)) {
          console.info(`シート ${key}: '${sheet}' から取得`);
          return text;
        } else {
          console.warn(`シート '${sheet}' は ${key} の形式ではないためスキップ`);
        }
      } catch (e) {
        // 次の候補を試す
      }
    }
    console.warn(`シート ${key} は全候補でフェッチ失敗`);
    return null;
  },

  // employees シートを両形式（仕様書テンプレ / Phase0ベース）に対応して正規化
  // 区分は新表記（現場監督 / 準現場監督 / 監督サポート / 対象外）に統一
  normalizeCategoryName(c) {
    const s = String(c || '').trim();
    if (!s) return '対象外';
    // 旧表記 → 新表記
    if (s === '監督職' || s === '現場監督') return '現場監督';
    if (s === '準監督職' || s === '準現場監督' || s.includes('準')) return '準現場監督';
    if (s === '広義監督職' || s === '監督サポート') return '監督サポート';
    return s;  // 「対象外」やその他はそのまま
  },

  normalizeEmployees(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const first = raw[0];

    // 仕様書テンプレート形式（employee_id, name, department_id, category 等）
    if (Object.prototype.hasOwnProperty.call(first, 'employee_id')) {
      return raw.map(r => ({
        id: parseInt(r.employee_id, 10) || r.employee_id,
        name: String(r.name || '').trim(),
        department: r.department || r.department_id || '',
        role: r.role_title || '',
        role_title: r.role_title || '',
        category: this.normalizeCategoryName(r.category),
        status: r.status || 'active',
        rank: r.rank_code || '',
      })).filter(e => e.id && e.name);
    }

    // Phase 0 ベース形式（No, 社員番号, 名前, 部門, 役職, 資格, 区分, 中計, 所属（最終判定））
    if (Object.prototype.hasOwnProperty.call(first, '社員番号') || Object.prototype.hasOwnProperty.call(first, '名前')) {
      return raw.map(r => {
        const kubun = String(r['区分'] || '').trim();
        const chukei = String(r['中計'] || '').trim();
        const inChukei = chukei.includes('〇') || chukei.includes('○') || chukei === '◯';
        let category;
        if (inChukei) {
          if (kubun.includes('準') || kubun.includes('準監督')) category = '準現場監督';
          else if (kubun === '監督職') category = '現場監督';
          else category = '監督サポート';
        } else {
          // 中計外でも区分から判定（フェイルセーフ）
          if (kubun.includes('準')) category = '準現場監督';
          else if (kubun === '監督職') category = '現場監督';
          else category = '対象外';
        }
        return {
          id: parseInt(r['社員番号'], 10) || r['社員番号'],
          name: String(r['名前'] || '').trim(),
          department: String(r['所属（最終判定）'] || r['部門'] || '').trim(),
          role: String(r['役職'] || '').trim(),
          role_title: String(r['役職'] || '').trim(),
          qualifications_raw: String(r['資格'] || '').trim(),  // F列（複数資格はカンマ・改行・スペースで区切り想定）
          category,
          status: 'active',
          rank: '',
        };
      }).filter(e => e.id && e.name);
    }

    // どちらでもなければ生データのまま返す
    return raw;
  },

  // 参照系テーブル（Sheetsで編集する3つ）の列ホワイトリスト。
  // 余分な空ヘッダ列やサロゲートid を除外し、これらの列だけ投入する。
  REFERENCE_COLUMNS: {
    employees: ['No', '社員番号', '名前', '部門', '役職', '資格', '区分', '中計', '所属（最終判定）', 'オーバーライド理由', 'ユーザーチェック'],
    g_work_logs: ['社員コード', '社員名', '日付', '勤務時間差異', 'プロジェクトコード', 'プロジェクト名', '作業時間', '備考'],
    salesforce_imports: ['department', 'emp_name', 'emp_name_raw', 'role', 'role_detail', 'contract_type', 'project_id', 'project_name', 'start', 'end', 'total_revenue', 'order_amount', 'status'],
    // 段階D: SmartHR名簿(01_organization)の整形後スキーマ
    organization: ['emp_no', 'last_name', 'first_name', 'kana_last', 'kana_first', 'email', 'business', 'hire_date', 'depts', 'positions'],
    // 段階Q: 資格マスタ(02_employees タブ＝SmartHR「従業員の資格一覧」エクスポートを貼付)。
    //   1行=1人×1資格。必要6列のみ取込（部署/点数/資格番号/証明書の写し等は無視）。
    employee_quals: ['社員番号', '氏名', 'コード', '保有資格', '取得日', '有効期限'],
  },

  // 段階D: SmartHR名簿(01_organization)の生行 → organization テーブル形式に整形。
  // 部署1..10／役職1..10 の非空セルを配列にまとめる（兼任=部署が複数）。
  parseOrganizationRows(rawRows) {
    return rawRows.map(r => {
      const depts = [];
      const positions = [];
      for (let i = 1; i <= 10; i++) {
        const d = String(r[`部署${i} 部署`] || '').trim();
        if (d) depts.push(d);
        const p = String(r[`役職${i} 役職`] || '').trim();
        if (p) positions.push(p);
      }
      return {
        emp_no: String(r['社員番号'] || '').trim(),
        // SmartHR名簿の列名変更に後方互換で対応：新「ビジネスネーム：姓/名」→旧「姓/名」の順にフォールバック。
        // どちらか一方でも来れば氏名が埋まる（列名変更で組織図が氏名空になり全消えする事故を防ぐ）。
        last_name: String(r['ビジネスネーム：姓'] || r['姓'] || '').trim(),
        first_name: String(r['ビジネスネーム：名'] || r['名'] || '').trim(),
        kana_last: String(r['ビジネスネーム：姓（ヨミガナ）'] || r['姓（ヨミガナ）'] || '').trim(),
        kana_first: String(r['ビジネスネーム：名（ヨミガナ）'] || r['名（ヨミガナ）'] || '').trim(),
        email: String(r['メールアドレス'] || '').trim(),
        business: String(r['業務内容'] || '').trim(),
        hire_date: String(r['入社年月日'] || '').trim(),
        depts: [...new Set(depts)],          // 部署の重複登録を除去
        positions: [...new Set(positions)],
      };
    }).filter(r => r.emp_no);
  },

  // 段階C/D/D5: Sheets→Supabase 参照系テーブルの同期（編集者のみ・「同期」ボタンから呼ばれる）。
  // 同期対象：g_work_logs（勤怠貼付）・salesforce_imports（SF貼付）・organization（01_organization 名簿）・
  //           employee_quals（02_employees 資格）。編集の正は Google Sheets。運用系には一切触れない。
  // ※ 旧 employees(01_employees) は段階D5で廃止し、同期対象から除外。
  async syncReferenceFromSheets() {
    // Sheets から取得（既存の gviz 経路を再利用）
    const [gwTxt, sfTxt] = await Promise.all([
      this.fetchSheetWithValidation('g_work_logs'),
      this.fetchSheetWithValidation('salesforce_imports'),
    ]);
    // 段階D: 組織図名簿（01_organization）／段階D5: 資格マスタ（02_employees）を直接取得
    let orgTxt = null, qualTxt = null;
    try { orgTxt = await this.fetchSheetRaw('01_organization'); } catch (e) { /* タブ未作成は許容 */ }
    try { qualTxt = await this.fetchSheetRaw('02_employees'); } catch (e) { /* タブ未作成は許容 */ }

    const gwRows = gwTxt ? this.parseCSV(gwTxt).filter(r => String(r['社員コード'] || '').trim()) : [];
    const sfRows = sfTxt ? this.parseSalesforceCsv(sfTxt) : [];
    const orgRows = orgTxt ? this.parseOrganizationRows(this.parseCSV(orgTxt)) : [];
    const qualRows = qualTxt ? this.parseCSV(qualTxt).filter(r => String(r['社員番号'] || '').trim()) : [];

    // 0件のテーブルは取得失敗の可能性があるので置換しない（誤って空にしない安全策）
    // ※ 段階D5: 旧 employees(01_employees) は廃止につき同期しない。資格は 02_employees→employee_quals へ。
    if (gwRows.length) await this._replaceSupabaseTable('g_work_logs', gwRows);
    if (sfRows.length) await this._replaceSupabaseTable('salesforce_imports', sfRows);
    if (orgRows.length) await this._replaceSupabaseTable('organization', orgRows);
    if (qualRows.length) await this._replaceSupabaseTable('employee_quals', qualRows);

    return { g_work_logs: gwRows.length, salesforce_imports: sfRows.length, organization: orgRows.length, employee_quals: qualRows.length };
  },

  // 参照系テーブルを全置換。書込は authenticated（編集者）のみRLSで許可。
  // 安全策：「先に新規投入 → 成功後に旧行を削除」の順。
  //   - 投入が失敗しても旧データは残る（空にならない）
  //   - 旧行削除が失敗しても重複が残るだけ（再同期で回復）＝データ消失は起きない
  // サロゲートidは常に増加するため、投入前の最大idを基準に旧行を特定できる。
  async _replaceSupabaseTable(table, rows) {
    const sb = this.getSupabase();
    const cols = this.REFERENCE_COLUMNS[table];
    const clean = rows.map(r => {
      const o = {};
      cols.forEach(c => { o[c] = (r[c] !== undefined ? r[c] : null); });
      return o;
    });
    // 1. 投入前の最大id（新規行はこれより大きいidになる）
    const maxRes = await sb.from(table).select('id').order('id', { ascending: false }).limit(1);
    if (maxRes.error) throw new Error(`${table} 既存id取得失敗: ${maxRes.error.message}`);
    const maxOldId = (maxRes.data && maxRes.data.length) ? maxRes.data[0].id : 0;
    // 2. 新規行を投入（旧行と一時共存・失敗時は旧データが残る）
    const batch = 500;
    for (let i = 0; i < clean.length; i += batch) {
      const ins = await sb.from(table).insert(clean.slice(i, i + batch));
      if (ins.error) throw new Error(`${table} 投入失敗(${i}行目付近): ${ins.error.message}`);
    }
    // 3. 旧行を削除（投入成功後。失敗しても重複が残るだけで消失はしない）
    const del = await sb.from(table).delete().lte('id', maxOldId);
    if (del.error) throw new Error(`${table} 旧行削除失敗: ${del.error.message}（重複が残った可能性。もう一度同期してください）`);
  },
});
