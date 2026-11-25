// 旧コードの表・社名変更の履歴の記録者と日時・適格請求書の登録日と失効日（company_old_code.sql）を、手元の PostgreSQL（PGlite）で通す
// 使い方: node company_old_code.test.mjs <hub_dump のフォルダ>      → 最後に ALL OK
//   hub_dump に company.json・system_code.json（あれば company_name_history.json）が要る（dump_hub.py）
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUMP = process.argv[2];
const ddl = fs.readFileSync(path.join(HERE, '..', 'torihikisaki_prod', 'prod_01_schema_rls.sql'), 'utf8');
const extractTable = (name) => ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`, 'i'))[0];
const load = (t) => JSON.parse(fs.readFileSync(path.join(DUMP, t + '.json'), 'utf8'));
const sql = fs.readFileSync(path.join(HERE, '..', 'company_old_code.sql'), 'utf8');
const pg = new PGlite();
let fails = 0;
const ok = (label, cond, info) => { console.log((cond ? 'OK   ' : 'FAIL ') + label + (info !== undefined ? '  ' + JSON.stringify(info) : '')); if (!cond) fails++; };
const one = async (q, p) => (await pg.query(q, p)).rows[0];
const err = async (q) => { try { await pg.exec(q); return null; } catch (e) { return e.message; } };

await pg.exec(`create role anon; create role authenticated;
  create function app_role() returns text language sql stable as $$ select current_setting('test.role', true) $$;`);
await pg.exec(['company', 'system_code', 'company_name_history'].map(extractTable).join('\n'));
await pg.exec('create unique index if not exists ux_system_code on system_code(system, code); alter table company alter column suspend_reason type text;');
async function insertAll(table, rows, cols) {
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200); const params = [];
    const tuples = part.map(r => '(' + cols.map(c => { params.push(r[c] === undefined ? null : r[c]); return '$' + params.length; }).join(',') + ')');
    await pg.query(`insert into ${table}(${cols.join(',')}) values ${tuples.join(',')}`, params);
  }
}
const companies = load('company'), codes = load('system_code');
await insertAll('company', companies, ['company_id', 'official_name', 'is_suspended', 'suspend_merged_into', 'registration_stage']);
await insertAll('system_code', codes, ['company_id', 'system', 'code']);
let names = [];
try { names = load('company_name_history'); } catch { /* 写しが無ければ 12 行の代わりを入れる */ }
if (!names.length) names = companies.slice(0, 12).map((c, i) => ({ company_id: c.company_id, changed_on: `2026-08-${String(i + 10)}`, old_name: '旧' + i, new_name: null }));
await insertAll('company_name_history', names, ['company_id', 'changed_on', 'old_name', 'new_name']);
const fp = async (t, cols) => (await one(`select md5(string_agg(md5(row(${cols})::text), '' order by md5(row(${cols})::text))) h, count(*)::int n from ${t}`));
const c0 = await fp('company', 'company_id, official_name, is_suspended, suspend_merged_into'), s0 = await fp('system_code', 'company_id, system, code'), n0 = await fp('company_name_history', 'company_id, changed_on, old_name, new_name');

// ---- 1 回目・2 回目（何度流しても同じ）
const run = async () => { const r = await pg.exec(sql); return r[r.length - 1].rows[0]; };
const r1 = await run(), r2 = await run();
ok('結果の 1 行', r1.old_code_table === true && Number(r1.policies_4) === 4 && Number(r1.triggers_3) === 3 && Number(r1.company_cols_2) === 2 && Number(r1.name_cols_2) === 2 && Number(r1.name_rows_unstamped) === names.length, r1);
ok('2 回流しても同じ結果', JSON.stringify(r1) === JSON.stringify(r2));
const c1 = await fp('company', 'company_id, official_name, is_suspended, suspend_merged_into'), s1 = await fp('system_code', 'company_id, system, code'), n1 = await fp('company_name_history', 'company_id, changed_on, old_name, new_name');
ok('会社・コード・社名の履歴の中身は 1 文字も変わらない', c0.h === c1.h && s0.h === s1.h && n0.h === n1.h, { company: c1.n, system_code: s1.n, name: n1.n });

// ---- 旧コード
const tera = codes.filter(c => c.system === 'tera');
const byId = Object.fromEntries(companies.map(c => [c.company_id, c]));
const usedCodes = new Set(codes.filter(c => ['tera', 'obc_onpre'].includes(c.system)).map(c => c.code));
const act = tera.find(c => !byId[c.company_id].is_suspended), act2 = tera.filter(c => !byId[c.company_id].is_suspended)[5];
const susp = tera.find(c => byId[c.company_id].is_suspended && byId[c.company_id].suspend_merged_into);
let free = 800; while (usedCodes.has(String(free))) free++;
let free2 = free + 1; while (usedCodes.has(String(free2))) free2++;
await pg.query('insert into company_old_code(company_id, code, memo, created_by, created_at) values ($1, $2, $3, $4, $5)', [act.company_id, String(free), '販管費のコード', '試験 太郎', '2000-01-01T00:00:00Z']);
const o1 = await one('select *, now() - created_at < interval \'1 minute\' as fresh from company_old_code where code = $1', [String(free)]);
ok('旧コードが入る・日時は DB が付ける（送った 2000 年は使われない）', o1 && o1.company_id === act.company_id && o1.created_by === '試験 太郎' && o1.fresh === true, { code: o1.code });
ok('ほかの会社に同じ旧コードは入らない', /company_old_code_code_key|duplicate/.test(await err(`insert into company_old_code(company_id, code) values ('${act2.company_id}', '${free}')`) || ''));
const e1 = await err(`insert into company_old_code(company_id, code) values ('${act2.company_id}', '${act.code}')`);
ok('有効な会社の今のコードと同じ番号は入らない（どの会社かを言う）', !!e1 && e1.includes('今のコードです') && e1.includes(act.company_id), e1);
const e2 = await err(`insert into company_old_code(company_id, code) values ('${susp.company_id === act2.company_id ? act.company_id : act2.company_id}', '${susp.code}')`);
ok('統合で停止した会社のコードと同じ番号も入らない（自動で出るので要らない）', !!e2 && e2.includes('今のコードです') && e2.includes(susp.company_id), e2);
ok('自分の今のコードも入らない', /今のコードです/.test(await err(`insert into company_old_code(company_id, code) values ('${act.company_id}', '${act.code}')`) || ''));
ok('空・前後の空白のあるコードは入らない', /company_old_code_code_chk/.test(await err(`insert into company_old_code(company_id, code) values ('${act.company_id}', '')`) || '') && /company_old_code_code_chk/.test(await err(`insert into company_old_code(company_id, code) values ('${act.company_id}', ' ${free2}')`) || ''));
await pg.query('update company_old_code set memo = $1, company_id = $2, created_by = $3, created_at = $4 where code = $5', ['メモを直した', act2.company_id, '別の人', '2001-01-01T00:00:00Z', String(free)]);
const o2 = await one('select * from company_old_code where code = $1', [String(free)]);
ok('直せるのはコードとメモだけ（会社・登録者・日時は変わらない）', o2.memo === 'メモを直した' && o2.company_id === act.company_id && o2.created_by === '試験 太郎' && String(o2.created_at) === String(o1.created_at));
ok('今のコードへの直しも止まる', /今のコードです/.test(await err(`update company_old_code set code = '${act2.code}' where code = '${free}'`) || ''));
await pg.exec(`update company_old_code set code = '${free2}' where code = '${free}'`);
ok('使われていない番号へは直せる', (await one('select count(*)::int n from company_old_code where code = $1', [String(free2)])).n === 1);
await pg.exec(`insert into company_old_code(company_id, code) values ('${act.company_id}', '${free}')`);
ok('1 社に 2 件持てる', (await one('select count(*)::int n from company_old_code where company_id = $1', [act.company_id])).n === 2);

// ---- 逆向き（今のコードに旧コードの番号は入らない）
const noTera = companies.find(c => !codes.some(x => x.company_id === c.company_id && x.system === 'tera'));
const e3 = await err(`insert into system_code(company_id, system, code) values ('${noTera.company_id}', 'tera', '${free}')`);
ok('tera の今のコードに旧コードの番号は入らない（どの会社かを言う）', !!e3 && e3.includes('旧コードです') && e3.includes(act.company_id), e3);
ok('勘定奉行オンプレも同じ', /旧コードです/.test(await err(`insert into system_code(company_id, system, code) values ('${noTera.company_id}', 'obc_onpre', '${free}')`) || ''));
ok('直すときも止まる', /旧コードです/.test(await err(`update system_code set code = '${free}' where company_id = '${act2.company_id}' and system = 'tera'`) || ''));
ok('勘定奉行クラウド・Salesforce のコードは番号の体系が別なので止めない', (await err(`insert into system_code(company_id, system, code) values ('${noTera.company_id}', 'obc_cloud', '${free}')`)) === null);
await pg.exec(`delete from system_code where company_id = '${noTera.company_id}' and system = 'obc_cloud'`);
ok('旧コードと関係ない今のコードの直しは、これまでどおり通る', (await err(`update system_code set code = code where company_id = '${act2.company_id}'`)) === null && (await err(`update system_code set code = 'ZZ99' where company_id = '${act2.company_id}' and system = 'tera'`)) === null);
await pg.exec(`update system_code set code = '${act2.code}' where company_id = '${act2.company_id}' and system = 'tera'`);
ok('旧コードを消すと、その番号は今のコードに使える', (await err(`delete from company_old_code where code = '${free}'; insert into system_code(company_id, system, code) values ('${noTera.company_id}', 'tera', '${free}')`)) === null);
await pg.exec(`delete from system_code where company_id = '${noTera.company_id}' and system = 'tera'; delete from company_old_code`);
const s2 = await fp('system_code', 'company_id, system, code');
ok('試験のあと、今のコードは最初と同じ', s2.h === s0.h && s2.n === s0.n, { n: s2.n });

// ---- 社名変更の履歴
await pg.query('insert into company_name_history(company_id, changed_on, old_name, new_name, recorded_by, recorded_at) values ($1, $2, $3, $4, $5, $6)', [act.company_id, '2026-11-25', '前', '後', '試験 太郎', '2000-01-01T00:00:00Z']);
const h1 = await one(`select recorded_by, now() - recorded_at < interval '1 minute' as fresh from company_name_history where company_id = $1 and changed_on = '2026-11-25'`, [act.company_id]);
ok('社名の履歴に入れると日時は DB が付ける', h1.recorded_by === '試験 太郎' && h1.fresh === true);
ok('同じ会社・同じ日は 1 行だけ（これまでどおり）', /duplicate|pkey/.test(await err(`insert into company_name_history(company_id, changed_on, old_name) values ('${act.company_id}', '2026-11-25', 'x')`) || ''));
ok('前からある行の日時は空のまま', (await one('select count(*)::int n from company_name_history where recorded_at is null')).n === names.length);

// ---- 登録日・失効日
await pg.query('update company set invoice_registered_on = $1, invoice_expired_on = $2 where company_id = $3', ['2023-10-01', '2025-04-01', act.company_id]);
const i1 = await one(`select invoice_registered_on::text a, invoice_expired_on::text b from company where company_id = $1`, [act.company_id]);
ok('登録日・失効日が入る', i1.a === '2023-10-01' && i1.b === '2025-04-01');

// ---- 権限（経理・管理者だけ）
await pg.exec(`grant select on company, system_code to authenticated; grant usage on schema public to authenticated, anon`);
await pg.exec(`insert into company_old_code(company_id, code) values ('${act.company_id}', '${free}')`);
async function as(role, appRole, q) {
  await pg.exec(`set test.role = '${appRole}'; set role ${role}`);
  let r, e = null;
  try { r = await pg.query(q); } catch (x) { e = x.message; }
  await pg.exec('reset role; reset test.role');
  return { n: r ? (r.rows.length || r.affectedRows || 0) : 0, e };
}
ok('経理は読める', (await as('authenticated', 'accounting', 'select * from company_old_code')).n === 1);
ok('経理は入れられる', (await as('authenticated', 'accounting', `insert into company_old_code(company_id, code) values ('${act.company_id}', '${free2}')`)).e === null);
ok('ほかのロールは読めない・入れられない', (await as('authenticated', 'viewer', 'select * from company_old_code')).n === 0 && /row-level security/.test((await as('authenticated', 'viewer', `insert into company_old_code(company_id, code) values ('${act.company_id}', 'Q1')`)).e || ''));
ok('ログインしていない人は触れない', /permission denied/.test((await as('anon', '', 'select * from company_old_code')).e || ''));

console.log(fails ? `\n${fails} 件 FAIL` : '\nALL OK');
process.exit(fails ? 1 : 0);
