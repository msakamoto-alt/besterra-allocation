// 仮登録の受け口 Edge Function（sf-intake）
//
// 役割：Salesforce で案件の相手を選んで取引先ができた瞬間に、SF（Apex HubIntake）から呼ばれ、
//       会社マスタに「申請中」（registration_stage='temp'）の行＝箱を作って会社マスタIDを返す。
//       箱に入るのは 取引先番号（親コード・5桁・SFが振る）・社名・法人番号の候補・住所・電話・与信不要の印 だけ。
//       住所以外の中身（口座・反社・与信の確定）は経理が本登録で埋める。設計書＝取引先番号と与信の稟議 設計書 第4版（2026-10-20）p.2・p.4。
//       sf-export（ハブ→SF）の逆方向＝SF→ハブ。認証・呼び出し方は sf-export と同型。
//
// 流れ（1社ごと）：
//   1) system_code(system='salesforce', code=<Account Id>) が既にある → その会社を返す（status=exists）
//   2) 法人番号の候補があり、同じ法人番号の会社がある → その会社に SF の Id と親コードを結ぶ（status=linked）
//   3) それ以外 → 会社を新規（temp）＋system_code（salesforce／torihikisaki_code）＋company_history（status=created）
//   4) SF_EXPORT_* の Secrets があれば、SF の Account に会社マスタIDを書き戻す（HubCompanyId__c）
//      ＝company の INSERT で即時配信トリガ（sf-export direct）が走るとき、SF 側に会社マスタIDが無いと新しい Account を作ってしまう（二重）ため、
//        3秒の待ちの間に先に書く。Apex 側も応答の company_id を書く（冪等）。
//
// 認証（どちらかを満たすこと）：
//   a) Supabase JWT が admin ロール
//   b) x-import-secret ヘッダが IMPORT_SECRET と一致（SF の Apex からはこちら）
//      ※どちらも Verify JWT を通すため Authorization には最低 anon キーが必要
//
// POST body：{ source:'salesforce', org_id:'00D…', records:[{ account_id, account_code, name, name_kana, corporate_number, postal_code, prefecture, address, phone, credit_exempt, created_by }] }
// 応答：{ ok:true, results:[{ account_id, company_id, status:'created'|'linked'|'exists', error }], log_written }
//
// 必要な Secrets：IMPORT_SECRET（sf-import／sf-export と共通）。書き戻しに SF_EXPORT_INSTANCE_URL / SF_EXPORT_CLIENT_ID / SF_EXPORT_CLIENT_SECRET / SF_EXPORT_ALLOWED_ORG_IDS（sf-export と共通・任意）
//
// 安全鉄則：
//   - 箱を作るだけ。本登録（registration_stage='full'）にはしない。既存の会社の中身は書き換えない（SF の Id と親コードを結ぶだけ）
//   - 法人番号は候補として company.corporate_number に入れる（経理が本登録で確かめる）。同じ法人番号が別の会社にあるときは新規にせず結ぶ
//   - 親コード（torihikisaki_code）が他社に付いていたら、その社は作らず error で返す（SF 側で HubIntakeError__c に残る）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-import-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const VERSION = '2026-10-20.1';
const LOG = 'integration_log';
const SYSTEM = 'salesforce';
const CODE_SYSTEM = 'torihikisaki_code'; // 取引先番号（親コード・5桁）を system_code に持つ（会社マスタIDとは別物）
const API_VERSION = 'v61.0';
const ID_FLOOR = 2563; // 画面の nextCompanyId と同じ下限（棚卸の 2,563 社）

type Admin = ReturnType<typeof createClient>;
type Rec = { account_id?: string; account_code?: string; name?: string; name_kana?: string; corporate_number?: string; postal_code?: string;
  prefecture?: string; address?: string; phone?: string; credit_exempt?: boolean; created_by?: string };
type Result = { account_id: string; company_id: string | null; status: 'created' | 'linked' | 'exists' | 'error'; error?: string };

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
const env = (k: string) => (Deno.env.get(k) || '').trim();
const clean = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');

async function nextCompanyId(admin: Admin): Promise<number> {
  // 画面（js/views/torihikisaki.js nextCompanyId）と同じ＝数字だけの ID の最大＋1（下限 2563）
  const { data, error } = await admin.from('company').select('company_id').order('company_id', { ascending: false }).limit(50);
  if (error) throw new Error('company 読取失敗: ' + error.message);
  let max = ID_FLOOR;
  for (const r of data || []) { const s = String(r.company_id); if (/^\d+$/.test(s)) max = Math.max(max, Number(s)); }
  return max + 1;
}

async function logRun(admin: Admin, e: { kind: 'run' | 'error'; caller: string; source: unknown; counts?: Record<string, number>; companyIds?: string[]; message?: string; meta?: Record<string, unknown>; payload?: unknown; t0: number }): Promise<boolean> {
  try {
    const { error } = await admin.from(LOG).insert({
      system: SYSTEM, target: 'SF→ハブ（仮登録の箱）', kind: e.kind, action: 'intake', trigger: '自動（SF で取引先ができたとき）', actor: e.caller === 'secret' ? 'sf-intake（Salesforce）' : e.caller,
      counts: e.counts || null, company_ids: e.companyIds || null, message: e.message || null,
      meta: { version: VERSION, source: e.source ?? null, ...(e.meta || {}) }, payload: e.payload ?? null, duration_ms: Date.now() - e.t0,
    });
    if (error) { console.error('連携ログ記録失敗:', error.message); return false; }
    return true;
  } catch (err) { console.error('連携ログ記録失敗:', String((err as Error)?.message || err)); return false; }
}

// ---- SF への書き戻し（会社マスタID）。Secrets が無ければ何もしない ----
async function writebackHubIds(pairs: { account_id: string; company_id: string }[]): Promise<string | null> {
  const base = env('SF_EXPORT_INSTANCE_URL').replace(/\/+$/, '');
  const clientId = env('SF_EXPORT_CLIENT_ID'); const clientSecret = env('SF_EXPORT_CLIENT_SECRET');
  if (!base || !clientId || !clientSecret || !pairs.length) return null;
  const tokenRes = await fetch(base + '/services/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }) });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok || !tokenBody.access_token) return 'SFトークン取得失敗: ' + JSON.stringify(tokenBody).slice(0, 200);
  const res = await fetch(`${base}/services/data/${API_VERSION}/composite/sobjects`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + tokenBody.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allOrNone: false, records: pairs.map((p) => ({ attributes: { type: 'Account' }, Id: p.account_id, HubCompanyId__c: p.company_id })) }),
  });
  const body = await res.json();
  if (!res.ok) return 'SF 書き戻し失敗: ' + JSON.stringify(body).slice(0, 200);
  const bad = (body as { success: boolean; errors?: { message?: string }[] }[]).filter((r) => !r.success);
  return bad.length ? 'SF 書き戻し失敗 ' + bad.length + ' 件: ' + (bad[0].errors || []).map((e) => e.message).join('; ').slice(0, 200) : null;
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
    const records: Rec[] = Array.isArray(body.records) ? body.records : [];
    if (!records.length) return json({ ok: false, error: 'records が空です' }, 400);
    if (records.length > 50) return json({ ok: false, error: 'records は 50 件までです' }, 400);

    const who = 'sf-intake（Salesforce）';
    const results: Result[] = [];
    const newPairs: { account_id: string; company_id: string }[] = [];
    let nextId = await nextCompanyId(admin);

    for (const r of records) {
      const accountId = clean(r.account_id, 18);
      if (!accountId) { results.push({ account_id: String(r.account_id || ''), company_id: null, status: 'error', error: 'account_id がありません' }); continue; }
      const name = clean(r.name, 200);
      const code = digits(r.account_code);
      const corp = digits(r.corporate_number);
      try {
        // 1) 既に結ばれている SF の取引先か
        const { data: ex, error: exErr } = await admin.from('system_code').select('company_id').eq('system', SYSTEM).eq('code', accountId).maybeSingle();
        if (exErr) throw new Error('system_code 読取失敗: ' + exErr.message);
        if (ex?.company_id) {
          // 親コードが未登録なら結ぶ（既存の会社に SF が振った番号を足す）
          if (code.length === 5) await admin.from('system_code').upsert({ company_id: ex.company_id, system: CODE_SYSTEM, code }, { onConflict: 'company_id,system' });
          results.push({ account_id: accountId, company_id: String(ex.company_id), status: 'exists' });
          continue;
        }
        // 親コードが他社に付いていないか
        if (code.length === 5) {
          const { data: holder } = await admin.from('system_code').select('company_id').eq('system', CODE_SYSTEM).eq('code', code).maybeSingle();
          if (holder?.company_id) { results.push({ account_id: accountId, company_id: null, status: 'error', error: `親コード ${code} は会社マスタ ${holder.company_id} に付いています` }); continue; }
        }
        // 2) 同じ法人番号の会社があれば結ぶ
        let cid: string | null = null;
        let status: Result['status'] = 'created';
        if (corp.length === 13) {
          const { data: same } = await admin.from('company').select('company_id,official_name').eq('corporate_number', corp).maybeSingle();
          if (same?.company_id) { cid = String(same.company_id); status = 'linked'; }
        }
        // 3) 新規＝申請中の箱
        if (!cid) {
          if (!name) { results.push({ account_id: accountId, company_id: null, status: 'error', error: '社名がありません' }); continue; }
          for (let attempt = 0; attempt < 5 && !cid; attempt++) {
            const tryId = String(nextId + attempt).padStart(8, '0');
            const row: Record<string, unknown> = {
              company_id: tryId, official_name: name, name_kana: clean(r.name_kana, 200), corporate_number: corp.length === 13 ? corp : null,
              postal_code: digits(r.postal_code).length === 7 ? digits(r.postal_code) : null, prefecture: clean(r.prefecture, 20), address_line: clean(r.address, 200),
              phone: clean(r.phone, 20), credit_exempt: r.credit_exempt === true, registration_stage: 'temp', data_source: 'salesforce',
              remarks: `Salesforce の案件管理で相手を選んだときにできた仮登録（箱）。作った人: ${clean(r.created_by, 40) || '不明'}。本登録は取引開始申請の承認後に経理が行う`,
              created_by: who, updated_by: who,
            };
            const ins = await admin.from('company').insert(row);
            if (!ins.error) { cid = tryId; nextId = nextId + attempt + 1; break; }
            if (!/duplicate|23505/i.test(ins.error.message || '')) throw new Error('company 登録失敗: ' + ins.error.message);
            if (/corpnum|corporate_number/i.test(ins.error.message || '')) throw new Error('法人番号 ' + corp + ' が他社と重複');
          }
          if (!cid) throw new Error('会社マスタIDの採番が競合しました');
          await admin.from('company_history').insert({ company_id: cid, table_name: 'company', column_name: '(新規作成)', old_value: null,
            new_value: `${name}（経路: Salesforce 仮登録の箱・親コード ${code || '-'}・法人番号の候補 ${corp || '-'}）`, changed_by: who });
        }
        // SF の Id と親コードを結ぶ
        const codes: Record<string, unknown>[] = [{ company_id: cid, system: SYSTEM, code: accountId }];
        if (code.length === 5) codes.push({ company_id: cid, system: CODE_SYSTEM, code });
        const sc = await admin.from('system_code').upsert(codes, { onConflict: 'company_id,system' });
        if (sc.error) throw new Error('system_code 登録失敗: ' + sc.error.message);
        if (status === 'linked') {
          await admin.from('company_history').insert({ company_id: cid, table_name: 'system_code', column_name: SYSTEM, old_value: null,
            new_value: `Salesforce の取引先 ${accountId}（親コード ${code || '-'}）を法人番号 ${corp} で結んだ`, changed_by: who });
        }
        newPairs.push({ account_id: accountId, company_id: cid! });
        results.push({ account_id: accountId, company_id: cid, status });
      } catch (err) {
        results.push({ account_id: accountId, company_id: null, status: 'error', error: String((err as Error)?.message || err).slice(0, 200) });
      }
    }

    // 4) SF へ会社マスタIDを書き戻す（即時配信より先に・任意）
    const wb = await writebackHubIds(newPairs).catch((e) => String((e as Error)?.message || e));
    const counts = { received: records.length, created: results.filter((x) => x.status === 'created').length, linked: results.filter((x) => x.status === 'linked').length,
      exists: results.filter((x) => x.status === 'exists').length, failed: results.filter((x) => x.status === 'error').length };
    const logged = await logRun(admin, { kind: counts.failed ? 'error' : 'run', caller, source, counts, companyIds: results.map((x) => x.company_id).filter((x): x is string => !!x), t0,
      message: counts.failed ? results.filter((x) => x.status === 'error').map((x) => `${x.account_id}: ${x.error}`).join(' / ').slice(0, 1000) : (wb || undefined),
      meta: { org_id: body.org_id ?? null, writeback: wb ? 'failed: ' + wb : (newPairs.length ? 'ok' : 'none') }, payload: results });
    return json({ ok: true, version: VERSION, results, writeback: wb, log_written: logged, elapsed_ms: Date.now() - t0 });
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (admin) await logRun(admin, { kind: 'error', caller, source, message: msg, t0 });
    return json({ ok: false, error: msg }, 500);
  }
});
