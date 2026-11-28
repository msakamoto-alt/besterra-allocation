// credit_notice_del_test_2026-11-28.sql（試験の稟議の知らせ 6 件を消す・一回きり）を、本物の表の定義（credit_notice.sql・credit_notice_v2.sql）で PGlite に通す。2026-11-28
// 確かめること: [1] が 6 行を出す／[2] は 6 行ぴったりのときだけ消す（閉じた行・試験の与信がつながった行が混ざると何も消さずに止まる・二度目も止まる）／
//              状態の履歴は一緒に消える／本物の与信・試験の与信・ほかの知らせは残る／SF へ配る仕組み（notify_sf_export）は動かない
// 使い方: cd C:\Users\sakamoto\besterra-allocation\supabase\tests && node credit_notice_del_test_2026-11-28.test.mjs → 最後に ALL OK
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');
const ddl = read('torihikisaki_prod', 'prod_01_schema_rls.sql');
function extractTable(name) {
  const m = ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`, 'i'));
  if (!m) return null;
  return m[0].replace(/REFERENCES (\w+)\(([^)]*)\)/g, (s, t) => (t === 'company') ? s : '');
}
const SQLFILE = read('credit_notice_del_test_2026-11-28.sql');
const sec = (k) => { const a = SQLFILE.indexOf(`-- [${k}]`); const b = SQLFILE.indexOf(`-- [${k + 1}]`); return SQLFILE.slice(a, b < 0 ? undefined : b); };

const pg = new PGlite();
let fails = 0;
const ok = (label, cond, info) => { console.log((cond ? 'OK   ' : 'FAIL ') + label + (info !== undefined ? '  ' + JSON.stringify(info) : '')); if (!cond) fails++; };
async function run(label, sql) { try { await pg.exec(sql); ok(label, true); } catch (e) { ok(label, false, e.message.split('\n').slice(0, 3).join(' | ')); } }
async function expectErr(label, sql, needle) {
  try { await pg.exec(sql); ok(label + '（通ってしまった）', false); }
  catch (e) { const m = e.message || ''; ok(label + ' -> ' + m.split('\n')[0], m.includes(needle)); }
}
async function all(sql, params) { const r = await pg.query(sql, params); return r.rows; }
async function one(sql, params) { return (await all(sql, params))[0]; }
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

// 列を指定して 1 行入れる（指定していない NOT NULL・既定なしの列は型に合う仮の値で埋める）
async function ins(table, vals) {
  const cols = await all(`select column_name, data_type, is_nullable, column_default from information_schema.columns
                           where table_schema = 'public' and table_name = $1`, [table]);
  const v = { ...vals };
  for (const c of cols) {
    if (c.column_name in v || c.is_nullable !== 'NO' || c.column_default != null) continue;
    const t = c.data_type;
    v[c.column_name] = /json/.test(t) ? '{}' : t === 'ARRAY' ? '{}' : /char|text/.test(t) ? 'x' : /bool/.test(t) ? false
      : /int|numeric|double|real/.test(t) ? 0 : /date|time/.test(t) ? '2026-01-01' : 'x';
  }
  const ks = Object.keys(v);
  await pg.query(`insert into ${table} (${ks.join(',')}) values (${ks.map((_, i) => '$' + (i + 1)).join(',')})`, ks.map(k => v[k]));
}

// ---------------- 下ごしらえ（Supabase の役割・app_role・本番の表の形・SF へ配る仕組みの身代わり） ----------------
await run('roles', `create role anon nologin; create role authenticated nologin; create role service_role nologin;
  grant usage on schema public to anon, authenticated, service_role;`);
await run('app_role()', `create function public.app_role() returns text language sql stable as $$ select coalesce(nullif(current_setting('app.role', true), ''), 'admin') $$;`);
await run('company（本番の形）', extractTable('company') + `\nalter table company add column if not exists is_test boolean not null default false;`);
const clDdl = extractTable('credit_line');
await run('credit_line（' + (clDdl ? '本番の形' : '使う列だけ') + '）', clDdl || `create table credit_line (credit_id bigserial primary key,
  company_id varchar(8) not null references company(company_id), limit_amount bigint, limit_type varchar(20), valid_until date, approved_on date, decided_by varchar(40));`);
await run('notify_sf_export の身代わり（呼ばれたら sfx_log に残す）', `create table sfx_log (id serial primary key, tbl text, op text);
  create function public.notify_sf_export() returns trigger language plpgsql as $$ begin insert into sfx_log(tbl, op) values (TG_TABLE_NAME, TG_OP); return null; end $$;`);
await run('credit_notice.sql（本物）', read('credit_notice.sql'));
await run('credit_notice_v2.sql（本物）', read('credit_notice_v2.sql'));

const DEV6 = '00Dfd000002CDWc', DEV7 = '00Dff0000014yuf', PROD = '00D5h0000000001';
for (const [cid, name, t] of [['11771', '本物の会社A', false], ['12379', '本物の会社B', false], ['11456', '本物の会社C', false],
  ['11837', '本物の会社D', false], ['00028', '試験の会社E', true], ['00030', '試験の会社F', true], ['00019', '試験の会社G', true]]) {
  await ins('company', { company_id: cid, official_name: name, is_test: t });
}
for (const [cid, amt] of [['11456', 1100], ['11771', 2200], ['11837', 3300], ['12379', 4400]]) { // 額は架空（公開の repo に本物の与信の額を置かない）
  await ins('credit_line', { company_id: cid, limit_amount: amt, limit_type: '普通', valid_until: '2027-01-31' });
}
// 消す 6 行（本番で読んだ値と同じ）＋残すべき行（閉じた試験の知らせ 2・本物の知らせ 20・開いた別の試験の知らせ 21）
const T = [[6, DEV6, 'dev6', 'YS-00034', '与信', '11771', '承認'], [9, DEV6, 'dev6', 'YS-00015', '与信', '12379', '申請中'],
  [13, DEV6, 'dev6', 'YS-00040', '与信', '11456', '承認'], [16, DEV7, 'dev7', 'YS-00000', '与信', '11837', '申請中'],
  [18, DEV6, 'dev6', 'YS-00044', '取引開始', '00030', '申請中'], [19, DEV7, 'dev7', 'YS-00003', '与信', '00028', '申請中']];
for (const [id, org, lbl, no, kind, cid, st] of T) {
  await ins('credit_notice', { id, org_id: org, org_label: lbl, application_no: no, kind, company_id: cid, stage: st, is_prod: false });
}
await ins('credit_notice', { id: 2, org_id: DEV6, org_label: 'dev6', application_no: 'YS-00010', kind: '与信', company_id: '00019', stage: '承認', is_prod: false, done_at: '2026-10-31T00:00:00Z' });
await ins('credit_notice', { id: 20, org_id: PROD, org_label: '本番', application_no: 'YS-00050', kind: '与信', company_id: '11771', stage: '申請中', is_prod: true });
await ins('credit_notice', { id: 21, org_id: DEV6, org_label: 'dev6', application_no: 'YS-00099', kind: '与信', company_id: '00019', stage: '申請中', is_prod: false });
for (const nid of [6, 6, 9, 20]) await ins('credit_notice_event', { notice_id: nid });
await ins('credit_line_test', { company_id: '00019', org_id: DEV6, org_label: 'dev6', application_no: 'YS-00010', notice_id: 2, limit_amount: 100000000 });
await pg.exec('delete from sfx_log');

// ---------------- [1] 確かめ ----------------
const r1 = await all(sec(1));
ok('[1] 6 行', r1.length === 6, r1.length);
ok('[1] 全部 本番でない・開いている・試験の与信のつながり 0', r1.every(r => r.is_prod === false && r.done_at == null && num(r.test_credit_links) === 0));
const lim = Object.fromEntries(r1.map(r => [r.company_id, r.real_limit == null ? null : num(r.real_limit)]));
ok('[1] 本物の 4 社の額・試験の 2 社は空', lim['11456'] === 1100 && lim['11771'] === 2200 && lim['11837'] === 3300 && lim['12379'] === 4400
  && lim['00028'] === null && lim['00030'] === null, lim);

// ---------------- [2] が止まるとき（何も消さない） ----------------
const cnt6 = async () => num((await one('select count(*) as c from credit_notice where id in (6,9,13,16,18,19)')).c);
await pg.exec("update credit_notice set done_at = now() where id = 9");
await expectErr('[2] 閉じた行が混ざる → 止まる', sec(2), '5 行');
ok('  何も消していない', await cnt6() === 6);
await pg.exec("update credit_notice set done_at = null where id = 9");
await ins('credit_line_test', { company_id: '11456', org_id: DEV6, org_label: 'dev6', application_no: 'YS-00040', notice_id: 13, limit_amount: 1 });
await expectErr('[2] 試験の与信がつながった行が混ざる → 止まる', sec(2), '5 行');
ok('  何も消していない', await cnt6() === 6);
await pg.exec("delete from credit_line_test where notice_id = 13");
await pg.exec('delete from sfx_log');

// ---------------- [2] 消す → [3] 確かめ ----------------
await run('[2] 消す（6 行ぴったり）', sec(2));
const r3 = await one(sec(3));
ok('[3] 消した 6 行が 0・状態の履歴も 0', num(r3.deleted_left) === 0 && num(r3.events_left) === 0, r3);
ok('[3] 本物の与信 4 行・額は同じ', num(r3.real_credit_rows) === 4 && r3.real_limits === '11456:1100 11771:2200 11837:3300 12379:4400', r3.real_limits);
ok('[3] 開いている知らせ＝残すべき 2 行（本物 20・別の試験 21）', num(r3.open_notices_now) === 2, num(r3.open_notices_now));
ok('残すべき行（2・20・21）と、その状態の履歴（20）は残る', num((await one('select count(*) as c from credit_notice where id in (2,20,21)')).c) === 3
  && num((await one('select count(*) as c from credit_notice_event where notice_id = 20')).c) === 1);
ok('試験の与信（2 番の知らせとつながった行）はそのまま', num((await one('select count(*) as c from credit_line_test where notice_id = 2')).c) === 1);
ok('会社は 7 社のまま', num((await one('select count(*) as c from company')).c) === 7);
ok('SF へ配る仕組みは動いていない（sfx_log 0）', num((await one('select count(*) as c from sfx_log')).c) === 0);
await expectErr('[2] 二度目 → 止まる（0 行）', sec(2), '0 行');

console.log(fails ? `\n${fails} FAIL` : '\nALL OK');
await pg.close();
process.exitCode = fails ? 1 : 0; // process.exit は Windows の Node で終わり際に libuv の assert が出るため使わない
