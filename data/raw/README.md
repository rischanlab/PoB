@'
# Raw data

The original RWA.xyz Treasury market-cap dataset is not redistributed in this
repository.

To reproduce the processed USDY dataset:

1. Download the Treasury market-cap CSV from RWA.xyz.
2. Save it as:

   data/raw/rwa-xyz-treasury-market-caps.csv

3. Run:

   npm run prepare:usdy

The processed observations will be written to data/input/.
'@ | Set-Content -Encoding UTF8 data\raw\README.md