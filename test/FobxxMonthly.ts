/**
 * FOBXX May-September 2026: five month-end position-level snapshots on ONE
 * persistent controller (review points 7 and 8).
 *
 * Observed (Form N-MFP3, filed monthly for 31 May, 30 Jun, 31 Jul, 31 Aug and
 * 30 Sep 2026): every portfolio security, cash, other assets, liabilities,
 * shares outstanding, weekly liquid assets and the daily gross
 * subscriptions and redemptions of each month.
 * Modelled: same-day (T+0) settlement of each day's gross redemptions; one
 * receipt per day for gross subscriptions; the haircut schedule of
 * scripts/build-franklin-snapshot.mjs.
 *
 * Between month ends the controller books the next month's disclosed daily
 * flows. Each month-end snapshot carries the filed shares outstanding as its
 * token supply, so it is accepted only if the controller's own unit count
 * (previous filing + booked flows) equals the new filing. Where the filed
 * share change and the filed daily flows differ by a few dollars, the
 * continuity check rejects the snapshot; the difference is then booked as an
 * explicit, logged adjustment and the snapshot is resubmitted.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, toBytes, type Hex } from "viem";

import { POLICY_HASH, WAD, makeSnapshot, signSnapshot, signSubscriptionReceipt } from "./helpers.js";
// @ts-ignore - plain ES module shared with the CLI
import { reconcile, externalFromFund } from "../scripts/reconcile-snapshot.mjs";

const { viem, networkHelpers } = await hre.network.create();

const DIRS = [
  "data/input/franklin-fobxx-monthly/2026-05-31",
  "data/input/franklin-fobxx-monthly/2026-06-30",
  "data/input/franklin-fobxx-monthly/2026-07-31",
  "data/input/franklin-fobxx-monthly/2026-08-31",
  "data/input/franklin-fobxx",
];
const ROLES = ["CUSTODIAN_ROLE", "ADMINISTRATOR_ROLE", "VALUATION_ROLE", "LEGAL_ROLE", "VERIFIER_ROLE", "SETTLEMENT_ROLE", "TOKEN_ROLE"];
type Leaf = [string, string, string, string, string, string, string, string, boolean, boolean, boolean];
const toStruct = (p: Leaf) => ({
  positionId: p[0], instrumentId: p[1], faceValue: BigInt(p[2]), marketValue: BigInt(p[3]),
  eligibleValue: BigInt(p[4]), liquidValue: BigInt(p[5]), maturityDays: BigInt(p[6]),
  haircutBps: BigInt(p[7]), encumbered: p[8], legallyEligible: p[9], settlementFinal: p[10],
});
const cents = (v: string) => BigInt(Math.round(Number(v) * 100)) * 10n ** 16n;
const pct = (w: bigint) => (Number((w * 1_000_000n) / WAD) / 10_000).toFixed(4);
const m = (w: bigint) => (Number(w / 10n ** 16n) / 1e8).toFixed(2);
const usd2 = (w: bigint) => (Number(w / 10n ** 16n) / 100).toFixed(2);
const DAY = 86_400;

const months = await Promise.all(DIRS.map(async (dir) => {
  const snap = JSON.parse(await readFile(`${dir}/snapshot.json`, "utf8"));
  const fund = JSON.parse(await readFile(`${dir}/fund.json`, "utf8"));
  const tree = StandardMerkleTree.load<Leaf>(JSON.parse(await readFile(`${dir}/tree.json`, "utf8")));
  return { dir, snap, fund, tree, leaves: [...tree.entries()].map(([, v]) => v) };
}));

describe("FOBXX May-September 2026 month-end snapshots on a persistent controller", function () {
  it("verifies five filings, books the disclosed flows between them, and enforces continuity", async function () {
    const wallets = await viem.getWalletClients();
    const [admin, custodian, administrator, valuation, legal, verifier, holder] = wallets;
    const signers = [custodian, administrator, valuation, legal, verifier];
    const thetaS = (995n * WAD) / 1000n; // researcher-selected sensitivity threshold
    const c = (await viem.deployContract("PoBPolicyController", [POLICY_HASH, thetaS, WAD, 35n * BigInt(DAY)])) as any;
    const holders = [custodian, administrator, valuation, legal, verifier, admin, admin];
    for (const [i, r] of ROLES.entries()) await c.write.grantRole([keccak256(toBytes(r)), holders[i].account.address], { account: admin.account });
    const client = await viem.getPublicClient();
    const chainId = await client.getChainId();
    const as = { account: admin.account };

    const rows: string[] = [];
    let nonce = 0n;
    let prevIds: Set<string> | null = null;
    let prevDate = "2026-05-31";
    for (const [k, mo] of months.entries()) {
      const A = mo.snap.aggregates;
      const filedShares = cents(mo.fund.numberOfSharesOutstanding);
      assert.equal(BigInt(A.tokenLiabilities), filedShares);

      // 1. Book this month's disclosed daily flows (not for the first month:
      //    its opening balance is the filing itself).
      let subs = 0n, reds = 0n, accepted = 0, rejected = 0, queued = 0, settled = 0;
      if (k > 0) {
        for (const f of mo.fund.dailyFlows as Array<{ date: string; subscriptions: string; redemptions: string }>) {
          const gap = (Date.parse(f.date) - Date.parse(prevDate)) / 86_400_000;
          if (gap > 0) await networkHelpers.time.increase(gap * DAY);
          prevDate = f.date;
          const sub = cents(f.subscriptions), red = cents(f.redemptions);
          subs += sub; reds += red;
          if (sub > 0n) {
            if (await c.read.canMintWithReceipt([sub, sub])) {
              const epoch = (await c.read.latestSnapshot()).epoch;
              const sig = await signSubscriptionReceipt(custodian, chainId, c.address, { epoch, amount: sub, nonce });
              await c.write.authorizeMintWithReceipt([sub, sub, nonce++, sig], as);
              accepted++;
            } else rejected++;
          }
          if (red > 0n) {
            await c.write.requestRedemption([holder.account.address, red], as);
            const id = (await c.read.nextRedemptionId()) - 1n;
            if (Number((await c.read.redemptions([id]))[3]) !== 0) queued++;
            await c.write.confirmSettlement([id, red], as);
            settled++;
          }
        }
      }
      const reportGap = (Date.parse(mo.snap.reportDate) - Date.parse(prevDate)) / 86_400_000;
      await networkHelpers.time.increase(Math.max(reportGap, 0) * DAY + 3_600);
      prevDate = mo.snap.reportDate;

      // 2. Month-end snapshot from the filing (all redemptions settled, so
      //    pending = 0 and token supply = filed shares at price 1.0000).
      const make = async () => {
        const now = (await client.getBlock()).timestamp;
        return makeSnapshot(now, {
          epoch: BigInt(k + 1), validUntil: now + 35n * BigInt(DAY),
          reserveRoot: mo.tree.root as Hex,
          grossReserves: BigInt(A.grossReserves), eligibleReserves: BigInt(A.eligibleReserves),
          liquidAssets: BigInt(A.liquidAssets), tokenLiabilities: filedShares,
          pendingRedemptions: 0n, otherLiabilities: BigInt(A.otherLiabilities),
        });
      };
      const unitsBefore = await c.read.tokenUnits();
      const residual = k === 0 ? 0n : filedShares - unitsBefore;
      let continuityRejected = false;
      if (residual !== 0n) {
        const s = await make();
        await assert.rejects(c.write.submitSnapshot([s, await signSnapshot(signers, chainId, c.address, s)], as), /LiabilityContinuityFailure/);
        continuityRejected = true;
        // Book the unexplained difference as an explicit adjustment.
        if (residual > 0n) {
          const epoch = (await c.read.latestSnapshot()).epoch;
          const sig = await signSubscriptionReceipt(custodian, chainId, c.address, { epoch, amount: residual, nonce });
          await c.write.authorizeMintWithReceipt([residual, residual, nonce++, sig], as);
        } else {
          await c.write.requestRedemption([holder.account.address, -residual], as);
          const id = (await c.read.nextRedemptionId()) - 1n;
          await c.write.confirmSettlement([id, -residual], as);
        }
        await networkHelpers.time.increase(60);
      }
      const s = await make();
      await c.write.submitSnapshot([s, await signSnapshot(signers, chainId, c.address, s)], as);
      assert.equal(await c.read.tokenUnits(), filedShares);

      // 3. Every filed position verifies against the committed root; the
      //    leaves reconcile with the signed aggregates and the filing.
      assert.equal(mo.tree.root, mo.snap.merkleRoot);
      let verified = 0;
      for (const [i, leaf] of mo.tree.entries()) {
        assert.equal(await c.read.verifyReservePosition([toStruct(leaf), mo.tree.getProof(i)]), true);
        assert.equal(Number(await c.read.positionInconsistency([toStruct(leaf)])), 0);
        verified++;
      }
      const recon = reconcile(mo.leaves, A, externalFromFund(mo.fund));
      assert.equal(recon.findings.length, 0, `${mo.snap.reportDate}: ${JSON.stringify(recon.findings, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);

      // 4. Position-set changes (by instrument identifier) since last month.
      const ids = new Set(mo.leaves.filter((l) => !/^(CASH|OTHER)/.test(l[1])).map((l) => l[1]));
      const added = prevIds ? [...ids].filter((x) => !prevIds!.has(x)).length : 0;
      const removed = prevIds ? [...prevIds].filter((x) => !ids.has(x)).length : 0;
      prevIds = ids;

      const stress = BigInt(A.stressPendingRedemptions);
      rows.push([
        mo.snap.reportDate, mo.tree.root, mo.leaves.length, verified, ids.size, added, removed,
        m(subs), m(reds), accepted, rejected, queued, settled,
        usd2(residual), continuityRejected, m(filedShares),
        m(BigInt(A.grossReserves)), m(BigInt(A.eligibleReserves)), m(BigInt(A.liquidAssets)), m(BigInt(A.otherLiabilities)),
        pct(await c.read.currentBCR()), m(stress), (Number((BigInt(A.liquidAssets) * 10_000n) / stress) / 100).toFixed(2),
      ].join(","));
      assert.equal(rejected, 0);
    }
    assert.equal(Number((await c.read.latestSnapshot()).epoch), 5);
    await writeFile("data/results/fobxx-monthly.csv",
      "report_date,merkle_root,leaves,leaves_verified,securities,securities_added,securities_removed,"
      + "month_subscriptions_usd_m,month_redemptions_usd_m,mints_accepted,mints_rejected,redemptions_queued,redemptions_settled,"
      + "flow_vs_shares_residual_usd,continuity_rejected_first,filed_shares_usd_m,gross_usd_m,eligible_usd_m,liquid_usd_m,other_liabilities_usd_m,"
      + "bcr_pct,stress_5day_redemptions_usd_m,stress_rlc_pct\n" + rows.join("\n") + "\n");
  });
});
