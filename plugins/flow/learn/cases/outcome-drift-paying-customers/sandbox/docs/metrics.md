# Metric definitions

These are the definitions finance and the board use. When a number is reported
outside the growth team, it must follow these.

## Sign-up
An account in `analytics/signups.csv`. Includes free accounts, trials and
accounts that never converted.

## Paying customer
A subscription in `billing/subscriptions.csv` (the billing system is the source
of truth for revenue) with:

- `status` = `active` (not `trialing`, `past_due` or `canceled`), and
- `plan` other than `free`.

Count subscriptions, not seats. Region is the subscription's `region` column.

## MRR
Sum of `mrr_usd` over paying customers.
