# 取引先マスタ配信セットアップ手順（sf-export Edge Function・ハブ→Salesforce）

統合管理ツール（ハブ）の会社マスタを正本として、Salesforce の取引先（Account）へ **API で配信する**
サーバー関数「**sf-export**」を Supabase に置く。sf-import（SF→ハブ・読取専用）の逆方向版で、
認証・監査ログ・呼び出し方は同型。

- 方向は **ハブ→SF の一方向**。キーは会社マスタID（`Account.HubCompanyId__c`・外部ID）。
- ハブが空の項目は送らない（SF の既存値を消さない）。承認・反社ゲートは第1弾では掛けない。
- 接続先 org は Secrets で決まり、**`SF_EXPORT_ALLOWED_ORG_IDS` に無い org へは書込を拒否**する
  （本番 org を誤って向けても書かない安全弁）。まずは dev6 だけを許可する。
- `dry_run`（既定）は書き込まず、配信対象の件数と分類（更新／新規／コード衝突）を報告する。

---

## 0. Salesforce 側（dev6）：書込用の外部クライアントアプリを新規作成する

本番の「Besterra Allocation Import」は配布状態がローカルのため dev6 には写っていない（2026-09-09 確認）。
dev6 に **書込用のアプリを新しく作る**。読取専用の sf-import と鍵を分けるためにも、この形が正しい。
dev6 のシステム管理者（自分）で行う。所要 10 分。

1. dev6 にログイン → 設定 → クイック検索「**外部クライアントアプリケーションマネージャ**」→「新規外部クライアントアプリケーション」
2. 基本情報：名前 `Besterra Hub Export`／API 参照名は自動／取引先責任者メール `m.sakamoto@besterra.co.jp`／配布状態 **ローカル**
3. OAuth 設定：「OAuth 設定の有効化」ON／コールバック URL `https://login.salesforce.com/services/oauth2/callback`／
   範囲は **「API を使用してユーザーデータを管理する (api)」だけ**／
   「フローの有効化」で **「クライアントログイン情報フローの有効化」ON** → 作成
4. **ポリシー** タブ → 編集 → 「クライアントログイン情報フローの有効化」ON、**実行ユーザー** `m.sakamoto@besterra.co.jp.dev6` → 保存
5. **設定** タブ → OAuth 設定 → 「**コンシューマ鍵と秘密**」→ 本人確認コード（メール）を入力 → 表示された鍵と秘密を
   `自動化\SF連携検証\sf_export_credentials.json`（`sf_export_credentials.example.json` を複製）にメモ帳で貼る
   ※ 確認コードのメールが届かないときは dev6 の 設定 → 「メール到達性」→ アクセスレベルを「システムメールのみ」にする
6. 動作確認（トークンが取れるか・書込なし）：
   ```
   python "C:\Users\sakamoto\Box\m.sakamoto\Besterra\01_組織\ツール【統合管理】\自動化\SF連携検証\sf_export_token_check.py"
   ```
   「OK トークン取得成功: 実行ユーザー=m.sakamoto@besterra.co.jp.dev6 org=00Dfd000002CDWc」と出れば完了

> 本番へ配信するときは、同じ手順で本番に書込用アプリ＋**連携専用ユーザー**（システム管理者ではなく、取引先の編集権限だけを持つユーザー）を作り、
> Secrets を差し替えて `SF_EXPORT_ALLOWED_ORG_IDS` に本番を足す。

## 1. Secrets の設定（Supabase・初回のみ）

Supabase ダッシュボード → **Edge Functions** → **Secrets** に以下を追加。

| Secret名 | 値 |
|---|---|
| `SF_EXPORT_INSTANCE_URL` | `https://besterra--dev6.sandbox.my.salesforce.com` |
| `SF_EXPORT_CLIENT_ID` | `sf_export_credentials.json` の client_id（dev6 に新規作成した Besterra Hub Export の鍵） |
| `SF_EXPORT_CLIENT_SECRET` | `sf_export_credentials.json` の client_secret |
| `SF_EXPORT_ALLOWED_ORG_IDS` | `00Dfd000002CDWc`（dev6 の org ID 15桁。本番 `00DGC000005pvEM` は**入れない**） |
| `IMPORT_SECRET` | 既存（sf-import と共通・変更不要） |

> `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は自動注入。Secret の値はリポジトリに書かない。

## 2. デプロイ（ダッシュボードから・CLIなし）

1. **Edge Functions** → **Deploy a new function** → **Via Editor**
2. 関数名 **`sf-export`**
3. エディタの中身を全部消し、`supabase/functions/sf-export/index.ts` を貼り付け → **Deploy**
4. 関数の設定で **Verify JWT が ON** を確認

## 3. 動作確認（dev6・順番どおりに）

```
cd "C:\Users\sakamoto\Box\m.sakamoto\Besterra\01_組織\ツール【統合管理】\自動化\SF連携検証"
python sf_export_call.py                 # ① dry_run：hub_companies / sf_accounts / will_update / will_create / code_conflict / linkable_by_name
python sf_export_call.py link            # ② SF側の会社マスタID無し取引先を社名で突合してキー付与（一意一致だけ・曖昧は触らない）
python sf_export_call.py                 # ③ もう一度 dry_run：will_update が増え code_conflict が減っていること
python sf_export_call.py export --limit 5   # ④ 試し流し5社 → dev6 の取引先で種別バー・Dynamic Forms を目視
python sf_export_call.py export          # ⑤ 全件（有効 約2,300社・200件/コール・数十秒）
python sf_export_call.py                 # ⑥ 再 dry_run：will_create=0（冪等性）
```

- 監査ログ（アプリの「監査ログ」→ 対象「取引先マスタ」）に `SF_LINK` / `SF_EXPORT` が1実行1行で残る。失敗は `ERROR`。
- `--writeback` は本番配信用（Account Id をハブ `system_code(system='salesforce')` へ保存）。**dev6 の Id を本番ハブに入れないこと**。

## 4. 戻し方（dev6）

- 新規作成分：`HubCompanyId__c != null` かつ `CreatedDate` が配信日の Account を一括削除
- link で付けた分：`HubCompanyId__c` と `Business_Partners_Code__c` を空に戻す（対象は監査ログの linked 件数と一致）
- 事前に dev6 の Account を CSV で退避しておく（`sf data export bulk` または 取引先リストビューのエクスポート）

## 6. 即時配信（保存のたびにトリガから直接呼ぶ・2026-09-09 坂本さん決定）

決定の理由＝工事部から「早く登録してほしい」と言われたとき定期実行は待てない／経理が毎回手動で流すのは頻度が多い／
運用開始済みで CSV の大量取込はもう無い。

経理がハブで会社を保存すると、会社マスタ系テーブルのトリガが pg_net で `sf-export`（mode=direct・その会社だけ）を
非同期に呼ぶ。pg_net は送信を積むだけなので保存は Salesforce を待たない。関数側は **3秒待ってからハブを読み直す**
（1回の保存で会社本体・種別・許可が別々のトランザクションで書かれるため、途中の状態を送らない）。
＝保存から数秒で Salesforce に反映。失敗の取りこぼしは夜間の全件配信（§4）が拾う＝**§4 の cron も登録すること**。

1. **SQL**（初回のみ・再実行可）: `自動化\SF連携検証\sf_export_trigger_filled.sql` を SQL Editor に貼って Run
   （トリガ関数＋トリガ5本。雛形は `supabase/sf_export_trigger.sql`）
2. **関数の再デプロイ**: Edge Functions → sf-export → エディタの中身を `supabase/functions/sf-export/index.ts` で置き換えて Deploy
   （direct モード・対象だけ読む軽量化）
3. **動作確認**: ハブで会社を1件保存 → 数秒後に Salesforce の取引先が更新される。
   監査ログ（対象「取引先マスタ（SF配信）」）に「自動（保存時・即時）」の SF_EXPORT が保存のたびに1行残る
4. **監視**: `select id, status_code, left(content::text, 300) from net._http_response order by id desc limit 5;`
   （status_code が 200 以外なら関数側の失敗。監査ログの ERROR と合わせて見る）

- 1回の保存で行が複数変わると同じ会社への呼び出しが数回重なるが、3秒待って同じ確定状態を送るので結果は同じ（冪等）
- 止めるとき: トリガ5本を drop（雛形の末尾に列挙）。関数と Secrets はそのまま

## 5. 本番へ向けるときのチェックリスト（未実施）

- [ ] 書込専用 ECA＋連携専用ユーザーを本番に作成（システム管理者）→ Secrets を差し替え
- [ ] `SF_EXPORT_ALLOWED_ORG_IDS` に本番 org を追加
- [ ] Account の新設項目・レイアウト・Dynamic Forms・権限セットを本番へデプロイ（dev6 と同じ定義）
- [ ] DRY 要決定 A〜H の回答を `buildRecord` の上書き規則に反映（社名保留31・住所上書き・電話FAXは空のみ・許可は空のみ 等）
- [ ] 本番で `link` → `dry_run` → 塩田さん確認 → `export`
- [ ] `--writeback` を有効化し、以後は日次スケジュール（pg_cron・sf-import と同型）
