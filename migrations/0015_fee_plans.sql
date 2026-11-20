-- 0015_fee_plans.sql
-- Adds the six-monthly (half-yearly) plan next to monthly / quarterly / term / one-time, so a
-- school can bill 2 installments a year without pretending it is a "term".
--
-- PostgreSQL allows ADD VALUE inside a transaction (12+) as long as the new value is not used in
-- the same transaction, which is why the seed/usage stays out of this file.

ALTER TYPE installment_plan ADD VALUE IF NOT EXISTS 'half_yearly' AFTER 'quarterly';
