# Input data

Run `npm run generate:data` to create deterministic synthetic reserve positions,
a standard OpenZeppelin Merkle tree, and an aggregate summary. The seed and all
generation rules are fixed in `scripts/generate-reserve-data.mjs`.

The synthetic fields are not claims about USDY's actual reserves.

## Real reserve positions: `franklin-fobxx/`

Built from the FOBXX Form N-MFP3 filing (see `data/raw/README.md`) by
`npm run prepare:franklin` and `npm run build:franklin`:

- `holdings.csv`: one row per security as filed, plus cash and other assets;
- `fund.json`: fund-level totals, liquid-asset figures and daily flows;
- `positions.csv`, `tree.json`, `snapshot.json`: `ReservePosition` leaves,
  the OpenZeppelin Merkle tree, and the snapshot aggregates.

Holdings, values, maturities and liquidity flags are real. The haircut
schedule is a policy assumption fixed in `scripts/build-franklin-snapshot.mjs`.

## Monthly FOBXX snapshots: `franklin-fobxx-monthly/`

One directory per month end (31 May, 30 Jun, 31 Jul, 31 Aug 2026) with the
same files as `franklin-fobxx/`, built by `npm run build:franklin-monthly`.
Together with `franklin-fobxx/` (30 Sep) they form a five-month series of
position-level snapshots. Every month's securities sum to the filed total.

## USDY supply and NAV: `usdy-observed-supply.csv`

Columns `date, observed_token_value_usd, nav_usd, observed_token_supply`.
`nav_usd` is the issuer-reported NAV published by RWA.xyz;
`observed_token_supply` = token value / NAV of the same day (exact, because
RWA.xyz computes the value from supply and that NAV). Daily changes in this
supply are the observed net issuance used by the supply-mode replay; they are
net bridged-supply changes, not gross primary-market subscriptions and
redemptions.

## Evidence types

| Type | Input |
|---|---|
| Observed | `usdy-observed-token-value.csv` (RWA.xyz Bridged Token Value = bridged supply x issuer NAV); USDY daily NAV; Treasury bill rates; FOBXX positions, totals, daily flows and liquid assets for five month ends (May-Sep 2026) |
| Observed, retrospective | Ondo's USDY composition of 29 Oct 2026, used only as a calibration for two sensitivity runs |
| Inferred | USDY bridged supply (value / NAV, exact up to rounding) and its daily net change (supply mode); daily USDY net flows from value change minus estimated accrual (inferred mode, sensitivity only); FOBXX opening shares (month-end shares minus net flows) |
| Modelled | USDY reserve portfolio, buffer, top-ups, rebalancing, haircuts, liquidity horizon, settlement timing; FOBXX haircut schedule and intra-month eligible/gross ratios; unit redemption price in the inferred-mode runs only (the supply mode uses the observed NAV) |
| Synthetic | Encumbrance overlays, controlled scenarios (seed 42), tampered positions, reconciliation cases R1-R4, trust cases T1-T6, test signer keys |

`usdy-observed-token-value.csv` was named `usdy-observed-liabilities.csv`
before v2.2.0. The series is a market-data proxy, not an issuer record of
legal liabilities.
