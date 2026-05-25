-- 段階C: 参照系3テーブルを編集者(authenticated)が「同期」で全置換できるよう書込許可
--
-- 編集の正は Google Sheets（employees=手入力 / g_work_logs=勤怠貼付 / salesforce_imports=SFレポート貼付）。
-- アプリの「同期」ボタン（編集ログイン時のみ）が Sheets→Supabase を全置換で反映する。
-- 全削除→投入のため insert と delete のみ許可（update は不要）。
-- 閲覧者(anon)には引き続き書込不可（読取のみ）。

create policy write_employees_ins on public.employees          for insert to authenticated with check (true);
create policy write_employees_del on public.employees          for delete to authenticated using (true);

create policy write_glogs_ins on public.g_work_logs            for insert to authenticated with check (true);
create policy write_glogs_del on public.g_work_logs            for delete to authenticated using (true);

create policy write_sf_ins on public.salesforce_imports        for insert to authenticated with check (true);
create policy write_sf_del on public.salesforce_imports        for delete to authenticated using (true);
