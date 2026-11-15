# 反社チェック（RoboRobo）の API 連携 — 手順書（2026-11-15）

調べるのは RoboRobo、決めるのは経理、残すのはツール。新しい相手は申請で、今の相手は 1 年ごとに。
検討書＝`Box\…\ツール【統合管理】\自動化\API連携\反社チェック_RoboRobo連携_検討_2026-11-15.html`

## 部品

| 部品 | 置き場 | 役割 |
|---|---|---|
| DB | `supabase/antisocial_check.sql`（試験 `supabase/tests/antisocial_check.test.mjs`） | 記録の表に列・RoboRobo に頼んだ 1 件の表・設定・頼む決まり・結果と取引判断の取り込み・回の結果・今の状態（計算） |
| 関数 | `supabase/functions/antisocial-check/index.ts` | RoboRobo との通信（頼む・結果の送付を受ける・結果を取りに行く・取引判断を取り込む・つながるか） |
| 定時実行 | `supabase/antisocial_cron.sql`（実物は git の外 `自動化\API連携\RoboRobo_道具\antisocial_cron_filled.sql`） | 10 分おきに tick |
| 画面 | `js/views/torihikisaki.js` | 会社の画面の「反社チェック（RoboRobo）」・左の「🛡 反社チェック」（一覧・設定・つながりの確かめ）・与信の知らせの窓に 1 行 |

## 初回の設定（坂本さん・Supabase のダッシュボード）

貼るものは道具でクリップボードに入れます（値は画面に出ません）。番号を変えて 5 回使います。

```
! powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\sakamoto\Box\m.sakamoto\Besterra\01_組織\ツール【統合管理】\自動化\API連携\RoboRobo_道具\antisocial_clip.ps1" 1
```

1. **SQL Editor**（番号 1）→ Run。出る 1 行＝`setting_rows 1`・`new_columns 8`・`item_table 1`・`companies`＝会社の数・`roborobo_rounds 0`
2. **Edge Functions → Secrets** に 2 つ足す
   - `ROBOROBO_API_TOKEN_TEST`（番号 3＝テスト環境のトークン）
   - `ANTISOCIAL_CALLBACK_SECRET`（番号 4＝結果の送付の合言葉）
3. **Edge Functions → Deploy a new function → Via Editor**。名前 `antisocial-check`（番号 2 を貼る）→ Deploy。JWT の確かめは既定（ON）のまま
4. **SQL Editor**（番号 5）→ Run（10 分おきの定時実行）
5. 終わったら教えてください（私がつながりの確かめと、試しの 1 件を流します）

最初は「試し」で動きます（設定 `use_prod_token=false`）。テスト環境のトークンで流した回は本物の状態に数えません。自動で頼む決まり（①②③）は止めてあり（`enabled=false`）、画面の［反社チェックを流す］だけが動きます。

## 本番の契約のあと

1. Secrets に `ROBOROBO_API_TOKEN`（本番のトークン）を足す
2. ツールの「🛡 反社チェック」→ 設定で「本番のトークンを使う」をオン（管理者だけ変えられる）
3. 「決まりに沿って自動で頼む」をオンにし、①（SF の申請）②（ツールの登録）③（1 年ごとの見直し・月の上限）を選ぶ

## 止めるとき

- 自動で頼むのを止める＝設定「決まりに沿って自動で頼む」をオフ（手動の［反社チェックを流す］は使える）
- 全部止める＝SQL Editor で `select cron.unschedule('antisocial-check-tick');`

## 決まり（要点・正は SQL）

- 状態＝未実施／調査中／要確認／該当なし／問題なし／取引不可／期限切れ／エラー。毎回計算する（`v_compliance_status`）
- 自動で「該当なし」＝どの検索もヒット 0 件のときだけ（設定で「注目度 高 0 件・新聞 0 件」に変えられる）。それ以外は要確認＝経理が RoboRobo の画面で取引判断（承認→問題なし・否認→取引不可）を打ち、ツールが取り込む
- 有効期限＝調べた日から 1 年（該当なし・問題なしのときだけ）
- RoboRobo の回は人が直せない・消せない（DB のトリガ）。手入力の記録は今までどおり
- ①SF の申請中（同じ稟議は 1 回・有効な結果があれば頼まない）②ツールに会社を登録（7 日以内・SF の箱と移行は除く）③1 年ごとの見直し（本登録・取引の種別がある会社・上場と官公庁らしい会社を除く・顧客→外注の順・月と日の上限）。②③と本番の SF の申請は本番のトークンのときだけ
- 呼び出しの回数: 何も無い回は RoboRobo を呼ばない（判断の取り込みは判断待ちがあるときと毎時 1 回）

## まだ（次の段）

- SF（dev6 で作り dev7 で確かめる）: 取引先に状態の 3 項目と配信・与信の稟議の決裁の画面に表示と控え・経理審査の段の門（`ApprovalTargetCredit.stepBlockReason`）・申請の知らせに代表者
- ツールの本登録の門（「該当なし」「問題なし」の会社だけ本登録）
