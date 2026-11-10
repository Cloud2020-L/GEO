from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg
from psycopg.rows import dict_row

from config import POSTGRES_DSN


@contextmanager
def get_conn() -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(POSTGRES_DSN, row_factory=dict_row)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def ensure_app_schema() -> None:
    """Create production-facing tables used by dashboard modules."""
    with get_conn() as conn:
        conn.execute("create extension if not exists pgcrypto")
        has_leads = conn.execute(
            "select to_regclass('public.consultation_leads') as table_name"
        ).fetchone()
        if has_leads and has_leads["table_name"]:
            conn.execute("alter table consultation_leads add column if not exists brand_name text")
            conn.execute("alter table consultation_leads add column if not exists domain text")
            conn.execute(
                "alter table consultation_leads add column if not exists keywords jsonb not null default '[]'::jsonb"
            )
            conn.execute(
                "alter table consultation_leads add column if not exists competitors jsonb not null default '[]'::jsonb"
            )
        conn.execute(
            """
            create table if not exists app_tenants (
              id uuid primary key default gen_random_uuid(),
              name text not null unique,
              plan text not null default 'standard',
              credit_balance int not null default 10000,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists app_users (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              username text,
              name text not null,
              email text not null unique,
              password_hash text not null,
              role text not null default 'client',
              status text not null default 'active',
              bound_lead_id uuid,
              must_change_password boolean,
              last_login_at timestamptz,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("alter table app_users add column if not exists username text")
        conn.execute("alter table app_users add column if not exists phone text")
        conn.execute("alter table app_users add column if not exists bound_lead_id uuid")
        if has_leads and has_leads["table_name"]:
            conn.execute(
                """
                update app_users u
                set bound_lead_id = null
                where u.bound_lead_id is not null
                  and not exists (
                    select 1 from consultation_leads l where l.id = u.bound_lead_id
                  )
                """
            )
            conn.execute("alter table app_users drop constraint if exists app_users_bound_lead_id_fkey")
            conn.execute(
                """
                alter table app_users
                add constraint app_users_bound_lead_id_fkey
                foreign key (bound_lead_id) references consultation_leads(id) on delete set null
                """
            )
        conn.execute(
            """
            with seeds as (
              select
                id,
                coalesce(
                  nullif(regexp_replace(lower(split_part(coalesce(email, ''), '@', 1)), '[^a-z0-9_-]', '', 'g'), ''),
                  'user-' || left(id::text, 8)
                ) as seed
              from app_users
              where username is null or btrim(username) = ''
            ),
            ranked as (
              select id, seed, row_number() over (partition by seed order by id) as rn
              from seeds
            )
            update app_users u
            set username = case when r.rn = 1 then r.seed else r.seed || '-' || r.rn::text end
            from ranked r
            where u.id = r.id
            """
        )
        conn.execute("alter table app_users alter column username set not null")
        conn.execute("create unique index if not exists idx_app_users_username_ci on app_users(lower(username))")
        conn.execute("create unique index if not exists idx_app_users_phone on app_users(phone) where phone is not null")
        conn.execute("create index if not exists idx_app_users_bound_lead on app_users(bound_lead_id)")
        conn.execute("alter table app_users add column if not exists must_change_password boolean")
        conn.execute(
            """
            update app_users
            set must_change_password = true
            where must_change_password is null and lower(email) = 'admin@zggeo.local'
            """
        )
        conn.execute("update app_users set must_change_password = false where must_change_password is null")
        conn.execute("alter table app_users alter column must_change_password set default false")
        conn.execute("alter table app_users alter column must_change_password set not null")
        conn.execute(
            """
            create table if not exists role_permissions (
              role text not null,
              module text not null,
              can_view boolean not null default true,
              can_edit boolean not null default false,
              primary key (role, module)
            )
            """
        )
        conn.execute(
            """
            create table if not exists api_keys (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              name text not null,
              key_hash text not null,
              key_preview text not null,
              scope text not null default 'reports:read',
              status text not null default 'active',
              last_used_at timestamptz,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists auth_sms_codes (
              id uuid primary key default gen_random_uuid(),
              scene text not null,
              phone_hash text not null,
              code_hash text not null,
              provider text not null,
              provider_request_id text,
              ip text,
              attempts int not null default 0,
              expires_at timestamptz not null,
              consumed_at timestamptz,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("create index if not exists idx_auth_sms_codes_phone_created on auth_sms_codes(phone_hash, created_at desc)")
        conn.execute("create index if not exists idx_auth_sms_codes_ip_created on auth_sms_codes(ip, created_at desc)")
        conn.execute(
            """
            create table if not exists operation_logs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete set null,
              actor text not null default 'system',
              module text not null,
              action text not null,
              result text not null default 'success',
              detail text,
              ip text default '127.0.0.1',
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists customer_activity_logs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete set null,
              user_id uuid references app_users(id) on delete set null,
              role text,
              module text not null,
              action text not null,
              target_type text,
              target_id text,
              status text not null default 'success',
              message text,
              error_type text,
              error_detail text,
              request_payload jsonb not null default '{}'::jsonb,
              response_summary jsonb not null default '{}'::jsonb,
              request_id text,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists operation_steps (
              id uuid primary key default gen_random_uuid(),
              activity_id uuid references customer_activity_logs(id) on delete cascade,
              step_key text not null,
              step_name text not null,
              status text not null default 'success',
              started_at timestamptz not null default now(),
              finished_at timestamptz,
              duration_ms int,
              message text,
              error_detail text
            )
            """
        )
        conn.execute(
            "create index if not exists idx_customer_activity_logs_tenant_created on customer_activity_logs(tenant_id, created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_customer_activity_logs_request_id on customer_activity_logs(request_id)"
        )
        conn.execute(
            "create index if not exists idx_customer_activity_logs_module_status_created on customer_activity_logs(module, status, created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_customer_activity_logs_target on customer_activity_logs(target_type, target_id)"
        )
        conn.execute(
            "create index if not exists idx_operation_steps_activity on operation_steps(activity_id)"
        )
        conn.execute(
            """
            create table if not exists task_queue_jobs (
              id uuid primary key default gen_random_uuid(),
              queue_id text not null unique,
              tenant_id uuid references app_tenants(id) on delete set null,
              name text not null,
              backend text not null default 'local',
              status text not null default 'queued',
              run_log_task_id text,
              operation_module text,
              operation_action text,
              rq_job_id text,
              result_summary jsonb not null default '{}'::jsonb,
              error_type text,
              error_detail text,
              queued_at timestamptz not null default now(),
              started_at timestamptz,
              finished_at timestamptz,
              duration_ms int,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        for sql in [
            "alter table task_queue_jobs add column if not exists queue_id text",
            "alter table task_queue_jobs add column if not exists tenant_id uuid references app_tenants(id) on delete set null",
            "alter table task_queue_jobs add column if not exists name text",
            "alter table task_queue_jobs add column if not exists backend text not null default 'local'",
            "alter table task_queue_jobs add column if not exists status text not null default 'queued'",
            "alter table task_queue_jobs add column if not exists run_log_task_id text",
            "alter table task_queue_jobs add column if not exists operation_module text",
            "alter table task_queue_jobs add column if not exists operation_action text",
            "alter table task_queue_jobs add column if not exists rq_job_id text",
            "alter table task_queue_jobs add column if not exists result_summary jsonb not null default '{}'::jsonb",
            "alter table task_queue_jobs add column if not exists error_type text",
            "alter table task_queue_jobs add column if not exists error_detail text",
            "alter table task_queue_jobs add column if not exists queued_at timestamptz not null default now()",
            "alter table task_queue_jobs add column if not exists started_at timestamptz",
            "alter table task_queue_jobs add column if not exists finished_at timestamptz",
            "alter table task_queue_jobs add column if not exists duration_ms int",
            "alter table task_queue_jobs add column if not exists created_at timestamptz not null default now()",
            "alter table task_queue_jobs add column if not exists updated_at timestamptz not null default now()",
        ]:
            conn.execute(sql)
        conn.execute("update task_queue_jobs set queue_id = id::text where queue_id is null")
        conn.execute("update task_queue_jobs set name = 'unknown' where name is null")
        conn.execute("create unique index if not exists idx_task_queue_jobs_queue_id_unique on task_queue_jobs(queue_id)")
        conn.execute("create index if not exists idx_task_queue_jobs_tenant_created on task_queue_jobs(tenant_id, created_at desc)")
        conn.execute("create index if not exists idx_task_queue_jobs_status_created on task_queue_jobs(status, created_at desc)")
        conn.execute("create index if not exists idx_task_queue_jobs_name_created on task_queue_jobs(name, created_at desc)")
        conn.execute(
            """
            create table if not exists content_writing_tasks (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              lead_id uuid,
              report_id uuid references analysis_reports(id) on delete set null,
              title text not null,
              brand text not null,
              domain text not null,
              keyword text not null,
              channel text not null,
              angle text not null,
              priority text not null default '中',
              status text not null default '待生成',
              outline jsonb not null default '[]'::jsonb,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists brand_knowledge (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              title text not null,
              type text not null,
              content text not null,
              tags jsonb not null default '[]'::jsonb,
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists content_image_groups (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              lead_id uuid,
              name text not null,
              description text,
              usage text not null default 'article',
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create unique index if not exists idx_content_image_groups_tenant_lead_name
            on content_image_groups(tenant_id, coalesce(lead_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
            """
        )
        conn.execute(
            "create index if not exists idx_content_image_groups_tenant_lead on content_image_groups(tenant_id, lead_id, created_at desc)"
        )
        conn.execute(
            """
            create table if not exists content_images (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              lead_id uuid,
              group_id uuid not null references content_image_groups(id) on delete cascade,
              name text not null,
              alt text not null,
              file_url text not null,
              file_path text not null,
              mime_type text not null,
              size bigint not null default 0,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create index if not exists idx_content_images_tenant_group_created on content_images(tenant_id, group_id, created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_content_images_tenant_lead_created on content_images(tenant_id, lead_id, created_at desc)"
        )
        conn.execute(
            """
            create table if not exists article_drafts (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              task_id uuid references content_writing_tasks(id) on delete set null,
              source_prompt_text text,
              source_prompt_keyword text,
              source_prompt_intent text,
              source_prompt_scenario text,
              generated_from text not null default 'manual',
              title text not null,
              channel text not null,
              article_type text,
              body text not null,
              model text,
              provider text not null default 'local',
              status text not null default '草稿',
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists credit_transactions (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              amount int not null,
              type text not null,
              module text not null,
              description text not null,
              ref_id text,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("alter table credit_transactions add column if not exists balance_after int")
        conn.execute("alter table credit_transactions add column if not exists status text not null default 'posted'")
        conn.execute("alter table credit_transactions add column if not exists ref_type text")
        conn.execute("alter table credit_transactions add column if not exists idempotency_key text")
        conn.execute("alter table credit_transactions add column if not exists created_by uuid")
        conn.execute("create unique index if not exists idx_credit_transactions_idempotency on credit_transactions(idempotency_key) where idempotency_key is not null")
        conn.execute(
            """
            create table if not exists credit_accounts (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null unique references app_tenants(id) on delete cascade,
              available_balance int not null default 0,
              held_balance int not null default 0,
              lifetime_credited int not null default 0,
              lifetime_consumed int not null default 0,
              low_balance_threshold int not null default 500,
              expires_at timestamptz,
              last_expired_at timestamptz,
              expiry_policy text not null default 'client_configured',
              updated_at timestamptz not null default now(),
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("alter table credit_accounts add column if not exists expires_at timestamptz")
        conn.execute("alter table credit_accounts add column if not exists last_expired_at timestamptz")
        conn.execute("alter table credit_accounts add column if not exists expiry_policy text not null default 'client_configured'")
        conn.execute("alter table credit_accounts alter column expiry_policy set default 'client_configured'")
        conn.execute("update credit_accounts set expiry_policy = 'client_configured' where expiry_policy is null")
        conn.execute("alter table credit_accounts alter column expiry_policy set not null")
        conn.execute("create index if not exists idx_credit_accounts_expires_at on credit_accounts(expires_at) where expires_at is not null")
        conn.execute(
            """
            insert into credit_accounts (tenant_id, available_balance, lifetime_credited)
            select id, credit_balance, greatest(credit_balance, 0)
            from app_tenants
            on conflict (tenant_id) do nothing
            """
        )
        conn.execute(
            """
            create table if not exists credit_ledger_entries (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              account_id uuid not null references credit_accounts(id) on delete cascade,
              amount int not null,
              direction text not null,
              entry_type text not null,
              module text not null,
              description text not null,
              ref_type text,
              ref_id text,
              status text not null default 'posted',
              idempotency_key text,
              balance_after int not null,
              created_by uuid,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("create unique index if not exists idx_credit_ledger_entries_idempotency on credit_ledger_entries(idempotency_key) where idempotency_key is not null")
        conn.execute("create index if not exists idx_credit_ledger_entries_tenant_created on credit_ledger_entries(tenant_id, created_at desc)")
        conn.execute(
            """
            create table if not exists credit_holds (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              account_id uuid not null references credit_accounts(id) on delete cascade,
              amount int not null,
              captured_amount int not null default 0,
              status text not null default 'held',
              module text not null,
              description text not null,
              ref_type text not null,
              ref_id text not null,
              idempotency_key text,
              expires_at timestamptz,
              created_by uuid,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute("create unique index if not exists idx_credit_holds_idempotency on credit_holds(idempotency_key) where idempotency_key is not null")
        conn.execute("create index if not exists idx_credit_holds_tenant_status on credit_holds(tenant_id, status)")
        conn.execute(
            """
            create table if not exists billing_plans (
              id uuid primary key default gen_random_uuid(),
              code text not null unique,
              name text not null,
              price_monthly int not null default 0,
              price_yearly int not null default 0,
              monthly_credits int not null default 0,
              max_projects int,
              max_users int,
              features jsonb not null default '[]'::jsonb,
              limits jsonb not null default '[]'::jsonb,
              status text not null default 'active',
              sort_order int not null default 0,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists credit_packs (
              id uuid primary key default gen_random_uuid(),
              code text not null unique,
              name text not null,
              credits int not null,
              price_cents int not null,
              description text not null default '',
              status text not null default 'active',
              sort_order int not null default 0,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists billing_orders (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              order_no text not null unique,
              order_type text not null,
              status text not null default 'pending',
              amount_cents int not null default 0,
              credits int not null default 0,
              plan_code text,
              credit_pack_code text,
              payment_method text not null default 'bank',
              description text not null default '',
              paid_at timestamptz,
              created_by uuid,
              confirmed_by uuid,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute("create index if not exists idx_billing_orders_tenant_created on billing_orders(tenant_id, created_at desc)")
        conn.execute("create index if not exists idx_billing_orders_status_created on billing_orders(status, created_at desc)")
        conn.execute("create index if not exists idx_billing_orders_tenant_status_created on billing_orders(tenant_id, status, created_at desc)")
        conn.execute("create index if not exists idx_billing_orders_status_type_created on billing_orders(status, order_type, created_at desc)")
        conn.execute("create index if not exists idx_billing_orders_tenant_status_type_created on billing_orders(tenant_id, status, order_type, created_at desc)")
        conn.execute(
            """
            create table if not exists media_market_order_snapshots (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              media_id text not null,
              media_name text,
              title text not null default '',
              pop_id text,
              pop_out_trade_no text,
              cost_amount_cents int,
              markup_bps int not null default 2000,
              sale_amount_cents int,
              charge_credits int not null default 0,
              credit_hold_id uuid references credit_holds(id) on delete set null,
              created_by uuid,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("create index if not exists idx_media_market_snapshots_tenant_created on media_market_order_snapshots(tenant_id, created_at desc)")
        conn.execute(
            """
            create table if not exists billing_low_balance_events (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              available_balance int not null,
              threshold int not null,
              status text not null default 'open',
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("create index if not exists idx_billing_low_balance_events_tenant_created on billing_low_balance_events(tenant_id, created_at desc)")
        for plan in [
            ("trial", "体验版", 0, 0, 300, 1, 1, '["基础 GEO 诊断", "基础报告", "1 个品牌项目"]', '["不含媒体分发", "不含 Agent 自动运作"]', 10),
            ("standard", "标准版", 99900, 999000, 5000, 10, 3, '["GEO 增强诊断", "文章生成", "回测闭环", "媒体分发后台"]', '["媒体发稿费用另计", "第三方 API 需单独开通"]', 20),
            ("growth", "增长版", 299900, 2999000, 30000, 50, 10, '["多品牌项目", "多模型诊断", "批量文章", "Agent 自动运作"]', '["企业 SLA 需单独确认"]', 30),
            ("enterprise", "企业版", 0, 0, 0, None, None, '["白标交付", "API 对接", "私有化/定制", "专属 SLA"]', '["需商务确认价格和服务边界"]', 40),
        ]:
            conn.execute(
                """
                insert into billing_plans (
                  code, name, price_monthly, price_yearly, monthly_credits, max_projects, max_users,
                  features, limits, sort_order
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
                on conflict (code) do nothing
                """,
                plan,
            )
        for pack in [
            ("basic", "基础点数包", 1990, 19900, "适合额外诊断和少量内容生成", 10),
            ("growth", "增长点数包", 9990, 99900, "适合月度 GEO 优化和媒体分发", 20),
            ("delivery", "交付点数包", 49990, 499900, "适合代理商批量客户交付", 30),
        ]:
            conn.execute(
                """
                insert into credit_packs (code, name, credits, price_cents, description, sort_order)
                values (%s, %s, %s, %s, %s, %s)
                on conflict (code) do update
                set credits = excluded.credits,
                    price_cents = excluded.price_cents,
                    description = excluded.description,
                    sort_order = excluded.sort_order,
                    updated_at = now()
                """,
                pack,
            )
        conn.execute(
            """
            create table if not exists geo_drift_schedules (
              id uuid primary key default gen_random_uuid(),
              domain text not null unique,
              frequency text not null default 'weekly',
              enabled boolean not null default true,
              updated_at timestamptz not null default now(),
              next_run_at timestamptz
            )
            """
        )
        conn.execute(
            """
            create table if not exists geo_drift_snapshots (
              id uuid primary key default gen_random_uuid(),
              domain text not null,
              captured_at timestamptz not null default now(),
              severity text not null default 'none',
              snapshot jsonb not null default '{}'::jsonb,
              changes jsonb not null default '[]'::jsonb,
              result_json jsonb not null default '{}'::jsonb,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create index if not exists idx_geo_drift_snapshots_domain_created on geo_drift_snapshots(domain, created_at desc)"
        )
        conn.execute(
            """
            create table if not exists distribution_records (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              draft_id uuid references article_drafts(id) on delete set null,
              title text not null,
              channel text not null,
              target text not null,
              status text not null default '待提交',
              cost int not null default 0,
              publish_url text,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute("alter table distribution_records add column if not exists platform text")
        conn.execute("alter table distribution_records add column if not exists account_name text")
        conn.execute("alter table distribution_records add column if not exists scheduled_at timestamptz")
        conn.execute("alter table distribution_records add column if not exists published_at timestamptz")
        conn.execute("alter table distribution_records add column if not exists review_note text")
        conn.execute("alter table distribution_records add column if not exists publisher_name text")
        conn.execute("alter table distribution_records add column if not exists account_id uuid")
        conn.execute("alter table distribution_records add column if not exists publish_mode text not null default 'manual_copy'")
        conn.execute("alter table distribution_records add column if not exists customer_confirmed_at timestamptz")
        conn.execute("alter table distribution_records add column if not exists customer_confirmed_by text")
        conn.execute("alter table distribution_records add column if not exists platform_entry_url text")
        conn.execute("alter table distribution_records add column if not exists monitoring_status text not null default 'not_started'")
        conn.execute("alter table distribution_records add column if not exists error_message text")
        conn.execute("create index if not exists idx_distribution_records_tenant_status on distribution_records(tenant_id, status, updated_at desc)")
        conn.execute("create index if not exists idx_distribution_records_draft on distribution_records(draft_id)")
        conn.execute(
            """
            create table if not exists publishing_accounts (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              platform text not null,
              account_name text not null,
              account_home_url text,
              auth_status text not null default 'manual_only',
              publish_mode text not null default 'manual_copy',
              remark text,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute("alter table publishing_accounts add column if not exists account_type text not null default 'personal'")
        conn.execute("alter table publishing_accounts add column if not exists subject_name text")
        conn.execute("alter table publishing_accounts add column if not exists auth_method text not null default 'manual'")
        conn.execute("create index if not exists idx_publishing_accounts_tenant_platform on publishing_accounts(tenant_id, platform)")
        conn.execute(
            """
            create table if not exists owned_publishing_tasks (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              draft_id uuid references article_drafts(id) on delete set null,
              account_id uuid references publishing_accounts(id) on delete set null,
              title text not null,
              platform text not null,
              account_name text,
              account_type text not null default 'personal',
              subject_name text,
              status text not null default '待客户确认',
              publish_mode text not null default 'manual_copy',
              platform_entry_url text,
              publish_url text,
              scheduled_at timestamptz,
              published_at timestamptz,
              review_note text,
              customer_confirmed_at timestamptz,
              customer_confirmed_by text,
              error_message text,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute("create index if not exists idx_owned_publishing_tasks_tenant_status on owned_publishing_tasks(tenant_id, status, updated_at desc)")
        conn.execute("create index if not exists idx_owned_publishing_tasks_draft on owned_publishing_tasks(draft_id)")
        conn.execute(
            """
            create table if not exists owned_publishing_logs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              task_id uuid references owned_publishing_tasks(id) on delete cascade,
              action text not null,
              operator_name text,
              before_status text,
              after_status text,
              detail jsonb not null default '{}'::jsonb,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("create index if not exists idx_owned_publishing_logs_task_created on owned_publishing_logs(task_id, created_at desc)")
        conn.execute(
            """
            create table if not exists publishing_logs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              task_id uuid references distribution_records(id) on delete cascade,
              action text not null,
              operator_name text,
              before_status text,
              after_status text,
              detail jsonb not null default '{}'::jsonb,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("create index if not exists idx_publishing_logs_task_created on publishing_logs(task_id, created_at desc)")
        conn.execute("alter table content_writing_tasks add column if not exists agent_enabled boolean not null default false")
        conn.execute("alter table content_writing_tasks add column if not exists agent_run_id uuid")
        conn.execute("alter table content_writing_tasks add column if not exists lead_id uuid")
        conn.execute("alter table content_writing_tasks add column if not exists source_prompt_id uuid")
        conn.execute("alter table content_writing_tasks add column if not exists source_prompt_text text")
        conn.execute("alter table content_writing_tasks add column if not exists source_prompt_keyword text")
        conn.execute("alter table content_writing_tasks add column if not exists source_prompt_intent text")
        conn.execute("alter table content_writing_tasks add column if not exists source_prompt_scenario text")
        conn.execute("create index if not exists idx_content_writing_tasks_lead_created on content_writing_tasks(lead_id, created_at desc)")
        conn.execute("create index if not exists idx_content_writing_tasks_source_prompt on content_writing_tasks(source_prompt_id)")
        conn.execute(
            """
            create table if not exists content_agent_runs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              task_id uuid references content_writing_tasks(id) on delete set null,
              draft_id uuid references article_drafts(id) on delete set null,
              distribution_id uuid references distribution_records(id) on delete set null,
              content_type text not null default 'image_text',
              agent_key text not null default '图文Agent',
              route_reason text,
              provider text,
              status text not null default 'pending',
              stage text not null default 'queued',
              title text not null,
              channel text not null,
              target text not null,
              geo_score int not null default 0,
              score_detail jsonb not null default '{}'::jsonb,
              calibration jsonb not null default '{}'::jsonb,
              generated_payload jsonb not null default '{}'::jsonb,
              error text,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now(),
              finished_at timestamptz
            )
            """
        )
        conn.execute("alter table content_agent_runs add column if not exists provider text")
        conn.execute(
            """
            create table if not exists agent_workflow_runs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              lead_id uuid,
              project_name text not null,
              domain text,
              keywords jsonb not null default '[]'::jsonb,
              urls jsonb not null default '[]'::jsonb,
              competitors jsonb not null default '[]'::jsonb,
              notes text,
              mode text not null default 'full_auto',
              status text not null default 'pending',
              summary text,
              task_id uuid,
              report_id uuid,
              deployment jsonb,
              visibility jsonb,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now(),
              finished_at timestamptz
            )
            """
        )
        for sql in [
            "alter table agent_workflow_runs add column if not exists retry_count int not null default 0",
            "alter table agent_workflow_runs add column if not exists max_retries int not null default 2",
            "alter table agent_workflow_runs add column if not exists schedule_frequency text not null default 'weekly'",
            "alter table agent_workflow_runs add column if not exists schedule_enabled boolean not null default true",
            "alter table agent_workflow_runs add column if not exists next_run_at timestamptz",
            "alter table agent_workflow_runs add column if not exists last_inspection jsonb",
            "alter table agent_workflow_runs add column if not exists exported_report jsonb",
            "alter table agent_workflow_runs add column if not exists n8n_status text",
            "alter table agent_workflow_runs add column if not exists n8n_payload jsonb",
            "alter table agent_workflow_runs add column if not exists last_callback_at timestamptz",
            "alter table agent_workflow_runs add column if not exists config jsonb not null default '{}'::jsonb",
        ]:
            conn.execute(sql)
        conn.execute(
            """
            create table if not exists agent_workflow_steps (
              id uuid primary key default gen_random_uuid(),
              run_id uuid references agent_workflow_runs(id) on delete cascade,
              step_key text not null,
              agent_key text not null,
              title text not null,
              status text not null default 'pending',
              detail text,
              ref_type text,
              ref_id text,
              sort_order int not null default 0,
              started_at timestamptz,
              finished_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now(),
              unique(run_id, step_key)
            )
            """
        )
        conn.execute(
            """
            create table if not exists keyword_prompt_inventory (
              id uuid primary key default gen_random_uuid(),
              lead_id uuid,
              brand_name text not null,
              domain text,
              keyword text,
              prompt text not null,
              intent text not null default 'AI 问答',
              scenario text,
              provider text not null default 'local',
              model text,
              source text not null default 'generated',
              keyword_source text,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("alter table keyword_prompt_inventory add column if not exists keyword_source text")
        conn.execute(
            "create index if not exists idx_keyword_prompt_inventory_keyword_source on keyword_prompt_inventory(keyword_source)"
        )
        conn.execute(
            """
            create table if not exists keyword_expansion_non_brand_inventory (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              lead_id uuid,
              brand_name text not null,
              company text,
              domain text,
              keyword text not null,
              intent text not null default '非品牌关键词',
              reason text,
              provider text not null default 'local',
              model text,
              source text not null default 'generated',
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create index if not exists idx_keyword_expansion_non_brand_lead_created on keyword_expansion_non_brand_inventory(lead_id, created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_keyword_expansion_non_brand_brand_created on keyword_expansion_non_brand_inventory(brand_name, created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_keyword_prompt_inventory_lead_created on keyword_prompt_inventory(lead_id, created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_keyword_prompt_inventory_brand_created on keyword_prompt_inventory(brand_name, created_at desc)"
        )
        conn.execute(
            """
            create table if not exists model_visibility_runs (
              id uuid primary key default gen_random_uuid(),
              lead_id text,
              project_name text not null,
              domain text,
              questions jsonb not null default '[]'::jsonb,
              providers jsonb not null default '[]'::jsonb,
              competitors jsonb not null default '[]'::jsonb,
              run_type text not null default 'normal',
              parent_run_id uuid references model_visibility_runs(id) on delete set null,
              source_probe_enabled boolean not null default false,
              status text not null default 'running',
              summary jsonb not null default '{}'::jsonb,
              created_at timestamptz not null default now(),
              finished_at timestamptz
            )
            """
        )
        conn.execute(
            """
            create table if not exists model_visibility_results (
              id uuid primary key default gen_random_uuid(),
              run_id uuid references model_visibility_runs(id) on delete cascade,
              provider text not null,
              provider_name text,
              vendor text,
              model text,
              question text not null,
              status text not null,
              answer text,
              error text,
              score int not null default 0,
              brand_mentioned boolean not null default false,
              domain_mentioned boolean not null default false,
              recommended boolean not null default false,
              brand_rank int,
              competitor_mentions jsonb not null default '[]'::jsonb,
              latency_ms int,
              answer_length int not null default 0,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists ai_answer_sources (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              run_id uuid references model_visibility_runs(id) on delete cascade,
              result_id uuid references model_visibility_results(id) on delete cascade,
              question text not null,
              provider text,
              model text,
              brand text,
              source_kind text not null default 'url',
              source_url text,
              source_domain text,
              source_title text,
              source_type text,
              source_excerpt text,
              verification_status text not null default 'unverified',
              confidence numeric not null default 0,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute("alter table model_visibility_runs add column if not exists run_type text not null default 'normal'")
        conn.execute(
            "alter table model_visibility_runs add column if not exists parent_run_id uuid references model_visibility_runs(id) on delete set null"
        )
        conn.execute(
            "alter table model_visibility_runs add column if not exists source_probe_enabled boolean not null default false"
        )
        conn.execute("alter table ai_answer_sources add column if not exists verification_status text not null default 'unverified'")
        conn.execute(
            """
            create table if not exists ai_source_articles (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              source_url text not null,
              source_domain text,
              media_name text,
              media_type text,
              title text,
              raw_text text,
              article_type text,
              content_profile_json jsonb not null default '{}'::jsonb,
              trust_anchor_score int not null default 0,
              structure_score int not null default 0,
              fetch_status text not null default 'pending',
              fetch_error text,
              fetched_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create index if not exists idx_model_visibility_runs_created on model_visibility_runs(created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_model_visibility_runs_parent on model_visibility_runs(parent_run_id, created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_model_visibility_results_run on model_visibility_results(run_id)"
        )
        conn.execute(
            "create index if not exists idx_ai_answer_sources_run on ai_answer_sources(run_id)"
        )
        conn.execute(
            "create index if not exists idx_ai_answer_sources_result on ai_answer_sources(result_id)"
        )
        conn.execute(
            "create index if not exists idx_ai_answer_sources_domain on ai_answer_sources(tenant_id, source_domain)"
        )
        conn.execute(
            "create unique index if not exists idx_ai_source_articles_tenant_url on ai_source_articles(tenant_id, source_url)"
        )
        conn.execute(
            """
            create table if not exists question_geo_reports (
              id uuid primary key default gen_random_uuid(),
              lead_id text,
              project_name text not null,
              domain text,
              title text not null,
              report_json jsonb not null default '{}'::jsonb,
              deployment_json jsonb not null default '{}'::jsonb,
              html text not null default '',
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create index if not exists idx_question_geo_reports_domain_created on question_geo_reports(domain, created_at desc)"
        )
        conn.execute(
            """
            create table if not exists question_summary_reports (
              id uuid primary key default gen_random_uuid(),
              lead_id text,
              project_name text not null,
              domain text,
              asset_json jsonb not null default '{}'::jsonb,
              geo_report_id uuid references question_geo_reports(id) on delete set null,
              model_report_id uuid references model_visibility_runs(id) on delete set null,
              summary_json jsonb not null default '{}'::jsonb,
              provider text not null default 'local',
              model text,
              raw_text text,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create index if not exists idx_question_summary_reports_domain_created on question_summary_reports(domain, created_at desc)"
        )
        conn.execute(
            """
            create table if not exists contact_governance_profiles (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              lead_id text,
              project_name text not null,
              brand_name text,
              company_name text,
              domain text not null,
              official_phone text not null,
              official_phone_normalized text not null,
              backup_phone text,
              hotline_400 text,
              landline text,
              invalid_phones jsonb not null default '[]'::jsonb,
              preferred_display_phone text,
              contact_page_url text,
              address text,
              business_hours text,
              phone_display_policy text not null default 'official_phone',
              verified_status text not null default 'pending',
              verified_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists contact_audit_runs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              profile_id uuid references contact_governance_profiles(id) on delete cascade,
              domain text not null,
              status text not null default 'completed',
              summary jsonb not null default '{}'::jsonb,
              created_at timestamptz not null default now(),
              finished_at timestamptz
            )
            """
        )
        conn.execute(
            """
            create table if not exists contact_audit_results (
              id uuid primary key default gen_random_uuid(),
              run_id uuid references contact_audit_runs(id) on delete cascade,
              source_url text not null,
              source_type text not null default 'page',
              extracted_phone text not null,
              normalized_phone text not null,
              is_official boolean not null default false,
              is_invalid boolean not null default false,
              has_tel_link boolean not null default false,
              has_label boolean not null default false,
              context_excerpt text,
              risk_level text not null default 'low',
              suggestion text,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists contact_visibility_runs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid references app_tenants(id) on delete cascade,
              profile_id uuid references contact_governance_profiles(id) on delete cascade,
              project_name text not null,
              domain text not null,
              questions jsonb not null default '[]'::jsonb,
              providers jsonb not null default '[]'::jsonb,
              status text not null default 'completed',
              summary jsonb not null default '{}'::jsonb,
              created_at timestamptz not null default now(),
              finished_at timestamptz
            )
            """
        )
        conn.execute(
            """
            create table if not exists contact_visibility_results (
              id uuid primary key default gen_random_uuid(),
              run_id uuid references contact_visibility_runs(id) on delete cascade,
              provider text not null,
              provider_name text,
              vendor text,
              model text,
              question text not null,
              status text not null,
              answer text,
              error text,
              detected_phones jsonb not null default '[]'::jsonb,
              expected_phone text not null,
              correct_phone_shown boolean not null default false,
              wrong_phone_shown boolean not null default false,
              phone_missing boolean not null default false,
              score int not null default 0,
              latency_ms int,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create index if not exists idx_contact_profiles_tenant_domain on contact_governance_profiles(tenant_id, domain)"
        )
        conn.execute(
            "create index if not exists idx_contact_audit_runs_profile_created on contact_audit_runs(profile_id, created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_contact_visibility_runs_profile_created on contact_visibility_runs(profile_id, created_at desc)"
        )

        tenant = conn.execute(
            """
            insert into app_tenants (name, plan, credit_balance)
            values ('ZGEO 智改', 'standard', 10000)
            on conflict (name) do update set name = excluded.name
            returning id
            """
        ).fetchone()
        tenant_id = tenant["id"]
        tenant_bound_tables = [
            "projects",
            "analysis_tasks",
            "consultation_leads",
            "keyword_prompt_inventory",
            "keyword_expansion_non_brand_inventory",
            "model_visibility_runs",
            "ai_answer_sources",
            "ai_source_articles",
            "question_geo_reports",
            "question_summary_reports",
            "geo_drift_schedules",
            "geo_drift_snapshots",
            "content_writing_tasks",
            "brand_knowledge",
            "content_image_groups",
            "content_images",
            "article_drafts",
            "article_generation_runs",
            "content_optimization_campaigns",
            "content_optimization_retests",
            "distribution_records",
            "content_agent_runs",
            "agent_workflow_runs",
            "customer_activity_logs",
            "contact_governance_profiles",
            "contact_audit_runs",
            "contact_visibility_runs",
        ]
        for table in tenant_bound_tables:
            exists = conn.execute("select to_regclass(%s) as table_name", (f"public.{table}",)).fetchone()
            if not exists or not exists["table_name"]:
                continue
            conn.execute(
                f"alter table {table} add column if not exists tenant_id uuid references app_tenants(id) on delete cascade"
            )
            conn.execute(f"update {table} set tenant_id = %s where tenant_id is null", (tenant_id,))
            conn.execute(f"create index if not exists idx_{table}_tenant on {table}(tenant_id)")
        if has_leads and has_leads["table_name"]:
            conn.execute(
                """
                update app_users u
                set bound_lead_id = (
                  select l.id
                  from consultation_leads l
                  where l.tenant_id = u.tenant_id
                  order by l.created_at desc
                  limit 1
                )
                where u.role = 'client'
                  and u.bound_lead_id is null
                  and exists (
                    select 1
                    from consultation_leads l
                    where l.tenant_id = u.tenant_id
                  )
                """
            )
        conn.execute("alter table article_drafts add column if not exists article_type text")
        conn.execute("alter table article_drafts add column if not exists source_prompt_id uuid")
        conn.execute(
            """
            update article_drafts d
            set source_prompt_id = null
            where d.source_prompt_id is not null
              and not exists (
                select 1
                from keyword_prompt_inventory p
                where p.id = d.source_prompt_id
              )
            """
        )
        conn.execute("alter table article_drafts drop constraint if exists article_drafts_source_prompt_id_fkey")
        conn.execute(
            """
            alter table article_drafts
            add constraint article_drafts_source_prompt_id_fkey
            foreign key (source_prompt_id) references keyword_prompt_inventory(id) on delete set null
            """
        )
        conn.execute("alter table article_drafts add column if not exists source_prompt_text text")
        conn.execute("alter table article_drafts add column if not exists source_prompt_keyword text")
        conn.execute("alter table article_drafts add column if not exists source_prompt_intent text")
        conn.execute("alter table article_drafts add column if not exists source_prompt_scenario text")
        conn.execute("alter table article_drafts add column if not exists generated_from text not null default 'manual'")
        conn.execute("alter table article_drafts add column if not exists compliance_platform text")
        conn.execute("alter table article_drafts add column if not exists compliance_status text not null default 'not_checked'")
        conn.execute("alter table article_drafts add column if not exists compliance_summary text")
        conn.execute("alter table article_drafts add column if not exists compliance_issues jsonb not null default '[]'::jsonb")
        conn.execute("alter table article_drafts add column if not exists ai_disclosure_required boolean not null default false")
        conn.execute("alter table article_drafts add column if not exists source_required boolean not null default false")
        conn.execute("alter table article_drafts add column if not exists fiction_disclosure_required boolean not null default false")
        conn.execute("alter table article_drafts add column if not exists human_review_required boolean not null default false")
        conn.execute("alter table article_drafts add column if not exists human_reviewed_at timestamptz")
        conn.execute("create index if not exists idx_article_drafts_article_type on article_drafts(article_type)")
        conn.execute("create index if not exists idx_article_drafts_compliance_status on article_drafts(compliance_status)")
        conn.execute("create index if not exists idx_article_drafts_source_prompt on article_drafts(source_prompt_id)")
        conn.execute("create index if not exists idx_article_drafts_tenant_created on article_drafts(tenant_id, created_at desc)")
        conn.execute(
            """
            create table if not exists article_generation_runs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              user_id uuid references app_users(id) on delete set null,
              mode text not null default 'basic',
              task_id uuid references content_writing_tasks(id) on delete set null,
              source_prompt_id uuid references keyword_prompt_inventory(id) on delete set null,
              source_prompt_text text,
              client_request_id text not null,
              request_fingerprint text,
              requested_count int not null default 1,
              created_count int not null default 0,
              draft_ids jsonb not null default '[]'::jsonb,
              status text not null default 'queued',
              stage text not null default 'queued',
              queue_id text,
              credit_hold_id uuid references credit_holds(id) on delete set null,
              reused_existing boolean not null default false,
              payload jsonb not null default '{}'::jsonb,
              error_type text,
              error_detail text,
              activity_id uuid references customer_activity_logs(id) on delete set null,
              started_at timestamptz,
              updated_at timestamptz not null default now(),
              finished_at timestamptz,
              duration_ms int,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create unique index if not exists idx_article_generation_runs_client_request on article_generation_runs(tenant_id, user_id, client_request_id)"
        )
        conn.execute(
            "create index if not exists idx_article_generation_runs_active on article_generation_runs(tenant_id, user_id, status, updated_at desc)"
        )
        conn.execute(
            "create index if not exists idx_article_generation_runs_prompt on article_generation_runs(tenant_id, source_prompt_id, created_at desc)"
        )
        conn.execute("alter table article_generation_runs add column if not exists preference_snapshot_json jsonb not null default '{}'::jsonb")
        conn.execute("alter table article_drafts add column if not exists preference_snapshot_json jsonb not null default '{}'::jsonb")
        conn.execute("alter table article_drafts add column if not exists trust_anchor_check_json jsonb not null default '{}'::jsonb")
        conn.execute(
            """
            create table if not exists content_optimization_campaigns (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              article_generation_run_id uuid references article_generation_runs(id) on delete set null,
              draft_id uuid references article_drafts(id) on delete set null,
              brand text not null,
              domain text,
              published_url text,
              target_prompts jsonb not null default '[]'::jsonb,
              target_keywords jsonb not null default '[]'::jsonb,
              before_run_id uuid references model_visibility_runs(id) on delete set null,
              after_run_id uuid references model_visibility_runs(id) on delete set null,
              status text not null default 'created',
              attribution_result text,
              baseline_summary_json jsonb not null default '{}'::jsonb,
              latest_report_json jsonb not null default '{}'::jsonb,
              created_by uuid references app_users(id) on delete set null,
              published_at timestamptz,
              last_retested_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            """
            create table if not exists content_optimization_retests (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              campaign_id uuid references content_optimization_campaigns(id) on delete cascade,
              before_run_id uuid references model_visibility_runs(id) on delete set null,
              after_run_id uuid references model_visibility_runs(id) on delete set null,
              config_diff_json jsonb not null default '{}'::jsonb,
              report_json jsonb not null default '{}'::jsonb,
              attribution_result text,
              created_by uuid references app_users(id) on delete set null,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create index if not exists idx_content_optimization_campaigns_tenant_created on content_optimization_campaigns(tenant_id, created_at desc)"
        )
        conn.execute(
            "create index if not exists idx_content_optimization_campaigns_before_after on content_optimization_campaigns(before_run_id, after_run_id)"
        )
        conn.execute(
            "create index if not exists idx_content_optimization_retests_campaign_created on content_optimization_retests(campaign_id, created_at desc)"
        )
        conn.execute(
            """
            create table if not exists keyword_generation_runs (
              id uuid primary key default gen_random_uuid(),
              tenant_id uuid not null references app_tenants(id) on delete cascade,
              user_id uuid references app_users(id) on delete set null,
              lead_id uuid references consultation_leads(id) on delete set null,
              brand_name text not null,
              domain text,
              client_request_id text not null,
              requested_count int not null default 10,
              status text not null default 'queued',
              stage text not null default 'queued',
              queue_id text,
              credit_hold_id uuid references credit_holds(id) on delete set null,
              result_json jsonb not null default '{}'::jsonb,
              payload jsonb not null default '{}'::jsonb,
              error_type text,
              error_detail text,
              activity_id uuid references customer_activity_logs(id) on delete set null,
              started_at timestamptz,
              updated_at timestamptz not null default now(),
              finished_at timestamptz,
              duration_ms int,
              created_at timestamptz not null default now()
            )
            """
        )
        conn.execute(
            "create unique index if not exists idx_keyword_generation_runs_client_request on keyword_generation_runs(tenant_id, user_id, client_request_id)"
        )
        conn.execute(
            "create index if not exists idx_keyword_generation_runs_active on keyword_generation_runs(tenant_id, user_id, status, updated_at desc)"
        )
        conn.execute(
            "create index if not exists idx_keyword_generation_runs_lead on keyword_generation_runs(tenant_id, lead_id, created_at desc)"
        )
        for table in ("article_generation_runs", "keyword_generation_runs"):
            constraint = f"{table}_activity_id_fkey"
            conn.execute(f"alter table {table} drop constraint if exists {constraint}")
            conn.execute(
                f"""
                update {table} r
                set activity_id = null
                where activity_id is not null
                  and not exists (
                    select 1 from customer_activity_logs a where a.id = r.activity_id
                  )
                """
            )
            conn.execute(
                f"""
                alter table {table}
                add constraint {constraint}
                foreign key (activity_id) references customer_activity_logs(id) on delete set null
                """
            )
        conn.execute(
            """
            update content_writing_tasks t
            set source_prompt_id = p.id,
                source_prompt_text = p.prompt,
                source_prompt_keyword = p.keyword,
                source_prompt_intent = p.intent,
                source_prompt_scenario = p.scenario
            from keyword_prompt_inventory p
            where t.source_prompt_id is null
              and t.tenant_id = p.tenant_id
              and (t.lead_id = p.lead_id or (t.lead_id is null and p.lead_id is null))
              and lower(coalesce(t.domain, '')) = lower(coalesce(p.domain, ''))
              and t.title = p.prompt
            """
        )
        conn.execute(
            """
            update content_writing_tasks t
            set source_prompt_id = null
            where t.source_prompt_id is not null
              and not exists (
                select 1
                from keyword_prompt_inventory p
                where p.id = t.source_prompt_id
              )
            """
        )
        conn.execute(
            """
            update article_drafts d
            set source_prompt_id = coalesce(d.source_prompt_id, t.source_prompt_id),
                source_prompt_text = coalesce(d.source_prompt_text, t.source_prompt_text),
                source_prompt_keyword = coalesce(d.source_prompt_keyword, t.source_prompt_keyword),
                source_prompt_intent = coalesce(d.source_prompt_intent, t.source_prompt_intent),
                source_prompt_scenario = coalesce(d.source_prompt_scenario, t.source_prompt_scenario),
                generated_from = case
                  when coalesce(d.source_prompt_id, t.source_prompt_id) is not null then 'prompt'
                  else d.generated_from
                end
            from content_writing_tasks t
            where d.task_id = t.id
              and d.tenant_id = t.tenant_id
              and (
                d.source_prompt_id is null
                or d.source_prompt_text is null
                or d.generated_from = 'manual'
              )
            """
        )
        conn.execute("alter table geo_drift_schedules drop constraint if exists geo_drift_schedules_domain_key")
        conn.execute(
            """
            create unique index if not exists idx_geo_drift_schedules_tenant_domain
            on geo_drift_schedules(tenant_id, domain)
            """
        )
        conn.execute(
            """
            insert into app_users (tenant_id, username, name, email, password_hash, role, status, must_change_password)
            values (%s, 'admin', '管理员', 'admin@zggeo.local', encode(digest('admin123', 'sha256'), 'hex'), 'admin', 'active', true)
            on conflict (email) do nothing
            """,
            (tenant_id,),
        )
        for role, module, can_edit in [
            ("admin", "系统管理", True), ("admin", "内容生产", True), ("admin", "商业化", True),
            ("delivery", "内容生产", True), ("delivery", "分发执行", True), ("sales", "产品化报告", False),
            ("client", "产品化报告", False),
        ]:
            conn.execute(
                """
                insert into role_permissions (role, module, can_view, can_edit)
                values (%s, %s, true, %s)
                on conflict (role, module) do nothing
                """,
                (role, module, can_edit),
            )
