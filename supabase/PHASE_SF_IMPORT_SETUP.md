# SF自動取込セットアップ手順（sf-import Edge Function）

Salesforceの配置レポートを、手動CSV→Sheets貼付を経ずに **APIから直接 salesforce_imports
テーブルへ取り込む** サーバー関数「**sf-import**」を Supabase 上に置く（初回のみ）。

- Salesforce へは**読取のみ**（トークン取得＋レポートGET）。SFへの書込は一切しない。
- テーブルの形は現行と同一のため、**アプリ側の変更は不要**。
- `dry_run`（既定）は書き込まず、現テーブルとの差分を報告するだけの安全モード。
- 実際の全置換は `action: "import"` を明示したときだけ。手順も「先に投入→成功後に旧行削除」
  （同期ボタンと同じ安全順）。

---

## 1. Secrets の設定（初回のみ）

1. Supabase ダッシュボード左メニュー **Edge Functions** → 上部の **Secrets** タブ
2. 以下の5つを追加（値は `自動化\SF連携検証\sf_credentials.json` からコピー）：

| Secret名 | 値（sf_credentials.json の対応キー） |
|---|---|
| `SF_INSTANCE_URL` | instance_url |
| `SF_CLIENT_ID` | client_id |
| `SF_CLIENT_SECRET` | client_secret |
| `SF_REPORT_ID` | report_id |
| `IMPORT_SECRET` | import_secret（スケジュール実行用の合言葉） |

> ⚠️ `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` の設定は不要（自動注入）。
> ⚠️ Secretの値はこのリポジトリに書かない（sf_credentials.json は git 外で管理）。

## 2. デプロイ（ダッシュボードから・CLIなし）

1. **Edge Functions** → **「Deploy a new function」→「Via Editor」**
2. 関数名に **`sf-import`** と入力（この名前でないと呼べません）
3. エディタの中身を全部消し、`supabase/functions/sf-import/index.ts` の中身を貼り付け
4. **Deploy** ボタンを押す
5. 関数の設定で **「Verify JWT」が ON**（既定）であることを確認

## 3. 動作確認

`自動化\SF連携検証\sf_import_call.py` を実行（書込なしの dry_run）：

```
python "C:\Users\sakamoto\Box\m.sakamoto\Besterra\01_組織\ツール【統合管理】\自動化\SF連携検証\sf_import_call.py"
```

- `sf_rows`（SF最新）と `db_rows`（現テーブル）、`matched / added / removed` の差分が表示される
- 差分は内容ベース（￥/JPY・日付ゼロ埋め・空白全半角・空欄「-」の表記差は無視）
- 実取込は `python ...sf_import_call.py import`（**現テーブルを全置換**するので差分確認後に）

## 4. 毎朝の自動実行（pg_cron・2026-07-15設定）

`自動化\SF連携検証\sf_import_cron_filled.sql`（キー記入済み）を
**SQL Editor** に貼り付けて Run（初回のみ）。雛形は `supabase/sf_import_cron.sql`。

- スケジュール = **毎朝6:00 JST**（pg_cronはUTC基準のため `0 21 * * *`）
- ジョブ名 = `sf-import-daily`（同名で再実行すれば上書き・`cron.unschedule` で解除）
- 実行履歴の確認：
  `select * from cron.job_run_details order by start_time desc limit 5;`
  `select id, status_code, left(content::text, 200) from net._http_response order by id desc limit 5;`

## 5. 同期ボタンとの役割分担（2026-07-15切替）

- **salesforce_imports の「編集の正」は Sheets → SF API（sf-import）へ移管済み。**
  「同期」ボタン（`syncReferenceFromSheets`）は salesforce_imports を**同期しない**
  （古いSheetsデータでAPI取込分が巻き戻る事故を防ぐため）。
- 同期ボタンの対象 = g_work_logs（勤怠）・organization（名簿）・employee_quals（資格）の3つ。
- Sheets の 09_salesforce_imports タブは**当面残置**（巻き戻し先の保険）。
  自動実行が数週間安定したら削除を検討。
- 緊急でSF最新を反映したいとき = `sf_import_call.py import` を手動実行（毎朝を待たなくてよい）。

## 6. うまくいかない時

- 「Secretsが未設定です」→ 手順1の5つを確認（名前の綴りまで一致させる）
- 「SFトークン取得失敗」→ sf_credentials.json の値と Secrets の値の食い違い・ECAの
  クライアントログイン情報フロー設定（Run As）を確認
- 「レポートが2,000行を超えています」→ 取込を安全側で中止する仕様（要ページング設計・相談）
- 朝6時に更新されていない → SQL Editorで上記の実行履歴2クエリを確認
  （status_code が 200 以外なら内容を共有してください）
- F12 → Network で `functions/v1/sf-import` の応答を確認して共有してください
