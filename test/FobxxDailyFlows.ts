/**
 * FOBXX September 2026: disclosed daily fund flows on ONE persistent
 * controller (review points 7 and 8).
 *
 * Observed (Form N-MFP3, 30 Sep 2026): daily gross subscriptions and
 * redemptions for the 21 business days of September; daily weekly-liquid
 * assets as reported by the fund; NAV per share 1.0000 every day; shares
 * outstanding at month end.
 * Derived: shares outstanding at the start of each day, back-calculated from
 * month-end shares and the disclosed flows (stable 1.0000 NAV).
 * Modelled: eligible and gross reserves held at the 30 Sep position-level
 * coverage ratios (only month-end positions are filed); other liabilities
 * held at the month-end value; same-day (T+0) settlement.
 *
 * Every snapshot, receipt-backed mint, redemption request, and settlement is
 * executed on the same deployment; each new snapshot must pass the
 * controller's liability-continuity check against the previous epoch.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { keccak256, toBytes, type Hex } from "viem";

import { POLICY_HASH, WAD, makeSnapshot, signSnapshot, signSubscriptionReceipt } from "./helpers.js";

const { viem, networkHelpers } = await hre.network.create();
const DIR = "data/input/franklin-fobxx";
const ROLE_NAMES = ["CUSTODIAN_ROLE", "ADMINISTRATOR_ROLE", "VALUATION_ROLE", "LEGAL_ROLE", "VERIFIER_ROLE", "SETTLEMENT_ROLE", "TOKEN_ROLE"];
const cents = (v: string) => BigInt(Math.round(Number(v) * 100)) * 10n ** 16n;
const pct = (w: bigint) => (Number((w * 1_000_000n) / WAD) / 10_000).toFixed(2);
const m = (w: bigint) => (Number(w / 10n ** 16n) / 1e8).toFixed(2); // USD millions

const fund = JSON.parse(await readFile(`${DIR}/fund.json`, "utf8"));
const snap30 = JSON.parse(await readFile(`${DIR}/snapshot.json`, "utf8"));
const A = snap30.aggregates;

async function run(thetaS: bigint) {
  const wallets = await viem.getWalletClients();
  const [admin, custodian, administrator, valuation, legal, verifier, holder] = wallets;
  const signers = [custodian, administrator, valuation, legal, verifier];
  const c = (await viem.deployContract("PoBPolicyController", [POLICY_HASH, thetaS, WAD, 5n * 86_400n])) as any;
  const holders = [custodian, administrator, valuation, legal, verifier, admin, admin];
  for (const [i, r] of ROLE_NAMES.entries()) await c.write.grantRole([keccak256(toBytes(r)), holders[i].account.address], { account: admin.account });
  const client = await viem.getPublicClient();
  const chainId = await client.getChainId();
  const as = { account: admin.account };

  const flows = fund.dailyFlows as Array<{ date: string; subscriptions: string; redemptions: string }>;
  const liq = new Map((fund.dailyLiquidAssets as any[]).map((d) => [d.date, cents(d.weeklyLiquidAssets)]));
  const other = BigInt(A.otherLiabilities);
  const liab30 = BigInt(A.tokenLiabilities) + other;
  const eRatio = (BigInt(A.eligibleReserves) * WAD) / liab30;
  const gRatio = (BigInt(A.grossReserves) * WAD) / liab30;
  // Opening shares on 1 Sep = month-end shares minus September net flows.
  const net = flows.reduce((s, f) => s + cents(f.subscriptions) - cents(f.redemptions), 0n);
  const opening = BigInt(A.tokenLiabilities) - net;

  const rows: string[] = [];
  let mintsAccepted = 0, mintsRejected = 0, queued = 0, epochs = 0, continuityChecks = 0;
  let minRlc = Infinity, rejectedUsd = 0n;
  let prevDate = flows[0].date;
  for (const [d, f] of flows.entries()) {
    const gap = (Date.parse(f.date) - Date.parse(prevDate)) / 86_400_000;
    if (gap > 0) await networkHelpers.time.increase(gap * 86_400);
    prevDate = f.date;
    // Snapshot at the open: liabilities from the controller (continuity), the
    // previous close's reported weekly liquid assets, modelled reserves.
    const token = d === 0 ? opening : await c.read.currentTokenLiabilities();
    const pending = d === 0 ? 0n : await c.read.currentPendingRedemptions();
    const total = token + pending + other;
    const eligible = (total * eRatio) / WAD;
    const gross = (total * gRatio) / WAD;
    const prevLiquid = liq.get(d === 0 ? f.date : flows[d - 1].date)!;
    const liquid = prevLiquid < eligible ? prevLiquid : eligible;
    const now = (await client.getBlock()).timestamp;
    const s = makeSnapshot(now, {
      epoch: BigInt(d + 1), validUntil: now + 5n * 86_400n,
      reserveRoot: d === 0 ? (snap30.merkleRoot as Hex) : keccak256(toBytes(`fobxx-${f.date}`)),
      grossReserves: gross, eligibleReserves: eligible, liquidAssets: liquid,
      tokenLiabilities: token, pendingRedemptions: pending, otherLiabilities: other,
    });
    await c.write.submitSnapshot([s, await signSnapshot(signers, chainId, c.address, s)], as);
    epochs++; if (d > 0) continuityChecks++;
    const bcrOpen = await c.read.currentBCR();

    // Subscriptions: one custodian receipt for the day's gross subscriptions.
    const sub = cents(f.subscriptions);
    let accepted = false;
    if (sub > 0n) {
      if (await c.read.canMintWithReceipt([sub, sub])) {
        const sig = await signSubscriptionReceipt(custodian, chainId, c.address, { epoch: s.epoch, amount: sub, nonce: BigInt(d) });
        await c.write.authorizeMintWithReceipt([sub, sub, BigInt(d), sig], as);
        mintsAccepted++; accepted = true;
      } else { mintsRejected++; rejectedUsd += sub; }
    }
    // Redemptions: one request for the day's gross redemptions, settled T+0.
    const red = cents(f.redemptions);
    let disposition = "";
    if (red > 0n) {
      const rlcAfter = ((await c.read.currentLiquidAssets()) * WAD) / ((await c.read.currentPendingRedemptions()) + red);
      minRlc = Math.min(minRlc, Number(rlcAfter / 10n ** 12n) / 1e6);
      await c.write.requestRedemption([holder.account.address, red], as);
      const id = (await c.read.nextRedemptionId()) - 1n;
      disposition = Number((await c.read.redemptions([id]))[3]) === 0 ? "instant" : "queued";
      if (disposition === "queued") queued++;
      await c.write.confirmSettlement([id, red], as);
    }
    rows.push([f.date, m(token), m(sub), accepted ? "accepted" : sub > 0n ? "rejected" : "", m(red), disposition, m(prevLiquid), pct(bcrOpen), pct(await c.read.currentBCR())].join(","));
  }
  const closing = await c.read.currentTokenLiabilities();
  return { rows, mintsAccepted, mintsRejected, rejectedUsd, queued, epochs, continuityChecks, minRlc, closing, opening };
}

describe("FOBXX September 2026 daily flows on a persistent controller", function () {
  it("runs 21 business days of disclosed flows through one deployment", async function () {
    const summary: string[] = [];
    let dailyRows: string[] = [];
    for (const [label, thetaS] of [["99.5%", (995n * WAD) / 1000n], ["100%", WAD]] as const) {
      const r = await run(thetaS);
      assert.equal(r.epochs, 21);
      assert.equal(r.continuityChecks, 20);
      if (label === "99.5%") {
        // All subscriptions accepted, so the controller's closing token
        // liabilities equal the filed month-end shares (by construction of
        // the opening balance; checks that every flow was booked once).
        assert.equal(r.mintsRejected, 0);
        const diff = r.closing > BigInt(A.tokenLiabilities) ? r.closing - BigInt(A.tokenLiabilities) : BigInt(A.tokenLiabilities) - r.closing;
        assert.ok(diff < 10n ** 16n);
        dailyRows = r.rows;
      } else {
        assert.equal(r.mintsAccepted, 0);
      }
      summary.push([label, r.epochs, r.continuityChecks, r.mintsAccepted, r.mintsRejected, m(r.rejectedUsd), r.queued, (r.minRlc * 100).toFixed(2), m(r.opening), m(r.closing)].join(","));
    }
    await writeFile("data/results/fobxx-daily-replay.csv", "date,token_liabilities_open_usd_m,subscriptions_usd_m,mint,redemptions_usd_m,redemption,weekly_liquid_prev_close_usd_m,bcr_open_pct,bcr_close_pct\n" + dailyRows.join("\n") + "\n");
    await writeFile("data/results/fobxx-daily-replay-summary.csv", "theta_s,snapshots,continuity_checks,mints_accepted,mints_rejected,rejected_usd_m,redemptions_queued,min_post_request_rlc_pct,opening_shares_usd_m,closing_token_liabilities_usd_m\n" + summary.join("\n") + "\n");
  });
});
