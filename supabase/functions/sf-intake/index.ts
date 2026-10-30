// 仮登録の受け口 Edge Function（sf-intake）
//
// 役割：Salesforce で案件の相手を選んで取引先ができた瞬間に、SF（Apex HubIntake）から呼ばれ、
//       会社マスタに「申請中」（registration_stage='temp'）の行＝箱を作り、**取引先番号（親コード・5 桁）＝会社マスタの鍵** を振って返す。
//       番号を振るのはハブだけ（坂本さん決定 2026-10-21・案 B）。SF は返った番号を HubCompanyId__c と AccountCode__c に入れる。
//       箱に入るのは 社名・法人番号の候補・住所・電話・与信不要の印 だけ。口座・反社・与信の確定は経理が本登録で埋める。
//       設計書＝取引先番号と与信の稟議 設計書 第4版（2026-10-20）p.2・p.4（振る場所は改訂 2 で「ハブ」に）。
//
// 帯（parent_code_01_migrate.sql の next_parent_code）：
//   本物 10001〜99999 ＝ Secret SF_PROD_ORG_IDS（15 桁・カンマ区切り）にある org から来た箱だけ
//   試験 00001〜09999 ＝ それ以外の org（dev6・dev7・知らない org）。is_test=true・経理の画面では既定で隠す・本番 SF には配信しない・消したら使い回す
//   10000 ＝ ベステラ自社（予約・ここでは振らない）
//
// 流れ（1社ごと）：
//   1) system_code(system=<帯の札>, code=<Account Id>) が既にある → その会社を返す（status=exists）。札＝本物 'salesforce'／試験 'salesforce_test'
//   2) 法人番号の候補があり、同じ帯（本物／試験）に同じ法人番号の会社がある → その会社に結ぶ（status=linked）。試験の箱が本物の会社に結ぶことはない
//   3) それ以外 → 会社を新規（temp・is_test・source_org_id／source_org_label＝箱を送ってきた org と呼び名・2026-10-29.1）＋system_code（札）＋company_history（status=created）
//      sf-export は試験の会社を source_org_id の org にだけ配る（dev6 の試験の会社が dev7 に混ざらない）
//   4) SF_EXPORT_* の Secrets があれば、SF の Account に番号を書き戻す（HubCompanyId__c と AccountCode__c）
//      ＝company の INSERT で即時配信トリガ（sf-export direct）が走るとき、SF 側に鍵が無いと新しい Account を作ってしまう（二重）ため、
//        3秒の待ちの間に先に書く。Apex 側も応答の company_id を書く（冪等）。
//
// 認証（どちらかを満たすこと）：
//   a) Supabase JWT が admin ロール
//   b) x-import-secret ヘッダが IMPORT_SECRET と一致（SF の Apex からはこちら）
//      ※どちらも Verify JWT を通すため Authorization には最低 anon キーが必要
//
// POST body：{ source:'salesforce', org_id:'00D…', records:[{ account_id, name, name_kana, corporate_number, postal_code, prefecture, address, phone, credit_exempt, created_by }] }
//           （account_code は受け取っても使わない＝番号はハブが振る）
// 応答：{ ok:true, version, band:'real'|'test', results:[{ account_id, company_id, status:'created'|'linked'|'exists'|'error', error }], writeback, log_written }
//
// 必要な Secrets：IMPORT_SECRET（sf-import／sf-export と共通）・SF_PROD_ORG_IDS（本物の帯を振る org・切り替えまでは空＝全部が試験）。
//               書き戻しに SF_EXPORT_TARGETS（sf-export と共通・箱を送ってきた org へ）か、従来の SF_EXPORT_INSTANCE_URL / CLIENT_ID / CLIENT_SECRET（1 件・任意）
//
// 安全鉄則：
//   - 箱を作るだけ。本登録（registration_stage='full'）にはしない。既存の会社の中身は書き換えない（SF の Id を結ぶだけ）
//   - 法人番号は候補として company.corporate_number に入れる（経理が本登録で確かめる）。同じ帯に同じ法人番号の会社があるときは新規にせず結ぶ
//   - 番号は DB の next_parent_code() だけが振る（本物は順序＝重複なし・試験は最大＋1＝重複したらやり直し）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-import-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const VERSION = '2026-10-30.1'; // .1（10/30）: action=credit_notice＝SF の与信の稟議・取引開始申請の承認の知らせを credit_notice に 1 件（org・稟議番号で一意・決裁額は来ない）。会社は取引先番号→SF の取引先 Id の札の順で引く（引けなければ空＝画面の窓で選ぶ）／2026-10-29.1: .1（10/29）: 会社に出どころの org（source_org_id／source_org_label）を持たせる＝sf-export が試験の会社をその org にだけ配る／2026-10-21.2: // .1: 番号はハブが振る（next_parent_code）・帯＝本物／試験・is_test・書き戻しに AccountCode__c／.2: 書き戻し先は箱を送ってきた org（SF_EXPORT_TARGETS）
const LOG = 'integration_log';
const API_VERSION = 'v61.0';
const SYSTEM_REAL = 'salesforce';      // 本物の org の取引先 Id の札（sf-export の writeback と同じ）
const SYSTEM_TEST = 'salesforce_test'; // 試験の org の取引先 Id の札（本物の札と混ぜない）

type Admin = ReturnType<typeof createClient>;
type Band = 'real' | 'test';
type Rec = { account_id?: string; account_code?: string; name?: string; name_kana?: string; corporate_number?: string; postal_code?: string;
  prefecture?: string; address?: string; phone?: string; credit_exempt?: boolean; created_by?: string };
type Result = { account_id: string; company_id: string | null; status: 'created' | 'linked' | 'exists' | 'error'; error?: string };

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
const env = (k: string) => (Deno.env.get(k) || '').trim();
const clean = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');

// 帯の判定＝呼び出し元の org（15 桁）が SF_PROD_ORG_IDS にあれば本物、無ければ試験（Secret が空なら全部が試験＝安全側）
function bandOf(orgId: unknown): Band {
  const id = String(orgId || '').slice(0, 15);
  const prod = env('SF_PROD_ORG_IDS').split(',').map((s) => s.trim().slice(0, 15)).filter(Boolean);
  return id && prod.includes(id) ? 'real' : 'test';
}

// 番号を 1 つ振る（DB の next_parent_code・本物は順序・試験は最大＋1）
async function nextParentCode(admin: Admin, band: Band): Promise<string> {
  const { data, error } = await admin.rpc('next_parent_code', { p_band: band });
  if (error) throw new Error('採番失敗（next_parent_code）: ' + error.message);
  const code = String(data || '');
  if (!/^\d{5}$/.test(code)) throw new Error('採番の結果が 5 桁でありません: ' + code);
  return code;
}

async function logRun(admin: Admin, e: { kind: 'run' | 'error'; caller: string; source: unknown; counts?: Record<string, number>; companyIds?: string[]; message?: string; meta?: Record<string, unknown>; payload?: unknown; t0: number }): Promise<boolean> {
  try {
    const { error } = await admin.from(LOG).insert({
      system: SYSTEM_REAL, target: 'SF→ハブ（仮登録の箱）', kind: e.kind, action: 'intake', trigger: '自動（SF で取引先ができたとき）', actor: e.caller === 'secret' ? 'sf-intake（Salesforce）' : e.caller,
      counts: e.counts || null, company_ids: e.companyIds || null, message: e.message || null,
      meta: { version: VERSION, source: e.source ?? null, ...(e.meta || {}) }, payload: e.payload ?? null, duration_ms: Date.now() - e.t0,
    });
    if (error) { console.error('連携ログ記録失敗:', error.message); return false; }
    return true;
  } catch (err) { console.error('連携ログ記録失敗:', String((err as Error)?.message || err)); return false; }
}

// ---- SF への書き戻し（鍵＝取引先番号を HubCompanyId__c と AccountCode__c に）。書き戻し先＝箱を送ってきた org ----
// Secret SF_EXPORT_TARGETS（sf-export と共通・JSON の配列 [{name, org_id, instance_url, client_id, client_secret, enabled}]）があれば org_id が一致する送り先へ。
// 一致する送り先が無ければ書き戻さない（Apex 側が応答の番号を書く）。SF_EXPORT_TARGETS が無ければ従来の SF_EXPORT_* の 1 件へ
function writebackTargetFor(orgId: string): { base: string; clientId: string; clientSecret: string } | null {
  const raw = env('SF_EXPORT_TARGETS');
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const x of arr as Record<string, unknown>[]) {
          if (x && x.enabled !== false && String(x.org_id || '').slice(0, 15) === orgId.slice(0, 15)) {
            return { base: String(x.instance_url || '').replace(/\/+$/, ''), clientId: String(x.client_id || ''), clientSecret: String(x.client_secret || '') };
          }
        }
      }
    } catch (_) { /* 読めなければ書き戻さない */ }
    return null;
  }
  const base = env('SF_EXPORT_INSTANCE_URL').replace(/\/+$/, '');
  const clientId = env('SF_EXPORT_CLIENT_ID'); const clientSecret = env('SF_EXPORT_CLIENT_SECRET');
  return base && clientId && clientSecret ? { base, clientId, clientSecret } : null;
}
// 出どころの org の呼び名（Secret SF_EXPORT_TARGETS の name＝dev6・dev7）。無ければ org の 15 桁（2026-10-29.1）
function orgLabelFor(orgId: string): string {
  const id = orgId.slice(0, 15);
  try {
    const arr = JSON.parse(env('SF_EXPORT_TARGETS') || '[]');
    if (Array.isArray(arr)) {
      for (const x of arr as Record<string, unknown>[]) {
        if (x && String(x.org_id || '').slice(0, 15) === id && x.name) return String(x.name).slice(0, 40);
      }
    }
  } catch (_) { /* 読めなければ org の 15 桁 */ }
  return id;
}

async function writebackHubIds(pairs: { account_id: string; company_id: string }[], orgId: string): Promise<string | null> {
  const tg = writebackTargetFor(orgId);
  if (!tg || !pairs.length) return null;
  const { base, clientId, clientSecret } = tg;
  const tokenRes = await fetch(base + '/services/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }) });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok || !tokenBody.access_token) return 'SFトークン取得失敗: ' + JSON.stringify(tokenBody).slice(0, 200);
  const res = await fetch(`${base}/services/data/${API_VERSION}/composite/sobjects`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + tokenBody.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allOrNone: false, records: pairs.map((p) => ({ attributes: { type: 'Account' }, Id: p.account_id, HubCompanyId__c: p.company_id, AccountCode__c: p.company_id })) }),
  });
  const body = await res.json();
  if (!res.ok) return 'SF 書き戻し失敗: ' + JSON.stringify(body).slice(0, 200);
  const bad = (body as { success: boolean; errors?: { message?: string }[] }[]).filter((r) => !r.success);
  return bad.length ? 'SF 書き戻し失敗 ' + bad.length + ' 件: ' + (bad[0].errors || []).map((e) => e.message).join('; ').slice(0, 200) : null;
}

// ---- 承認の知らせ（2026-10-30.1・坂本さん「承認の知らせが届いた会社について、ツールで窓を出す」）----
// body: { action:'credit_notice', org_id, notices:[{ application_no, application_id, kind, account_id, account_name, company_id, applicant, approved_on, requested_limit, project_no }] }
// 決裁額は来ない（限度額は経理が窓で入れる）。同じ org・稟議番号は 1 件（二度目は何もしない＝済みの印も消さない）。
type NoticeIn = { application_no?: string; application_id?: string; kind?: string; account_id?: string; account_name?: string; company_id?: string;
  applicant?: string; approved_on?: string; requested_limit?: number | string; project_no?: string };
async function creditNotice(admin: Admin, body: Record<string, unknown>, caller: string, t0: number): Promise<Response> {
  const notices: NoticeIn[] = Array.isArray(body.notices) ? body.notices as NoticeIn[] : [];
  if (!notices.length) return json({ ok: false, error: 'notices が空です' }, 400);
  if (notices.length > 50) return json({ ok: false, error: 'notices は 50 件までです' }, 400);
  const orgId = String(body.org_id || '').slice(0, 15);
  if (!/^00D[0-9A-Za-z]{12}$/.test(orgId)) return json({ ok: false, error: 'org_id がありません' }, 400);
  const isProd = bandOf(orgId) === 'real';
  const label = orgLabelFor(orgId);
  const out: { application_no: string; company_id: string | null; status: 'created' | 'exists' | 'error'; error?: string }[] = [];
  for (const n of notices) {
    const no = clean(n.application_no, 40);
    if (!no) { out.push({ application_no: '', company_id: null, status: 'error', error: 'application_no がありません' }); continue; }
    try {
      // 会社: 取引先番号（5 桁）があってツールにあればそれ。無ければ SF の取引先 Id の札（帯ごと）で引く。引けなければ空＝窓で選ぶ
      let cid: string | null = null;
      const code = digits(n.company_id);
      if (code.length === 5) {
        const { data: co } = await admin.from('company').select('company_id').eq('company_id', code).maybeSingle();
        if (co?.company_id) cid = String(co.company_id);
      }
      const acc = clean(n.account_id, 18);
      if (!cid && acc) {
        const { data: sc } = await admin.from('system_code').select('company_id').in('system', [SYSTEM_REAL, SYSTEM_TEST]).eq('code', acc).limit(1);
        if (sc && sc.length) cid = String((sc[0] as { company_id: string }).company_id);
      }
      const kind = clean(n.kind, 10) === '取引開始' ? '取引開始' : '与信';
      const lim = Number(String(n.requested_limit ?? '').replace(/[^\d.]/g, ''));
      const row = {
        org_id: orgId, org_label: label, is_prod: isProd, kind, application_no: no, application_id: clean(n.application_id, 18),
        sf_account_id: acc, account_name: clean(n.account_name, 200), company_id: cid, applicant: clean(n.applicant, 80),
        approved_on: /^\d{4}-\d{2}-\d{2}$/.test(String(n.approved_on || '')) ? String(n.approved_on) : null,
        requested_limit: Number.isFinite(lim) && lim > 0 ? Math.round(lim) : null, project_no: clean(n.project_no, 20),
      };
      const { data: ins, error } = await admin.from('credit_notice').upsert(row, { onConflict: 'org_id,application_no', ignoreDuplicates: true }).select('id');
      if (error) throw new Error('credit_notice 登録失敗: ' + error.message);
      out.push({ application_no: no, company_id: cid, status: ins && ins.length ? 'created' : 'exists' });
    } catch (err) {
      out.push({ application_no: no, company_id: null, status: 'error', error: String((err as Error)?.message || err).slice(0, 200) });
    }
  }
  const failed = out.filter((x) => x.status === 'error');
  try {
    await admin.from(LOG).insert({
      system: isProd ? SYSTEM_REAL : SYSTEM_TEST, target: 'SF→ハブ（承認の知らせ）', kind: failed.length ? 'error' : 'run', action: 'credit_notice',
      trigger: '自動（SF で稟議が承認されたとき）', actor: caller === 'secret' ? 'sf-intake（Salesforce）' : caller,
      counts: { received: notices.length, created: out.filter((x) => x.status === 'created').length, exists: out.filter((x) => x.status === 'exists').length, failed: failed.length },
      company_ids: out.map((x) => x.company_id).filter((x): x is string => !!x),
      message: failed.length ? failed.map((x) => `${x.application_no}: ${x.error}`).join(' / ').slice(0, 1000) : null,
      meta: { version: VERSION, org_id: orgId, org_label: label, is_prod: isProd }, payload: out, duration_ms: Date.now() - t0,
    });
  } catch (e) { console.error('連携ログ記録失敗:', String((e as Error)?.message || e)); }
  if (failed.length) return json({ ok: false, version: VERSION, error: failed.map((x) => `${x.application_no}: ${x.error}`).join(' / ').slice(0, 500), results: out }, 500);
  return json({ ok: true, version: VERSION, results: out, elapsed_ms: Date.now() - t0 });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const t0 = Date.now();
  let admin: Admin | null = null;
  let caller = 'secret';
  let source: unknown = null;
  try {
    admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    // --- 認証（sf-export と同じ） ---
    const importSecret = env('IMPORT_SECRET');
    if (!(importSecret && req.headers.get('x-import-secret') === importSecret)) {
      const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
      if (!jwt) return json({ ok: false, error: '未認証です' }, 401);
      const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
      if (uErr || !userData?.user) return json({ ok: false, error: '認証が無効です' }, 401);
      const { data: role } = await admin.from('user_roles').select('role').eq('user_id', userData.user.id).maybeSingle();
      if (role?.role !== 'admin') return json({ ok: false, error: '管理者権限が必要です' }, 403);
      caller = userData.user.email || userData.user.id;
    }
    const body = await req.json().catch(() => ({}));
    source = body.source ?? null;
    if (body.action === 'credit_notice') return await creditNotice(admin, body, caller, t0); // 承認の知らせ（2026-10-30.1）
    const records: Rec[] = Array.isArray(body.records) ? body.records : [];
    if (!records.length) return json({ ok: false, error: 'records が空です' }, 400);
    if (records.length > 50) return json({ ok: false, error: 'records は 50 件までです' }, 400);

    const band = bandOf(body.org_id);
    const isTest = band === 'test';
    const SYS = isTest ? SYSTEM_TEST : SYSTEM_REAL;
    const who = 'sf-intake（Salesforce' + (isTest ? '・試験' : '') + '）';
    const results: Result[] = [];
    const newPairs: { account_id: string; company_id: string }[] = [];

    for (const r of records) {
      const accountId = clean(r.account_id, 18);
      if (!accountId) { results.push({ account_id: String(r.account_id || ''), company_id: null, status: 'error', error: 'account_id がありません' }); continue; }
      const name = clean(r.name, 200);
      const corp = digits(r.corporate_number);
      try {
        // 1) 既に結ばれている SF の取引先か（同じ帯の札で）
        const { data: ex, error: exErr } = await admin.from('system_code').select('company_id').eq('system', SYS).eq('code', accountId).maybeSingle();
        if (exErr) throw new Error('system_code 読取失敗: ' + exErr.message);
        if (ex?.company_id) { results.push({ account_id: accountId, company_id: String(ex.company_id), status: 'exists' }); continue; }
        // 2) 同じ帯に同じ法人番号の会社があれば結ぶ（試験の箱は本物の会社に結ばない）
        let cid: string | null = null;
        let status: Result['status'] = 'created';
        if (corp.length === 13) {
          const { data: same } = await admin.from('company').select('company_id,official_name').eq('corporate_number', corp).eq('is_test', isTest).maybeSingle();
          if (same?.company_id) { cid = String(same.company_id); status = 'linked'; }
        }
        // 3) 新規＝申請中の箱（番号はハブが振る）
        if (!cid) {
          if (!name) { results.push({ account_id: accountId, company_id: null, status: 'error', error: '社名がありません' }); continue; }
          for (let attempt = 0; attempt < 5 && !cid; attempt++) {
            const tryId = await nextParentCode(admin, band);
            const row: Record<string, unknown> = {
              company_id: tryId, is_test: isTest, official_name: name, name_kana: clean(r.name_kana, 200), corporate_number: corp.length === 13 ? corp : null,
              postal_code: digits(r.postal_code).length === 7 ? digits(r.postal_code) : null, prefecture: clean(r.prefecture, 20), address_line: clean(r.address, 200),
              phone: clean(r.phone, 20), credit_exempt: r.credit_exempt === true, registration_stage: 'temp', data_source: isTest ? 'salesforce_test' : 'salesforce',
              source_org_id: String(body.org_id || '').slice(0, 15) || null, source_org_label: orgLabelFor(String(body.org_id || '')) || null, // 出どころ（2026-10-29.1）
              remarks: (isTest ? '【試験】' : '') + `Salesforce の案件管理で相手を選んだときにできた仮登録（箱）。作った人: ${clean(r.created_by, 40) || '不明'}。本登録は取引開始申請の承認後に経理が行う`,
              created_by: who, updated_by: who,
            };
            const ins = await admin.from('company').insert(row);
            if (!ins.error) { cid = tryId; break; }
            if (!/duplicate|23505/i.test(ins.error.message || '')) throw new Error('company 登録失敗: ' + ins.error.message);
            if (/corpnum|corporate_number/i.test(ins.error.message || '')) throw new Error('法人番号 ' + corp + ' が他社と重複');
            // 鍵の重複（試験の帯で同時に振ったとき）＝もう一度振る
          }
          if (!cid) throw new Error('取引先番号の採番が競合しました');
          await admin.from('company_history').insert({ company_id: cid, table_name: 'company', column_name: '(新規作成)', old_value: null,
            new_value: `${name}（経路: Salesforce 仮登録の箱・取引先番号 ${cid}${isTest ? '・試験の帯' : ''}・法人番号の候補 ${corp || '-'}）`, changed_by: who });
        }
        // SF の取引先 Id を札として結ぶ（帯ごとの札）
        const sc = await admin.from('system_code').upsert([{ company_id: cid, system: SYS, code: accountId }], { onConflict: 'company_id,system' });
        if (sc.error) throw new Error('system_code 登録失敗: ' + sc.error.message);
        if (status === 'linked') {
          await admin.from('company_history').insert({ company_id: cid, table_name: 'system_code', column_name: SYS, old_value: null,
            new_value: `Salesforce の取引先 ${accountId} を法人番号 ${corp} で結んだ（取引先番号 ${cid}）`, changed_by: who });
        }
        newPairs.push({ account_id: accountId, company_id: cid! });
        results.push({ account_id: accountId, company_id: cid, status });
      } catch (err) {
        results.push({ account_id: accountId, company_id: null, status: 'error', error: String((err as Error)?.message || err).slice(0, 200) });
      }
    }

    // 4) SF へ番号を書き戻す（即時配信より先に・任意）
    const wb = await writebackHubIds(newPairs, String(body.org_id || '')).catch((e) => String((e as Error)?.message || e));
    const counts = { received: records.length, created: results.filter((x) => x.status === 'created').length, linked: results.filter((x) => x.status === 'linked').length,
      exists: results.filter((x) => x.status === 'exists').length, failed: results.filter((x) => x.status === 'error').length };
    const logged = await logRun(admin, { kind: counts.failed ? 'error' : 'run', caller, source, counts, companyIds: results.map((x) => x.company_id).filter((x): x is string => !!x), t0,
      message: counts.failed ? results.filter((x) => x.status === 'error').map((x) => `${x.account_id}: ${x.error}`).join(' / ').slice(0, 1000) : (wb || undefined),
      meta: { org_id: body.org_id ?? null, band, writeback: wb ? 'failed: ' + wb : (newPairs.length ? 'ok' : 'none') }, payload: results });
    return json({ ok: true, version: VERSION, band, results, writeback: wb, log_written: logged, elapsed_ms: Date.now() - t0 });
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (admin) await logRun(admin, { kind: 'error', caller, source, message: msg, t0 });
    return json({ ok: false, error: msg }, 500);
  }
});
