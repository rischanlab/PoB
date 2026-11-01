// Build a position-level reserve snapshot and Merkle tree from the real
// Franklin OnChain U.S. Government Money Fund (FOBXX) N-MFP3 holdings.
// Input:  data/input/franklin-fobxx/holdings.csv and fund.json
//         (from scripts/prepare-franklin-nmfp3.py).
// Output: positions.csv, tree.json and snapshot.json in the same folder.
// The holdings, values, maturities and liquidity flags are the fund's own
// reported data. The haircut schedule is a stated policy assumption.
import { readFile, writeFile } from "node:fs/promises";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const DIR = process.argv[2] ?? "data/input/franklin-fobxx";
const DECIMALS = 18n; // same unit as the controller tests (usd() = 18 decimals)
const BPS = 10_000n;

// Policy assumption: haircut by days to final legal maturity.
const HAIRCUT_SCHEDULE = [
  { maxDays: 7, bps: 0n },
  { maxDays: 90, bps: 10n },
  { maxDays: 397, bps: 25n },
  { maxDays: Infinity, bps: 50n },
];
const haircutFor = (days) => HAIRCUT_SCHEDULE.find((h) => days <= h.maxDays).bps;

function parseCsv(text) {
  const rows = [];
  let field = "", row = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// "1234.56" -> 1234.56 * 10^18 (exact).
function toUnits(value) {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 10n ** DECIMALS + BigInt(frac.padEnd(2, "0").slice(0, 2)) * 10n ** (DECIMALS - 2n);
}
const fmt = (units) => {
  const cents = units / 10n ** (DECIMALS - 2n);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

const holdings = parseCsv(await readFile(`${DIR}/holdings.csv`, "utf8"));
const fund = JSON.parse(await readFile(`${DIR}/fund.json`, "utf8"));

const positions = holdings.map((h) => {
  const market = toUnits(h.value_usd);
  const face = toUnits(h.principal_usd || h.value_usd);
  const days = Number(h.days_to_final);
  const receivable = h.identifier === "OTHER-ASSETS";
  const haircut = receivable ? BPS : haircutFor(days);
  const eligible = receivable ? 0n : (market * (BPS - haircut)) / BPS;
  // Liquid within the 7-day horizon = the fund's weekly-liquid-asset flag.
  const liquid = h.weekly_liquid === "Y" ? eligible : 0n;
  return {
    positionId: `FOBXX-${fund.reportDate}-${h.line.padStart(3, "0")}`,
    instrumentId: h.identifier,
    faceValue: face,
    marketValue: market,
    eligibleValue: eligible,
    liquidValue: liquid,
    maturityDays: BigInt(days),
    haircutBps: haircut,
    encumbered: false,
    legallyEligible: !receivable,
    settlementFinal: true,
  };
});

const leaf = (p) => [
  p.positionId, p.instrumentId, p.faceValue.toString(), p.marketValue.toString(),
  p.eligibleValue.toString(), p.liquidValue.toString(), p.maturityDays.toString(),
  p.haircutBps.toString(), p.encumbered, p.legallyEligible, p.settlementFinal,
];
const TYPES = ["string", "string", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bool", "bool", "bool"];
const tree = StandardMerkleTree.of(positions.map(leaf), TYPES);

const sum = (k) => positions.reduce((a, p) => a + p[k], 0n);
const shares = toUnits(Number(fund.numberOfSharesOutstanding).toFixed(2));
const other = toUnits(fund.totalValueLiabilities);
const gross = sum("marketValue");
const eligible = sum("eligibleValue");
const liquid = sum("liquidValue");
const liabilities = shares + other;
const bpsOf = (a, b) => Number((a * 1_000_000n) / b) / 10_000; // percent, 4 dp

const snapshot = {
  source: fund.source,
  series: fund.series,
  seriesId: fund.seriesId,
  reportDate: fund.reportDate,
  unit: "USD with 18 decimals",
  positionCount: positions.length,
  merkleRoot: tree.root,
  haircutSchedule: HAIRCUT_SCHEDULE.map((h) => ({ maxDays: h.maxDays === Infinity ? null : h.maxDays, bps: Number(h.bps) })),
  aggregates: {
    grossReserves: gross.toString(),
    eligibleReserves: eligible.toString(),
    liquidAssets: liquid.toString(),
    tokenLiabilities: shares.toString(),
    otherLiabilities: other.toString(),
    stressPendingRedemptions: toUnits(fund.max5BusinessDayGrossRedemptions).toString(),
  },
  usd: {
    grossReserves: fmt(gross),
    eligibleReserves: fmt(eligible),
    liquidAssets: fmt(liquid),
    tokenLiabilities: fmt(shares),
    otherLiabilities: fmt(other),
    stressPendingRedemptions: fund.max5BusinessDayGrossRedemptions,
    fundReportedWeeklyLiquidAssets: fund.totalValueWeeklyLiquidAssets,
    fundReportedNetAssets: fund.netAssetOfSeries,
  },
  ratiosPercent: {
    bcrAtMarketNoHaircut: bpsOf(gross - toUnits(fund.totalValueOtherAssets), liabilities),
    bcrAfterHaircut: bpsOf(eligible, liabilities),
    liquidShareOfTokenLiabilities: bpsOf(liquid, shares),
    rlcUnderStressRedemptions: bpsOf(liquid, toUnits(fund.max5BusinessDayGrossRedemptions)),
  },
};

const header = "position_id,instrument_id,face_value_usd,market_value_usd,eligible_value_usd,liquid_value_usd,maturity_days,haircut_bps,encumbered,legally_eligible,settlement_final";
const csv = [header, ...positions.map((p) => [p.positionId, p.instrumentId, fmt(p.faceValue), fmt(p.marketValue), fmt(p.eligibleValue), fmt(p.liquidValue), p.maturityDays, p.haircutBps, p.encumbered, p.legallyEligible, p.settlementFinal].join(","))].join("\n") + "\n";

await writeFile(`${DIR}/positions.csv`, csv);
await writeFile(`${DIR}/tree.json`, JSON.stringify(tree.dump(), null, 2) + "\n");
await writeFile(`${DIR}/snapshot.json`, JSON.stringify(snapshot, null, 2) + "\n");
console.log(JSON.stringify({ root: tree.root, usd: snapshot.usd, ratios: snapshot.ratiosPercent }, null, 2));
