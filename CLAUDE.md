# CLAUDE.md — 統合管理ツール（besterra-allocation）

ベステラ社内の経営管理プラットフォーム。監督リスト・現場人員配置（ガント）・監督ダッシュボード・
見込み案件・経営レポート・安全学習・組織図・アカウント管理を1枚のHTMLで提供する。
本番 = GitHub Pages（mainへのpush＝即デプロイ）。バックエンド = Supabase（Auth＋RLS）。
**作業拠点 = Box**（2026-07-06 PC移行で移設）: `C:\Users\sakamoto\Box\m.sakamoto\Besterra\01_組織\ツール【統合管理】\besterra-allocation`
検証スクリプトは `C:\Users\sakamoto\Box\m.sakamoto\Besterra\01_組織\ツール【統合管理】\検証スクリプト\`・刷新前バックアップは `保全\` 配下。

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
| `js/views/gantt/report.js` | 週次レポート出力（工事部員配置状況）: 稼働サマリー集計・HTML/PDF生成・スナップショット/アーカイブ記録 |
| `js/views/*.js` | 各タブのView（pool/dashboard/prospects/member_add/orgchart/accounts/audit/management/elearning/board） |
| `js/pet-embed.js` | AIペット「ピーちゃん」。**自己完結IIFE・原則触らない**（下記契約参照） |
| `js/mock_data.js` | `processRawTables`のフォールバック用（Supabase空応答時の保険）。**削除しない** |
| `js/config.js` | 接続設定（SHEET_ID / SUPABASE_URL / ANON_KEY / USE_SUPABASE / ADMIN_FN） |
| `css/styles.css` | 補助CSS（基本はTailwind CDN） |
| `supabase/*.sql` | DB変更の履歴（実行はSupabase SQL Editorで手動） |

**script読込順（index.html末尾・変更注意）**:
supabase CDN → mock_data → **util** → **sync → sync/sheets → sync/derive → sync/db → sync/auth**
→ views(pool → **gantt → gantt/modals → gantt/axes → gantt/report** → dashboard → prospects → member_add → orgchart
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
python "C:\Users\sakamoto\Box\m.sakamoto\Besterra\01_組織\ツール【統合管理】\検証スクリプト\verify_all.py"     # 10本直列・基準線 = 124 PASS / 0 FAIL
```
- 基準線: `C:\Users\sakamoto\Box\m.sakamoto\Besterra\01_組織\ツール【統合管理】\検証スクリプト\verify_baseline.txt`（2026-07-06確立）
- 除外: verify_prospects.py（CSV検査）・verify_dashboard_sandbox.py（別プロジェクト）。verify_bi_tab.py（20/20）はBI統合main反映（2026-07-08）に伴い個別実行に変更（verify_all.py本体への組込みは未実施）
- デプロイ時は index.html の変更したscriptタグの `?v=` をタイムスタンプ更新（キャッシュバスティング・忘れると旧コードを掴む）
- 本番push（main）は非軽微変更ならユーザーのゴーサインが必要

## ロール×タブ（TAB_ROLES: js/app.js）

admin=全部＋同期/アカウント/監査 / editor=pool・gantt(編集可)・dash / executive=management・pool・gantt・dash・prospects /
manager=pool・gantt・dash / viewer=gantt・dash(自分のみ) / accounting=management・pool・gantt・dash・prospects・orgchart(閲覧のみ)。
連絡先(contacts)=全ロール。安全学習(elearning)は当面admin限定。組織図はヘッダーの`#org-toggle`ボタンから。

## 社内連絡先タブ（2026-07-15新設）

総務発行の「電話番号表」PDFを閲覧専用ページ化（js/views/contacts.js・Supabase `contacts` テーブル）。
- 🔴**実データ（氏名・電話番号）はPublicリポジトリにコミット禁止**。リポジトリには DDL のみ
  （supabase/add_contacts.sql・書込ポリシーなし=閲覧専用）。seed は
  `Box\...\ツール【統合管理】\自動化\連絡先取込\seed_contacts_YYYYMMDD.sql`（全置換方式・check_seed.py でPDF照合）。
- PDF改版時の更新手順: 新PDFから seed を作り直し→check_seed.py で照合→SQL Editor で再実行。
- 並び順は原本を尊重（内線=番号順・携帯=五十音順）＝ sort_order。携帯・外線は tel: リンク。

## 触らない・注意するもの

- `js/pet-embed.js`: 自己完結。Sync契約さえ保てば無影響
- `js/mock_data.js`＋`processRawTables`内のMOCK_DATAフォールバック: Supabase空応答時の保険
- Sheets読込経路（sync/sheets.js）: 「同期」ボタンで**現役**（読取はSupabaseでもSheets取込は生きている）
- 旧GAS書込経路は2026-07刷新で削除済み。GAS側WebAppの後始末（デプロイのアーカイブ）は別途
- 未追跡ファイル（build_quals_map.py等）はコミットに巻き込まない（`git add -A`禁止）

## 経営分析BI統合（2026-07-08 main反映済み）

feature/bi-tab（旧a944f70分岐）をmainへfast-forwardマージ。経営レポートタブに「経営分析BI」種別として統合
（専用タブ・専用Viewは無し＝index.html/app.js/management.jsのみ）。選択すると埋め込まず別タブ全画面
（?bi=<id>・App.enterBi・sandbox=allow-scripts・iframe src=blob:）。要SQL=supabase/add_bi_report_type.sql
（実行済み確認済み）。
- 修正: bi-screen-close（閉じるボタン）は左上固定。右上だとダッシュボード自身のテーマ切替ボタンと重なり、
  テーマ変更のつもりでクリックするとbi-screen自体が閉じる不具合があった。
- 中身のPowerBI移行ダッシュボード（経営分析ダッシュボード.html）はcombine_dashboard.py側の管理。
  同スクリプトはBox移行前の旧ローカルパスがBASE変数にハードコードされたままだと動かない
  （2026-07-07に修正・再ビルド済み）。テーマ/アクセントが個別レポートに反映されない不具合が起きたら、
  まずこのビルドが最新か（画面右上のbuild時刻表示）を疑う。

## 週次レポート出力（2026-07-13 main反映）

現場人員配置タブの「📄 週次レポート」ボタン→モーダルから、全体会議用「工事部員配置状況（YYYY.M.D）」を
HTML（自己完結）/PDF（html2canvas＋jsPDF・1枚長尺）でワンクリック生成する（js/views/gantt/report.js）。
- 稼働定義（2026-07-10確定・07-13準備期間追加・変更時はSQLコメントも同期）: その月に1日でも配置バーが
  重なる監督（バー開始=prep_start/joinの早い方＝**準備期間も稼働**・完成除外・見込み含む）
  **または** 専従・派遣（work_mode。期間設定があればその期間の月のみ）。
  分母（監督者数）=「〜事務所」所属の現場監督＋準現場監督。
- サマリー時点 = 当月・+3/+6/+9ヶ月ローリング（+3以降は「稼働予定」表記）。
- 「アーカイブに保存」ON（admin/editor）で allocation_snapshots（数値）＋ allocation_reports
  （HTML＋PDF base64・taken_on一意）にupsert記録。モーダル内「過去のレポート」一覧から再取得可。
- `GanttView.reportDateOverride`（'YYYY-MM-DD'）= 自動実行専用の基準日上書き。手動時は未設定＝当日。
  自動実行スクリプトはリポジトリ外 `..\自動化\週次レポート\weekly_report_autorun.py`（credentials分離のためgit外）。
- ⚠️PDFのラベル/バーの微妙な縦ズレは html2canvas 自体のテキスト計測誤差（ライブDOMは正常）。
  ブラウザ印刷への切替は環境依存を理由に不採用（2026-07-09ユーザー判断）＝多少のズレは許容仕様。
- 検証 = verify_weekly_report.py（個別実行・48 PASS）。

## 将来の改修候補（刷新で見送ったもの）

- dashboard.populateSelect / member_add.populateEmployeeList の統合（ほぼ同一だが差分精査が必要）
- 取引先マスタ（MDMハブ）統合
- 退職者の在籍ステータス管理（organization名簿から外れた過去配置の扱い）
