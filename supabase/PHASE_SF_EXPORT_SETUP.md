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

## 0. Salesforce 側（dev6）：クライアントログイン情報フローの実行ユーザーを有効にする

本番 org に 7/14 に作った外部クライアントアプリ「Besterra Allocation Import」は dev6 にも写っている
（鍵と秘密は同じ・トークン発行は通る）が、**ポリシーの「実行ユーザー」が dev6 では未設定**のため
`no client credentials user enabled` で止まる。dev6 のシステム管理者で次を行う。

1. dev6 にログイン → 設定 → クイック検索「外部クライアントアプリケーションマネージャ」
2. 「Besterra Allocation Import」を開く → **ポリシー** タブ → 編集
3. 「クライアントログイン情報フローの有効化」を ON、**実行ユーザー**に `m.sakamoto@besterra.co.jp.dev6` を入力 → 保存
4. 動作確認（トークンが取れるか・書込なし）：
   ```
   python "C:\Users\sakamoto\Box\m.sakamoto\Besterra\01_組織\ツール【統合管理】\自動化\SF連携検証\sf_export_token_check.py"
   ```

> dev6 では既存アプリの流用で足りる（鍵の再発行が不要）。**本番へ配信するときは、書込専用の
> 外部クライアントアプリ＋連携専用ユーザーを別に作る**（手順書_外部クライアントアプリケーション作成.md の手順・
> 範囲は api のみ）。読取専用の sf-import と鍵を分け、`SF_EXPORT_ALLOWED_ORG_IDS` に本番を足すのはその時。

## 1. Secrets の設定（Supabase・初回のみ）

Supabase ダッシュボード → **Edge Functions** → **Secrets** に以下を追加。

| Secret名 | 値 |
|---|---|
| `SF_EXPORT_INSTANCE_URL` | `https://besterra--dev6.sandbox.my.salesforce.com` |
| `SF_EXPORT_CLIENT_ID` | `sf_credentials.json` の client_id（本番アプリと同じ） |
| `SF_EXPORT_CLIENT_SECRET` | `sf_credentials.json` の client_secret |
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

## 5. 本番へ向けるときのチェックリスト（未実施）

- [ ] 書込専用 ECA＋連携専用ユーザーを本番に作成（システム管理者）→ Secrets を差し替え
- [ ] `SF_EXPORT_ALLOWED_ORG_IDS` に本番 org を追加
- [ ] Account の新設項目・レイアウト・Dynamic Forms・権限セットを本番へデプロイ（dev6 と同じ定義）
- [ ] DRY 要決定 A〜H の回答を `buildRecord` の上書き規則に反映（社名保留31・住所上書き・電話FAXは空のみ・許可は空のみ 等）
- [ ] 本番で `link` → `dry_run` → 塩田さん確認 → `export`
- [ ] `--writeback` を有効化し、以後は日次スケジュール（pg_cron・sf-import と同型）
