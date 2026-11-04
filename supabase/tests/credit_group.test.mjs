// credit_group.sql を手元の PostgreSQL（PGlite＝WASM 版・Supabase に貼る前の通し）で流す。
// 学習用の形（app_role() 無し・RLS 無し）→ 本番の形（app_role() 有り・RLS）の順に 4 回流し、決まりのトリガ・別紙の記録・view・権限・security_invoker を確かめる。
// 使い方（初回は npm install が要る・node_modules は git に入れない）:
//   cd C:\Users\sakamoto\besterra-allocation\supabase\tests
//   npm install
//   node credit_group.test.mjs            → 最後に ALL OK
// 版: @electric-sql/pglite 0.2.17 を固定（0.3.6 はこの PC（Windows・Node 24）で "memory access out of bounds" で落ちた・2026-11-04）
// 作った理由: 2026-11-04 に坂本さんの SQL Editor で 2 度止めてしまった（app_role() 無し・再帰の配列の型）。渡す前にここで通す。
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.join(HERE, '..', 'credit_group.sql');
const SCHEMA_PATH = path.join(HERE, '..', 'torihikisaki_prod', 'prod_01_schema_rls.sql');

const ddl = fs.readFileSync(SCHEMA_PATH, 'utf8');
function extractTable(name) {  // 本番スキーマから表 1 つの CREATE TABLE を切り出す（他の表への FK は外す）
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`, 'i');
  const m = ddl.match(re);
  if (!m) throw new Error('DDL not found: ' + name);
  return m[0].replace(/REFERENCES (\w+)\(([^)]*)\)/g, (s, t) => (t === 'company') ? s : '');
}

const pg = new PGlite();
let fails = 0;
const ok = (label, cond, info) => { console.log((cond ? 'OK   ' : 'FAIL ') + label + (info !== undefined ? '  ' + JSON.stringify(info) : '')); if (!cond) fails++; };
async function run(label, sql) {
  try { await pg.exec(sql); ok(label, true); }
  catch (e) { ok(label, false, e.message.split('\n').slice(0, 3).join(' | ')); }
}
async function expectErr(label, sql, needle) {
  try { await pg.query(sql); ok(label + '（通ってしまった）', false); }
  catch (e) { const m = e.message || ''; ok(label + ' -> ' + m.split('\n')[0], m.includes(needle)); }
}
async function row(sql, params) { const r = await pg.query(sql, params); return r.rows[0]; }
async function rows(sql, params) { const r = await pg.query(sql, params); return r.rows; }

await run('roles', `create role anon nologin; create role authenticated nologin; create role service_role nologin;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);  // Supabase の既定（新しい表は anon/authenticated に全部）
await run('schema company / credit_line', extractTable('company') + '\n' + extractTable('credit_line'));

const sql = fs.readFileSync(SQL_PATH, 'utf8');

// ---------------- 学習用の形 ----------------
await run('credit_group.sql 1 回目（学習用の形）', sql);
let chk = await row(`select (to_regproc('public.app_role') is not null) as prod_form,
  (select relrowsecurity from pg_class where oid = 'public.credit_group_listing'::regclass) as listing_rls,
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'credit_group_listing') as listing_policies`);
ok('確かめ 学習用: prod_form false / listing_rls false / policies 2', chk.prod_form === false && chk.listing_rls === false && chk.listing_policies === 2, chk);
let priv = await row(`select has_table_privilege('anon','public.credit_group_listing','select') as a_sel, has_table_privilege('anon','public.credit_group_listing','delete') as a_del,
  has_table_privilege('anon','public.credit_group_listing','insert') as a_ins, has_table_privilege('anon','public.credit_group_listing','update') as a_upd,
  has_table_privilege('anon','public.v_credit_effective','select') as a_view`);
ok('学習用: anon が別紙の記録を読める・消せる・view を読める／書けない', priv.a_sel && priv.a_del && priv.a_view && !priv.a_ins && !priv.a_upd, priv);

await run('会社 5 社', `insert into company (company_id, official_name) values ('P','親ホールディングス'),('A','子会社A'),('B','孫会社B'),('X','無関係X'),('E','与信不要E');`);
await expectErr('B1 親に自分', `update company set parent_company_id = 'A' where company_id = 'A'`, '自分自身');
await run('A の親 = P', `update company set parent_company_id = 'P' where company_id = 'A'`);
await expectErr('B1 輪（P の親に A）', `update company set parent_company_id = 'A' where company_id = 'P'`, '輪');
await run('B の親 = A・E の親 = P・E は与信不要', `update company set parent_company_id = 'A' where company_id = 'B'; update company set parent_company_id = 'P', credit_exempt = true where company_id = 'E';`);
await expectErr('B2 与信先が上の会社でない（A → X）', `update company set credit_holder_id = 'X' where company_id = 'A'`, 'たどった先にありません');
await expectErr('B2 与信先に自分', `update company set credit_holder_id = 'A' where company_id = 'A'`, '自分自身');
await expectErr('与信不要先に与信先（E → P）', `update company set credit_holder_id = 'P' where company_id = 'E'`, '与信不要先');
await run('A の与信先 = P（常務会 2019-05-15・経理 太郎）', `update company set credit_holder_id = 'P', credit_listing_decided_on = '2019-05-15', credit_listing_ref = '常務会 2019-05', updated_by = '経理 太郎', parent_ownership_pct = 100 where company_id = 'A'`);
let lst = await rows(`select member_id, holder_id, action, ownership_pct, decided_on::text as decided_on, decision_ref, created_by from credit_group_listing order by id`);
ok('B3 別紙の記録 1 行（載せる・P・2019-05-15・経理 太郎・100%）', lst.length === 1 && lst[0].action === '載せる' && lst[0].holder_id === 'P' && lst[0].decided_on === '2019-05-15' && lst[0].created_by === '経理 太郎' && Number(lst[0].ownership_pct) === 100, lst);
await expectErr('B4 2 段（B → A・A は P の与信）', `update company set credit_holder_id = 'A' where company_id = 'B'`, '自身がグループの与信');
await run('B の与信先 = P（孫から頂点）', `update company set credit_holder_id = 'P', credit_listing_decided_on = '2019-05-15' where company_id = 'B'`);
await expectErr('与信先を持つ会社を与信不要に（A）', `update company set credit_exempt = true where company_id = 'A'`, '与信不要先');
await run('P の親 = X（頂点が上がる）', `update company set parent_company_id = 'X' where company_id = 'P'`);
await expectErr('B5 与信先の P が自分もグループの与信に（P → X）', `update company set credit_holder_id = 'X' where company_id = 'P'`, '社の与信先です');

await run('credit_line: P 15 億・使用 4.1 億／A 使用 1 億（限度なし）', `insert into credit_line (company_id, limit_amount, limit_type, valid_until, approved_on, used_amount) values ('P', 1500000000, '通常', '2027-05-31', '2026-05-15', 410000000); insert into credit_line (company_id, used_amount) values ('A', 100000000);`);
let eff = await row(`select credit_mode, holder_id, holder_name, limit_amount::text, group_used_amount::text, remaining::text, member_count::int, own_credit_conflict, holder_without_credit, holder_not_ancestor, valid_until::text from v_credit_effective where company_id = 'A'`);
ok('B7 v_credit_effective A＝グループ・P・15 億・使用 5.1 億・残り 9.9 億・2 社・印 3 つ false', eff.credit_mode === 'グループ' && eff.holder_id === 'P' && eff.holder_name === '親ホールディングス' && eff.limit_amount === '1500000000' && eff.group_used_amount === '510000000' && eff.remaining === '990000000' && eff.member_count === 2 && eff.own_credit_conflict === false && eff.holder_without_credit === false && eff.holder_not_ancestor === false && eff.valid_until === '2027-05-31', eff);
let effP = await row(`select credit_mode, holder_id, group_used_amount::text, member_count::int, own_used_amount::text from v_credit_effective where company_id = 'P'`);
ok('   P＝自分・使用 5.1 億（合計）・2 社・自分の使用 4.1 億', effP.credit_mode === '自分' && effP.holder_id === 'P' && effP.group_used_amount === '510000000' && effP.member_count === 2 && effP.own_used_amount === '410000000', effP);
let effX = await row(`select credit_mode, holder_id, limit_amount, group_used_amount, member_count::int from v_credit_effective where company_id = 'X'`);
ok('   X＝自分・限度なし・使用 null・0 社', effX.credit_mode === '自分' && effX.holder_id === 'X' && effX.limit_amount === null && effX.group_used_amount === null && effX.member_count === 0, effX);
let effE = await row(`select credit_mode from v_credit_effective where company_id = 'E'`);
ok('   E＝不要', effE.credit_mode === '不要', effE);
let grp = await rows(`select company_id, root_id, depth::int, path, child_count::int from v_company_group order by company_id`);
const g = Object.fromEntries(grp.map(r => [r.company_id, r]));
ok('   v_company_group: B の頂点 X・深さ 3・道 X,P,A,B／P の子 2', g.B.root_id === 'X' && g.B.depth === 3 && JSON.stringify(g.B.path) === JSON.stringify(['X','P','A','B']) && g.P.child_count === 2 && g.X.depth === 0 && grp.length === 5, grp);
await run('A に自分の限度額（第4条に反する状態）', `insert into credit_line (company_id, limit_amount, used_amount) values ('A', 100000000, 100000000)`);
eff = await row(`select own_credit_conflict, group_used_amount::text from v_credit_effective where company_id = 'A'`);
ok('   own_credit_conflict true・使用額は後の行（1 社 1 行）で 5.1 億のまま', eff.own_credit_conflict === true && eff.group_used_amount === '510000000', eff);
await run('P の親を外す（X から切る）→ A の与信先は上のまま', `update company set parent_company_id = null where company_id = 'P'`);
eff = await row(`select holder_not_ancestor from v_credit_effective where company_id = 'A'`);
ok('   holder_not_ancestor false', eff.holder_not_ancestor === false, eff);
await expectErr('与信先を持つ A の親を直接 X に（止まる・外してから）', `update company set parent_company_id = 'X' where company_id = 'A'`, '先にグループの与信を外して');

await run('A をグループから外す（常務会 2026-11-30）', `update company set credit_holder_id = null, credit_listing_decided_on = '2026-11-30', credit_listing_ref = '常務会 2026-11' where company_id = 'A'`);
lst = await rows(`select member_id, holder_id, action, decided_on::text as decided_on, decision_ref from credit_group_listing where member_id = 'A' order by id`);
ok('B3 別紙の記録 A: 載せる → 外す（P・2026-11-30）', lst.length === 2 && lst[1].action === '外す' && lst[1].holder_id === 'P' && lst[1].decided_on === '2026-11-30', lst);
await run('A（与信先なし）の親を X に付け替え → 孫 B の与信先 P が上でなくなる（止めない・印）', `update company set parent_company_id = 'X' where company_id = 'A'`);
eff = await row(`select holder_not_ancestor, holder_id from v_credit_effective where company_id = 'B'`);
let gB = await row(`select root_id, path from v_company_group where company_id = 'B'`);
ok('   B: holder_not_ancestor true（画面と view で赤く出す）・頂点 X・道 X,A,B', eff.holder_not_ancestor === true && eff.holder_id === 'P' && gB.root_id === 'X' && JSON.stringify(gB.path) === JSON.stringify(['X','A','B']), [eff, gB]);
await run('A の親を P に戻す', `update company set parent_company_id = 'P' where company_id = 'A'`);
eff = await row(`select holder_not_ancestor from v_credit_effective where company_id = 'B'`);
ok('   B: holder_not_ancestor false に戻る', eff.holder_not_ancestor === false, eff);
await run('A をまた載せる', `update company set credit_holder_id = 'P', credit_listing_decided_on = '2026-12-10' where company_id = 'A'`);
await run('与信先の変わらない更新（記録は増えない）', `update company set official_name = '子会社A（改名）' where company_id = 'A'`);
lst = await rows(`select action from credit_group_listing where member_id = 'A' order by id`);
ok('   A の記録 3 行（載せる・外す・載せる）', lst.length === 3 && lst.map(r => r.action).join(',') === '載せる,外す,載せる', lst);
await run('insert で与信先つき（新会社 C・親 P）', `insert into company (company_id, official_name, parent_company_id, credit_holder_id, credit_listing_decided_on, created_by) values ('C','子会社C','P','P','2026-12-10','坂本')`);
lst = await rows(`select action, created_by from credit_group_listing where member_id = 'C'`);
ok('   C の記録 1 行（載せる・坂本）', lst.length === 1 && lst[0].action === '載せる' && lst[0].created_by === '坂本', lst);
let cnt = await row(`select count(*)::int as n from credit_group_listing`);
await run('credit_group.sql 2 回目（同じ結果）', sql);
let cnt2 = await row(`select count(*)::int as n from credit_group_listing`);
ok('2 回流しても記録は消えない', cnt.n === cnt2.n && cnt.n === 5, [cnt, cnt2]);

// 学習用で別紙の記録に RLS が掛かった場合（実害 2026-11-04: 流したのに anon から 0 行に見え、試験の片付けも効かなかった）
await run('学習用: 別紙の記録に RLS を掛ける（Supabase が付けた場合の見立て）', `alter table credit_group_listing enable row level security`);
await run('set role anon', `set role anon`);
let seenAnon = await row(`select count(*)::int as n from credit_group_listing`);
ok('RLS が掛かっても anon が読める', seenAnon.n === 5, seenAnon);
await run('anon が会社に親と与信先を付ける（トリガが記録を残す）', `insert into company (company_id, official_name, parent_company_id) values ('L','試験L','P'); update company set credit_holder_id = 'P', credit_listing_decided_on = '2026-12-10', updated_by = '試験' where company_id = 'L';`);
seenAnon = await row(`select count(*)::int as n from credit_group_listing where member_id = 'L'`);
ok('   L の記録 1 行が anon から見える', seenAnon.n === 1, seenAnon);
await expectErr('anon は別紙の記録に insert できない', `insert into credit_group_listing (member_id, holder_id, action) values ('L','P','載せる')`, 'permission denied');
await run('anon が試験の記録を消せる', `delete from credit_group_listing where member_id = 'L'`);
seenAnon = await row(`select count(*)::int as n from credit_group_listing where member_id = 'L'`);
ok('   L の記録が消えた', seenAnon.n === 0, seenAnon);
await run('reset role', `reset role; delete from company where company_id = 'L';`);
await run('credit_group.sql（RLS が掛かった状態から流し直す）', sql);
chk = await row(`select (select relrowsecurity from pg_class where oid = 'public.credit_group_listing'::regclass) as listing_rls`);
ok('流し直すと RLS は外れる', chk.listing_rls === false, chk);

// ---------------- 本番の形 ----------------
await run('app_role() を置く（本番の見立て）', `create function public.app_role() returns text language sql stable as $$ select 'admin'::text $$;`);
await run('credit_group.sql 3 回目（本番の形）', sql);
chk = await row(`select (to_regproc('public.app_role') is not null) as prod_form,
  (select relrowsecurity from pg_class where oid = 'public.credit_group_listing'::regclass) as listing_rls,
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'credit_group_listing') as listing_policies`);
ok('確かめ 本番: prod_form true / listing_rls true / policies 1', chk.prod_form === true && chk.listing_rls === true && chk.listing_policies === 1, chk);
priv = await row(`select has_table_privilege('anon','public.credit_group_listing','select') as a_sel, has_table_privilege('authenticated','public.credit_group_listing','select') as u_sel,
  has_table_privilege('authenticated','public.credit_group_listing','insert') as u_ins, has_table_privilege('authenticated','public.credit_group_listing','delete') as u_del,
  has_table_privilege('anon','public.v_credit_effective','select') as a_view, has_table_privilege('authenticated','public.v_credit_effective','select') as u_view,
  has_table_privilege('anon','public.v_company_group','select') as a_grp`);
ok('本番: anon 読めない／authenticated は select だけ／view も同じ', !priv.a_sel && priv.u_sel && !priv.u_ins && !priv.u_del && !priv.a_view && priv.u_view && !priv.a_grp, priv);
await run('credit_group.sql 4 回目（本番の形・2 度目）', sql);
cnt2 = await row(`select count(*)::int as n from credit_group_listing`);
ok('本番の形でも記録は消えない', cnt2.n === 5, cnt2);
// RLS: authenticated（app_role()='admin'）で読める・書けない
await run('set role authenticated', `set role authenticated`);
let seen = await row(`select count(*)::int as n from credit_group_listing`);
ok('authenticated（admin）で別紙の記録が読める', seen.n === 5, seen);
await expectErr('authenticated は別紙の記録に insert できない', `insert into credit_group_listing (member_id, holder_id, action) values ('A','P','載せる')`, 'permission denied');
await run('reset role', `reset role`);
await run('トリガ（security definer）は authenticated の更新でも記録を残す', `set role authenticated; update company set credit_holder_id = null where company_id = 'C'; reset role;`);
cnt2 = await row(`select count(*)::int as n from credit_group_listing where member_id = 'C'`);
ok('   C の記録 2 行', cnt2.n === 2, cnt2);
// security_invoker: company に本番と同じ RLS（admin／accounting）を掛けると、view は読む人の権限で絞られる
await run('company・credit_line に本番と同じ RLS', `alter table company enable row level security; alter table credit_line enable row level security;
  create policy t_sel_company on company for select to authenticated using (public.app_role() in ('admin','accounting'));
  create policy t_sel_credit on credit_line for select to authenticated using (public.app_role() in ('admin','accounting'));`);
await run('set role authenticated', `set role authenticated`);
seen = await row(`select count(*)::int as n from v_credit_effective`);
ok('admin は view で 6 社を読める', seen.n === 6, seen);
await run('reset role', `reset role`);
await run('app_role() を viewer に', `create or replace function public.app_role() returns text language sql stable as $$ select 'viewer'::text $$;`);
await run('set role authenticated', `set role authenticated`);
seen = await row(`select count(*)::int as n from v_credit_effective`);
let seen2 = await row(`select count(*)::int as n from v_company_group`);
let seen3 = await row(`select count(*)::int as n from credit_group_listing`);
ok('viewer は view も別紙の記録も 0 行（security_invoker・RLS が効く）', seen.n === 0 && seen2.n === 0 && seen3.n === 0, [seen, seen2, seen3]);
await run('reset role', `reset role`);

console.log(fails === 0 ? '\nALL OK' : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
