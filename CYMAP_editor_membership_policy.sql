-- CYMAP: allow signed-in users to check only their own editor membership.
-- Run once in Supabase SQL Editor after the initial schema setup.

grant select on public.map_editors to authenticated;

create policy "Users can read their own editor membership"
  on public.map_editors
  for select
  to authenticated
  using (user_id = (select auth.uid()));
