// 取引先マスタの「与信の稟議」の出し方（js/views/torihikisaki.js）を、ブラウザなしで確かめる。2026-11-28
// 決まり（坂本さん 11/28「試験の知らせは『テストのみ』のときだけ出す」）: 試験の知らせ（is_prod=false）は「テストのみ」のときだけ、
//   本物の知らせ（is_prod=true・空）は「テストのみ」以外のときだけ、数・一覧・会社の札・絞り込み・会社を開いたときの窓・与信の段の行に出す
// 使い方: cd C:\Users\sakamoto\besterra-allocation\supabase\tests && node torihikisaki_notice_visibility.test.mjs → 最後に ALL OK
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', '..', 'js', 'views', 'torihikisaki.js'), 'utf8');
const utilSrc = fs.readFileSync(path.join(HERE, '..', '..', 'js', 'util.js'), 'utf8'); // 画面は共通の道具 Util（esc など）を使う
const V = new Function(utilSrc + '\n' + src + '\nreturn TorihikisakiView;')();
let fails = 0;
const ok = (label, cond, info) => { console.log((cond ? 'OK   ' : 'FAIL ') + label + (info !== undefined ? '  ' + JSON.stringify(info) : '')); if (!cond) fails++; };
const tryv = (label, f) => { try { return f(); } catch (e) { ok(label + '（例外）', false, e.message); return undefined; } };

const real = { id: 1, company_id: '11771', org_label: '本番', is_prod: true, kind: '与信', application_no: 'YS-90001', stage: '申請中', done_at: null, requested_limit: 1 };
const realNull = { id: 2, company_id: '11456', org_label: null, is_prod: null, kind: '与信', application_no: 'YS-90002', stage: '承認', done_at: null, requested_limit: 1 };
const testOnReal = { id: 6, company_id: '11771', org_label: 'dev6', is_prod: false, kind: '与信', application_no: 'YS-00034', stage: '承認', done_at: null, requested_limit: 1 };
const testOnTest = { id: 19, company_id: '00028', org_label: 'dev7', is_prod: false, kind: '与信', application_no: 'YS-00003', stage: '申請中', done_at: null, requested_limit: 1 };
const testOnly = { id: 9, company_id: '12379', org_label: 'dev6', is_prod: false, kind: '与信', application_no: 'YS-00015', stage: '申請中', done_at: null, requested_limit: 1 };
const sendback = { id: 7, company_id: '11771', org_label: 'dev6', is_prod: false, kind: '与信', application_no: 'YS-00016', stage: '差し戻し', done_at: null };
const closed = { ...testOnReal, id: 8, application_no: 'YS-00017', done_at: '2026-11-01T00:00:00Z' };
V.notices = [real, realNull, testOnReal, testOnTest, testOnly, closed];
V.rows = [{ company_id: '11771', official_name: '本物の会社A' }, { company_id: '11456', official_name: '本物の会社C' },
  { company_id: '12379', official_name: '本物の会社B' }, { company_id: '00028', official_name: '試験の会社E', is_test: true }];
V.typeFilter = ''; V.typesByCid = {};
const has = (html, no) => (html || '').includes(no);

// 普段の画面（有効のみ）
V.stateFilter = 'active';
let s = tryv('noticeSummary active', () => V.noticeSummary());
ok('有効のみ: 数は本物の 2 件（空の is_prod も本物として出す）・押すと絞り込む札', has(s, '与信の稟議 2') && has(s, 'tmk-notice-filter'), s);
let p = tryv('noticePanelHtml active', () => V.noticePanelHtml());
ok('有効のみ: 一覧は本物だけ', has(p, 'YS-90001') && has(p, 'YS-90002') && !has(p, 'YS-00034') && !has(p, 'YS-00003') && !has(p, 'YS-00015'));
ok('有効のみ: 試験の知らせしか無い会社に札を出さない', V.noticeFor('12379') === null && V.noticeBadge('12379') === '');
ok('有効のみ: 本物の知らせがある会社は本物を出す', (V.noticeFor('11771') || {}).id === 1);
ok('閉じた知らせは出さない', V.noticeShown(closed) === false);

// テストのみ
V.stateFilter = 'test';
s = tryv('noticeSummary test', () => V.noticeSummary());
ok('テストのみ: 数は試験の 3 件・押せない札（絞り込みに切り替えない）', has(s, '与信の稟議 3') && !has(s, 'tmk-notice-filter'), s);
p = tryv('noticePanelHtml test', () => V.noticePanelHtml());
ok('テストのみ: 一覧は試験だけ（本物の会社につながった試験の知らせも）', has(p, 'YS-00034') && has(p, 'YS-00003') && has(p, 'YS-00015') && !has(p, 'YS-90001') && !has(p, 'YS-90002'));
ok('テストのみ: 本物の会社でも試験の知らせを出す', (V.noticeFor('11771') || {}).id === 6);

// 与信の稟議あり（絞り込み）・すべて
V.stateFilter = 'notice';
const m = (r) => tryv('matches ' + r.company_id, () => V.matches(r, '', null));
ok('与信の稟議あり: 試験の知らせしか無い会社は出さない', m({ company_id: '12379', official_name: '本物の会社B' }) === false);
ok('与信の稟議あり: 本物の知らせがある会社は出す', m({ company_id: '11771', official_name: '本物の会社A' }) === true);
ok('与信の稟議あり: 試験の会社（試験の知らせだけ）は出さない', m({ company_id: '00028', official_name: '試験の会社E', is_test: true }) === false);
V.stateFilter = 'all';
s = tryv('noticeSummary all', () => V.noticeSummary());
ok('すべて: 数は本物の 2 件', has(s, '与信の稟議 2'), s);

// 会社を開いたとき（与信の段の行・自動の窓の対象）
V.view = 'detail';
V.detail = { credit_line_test: [], notices: [real, testOnReal, sendback] };
const host = { id: 'tmk-fields' };
V.stateFilter = 'active';
let x = tryv('creditExtraHtml active', () => V.creditExtraHtml(host));
ok('有効のみ: 与信の段に本物の稟議だけ（試験の承認済み・差し戻し中は出さない）', has(x, 'YS-90001') && !has(x, 'YS-00034') && !has(x, 'YS-00016'));
ok('有効のみ: 自動で開く窓は本物の知らせ', (V.detail.notices.find(n => V.noticeShown(n)) || {}).id === 1);
V.detail = { credit_line_test: [], notices: [testOnReal] };
ok('有効のみ: 試験の知らせしか無い本物の会社では窓を開かない', V.detail.notices.find(n => V.noticeShown(n)) === undefined);
x = tryv('creditExtraHtml active only test', () => V.creditExtraHtml(host));
ok('有効のみ: 試験の知らせしか無いなら与信の段に何も足さない', x === '', x);
V.stateFilter = 'test';
V.detail = { credit_line_test: [], notices: [real, testOnReal, sendback] };
x = tryv('creditExtraHtml test', () => V.creditExtraHtml(host));
ok('テストのみ: 与信の段に試験の稟議（承認済み・差し戻し中）', has(x, 'YS-00034') && has(x, 'YS-00016') && !has(x, 'YS-90001'));
ok('テストのみ: 自動で開く窓は試験の知らせ', (V.detail.notices.find(n => V.noticeShown(n)) || {}).id === 6);

console.log(fails ? `\n${fails} FAIL` : '\nALL OK');
process.exit(fails ? 1 : 0);
