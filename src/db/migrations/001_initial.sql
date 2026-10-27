create extension if not exists pgcrypto;

create table payment_intents (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  owner_wallet text not null,
  source_token_account text not null,
  recipient_owner text not null,
  mint text not null,
  decimals integer not null check (decimals between 0 and 18),
  amount_minor numeric(39, 0) not null check (amount_minor > 0),
  reference text not null unique,
  status text not null check (status in ('active', 'cancelled', 'completed')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index payment_intents_user_idx on payment_intents(user_id);

create table sponsored_transactions (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id uuid not null references payment_intents(id),
  attempt_number integer not null check (attempt_number > 0),
  canonical_message_hash text not null,
  policy_snapshot jsonb not null,
  recent_blockhash text not null,
  last_valid_block_height bigint not null,
  status text not null check (status in (
    'constructed', 'user_signed', 'validated', 'sponsor_signed', 'submitted', 'rejected', 'expired'
  )),
  estimated_fee_lamports bigint not null check (estimated_fee_lamports >= 0),
  signed_payload_hash text unique,
  signature text unique,
  rejection_code text,
  submission_error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now(),
  submitted_at timestamptz,
  unique(payment_intent_id, attempt_number)
);

create index sponsored_transactions_status_idx on sponsored_transactions(status);

create table sponsorship_users (
  user_id text primary key,
  created_at timestamptz not null default now()
);

create table sponsorship_usage (
  id uuid primary key default gen_random_uuid(),
  sponsored_transaction_id uuid not null unique references sponsored_transactions(id),
  user_id text not null references sponsorship_users(user_id),
  fee_lamports bigint not null check (fee_lamports >= 0),
  usage_date date not null default current_date,
  created_at timestamptz not null default now()
);

create index sponsorship_usage_user_date_idx on sponsorship_usage(user_id, usage_date);
create index sponsorship_usage_date_idx on sponsorship_usage(usage_date);

create table sponsorship_budget_state (
  singleton boolean primary key default true check (singleton)
);

insert into sponsorship_budget_state default values;

create table sponsorship_audit_events (
  id uuid primary key default gen_random_uuid(),
  sponsored_transaction_id uuid references sponsored_transactions(id),
  user_id text,
  event_type text not null,
  code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index sponsorship_audit_created_idx on sponsorship_audit_events(created_at);

create function prevent_usage_mutation() returns trigger as $$
begin
  raise exception 'Sponsorship usage is immutable';
end;
$$ language plpgsql;

create trigger sponsorship_usage_immutable
before update or delete on sponsorship_usage
for each row execute function prevent_usage_mutation();
