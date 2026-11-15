// antisocial_check.sql（反社チェックの API 連携・RoboRobo）を手元の PostgreSQL（PGlite）で通す。2026-11-15
// 何度流しても同じ・依頼の決まり・結果と取引判断の取り込み・回の結果・今の状態・人が RoboRobo の記録を直せないこと・権限を見る。
// 使い方（初回は npm install が要る）:
//   cd C:\Users\sakamoto\besterra-allocation\supabase\tests
//   node antisocial_check.test.mjs            → 最後に ALL OK
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '..', 'antisocial_check.sql'), 'utf8');
const ddl = fs.readFileSync(path.join(HERE, '..', 'torihikisaki_prod', 'prod_01_schema_rls.sql'), 'utf8');
function extractTable(name) {
  const m = ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`, 'i'));
  if (!m) throw new Error('DDL not found: ' + name);
  return m[0].replace(/REFERENCES (\w+)\(([^)]*)\)/g, (s, t) => (t === 'company') ? s : '');
}

const pg = new PGlite();
let fails = 0;
const ok = (label, cond, info) => { console.log((cond ? 'OK   ' : 'FAIL ') + label + (info !== undefined ? '  ' + JSON.stringify(info) : '')); if (!cond) fails++; };
async function run(label, sql) { try { await pg.exec(sql); ok(label, true); } catch (e) { ok(label, false, e.message.split('\n').slice(0, 3).join(' | ')); } }
async function expectErr(label, sql, needle) {
  try { await pg.query(sql); ok(label + '（通ってしまった）', false); }
  catch (e) { const m = e.message || ''; ok(label + ' -> ' + m.split('\n')[0], m.includes(needle)); }
}
async function one(sql, params) { const r = await pg.query(sql, params); return r.rows[0]; }
async function all(sql, params) { const r = await pg.query(sql, params); return r.rows; }
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

// ---------------- 下ごしらえ（Supabase の役割・app_role・本番の表の形） ----------------
await run('roles', `create role anon nologin; create role authenticated nologin; create role service_role nologin;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);
await run('app_role()', `create function app_role() returns text language sql stable as $$ select coalesce(nullif(current_setting('app.role', true), ''), 'admin') $$;`);
await run('company / company_type / compliance_check（本番の形）', extractTable('company') + '\n' + extractTable('company_type') + '\n' + extractTable('compliance_check')
  + `\nalter table company add column if not exists is_test boolean not null default false;`);
await run('credit_notice（知らせの表・使う列だけ）', `create table credit_notice (
  id bigserial primary key, org_id varchar(15) not null, org_label varchar(40), is_prod boolean not null default false,
  kind varchar(10) not null, application_no varchar(40) not null, company_id varchar(8) references company(company_id),
  received_at timestamptz not null default now(), done_at timestamptz, stage varchar(10));`);
await run('移行の行（結果なし）', `insert into company (company_id, official_name) values ('00001','移行の会社');
  insert into compliance_check (company_id, checked_on, method) values ('00001', '2015-03-10', 'TDB（帝国データバンク）');`);

// ---------------- 何度流しても同じ ----------------
await run('antisocial_check.sql 1 回目', SQL);
await run('antisocial_check.sql 2 回目（同じ結果）', SQL);
let r = await one(`select count(*) as n from antisocial_setting`);
ok('設定は 1 行・既定は止めてある', num(r.n) === 1 && (await one(`select enabled, use_prod_token, auto_rule from antisocial_setting`)).enabled === false);
r = await one(`select requested_at, source, is_test from compliance_check where company_id = '00001'`);
ok('移行の行の requested_at は空のまま（今日の日付を付けない）', r.requested_at === null && r.source === null && r.is_test === false, r);

// ---------------- 小さな道具 ----------------
const rep = async (s) => (await one(`select antisocial_norm_rep($1) as v`, [s])).v;
ok('代表者名: 役職と空白を落とす', await rep('代表取締役社長 山田 太郎') === '山田太郎');
ok('代表者名: 最初の 1 人だけ', await rep('代表取締役　鈴木一郎、取締役 佐藤次郎') === '鈴木一郎');
ok('代表者名: 括弧の中を落とす', await rep('山田太郎（ヤマダタロウ）') === '山田太郎');
ok('代表者名: 役職だけ・空は null', await rep('社長') === null && await rep('') === null && await rep(null) === null);
const ent = async (n, c, k) => (await one(`select antisocial_entity_type($1, $2, $3) as v`, [n, c, k])).v;
ok('組織／個人: 法人番号・法人の形・個人', await ent('山田工務店', '1234567890123', null) === '組織' && await ent('株式会社テスト', null, null) === '組織'
  && await ent('山田工務店', null, '個人') === '個人' && await ent('山田工務店', null, null) === '組織');
ok('官公庁らしい名前', (await one(`select antisocial_is_public_name('国土交通省') as a, antisocial_is_public_name('株式会社国土') as b`)).a === true);

// ---------------- 会社 ----------------
await run('会社と種別', `insert into company (company_id, official_name, corporate_number, representative_name, data_source, created_at) values
  ('10001','株式会社テスト顧客','1111111111111','代表取締役 山田太郎','migration', now() - interval '2 years'),
  ('10002','テスト外注株式会社','2222222222222','代表取締役社長 鈴木一郎','migration', now() - interval '2 years'),
  ('10003','電気の会社株式会社','3333333333333',null,'migration', now() - interval '2 years'),
  ('10004','山田工務店',null,'山田花子','migration', now() - interval '2 years'),
  ('10005','新規の顧客株式会社',null,'代表取締役 佐藤次郎','salesforce', now()),
  ('10006','新しい外注株式会社','6666666666666','代表 田中三郎','sansan', now()),
  ('10007','上場会社株式会社','7777777777777','代表 高橋','migration', now() - interval '2 years');
  update company set entity_class = '個人' where company_id = '10004';
  update company set listing_class = '上場' where company_id = '10007';
  update company set registration_stage = 'full' where data_source = 'migration';   -- 移行の会社は本登録（本番と同じ）
  insert into company (company_id, official_name, corporate_number, data_source, created_at, registration_stage) values
    ('10008','登録したて外注株式会社','8888888888888','sansan', now(), 'temp'),
    ('10009','本番の申請の顧客株式会社','9999999999999','migration', now() - interval '2 years', 'full');
  insert into company (company_id, official_name, is_test) values ('00009','【テスト】試験の会社', true);
  insert into company_type values ('10001','customer'),('10002','subcontractor'),('10003','sga'),('10004','subcontractor'),
    ('10005','customer'),('10006','subcontractor'),('10007','customer'),('10008','subcontractor'),('10009','customer'),('00009','customer');`);

// ---------------- 頼む（手動・試し） ----------------
r = await one(`select antisocial_enqueue('10001','手動',null,true,'tester') as id`);
const c1 = num(r.id);
ok('手動で頼む → 回ができる', !!c1);
let items = await all(`select subject, name_sent, relative_word, management_number, entity_type, state, folder_name from compliance_check_item where check_id = $1 order by item_id`, [c1]);
ok('会社と代表者の 2 件・代表者は役職を落として関連ワード＝社名', items.length === 2 && items[0].subject === '会社' && items[0].management_number === '10001'
  && items[1].name_sent === '山田太郎' && items[1].relative_word === '株式会社テスト顧客' && items[1].management_number === '10001-R' && items[1].entity_type === '個人', items);
ok('フォルダ名＝手動 年-月（試し）', /^手動 \d{4}-\d{2}（試し）$/.test(items[0].folder_name), items[0].folder_name);
r = await one(`select result, source, is_test, trigger_kind, method, name_at_check, rep_at_check, requested_at from compliance_check where check_id = $1`, [c1]);
ok('回＝調査中・roborobo・試し・時刻は DB', r.result === '調査中' && r.source === 'roborobo' && r.is_test === true && r.trigger_kind === '手動' && r.rep_at_check === '山田太郎' && r.requested_at !== null, r);
ok('調べている途中にもう一度頼んでも作らない', (await one(`select antisocial_enqueue('10001','手動',null,true,'tester') as id`)).id === null);
ok('試験の会社は流さない', (await one(`select antisocial_enqueue('00009','手動',null,false,'tester') as id`)).id === null);
r = await one(`select antisocial_enqueue('10004','手動',null,true,'tester') as id`);
ok('個人事業は会社の 1 件だけ（代表者を重ねない）', num((await one(`select count(*) as n from compliance_check_item where check_id = $1`, [num(r.id)])).n) === 1);
await expectErr('きっかけの言葉が違えば止める', `select antisocial_enqueue('10001','なんとなく',null,true,'x')`, 'きっかけが違います');

// ---------------- 結果を取り込む ----------------
await run('送ったことにする（取引先 ID・実行 ID）', `
  update compliance_check_item set state = '調査中', sent_at = now(), rr_customer_id = 900001, rr_execution_id = 800001 where check_id = ${c1} and subject = '会社';
  update compliance_check_item set state = '調査中', sent_at = now(), rr_customer_id = 900002, rr_execution_id = 800002 where check_id = ${c1} and subject = '代表者';`);
const payload1 = { resultList: [
  { checkExecutionId: 800001, customerId: 900001, customerName: '株式会社テスト顧客', managementNumber: '10001', checkedExecutionAt: '2026-11-15 10:00:00',
    complianceUrl: 'https://compliance.roborobo.co.jp/groups/1/customers/900001/check-results/800001/detail', totalUrlCount: 12,
    riskLevelCount: { high: 1, middle: 2, low: 8, none: 0, exclude: 1 }, newspaperResult: { message: 'success', articleCount: 0 },
    checkResultList: [
      { title: '低い記事', url: 'https://a.example/1', domain: 'a.example', riskLevelScore: 2, publicationDate: null },
      { title: '高い記事', url: 'https://b.example/2', domain: 'b.example', domainName: 'B新聞', riskLevelScore: 0, publicationDate: '2026-04-14' },
      { title: '除外の記事', url: 'https://c.example/3', domain: 'c.example', riskLevelScore: -1 },
      { title: '中の記事', url: 'https://d.example/4', domain: 'd.example', riskLevelScore: 1 }] },
  { checkExecutionId: 800002, customerId: 900002, customerName: '山田太郎', relativeWord: '株式会社テスト顧客', checkedExecutionAt: '2026-11-15 10:00:05',
    totalUrlCount: 0, riskLevelCount: { high: 0, middle: 0, low: 0, none: 0, exclude: 0 }, newspaperResult: { message: 'success', articleCount: 0 }, checkResultList: [] },
  { checkExecutionId: 999999, customerId: 999999, totalUrlCount: 3 },   // ツールに無い実行は読み飛ばす
  { code: 500, message: 'エラー' } ] };
r = await one(`select antisocial_apply_result($1::jsonb) as n`, [JSON.stringify(payload1)]);
ok('取り込んだのは 2 件（無い実行・エラーの本文は読み飛ばす）', num(r.n) === 2, r);
items = await all(`select subject, state, hit_total, hit_high, hit_middle, newspaper_count, articles, compliance_url, checked_at from compliance_check_item where check_id = $1 order by item_id`, [c1]);
ok('会社＝要確認（ヒット 12）・代表者＝該当なし（ヒット 0）', items[0].state === '要確認' && items[0].hit_total === 12 && items[0].hit_high === 1 && items[1].state === '該当なし', items.map(i => [i.subject, i.state, i.hit_total]));
ok('記事は注目度の高い順（高→中→低→除外）・出典は名前を優先', items[0].articles.map(a => a.title).join(',') === '高い記事,中の記事,低い記事,除外の記事' && items[0].articles[0].site === 'B新聞', items[0].articles.map(a => a.title));
ok('結果画面の URL・チェック日（日本時間）', items[0].compliance_url.includes('/check-results/800001/') && new Date(items[0].checked_at).toISOString() === '2026-11-15T01:00:00.000Z', items[0].checked_at);
r = await one(`select result, valid_until, completed_at from compliance_check where check_id = $1`, [c1]);
ok('回＝要確認（1 件でもヒットがあれば人が見る）・有効期限はまだ無い', r.result === '要確認' && r.valid_until === null && r.completed_at === null, r);
ok('同じ結果がもう一度届いても 1 回分', num((await one(`select antisocial_apply_result($1::jsonb) as n`, [JSON.stringify(payload1)])).n) === 2
  && (await one(`select count(*) as n from compliance_check_item where check_id = $1`, [c1])).n == 2);

// ---------------- 取引判断を取り込む ----------------
r = await one(`select antisocial_apply_decisions($1::jsonb) as n`, [JSON.stringify({ checkDecisionList: [
  { checkDecisionId: 7001, customerId: 900001, checkExecutionId: 800001, checkDecisionChoice: 1, comment: '別会社の記事。問題なし', updatedAt: '2026-11-15 11:00:00' }] })]);
ok('承認を取り込む', num(r.n) === 1);
r = await one(`select result, checked_on, valid_until, checked_by, completed_at from compliance_check where check_id = $1`, [c1]);
ok('回＝問題なし・有効期限＝調べた日から 1 年・判断した人の印', r.result === '問題なし' && String(r.valid_until.toISOString()).startsWith('2027-11-14') && r.checked_by === '経理（RoboRobo の取引判断）' && r.completed_at !== null, r);
r = await one(`select antisocial_apply_decisions($1::jsonb) as n`, [JSON.stringify({ checkDecisionList: [
  { checkDecisionId: 7000, customerId: 900001, checkExecutionId: 800001, checkDecisionChoice: 2, comment: '古い判断', updatedAt: '2026-11-15 09:00:00' }] })]);
ok('古い判断では上書きしない', num(r.n) === 0 && (await one(`select state from compliance_check_item where rr_execution_id = 800001`)).state === '問題なし');
await pg.query(`select antisocial_apply_decisions($1::jsonb)`, [JSON.stringify({ checkDecisionList: [
  { checkDecisionId: 7002, customerId: 900001, checkExecutionId: 800001, checkDecisionChoice: 2, comment: '否認', updatedAt: '2026-11-15 12:00:00' }] })]);
r = await one(`select result, valid_until from compliance_check where check_id = $1`, [c1]);
ok('否認 → 回＝取引不可・有効期限なし', r.result === '取引不可' && r.valid_until === null, r);
r = await one(`select antisocial_enqueue('10002','手動',null,true,'tester') as id`);
await pg.query(`select antisocial_apply_result($1::jsonb)`, [JSON.stringify({ resultList: [{ checkExecutionId: 830001, customerId: 930001, customerName: 'テスト外注株式会社',
  managementNumber: '10002', checkedExecutionAt: '2026-11-15 15:00:00', totalUrlCount: 0, riskLevelCount: { high: 0 }, newspaperResult: { message: 'success', articleCount: 0 } }] })]);
r = await one(`select state, rr_customer_id, rr_execution_id from compliance_check_item where check_id = $1 and subject = '会社'`, [num(r.id)]);
ok('送った記録より先に結果が届いても、管理番号と社名で取り込む', r.state === '該当なし' && num(r.rr_execution_id) === 830001 && num(r.rr_customer_id) === 930001, r);
ok('人の判断は、結果の取り込み直しで消えない', num((await one(`select antisocial_apply_result($1::jsonb) as n`, [JSON.stringify(payload1)])).n) === 2
  && (await one(`select state from compliance_check_item where rr_execution_id = 800001`)).state === '取引不可');

// ---------------- 今の状態（試しは数えない） ----------------
let v = await one(`select status from v_compliance_status where company_id = '10001'`);
ok('試しの回は今の状態に数えない（10001 は未実施のまま）', v.status === '未実施', v);
r = await one(`select antisocial_enqueue('10001','手動',null,false,'tester') as id`);
const c2 = num(r.id);
await run('本物の回を送ったことにする', `update compliance_check_item set state = '調査中', rr_customer_id = 910000 + item_id, rr_execution_id = 810000 + item_id where check_id = ${c2};`);
const its2 = await all(`select item_id, rr_customer_id, rr_execution_id from compliance_check_item where check_id = $1 order by item_id`, [c2]);
await pg.query(`select antisocial_apply_result($1::jsonb)`, [JSON.stringify({ resultList: its2.map((x) => ({ checkExecutionId: num(x.rr_execution_id), customerId: num(x.rr_customer_id),
  checkedExecutionAt: '2026-11-15 13:00:00', totalUrlCount: 0, riskLevelCount: { high: 0, middle: 0, low: 0, none: 0, exclude: 0 }, newspaperResult: { message: 'success', articleCount: 0 } })) })]);
v = await one(`select status, status_valid_until, latest_trigger from v_compliance_status where company_id = '10001'`);
ok('ヒット 0 件 → 該当なし（自動）・有効期限 1 年', v.status === '該当なし' && String(v.status_valid_until.toISOString()).startsWith('2027-11-14') && v.latest_trigger === '手動', v);
ok('有効な結果があれば、手動以外のきっかけでは頼まない', (await one(`select antisocial_enqueue('10001','与信の稟議','YS-1',false,'x') as id`)).id === null);
await run('期限を過ぎたことにする', `update compliance_check set valid_until = date '2025-01-01', checked_on = date '2024-01-02' where check_id = ${c2};`);
v = await one(`select status from v_compliance_status where company_id = '10001'`);
ok('有効期限を過ぎると期限切れ（日付だけで出る）', v.status === '期限切れ', v);
await run('手入力の記録（有効期限は空）', `insert into compliance_check (company_id, checked_on, result, method) values ('10002', (now() at time zone 'Asia/Tokyo')::date, '問題なし', '手入力');`);
v = await one(`select status, status_valid_until from v_compliance_status where company_id = '10002'`);
ok('手入力の「問題なし」は実施日から 1 年を有効期限とみなす', v.status === '問題なし' && v.status_valid_until !== null, v);
ok('移行の行（結果なし）は未実施', (await one(`select status from v_compliance_status where company_id = '00001'`)).status === '未実施');
await run('auto_rule を no_high に', `update antisocial_setting set auto_rule = 'no_high';`);
r = await one(`select antisocial_enqueue('10006','手動',null,false,'tester') as id`);
const c3 = num(r.id);
await run('10006 を送ったことにする', `update compliance_check_item set state = '調査中', rr_customer_id = 920000 + item_id, rr_execution_id = 820000 + item_id where check_id = ${c3};`);
const its3 = await all(`select rr_customer_id, rr_execution_id, subject from compliance_check_item where check_id = $1 order by item_id`, [c3]);
await pg.query(`select antisocial_apply_result($1::jsonb)`, [JSON.stringify({ resultList: [
  { checkExecutionId: num(its3[0].rr_execution_id), customerId: num(its3[0].rr_customer_id), checkedExecutionAt: '2026-11-15 14:00:00', totalUrlCount: 30,
    riskLevelCount: { high: 0, middle: 3, low: 27, none: 0, exclude: 0 }, newspaperResult: { message: 'success', articleCount: 0 } },
  { checkExecutionId: num(its3[1].rr_execution_id), customerId: num(its3[1].rr_customer_id), checkedExecutionAt: '2026-11-15 14:00:00', totalUrlCount: 5,
    riskLevelCount: { high: 0, middle: 0, low: 5, none: 0, exclude: 0 }, newspaperResult: { message: 'success', articleCount: 1 } }] })]);
items = await all(`select subject, state from compliance_check_item where check_id = $1 order by item_id`, [c3]);
ok('no_high: 注目度 高 0 件は該当なし／新聞記事が 1 件でもあれば要確認', items[0].state === '該当なし' && items[1].state === '要確認', items);
ok('最新の回が要確認なら、今の状態は要確認', (await one(`select status from v_compliance_status where company_id = '10006'`)).status === '要確認');
await run('auto_rule を戻す', `update antisocial_setting set auto_rule = 'zero_hits';`);

// ---------------- 人（画面・REST）からは RoboRobo の記録を直せない ----------------
await run('ログインした人として振る舞う', `select set_config('request.jwt.claims', '{"role":"authenticated"}', false);`);
await expectErr('RoboRobo の回を直せない', `update compliance_check set result = '該当なし' where check_id = ${c3}`, '直せません');
await expectErr('RoboRobo の回を消せない', `delete from compliance_check where check_id = ${c3}`, '消せません');
await expectErr('RoboRobo の回を人が作れない', `insert into compliance_check (company_id, checked_on, source) values ('10003', '2026-11-15', 'roborobo')`, '関数だけ');
await run('手入力の行は今までどおり直せる', `update compliance_check set result = '該当なし' where company_id = '10002' and source is null and method = '手入力';`);
await expectErr('結果の言葉は決まったものだけ', `update compliance_check set result = 'OK' where company_id = '10002' and method = '手入力'`, 'compliance_check_result_chk');
await run('関数（service_role）に戻す', `select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);

await run('設定を変える（ログインした人）', `select set_config('request.jwt.claims', '{"role":"authenticated","email":"keiri@example.invalid"}', false);
  update antisocial_setting set check_rep = true; select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
r = await one(`select updated_by, updated_at from antisocial_setting`);
ok('設定を変えた人と時刻は DB が付ける', r.updated_by === 'keiri@example.invalid' && r.updated_at !== null, r);
ok('状態の計算に試験の会社の印が出る', (await one(`select is_test from v_compliance_status where company_id = '00009'`)).is_test === true);

// ---------------- 決まりに沿って頼む（定時実行） ----------------
r = await one(`select antisocial_enqueue_due() as j`);
ok('全体のスイッチが切れていれば何もしない', r.j.enabled === false, r.j);
await run('スイッチを入れる（テスト環境のトークン）', `update antisocial_setting set enabled = true, use_prod_token = false, on_credit = true, on_register = true, periodic = true;`);
await run('SF の知らせ（dev6 の申請中・本番の申請中・承認済み）', `insert into credit_notice (org_id, org_label, is_prod, kind, application_no, company_id, stage) values
  ('00Dfd000002CDWc','dev6',false,'与信','YS-00031','10005','申請中'),
  ('00D000000000001','本番',true,'与信','YS-00100','10009','申請中'),
  ('00D000000000001','本番',true,'与信','YS-00101','10002','申請中'),
  ('00Dfd000002CDWc','dev6',false,'与信','YS-00032','10007','承認');`);
r = await one(`select antisocial_enqueue_due() as j`);
ok('テスト環境のトークンの間: dev6 の申請中だけ試しで頼む（本番の申請・登録・見直しは待つ）', r.j.credit === 1 && r.j.register === 0 && r.j.periodic === 0, r.j);
r = await one(`select trigger_kind, trigger_ref, is_test, requested_by from compliance_check where company_id = '10005' and source = 'roborobo'`);
ok('回＝与信の稟議・稟議番号・試し・頼んだのは SF の org', r.trigger_kind === '与信の稟議' && r.trigger_ref === 'YS-00031' && r.is_test === true && r.requested_by === 'SF dev6', r);
ok('同じ稟議ではもう一度頼まない', (await one(`select antisocial_enqueue_due() as j`)).j.credit === 0);
await run('本番のトークンに切り替え・見直しは月 40 件（1 日 2 件）', `update antisocial_setting set use_prod_token = true, periodic_monthly_cap = 40;`);
r = await one(`select antisocial_enqueue_due() as j`);
ok('本番の申請中（有効な結果がある 10002 は頼まない）・登録・見直しが動く', r.j.credit === 1 && r.j.register === 1 && r.j.periodic === 2, r.j);
const per = await all(`select company_id from compliance_check where trigger_kind = '定期' and not is_test order by check_id`);
ok('見直しは本登録の顧客から外注へ（仮登録・上場・販管費先だけ・試験の会社は外す）', per.map((x) => x.company_id).join(',') === '10001,10004', per);
ok('見直しの 1 日の上限（2 件）を守る', (await one(`select antisocial_enqueue_due() as j`)).j.periodic === 0);
const reg = await all(`select company_id from compliance_check where trigger_kind = '登録'`);
ok('登録＝ツールで作ったばかりの会社だけ（SF の箱・移行・調べたことのある会社は除く）', reg.length === 1 && reg[0].company_id === '10008', reg);
r = await one(`select trigger_ref, is_test from compliance_check where company_id = '10009' and trigger_kind = '与信の稟議'`);
ok('本番の申請＝本物の回（試しではない）', r && r.trigger_ref === 'YS-00100' && r.is_test === false, r);

// ---------------- 権限 ----------------
r = await one(`select has_function_privilege('authenticated','public.antisocial_enqueue(varchar,varchar,varchar,boolean,varchar)','execute') as a,
  has_function_privilege('authenticated','public.antisocial_apply_result(jsonb)','execute') as b,
  has_function_privilege('service_role','public.antisocial_enqueue_due()','execute') as c`);
ok('頼む・取り込むのは関数（service_role）だけ', r.a === false && r.b === false && r.c === true, r);
r = await one(`select count(*) filter (where tablename = 'compliance_check_item') as i, count(*) filter (where tablename = 'antisocial_setting') as s from pg_policies`);
ok('RLS: 項目は読むだけ 1 本・設定は読む／変える 2 本', num(r.i) === 1 && num(r.s) === 2, r);

console.log(fails ? `\n${fails} FAIL` : '\nALL OK');
process.exit(fails ? 1 : 0);
