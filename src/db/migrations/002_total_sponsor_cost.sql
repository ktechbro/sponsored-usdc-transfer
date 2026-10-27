alter table sponsored_transactions rename column estimated_fee_lamports to estimated_cost_lamports;
alter table sponsorship_usage rename column fee_lamports to cost_lamports;
