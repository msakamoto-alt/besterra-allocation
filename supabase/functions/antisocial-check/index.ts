// 反社チェックの API 連携（RoboRobo コンプライアンスチェック）Edge Function（antisocial-check）— 2026-11-15
//
// 役割：統合管理ツールの取引先マスタから RoboRobo へ反社チェックを頼み、結果と取引判断を取り込む。
//       決まり（いつ・誰を頼むか・該当なしの線・回の結果・今の状態）は DB（supabase/antisocial_check.sql）が持ち、
//       この関数は RoboRobo との通信だけを受け持つ。調べるのは RoboRobo、決めるのは経理（RoboRobo の画面で取引判断）、残すのはツール。
//       手順書＝supabase/PHASE_ANTISOCIAL_CHECK_SETUP.md
//
// 認証（どれか 1 つ）：
//   a) 結果の送付（RoboRobo から）… URL の ?action=callback&k=<ANTISOCIAL_CALLBACK_SECRET>（Authorization は anon の鍵＝RoboRobo に渡すトークン）
//   b) 定時実行 … x-import-secret ヘッダが IMPORT_SECRET と一致（pg_cron・sf-import／sf-export と共通）
//   c) 画面 … Supabase JWT が admin か accounting
//
// POST body（a 以外）：
//   action … tick（定時：決まりに沿って頼む→送る→届かない結果を取りに行く→取引判断を取り込む）
//            request（会社を 1 社・手動で頼んですぐ送る）／sync（その会社の結果と取引判断を今すぐ取り込む）／probe（RoboRobo につながるか・今月の件数）
//   company_id … request・sync のとき
//
// 必要な Secrets：
//   ROBOROBO_API_TOKEN_TEST    … テスト環境のトークン（試しの回＝本物の状態に数えない）
//   ROBOROBO_API_TOKEN         … 本番のトークン（契約のあと。設定 use_prod_token=true のときに使う）
//   ANTISOCIAL_CALLBACK_SECRET … 結果の送付の合言葉（長い乱数）
//   IMPORT_SECRET              … 定時実行（共通）
//
// 安全：
//   - トークンは Secrets だけに置く。返事・連携ログ・エラーの文に出さない
//   - RoboRobo が止まっていても、ツールの保存・SF の申請は止めない（依頼待ちに残し、間をあけて送り直す・5 回でエラー）
//   - 同じ結果が何度届いても 1 回分（実行 ID で取り込む・DB の antisocial_apply_result）
//   - 1 回の定時実行で送るのは 100 件・取りに行くのは 30 件まで（残りは次の回）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VERSION = '2026-11-15.1';
const BASE = 'https://compliance-api.roborobo.co.jp';
const SEND_MAX = 100;        // 1 回で送る件数（RoboRobo は 1 回 1,000 件まで）
const MAX_ATTEMPTS = 5;      // 送れなかったときの送り直しの上限（10・20・40・80 分あける）
const POLL_AFTER_MIN = 20;   // 送ってから結果が届かないまま、この分を過ぎたら取りに行く
const POLL_MAX = 30;         // 1 回で取りに行く件数（10 件ずつ）
const GIVE_UP_HOURS = 24;    // これを過ぎても結果が出なければエラー
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-import-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// deno-lint-ignore no-explicit-any
type Any = any;
type Admin = ReturnType<typeof createClient>;
type Setting = { enabled: boolean; use_prod_token: boolean; auto_rule: string; check_rep: boolean };

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const env = (k: string) => (Deno.env.get(k) || '').trim();
const tokenOf = (isTest: boolean) => env(isTest ? 'ROBOROBO_API_TOKEN_TEST' : 'ROBOROBO_API_TOKEN') || null;
const jstDate = (addDays = 0) => new Date(Date.now() + 9 * 3600e3 + addDays * 86400e3).toISOString().slice(0, 10);
const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// ---------------- RoboRobo ----------------
async function rr(tok: string, method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: Any = null;
  try { data = JSON.parse(text); } catch { /* 本文が JSON でない */ }
  return { status: res.status, ok: res.ok, data, text };
}

// 人が読める失敗の言葉（トークンは出さない）
function rrError(r: { status: number; data: Any; text: string }): string {
  const code = r.data && r.data.code;
  const msg = String((r.data && r.data.message) || r.text || '').slice(0, 200);
  if (r.status === 403 && code === 200) return 'IP 制限（RoboRobo の設定で、この接続元が許されていません）: ' + msg;
  if (r.status === 403 && code === 201) return 'API の実行権限がありません（RoboRobo のアカウントの設定）: ' + msg;
  if (r.status === 403 && code === 300) return '契約に無い検索です: ' + msg;
  if (r.status === 401) return 'トークンが無効です（Secrets のトークンを確かめてください）';
  if (r.status === 400) return '頼み方の誤り（400）: ' + msg;
  if (r.status === 404) return '見つかりません（404）: ' + msg;
  if (r.status >= 500) return `RoboRobo の障害（${r.status}）。時間をおいて送り直します: ` + msg;
  return `RoboRobo の返事 ${r.status}: ` + msg;
}

function callbackUrl() {
  return `${env('SUPABASE_URL')}/functions/v1/antisocial-check?action=callback&k=${encodeURIComponent(env('ANTISOCIAL_CALLBACK_SECRET'))}`;
}

async function getSetting(admin: Admin): Promise<Setting> {
  const { data, error } = await admin.from('antisocial_setting').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error('設定が読めません（antisocial_check.sql を流しましたか）: ' + error.message);
  return (data || { enabled: false, use_prod_token: false, auto_rule: 'zero_hits', check_rep: true }) as Setting;
}

async function log(admin: Admin, kind: 'run' | 'error', action: string, trigger: string, counts: Any, message?: string, companyIds?: string[], isTest?: boolean) {
  await admin.from('integration_log').insert({
    system: 'roborobo', target: isTest === undefined ? 'RoboRobo' : (isTest ? 'RoboRobo（テスト環境）' : 'RoboRobo（本番）'),
    kind, action, trigger, actor: 'antisocial-check', counts, company_ids: companyIds && companyIds.length ? companyIds : null,
    message: message ? message.slice(0, 1000) : null, meta: { version: VERSION },
  }).then(() => undefined, () => undefined);   // 記録の失敗で本体を止めない
}

// ---------------- 送る（依頼待ち → 調査中） ----------------
async function sendQueued(admin: Admin, onlyCompany?: string) {
  const nowIso = new Date().toISOString();
  let q = admin.from('compliance_check_item')
    .select('item_id,check_id,company_id,subject,name_sent,relative_word,management_number,entity_type,folder_name,attempts,next_try_at,compliance_check!inner(is_test)')
    .eq('state', '依頼待ち').order('item_id').limit(SEND_MAX);
  if (onlyCompany) q = q.eq('company_id', onlyCompany);
  const { data, error } = await q;
  if (error) throw new Error('依頼待ちが読めません: ' + error.message);
  const items = (data || []).filter((x: Any) => !x.next_try_at || x.next_try_at <= nowIso);
  const out = { sent: 0, failed: 0, errors: [] as string[], companies: new Set<string>() };
  // RoboRobo の 1 回の依頼はフォルダが 1 つ＝試しかどうかとフォルダで分けて送る
  const groups = new Map<string, Any[]>();
  for (const it of items) {
    const isTest = !!(it.compliance_check && it.compliance_check.is_test);
    const key = `${isTest ? 'T' : 'P'}|${it.folder_name || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(Object.assign(it, { is_test: isTest }));
  }
  for (const [key, list] of groups) {
    const isTest = key.startsWith('T|');
    const tok = tokenOf(isTest);
    const failAll = async (msg: string) => {
      for (const it of list) {
        const attempts = (it.attempts || 0) + 1;
        const giveUp = attempts >= MAX_ATTEMPTS;
        await admin.from('compliance_check_item').update({
          attempts, error_text: msg.slice(0, 500), updated_at: new Date().toISOString(),
          ...(giveUp ? { state: 'エラー', next_try_at: null } : { next_try_at: new Date(Date.now() + 10 * 60e3 * 2 ** (attempts - 1)).toISOString() }),
        }).eq('item_id', it.item_id);
        out.failed++;
      }
      out.errors.push(msg);
    };
    if (!tok) { await failAll(isTest ? 'テスト環境のトークン（ROBOROBO_API_TOKEN_TEST）が Secrets にありません' : '本番のトークン（ROBOROBO_API_TOKEN）が Secrets にありません'); continue; }
    if (!env('ANTISOCIAL_CALLBACK_SECRET')) { await failAll('結果の送付の合言葉（ANTISOCIAL_CALLBACK_SECRET）が Secrets にありません'); continue; }
    const checkList = list.map((it: Any) => {
      const e: Any = { customerName: it.name_sent };
      if (it.relative_word) e.relativeWord = it.relative_word;
      if (it.management_number) e.managementNumber = it.management_number;
      if (it.entity_type) e.entityType = it.entity_type;
      return e;
    });
    const body: Any = { checkList, responseTarget: { url: callbackUrl(), token: env('SUPABASE_ANON_KEY') } };
    if (list[0].folder_name) body.folderName = list[0].folder_name;
    let r;
    try { r = await rr(tok, 'POST', '/v2/execution', body); } catch (e) { await failAll('RoboRobo につながりません: ' + String((e as Error).message || e)); continue; }
    if (!r.ok || !r.data || !Array.isArray(r.data.checkList)) { await failAll(r.ok ? 'RoboRobo の返事の形が違います' : rrError(r)); continue; }
    const resp: Any[] = r.data.checkList;
    const keyOf = (n: Any, rel: Any, mng: Any) => `${n || ''}|${rel || ''}|${mng || ''}`;
    const byKey = new Map(resp.map((x: Any) => [keyOf(x.customerName, x.relativeWord, x.managementNumber), x]));
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const m = byKey.get(keyOf(it.name_sent, it.relative_word, it.management_number)) || (resp.length === list.length ? resp[i] : null);
      await admin.from('compliance_check_item').update({
        state: '調査中', sent_at: new Date().toISOString(), attempts: (it.attempts || 0) + 1, next_try_at: null, error_text: null,
        rr_customer_id: m && m.customerId ? m.customerId : null, rr_execution_id: m && m.checkExecutionId ? m.checkExecutionId : null,
        updated_at: new Date().toISOString(),
      }).eq('item_id', it.item_id).eq('state', '依頼待ち');   // 送るあいだに結果が先に届いていたら（＝調査中でない）触らない
      out.sent++;
      out.companies.add(it.company_id);
    }
  }
  return out;
}

// ---------------- 届かない結果を取りに行く ----------------
async function pollStale(admin: Admin, onlyCompany?: string) {
  let q = admin.from('compliance_check_item')
    .select('item_id,company_id,rr_customer_id,rr_execution_id,sent_at,compliance_check!inner(is_test)')
    .eq('state', '調査中').not('rr_customer_id', 'is', null).order('sent_at').limit(POLL_MAX);
  if (onlyCompany) q = q.eq('company_id', onlyCompany);
  else q = q.lt('sent_at', new Date(Date.now() - POLL_AFTER_MIN * 60e3).toISOString());
  const { data, error } = await q;
  if (error) throw new Error('調査中が読めません: ' + error.message);
  const out = { polled: 0, applied: 0, gaveUp: 0, errors: [] as string[] };
  const byToken = new Map<boolean, Any[]>();
  for (const it of data || []) {
    const isTest = !!(it.compliance_check && it.compliance_check.is_test);
    if (!byToken.has(isTest)) byToken.set(isTest, []);
    byToken.get(isTest)!.push(it);
  }
  for (const [isTest, list] of byToken) {
    const tok = tokenOf(isTest);
    if (!tok) continue;
    const withExec = list.filter((x: Any) => x.rr_execution_id);
    const onlyCust = list.filter((x: Any) => !x.rr_execution_id);
    const calls: Array<[string, Any]> = [
      ...chunk(withExec, 10).map((c) => ['/v2/execution/detail-history', { executionList: c.map((x: Any) => ({ customerId: x.rr_customer_id, checkExecutionId: x.rr_execution_id })), limit: 200 }] as [string, Any]),
      ...chunk(onlyCust, 10).map((c) => ['/v2/execution/detail', { customerId: c.map((x: Any) => x.rr_customer_id), limit: 200 }] as [string, Any]),
    ];
    for (const [path, body] of calls) {
      out.polled += (body.executionList || body.customerId).length;
      const r = await rr(tok, 'POST', path, body).catch((e) => ({ status: 0, ok: false, data: null, text: String(e) }));
      if (!r.ok || !r.data) { out.errors.push(rrError(r)); continue; }
      const { data: n, error: aErr } = await admin.rpc('antisocial_apply_result', { p: r.data });
      if (aErr) { out.errors.push('結果の取り込みに失敗: ' + aErr.message); continue; }
      out.applied += Number(n || 0);
    }
    // 長く結果が出ないものはエラーにする（もう一度は画面の［反社チェックを流す］）
    const limit = Date.now() - GIVE_UP_HOURS * 3600e3;
    for (const it of list) {
      if (it.sent_at && new Date(it.sent_at).getTime() < limit) {
        const { count } = await admin.from('compliance_check_item').update({ state: 'エラー', error_text: `結果が ${GIVE_UP_HOURS} 時間届きません`, updated_at: new Date().toISOString() }, { count: 'exact' })
          .eq('item_id', it.item_id).eq('state', '調査中');
        out.gaveUp += count || 0;
      }
    }
  }
  return out;
}

// ---------------- 取引判断を取り込む ----------------
async function syncDecisions(admin: Admin, isTest: boolean, days: number, force: boolean) {
  const out = { fetched: 0, applied: 0, errors: [] as string[] };
  const tok = tokenOf(isTest);
  if (!tok) return out;
  if (!force) {
    // 判断待ちが無く、毎時の見回りでもなければ呼ばない（呼び出しの回数を増やさない）
    const { count } = await admin.from('compliance_check_item').select('item_id, compliance_check!inner(is_test)', { count: 'exact', head: true })
      .eq('state', '要確認').eq('compliance_check.is_test', isTest);
    if (!count && new Date().getUTCMinutes() >= 10) return out;
  }
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await rr(tok, 'POST', '/v2/check-decision/list', { updatedAtFrom: jstDate(-days), updatedAtTo: jstDate(0), limit: 100, offset })
      .catch((e) => ({ status: 0, ok: false, data: null, text: String(e) }));
    if (!r.ok || !r.data) { out.errors.push(rrError(r)); break; }
    const list = Array.isArray(r.data.checkDecisionList) ? r.data.checkDecisionList : [];
    out.fetched += list.length;
    if (list.length) {
      const { data: n, error } = await admin.rpc('antisocial_apply_decisions', { p: { checkDecisionList: list } });
      if (error) { out.errors.push('取引判断の取り込みに失敗: ' + error.message); break; }
      out.applied += Number(n || 0);
    }
    if (list.length < 100) break;
  }
  return out;
}

async function roundOf(admin: Admin, companyId: string) {
  const { data } = await admin.from('compliance_check').select('*, compliance_check_item(*)')
    .eq('company_id', companyId).eq('source', 'roborobo').order('check_id', { ascending: false }).limit(1);
  const c: Any = (data || [])[0] || null;
  if (c && Array.isArray(c.compliance_check_item)) {
    c.items = c.compliance_check_item.map((x: Any) => { const { payload: _p, ...rest } = x; return rest; });  // 画面へは届いた内容そのものは返さない
    delete c.compliance_check_item;
  }
  return c;
}

// ---------------- 入口 ----------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const t0 = Date.now();
  const url = new URL(req.url);
  const admin: Admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  // --- a) 結果の送付（RoboRobo から） ---
  if (url.searchParams.get('action') === 'callback') {
    const secret = env('ANTISOCIAL_CALLBACK_SECRET');
    if (!secret || url.searchParams.get('k') !== secret) return json({ error: 'forbidden' }, 403);
    const body: Any = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.resultList)) {
      // 結果の組み立てに失敗したとき RoboRobo は code／message だけを送ってくる＝記録して 200（送り直しは要らない）
      await log(admin, 'error', 'callback', '自動（RoboRobo の結果の送付）', { received: 0 }, 'RoboRobo から結果でない送付: ' + JSON.stringify(body).slice(0, 300));
      return json({ ok: true, applied: 0 });
    }
    const { data: n, error } = await admin.rpc('antisocial_apply_result', { p: body });
    if (error) {
      await log(admin, 'error', 'callback', '自動（RoboRobo の結果の送付）', { received: body.resultList.length }, '結果の取り込みに失敗: ' + error.message);
      return json({ ok: false, error: '取り込みに失敗しました' }, 500);   // 500 なら RoboRobo が送り直す
    }
    await log(admin, 'run', 'callback', '自動（RoboRobo の結果の送付）', { received: body.resultList.length, applied: Number(n || 0) }, undefined,
      body.resultList.map((x: Any) => String(x.managementNumber || '').replace(/-R$/, '')).filter(Boolean));
    return json({ ok: true, applied: Number(n || 0) });
  }

  try {
    // --- b) 定時実行／c) 画面 ---
    let actor = 'cron';
    const importSecret = env('IMPORT_SECRET');
    const isCron = !!importSecret && req.headers.get('x-import-secret') === importSecret;
    if (!isCron) {
      const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
      if (!jwt) return json({ error: '未認証です' }, 401);
      const { data: u, error: uErr } = await admin.auth.getUser(jwt);
      if (uErr || !u?.user) return json({ error: '認証が無効です' }, 401);
      const { data: role } = await admin.from('user_roles').select('role').eq('user_id', u.user.id).maybeSingle();
      if (!['admin', 'accounting'].includes(String(role?.role))) return json({ error: '管理者か経理の権限が必要です' }, 403);
      actor = u.user.email || u.user.id;
    }
    const body: Any = await req.json().catch(() => ({}));
    const action = String(body.action || (isCron ? 'tick' : 'probe'));
    const setting = await getSetting(admin);

    if (action === 'probe') {
      const res: Any = {};
      for (const isTest of [true, false]) {
        const tok = tokenOf(isTest);
        const name = isTest ? 'test' : 'prod';
        if (!tok) { res[name] = { token: false }; continue; }
        const c = await rr(tok, 'GET', `/v2/execution-count?startDate=${jstDate(0).slice(0, 8)}01&endDate=${jstDate(0)}`).catch((e) => ({ status: 0, ok: false, data: null, text: String(e) }));
        const g = await rr(tok, 'GET', '/v2/get-group').catch((e) => ({ status: 0, ok: false, data: null, text: String(e) }));
        res[name] = { token: true, count_ok: c.ok, month_count: c.ok ? c.data?.count : null, groups: g.ok ? (g.data?.groupList || []).map((x: Any) => x.name) : null,
          error: !c.ok ? rrError(c) : (!g.ok ? rrError(g) : null) };
      }
      const { count: queued } = await admin.from('compliance_check_item').select('item_id', { count: 'exact', head: true }).eq('state', '依頼待ち');
      const { count: reviewing } = await admin.from('compliance_check_item').select('item_id', { count: 'exact', head: true }).eq('state', '要確認');
      return json({ ok: true, version: VERSION, setting, callback_secret: !!env('ANTISOCIAL_CALLBACK_SECRET'), roborobo: res, queued, reviewing, ms: Date.now() - t0 });
    }

    if (action === 'request') {
      if (isCron) return json({ error: 'request は画面から' }, 400);
      const cid = String(body.company_id || '');
      if (!cid) return json({ error: 'company_id が要ります' }, 400);
      const isTest = !setting.use_prod_token;
      const { data: checkId, error } = await admin.rpc('antisocial_enqueue', { p_company_id: cid, p_trigger: '手動', p_ref: null, p_is_test: isTest, p_by: actor });
      if (error) return json({ ok: false, error: error.message }, 400);
      if (!checkId) {
        const cur = await roundOf(admin, cid);
        return json({ ok: true, skipped: true, reason: cur && ['調査中', '要確認'].includes(cur.result) ? `調べている途中か判断待ちの回があります（${cur.result}）` : '試験の会社は流しません', round: cur });
      }
      const s = await sendQueued(admin, cid);
      await log(admin, s.failed ? 'error' : 'run', 'request', '手動（アプリ）', { sent: s.sent, failed: s.failed }, s.errors.join(' / ') || undefined, [cid], isTest);
      return json({ ok: s.failed === 0, sent: s.sent, failed: s.failed, error: s.errors[0] || null, round: await roundOf(admin, cid), ms: Date.now() - t0 });
    }

    if (action === 'sync') {
      if (isCron) return json({ error: 'sync は画面から' }, 400);
      const cid = String(body.company_id || '');
      if (!cid) return json({ error: 'company_id が要ります' }, 400);
      const s = await sendQueued(admin, cid);
      const p = await pollStale(admin, cid);
      const dT = await syncDecisions(admin, true, 7, true);
      const dP = setting.use_prod_token ? await syncDecisions(admin, false, 7, true) : { fetched: 0, applied: 0, errors: [] };
      const errors = [...s.errors, ...p.errors, ...dT.errors, ...dP.errors];
      return json({ ok: errors.length === 0, sent: s.sent, applied: p.applied, decisions: dT.applied + dP.applied, error: errors[0] || null, round: await roundOf(admin, cid), ms: Date.now() - t0 });
    }

    if (action === 'tick') {
      let enq: Any = { enabled: setting.enabled };
      if (setting.enabled) {
        const { data, error } = await admin.rpc('antisocial_enqueue_due');
        if (error) throw new Error('決まりに沿って頼む処理に失敗: ' + error.message);
        enq = data;
      }
      const s = await sendQueued(admin);
      const p = await pollStale(admin);
      const dT = await syncDecisions(admin, true, 1, false);
      const dP = setting.use_prod_token ? await syncDecisions(admin, false, 1, false) : { fetched: 0, applied: 0, errors: [] };
      const errors = [...s.errors, ...p.errors, ...dT.errors, ...dP.errors];
      const counts = { enqueued: (enq.credit || 0) + (enq.register || 0) + (enq.periodic || 0), enq, sent: s.sent, failed: s.failed,
        polled: p.polled, applied: p.applied, gave_up: p.gaveUp, decisions: dT.applied + dP.applied };
      const happened = counts.enqueued || s.sent || s.failed || p.applied || p.gaveUp || counts.decisions || errors.length;
      if (happened) await log(admin, errors.length ? 'error' : 'run', 'tick', isCron ? '自動（定時）' : '手動（アプリ）', counts, errors.join(' / ') || undefined, [...s.companies]);
      return json({ ok: errors.length === 0, version: VERSION, ...counts, errors, ms: Date.now() - t0 });
    }

    return json({ error: `不明な action: ${action}` }, 400);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    await log(admin, 'error', 'error', '-', {}, msg);
    return json({ ok: false, error: msg, version: VERSION }, 500);
  }
});
