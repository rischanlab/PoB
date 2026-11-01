"""Integrity check for U.S. Treasury Daily Bill Rates CSVs.

For bills of 26 weeks or less, Treasury's coupon-equivalent (CE) yield is a
deterministic function of the bank-discount (BD) rate d and days to maturity t:
    CE = Y * d / (360 - d * t)
where Y = 366 if the period from the rate date to maturity contains 29 February,
otherwise 365 (Treasury's leap-year convention). For the 52-week bill
(t = 364 > half a year) Treasury uses the semi-annual compounding formula:
    P = 1 - d*t/360,  a = t/(2Y) - 0.25,  b = t/Y,  c = (P - 1)/P,
    CE = (-b + sqrt(b^2 - 4ac)) / (2a).
Each row's published CE must match the CE recomputed from its BD within
rounding (0.02 percentage points). A transcription error in either column, or
a column shift, breaks the identity. Usage: python3 validate-treasury-bill-rates.py FILE...
"""
import csv, math, sys
from datetime import date, timedelta
DAYS = {"4 WEEKS": 28, "6 WEEKS": 42, "8 WEEKS": 56, "13 WEEKS": 91, "17 WEEKS": 119, "26 WEEKS": 182, "52 WEEKS": 364}
bad = 0; checked = 0; rows = 0
for path in sys.argv[1:]:
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows += 1
            for tenor, t in DAYS.items():
                bd = row.get(f"{tenor} BANK DISCOUNT"); ce = row.get(f"{tenor} COUPON EQUIVALENT")
                if not bd or not ce or bd == "N/A" or ce == "N/A":
                    continue
                d = float(bd) / 100
                m, dd, yy = map(int, row["Date"].split("/"))
                start = date(yy, m, dd); end = start + timedelta(days=t)
                year_days = 365
                for y in range(start.year, end.year + 1):
                    try:
                        feb29 = date(y, 2, 29)
                    except ValueError:
                        continue
                    if start < feb29 <= end:
                        year_days = 366
                def ce_of(Y):
                    if t <= 182:
                        return 100 * Y * d / (360 - d * t)
                    P = 1 - d * t / 360
                    a = t / (2 * Y) - 0.25
                    b = t / Y
                    c = (P - 1) / P
                    return 100 * (-b + math.sqrt(b * b - 4 * a * c)) / (2 * a)
                calc = ce_of(year_days)
                # Within a week of the leap-day boundary the exact settlement
                # date decides 365 vs 366, so accept either convention there.
                alt = ce_of(731 - year_days)
                near_boundary = any(
                    abs((date(y, 2, 28) - x).days) <= 7
                    for y in range(start.year, end.year + 1) if y % 4 == 0
                    for x in (start, end)
                )
                checked += 1
                ok = abs(calc - float(ce)) <= 0.02 or (near_boundary and abs(alt - float(ce)) <= 0.02)
                if not ok:
                    bad += 1
                    print(f"MISMATCH {path} {row['Date']} {tenor}: BD={bd} CE={ce} recomputed={calc:.3f}")
print(f"rows={rows} checks={checked} mismatches={bad}")
sys.exit(1 if bad else 0)
