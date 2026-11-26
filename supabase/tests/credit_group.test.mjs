// credit_group.sql を手元の PostgreSQL（PGlite＝WASM 版・Supabase に貼る前の通し）で流す。
// 学習用の形（app_role() 無し・RLS 無し）→ 本番の形（app_role() 有り・RLS）の順に 4 回流し、決まりのトリガ・別紙の記録・view・権限・security_invoker を確かめる。
// 2026-11-25: view は「与信は会社ごと・グループの限度額は合計」。11/04 の view が入っている DB（今の本番ハブ）へ credit_group_per_company.sql を流す道も、学習用の形・本番の形の両方で通す。
// 使い方（初回は npm install が要る・node_modules は git に入れない）:
//   cd C:\Users\sakamoto\besterra-allocation\supabase\tests
//   npm install
//   node credit_group.test.mjs            → 最後に ALL OK
// 版: @electric-sql/pglite 0.2.17 を固定（0.3.6 はこの PC（Windows・Node 24）で "memory access out of bounds" で落ちた・2026-11-04）
// 作った理由: 2026-11-04 に坂本さんの SQL Editor で 2 度止めてしまった（app_role() 無し・再帰の配列の型）。渡す前にここで通す。
import { PGlite } from '@electric-sql/pglite';
import { execSync } from 'node:child_process';
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
async function runScript(label, sql) {  // SQL Editor と同じく最後の結果を返す（画面に出るのはこの 1 行だけ）
  try {
    const rs = await pg.exec(sql);
    ok(label, true);
    return Object.fromEntries(Object.entries(rs[rs.length - 1].rows[0]).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
  } catch (e) { ok(label, false, e.message.split('\n').slice(0, 3).join(' | ')); return {}; }
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
// ---------------- 2026-11-25: 後追いの SQL（credit_group_per_company.sql）を通すための道具 ----------------
const perCompanySql = fs.readFileSync(path.join(HERE, '..', 'credit_group_per_company.sql'), 'utf8');
// 11/04 の view（一括手続先は与信先の行を読む）が入っている版＝今の本番ハブに流してある credit_group.sql
const OLD_SQL = execSync('git show f4dc89b:supabase/credit_group.sql', { cwd: path.join(HERE, '..', '..'), encoding: 'utf8', maxBuffer: 1 << 24 });
const viewCols = async () => (await rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'v_credit_effective' order by ordinal_position`)).map(r => r.column_name);
// view の今の形（定義・権限・説明・security_invoker）と、与信先の列の説明
const viewShape = async () => row(`select pg_get_viewdef('public.v_credit_effective'::regclass, true) as def,
  array_to_string(array(select x::text from unnest((select relacl from pg_class where oid = 'public.v_credit_effective'::regclass)) x order by 1), ' ') as acl,
  obj_description('public.v_credit_effective'::regclass, 'pg_class') as note,
  (select reloptions::text from pg_class where oid = 'public.v_credit_effective'::regclass) as opts,
  (select col_description('public.company'::regclass, attnum) from pg_attribute where attrelid = 'public.company'::regclass and attname = 'credit_holder_id') as holder_note`);
// 表の中身の指紋（会社・与信の行・別紙の記録）と、後追いの SQL の最後の 1 行に出るはずの数。SQL を流す前後で指紋が同じなら、データは 1 行も変わっていない
const dataPrint = async () => row(`select (select md5(coalesce(string_agg(c::text, '|' order by c.company_id), '')) from company c) as company,
  (select md5(coalesce(string_agg(l::text, '|' order by l.credit_id), '')) from credit_line l) as credit_line,
  (select md5(coalesce(string_agg(g::text, '|' order by g.id), '')) from credit_group_listing g) as listing,
  (select count(*)::int from company) as companies,
  (select count(*)::int from (select distinct on (company_id) limit_amount from credit_line order by company_id, credit_id desc) t where limit_amount is not null) as with_limit,
  (select coalesce(sum(limit_amount), 0)::text from (select distinct on (company_id) limit_amount from credit_line order by company_id, credit_id desc) t) as limit_total,
  (select count(*)::int from company where credit_holder_id is not null and credit_exempt is not true) as group_mode`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 11/04 の view が入っている DB（今の本番ハブの見立て）に後追いの SQL を流す → 本体と同じ view・権限・説明になり、データは 1 行も変わらない
async function upgradeFromOld(form, wantAnon) {
  const want = await viewShape();   // 本体（credit_group.sql）を流した直後の形
  const before = await dataPrint();
  await run(`${form}: 11/04 の view に戻す（今の本番ハブの見立て）`, 'drop view public.v_credit_effective;\n' + OLD_SQL);
  const old = await viewShape(); const oldCols = await viewCols();
  const isOld = oldCols.includes('own_credit_conflict') && !oldCols.includes('group_limit_amount') && old.def !== want.def && old.note !== want.note && old.holder_note !== want.holder_note;
  ok(`${form}:   前の view になった（own_credit_conflict がある・group_limit_amount は無い・説明も前のもの）`, isOld, isOld ? undefined : oldCols);
  // 途中で止まったら何も変わらないこと（DO ブロックの中で view を落としたあとに失敗させる）
  await run(`${form}: 途中で失敗する形にする（与信の行の列名を一時的に変える）`, `alter table credit_line rename column used_amount to used_amount_x`);
  let msg = '';
  try { await pg.exec(perCompanySql); } catch (e) { msg = e.message || ''; }
  ok(`${form}: 後追いの SQL は途中で止まる -> ${msg.split('\n')[0]}`, msg.includes('used_amount'));
  await run(`${form}: 列名を戻す`, `alter table credit_line rename column used_amount_x to used_amount`);
  ok(`${form}:   止まったら何も変わらない（前の view・権限・説明のまま）`, same(await viewShape(), old));
  for (const n of [1, 2]) {
    const r = await runScript(`${form}: credit_group_per_company.sql ${n} 回目`, perCompanySql);
    ok(`${form}:   最後の 1 行: prod_form ${form === '本番の形'} / new_columns 2 / old_columns 0 / anon ${wantAnon} / authenticated true / 会社 ${before.companies} / 限度額あり ${before.with_limit}・合計 ${before.limit_total} / グループの与信 ${before.group_mode}`,
      r.prod_form === (form === '本番の形') && r.new_columns === 2 && r.old_columns === 0 && r.anon_can_read === wantAnon && r.auth_can_read === true
      && r.companies === before.companies && r.with_limit === before.with_limit && String(r.limit_total) === before.limit_total && r.group_mode === before.group_mode, r);
    const got = await viewShape();
    ok(`${form}:   view の定義・権限・説明・security_invoker・与信先の列の説明は credit_group.sql 本体と同じ`, same(got, want), same(got, want) ? undefined : (got.def === want.def ? [got, want] : 'view の定義が違う'));
  }
  ok(`${form}:   security_invoker が付いている`, String(want.opts).includes('security_invoker=true'), want.opts);
  ok(`${form}:   会社・与信の行・別紙の記録は 1 行も変わらない`, same(await dataPrint(), before));
  await run(`${form}: 11/04 の view の上から本体（credit_group.sql）を流しても通る`, 'drop view public.v_credit_effective;\n' + OLD_SQL + '\n' + sql);
  ok(`${form}:   本体でも同じ形になる・データも変わらない`, same(await viewShape(), want) && same(await dataPrint(), before));
}

// ---------------- 種別のメイン（company_main_type.sql）: 何度流しても同じ・最後の 1 行 ----------------
const mainSql = fs.readFileSync(path.join(HERE, '..', 'company_main_type.sql'), 'utf8');
for (const n of [1, 2]) {
  const r = await runScript(`company_main_type.sql ${n} 回目`, mainSql);
  ok(`   最後の 1 行: prod_form false（学習用の形）/ new_column 1 / with_main 0`, r.prod_form === false && r.new_column === 1 && r.with_main === 0, r);
}

// ---------------- 学習用の形 ----------------
let chk = await runScript('credit_group.sql 1 回目（学習用の形）', sql);
ok('最後の 1 行 学習用: prod_form false / listing_rls false / policies 2 / 列 6 / トリガ 2 / 別紙 0', chk.prod_form === false && chk.listing_rls === false && chk.listing_policies === 2 && chk.new_columns === 6 && chk.triggers === 2 && chk.listing_rows === 0, chk);
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
await expectErr('B4 2 段（B → A・A は P の与信）', `update company set credit_holder_id = 'A' where company_id = 'B'`, '単体で与信を取っている会社にしてください');
await run('B の与信先 = P（孫から頂点）', `update company set credit_holder_id = 'P', credit_listing_decided_on = '2019-05-15' where company_id = 'B'`);
await expectErr('与信先を持つ会社を与信不要に（A）', `update company set credit_exempt = true where company_id = 'A'`, '与信不要先');
await run('P の親 = X（頂点が上がる）', `update company set parent_company_id = 'X' where company_id = 'P'`);
await expectErr('B5 与信先の P が自分もグループの与信に（P → X）', `update company set credit_holder_id = 'X' where company_id = 'P'`, '社の与信先です');

await run('credit_line: P 15 億・使用 4.1 億／A 使用 1 億（限度なし）', `insert into credit_line (company_id, limit_amount, limit_type, valid_until, approved_on, used_amount) values ('P', 1500000000, '通常', '2027-05-31', '2026-05-15', 410000000); insert into credit_line (company_id, used_amount) values ('A', 100000000);`);
const EFF = `select credit_mode, holder_id, holder_name, limit_amount::text, valid_until::text, own_used_amount::text, remaining::text, group_limit_amount::text, group_used_amount::text, group_remaining::text, member_count::int, holder_not_ancestor from v_credit_effective where company_id = `;
let eff = await row(EFF + `'A'`);
ok('B7 v_credit_effective A＝グループ・与信先 P・自分の限度額なし（与信先の 15 億は読まない）・自分の使用 1 億／グループ 15 億・使用 5.1 億・残り 9.9 億・2 社',
  eff.credit_mode === 'グループ' && eff.holder_id === 'P' && eff.holder_name === '親ホールディングス' && eff.limit_amount === null && eff.valid_until === null && eff.own_used_amount === '100000000' && eff.remaining === null
  && eff.group_limit_amount === '1500000000' && eff.group_used_amount === '510000000' && eff.group_remaining === '990000000' && eff.member_count === 2 && eff.holder_not_ancestor === false, eff);
ok('   11/04 の印の列（own_credit_conflict・holder_without_credit）は無い', !(await viewCols()).some(c => c === 'own_credit_conflict' || c === 'holder_without_credit'));
let effP = await row(EFF + `'P'`);
ok('   P＝自分・限度 15 億・期限は自分の行・自分の使用 4.1 億・残り 10.9 億／グループ 15 億・使用 5.1 億・残り 9.9 億・2 社',
  effP.credit_mode === '自分' && effP.holder_id === 'P' && effP.limit_amount === '1500000000' && effP.valid_until === '2027-05-31' && effP.own_used_amount === '410000000' && effP.remaining === '1090000000'
  && effP.group_limit_amount === '1500000000' && effP.group_used_amount === '510000000' && effP.group_remaining === '990000000' && effP.member_count === 2, effP);
let effX = await row(EFF + `'X'`);
ok('   X＝自分・限度なし・グループの値も null・0 社', effX.credit_mode === '自分' && effX.holder_id === 'X' && effX.limit_amount === null && effX.remaining === null && effX.group_limit_amount === null && effX.group_used_amount === null && effX.group_remaining === null && effX.member_count === 0, effX);
let effE = await row(`select credit_mode from v_credit_effective where company_id = 'E'`);
ok('   E＝不要', effE.credit_mode === '不要', effE);
let grp = await rows(`select company_id, root_id, depth::int, path, child_count::int from v_company_group order by company_id`);
const g = Object.fromEntries(grp.map(r => [r.company_id, r]));
ok('   v_company_group: B の頂点 X・深さ 3・道 X,P,A,B／P の子 2', g.B.root_id === 'X' && g.B.depth === 3 && JSON.stringify(g.B.path) === JSON.stringify(['X','P','A','B']) && g.P.child_count === 2 && g.X.depth === 0 && grp.length === 5, grp);
await run('A に会社ごとの限度額 1 億（グループの与信の会社も自分の与信の行を持つ）', `insert into credit_line (company_id, limit_amount, limit_type, valid_until, used_amount) values ('A', 100000000, '普通', '2027-01-31', 100000000)`);
eff = await row(EFF + `'A'`);
ok('   A＝限度 1 億・期限は自分の行・残り 0／グループ 16 億（P 15 億＋A 1 億）・使用は後の行（1 社 1 行）で 5.1 億のまま・残り 10.9 億',
  eff.limit_amount === '100000000' && eff.valid_until === '2027-01-31' && eff.own_used_amount === '100000000' && eff.remaining === '0'
  && eff.group_limit_amount === '1600000000' && eff.group_used_amount === '510000000' && eff.group_remaining === '1090000000', eff);
effP = await row(EFF + `'P'`);
ok('   P＝自分の限度は 15 億のまま（与信先に小計は入れない）・残り 10.9 億／グループ 16 億', effP.limit_amount === '1500000000' && effP.remaining === '1090000000' && effP.group_limit_amount === '1600000000' && effP.group_remaining === '1090000000', effP);
await run('B に限度額 2 億・使用 0.3 億', `insert into credit_line (company_id, limit_amount, used_amount) values ('B', 200000000, 30000000)`);
effP = await row(EFF + `'P'`);
ok('   グループ 18 億（P＋A＋B）・使用 5.4 億・残り 12.6 億', effP.group_limit_amount === '1800000000' && effP.group_used_amount === '540000000' && effP.group_remaining === '1260000000', effP);
await run('B を欠番（停止）に', `update company set is_suspended = true where company_id = 'B'`);
effP = await row(EFF + `'P'`); let effB = await row(EFF + `'B'`);
ok('   欠番の会社の限度額はグループに数えない（16 億に戻る）・使用額は数えたまま（5.4 億・残り 10.6 億）・B の自分の行は 2 億のまま読める・一括手続先は 2 社のまま',
  effP.group_limit_amount === '1600000000' && effP.group_used_amount === '540000000' && effP.group_remaining === '1060000000' && effP.member_count === 2
  && effB.limit_amount === '200000000' && effB.remaining === '170000000' && effB.group_limit_amount === '1600000000', [effP, effB]);
await run('B を戻す（欠番を外し、与信の行を消す）', `update company set is_suspended = false where company_id = 'B'; delete from credit_line where company_id = 'B';`);
await run('限度額の無い会社（取引の無い親の見立て）を与信先に: X の下に子会社 Y（限度 3,000 万）', `insert into company (company_id, official_name, parent_company_id) values ('Y','子会社Y','X');
  update company set credit_holder_id = 'X', credit_listing_decided_on = '2026-11-25' where company_id = 'Y';
  insert into credit_line (company_id, limit_amount) values ('Y', 30000000);`);
eff = await row(EFF + `'Y'`); effX = await row(EFF + `'X'`);
ok('   Y＝グループ・与信先 X・限度 3,000 万／X＝自分の限度なし・グループ 3,000 万（子会社の合計）・1 社',
  eff.credit_mode === 'グループ' && eff.holder_id === 'X' && eff.limit_amount === '30000000' && eff.group_limit_amount === '30000000'
  && effX.credit_mode === '自分' && effX.limit_amount === null && effX.group_limit_amount === '30000000' && effX.member_count === 1, [eff, effX]);
await run('Y を片付ける', `delete from credit_line where company_id = 'Y'; delete from credit_group_listing where member_id = 'Y'; delete from company where company_id = 'Y';`);
effP = await row(EFF + `'P'`); effX = await row(EFF + `'X'`);
ok('   片付けのあと: P のグループ 16 億・使用 5.1 億／X は限度なし・0 社', effP.group_limit_amount === '1600000000' && effP.group_used_amount === '510000000' && effX.group_limit_amount === null && effX.member_count === 0, [effP, effX]);
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
await upgradeFromOld('学習用の形', true);

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
chk = await runScript('credit_group.sql 3 回目（本番の形）', sql);
ok('最後の 1 行 本番: prod_form true / listing_rls true / policies 1 / 列 6 / トリガ 2', chk.prod_form === true && chk.listing_rls === true && chk.listing_policies === 1 && chk.new_columns === 6 && chk.triggers === 2, chk);
priv = await row(`select has_table_privilege('anon','public.credit_group_listing','select') as a_sel, has_table_privilege('authenticated','public.credit_group_listing','select') as u_sel,
  has_table_privilege('authenticated','public.credit_group_listing','insert') as u_ins, has_table_privilege('authenticated','public.credit_group_listing','delete') as u_del,
  has_table_privilege('anon','public.v_credit_effective','select') as a_view, has_table_privilege('authenticated','public.v_credit_effective','select') as u_view,
  has_table_privilege('anon','public.v_company_group','select') as a_grp`);
ok('本番: anon 読めない／authenticated は select だけ／view も同じ', !priv.a_sel && priv.u_sel && !priv.u_ins && !priv.u_del && !priv.a_view && priv.u_view && !priv.a_grp, priv);
await run('credit_group.sql 4 回目（本番の形・2 度目）', sql);
cnt2 = await row(`select count(*)::int as n from credit_group_listing`);
ok('本番の形でも記録は消えない', cnt2.n === 5, cnt2);
await upgradeFromOld('本番の形', false);
priv = await row(`select has_table_privilege('anon','public.v_credit_effective','select') as a_view, has_table_privilege('authenticated','public.v_credit_effective','select') as u_view`);
ok('本番の形: 後追いのあとも anon は view を読めない／authenticated は読める', !priv.a_view && priv.u_view, priv);
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

// ---------------- 表記の直し（credit_group_wording_tantai.sql）: 本体の関数と同じになること・何度流しても同じ ----------------
const guardSrc = async () => (await row(`select prosrc from pg_proc where oid = 'public.company_group_guard'::regproc`)).prosrc;
const srcBefore = await guardSrc();
const wording = await runScript('credit_group_wording_tantai.sql', fs.readFileSync(path.join(HERE, '..', 'credit_group_wording_tantai.sql'), 'utf8'));
ok('   最後の 1 行: prod_form true（本番の形）/ new_wording true', wording.prod_form === true && wording.new_wording === true, wording);
ok('   関数の中身は credit_group.sql 本体と同じ', (await guardSrc()) === srcBefore);
ok('   決まりのトリガは残っている', (await row(`select count(*)::int as n from pg_trigger where tgname = 'trg_company_group_guard'`)).n === 1);

// ---------------- 後追いの SQL は、credit_group.sql を流していない DB では何もせずに止まる ----------------
const shapeBefore = await viewShape();
await run('別紙の記録の表が無い DB の見立て（表の名前を一時的に変える）', `alter table credit_group_listing rename to credit_group_listing_x`);
let stopMsg = '';
try { await pg.exec(perCompanySql); } catch (e) { stopMsg = e.message || ''; }
ok('credit_group.sql を流していない DB: 後追いは止まる -> ' + stopMsg.split('\n')[0], stopMsg.includes('先に credit_group.sql を流してください'));
await run('表の名前を戻す', `alter table credit_group_listing_x rename to credit_group_listing`);
ok('   止まったら view はそのまま', same(await viewShape(), shapeBefore));

console.log(fails === 0 ? '\nALL OK' : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
