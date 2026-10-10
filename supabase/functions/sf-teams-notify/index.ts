// SF の承認待ち・回覧 → Teams 通知 Edge Function（sf-teams-notify）— 2026-10-10 第 1 段
//
// 役割：Salesforce の「あなた宛ての承認待ち」（ProcessInstanceWorkitem）と「回覧」（Circulation__c）を数分おきに拾い、
//       宛先の人へ Teams のカード（要旨＋「Salesforce で開く」）で知らせる。SF→Teams の一方向・知らせるだけ。
//       承認・既読は SF で付ける（Teams から SF へは何も書かない＝正は SF の一つ）。
//       Teams 側は Workflows（Power Automate）の「Teams Webhook 要求を受信したとき」→ Flow bot で宛先へ個人チャット。
//       手順書＝supabase/PHASE_TEAMS_NOTIFY_SETUP.md
//
// 認証（sf-export と同じ・どちらかを満たすこと）：
//   a) Supabase JWT が admin ロール
//   b) x-import-secret ヘッダが IMPORT_SECRET と一致（cron 用）
//
// POST body：
//   action … dry_run（既定・送らず記録もせず、送る予定の一覧を返す）／send（送る）／ping（テストの宛先へ接続テストのカードを 1 枚）
//   source … 実行元の名乗り（cron / script / app）
//   最初の send（送信記録が空のとき）は、その時点で SF にある分を「起点」として記録するだけで送らない
//   （動かし始める前からある承認待ち・回覧を一斉に送らないため）。
//
// 必要な Secrets：
//   SF_EXPORT_INSTANCE_URL / SF_EXPORT_CLIENT_ID / SF_EXPORT_CLIENT_SECRET / SF_EXPORT_ALLOWED_ORG_IDS（sf-export と共通＝dev6）
//   IMPORT_SECRET（sf-import・sf-export と共通）
//   TEAMS_WEBHOOK_URL    … Workflows の Webhook の URL（合鍵と同じ。リポジトリ・チャットに書かない）
//   TEAMS_TEST_RECIPIENT … テスト中の送り先（メール）。設定されている間は、本来の宛先に関係なく全部ここへ送る
//   TEAMS_LIVE           … 'true' のときだけ本来の宛先へ送る（TEAMS_TEST_RECIPIENT を消したうえで設定する）
//
// 安全鉄則：
//   - TEAMS_TEST_RECIPIENT も TEAMS_LIVE=true も無ければ誰にも送らない（dev6 のメールは末尾 .invalid を外すと実在の社員）
//   - TEAMS_LIVE=true でも、宛先のメールが .invalid で終わる（サンドボックスのまま）なら送らない
//   - 送る前に teams_notify_log へ主キー（SF の Id）で行を入れ、入れられた分だけ送る＝二重起動でも 1 回
//   - 送れなかった分は、SF でまだ対象（承認待ちのまま・3 日以内）なら次の回で最大 MAX_ATTEMPTS 回まで送り直す

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-import-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const API_VERSION = 'v61.0';
const VERSION = '2026-10-10.2';
const LOG = 'teams_notify_log';
const LOOKBACK = 'LAST_N_DAYS:3'; // これより古い承認待ち・回覧は拾わない（送り直しもしない）
const MAX_SEND_PER_RUN = 30;      // 1 回で送る上限（残りは次の回）
const MAX_ATTEMPTS = 3;

// 承認の対象（ApprovalTarget の 4 種・sobjectName と回覧の参照項目）
const TARGETS: Record<string, { label: string; circulationLookup: string }> = {
  quoteManagement__c:        { label: '見積',     circulationLookup: 'Quote__c' },
  SalesDepartmentProject__c: { label: '案件（受注）', circulationLookup: 'Project__c' },
  Construction__c:           { label: '工事',     circulationLookup: 'Construction__c' },
  ExecBudget_AtsuH__c:       { label: '実行予算', circulationLookup: 'Budget__c' },
};
const CIRC_LOOKUPS = ['Project__c', 'Quote__c', 'Budget__c', 'Construction__c'];

type Admin = ReturnType<typeof createClient>;
type Sf = { base: string; token: string; orgId: string; orgName: string };
type Item = {
  sf_id: string; kind: 'approval' | 'circulation'; record_id: string | null; record_name: string | null; title: string;
  recipient_name: string; recipient_email: string; sf_created_at: string; facts: { title: string; value: string }[];
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function jst(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function yen(v: unknown): string {
  const n = Number(v);
  return v === null || v === undefined || v === '' || isNaN(n) ? '' : n.toLocaleString('ja-JP') + ' 円';
}
const soqlIn = (vals: string[]) => vals.map((v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
// deno-lint-ignore no-explicit-any
const get = (o: any, path: string): any => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

// ---------------- Salesforce（sf-export と同じ扉・同じ安全弁） ----------------
async function sfConnect(): Promise<Sf> {
  const base = (Deno.env.get('SF_EXPORT_INSTANCE_URL') || '').replace(/\/+$/, '');
  const clientId = Deno.env.get('SF_EXPORT_CLIENT_ID');
  const clientSecret = Deno.env.get('SF_EXPORT_CLIENT_SECRET');
  if (!base || !clientId || !clientSecret) throw new Error('SF_EXPORT_INSTANCE_URL / SF_EXPORT_CLIENT_ID / SF_EXPORT_CLIENT_SECRET のSecretsが未設定です');
  const tokenRes = await fetch(base + '/services/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok || !tokenBody.access_token) throw new Error('SFトークン取得失敗: ' + JSON.stringify(tokenBody).slice(0, 300));
  const sf: Sf = { base, token: tokenBody.access_token, orgId: '', orgName: '' };
  const org = await sfQuery(sf, 'SELECT Id, Name FROM Organization');
  sf.orgId = String(org[0]?.Id || '').slice(0, 15);
  sf.orgName = String(org[0]?.Name || '');
  const allowed = (Deno.env.get('SF_EXPORT_ALLOWED_ORG_IDS') || '').split(',').map((s) => s.trim().slice(0, 15)).filter(Boolean);
  if (!allowed.includes(sf.orgId)) throw new Error(`接続先 org ${sf.orgId}（${sf.orgName}）は SF_EXPORT_ALLOWED_ORG_IDS に含まれていません。安全のため中止しました`);
  return sf;
}
async function sfQuery(sf: Sf, soql: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let url = `${sf.base}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  for (;;) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + sf.token } });
    const body = await res.json();
    if (!res.ok) throw new Error('SOQL失敗: ' + JSON.stringify(body).slice(0, 300));
    out.push(...(body.records || []));
    if (body.done || !body.nextRecordsUrl) return out;
    url = sf.base + body.nextRecordsUrl;
  }
}

// ---------------- 拾う ----------------
async function loadApprovals(sf: Sf): Promise<Item[]> {
  const rows = await sfQuery(sf, `SELECT Id, ActorId, Actor.Name, Actor.Email, CreatedDate,
      ProcessInstance.TargetObjectId, ProcessInstance.TargetObject.Name, ProcessInstance.TargetObject.Type,
      ProcessInstance.SubmittedBy.Name
    FROM ProcessInstanceWorkitem
    WHERE ProcessInstance.Status = 'Pending' AND CreatedDate = ${LOOKBACK}
    ORDER BY CreatedDate ASC`);
  // 判定金額（申請時に固定した ApprovalAmount__c）とルート名を対象ごとに 1 回で読む
  const byType: Record<string, string[]> = {};
  for (const r of rows) {
    const type = String(get(r, 'ProcessInstance.TargetObject.Type') || '');
    if (TARGETS[type]) (byType[type] ||= []).push(String(get(r, 'ProcessInstance.TargetObjectId')));
  }
  const extra: Record<string, Record<string, unknown>> = {};
  for (const [type, ids] of Object.entries(byType)) {
    for (const x of await sfQuery(sf, `SELECT Id, ApprovalAmount__c, ApprovalRouteName__c FROM ${type} WHERE Id IN (${soqlIn([...new Set(ids)])})`)) {
      extra[String(x.Id)] = x;
    }
  }
  return rows.map((r) => {
    const type = String(get(r, 'ProcessInstance.TargetObject.Type') || '');
    const recId = String(get(r, 'ProcessInstance.TargetObjectId') || '');
    const name = String(get(r, 'ProcessInstance.TargetObject.Name') || '');
    const ex = extra[recId] || {};
    const label = TARGETS[type]?.label || type;
    const facts = [
      { title: '種類', value: label },
      { title: '件名', value: name },
      { title: '金額', value: yen(ex.ApprovalAmount__c) },
      { title: 'ルート', value: String(ex.ApprovalRouteName__c || '') },
      { title: '申請者', value: String(get(r, 'ProcessInstance.SubmittedBy.Name') || '') },
      { title: '届いた時刻', value: jst(String(r.CreatedDate)) },
    ].filter((f) => f.value);
    return {
      sf_id: String(r.Id), kind: 'approval' as const, record_id: recId || null, record_name: name || null,
      title: `承認待ちです：${label}「${name}」`,
      recipient_name: String(get(r, 'Actor.Name') || ''), recipient_email: String(get(r, 'Actor.Email') || ''),
      sf_created_at: String(r.CreatedDate), facts,
    };
  });
}

async function loadCirculations(sf: Sf): Promise<Item[]> {
  const rows = await sfQuery(sf, `SELECT Id, Recipient__r.Name, Recipient__r.Email, Kind__c, Summary__c, CreatedBy.Name, CreatedDate,
      ${CIRC_LOOKUPS.join(', ')}, ${CIRC_LOOKUPS.map((f) => f.replace(/__c$/, '__r') + '.Name').join(', ')}
    FROM Circulation__c
    WHERE CreatedDate = ${LOOKBACK}
    ORDER BY CreatedDate ASC`);
  return rows.map((r) => {
    const lookup = CIRC_LOOKUPS.find((f) => r[f]);
    const recId = lookup ? String(r[lookup]) : null;
    const name = lookup ? String(get(r, lookup.replace(/__c$/, '__r') + '.Name') || '') : '';
    const label = lookup ? (Object.values(TARGETS).find((t) => t.circulationLookup === lookup)?.label || '') : '';
    const facts = [
      { title: '種類', value: label ? `${label}の回覧（${r.Kind__c || ''}）` : `回覧（${r.Kind__c || ''}）` },
      { title: '件名', value: name },
      { title: '要旨', value: String(r.Summary__c || '') },
      { title: '回した人', value: String(get(r, 'CreatedBy.Name') || '') },
      { title: '届いた時刻', value: jst(String(r.CreatedDate)) },
    ].filter((f) => f.value);
    return {
      sf_id: String(r.Id), kind: 'circulation' as const, record_id: recId, record_name: name || null,
      title: name ? `回覧が届きました：${label}「${name}」` : '回覧が届きました',
      recipient_name: String(get(r, 'Recipient__r.Name') || ''), recipient_email: String(get(r, 'Recipient__r.Email') || ''),
      sf_created_at: String(r.CreatedDate), facts,
    };
  });
}

// ---------------- 送る ----------------
// 送り先：テスト中は全部 TEAMS_TEST_RECIPIENT。本番の宛先へは TEAMS_LIVE=true のときだけ
function resolveTo(it: Item): { to: string | null; reason?: string } {
  const test = (Deno.env.get('TEAMS_TEST_RECIPIENT') || '').trim();
  if (test) return { to: test };
  if (Deno.env.get('TEAMS_LIVE') !== 'true') return { to: null, reason: 'TEAMS_TEST_RECIPIENT も TEAMS_LIVE=true も無いため送りません' };
  if (!it.recipient_email) return { to: null, reason: '宛先のメールが空です' };
  if (/\.invalid$/i.test(it.recipient_email)) return { to: null, reason: `宛先のメールがサンドボックスのまま（${it.recipient_email}）` };
  return { to: it.recipient_email };
}

function buildCard(it: Item, sf: Sf, testMode: boolean) {
  // deno-lint-ignore no-explicit-any
  const body: any[] = [];
  if (testMode) {
    body.push({ type: 'TextBlock', wrap: true, size: 'Small', color: 'Warning',
      text: `テスト送信（${sf.orgName}）：本来の宛先は ${it.recipient_name || '不明'} さんです` });
  }
  body.push({ type: 'TextBlock', wrap: true, weight: 'Bolder', size: 'Medium', text: it.title });
  body.push({ type: 'FactSet', facts: it.facts });
  if (!it.record_id) body.push({ type: 'TextBlock', wrap: true, size: 'Small', isSubtle: true, text: '元のレコードが見つかりません（削除された可能性があります）' });
  return {
    type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body,
    actions: it.record_id ? [{ type: 'Action.OpenUrl', title: 'Salesforce で開く', url: `${sf.base}/${it.record_id}` }] : [],
  };
}

async function postTeams(url: string, to: string, card: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] }),
  });
  if (res.ok) return null;
  return `Teams Webhook ${res.status}: ${(await res.text()).slice(0, 300)}`;
}

// ---------------- 入口 ----------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const t0 = Date.now();
  try {
    const admin: Admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

    // --- 認証（sf-export と同じ） ---
    const importSecret = Deno.env.get('IMPORT_SECRET');
    if (!(importSecret && req.headers.get('x-import-secret') === importSecret)) {
      const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
      if (!jwt) return json({ error: '未認証です' }, 401);
      const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
      if (uErr || !userData?.user) return json({ error: '認証が無効です' }, 401);
      const { data: role } = await admin.from('user_roles').select('role').eq('user_id', userData.user.id).maybeSingle();
      if (role?.role !== 'admin') return json({ error: '管理者権限が必要です' }, 403);
    }
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'dry_run');
    if (!['dry_run', 'send', 'ping'].includes(action)) return json({ error: `不明な action: ${action}` }, 400);

    // --- ping：テストの宛先へテストカードを 1 枚だけ送る（Webhook が匿名で呼べるか・カードが届くかの確認。SF は読まない・記録しない） ---
    if (action === 'ping') {
      const webhook = Deno.env.get('TEAMS_WEBHOOK_URL');
      const to = (Deno.env.get('TEAMS_TEST_RECIPIENT') || '').trim();
      if (!webhook || !to) return json({ ok: false, error: 'ping は TEAMS_WEBHOOK_URL と TEAMS_TEST_RECIPIENT の両方が要ります' }, 400);
      const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4',
        body: [{ type: 'TextBlock', wrap: true, weight: 'Bolder', text: '統合管理ツールからの接続テストです' },
          { type: 'TextBlock', wrap: true, size: 'Small', isSubtle: true, text: `sf-teams-notify ${VERSION}・このカードが届けば Webhook と Flow bot はつながっています` }] };
      const err = await postTeams(webhook, to, card).catch((e) => String(e?.message || e));
      return json({ ok: !err, action, version: VERSION, ...(err ? { error: err } : {}), ms: Date.now() - t0 });
    }

    const sf = await sfConnect();
    const items = [...await loadApprovals(sf), ...await loadCirculations(sf)];
    const testMode = !!(Deno.env.get('TEAMS_TEST_RECIPIENT') || '').trim();

    // 既に記録のある分（送った・起点・送り中・失敗）
    const ids = items.map((i) => i.sf_id);
    const known = new Map<string, { status: string; attempts: number }>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await admin.from(LOG).select('sf_id, status, attempts').in('sf_id', ids.slice(i, i + 200));
      if (error) throw new Error('送信記録の読取に失敗: ' + error.message);
      for (const r of data || []) known.set(r.sf_id, { status: r.status, attempts: r.attempts });
    }
    const fresh = items.filter((i) => !known.has(i.sf_id));
    const retry = items.filter((i) => known.get(i.sf_id)?.status === 'error' && known.get(i.sf_id)!.attempts < MAX_ATTEMPTS);
    const summary = { version: VERSION, org: sf.orgName, test_mode: testMode, found: items.length, fresh: fresh.length, retry: retry.length };

    if (action === 'dry_run') {
      return json({ ok: true, action, ...summary,
        would_send: [...fresh, ...retry].slice(0, MAX_SEND_PER_RUN).map((i) => ({ sf_id: i.sf_id, kind: i.kind, title: i.title, recipient: i.recipient_name, to: resolveTo(i).to, reason: resolveTo(i).reason })),
        ms: Date.now() - t0 });
    }

    // --- 最初の 1 回は起点を記録するだけ（記録が 1 行も無いとき） ---
    const { count, error: cErr } = await admin.from(LOG).select('sf_id', { count: 'exact', head: true });
    if (cErr) throw new Error('送信記録の件数取得に失敗: ' + cErr.message);
    if (!count) {
      // 起点の目印（対象が 0 件のときも「起点は済んだ」と分かるように 1 行入れる）
      const rows: Record<string, unknown>[] = [{ sf_id: '__baseline__', kind: 'marker', status: 'baseline', title: '起点' }];
      rows.push(...items.map((i) => ({ sf_id: i.sf_id, kind: i.kind, status: 'baseline', record_id: i.record_id, record_name: i.record_name,
        title: i.title, recipient_name: i.recipient_name, recipient_email: i.recipient_email, sf_created_at: i.sf_created_at })));
      const { error } = await admin.from(LOG).upsert(rows, { onConflict: 'sf_id', ignoreDuplicates: true });
      if (error) throw new Error('起点の記録に失敗: ' + error.message);
      return json({ ok: true, action, ...summary, baseline: items.length, note: '初回のため起点を記録しました（送っていません）。次の回から新しく来た分を送ります', ms: Date.now() - t0 });
    }

    const webhook = Deno.env.get('TEAMS_WEBHOOK_URL');
    if (!webhook) throw new Error('TEAMS_WEBHOOK_URL のSecretが未設定です');
    if (!testMode && Deno.env.get('TEAMS_LIVE') !== 'true') throw new Error('TEAMS_TEST_RECIPIENT も TEAMS_LIVE=true も無いため送りません（記録も付けません）');

    // --- 取り合い：新しい分は行を入れられた分だけ、送り直しは失敗の行を書き換えられた分だけが自分の担当 ---
    const mine: Item[] = [];
    for (const it of fresh.slice(0, MAX_SEND_PER_RUN)) {
      const { data, error } = await admin.from(LOG).upsert([{ sf_id: it.sf_id, kind: it.kind, status: 'claimed', record_id: it.record_id,
        record_name: it.record_name, title: it.title, recipient_name: it.recipient_name, recipient_email: it.recipient_email,
        sf_created_at: it.sf_created_at }], { onConflict: 'sf_id', ignoreDuplicates: true }).select('sf_id');
      if (error) throw new Error('送信記録の書込に失敗: ' + error.message);
      if (data && data.length) mine.push(it);
    }
    for (const it of retry.slice(0, Math.max(0, MAX_SEND_PER_RUN - mine.length))) {
      const prev = known.get(it.sf_id)!;
      const { data, error } = await admin.from(LOG).update({ status: 'claimed', attempts: prev.attempts + 1, error: null })
        .eq('sf_id', it.sf_id).eq('status', 'error').eq('attempts', prev.attempts).select('sf_id');
      if (error) throw new Error('送信記録の書込に失敗: ' + error.message);
      if (data && data.length) mine.push(it);
    }

    const results: { sf_id: string; title: string; to: string | null; ok: boolean; error?: string }[] = [];
    for (const it of mine) {
      const { to, reason } = resolveTo(it);
      let err: string | null = reason || null;
      if (to) err = await postTeams(webhook, to, buildCard(it, sf, testMode)).catch((e) => String(e?.message || e));
      await admin.from(LOG).update(err ? { status: 'error', error: err, sent_to: to } : { status: 'sent', sent_to: to }).eq('sf_id', it.sf_id);
      results.push({ sf_id: it.sf_id, title: it.title, to, ok: !err, ...(err ? { error: err } : {}) });
    }
    return json({ ok: true, action, ...summary, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, ms: Date.now() - t0 });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), ms: Date.now() - t0 }, 500);
  }
});
