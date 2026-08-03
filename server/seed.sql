-- 스모크 테스트용 최소 시드 데이터.
-- schema.sql 적용 후 실행하면 /orders·/tick을 바로 돌려볼 수 있다.

insert into users (id, handle) values ('u_alice', 'alice'), ('u_bob', 'bob')
  on conflict (id) do nothing;

insert into nations (id, name, currency, owner_user_id)
  values ('n1', 'Testland', 'USD', 'u_alice') on conflict (id) do nothing;

insert into exchanges (id, nation_id, name)
  values ('ex1', 'n1', 'Test Exchange') on conflict (id) do nothing;

-- 유저 alice가 발행한 주식 ACME (상장).
insert into securities (id, type, ticker, issuer_user_id, nation_id, exchange_id, currency, status)
  values ('sec_acme', 'equity', 'ACME', 'u_alice', 'n1', 'ex1', 'USD', 'listed')
  on conflict (id) do nothing;
insert into equity_details (security_id, shares_outstanding)
  values ('sec_acme', '1000000') on conflict (security_id) do nothing;

-- AMM 풀: 현물가 100(=$1.00) — base 1000, quote 100000.
insert into amm_pools (security_id, currency, reserve_base, reserve_quote, total_shares, fee_bps)
  values ('sec_acme', 'USD', '1000', '100000', '1000', 30)
  on conflict (security_id) do nothing;

-- bob은 매수용 현금 $1,000,000, alice는 매도용 포지션 보유.
insert into cash_ledger (user_id, currency, balance)
  values ('u_bob', 'USD', '100000000') on conflict (user_id, currency) do nothing;
insert into positions (user_id, security_id, quantity)
  values ('u_alice', 'sec_acme', '1000000') on conflict (user_id, security_id) do nothing;
