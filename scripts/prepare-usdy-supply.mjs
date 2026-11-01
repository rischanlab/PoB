// Derive USDY's observed token supply from two RWA.xyz series (review P1, P4).
//
// RWA.xyz defines Bridged Token Value (Dollar) as Bridged Token Supply x NAV,
// with NAV issuer-reported. Dividing the summed value by the same day's NAV
// therefore recovers the bridged token supply. Early observations, where the
// published NAV has four decimals, give a supply that is constant to 1e-6
// tokens across days with no supply change, which shows that RWA.xyz
// multiplied by the same rounded NAV.
//
// Usage: node scripts/prepare-usdy-supply.mjs
// Inputs:  data/input/usdy-observed-token-value.csv (prepare:usdy)
//          data/raw/rwa-xyz-usdy-net-asset-value-2026-11-01.csv
// Output:  data/input/usdy-observed-supply.csv (date, value, NAV, supply)
import { readFile, writeFile } from "node:fs/promises";

const value = (await readFile("data/input/usdy-observed-token-value.csv", "utf8")).trim().split("\n");
const vh = value[0].split(",");
const iD = vh.indexOf("date"), iV = vh.indexOf("observed_token_value_usd");
const navRows = (await readFile("data/raw/rwa-xyz-usdy-net-asset-value-2026-11-01.csv", "utf8")).trim().split("\n");
const nh = navRows[0].split(",");
const jD = nh.indexOf("Date"), jM = nh.indexOf("Measure");
const jN = nh.findIndex((h) => h.startsWith("Ondo U.S. Dollar Yield"));
const nav = new Map();
for (const line of navRows.slice(1)) {
  const c = line.split(",");
  if (c[jM] !== "Net Asset Value (Dollar)") throw new Error(`unexpected measure ${c[jM]}`);
  nav.set(c[jD], c[jN]);
}
const out = ["date,observed_token_value_usd,nav_usd,observed_token_supply"];
for (const line of value.slice(1)) {
  const c = line.split(",");
  const n = nav.get(c[iD]);
  if (!n) throw new Error(`no NAV for ${c[iD]}`);
  out.push([c[iD], c[iV], n, (Number(c[iV]) / Number(n)).toFixed(6)].join(","));
}
await writeFile("data/input/usdy-observed-supply.csv", out.join("\n") + "\n");
console.log(`wrote ${out.length - 1} rows to data/input/usdy-observed-supply.csv`);
