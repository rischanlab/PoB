// Off-chain aggregate reconciliation of a signed reserve snapshot against its
// committed position file (review point 2).
//
// The controller verifies Merkle membership of one leaf at a time and checks
// rules inside that leaf. It does NOT check that the leaves add up to the
// signed aggregates, or that the position file is complete. This script does
// the first check for anyone holding the position file, and the second check
// against an external record (here the fund's N-MFP3 totals).
//
// Usage: node scripts/reconcile-snapshot.mjs [tree.json] [snapshot.json] [fund.json]
import { readFile } from "node:fs/promises";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const UNIT = 10n ** 16n; // 18-decimal USD -> cents

/** Sum gross (market), eligible, and liquid values over Merkle leaves. */
export function sumLeaves(leaves) {
  const t = { grossReserves: 0n, eligibleReserves: 0n, liquidAssets: 0n, count: 0 };
  for (const l of leaves) {
    t.grossReserves += BigInt(l[3]);
    t.eligibleReserves += BigInt(l[4]);
    t.liquidAssets += BigInt(l[5]);
    t.count += 1;
  }
  return t;
}

/**
 * Compare leaf totals with signed aggregates (exact), and optionally with an
 * external completeness reference (gross = securities + cash + other assets
 * as filed). Returns a list of findings; an empty list means reconciled.
 */
export function reconcile(leaves, aggregates, external) {
  const s = sumLeaves(leaves);
  const findings = [];
  for (const k of ["grossReserves", "eligibleReserves", "liquidAssets"]) {
    const signed = BigInt(aggregates[k]);
    if (signed !== s[k]) findings.push({ check: "leaves-vs-signed", field: k, signed, fromLeaves: s[k], difference: signed - s[k] });
  }
  if (external) {
    const filed = BigInt(external.grossReserves);
    if (filed !== s.grossReserves) findings.push({ check: "leaves-vs-external", field: "grossReserves", external: filed, fromLeaves: s.grossReserves, difference: s.grossReserves - filed });
    if (external.positionCount !== undefined && external.positionCount !== s.count)
      findings.push({ check: "leaves-vs-external", field: "positionCount", external: external.positionCount, fromLeaves: s.count });
  }
  return { totals: s, findings };
}

/** External reference from fund.json: securities + cash + other assets. */
export function externalFromFund(fund) {
  const toUnits = (v) => BigInt(Math.round(Number(v) * 100)) * UNIT;
  return {
    grossReserves: toUnits(fund.totalValuePortfolioSecurities) + toUnits(fund.cash) + toUnits(fund.totalValueOtherAssets),
    positionCount: fund.securityCount + 2,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = "data/input/franklin-fobxx";
  const [treePath = `${dir}/tree.json`, snapPath = `${dir}/snapshot.json`, fundPath = `${dir}/fund.json`] = process.argv.slice(2);
  const tree = StandardMerkleTree.load(JSON.parse(await readFile(treePath, "utf8")));
  const snap = JSON.parse(await readFile(snapPath, "utf8"));
  const fund = JSON.parse(await readFile(fundPath, "utf8"));
  const leaves = [...tree.entries()].map(([, v]) => v);
  const { totals, findings } = reconcile(leaves, snap.aggregates, externalFromFund(fund));
  const usd = (v) => (Number(v / UNIT) / 100).toFixed(2);
  console.log(`root ${tree.root}  leaves ${totals.count}`);
  console.log(`leaf totals: gross ${usd(totals.grossReserves)}  eligible ${usd(totals.eligibleReserves)}  liquid ${usd(totals.liquidAssets)}`);
  console.log(findings.length ? findings : "reconciled: leaves = signed aggregates; gross = filed securities + cash + other assets");
  process.exit(findings.length ? 1 : 0);
}
