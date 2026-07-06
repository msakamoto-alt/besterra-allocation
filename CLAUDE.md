# CLAUDE.md — 統合管理ツール（besterra-allocation）

ベステラ社内の経営管理プラットフォーム。監督リスト・現場人員配置（ガント）・監督ダッシュボード・
見込み案件・経営レポート・安全学習・組織図・アカウント管理を1枚のHTMLで提供する。
本番 = GitHub Pages（mainへのpush＝即デプロイ）。バックエンド = Supabase（Auth＋RLS）。

## アーキテクチャ宣言（変更禁止事項）

- **Vanilla JS・ビルドなし・`<script>`順次読込**。フレームワーク/バンドラ/ESモジュールは導入しない
  （git pushだけでデプロイできる単純さが運用の生命線）。
- **グローバルシングルトン方式**: `Sync`（データ層）＋ `App`（起動/タブ/ロール）＋ 各View
  （`GanttView` / `PoolView` / `DashboardView` / `ProspectsView` / `MemberAdd` / `OrgChartView` /
  `AccountsView` / `AuditView` / `ManagementView` / `ELearningView` / `Board`）＋ `Util`（共通ヘルパ）。
- **HTMLとJSは「id直結」**: DOM id・`data-tab`・`.tab-panel`/`.tab-btn` 規約がJSとの暗黙契約。
  **idの改名・削除は既存JSと検証スイートを壊す**。
- View規約: `init()`＝初回のDOMイベント配線 / `refresh()`＝再描画 / モーダルは `open()`/`close()`。

## ファイル構成（2026-07 刷新後）

| ファイル | 責務 |
|---|---|
| `index.html` | 全画面のmarkup（認証/PW変更/メイン/board/モーダル群）とscript読込 |
| `js/util.js` | 共通ヘルパ（esc/toIsoDate/toSlash/fmtMillions/orgByEmail/bindModalClose）。各Viewの同名メソッドはここへの委譲 |
| `js/sync.js` | **データ層コア**: 接続/定数・CSV/SFパース・氏名正規化(`normEmpKey`)・ロール判定・overrideマージ・`syncAll`/`fetchRawFromSupabase`/`getSupabase`・監査 |
| `js/sync/sheets.js` | Sheets取込（管理者「同期」ボタン）: gviz CSV取得・SmartHR名簿整形(`parseOrganizationRows`)・参照系テーブル全置換 |
| `js/sync/derive.js` | 派生・変換: 資格導出・projects/assignments派生・G工番集計・組織図社員生成(`buildEmployeesFromOrg`)・`processRawTables`（読込後の変換ハブ） |
| `js/sync/db.js` | Supabase書込: 配置/見込みCRUD(`writeToSupabase`)・階層/不在/稼働形態・経営レポート・Eラーニング・`canEdit` |
| `js/sync/auth.js` | 認証・ロール・アカウント管理（Supabase Auth／Edge Function `admin-users`） |
| `js/views/gantt.js` | ガント**コア**: 状態/定数・ツールバー・`refresh`+軸dispatch・日付⇔px変換・描画プリミティブ |
| `js/views/gantt/modals.js` | 配置編集モーダル・案件状態モーダル（書込を伴う編集操作） |
| `js/views/gantt/axes.js` | 軸レンダラ5種（現場/事務所/監督/事務所×監督/資格）・稼働形態/不在帯・事務所モニター |
| `js/views/*.js` | 各タブのView（pool/dashboard/prospects/member_add/orgchart/accounts/audit/management/elearning/board） |
| `js/pet-embed.js` | AIペット「ピーちゃん」。**自己完結IIFE・原則触らない**（下記契約参照） |
| `js/mock_data.js` | `processRawTables`のフォールバック用（Supabase空応答時の保険）。**削除しない** |
| `js/config.js` | 接続設定（SHEET_ID / SUPABASE_URL / ANON_KEY / USE_SUPABASE / ADMIN_FN） |
| `css/styles.css` | 補助CSS（基本はTailwind CDN） |
| `supabase/*.sql` | DB変更の履歴（実行はSupabase SQL Editorで手動） |

**script読込順（index.html末尾・変更注意）**:
supabase CDN → mock_data → **util** → **sync → sync/sheets → sync/derive → sync/db → sync/auth**
→ views(pool → **gantt → gantt/modals → gantt/axes** → dashboard → prospects → member_add → orgchart
→ accounts → audit → management → elearning → board) → **config** → app → pet-embed。
config.js が Sync に実値を代入してから App.init が走る。分割ファイルは `Object.assign(Sync|GanttView, {...})` 方式。

## 凍結インターフェース（検証スイートが依存・変更禁止）

- グローバル名: `Sync` `App` `GanttView` `ProspectsView` `Util` ほか全View名
- `js/sync.js` 単体ロードで動くべきメソッド（verify_normname/empno/audit が単体ロード）:
  `normEmpKey` / `mergeOverridesIntoAssignments` / `auditUnresolvedAssignments` とその依存
  （`NAME_VARIANT_MAP` / `buildOverrideKey` / `normalizeDate` / `parseCSV` / `parseRow` / `cache`）
  → **これらを sync/ 配下へ移動してはいけない**
- テスト依存メソッド名: `ProspectsView.sfCollision` / `fmtAmountStr` / `formatAmountField`、
  `GanttView.renderOfficeMonitor` / `pickColumnCount` / `monthKey` / `refresh` / `currentAxis` / `projectSearchQuery`
- pet-embed.js が参照するSync契約: `getSupabase` / `isExpiryTracked` / `qualExpiryStatus` / `userId` / `role` / `cache.*`
- DOM id（例: `#gantt-container` `#gantt-project-search` `#audit-*` `#bpet-alert` `#tab-*` `data-tab`）

## 検証（改修後は必ず実行）

```
python C:\Users\sakamoto\verify_all.py     # 10本直列・基準線 = 124 PASS / 0 FAIL
```
- 基準線: `C:\Users\sakamoto\verify_baseline.txt`（2026-07-06確立）
- 除外: verify_bi_tab.py（feature/bi-tab前提）・verify_prospects.py（CSV検査）・verify_dashboard_sandbox.py（別プロジェクト）
- デプロイ時は index.html の変更したscriptタグの `?v=` をタイムスタンプ更新（キャッシュバスティング・忘れると旧コードを掴む）
- 本番push（main）は非軽微変更ならユーザーのゴーサインが必要

## ロール×タブ（TAB_ROLES: js/app.js）

admin=全部＋同期/アカウント/監査 / editor=pool・gantt(編集可)・dash / executive=management・pool・gantt・dash・prospects /
manager=pool・gantt・dash / viewer=gantt・dash(自分のみ) / accounting=management・pool・gantt・dash・prospects・orgchart(閲覧のみ)。
安全学習(elearning)は当面admin限定。組織図はヘッダーの`#org-toggle`ボタンから。

## 触らない・注意するもの

- `js/pet-embed.js`: 自己完結。Sync契約さえ保てば無影響
- `js/mock_data.js`＋`processRawTables`内のMOCK_DATAフォールバック: Supabase空応答時の保険
- Sheets読込経路（sync/sheets.js）: 「同期」ボタンで**現役**（読取はSupabaseでもSheets取込は生きている）
- 旧GAS書込経路は2026-07刷新で削除済み。GAS側WebAppの後始末（デプロイのアーカイブ）は別途
- 未追跡ファイル（build_quals_map.py等）はコミットに巻き込まない（`git add -A`禁止）

## 保留中のブランチ

- `feature/bi-tab`(3da51ad): 経営分析BI統合。変更は index.html/app.js/management.js のみ＝本刷新と本質衝突なし。
  再開時は bi-tab 側で `git merge main`。予想コンフリクト: index.htmlのscriptタグ群vs BIタブmarkup／
  app.jsのUtil委譲行vs activateTab変更／management.jsのesc委譲行vs BI統合 → いずれも両取りで解消。

## 将来の改修候補（刷新で見送ったもの）

- dashboard.populateSelect / member_add.populateEmployeeList の統合（ほぼ同一だが差分精査が必要）
- 取引先マスタ（MDMハブ）統合・BIタブ本採用
- 退職者の在籍ステータス管理（organization名簿から外れた過去配置の扱い）
