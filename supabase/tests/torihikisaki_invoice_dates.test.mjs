// 適格請求書の登録日・失効日を全社分まとめて入れる SQL（gen_sql_invoice_dates.py が作る）を、手元の PostgreSQL（PGlite）で通す
// 使い方: node torihikisaki_invoice_dates.test.mjs <hub_dump のフォルダ> <SQL のファイル> <invoice_dates_*.json>      → 最後に ALL OK
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [DUMP, SQL_PATH, DATES] = process.argv.slice(2);
const ddl = fs.readFileSync(path.join(HERE, '..', 'torihikisaki_prod', 'prod_01_schema_rls.sql'), 'utf8');
const extractTable = (name) => ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`, 'i'))[0];
const load = (t) => JSON.parse(fs.readFileSync(path.join(DUMP, t + '.json'), 'utf8'));
const dates = JSON.parse(fs.readFileSync(DATES, 'utf8'));
const ddl2 = fs.readFileSync(path.join(HERE, '..', 'company_old_code.sql'), 'utf8');
const sql = fs.readFileSync(SQL_PATH, 'utf8');
const pg = new PGlite();
let fails = 0;
const ok = (label, cond, info) => { console.log((cond ? 'OK   ' : 'FAIL ') + label + (info !== undefined ? '  ' + JSON.stringify(info) : '')); if (!cond) fails++; };
const one = async (q, p) => (await pg.query(q, p)).rows[0];
const all = async (q, p) => (await pg.query(q, p)).rows;
const err = async (q) => { try { await pg.exec(q); return null; } catch (e) { return e.message; } };

await pg.exec(`create role anon; create role authenticated; create function app_role() returns text language sql stable as $$ select 'admin' $$;`);
await pg.exec(['company', 'system_code', 'company_name_history', 'company_history'].map(extractTable).join('\n'));
await pg.exec(`alter table company add column is_test boolean not null default false; alter table company alter column suspend_reason type text;
  create table _sent(n int); create function _sfx() returns trigger language plpgsql as $$ begin insert into _sent values (1); return new; end $$;
  create trigger trg_sfx_company after insert or update on company for each row execute function _sfx();
  create table if not exists system_code_dummy(x int);`);
const companies = load('company');
for (let i = 0; i < companies.length; i += 200) {
  const part = companies.slice(i, i + 200); const params = [];
  const cols = ['company_id', 'official_name', 'is_suspended', 'registration_stage', 'invoice_reg_number', 'invoice_status', 'is_test', 'updated_at', 'updated_by'];
  const tuples = part.map(r => '(' + cols.map(c => { params.push(r[c] === undefined ? null : r[c]); return '$' + params.length; }).join(',') + ')');
  await pg.query(`insert into company(${cols.join(',')}) values ${tuples.join(',')}`, params);
}
await pg.exec('delete from _sent');
ok('列を足す前に流すと止まる（何も変わらない）', /先に company_old_code\.sql/.test(await err(sql) || ''));
await pg.exec(ddl2);

// 期待する姿を、SQL とは別に照会の結果から組み立てる
const exp = {};
Object.entries(dates.companies).forEach(([n, cs]) => cs.forEach(k => {
  const r = dates.results[n];
  if (r.registrationDate) exp[k] = [r.registrationDate, r.disposalDate || r.expireDate || null];
}));
const nEnd = Object.values(exp).filter(x => x[1]).length;
// 人が先に入れた日付・試験の会社・照会のあとに番号が変わった会社
const ids = Object.keys(exp);
const human = ids[10], changed = ids[20], test = ids[30], endId = ids.find(k => exp[k][1]);
await pg.query(`update company set invoice_registered_on = '2020-01-01' where company_id = $1`, [human]);
const keep = (await one('select invoice_reg_number n from company where company_id = $1', [changed])).n;
await pg.query(`update company set invoice_reg_number = 'T9999999999999' where company_id = $1`, [changed]);
await pg.query(`update company set is_test = true where company_id = $1`, [test]);
await pg.exec('delete from _sent');
const restFp = `select md5(string_agg(md5(row(company_id, official_name, is_suspended, invoice_reg_number, invoice_status, updated_at, updated_by)::text), '' order by company_id)) h from company`;
const f0 = (await one(restFp)).h;
const run = async () => { const r = await pg.exec(sql); return r[r.length - 1].rows[0]; };
const r1 = await run();
const got = Object.fromEntries((await all(`select company_id, invoice_registered_on::text a, invoice_expired_on::text b from company where invoice_registered_on is not null or invoice_expired_on is not null`)).map(r => [r.company_id, [r.a, r.b]]));
const want = JSON.parse(JSON.stringify(exp)); want[human] = ['2020-01-01', exp[human][1]]; delete want[changed]; delete want[test];
const diff = [...new Set([...Object.keys(got), ...Object.keys(want)])].filter(k => JSON.stringify(got[k]) !== JSON.stringify(want[k]));
ok('全社の登録日・失効日が、照会の結果と 1 社ずつ一致（人が入れた日付・番号が変わった会社・試験の会社は触らない）', diff.length === 0, { 会社: Object.keys(got).length, 違い: diff.slice(0, 5) });
ok('会社のほかの欄（登録番号・状態・最終更新）は 1 文字も変わらない', (await one(restFp)).h === f0);
ok('Salesforce への即時配信は動かない・トリガは戻っている', (await one('select count(*)::int n from _sent')).n === 0 && Number(r1.sf_trigger_on_1) === 1);
const h = await all(`select company_id, column_name, old_value, new_value, changed_by from company_history`);
const wantH = Object.entries(want).reduce((a, [k, v]) => a + (k === human ? 0 : 1) + (v[1] ? 1 : 0), 0);
ok('変更履歴は入れた分だけ 1 件ずつ', h.length === wantH && h.every(x => x.old_value === null && x.changed_by.includes('国税庁')), { 履歴: h.length });
ok('履歴の値と会社の値が合う', h.every(x => got[x.company_id][x.column_name === 'invoice_registered_on' ? 0 : 1] === x.new_value));
ok('失効のある会社の例', got[endId] && got[endId][1] === exp[endId][1], { [endId]: got[endId], 失効のある会社: nEnd });
// もう一度流しても同じ
const r2 = await run();
ok('2 回流しても同じ（履歴も増えない）', JSON.stringify(r1) === JSON.stringify(r2) && (await one('select count(*)::int n from company_history')).n === h.length, r2);
// 番号を戻すと、その会社だけ入る
await pg.query(`update company set invoice_reg_number = $2 where company_id = $1`, [changed, keep]);
await run();
ok('番号が一致するようになった会社は、流し直すと入る', (await one('select invoice_registered_on::text a from company where company_id = $1', [changed])).a === exp[changed][0]);
// 貼りそこない（番号が欠けた）
const c1 = (await one(`select md5(string_agg(md5(c::text), '' order by company_id)) h from company c`)).h;
const broken = sql.replace(/\n    \d{13} (?:\d{13} ){5}/, '\n    ');
ok('番号が欠けたまま流すと止まる（何も変わらない・トリガも戻る）', broken !== sql && /貼った番号の数が違う/.test(await err(broken) || '') && (await one(`select md5(string_agg(md5(c::text), '' order by company_id)) h from company c`)).h === c1 && (await one(`select tgenabled e from pg_trigger where tgname = 'trg_sfx_company'`)).e === 'O');
const left = await all(`select company_id, invoice_reg_number::text n from company where not is_test and nullif(btrim(invoice_reg_number::text), '') is not null and invoice_registered_on is null`);
ok('入らずに残るのは、国税庁の公表データに無い 2 社だけ', left.length === 2 && left.every(x => dates.results[x.n].state === '無し'), left);
console.log(fails ? `\n${fails} 件 FAIL` : '\nALL OK');
process.exit(fails ? 1 : 0);
