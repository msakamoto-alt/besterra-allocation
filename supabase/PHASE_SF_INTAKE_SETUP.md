# 仮登録の受け口セットアップ手順（sf-intake Edge Function）＋ sf-export の再デプロイ

与信設計書 第4版（2026-10-20・`salesforce-anken-kouji-kanri\docs\specs\40_機能仕様\与信設計書\取引先番号と与信の稟議_設計書_第4版_2026-10-20.html`）p.2 ②・p.4 の
「Salesforce で相手を選んだ瞬間に、ハブへ親コードと法人番号の候補を自動で送り、会社マスタに『申請中』の行（箱）を作る」道。

- **sf-intake**（新設・SF→ハブ）: SF の Apex `HubIntake` が取引先を作った直後に呼ぶ。箱（`registration_stage='temp'`）を作り、会社マスタIDを返す。
  `system_code` に `salesforce`（Account Id）と `torihikisaki_code`（取引先番号の親コード・5桁）を結ぶ。
- **sf-export**（既存・ハブ→SF）: 2026-10-20.1 で送る項目を足した＝法人番号は `HubCorporateNumber__c`（ハブ確定）へ、
  `RegistrationStage__c`（temp→仮登録／full→本登録）、`CreditExempt__c`、`CreditLimitType__c`／`CreditExpiry__c`／`CreditDecisionDate__c`／`CreditUsedAmount__c`（credit_line）。
  🔴 配信先の SF（いまは dev6）に新しい項目が配備済みであること（2026-10-20 配備）。配備前の org に向けると SOQL が落ちる。
  🔴 `CorporateNumber__c` には書かなくなる。dev6 の旧項目（テキスト）は、本番の数式（Sansan 優先）に置き換えるまで残す。

---

## 1. Secrets（初回のみ・sf-export と共通なら追加不要）

| Secret名 | 用途 |
|---|---|
| `IMPORT_SECRET` | SF の Apex が `x-import-secret` ヘッダで名乗る合言葉（sf-import／sf-export と共通） |
| `SF_EXPORT_INSTANCE_URL` / `SF_EXPORT_CLIENT_ID` / `SF_EXPORT_CLIENT_SECRET` | 会社マスタIDを SF へ書き戻す（任意・無ければ書き戻しだけ飛ばす） |
| `SF_EXPORT_ALLOWED_ORG_IDS` | sf-export と同じ（sf-intake は参照しない） |

## 2. デプロイ（ダッシュボードから・CLIなし）

1. **Edge Functions** → **「Deploy a new function」→「Via Editor」**
2. 関数名 **`sf-intake`**（この名前でないと呼べない）
3. エディタの中身を全部消し、`supabase/functions/sf-intake/index.ts` を貼り付け → **Deploy**
4. **「Verify JWT」ON**（既定）のまま
5. 続けて **sf-export** を開き、`supabase/functions/sf-export/index.ts`（**2026-10-20.2**＝親コードの読み返しつき・§6）を貼り直して **Deploy**。新しい Secret はまだ足さない（`SF_CODE_ISSUER_ORG_IDS` は切り替えのときに入れる）

> ⚠️ 貼る前に、ローカル（`C:\Users\sakamoto\besterra-allocation`）が最新か `git log -1` で確かめる。Box のコピーは2時間ごとのミラーで古いことがある。

## 3. Salesforce 側の設定（dev6・カスタム設定「ハブ送信の設定」）

`HubIntakeSetting__c` の組織の既定値（設定 → カスタム設定 → ハブ送信の設定 → 管理 → 新規）:

| 項目 | 値 |
|---|---|
| 受け口の URL | `https://<project>.supabase.co/functions/v1/sf-intake` |
| anon キー | その Supabase の anon キー（公開前提の鍵） |
| 合言葉 | `IMPORT_SECRET` と同じ |
| 送信する | ON |

リモートサイト設定は配備済み（`HubLearning`＝学習用 `iinbncpofqaldpygfryz`）。本番ハブ（`pajmsowweswaxowrbiwr`）へ向けるときは同じ形でリモートサイトを足す。

### どのハブへ向けるか（**2026-10-20 坂本さん決定＝本番ハブ**）

- dev6 はリモートサイト `HubProduction`（pajmsow…）を配備済み。dev6 のハブ送信の設定は受け口の URL と anon キーまで入れてある（Claude・10/20）。**合言葉と「送信する」は坂本さんが画面で**。
- 試験のあとは「送信する」を切る（dev6 は 3 人の共用＝ふだんから送ると経理の画面に試しの箱が出る）。

（決定前の検討）

- いま dev6 へ配信している sf-export は **本番ハブ**（pajmsow…）で動いている（本番 SF にはまだ項目が無いため）。
- 箱→経理の限度額入力→配信で与信済み、を dev6 で通して試すなら、箱も本番ハブに作る必要がある（学習用 DB は dev6 へ配信しない）。
  本番ハブに試験の箱ができる＝経理の画面に「申請中」として見える。社名に【テスト】を付け、試験後に消す。
- 関数の動作だけ確かめるなら学習用 DB で足りる（`HubLearning` 向け）。

## 4. 動作確認

```powershell
# 1) 受け口に直接（secret 経由）
$h = @{ 'Authorization' = "Bearer <anon>"; 'x-import-secret' = '<IMPORT_SECRET>'; 'Content-Type' = 'application/json' }
$b = '{"source":"test","records":[{"account_id":"001TESTTESTTEST00","account_code":"10999","name":"【テスト】受け口の会社","corporate_number":""}]}'
Invoke-RestMethod -Method Post -Uri https://<project>.supabase.co/functions/v1/sf-intake -Headers $h -Body $b
#    → ok:true・results[0].status が created・company_id が 8 桁
# 2) ハブ: 会社マスタに「申請中」の行があり、システムコードに salesforce / torihikisaki_code が付いている。連携ログ（取引先マスタ）に action=intake
# 3) SF（dev6）: 取引先を 1 件作る（案件管理で名簿に無い社名を入れる）→ 数秒後に HubCompanyId__c が入り HubIntakeError__c が空
# 4) 片付け: 試験の会社は is_suspended=true か削除（system_code・company_history も）
```

## 5. 仕組みの境界（設計書との対応）

| 設計書 | ここ |
|---|---|
| p.2 ② 箱＝親コード・社名・法人番号の候補だけ | sf-intake が company（temp）＋system_code を作る。住所・電話も来れば入れる |
| p.2 ⑤ 経理が箱に限度額・種類・期限を入れ、ハブが SF へ送る | 経理はハブの画面で credit_line を入れる → 即時配信トリガ → sf-export が `CreditLimit__c` などを送る（箱の段階でも送る＝is_suspended でなければ対象） |
| p.2 ⑥ 本登録（登録を承認）→ PROCES.S | 既存の「登録を承認」。sf-export は `RegistrationStage__c=本登録` を送る。PROCES.S 連携（IF-01）は別途（本登録のものだけ） |
| p.4 届かなかった分は SF の画面で送り直す | SF の `HubIntake.resend`（取引先の `HubIntakeError__c` に理由） |
| p.5 枝番（口座×支払方法）・奉行 4 桁 | ハブ側の次の作業（bank_account に枝番・system_code obc の採番）＝塩田さんの回答待ち |

## 6. 親コードの読み返し（sf-export 2026-10-20.2・坂本さん「B にしましょう」2026-10-20）

外注先のように**先にハブで登録される会社**は、配信で Salesforce に届いた時点で Salesforce が取引先番号の親コード（`Account.AccountCode__c`・5桁）を振る。
ハブがその番号を知らないと PROCES.S のコード（例 `10002-F001`）を組めないので、sf-export が配信のあとに親コードを読み返し、
`system_code(system='torihikisaki_code')` に控える。切り替えの一斉付与（既存の会社に Salesforce がまとめて振る）も、そのあとの全件配信で同じ道を通って戻る。

- **書くのは接続先 org が Secret `SF_CODE_ISSUER_ORG_IDS`（親コードを振る正の org・15桁・カンマ区切り）にあるときだけ**。
  いまの配信先は dev6（試しの org）なので**空のまま**にする＝dev6 が試しに振った番号を本番のハブに書かない。切り替えのときに本番 SF の org ID を入れる。
- 一度付いた番号は変えない。ハブに別の番号が付いていたら上書きせず「食い違い」、同じ番号が別の会社に付いていたら「衝突」として応答と連携ログに出す。
- 書いた会社には `company_history` に 1 行（「Salesforce が振った番号を配信のあとに読み返した」）。
- 応答の `parent_code`（mode・read・written・would_write・unchanged・mismatch・conflict・invalid・samples）と、連携ログの counts `parent_code_*`・meta `code_readback` で見える。
- 読み返しが失敗しても配信の結果は返す（failed に「(親コードの読み返し)」として残る）。

### 試しの org で書かずに確かめる（任意）

```powershell
$h = @{ 'Authorization' = "Bearer <anon>"; 'x-import-secret' = '<IMPORT_SECRET>'; 'Content-Type' = 'application/json' }
$b = '{"action":"export","company_ids":["<会社マスタID>"],"code_readback":"preview","source":"script","reason":"親コードの読み返しの試し"}'
Invoke-RestMethod -Method Post -Uri https://pajmsowweswaxowrbiwr.supabase.co/functions/v1/sf-export -Headers $h -Body $b
#  → parent_code.mode が preview・would_write／unchanged などの件数と見本。ハブには書かない（配信そのものは普段どおり dev6 に届く）
```

### 切り替えのとき（本番 SF へ向けるとき）

1. 本番 SF で既存の取引先に親コードを一斉付与する（SF repo `scripts/credit/assign_account_codes_*.apex`）。
2. sf-export の連携ユーザー（クライアント認証の実行ユーザー）に、親コードの項目を読む権限（権限セット `Credit_Access`）を付ける。Metadata API で配備した項目は管理者にも自動では見えない。
3. Secret `SF_CODE_ISSUER_ORG_IDS` に本番 SF の org ID（15桁）を入れる。
4. 全件配信（`action=export`・`mode=full`）を 1 回流し、`parent_code.written` と `mismatch`／`conflict` が 0 かを見る。以後は即時配信のたびに新しい会社の番号が戻る。
