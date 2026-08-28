# 取引先マスタ 本番昇格手順（2026-08-26準備・🔴実行はゴーサイン後）

学習用Supabase（iinbnc）で完成させた取引先マスタを、**本番Supabase**（besterra-allocation本体と同じプロジェクト）へ昇格する。

- 方針＝**A: 実データ入りで昇格**（2026-08-26 坂本さん決定）。18テーブル＋RLS＋2,563社。
- 🔴**この手順の実行は坂本さんのゴーサイン後**。準備物はすべて揃っている。
- 昇格後は**本番が正本**。学習用DBは検証用に格下げ（以後の編集は本番で行う）。

## 事前に揃っているもの

| ファイル | 役割 |
|---|---|
| `prod_01_schema_rls.sql` | 18テーブル＋RLS（学習用DDLから機械生成・構造は同一） |
| `prod_02_after_load.sql` | データ投入後のシーケンス調整（BIGSERIAL 8列） |
| `自動化\API連携\promote_to_prod.py` | 学習用→本番のデータ移行（dry-run既定・二重投入ガード付き） |
| `検証スクリプト\verify_prod_migration.py` | 検証（データ9項目＋RLS 7項目） |

## RLS設計（prod_01 に実装済み）

- 18テーブルすべて: SELECT / INSERT / UPDATE / DELETE ＝ **admin ＋ accounting のみ**
- anon（未ログイン）は読み書きとも不可
- `company_history` のみ **DELETE は admin 限定**（履歴は原則消さない）
- 🔴既存の監査トリガー（audit_logs / log_audit()）は**掛けない**（履歴は company_history が正・坂本さん決定）
- `app_role()` は既存（phaseE1a_roles.sql）をそのまま使う

## 実行手順（ゴーサイン後・所要 約20分）

### 1. スキーマ＋RLS適用（SQL Editor）
本番Supabaseの SQL Editor を**空にしてから** `prod_01_schema_rls.sql` の全文を貼り付けて Run。
末尾のSELECTが **18行・rowsecurity=true** を返すことを確認。

### 2. データ投入（PowerShell）
```powershell
# service_role キーは ダッシュボード → Settings → API → service_role からコピー
$env:PROD_SERVICE_KEY="<service_roleキー>"
python "…\自動化\API連携\promote_to_prod.py"            # dry-run（件数確認・書込なし）
python "…\自動化\API連携\promote_to_prod.py" --apply    # 本番へ投入
```
- 安全装置: 本番 company が空でなければ中止／学習用が2,563社でなければ中止
- 終わったらキーを消す: `Remove-Item Env:PROD_SERVICE_KEY`

### 3. シーケンス調整（SQL Editor）
`prod_02_after_load.sql` を実行（8本のsetval）。**忘れると新規の口座登録等で主キー重複が起きる**。

### 4. 検証
```powershell
python "…\検証スクリプト\verify_prod_migration.py"      # 16項目 ALL PASS を確認
```

### 5. 画面の切替（ローカル）
- `js/config.local.js` を削除（またはリネーム）→ 画面は本体と同じ＝**本番**を見る
- ローカルで動作確認（一覧2,563社・編集・口座・API更新チェック）
- スモーク一式を実行（verify_torihikisaki*.py は接続先が config.local.js 依存のため、
  🔴削除後は**本番に対して走る**。書込系テストは原状復帰するが、実行するかは坂本さんの判断）

### 6. コミット＆デプロイ（🔴push前にもう一度ゴーサイン）
- `?v=` をタイムスタンプ更新
- コミット対象: index.html / js/app.js / js/config.js / js/config.example.js /
  css/torihikisaki.css / js/views/torihikisaki*.js / supabase/functions/torihikisaki-enrich/ /
  supabase/torihikisaki_prod/
- 🔴巻き込まない: assets/pet/*.gif・build_quals_map.py・全社有資格者マップ_デモ.html・config.local.js
- push（=GitHub Pages 即デプロイ）→ 本番URLで塩田さんに共有可能になる

## 昇格後の運用メモ

- 塩田さん（accounting・t.shiota@）は既存アカウントでそのままログイン可
- 学習用DB（iinbnc）は検証用に残す。keepalive は7/13から停止中＝いずれ休止する。
  必要な検証があれば都度 Restore
- Edge Function `torihikisaki-enrich` は既に本番稼働中（変更不要）
