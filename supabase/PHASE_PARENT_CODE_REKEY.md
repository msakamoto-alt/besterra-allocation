# 会社マスタの鍵を取引先番号（親コード）に付け替える ― 当日の手順（案 B・2026-10-21 坂本さん決定）

番号は一本（取引先番号＝親コード・5 桁）、振るのはハブ。会社マスタの鍵（`company.company_id`）をその番号にする。
帯＝00001〜09999 試験（dev6・dev7）／10000 自社（予約）／10001〜99999 本物。既存の会社は今の順で 10001〜。
決定の経緯＝SF repo `docs/specs/40_機能仕様/与信設計書/親コードの発番_SFかハブか_リスク洗い出し_2026-10-21.md`・記録 10-20 §6.6〜§6.8。

## 0. 前に済ませること（Claude）

- [x] SQL 4 本（`parent_code_01_migrate.sql`・`02_verify`・`03_delete_test`・`09_rollback`）
- [x] `sf-intake` 2026-10-21.1（番号はハブが振る・帯＝org で決める・is_test・書き戻しに AccountCode__c）
- [x] `sf-export` 2026-10-21.1（AccountCode__c を送る・試験の会社は本番 SF に送らない・action=rekey）
- [x] 統合管理ツール（取引先管理）＝採番を DB の `next_parent_code` に・5 桁・テストの印と絞り込み・文言
- [x] SF（dev6）＝取引先を作っても番号を振らない・受け口の番号を AccountCode__c に入れる・管理者だけが付け替えられる
- [x] 学習用ハブでリハーサル（10/21 坂本さん）: v1 は行の複製で法人番号の一意制約に当たった → v2（その場で書き換え・外部キーを遅延）で成功。2,563 社 → 10001〜12563・全表の件数一致・参照切れ 0・順序 12563・試験の帯の次 00001・札は obc_onpre／tera だけ

## 1. 当日（本番ハブを止めた時間帯・2〜3 時間）

| # | 誰 | すること | 確かめ |
|---|---|---|---|
| 1 | 坂本さん | 経理に「取引先マスタを __:__〜__:__ 止めます」と周知。ハブの画面を閉じてもらう | |
| 2 | Claude | dev6 の「ハブ送信の設定」の「送信する」を切る（`scripts/credit/intake_enable_dev6.apex` false） | enabled=false |
| 3 | 坂本さん | SQL Editor で `parent_code_01_migrate.sql` を全文実行（1 回） | 最後の NOTICE「付け替え完了: n 社（10001〜…）」 |
| 4 | 坂本さん | `parent_code_02_verify.sql` を実行 | ①今＝控え ②bad=0・real_band=n ③孤児 0 ④seq_last=max_real ⑤札に torihikisaki_code 無し |
| 5 | 坂本さん | Edge Functions: `sf-intake` と `sf-export` を貼り直す（ローカル `supabase/functions/*/index.ts`・2026-10-21.1） | 一覧の更新時刻 |
| 6 | 坂本さん | Secrets: `SF_PROD_ORG_IDS` は **まだ入れない**（本番 SF に配信を始めるときに入れる） | |
| 7 | Claude | dev6 の取引先番号（10/20 の試しの番号）を空にする（`scripts/credit/clear_account_codes_dev6.apex` ×2） | remaining=0 |
| 8 | Claude | `sf-export` を action=rekey で 1 回呼ぶ（dev6 の `HubCompanyId__c` を新しい鍵に・`AccountCode__c` にも入る） | legacy=n・matched≒2,443・failed=0 |
| 9 | Claude | `sf-export` を action=export・mode=full で 1 回（全件配信＝dev6 を新しい鍵でそろえる） | created=0・failed=0 |
| 10 | 坂本さん | 統合管理ツールを push（index.html・js/views/torihikisaki.js）→ 公開サイトを開いて取引先番号が 5 桁で出る・「テストのみ」の絞り込みがある | |
| 11 | Claude | dev6 の「送信する」を入れ、【テスト】の取引先を 1 件作る → 箱が **00001** で届く・dev6 に 00001 が戻る・経理の画面では「テストのみ」でだけ見える | |
| 12 | Claude | 試験の会社を消す（`parent_code_03_delete_test.sql`＝坂本さん）か、残して UAT に使う | |
| 13 | 坂本さん | 経理に「再開」と「番号が 5 桁の取引先番号に変わった」を周知 | |

戻すとき（3〜4 で止まったとき）: `parent_code_09_rollback.sql` を実行し、旧版の関数（2026-10-20.x）を貼り直す。

## 2. そのあと

- 設計書 改訂 2（番号を振るのはハブ・帯・10000 自社）と、経理への一言（形は約束どおり 5 桁・10001 から・10000 は自社の予約）。
- dev7 の UAT: 受け口は本番ハブのまま（試験の帯に入る）。配信先を dev7 にも＝`sf-export` の送り先を複数に（次の作業）。
- 本番 SF へ切り替えるとき: `SF_PROD_ORG_IDS` に本番の org ID（15 桁）→ 本番 SF からの箱は本物の帯・試験の会社は本番 SF に配信しない。

## 3. 読み方（番号の決まり）

| 帯 | 用途 | 振り方 |
|---|---|---|
| 00001〜09999 | 試験（dev6・dev7・知らない org） | `next_parent_code('test')`＝最大＋1。消したら使い回してよい。本番 SF・PROCES.S・奉行には出さない |
| 10000 | ベステラ自社 | 予約。自動では振らない |
| 10001〜99999 | 本物 | `next_parent_code('real')`＝順序。一度付いたら変えない・欠番は使い回さない |
