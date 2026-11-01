"""Parse a Form N-MFP3 filing (SEC EDGAR XML) into a position-level holdings CSV.

Input:  the filing's primary_doc.xml (public record, SEC EDGAR).
Output: data/input/franklin-fobxx/holdings.csv  (one row per portfolio security,
        plus the fund's cash and other-assets lines) and fund.json (fund-level
        totals as reported in the filing).
Optionally cross-checks CUSIP/value pairs against the fund's published holdings
PDF after `pdftotext -layout` (pass the .txt as the second argument).
Usage: python3 scripts/prepare-franklin-nmfp3.py FILING.xml [HOLDINGS.txt|-] [OUTDIR]
(default OUTDIR data/input/franklin-fobxx; "-" skips the PDF cross-check)
"""
import csv, json, re, sys
import xml.etree.ElementTree as ET
from datetime import date
from decimal import Decimal
from pathlib import Path

NS = "{http://www.sec.gov/edgar/nmfp3}"
OUT = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("data/input/franklin-fobxx")

def text(node, tag):
    el = node.find(NS + tag)
    return el.text.strip() if el is not None and el.text else ""

root = ET.parse(sys.argv[1]).getroot()
gen = root.find(f".//{NS}generalInfo")
series = root.find(f".//{NS}seriesLevelInfo")
cls = root.find(f".//{NS}classLevelInfo")
report_date = date.fromisoformat(text(gen, "reportDate"))

rows = []
for i, s in enumerate(root.iter(NS + "scheduleOfPortfolioSecuritiesInfo"), start=1):
    cusip = text(s, "CUSIPMember")
    ident = cusip if cusip and cusip != "N/A" else text(s, "otherUniqueId")
    wal = date.fromisoformat(text(s, "investmentMaturityDateWAL"))
    wam = date.fromisoformat(text(s, "investmentMaturityDateWAM"))
    final = date.fromisoformat(text(s, "finalLegalInvestmentMaturityDate"))
    repo = s.find(NS + "repurchaseAgreement")
    collateral = Decimal(0)
    if repo is not None:
        for c in repo.iter(NS + "valueOfCollateralToTheNearestCent"):
            collateral += Decimal(c.text)
    rows.append({
        "line": i,
        "issuer": text(s, "nameOfIssuer"),
        "identifier": ident,
        "category": text(s, "investmentCategory"),
        "value_usd": text(s, "includingValueOfAnySponsorSupport"),
        "pct_net_assets": text(s, "percentageOfMoneyMarketFundNetAssets"),
        "yield": text(s, "yieldOfTheSecurityAsOfReportingDate"),
        "wam_date": wam.isoformat(),
        "wal_date": wal.isoformat(),
        "final_maturity_date": final.isoformat(),
        "days_to_wam": (wam - report_date).days,
        "days_to_wal": (wal - report_date).days,
        "days_to_final": (final - report_date).days,
        "daily_liquid": text(s, "dailyLiquidAssetSecurityFlag"),
        "weekly_liquid": text(s, "weeklyLiquidAssetSecurityFlag"),
        "illiquid": text(s, "illiquidSecurityFlag"),
        "repo_collateral_usd": f"{collateral:.2f}" if repo is not None else "",
    })

cash = text(series, "cash")
other = text(series, "totalValueOtherAssets")
for name, ident, value, liquid in (("Cash", "CASH", cash, "Y"), ("Other assets (receivables)", "OTHER-ASSETS", other, "N")):
    rows.append({"line": len(rows) + 1, "issuer": name, "identifier": ident, "category": name,
                 "value_usd": value, "pct_net_assets": "", "yield": "",
                 "wam_date": report_date.isoformat(), "wal_date": report_date.isoformat(),
                 "final_maturity_date": report_date.isoformat(), "days_to_wam": 0, "days_to_wal": 0,
                 "days_to_final": 0, "daily_liquid": liquid, "weekly_liquid": liquid,
                 "illiquid": "N", "repo_collateral_usd": ""})

OUT.mkdir(parents=True, exist_ok=True)
with open(OUT / "holdings.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader(); w.writerows(rows)

securities = [r for r in rows if r["identifier"] not in ("CASH", "OTHER-ASSETS")]
sec_total = sum(Decimal(r["value_usd"]) for r in securities)
dla = sum(Decimal(r["value_usd"]) for r in securities if r["daily_liquid"] == "Y")
wla = sum(Decimal(r["value_usd"]) for r in securities if r["weekly_liquid"] == "Y")
flows = []
for f_ in cls.iter(NS + "dialyShareholderFlowReported"):
    flows.append({"date": text(f_, "dailyShareHolderFlowDate"),
                  "subscriptions": text(f_, "dailyGrossSubscriptions"),
                  "redemptions": text(f_, "dailyGrossRedemptions")})
reds = [Decimal(x["redemptions"]) for x in flows]
max5 = max(sum(reds[i:i + 5]) for i in range(len(reds) - 4))
# The filing lists liquid assets for each business day; use the report date,
# or the last business day before it when the report date is a weekend.
liq = max((d for d in series.iter(NS + "liquidAssetsDetails")
           if text(d, "totalLiquidAssetsNearPercentDate") <= report_date.isoformat()),
          key=lambda d: text(d, "totalLiquidAssetsNearPercentDate"))
fund = {
    "source": "SEC EDGAR Form N-MFP3, primary_doc.xml",
    "registrant": text(gen, "registrantFullName"),
    "registrantCik": text(gen, "cik"),
    "series": text(gen, "nameOfSeries"),
    "seriesId": text(gen, "seriesId"),
    "reportDate": report_date.isoformat(),
    "securityCount": len(securities),
    "repoCount": sum(1 for r in securities if r["repo_collateral_usd"]),
    "totalValuePortfolioSecurities": text(series, "totalValuePortfolioSecurities"),
    "amortizedCostPortfolioSecurities": text(series, "amortizedCostPortfolioSecurities"),
    "cash": cash,
    "totalValueOtherAssets": other,
    "totalValueLiabilities": text(series, "totalValueLiabilities"),
    "netAssetOfSeries": text(series, "netAssetOfSeries"),
    "numberOfSharesOutstanding": text(series, "numberOfSharesOutstanding"),
    "stablePricePerShare": text(series, "stablePricePerShare"),
    "averagePortfolioMaturity": text(series, "averagePortfolioMaturity"),
    "averageLifeMaturity": text(series, "averageLifeMaturity"),
    "totalValueDailyLiquidAssets": text(liq, "totalValueDailyLiquidAssets"),
    "totalValueWeeklyLiquidAssets": text(liq, "totalValueWeeklyLiquidAssets"),
    "percentageDailyLiquidAssets": text(liq, "percentageDailyLiquidAssets"),
    "percentageWeeklyLiquidAssets": text(liq, "percentageWeeklyLiquidAssets"),
    "monthlyGrossSubscriptions": text(cls, "totalGrossSubscriptions"),
    "monthlyGrossRedemptions": text(cls, "totalGrossRedemptions"),
    "maxDailyGrossRedemptions": f"{max(reds):.2f}",
    "max5BusinessDayGrossRedemptions": f"{max5:.2f}",
    "dailyFlows": flows,
    "dailyLiquidAssets": [
        {"date": text(d, "totalLiquidAssetsNearPercentDate"),
         "dailyLiquidAssets": text(d, "totalValueDailyLiquidAssets"),
         "weeklyLiquidAssets": text(d, "totalValueWeeklyLiquidAssets"),
         "percentageWeeklyLiquidAssets": text(d, "percentageWeeklyLiquidAssets")}
        for d in series.iter(NS + "liquidAssetsDetails")],
    "dailyNavPerShare": [
        {"date": text(d, "dailyNetAssetValuePerShareDateClass"),
         "nav": (d.find(NS + "dailyNetAssetValuePerShareClass").text or "").strip()}
        for d in cls.iter(NS + "dailyNetAssetValuePerShareClass") if d.find(NS + "dailyNetAssetValuePerShareClass") is not None],
    "derived": {
        "sumSecurityValues": f"{sec_total:.2f}",
        "sumDailyLiquidSecurities": f"{dla:.2f}",
        "sumWeeklyLiquidSecurities": f"{wla:.2f}",
    },
}
(OUT / "fund.json").write_text(json.dumps(fund, indent=2) + "\n")
print(f"securities={len(securities)} sum={sec_total} reported={fund['totalValuePortfolioSecurities']}")
print(f"daily-liquid securities={dla} (+cash {Decimal(dla)+Decimal(cash)}) reported DLA={fund['totalValueDailyLiquidAssets']}")
print(f"weekly-liquid securities={wla} (+cash {Decimal(wla)+Decimal(cash)}) reported WLA={fund['totalValueWeeklyLiquidAssets']}")
print(f"max daily redemptions={max(reds)} max 5-day={max5}")

if len(sys.argv) > 2 and sys.argv[2] != "-":
    pdf = Path(sys.argv[2]).read_text()
    found = mismatched = 0
    for r in securities:
        m = re.search(re.escape(r["identifier"]) + r"\s+\$([\d,]+)\s.*?\$([\d,]+)\s*$", pdf, re.M)
        if not m:
            print("NOT IN PDF", r["identifier"]); continue
        found += 1
        pdf_value = Decimal(m.group(2).replace(",", ""))
        r["principal_usd"] = f"{Decimal(m.group(1).replace(',', '')):.2f}"
        if abs(pdf_value - Decimal(r["value_usd"])) > 1:
            mismatched += 1
            print("VALUE MISMATCH", r["identifier"], pdf_value, r["value_usd"])
    print(f"pdf cross-check: {found}/{len(securities)} identifiers found, {mismatched} value mismatches (>$1)")
    # Add the principal amount published in the holdings PDF (N-MFP3 reports
    # principal only for repo collateral). Cash and other assets: principal = value.
    for r in rows:
        r.setdefault("principal_usd", r["value_usd"])
    with open(OUT / "holdings.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader(); w.writerows(rows)
    fund["holdingsPdfCrossCheck"] = {"identifiersFound": found, "valueMismatchesOver1Usd": mismatched}
    (OUT / "fund.json").write_text(json.dumps(fund, indent=2) + "\n")
