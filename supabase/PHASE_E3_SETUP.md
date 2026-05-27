# 段階E3 セットアップ手順（経営ドッキング・経営レポート）

R/F 分析資料・月次経営分析レポートの**生成済HTML**を Supabase に格納し、アプリ内の「経営レポート」タブで iframe 表示する。

- **このツールに初めて経営機密が入る段階**。レポートHTMLは Supabase の `management_reports` テーブルにのみ置き、**公開リポジトリ・公開URLには一切置かない**。
- 閲覧できるのは **admin / executive のみ**（RLSでサーバー強制。manager/editor/viewer はログイン済みでも読めない）。
- 月次差替は **admin がアプリ内アップロード**（HTMLファイル選択 → upsert）。Edge Function 不要。

## 仕組み

| 項目 | 内容 |
|---|---|
| テーブル | `management_reports`（report_type=analysis/rf・year_month=YYYYMM・html_content・(type,month)でUNIQUE） |
| RLS | SELECT=`app_role() in ('admin','executive')`／INSERT/UPDATE/DELETE=`app_role()='admin'` |
| 表示 | html_content → Blob URL → `<iframe sandbox="allow-scripts">`（allow-same-origin は付けない＝親のセッションに触れない） |
| 取得 | 一覧はメタのみ軽量取得・HTML本文は月を選んだ時に遅延取得 |

## カットオーバー手順（コードとDBを同時に切替）

> ⚠️ `feature/phase-e3-docking` のコードと `phaseE3_management_reports.sql` はどちらが先でも本番は壊れません
>    （新タブは admin/executive にしか出ず、テーブルが無くても一覧取得が空になるだけ）。ただし両方そろって初めて機能します。

1. **`phaseE3_management_reports.sql` を Supabase SQL Editor で実行**（テーブル＋RLS作成）。
   - 前提：`phaseE1a_roles.sql` 実行済み（`app_role()` が存在）。
2. **`feature/phase-e3-docking` を main にマージ＆push**。
3. GitHub Pages 反映後（1〜2分）、**admin でログイン → 「経営レポート」タブ**。
4. **「+ レポートを追加・差替」** から、種類（月次経営分析／R/F）・対象月・HTMLファイルを選んでアップロード。
   - 月次経営分析：`Box\…\05_財務・IR\予算・実績管理\月次経営分析レポート_YYYYMM.html`
   - R/F：`ローリングフォーキャスト分析資料_YYYYMM.html`
5. 確認：
   - admin / executive でログイン → タブが見え、レポートが表示される。
   - manager / editor / viewer でログイン → **タブが出ない**。
   - （任意）ブラウザのコンソールで anon 直アクセスを試し、`management_reports` が読めない（RLS拒否）ことを確認。

## ロールバック

- main を戻す ＋ `drop table public.management_reports;`（**機密データも消える**点に注意。残す場合はテーブルを残しタブだけ落とす）。

## 今後の月次運用

- 別セッションで当月の月次経営分析／R/F の HTML を生成 → 「経営レポート」タブの「追加・差替」で当月をアップロード。
- 同じ種類・同じ月は自動で上書き（履歴は月ごとに保持）。古い月は「表示中を削除」で削除可能。
