# Raw data

## RWA.xyz (not redistributed)

The original RWA.xyz Treasury market-cap dataset is not redistributed in this
repository.

To reproduce the processed USDY dataset:

1. Download the Treasury market-cap CSV from RWA.xyz.
2. Save it as `data/raw/rwa-xyz-treasury-market-caps.csv`.
3. Run `npm run prepare:usdy`.

The processed observations are written to `data/input/`.

## U.S. Treasury Daily Treasury Bill Rates (committed)

`data/raw/treasury/` holds the U.S. Department of the Treasury *Daily Treasury
Bill Rates* (bank-discount and coupon-equivalent rates for 4- to 52-week
bills), 1 Aug 2023 to 31 Jul 2026. They are U.S. Government works in the
public domain and are committed so the real-data replay runs offline.

| File | Business days |
|---|---:|
| `daily-treasury-bill-rates-2023-aug-dec.csv` | 105 |
| `daily-treasury-bill-rates-2024.csv` | 250 |
| `daily-treasury-bill-rates-2025.csv` | 249 |
| `daily-treasury-bill-rates-2026-jan-jul.csv` | 146 |

Source: <https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_bill_rates>

Two checks:

- `npm run validate:treasury` tests every row against the Treasury's own
  identity between the bank-discount rate and the coupon-equivalent rate
  (750 rows, 4,114 checks, 0 mismatches at 0.02 percentage points).
- `npm run fetch:treasury -- --compare` downloads the official CSVs again and
  reports any cell that differs from the committed files.
