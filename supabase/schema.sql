-- Run this complete script in Supabase SQL Editor once per project.
-- Re-running preserves existing journals. Future structural changes need migrations.
-- Each authenticated account owns one journal, shared by its devices.
begin;

create table if not exists public.journals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991)
);
create table if not exists public.students (
  user_id uuid not null references public.journals(user_id) on delete cascade,
  id text not null check (id ~ '^[a-zA-Z0-9-]{1,100}$'),
  name text not null check (length(btrim(name)) between 1 and 100),
  group_name text not null check (length(btrim(group_name)) between 1 and 60),
  phone text not null default '' check (length(phone) <= 40),
  joined date not null,
  deposit boolean not null default false,
  primary key (user_id, id)
);
create table if not exists public.attendance (
  user_id uuid not null,
  student_id text not null,
  lesson_date date not null,
  status text not null check (status in ('present', 'absent', 'excused')),
  primary key (user_id, lesson_date, student_id),
  foreign key (user_id, student_id) references public.students(user_id, id) on delete cascade
);
create index if not exists attendance_student_idx on public.attendance(user_id, student_id);

alter table public.journals enable row level security;
alter table public.students enable row level security;
alter table public.attendance enable row level security;

drop policy if exists own_journal_read on public.journals;
create policy own_journal_read on public.journals for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists own_students_read on public.students;
create policy own_students_read on public.students for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists own_attendance_read on public.attendance;
create policy own_attendance_read on public.attendance for select to authenticated using ((select auth.uid()) = user_id);

-- Clients cannot bypass optimistic concurrency through direct table writes.
revoke all on public.journals, public.students, public.attendance from public, anon, authenticated;
grant select on public.journals, public.students, public.attendance to authenticated;

create or replace function public.load_journal()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_result jsonb;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  -- One SQL statement gives a consistent snapshot of revision AND all rows.
  select jsonb_build_object(
    'revision', coalesce((select revision from public.journals where user_id = v_user), 0),
    'state', jsonb_build_object(
      'version', 1,
      'students', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'name', name, 'group', group_name, 'phone', phone,
          'joined', to_char(joined, 'YYYY-MM-DD'), 'deposit', deposit
        ) order by id) from public.students where user_id = v_user
      ), '[]'::jsonb),
      'attendance', coalesce((
        select jsonb_object_agg(date_key, marks) from (
          select to_char(lesson_date, 'YYYY-MM-DD') as date_key,
                 jsonb_object_agg(student_id, status) as marks
          from public.attendance where user_id = v_user group by lesson_date
        ) dates
      ), '{}'::jsonb)
    )
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.save_journal(p_state jsonb, p_expected_revision bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_revision bigint;
  v_student jsonb;
  v_day record;
  v_mark record;
  v_joined date;
  v_date date;
  v_ids text[] := array[]::text[];
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_state is null or octet_length(p_state::text) > 5242880
     or jsonb_typeof(p_state) is distinct from 'object'
     or p_state->'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_state->'students') is distinct from 'array'
     or jsonb_typeof(p_state->'attendance') is distinct from 'object'
     or p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'invalid_journal';
  end if;

  -- Concurrent first writes also serialize: INSERT waits for the competing row.
  insert into public.journals(user_id) values (v_user) on conflict (user_id) do nothing;
  select revision into v_revision from public.journals where user_id = v_user for update;
  if v_revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'journal_conflict';
  end if;

  -- Any validation error rolls back the entire call, including these deletes.
  delete from public.students where user_id = v_user;
  for v_student in select value from jsonb_array_elements(p_state->'students') loop
    if jsonb_typeof(v_student) is distinct from 'object'
       or jsonb_typeof(v_student->'id') is distinct from 'string'
       or (v_student->>'id') !~ '^[a-zA-Z0-9-]{1,100}$'
       or (v_student->>'id') = any(v_ids)
       or jsonb_typeof(v_student->'name') is distinct from 'string'
       or length(v_student->>'name') > 100 or length(btrim(v_student->>'name')) = 0
       or jsonb_typeof(v_student->'group') is distinct from 'string'
       or length(v_student->>'group') > 60 or length(btrim(v_student->>'group')) = 0
       or jsonb_typeof(v_student->'phone') is distinct from 'string'
       or length(v_student->>'phone') > 40
       or jsonb_typeof(v_student->'deposit') is distinct from 'boolean'
       or jsonb_typeof(v_student->'joined') is distinct from 'string'
       or (v_student->>'joined') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode = '22023', message = 'invalid_student';
    end if;
    v_joined := (v_student->>'joined')::date;
    if to_char(v_joined, 'YYYY-MM-DD') <> v_student->>'joined' then
      raise exception using errcode = '22023', message = 'invalid_joined_date';
    end if;
    v_ids := array_append(v_ids, v_student->>'id');
    insert into public.students(user_id, id, name, group_name, phone, joined, deposit)
    values (v_user, v_student->>'id', btrim(v_student->>'name'), btrim(v_student->>'group'),
            v_student->>'phone', v_joined, (v_student->>'deposit')::boolean);
  end loop;

  for v_day in select key, value from jsonb_each(p_state->'attendance') loop
    if v_day.key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or jsonb_typeof(v_day.value) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'invalid_attendance_date';
    end if;
    v_date := v_day.key::date;
    if to_char(v_date, 'YYYY-MM-DD') <> v_day.key then
      raise exception using errcode = '22023', message = 'invalid_attendance_date';
    end if;
    for v_mark in select key, value from jsonb_each(v_day.value) loop
      select joined into v_joined from public.students where user_id = v_user and id = v_mark.key;
      if not found or v_joined > v_date
         or jsonb_typeof(v_mark.value) is distinct from 'string'
         or (v_mark.value #>> '{}') not in ('present', 'absent', 'excused') then
        raise exception using errcode = '22023', message = 'invalid_attendance_mark';
      end if;
      insert into public.attendance(user_id, student_id, lesson_date, status)
      values (v_user, v_mark.key, v_date, v_mark.value #>> '{}');
    end loop;
  end loop;
  update public.journals set revision = revision + 1 where user_id = v_user;
  return public.load_journal();
end;
$$;

-- PostgreSQL defaults new functions to PUBLIC execute: explicitly close that path.
revoke all on function public.load_journal() from public, anon, authenticated;
revoke all on function public.save_journal(jsonb, bigint) from public, anon, authenticated;
grant execute on function public.load_journal() to authenticated;
grant execute on function public.save_journal(jsonb, bigint) to authenticated;

commit;
