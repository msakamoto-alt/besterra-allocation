// sf-export（Edge Function）の本物の index.ts を、ハブ（supabase-js）と Salesforce（fetch）を見立てて手元で動かす。
// Edge Function は学習用 DB では動かず、貼る前に通せる場所が他に無いので作った（2026-11-04）。どこにも接続しない。試験の会社はすべて架空。
// 使い方（npm install は要らない・Node 24 の型の除去だけ）:
//   cd C:\Users\sakamoto\besterra-allocation\supabase\tests
//   node sf_export_group.test.mjs            → 最後に ALL OK
// 確かめること: グループが無ければ前の版（10-30.1）と同じものを送る／対象の広げ方／実効の与信／SF に無い項目は読まず送らない／列が無い DB でも止まらない／試験の与信／dry_run は書かない／取引の無い親は送らない／種別のメイン
import { stripTypeScriptTypes } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const CURRENT = fs.readFileSync(path.join(HERE, '..', 'functions', 'sf-export', 'index.ts'), 'utf8');
const PREVIOUS = execSync('git show 8f9d569:supabase/functions/sf-export/index.ts', { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });  // 2026-10-30.1

let fails = 0;
const ok = (label, cond, info) => { console.log((cond ? 'OK   ' : 'FAIL ') + label + (info !== undefined && !cond ? '  ' + JSON.stringify(info) : '')); if (!cond) fails++; };
const same = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const ORG6 = '00Dxx0000000001';
const ORG7 = '00Dxx0000000002';
const ENV = {
  SUPABASE_URL: 'http://hub.invalid', SUPABASE_SERVICE_ROLE_KEY: 'x', IMPORT_SECRET: 's',
  SF_EXPORT_ALLOWED_ORG_IDS: `${ORG6},${ORG7}`, SF_PROD_ORG_IDS: '',
  SF_EXPORT_TARGETS: JSON.stringify([{ name: 'dev6', org_id: ORG6, instance_url: 'https://dev6.invalid', client_id: 'c', client_secret: 's' }]),
};

async function load(source, label) {
  const js = stripTypeScriptTypes(source).replace(/^import \{ createClient \}.*$/m, 'const createClient = () => globalThis.__hub;');
  const file = path.join(os.tmpdir(), `sf_export_${label}_${process.pid}.mjs`);
  fs.writeFileSync(file, js);
  let handler;
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  await import(pathToFileURL(file).href);
  fs.unlinkSync(file);
  return handler;
}

// ---------------- 見立てのハブ（PostgREST の振る舞い＝無い列はエラー・1 回 1,000 行まで） ----------------
const SCHEMA = {
  company: ['company_id', 'official_name', 'name_kana', 'corporate_number', 'representative_name', 'postal_code', 'prefecture', 'address_line', 'building', 'phone', 'fax', 'invoice_reg_number', 'invoice_status', 'capital_amount', 'remarks', 'last_trade_on', 'is_suspended', 'registration_stage', 'credit_exempt', 'is_test', 'legacy_company_id', 'source_org_id', 'credit_holder_id', 'main_type_code'],
  company_type: ['company_id', 'type_code'],
  system_code: ['company_id', 'system', 'code'],
  permit_license: ['permit_id', 'company_id', 'permit_type', 'construction_types', 'permit_authority', 'permit_number'],
  credit_line: ['credit_id', 'company_id', 'limit_amount', 'limit_type', 'valid_until', 'approved_on', 'used_amount'],
  credit_line_test: ['id', 'company_id', 'org_id', 'org_label', 'application_no', 'limit_amount', 'limit_type', 'valid_until', 'approved_on'],
};
function hubClient(db, opts = {}) {
  const log = [];
  const hasCol = (t, c) => SCHEMA[t].includes(c) && !(t === 'company' && ((opts.noHolderColumn && c === 'credit_holder_id') || (opts.noMainColumn && c === 'main_type_code')));
  class Query {
    constructor(table) { this.table = table; this.preds = []; this.need = []; this.span = [0, 999]; }
    select(cols) { this.cols = cols.split(','); this.need.push(...this.cols); return this; }
    in(c, vals) { this.need.push(c); this.preds.push((r) => vals.map(String).includes(String(r[c]))); return this; }
    not(c) { this.need.push(c); this.preds.push((r) => r[c] !== null && r[c] !== undefined); return this; }
    order(c) { this.need.push(c); this.sortBy = c; return this; }
    range(a, b) { this.span = [a, b]; return this; }
    insert(row) { if (this.table === 'integration_log') log.push(row); return Promise.resolve({ error: null }); }
    upsert() { return Promise.resolve({ error: null }); }
    then(resolve) {
      if (!SCHEMA[this.table]) return resolve({ data: null, error: { message: `relation "${this.table}" does not exist` } });
      const bad = this.need.find((c) => !hasCol(this.table, c));
      if (bad) return resolve({ data: null, error: { message: `column ${this.table}.${bad} does not exist` } });
      let rows = (db[this.table] || []).filter((r) => this.preds.every((p) => p(r)));
      if (this.sortBy) rows = [...rows].sort((a, b) => String(a[this.sortBy]).localeCompare(String(b[this.sortBy])));
      rows = rows.slice(this.span[0], this.span[1] + 1).map((r) => Object.fromEntries(this.cols.map((c) => [c, r[c] ?? null])));
      return resolve({ data: rows, error: null });
    }
  }
  return {
    log,
    from: (t) => new Query(t),
    rpc: async (name) => (name === 'sf_export_try_lock' ? { data: [{ acquired: true }], error: null } : { data: null, error: null }),
  };
}

// ---------------- 見立ての Salesforce（項目名は大文字小文字を区別しない・無い項目は SOQL も更新もエラー） ----------------
const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
function sfMock(orgs) {  // orgs: { base: { orgId, sandbox, fields: [項目名], accounts: [行] } }
  const state = { upserts: {}, soql: {}, updates: {} };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const base = Object.keys(orgs).find((b) => u.startsWith(b));
    if (!base) throw new Error('想定外の接続先: ' + u);
    const org = orgs[base];
    const known = (f) => org.fields.some((n) => n.toLowerCase() === f.toLowerCase());
    (state.soql[base] ||= []); (state.upserts[base] ||= []); (state.updates[base] ||= []);
    if (u.endsWith('/services/oauth2/token')) return reply({ access_token: 't' });
    if (u.endsWith('/sobjects/Account/describe')) return reply({ fields: org.fields.map((name) => ({ name })) });
    if (u.includes('/query?q=')) {
      const soql = decodeURIComponent(u.split('q=')[1]);
      if (soql.includes('FROM Organization')) return reply({ done: true, records: [{ Id: org.orgId + 'AAA', Name: 'test-org', IsSandbox: org.sandbox !== false }] });
      state.soql[base].push(soql);
      const bad = soql.match(/^SELECT (.*?) FROM/)[1].split(',').map((s) => s.trim()).find((f) => !known(f));
      if (bad) return reply([{ errorCode: 'INVALID_FIELD', message: `No such column '${bad}'` }], 400);
      const where = soql.match(/WHERE (\w+) IN \((.*)\)$/);
      const vals = where ? where[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : null;
      return reply({ done: true, records: where ? org.accounts.filter((a) => vals.includes(String(a[where[1]]))) : org.accounts });
    }
    if (u.includes('/composite/sobjects/Account/HubCompanyId__c')) {
      const { records } = JSON.parse(init.body);
      state.upserts[base].push(...records);
      return reply(records.map((r) => {
        const bad = Object.keys(r).find((k) => k !== 'attributes' && !known(k));
        return bad ? { success: false, errors: [{ statusCode: 'INVALID_FIELD', message: `No such column '${bad}'` }] } : { id: '001' + r.HubCompanyId__c, success: true, created: false };
      }));
    }
    if (u.endsWith('/composite/sobjects')) {  // Id 指定の更新（link）
      const { records } = JSON.parse(init.body);
      state.updates[base].push(...records);
      return reply(records.map((r) => ({ id: r.Id, success: true })));
    }
    throw new Error('想定外の呼び出し: ' + u);
  };
  return state;
}

// ---------------- 架空の会社 ----------------
const company = (id, name, extra = {}) => ({ company_id: id, official_name: name, name_kana: null, corporate_number: null, representative_name: null,
  postal_code: '1000001', prefecture: '東京都', address_line: '千代田区千代田1-1', building: null, phone: '03-0000-0000', fax: null, invoice_reg_number: null,
  invoice_status: null, capital_amount: 10000000, remarks: null, last_trade_on: null, is_suspended: false, registration_stage: 'full', credit_exempt: false,
  is_test: false, legacy_company_id: null, source_org_id: null, credit_holder_id: null, main_type_code: null, ...extra });
const HOLDER = '10001', MEMBER_A = '10002', MEMBER_B = '10003', SOLO = '10004', NO_CREDIT = '10005', SUSPENDED = '10006';
const db = (group = true) => ({
  company: [
    company(HOLDER, '試験親会社株式会社'),
    company(MEMBER_A, '試験子会社A株式会社', { credit_holder_id: group ? HOLDER : null }),
    company(MEMBER_B, '試験子会社B株式会社', { credit_holder_id: group ? HOLDER : null }),
    company(SOLO, '試験独立会社株式会社'),
    company(NO_CREDIT, '試験与信なし株式会社', { credit_exempt: true }),
    company(SUSPENDED, '試験欠番株式会社', { is_suspended: true }),
  ],
  company_type: [{ company_id: HOLDER, type_code: 'customer' }, { company_id: MEMBER_A, type_code: 'customer' }],
  system_code: [{ company_id: HOLDER, system: 'tera', code: 'A001' }, { company_id: SOLO, system: 'tera', code: 'A004' }],
  permit_license: [],
  credit_line: [
    { credit_id: 1, company_id: HOLDER, limit_amount: 1500000000, limit_type: '普通', valid_until: '2099-12-31', approved_on: '2025-04-01', used_amount: 410000000 },
    { credit_id: 2, company_id: MEMBER_B, limit_amount: null, limit_type: null, valid_until: null, approved_on: null, used_amount: 100000000 },
    { credit_id: 3, company_id: SOLO, limit_amount: 5000000, limit_type: '臨時', valid_until: '2027-01-31', approved_on: '2026-02-01', used_amount: 1000000 },
  ],
  credit_line_test: [],
});
const accounts = () => [HOLDER, MEMBER_A, MEMBER_B, SOLO, NO_CREDIT].map((id) => ({ Id: '001' + id, HubCompanyId__c: id, Name: 'old', Business_Partners_Code__c: id === HOLDER ? 'A001' : id === SOLO ? 'A004' : null }));

const LABELS = CURRENT.slice(CURRENT.indexOf('const FIELD_LABELS'), CURRENT.indexOf('};', CURRENT.indexOf('const FIELD_LABELS')));
const ALL_FIELDS = ['Id', ...[...LABELS.matchAll(/\b([A-Za-z_]+(?:__c)?):\s*'/g)].map((m) => m[1])];
const NOT_YET = ['CreditHolder__c', 'MainPartnerType__c'];  // SF にまだ配備していない項目
const WITHOUT_HOLDER = ALL_FIELDS.filter((f) => !NOT_YET.includes(f));
const dev6 = (fields, extra = {}) => ({ 'https://dev6.invalid': { orgId: ORG6, fields, accounts: accounts(), ...extra } });

async function call(handler, hub, body) {
  globalThis.__hub = hub;
  const res = await handler(new Request('http://local/sf-export', { method: 'POST', headers: { 'x-import-secret': 's' }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
const sentBy = (state, base = 'https://dev6.invalid') => Object.fromEntries((state.upserts[base] || []).map((r) => [r.HubCompanyId__c, r]));
const keys = (o) => Object.keys(o).sort();

const now = await load(CURRENT, 'current');
const old = await load(PREVIOUS, 'previous');

// ---------------- 1. グループが無ければ前の版と同じものを送る ----------------
for (const [label, body] of [['全件', { action: 'export' }], ['対象を絞る', { action: 'export', company_ids: [SOLO, NO_CREDIT, HOLDER] }], ['欠番を含む', { action: 'export', company_ids: [SUSPENDED, SOLO] }]]) {
  const sa = sfMock(dev6(WITHOUT_HOLDER)); const ha = hubClient(db(false)); const ra = await call(old, ha, body);
  const sb = sfMock(dev6(WITHOUT_HOLDER)); const hb = hubClient(db(false)); const rb = await call(now, hb, body);
  ok(`前の版と比べる ${label}: どちらも 200`, ra.status === 200 && rb.status === 200, [ra, rb]);
  same(`前の版と同じものを送る ${label}`, sb.upserts['https://dev6.invalid'], sa.upserts['https://dev6.invalid']);
  same(`SF の読み方も同じ ${label}`, sb.soql['https://dev6.invalid'], sa.soql['https://dev6.invalid']);
  same(`連携ログの送信内容も同じ ${label}`, hb.log[0].payload, ha.log[0].payload);
  same(`連携ログの対象も同じ ${label}`, hb.log[0].company_ids, ha.log[0].company_ids);
  same(`連携ログの数も同じ ${label}（group_member・skipped_group_parent だけ増える）`, { ...hb.log[0].counts, group_member: undefined, skipped_group_parent: undefined }, { ...ha.log[0].counts, group_member: undefined, skipped_group_parent: undefined });
}

// ---------------- 2. 一括手続先を保存（即時配信）: SF にまだ CreditHolder__c が無い今の状態 ----------------
{
  const s = sfMock(dev6(WITHOUT_HOLDER)); const h = hubClient(db());
  const r = await call(now, h, { action: 'export', mode: 'direct', company_ids: [MEMBER_A], source: 'trigger' });
  const sent = sentBy(s);
  ok('一括手続先の保存: 200・ok', r.status === 200 && r.json.ok === true, r);
  same('与信先と同じ与信先の一括手続先も一緒に送る', keys(sent), [HOLDER, MEMBER_A, MEMBER_B]);
  same('group_added は足した分', [...r.json.group_added].sort(), [HOLDER, MEMBER_B]);
  same('一括手続先に与信先の限度額・種類・期限・決裁日', [sent[MEMBER_A].CreditLimit__c, sent[MEMBER_A].CreditLimitType__c, sent[MEMBER_A].CreditExpiry__c, sent[MEMBER_A].CreditDecisionDate__c], [1500000000, '普通限度', '2099-12-31', '2025-04-01']);
  same('使用額はグループの合計（与信先 4.1 億＋B 1 億）', [sent[HOLDER].CreditUsedAmount__c, sent[MEMBER_A].CreditUsedAmount__c, sent[MEMBER_B].CreditUsedAmount__c], [510000000, 510000000, 510000000]);
  ok('SF に無い項目は送らない（CreditHolder__c・MainPartnerType__c）', Object.values(sent).every((x) => NOT_YET.every((k) => !(k in x))));
  ok('SF に無い項目は読まない', s.soql['https://dev6.invalid'].every((q) => NOT_YET.every((k) => !q.includes(k))));
  same('meta.missing_fields', r.json.missing_fields, NOT_YET);
  same('失敗 0', r.json.failed, 0);
  same('連携ログ: 版・group_member・対象・足した分', [h.log[0].meta.version, h.log[0].counts.group_member, [...h.log[0].company_ids].sort(), [...h.log[0].meta.group_added].sort()], ['2026-11-04.2', 2, [HOLDER, MEMBER_A, MEMBER_B], [HOLDER, MEMBER_B]]);
}

// ---------------- 3. SF に CreditHolder__c が入ったあと ----------------
{
  const s = sfMock(dev6(ALL_FIELDS)); const h = hubClient(db());
  const r = await call(now, h, { action: 'export', company_ids: [HOLDER, SOLO] });
  const sent = sentBy(s);
  same('与信先を保存: その下の一括手続先も配り直す', keys(sent), [HOLDER, MEMBER_A, MEMBER_B, SOLO]);
  same('一括手続先の一文', sent[MEMBER_A].CreditHolder__c, `グループの与信（与信先 試験親会社株式会社 ${HOLDER}）`);
  same('与信先の一文', sent[HOLDER].CreditHolder__c, 'グループの与信先（一括手続先 2 社）');
  same('グループでない会社は空（一度付いた一文を消す）', sent[SOLO].CreditHolder__c, null);
  same('グループでない会社の与信は自分の行', [sent[SOLO].CreditLimit__c, sent[SOLO].CreditLimitType__c, sent[SOLO].CreditUsedAmount__c], [5000000, '臨時限度', 1000000]);
  same('missing_fields は空', r.json.missing_fields, []);
}

// ---------------- 4. 全件（夜間） ----------------
{
  const s = sfMock(dev6(ALL_FIELDS)); const h = hubClient(db());
  const r = await call(now, h, { action: 'export', source: 'cron' });
  const sent = sentBy(s);
  same('全件: 欠番を除く全社', keys(sent), [HOLDER, MEMBER_A, MEMBER_B, SOLO, NO_CREDIT]);
  same('全件: group_added は空・group_member 2', [r.json.group_added, r.json.group_member], [[], 2]);
  same('全件: 与信なしの会社は空のまま', [sent[NO_CREDIT].CreditLimit__c, sent[NO_CREDIT].CreditUsedAmount__c, sent[NO_CREDIT].CreditExempt__c], [null, null, true]);
  same('全件でも使用額は同じ合計', sent[MEMBER_A].CreditUsedAmount__c, 510000000);
}

// ---------------- 5. SF の項目名の大文字小文字が違っても落とさない（SOQL も更新も区別しない） ----------------
{
  const fields = WITHOUT_HOLDER.map((f) => (f === 'Business_Partners_Code__c' ? 'business_partners_code__c' : f === 'HeadOfficeAddress__c' ? 'HEADOFFICEADDRESS__C' : f));
  const s = sfMock(dev6(fields)); const h = hubClient(db());
  const r = await call(now, h, { action: 'export', company_ids: [SOLO] });
  const sent = sentBy(s);
  same('綴りの大小が違うだけの項目は「無い」にしない', r.json.missing_fields, NOT_YET);
  same('綴りの大小が違うだけの項目も送る', [sent[SOLO].Business_Partners_Code__c, 'HeadOfficeAddress__c' in sent[SOLO]], ['A004', true]);
  ok('綴りの大小が違うだけの項目も読む', s.soql['https://dev6.invalid'].every((q) => q.includes('Business_Partners_Code__c') && q.includes('HeadOfficeAddress__c')));
}

// ---------------- 6. 送り先ごとに項目の有無が違う（dev6 に先に入る） ----------------
{
  const saved = ENV.SF_EXPORT_TARGETS;
  ENV.SF_EXPORT_TARGETS = JSON.stringify([
    { name: 'dev6', org_id: ORG6, instance_url: 'https://dev6.invalid', client_id: 'c', client_secret: 's' },
    { name: 'dev7', org_id: ORG7, instance_url: 'https://dev7.invalid', client_id: 'c', client_secret: 's' },
  ]);
  const s = sfMock({ 'https://dev6.invalid': { orgId: ORG6, fields: ALL_FIELDS, accounts: accounts() }, 'https://dev7.invalid': { orgId: ORG7, fields: WITHOUT_HOLDER, accounts: accounts() } });
  const r = await call(now, hubClient(db()), { action: 'export', company_ids: [MEMBER_A] });
  same('送り先ごと: missing_fields', r.json.results.map((x) => x.missing_fields), [[], NOT_YET]);
  ok('送り先ごと: dev6 には一文を送る', 'CreditHolder__c' in sentBy(s, 'https://dev6.invalid')[MEMBER_A]);
  ok('送り先ごと: dev7 には送らない', !('CreditHolder__c' in sentBy(s, 'https://dev7.invalid')[MEMBER_A]));
  ENV.SF_EXPORT_TARGETS = saved;
}

// ---------------- 7. credit_group.sql がまだの DB（列が無い）でも止まらない ----------------
{
  const s = sfMock(dev6(WITHOUT_HOLDER)); const h = hubClient(db(false), { noHolderColumn: true });
  const r = await call(now, h, { action: 'export', company_ids: [SOLO] });
  ok('列が無い DB: 200・ok', r.status === 200 && r.json.ok === true, r);
  same('列が無い DB: 対象だけ送る', keys(sentBy(s)), [SOLO]);
  ok('列が無い DB: group_note に理由', String(r.json.group_note || '').includes('credit_holder_id'), r.json.group_note);
  same('列が無い DB: 与信は自分の行', sentBy(s)[SOLO].CreditLimit__c, 5000000);
}

// ---------------- 8. dry_run は書かない ----------------
{
  const s = sfMock(dev6(WITHOUT_HOLDER)); const h = hubClient(db());
  const r = await call(now, h, { action: 'dry_run', company_ids: [MEMBER_A] });
  ok('dry_run: 200・ok', r.status === 200 && r.json.ok === true, r);
  same('dry_run: SF へ書かない', s.upserts['https://dev6.invalid'], []);
  same('dry_run: 連携ログも書かない', h.log, []);
  same('dry_run: グループの数は見える', [r.json.group_member, r.json.targets, r.json.missing_fields], [2, 3, NOT_YET]);
}

// ---------------- 9. 試験の与信（sandbox の稟議の結果） ----------------
{
  const data = db();
  data.credit_line_test.push({ id: 1, company_id: HOLDER, org_id: ORG6 + 'AAA', org_label: 'dev6', application_no: 'X', limit_amount: 99000000, limit_type: '普通', valid_until: '2027-03-31', approved_on: '2026-10-01' });
  const s = sfMock(dev6(WITHOUT_HOLDER)); const r = await call(now, hubClient(data), { action: 'export', company_ids: [MEMBER_A] });
  same('試験の与信: 与信先の試験の行を一括手続先にも', [sentBy(s)[MEMBER_A].CreditLimit__c, sentBy(s)[HOLDER].CreditLimit__c], [99000000, 99000000]);
  same('試験の与信: 使用額は本物の合計のまま', sentBy(s)[MEMBER_A].CreditUsedAmount__c, 510000000);
  same('試験の与信: 数', r.json.test_credit, 3);

  ENV.SF_PROD_ORG_IDS = ORG6;
  const sp = sfMock(dev6(WITHOUT_HOLDER)); await call(now, hubClient(data), { action: 'export', company_ids: [MEMBER_A] });
  same('本番の org には試験の与信を使わない', sentBy(sp)[MEMBER_A].CreditLimit__c, 1500000000);
  ENV.SF_PROD_ORG_IDS = '';
}

// ---------------- 10. 取引の無い親（種別「グループの親」だけの会社）は送らない ----------------
const holdingDb = (extraTypes = []) => {
  const d = db();
  d.company_type = d.company_type.filter((t) => t.company_id !== HOLDER);
  d.company_type.push({ company_id: HOLDER, type_code: 'group_parent' }, ...extraTypes.map((t) => ({ company_id: HOLDER, type_code: t })));
  return d;
};
{
  const s = sfMock(dev6(ALL_FIELDS)); const h = hubClient(holdingDb());
  const r = await call(now, h, { action: 'export', company_ids: [MEMBER_A] });
  const sent = sentBy(s);
  same('取引の無い親: 親は送らず子会社だけ送る', keys(sent), [MEMBER_A, MEMBER_B]);
  same('取引の無い親: 子会社の与信は親の行・使用額は合計', [sent[MEMBER_A].CreditLimit__c, sent[MEMBER_A].CreditUsedAmount__c], [1500000000, 510000000]);
  same('取引の無い親: 子会社の一文に親の名前', sent[MEMBER_A].CreditHolder__c, `グループの与信（与信先 試験親会社株式会社 ${HOLDER}）`);
  same('取引の無い親: 数（欠番の数に混ざらない）', [r.json.skipped_group_parent, r.json.skipped_suspended], [1, 0]);
  same('取引の無い親: 連携ログの数', h.log[0].counts.skipped_group_parent, 1);

  const sAll = sfMock(dev6(ALL_FIELDS)); const rAll = await call(now, hubClient(holdingDb()), { action: 'export' });
  ok('取引の無い親: 全件でも送らない', !(HOLDER in sentBy(sAll)) && MEMBER_A in sentBy(sAll));
  same('取引の無い親: 全件の数', rAll.json.skipped_group_parent, 1);

  const sBoth = sfMock(dev6(ALL_FIELDS)); await call(now, hubClient(holdingDb(['customer'])), { action: 'export', company_ids: [HOLDER] });
  same('他の種別も付いていれば送る（種別は SF の値だけ）', sentBy(sBoth)[HOLDER].PartnerType__c, '顧客');

  const sDry = sfMock(dev6(WITHOUT_HOLDER)); const rDry = await call(now, hubClient(holdingDb()), { action: 'dry_run', company_ids: [MEMBER_A] });
  same('取引の無い親: dry_run の数', [rDry.json.targets, rDry.json.skipped_group_parent, sDry.upserts['https://dev6.invalid']], [2, 1, []]);

  const orgs = dev6(WITHOUT_HOLDER);
  orgs['https://dev6.invalid'].accounts = [{ Id: '001HOLD', HubCompanyId__c: null, Name: '試験親会社株式会社', Business_Partners_Code__c: null }];
  const sLink = sfMock(orgs); await call(now, hubClient(holdingDb()), { action: 'link' });
  same('取引の無い親: 社名の突合でも SF の取引先に結び付けない', sLink.updates['https://dev6.invalid'], []);
}

// ---------------- 11. 種別のメイン ----------------
{
  const V = { TWO_MAIN: '10011', TWO_NONE: '10012', ONE: '10013', CUST_ONE: '10014', CUST: '10015', STALE_TWO: '10016', STALE_ONE: '10017' };
  const data = db();
  const add = (id, types, main = null) => { data.company.push(company(id, '試験発注先' + id, { main_type_code: main })); types.forEach((t) => data.company_type.push({ company_id: id, type_code: t })); };
  add(V.TWO_MAIN, ['lease', 'material'], 'material');
  add(V.TWO_NONE, ['lease', 'material']);
  add(V.ONE, ['subcontractor']);
  add(V.CUST_ONE, ['customer', 'subcontractor']);
  add(V.CUST, ['customer']);
  add(V.STALE_TWO, ['lease', 'material'], 'fuel');
  add(V.STALE_ONE, ['lease'], 'material');
  const ids = Object.values(V);
  const s = sfMock(dev6(ALL_FIELDS)); await call(now, hubClient(data), { action: 'export', company_ids: ids });
  const sent = sentBy(s);
  same('メイン: 選んだ種別', sent[V.TWO_MAIN].MainPartnerType__c, '資材');
  same('メイン: 2 つ以上で選んでいなければ空', sent[V.TWO_NONE].MainPartnerType__c, null);
  same('メイン: 発注先の種別が 1 つならそれ', sent[V.ONE].MainPartnerType__c, '外注（請負）');
  same('メイン: 顧客＋発注先 1 つなら発注先', sent[V.CUST_ONE].MainPartnerType__c, '外注（請負）');
  same('メイン: 顧客だけなら空', sent[V.CUST].MainPartnerType__c, null);
  same('メイン: 種別から外された値は無視（2 つ以上）', sent[V.STALE_TWO].MainPartnerType__c, null);
  same('メイン: 種別から外された値は無視（1 つ）', sent[V.STALE_ONE].MainPartnerType__c, '重機・リース');

  const sOld = sfMock(dev6(ALL_FIELDS)); const hOld = hubClient(data, { noMainColumn: true });
  const rOld = await call(now, hOld, { action: 'export', company_ids: [V.TWO_MAIN, V.ONE, MEMBER_A] });
  ok('メインの列が無い DB: 200・ok', rOld.status === 200 && rOld.json.ok === true, rOld);
  ok('メインの列が無い DB: group_note に理由', String(rOld.json.group_note || '').includes('main_type_code'), rOld.json.group_note);
  same('メインの列が無い DB: 1 つならそれ・選べない分は空', [sentBy(sOld)[V.ONE].MainPartnerType__c, sentBy(sOld)[V.TWO_MAIN].MainPartnerType__c], ['外注（請負）', null]);
  same('メインの列が無い DB: グループの与信は動く', sentBy(sOld)[MEMBER_A].CreditLimit__c, 1500000000);
}

console.log(fails ? `\n${fails} FAIL` : '\nALL OK');
process.exit(fails ? 1 : 0);
