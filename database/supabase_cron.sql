-- Bullseye scheduler, run by Supabase itself (free on every plan).
--
-- Why: GitHub's free scheduled workflows are throttled. "Every 10 minutes"
-- actually ran hours apart, so the Render backend fell asleep and the evening
-- picks and emails went out late or not at all. Supabase Cron (pg_cron) fires
-- on time, and pg_net makes the HTTP calls.
--
-- What it does:
--   1. Pings the backend every 10 minutes so Render's free instance never
--      sleeps. One always-on service uses about 744 of the 750 free instance
--      hours Render gives each month.
--   2. Every 10 minutes from 15:30 to 23:30 IST on weekdays, calls the
--      scheduled tick: it builds the next session's picks once after the
--      close, sends emails that are due, and records outcomes. The call
--      returns at once and the work continues on the server.
--
-- How to run it (once):
--   1. Supabase dashboard -> Integrations -> enable "Cron" (pg_cron) and
--      "pg_net" if they are not already on.
--   2. Open the SQL editor, paste this whole file, and replace the two
--      placeholders in step A with your Render URL and ALERT_ADMIN_KEY.
--      The key is stored in Supabase Vault, not in this file or the repo.
--   3. Run it. Re-running is safe: jobs are replaced, not duplicated.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── A. Secrets (edit the two values, then run) ─────────────────────────────
do $$
begin
  delete from vault.secrets where name in ('bullseye_backend_url', 'bullseye_admin_key');
  perform vault.create_secret('https://YOUR-SERVICE.onrender.com', 'bullseye_backend_url');
  perform vault.create_secret('PASTE_YOUR_ALERT_ADMIN_KEY_HERE', 'bullseye_admin_key');
end $$;

-- ── B. Jobs ────────────────────────────────────────────────────────────────
select cron.unschedule(jobid)
from cron.job
where jobname in ('bullseye-keep-awake', 'bullseye-daily-tick');

-- Every 10 minutes, all day.
select cron.schedule(
  'bullseye-keep-awake',
  '*/10 * * * *',
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'bullseye_backend_url') || '/health',
    timeout_milliseconds := 60000
  );
  $$
);

-- Every 10 minutes, 10:00-17:50 UTC (15:30-23:20 IST), Monday to Friday.
select cron.schedule(
  'bullseye-daily-tick',
  '*/10 10-17 * * 1-5',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'bullseye_backend_url')
           || '/api/v1/daily-updates/run-scheduled',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-alert-admin-key', (select decrypted_secret from vault.decrypted_secrets where name = 'bullseye_admin_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- ── C. Check it is working (run these any time) ────────────────────────────
-- select jobname, schedule, active from cron.job where jobname like 'bullseye-%';
-- select status, return_message, start_time from cron.job_run_details
--   order by start_time desc limit 20;
-- select status_code, created from net._http_response order by created desc limit 20;
