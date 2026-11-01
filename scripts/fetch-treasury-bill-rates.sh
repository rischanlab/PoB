#!/usr/bin/env bash
# Download the U.S. Treasury Daily Treasury Bill Rates used by the real-data
# replay. With --compare, write to a temporary folder and diff against the
# committed files in data/raw/treasury/ instead of overwriting them.
set -euo pipefail
BASE="https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv"
OUT="data/raw/treasury"
COMPARE=0
[[ "${1:-}" == "--compare" ]] && COMPARE=1 && OUT="$(mktemp -d)"
mkdir -p "$OUT"
for year in 2023 2024 2025 2026; do
  curl -fsSL "$BASE/$year/all?type=daily_treasury_bill_rates&field_tdr_date_value=$year&page&_format=csv" \
    -o "$OUT/full-$year.csv"
done
python3 - "$OUT" "$COMPARE" <<'PY'
import csv, pathlib, sys
out, compare = pathlib.Path(sys.argv[1]), sys.argv[2] == "1"
windows = {
    "daily-treasury-bill-rates-2023-aug-dec.csv": ("2023", lambda m, d: m >= 8),
    "daily-treasury-bill-rates-2024.csv": ("2024", lambda m, d: True),
    "daily-treasury-bill-rates-2025.csv": ("2025", lambda m, d: True),
    "daily-treasury-bill-rates-2026-jan-jul.csv": ("2026", lambda m, d: m <= 7),
}
diffs = 0
for name, (year, keep) in windows.items():
    rows = list(csv.reader(open(out / f"full-{year}.csv")))
    header, body = rows[0], [r for r in rows[1:] if keep(int(r[0][:2]), int(r[0][3:5]))]
    if not compare:
        with open(out / name, "w", newline="") as f:
            csv.writer(f, quoting=csv.QUOTE_MINIMAL).writerows([header] + body)
        (out / f"full-{year}.csv").unlink()
        print(f"{name}: {len(body)} rows")
        continue
    mine = {r[0]: r for r in csv.reader(open(pathlib.Path("data/raw/treasury") / name))}
    theirs = {r[0]: dict(zip(header, r)) for r in body}
    my_header = next(csv.reader(open(pathlib.Path("data/raw/treasury") / name)))
    for date, official in theirs.items():
        local = dict(zip(my_header, mine.get(date, [])))
        for col, val in official.items():
            if col in local and local[col].strip() != val.strip():
                diffs += 1
                print(f"{name} {date} {col}: committed={local[col]} official={val}")
        if date not in mine:
            diffs += 1
            print(f"{name} {date}: missing from committed file")
if compare:
    print(f"cells differing from the official download: {diffs}")
    sys.exit(1 if diffs else 0)
PY
