-- CivilStock 경제 서버 스키마 (Cloud SQL / Postgres)
--
-- 큰 수 규율: 금액·수량은 numeric으로 저장한다. node-postgres는 numeric을
-- JS **문자열**로 돌려주므로 앱의 exactAmount(정수 문자열) 규율과 그대로 맞물린다.
-- 모든 산술은 앱(순수 코어)에서 하고, DB는 저장·트랜잭션·불변식만 담당한다.

create table if not exists users (
  id text primary key,
  handle text unique,
  created_at timestamptz not null default now()
);

create table if not exists nations (
  id text primary key,
  name text not null,
  currency text not null,
  owner_user_id text references users(id),
  created_at timestamptz not null default now()
);

create table if not exists exchanges (
  id text primary key,
  nation_id text references nations(id),
  name text not null,
  listing_rules jsonb not null default '{}'
);

-- 증권 공통 헤더
create table if not exists securities (
  id text primary key,
  type text not null check (type in
    ('equity','bond','etf','adr','currency','commodity','option','future')),
  ticker text not null,
  issuer_user_id text references users(id),
  nation_id text references nations(id),
  exchange_id text references exchanges(id),
  currency text not null,
  status text not null default 'listed' check (status in ('listed','frozen','delisted')),
  created_at timestamptz not null default now()
);
create index if not exists securities_exchange_idx on securities(exchange_id);

-- 종류별 상세
create table if not exists equity_details (
  security_id text primary key references securities(id),
  shares_outstanding numeric not null default 0
);
create table if not exists bond_details (
  security_id text primary key references securities(id),
  face_value numeric not null,
  coupon_rate numeric not null,          -- 연율 백분율 (예: 5.25)
  maturity_tick bigint not null,
  coupon_interval_ticks bigint not null
);
create table if not exists etf_details (
  security_id text primary key references securities(id),
  constituents jsonb not null            -- [{securityId, unitsPerShare}]
);
create table if not exists adr_details (
  security_id text primary key references securities(id),
  underlying_security_id text references securities(id),
  ratio numeric not null,
  depositary_user_id text references users(id)
);
create table if not exists option_details (
  security_id text primary key references securities(id),
  underlying_security_id text references securities(id),
  kind text not null check (kind in ('call','put')),
  strike numeric not null,
  expiry_tick bigint not null,
  contract_size numeric not null,
  settlement text not null check (settlement in ('physical','cash'))
);

-- 원장: 현금(통화별) · 포지션(증권별). 서버 권위 유일 진실원본.
create table if not exists cash_ledger (
  user_id text references users(id),
  currency text not null,
  balance numeric not null default 0 check (balance >= 0),  -- 음수 국고 금지(공매도·마진은 별도 담보 계정)
  primary key (user_id, currency)
);
create table if not exists positions (
  user_id text references users(id),
  security_id text references securities(id),
  quantity numeric not null default 0,
  primary key (user_id, security_id)
);

-- 호가장(CLOB) · 체결 기록
create table if not exists orders (
  id text primary key,
  security_id text references securities(id),
  side text not null check (side in ('buy','sell')),
  owner_id text references users(id),
  limit_price numeric not null,
  quantity numeric not null,             -- 미체결 잔량
  ts bigint not null,
  status text not null default 'open' check (status in ('open','filled','cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists orders_book_idx on orders(security_id, side, status);

create table if not exists trades (
  id bigserial primary key,
  security_id text references securities(id),
  price numeric not null,
  quantity numeric not null,
  value numeric not null,
  buyer_id text references users(id),
  seller_id text references users(id),   -- AMM 체결이면 null
  source text not null check (source in ('clob','amm')),
  taker_side text not null check (taker_side in ('buy','sell')),
  tick bigint,
  created_at timestamptz not null default now()
);

-- AMM 유동성 풀 · LP 지분
create table if not exists amm_pools (
  security_id text primary key references securities(id),
  currency text not null,
  reserve_base numeric not null default 0,
  reserve_quote numeric not null default 0,
  total_shares numeric not null default 0,
  fee_bps int not null default 30
);
create table if not exists amm_lp_positions (
  security_id text references securities(id),
  user_id text references users(id),
  shares numeric not null default 0,
  primary key (security_id, user_id)
);

-- worldTick 멱등성: 처리한 틱은 한 번만.
create table if not exists tick_log (
  tick bigint primary key,
  processed_at timestamptz not null default now(),
  events jsonb
);

-- 세계 지도: 육각 타일(axial 좌표 q,r). 각 타일은 한 국가의 영토이거나 미점유.
create table if not exists territories (
  q int not null,
  r int not null,
  nation_id text references nations(id),
  claimed_at timestamptz not null default now(),
  primary key (q, r)
);
create index if not exists territories_nation_idx on territories(nation_id);

-- 세계 시계: 기원점(epoch)과 틱 간격. 서버가 경과 시간으로 현재 tick을 산출한다.
create table if not exists world (
  id int primary key default 1 check (id = 1),
  epoch_ms bigint not null,
  tick_seconds int not null default 3600,
  last_processed_tick bigint not null default 0
);
