/**
 * derive.js - 派生・変換: 資格導出・projects/assignments派生・G工番集計・組織図社員生成・processRawTables
 *
 * js/sync.js の Sync オブジェクトに責務を追加するモジュール（2026-07 刷新で分割）。
 * メソッド本体は旧 sync.js から無変更で移動。sync.js より後に読み込むこと。
 */
Object.assign(Sync, {
  // employees の F列「資格」フィールドから資格マスタと employee_qualifications を派生
  // 複数資格はカンマ/読点/改行/スペース/スラッシュで区切り
  // 既存マスタに無い資格名は自動的にマスタへ追加（社内認定種別として）
  deriveQualificationsFromEmployees(employees, existingQuals, existingEqs) {
    const quals = (existingQuals || []).slice();
    const qualsByName = {};
    quals.forEach(q => { qualsByName[String(q.name || '').trim()] = q; });

    const eqs = (existingEqs || []).slice();
    const existingKeys = new Set(eqs.map(eq => `${eq.emp_id}|${eq.qual_id}`));

    (employees || []).forEach(e => {
      const raw = String(e.qualifications_raw || '').trim();
      if (!raw) return;
      // 区切り文字：カンマ/読点/改行/スラッシュ/中黒・全角空白
      const names = raw.split(/[,、，\n\r\/／・　]+/).map(s => s.trim()).filter(Boolean);
      names.forEach(name => {
        // マスタに無ければ追加（自動採番：QE-001, QE-002,...）
        let q = qualsByName[name];
        if (!q) {
          const id = `QE-${String(quals.length + 1).padStart(3, '0')}`;
          q = { id, name, type: '社内登録' };
          quals.push(q);
          qualsByName[name] = q;
        }
        const key = `${e.id}|${q.id}`;
        if (!existingKeys.has(key)) {
          eqs.push({
            emp_id: e.id,
            qual_id: q.id,
            acquired: null,
            expiry: null,
            source: 'employees_F',
          });
          existingKeys.add(key);
        }
      });
    });
    return { qualifications: quals, employee_qualifications: eqs };
  },

  // 段階Q: 資格名を正規化（全角→半角：１級→1級／一級・二級→1級・2級）
  _normQual(s) {
    let t = String(s || '');
    try { t = t.normalize('NFKC'); } catch (e) { /* noop */ }
    return t.replace(/一級/g, '1級').replace(/二級/g, '2級');
  },

  // 実務経験で施工管理技士の要件を満たす監督の補完（SmartHRに証書データが無いケース）。
  //   キー=社員番号（同姓回避のため番号で指定）／値=deriveSekouTags が解釈できる資格名。
  //   ここに足すと qualifications_raw 経由で資格軸ガント・ダッシュボードのバッジ両方に反映される。
  EXPERIENCE_SEKOU: {
    '2007': '1級施工管理技士',  // 竹内信広：実務経験で1級施工管理技士の要件を満たす
  },

  // 段階Q: 保有資格名の配列から「1級/2級 施工管理技士」タグを導出。
  //   建築/土木/電気/管/造園 等の細分は畳む。技士「補」は下位資格のため除外。
  //   1級2級を両方保有する場合は上位（1級）のみ（資格軸ガントで二重表示しない）。
  //   このタグが資格軸ガント・バッジの唯一のソース（qualifications_raw に格納）。
  deriveSekouTags(names) {
    let has1 = false, has2 = false;
    (names || []).forEach(nm => {
      const n = this._normQual(nm);
      if (n.includes('施工管理技士') && !n.includes('補')) {
        if (n.includes('1級')) has1 = true;
        else if (n.includes('2級')) has2 = true;
      }
    });
    if (has1) return ['1級 施工管理技士'];
    if (has2) return ['2級 施工管理技士'];
    return [];
  },

  // 段階Q: 表示自体を除外する資格（個人系・業務管理外）。部分一致。
  QUAL_HIDDEN: ['運転免許'],
  isQualHidden(name) {
    const n = String(name || '');
    return this.QUAL_HIDDEN.some(k => n.includes(k));
  },

  // 段階Q: 期限アラートを出す対象資格（技術者・登録系の更新制資格のみ）。部分一致。
  //   ここに無い資格は詳細に期限日付を表示するだけでアラート（赤/橙/黄・件数）にしない。
  //   職長・安全衛生責任者教育（再教育推奨・法的失効なし）等はあえて対象外。編集容易。
  QUAL_EXPIRY_TRACK: [
    '監理技術者資格者証', '監理技術者講習', '解体工事施工技士',
    '建設キャリアアップ', '登録解体基幹技能者',
    '舗装施工管理技術者', '舗装診断士', 'コンクリート診断士', 'コンクリート技士',
    '非破壊試験', '宅地建物取引士', '可搬形発電設備専門技術者', '無人航空機操縦士',
    '溶接管理技術者',
  ],
  isExpiryTracked(name) {
    const n = String(name || '');
    return this.QUAL_EXPIRY_TRACK.some(k => n.includes(k));
  },

  // 段階Q: 有効期限の状態判定。戻り値 {status, days, label}。
  //   status: none(期限なし) / expired / warn30 / warn90 / ok / unknown
  qualExpiryStatus(expiry) {
    const e = String(expiry || '').trim();
    if (e === '' || e === '期限なし' || e === '無期限') return { status: 'none', days: null, label: '期限なし' };
    const m = e.replace(/-/g, '/').split('/');
    if (m.length !== 3) return { status: 'unknown', days: null, label: e };
    const dt = new Date(+m[0], +m[1] - 1, +m[2]);
    if (isNaN(dt.getTime())) return { status: 'unknown', days: null, label: e };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((dt - today) / 86400000);
    if (days < 0) return { status: 'expired', days, label: `期限切れ（${-days}日経過）` };
    if (days <= 30) return { status: 'warn30', days, label: `残${days}日` };
    if (days <= 90) return { status: 'warn90', days, label: `残${days}日` };
    return { status: 'ok', days, label: `残${days}日` };
  },

  // 見込み案件（prospects v2）から projects を派生
  // v2スキーマ: prospect_id, status, customer, project_name, contract_type, area,
  //             managing_dept, start_date, end_date, amount, note, archived
  // 担当監督は今回スコープ外（assignments は生成しない）
  // archived=TRUE の行は除外
  deriveFromProspects(prospectRows, employees) {
    const projects = [];
    prospectRows.forEach(r => {
      // アーカイブ済みはスキップ
      const arch = String(r.archived || '').trim().toUpperCase();
      if (arch === 'TRUE' || arch === '1' || arch === 'YES') return;

      const pid = String(r.prospect_id || '').trim();
      if (!pid) return;
      const projName = String(r.project_name || '').trim();
      if (!projName) return;  // 工事名なしは表示価値なし

      projects.push({
        project_id: pid,
        name: projName,
        customer: r.customer || '',
        start: this.normalizeDate(r.start_date),
        end: this.normalizeDate(r.end_date),
        amount: this.parseAmount(r.amount),
        kind: '見込み',
        dept: r.managing_dept || '',
        area: r.area || '',
        contract_type: r.contract_type || '',
        status: r.status || '見込み',
        note: r.note || '',
        prospect: true,
        completed: false,
      });
    });

    return { projects, assignments: [] };
  },

  // Salesforceデータから projects と assignments を派生
  // 完成工事は projects.completed=true でフラグ付与（表示制御はビュー側）
  // 工事番号が空の行はスキップ（parseSalesforceCsv 段階で既に対応）
  deriveFromSalesforce(sfRows, employees) {
    const projectsMap = {};
    const assignments = [];

    // 氏名インデックス
    const empByName = {};
    (employees || []).forEach(e => {
      const key = this.normEmpKey(e.name);
      if (key) empByName[key] = e;
    });

    let asgIdSeq = 1;
    sfRows.forEach(r => {
      const completed = this.isCompletedProject(r.status, r.end);

      if (!projectsMap[r.project_id]) {
        const deptParts = String(r.department || '').split('/');
        const deptShort = deptParts[deptParts.length - 1] || r.department;
        projectsMap[r.project_id] = {
          project_id: r.project_id,
          name: r.project_name,
          customer: '',
          start: r.start,
          end: r.end,
          amount: this.parseAmount(r.order_amount || r.total_revenue),  // 売上規模＝受注金額を優先（空なら総売上で補完。総売上はJPY0が多いため）
          kind: '工事',
          dept: deptShort,
          contract_type: r.contract_type || '',
          status: r.status,
          completed,
        };
      }

      const empKey = this.normEmpKey(r.emp_name);
      const emp = empByName[empKey];
      assignments.push({
        assignment_id: asgIdSeq++,
        emp_id: emp ? emp.id : null,
        emp_name: r.emp_name,
        project_id: r.project_id,
        project_name: r.project_name,
        allocation: 1,
        join: r.start,
        leave: null,
        planned_end: r.end,
        role: this.mapRole(r.role),
        role_sf: r.role,
        confirmed: String(r.status || '').includes('確定'),
        completed,
        source: 'salesforce',
      });
    });

    // 役割順→氏名でソート（主任技術者を一番上に・旧表記を正規化）
    assignments.sort((a, b) => {
      const ra = this.ROLE_ORDER[this.normalizeRole(a.role)] ?? 99;
      const rb = this.ROLE_ORDER[this.normalizeRole(b.role)] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.emp_name || '').localeCompare(b.emp_name || '');
    });

    return {
      projects: Object.values(projectsMap),
      assignments,
    };
  },

  // ===== G工番ログ ユーティリティ =====

  // '8:00' / '8:30' / 8 / '8.5' を時間（小数）に変換
  parseHours(s) {
    if (s == null) return 0;
    const str = String(s).trim();
    const colon = str.match(/^(\d+):(\d+)$/);
    if (colon) return Number(colon[1]) + Number(colon[2]) / 60;
    const num = Number(str);
    return isNaN(num) ? 0 : num;
  },

  // 備考からG工番カテゴリを推定（検証B2のカテゴリに準拠）
  classifyGCategory(note) {
    const s = String(note || '').trim();
    if (!s || /G工番を使用の際/.test(s)) return '空欄・未記載';
    if (/教育|研修|採用|新人|OJT/i.test(s)) return '教育・採用';
    if (/安全|KY|衛生|健康/i.test(s)) return '安全衛生';
    if (/資料|事務|報告|提案|見積|積算/i.test(s)) return '資料作成・事務';
    if (/会議|打合|ミーティング|MTG|打ち合わせ/i.test(s)) return '会議・打合せ';
    if (/視察|調査|見学|現調|現地/i.test(s)) return '視察・調査';
    if (/移動|出張/i.test(s)) return '移動・出張';
    return 'その他';
  },

  // 日付から年月キー（YYYY-MM）を生成
  yearMonthKey(dateStr) {
    if (!dateStr) return null;
    const d = new Date(String(dateStr).replace(/\//g, '-'));
    if (isNaN(d)) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  // 先月の年月キーを返す
  previousYearMonthKey() {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  // G工番判定：プロジェクトコードが 'G' or 'G' で始まる短いコード
  isGWorkCode(code) {
    const s = String(code || '').trim();
    if (!s) return false;
    // 'G' 単独、または 'G-XXX' のようなパターン（'GLE...' のような工番除外）
    if (s === 'G') return true;
    if (/^G[-_]/.test(s)) return true;
    return false;
  },

  // 指定社員の指定年月のG工番サマリを集計
  // 戻り値: { totalHours, gHours, gRatio, categories: {cat: hours, ...} }
  computeGSummaryForEmployee(empId, yearMonth) {
    const logs = this.cache.g_work_logs || [];
    if (logs.length === 0 || !yearMonth) {
      return { totalHours: 0, gHours: 0, gRatio: 0, categories: {}, logCount: 0 };
    }

    let totalHours = 0;
    let gHours = 0;
    const categories = {};
    let logCount = 0;

    logs.forEach(r => {
      const rEmpId = String(r['社員コード'] || r.emp_id || '').trim();
      if (rEmpId !== String(empId)) return;
      const ym = this.yearMonthKey(r['日付'] || r.date);
      if (ym !== yearMonth) return;

      const h = this.parseHours(r['作業時間'] || r.hours);
      totalHours += h;
      logCount++;
      if (this.isGWorkCode(r['プロジェクトコード'] || r.project_code)) {
        gHours += h;
        const cat = this.classifyGCategory(r['備考'] || r.note);
        categories[cat] = (categories[cat] || 0) + h;
      }
    });

    const gRatio = totalHours > 0 ? gHours / totalHours : 0;
    return { totalHours, gHours, gRatio, categories, logCount };
  },

  // 段階D: 階層の自動判定（階層1のみ自動・階層2/3は手動）。
  //   - employee_tiers に手動判定があれば最優先
  //   - 自動：所属が「工事部配下の事務所/作業所」のみ（単独所属）→ 監督職（現場監督）
  //   - それ以外（兼任・工事企画室・工事部直属・工事部外）→ 対象外（画面で手動昇格）
  judgeCategory(empNo, depts, tierByEmp) {
    const manual = tierByEmp[String(empNo).trim()];
    if (manual && this.TIER_TO_CATEGORY[manual]) return this.TIER_TO_CATEGORY[manual];
    const isSiteOffice = (d) => {
      const s = String(d || '');
      return s.includes('工事部') && (s.includes('事務所') || s.includes('作業所'));
    };
    if (depts.length === 1 && isSiteOffice(depts[0])) return '現場監督';
    return '対象外';
  },

  // 作業所→親事務所の集約マップ（監督リスト・ガント監督軸・人材プールの「所属」表示で統合）。
  // 「作業所は事務所配下のサブ組織」という方針に基づき、所属表示を事務所に寄せる。
  // ※ 組織図画面（orgchart.js）は organization の生データを使うので作業所ノードはそのまま残る。
  DEPT_CONSOLIDATE: [
    { match: /千葉構内作業所/, to: '千葉事務所' },   // JFE千葉構内作業所 / 千葉構内作業所
    { match: /倉敷作業所/,     to: '西日本事務所' },
  ],
  consolidateDept(name) {
    const s = String(name || '');
    for (const r of this.DEPT_CONSOLIDATE) if (r.match.test(s)) return r.to;
    return s;
  },

  // 段階D: organization（構造）＋ employee_tiers（手動階層）＋ 資格ソース から社員オブジェクトを生成。
  // 旧 normalizeEmployees（区分/中計）を置換。返す形は従来と同じ（id/name/department/role/category/...）。
  buildEmployeesFromOrg(orgRows, tierRows, qualSource, absenceRows) {
    const tierByEmp = {};
    const workModeByEmp = {};   // emp_no -> { mode, start, end }
    // 不在（複数期間可）を社員番号でグルーピング。開始日昇順。
    const absByEmp = {};
    (absenceRows || []).forEach(a => {
      const no = String(a.emp_no || '').trim();
      if (!no) return;
      (absByEmp[no] = absByEmp[no] || []).push({
        id: a.id,
        kind: String(a.kind || '').trim(),
        start: String(a.start_date || '').trim(),
        end: String(a.end_date || '').trim(),
        note: String(a.note || '').trim(),
      });
    });
    Object.values(absByEmp).forEach(list => list.sort((x, y) => String(x.start).localeCompare(String(y.start))));
    (tierRows || []).forEach(t => {
      const no = String(t.emp_no || '').trim();
      if (no) {
        tierByEmp[no] = String(t.tier || '').trim();
        const wm = String(t.work_mode || '').trim();
        if (wm) workModeByEmp[no] = {
          mode: wm,
          start: String(t.work_mode_start || '').trim(),
          end: String(t.work_mode_end || '').trim(),
        };
      }
    });
    // 段階Q: employee_quals は SmartHR「従業員の資格一覧」(1行=1人×1資格)。社員番号でグルーピングし、
    //   詳細配列(qual_details: 監督ダッシュボード用)と簡易タグ(資格軸/バッジ用)を作る。
    const detailsByEmp = {};
    (qualSource || []).forEach(q => {
      const no = String(q['社員番号'] || q.emp_no || '').trim();
      if (!no) return;
      const path = String(q['保有資格'] || '').trim();          // "種別/資格名"
      const name = String(q['コード'] || '').trim() || (path.includes('/') ? path.split('/').slice(1).join('/') : path);
      const type = path.includes('/') ? path.split('/')[0] : '';  // 資格 / 技能講習 / 特別教育 等
      if (!name) return;
      if (this.isQualHidden(name)) return;   // 段階Q: 運転免許証など個人系は表示しない
      (detailsByEmp[no] = detailsByEmp[no] || []).push({
        name, type,
        acquired: String(q['取得日'] || '').trim(),
        expiry: String(q['有効期限'] || '').trim(),
      });
    });
    const toArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' && v ? (() => { try { return JSON.parse(v); } catch (e) { return []; } })() : []);
    return (orgRows || []).map(r => {
      const empNo = String(r.emp_no || '').trim();
      const depts = [...new Set(toArr(r.depts))];        // 重複部署を除去（単独/兼任判定を正確に）
      const positions = toArr(r.positions);
      const primary = depts[0] || '';
      return {
        id: parseInt(empNo, 10) || empNo,
        name: `${r.last_name || ''} ${r.first_name || ''}`.trim(),
        department: this.consolidateDept(primary ? String(primary).split('/').pop() : ''),
        role: positions[0] || '',
        role_title: positions[0] || '',
        qualifications_raw: this.deriveSekouTags(
          (detailsByEmp[empNo] || []).map(d => d.name)
            .concat(this.EXPERIENCE_SEKOU[empNo] ? [this.EXPERIENCE_SEKOU[empNo]] : [])
        ).join('、'),
        qual_details: detailsByEmp[empNo] || [],
        category: this.judgeCategory(empNo, depts, tierByEmp),
        work_mode: workModeByEmp[empNo] ? workModeByEmp[empNo].mode : '',
        work_mode_start: workModeByEmp[empNo] ? workModeByEmp[empNo].start : '',
        work_mode_end: workModeByEmp[empNo] ? workModeByEmp[empNo].end : '',
        absences: absByEmp[empNo] || [],     // 不在予定（監督軸でグレー網掛け帯）
        status: 'active',
        rank: '',
        depts,            // 組織図画面用に保持
        positions,        // 同上
        emp_no: empNo,
      };
    }).filter(e => e.id && e.name);
  },

  // 取得済みの生テーブル（this.cache）から employees 正規化・projects/assignments 派生・
  // overrides/status マージを行う。Sheets 経路 / Supabase 経路で共通。
  processRawTables() {
      // 段階D: organization があれば組織図ベースで社員生成（階層1自動＋手動tier）。
      // 無ければ従来の 01_employees ベース（normalizeEmployees）。
      if (this.cache.organization && this.cache.organization.length > 0) {
        try {
          this.cache.employees = this.buildEmployeesFromOrg(
            this.cache.organization, this.cache.employee_tiers, this.cache.employee_quals,
            this.cache.employee_absences);
        } catch (e) {
          console.error('組織図ベース社員生成失敗・旧employeesにフォールバック:', e);
          try { this.cache.employees = this.normalizeEmployees(this.cache.employees); }
          catch (e2) { this.cache.employees = MOCK_DATA.employees; }
        }
      } else if (this.cache.employees && this.cache.employees.length > 0) {
        try {
          this.cache.employees = this.normalizeEmployees(this.cache.employees);
        } catch (e) {
          console.warn('employees 正規化失敗・モックにフォールバック:', e);
          this.cache.employees = MOCK_DATA.employees;
        }
      }
      // employees が無い場合はモックを使用
      if (!this.cache.employees || this.cache.employees.length === 0) {
        this.cache.employees = MOCK_DATA.employees;
      }
      // 資格は employees F列のみをソースとする（v0.5方針）
      // - mock_data フォールバック使わない
      // - Salesforce 🔴🔵 派生も使わない（v0.6で別ソース統合時に再検討）
      // - F列が空欄の社員は資格軸に表示されない
      this.cache.qualifications = [];
      this.cache.employee_qualifications = [];
      try {
        const d = this.deriveQualificationsFromEmployees(
          this.cache.employees,
          [],
          []
        );
        this.cache.qualifications = d.qualifications;
        this.cache.employee_qualifications = d.employee_qualifications;
      } catch (e) {
        console.error('deriveQualificationsFromEmployees 失敗:', e);
      }

      // Salesforce + prospects から projects と assignments を派生（個別に try-catch）
      let allProjects = [];
      let allAssignments = [];
      if (this.cache.salesforce_imports && this.cache.salesforce_imports.length > 0) {
        try {
          const d = this.deriveFromSalesforce(this.cache.salesforce_imports, this.cache.employees);
          allProjects = allProjects.concat(d.projects);
          allAssignments = allAssignments.concat(d.assignments);
        } catch (e) {
          console.error('deriveFromSalesforce 失敗:', e);
        }
        // Salesforce 🔴🔵派生は v0.5 で停止（F列のみソース）
        // v0.6 で別ソース統合時に再有効化検討
      }
      if (this.cache.prospects && this.cache.prospects.length > 0) {
        try {
          const d = this.deriveFromProspects(this.cache.prospects, this.cache.employees);
          allProjects = allProjects.concat(d.projects);
          allAssignments = allAssignments.concat(d.assignments);
        } catch (e) {
          console.error('deriveFromProspects 失敗:', e);
        }
      }
      if (allProjects.length > 0 || allAssignments.length > 0) {
        this.cache.projects = allProjects;
        this.cache.assignments = allAssignments;
      } else {
        this.cache.projects = MOCK_DATA.projects;
        this.cache.assignments = MOCK_DATA.assignments;
      }

      // assignment_overrides を assignments にマージ（v4: op 別処理対応）
      if (this.cache.assignment_overrides && this.cache.assignment_overrides.length > 0) {
        try {
          this.cache.assignments = this.mergeOverridesIntoAssignments(
            this.cache.assignments,
            this.cache.assignment_overrides,
            this.cache.projects
          );
        } catch (e) {
          console.error('overrides マージ失敗:', e);
        }
      }

      // project_status_overrides を projects にマージ（v5: completed フラグの手動上書き）
      // 自動判定（planned_end < 今日）の誤判定を手動で修正できる
      if (this.cache.project_status_overrides && this.cache.project_status_overrides.length > 0) {
        try {
          this.cache.projects = this.mergeProjectStatusOverrides(
            this.cache.projects,
            this.cache.project_status_overrides
          );
        } catch (e) {
          console.error('project_status_overrides マージ失敗:', e);
        }
      }

      // 健全性チェック：氏名照合に失敗した配置（emp_id未解決）を読込時に検出して警告。
      // emp_no恒久キー＋異体字正規化でも一致しない＝名簿に該当者なし（誤字・退職・新異体字）の早期発見用。
      try {
        const unresolved = this.auditUnresolvedAssignments();
        if (unresolved.length > 0) {
          console.warn(`⚠ 進行中・今後の案件で氏名が社員名簿と一致しない担当が ${unresolved.length} 件あります（退職者が現役案件に残っている等。監督軸・資格軸・空き判定に出ません）。詳細: Sync.auditUnresolvedAssignments()`, unresolved);
        }
      } catch (e) { /* 監査は副作用なし。失敗しても本処理は継続 */ }
  },
});
