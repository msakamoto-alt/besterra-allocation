#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
besterra-allocation : 段階A データ移行ローダ

現行 Google Sheets（6シート）の中身を取得・整形し、Supabase の各テーブルへ
PostgREST 経由で一括投入する。段階A は RLS 無効なので anon キーで書き込める。

認証情報は環境変数から読む（リポジトリにキーを埋め込まない）：
  SUPABASE_URL       例: https://xxxx.supabase.co
  SUPABASE_ANON_KEY  anon public キー

実行：
  SUPABASE_URL=... SUPABASE_ANON_KEY=... python supabase/load_data.py
冪等：各テーブルを一旦全削除してから投入する（再実行で重複しない）。
"""
import os, sys, json, csv, io, time, urllib.request, urllib.parse, urllib.error, re

SHEET_ID = '1f1OBRkX4UG1BQqBCf196dTuoiGKin-WPcXOpHrE0rhA'
SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
ANON = os.environ.get('SUPABASE_ANON_KEY', '')
if not SUPABASE_URL or not ANON:
    sys.exit('ERROR: SUPABASE_URL と SUPABASE_ANON_KEY を環境変数で渡してください')

# ---- Google Sheets 取得 ----
def fetch_rows(tab):
    url = (f'https://docs.google.com/spreadsheets/d/{SHEET_ID}'
           f'/gviz/tq?tqx=out:csv&sheet=' + urllib.parse.quote(tab))
    raw = urllib.request.urlopen(url, timeout=60).read().decode('utf-8', errors='replace')
    return list(csv.reader(io.StringIO(raw)))

# ---- gviz 結合バグ（全列 text シート）の検出と分離 ----
KNOWN_HEAD = re.compile(r'^(override_key|prospect_id|project_id|社員コード|社員番号|No)$', re.I)
def demerge(rows):
    """先頭行が 'ヘッダ名 値' の形で結合していたら、最初の空白で分割して復元する。"""
    if not rows:
        return rows
    first = rows[0]
    c0 = str(first[0]) if first else ''
    m = re.match(r'^(\S+)\s', c0)
    if m and KNOWN_HEAD.match(m.group(1)):
        headers, firstvals = [], []
        for cell in first:
            s = str(cell)
            mm = re.match(r'^(\S+)(\s+(.*))?$', s)
            if mm:
                headers.append(mm.group(1))
                firstvals.append((mm.group(3) or '').strip())
            else:
                headers.append(s); firstvals.append('')
        return [headers, firstvals] + rows[1:]
    return rows

def to_dicts(rows, ncols=None):
    if not rows:
        return []
    hdr = rows[0]
    last = max([i for i, c in enumerate(hdr) if str(c).strip() != ''], default=-1)
    if ncols is not None:
        last = ncols - 1
    hdr = [str(h).strip() for h in hdr[:last + 1]]
    out = []
    for r in rows[1:]:
        d = {hdr[i]: (r[i] if i < len(r) else '') for i in range(len(hdr))}
        out.append(d)
    return out

# ---- Salesforce 整形（parseSalesforceCsv 相当） ----
EMOJI = re.compile('[\U0001F000-\U0001FAFF☀-➿⬀-⯿︀-️←-⇿]')
def norm_name(s):
    return EMOJI.sub('', str(s or '')).strip()

def parse_salesforce(rows):
    if not rows or len(rows) < 2:
        return []
    headers = [str(h) for h in rows[0]]
    def find_col(*pats):
        for i, h in enumerate(headers):
            for p in pats:
                if p in h:
                    return i
        return -1
    cols = {
        'dept': find_col('所属', '部門'),
        'emp': find_col('工事部員', '担当者'),
        'role': find_col('ロール'),
        'role_detail': find_col('ロール詳細'),
        'contract_type': find_col('受注形態'),
        'project_id': find_col('工事番号'),
        'project_name': find_col('工事名', '通称'),
        'start': find_col('着工'),
        'end': find_col('完工'),
        'total_revenue': find_col('総売上'),
        'order_amount': find_col('受注金額'),
        'status': find_col('状態'),
    }
    # 'ロール' と 'ロール詳細' が同じ列を指す場合は 'ロール' 完全一致で取り直す
    if cols['role'] == cols['role_detail'] and cols['role_detail'] >= 0:
        for i, h in enumerate(headers):
            if h.strip() == 'ロール':
                cols['role'] = i
                break
    def g(c, i):
        idx = cols[i]
        return c[idx] if 0 <= idx < len(c) else ''
    out = []
    for r in rows[1:]:
        if cols['dept'] >= 0 and '合計' in str(g(r, 'dept')):
            continue
        emp = norm_name(g(r, 'emp'))
        pid = str(g(r, 'project_id')).strip()
        if not emp:
            continue
        if not pid or re.match(r'^(-|nan|null|na|n/a|undefined)$', pid, re.I):
            continue
        if not re.search(r'[A-Za-z]', pid) or not re.search(r'\d', pid):
            continue
        out.append({
            'department': g(r, 'dept') or '',
            'emp_name': emp,
            'emp_name_raw': g(r, 'emp') or '',
            'role': g(r, 'role') or '',
            'role_detail': (c if (c := g(r, 'role_detail')) else '') if cols['role_detail'] >= 0 else '',
            'contract_type': g(r, 'contract_type') or '',
            'project_id': pid,
            'project_name': g(r, 'project_name') or '',
            'start': (str(g(r, 'start')).strip() or None),
            'end': (str(g(r, 'end')).strip() or None),
            'total_revenue': g(r, 'total_revenue') or '',
            'order_amount': g(r, 'order_amount') or '',
            'status': g(r, 'status') or '',
        })
    return out

# ---- PostgREST 書き込み ----
def rest(method, path, body=None, headers=None):
    url = f'{SUPABASE_URL}/rest/v1/{path}'
    h = {'apikey': ANON, 'Authorization': f'Bearer {ANON}',
         'Content-Type': 'application/json', 'Prefer': 'return=minimal'}
    if headers:
        h.update(headers)
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, resp.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', errors='replace')

def delete_all(table, col):
    st, txt = rest('DELETE', f'{table}?{col}=not.is.null')
    print(f'  delete {table}: HTTP {st} {txt[:120]}')

def insert(table, rows, batch=500):
    total = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        st, txt = rest('POST', table, chunk)
        if st not in (200, 201, 204):
            print(f'  !! insert {table} [{i}:{i+len(chunk)}] HTTP {st}: {txt[:300]}')
            sys.exit(1)
        total += len(chunk)
    print(f'  insert {table}: {total} 行 OK')

# ---- メイン ----
def main():
    print(f'Supabase: {SUPABASE_URL}')

    # 01 employees（実列 11・末尾の空列は除外）
    emp = to_dicts(fetch_rows('01_employees'))
    emp = [r for r in emp if str(r.get('社員番号', '')).strip()]
    delete_all('employees', 'id'); insert('employees', emp)

    # 09 salesforce_imports（整形後の形で保存）
    sf = parse_salesforce(fetch_rows('09_salesforce_imports'))
    delete_all('salesforce_imports', 'id'); insert('salesforce_imports', sf)

    # 11 prospects
    pro = to_dicts(fetch_rows('11_prospects'))
    pro = [r for r in pro if str(r.get('prospect_id', '')).strip()]
    delete_all('prospects', 'prospect_id'); insert('prospects', pro)

    # 12 assignment_overrides（結合バグを分離）
    ov = to_dicts(demerge(fetch_rows('12_assignment_overrides')))
    ov = [r for r in ov if str(r.get('override_key', '')).strip()]
    delete_all('assignment_overrides', 'override_key'); insert('assignment_overrides', ov)

    # 07 g_work_logs
    gw = to_dicts(fetch_rows('07_G_work_logs'))
    gw = [r for r in gw if str(r.get('社員コード', '')).strip()]
    delete_all('g_work_logs', 'id'); insert('g_work_logs', gw)

    # 13 project_status_overrides
    ps = to_dicts(fetch_rows('13_project_status_overrides'))
    ps = [r for r in ps if str(r.get('project_id', '')).strip()]
    delete_all('project_status_overrides', 'project_id'); insert('project_status_overrides', ps)

    print('\n完了。各テーブルの行数:')
    for t in ['employees', 'salesforce_imports', 'prospects',
              'assignment_overrides', 'g_work_logs', 'project_status_overrides']:
        st, txt = rest('GET', f'{t}?select=count', headers={'Prefer': 'count=exact', 'Range': '0-0'})

if __name__ == '__main__':
    main()
