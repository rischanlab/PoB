/**
 * FOBXX May-September 2026: five month-end position-level snapshots on ONE
 * persistent controller (review points P7, P1.6, P0.3).
 *
 * Observed (Form N-MFP3 for 31 May, 30 Jun, 31 Jul, 31 Aug and 30 Sep 2026):
 * every portfolio security, cash, other assets, liabilities, shares
 * outstanding, weekly liquid assets, the daily seven-day net yield, and the
 * daily GROSS subscriptions and redemptions of each month. The flows are
 * trade-date share transactions. The filing does not separate reinvested
 * dividends from new cash, and it does not report when cash was received or
 * paid.
 *
 * Modelled (and labelled as such in the output):
 *   - "cash-receipt-T0" (base): every subscription is new cash confirmed by a
 *     custodian receipt on the trade date; each redemption is settled the
 *     same day;
 *   - "reinvest-T0": dividends are assumed to be reinvested in full; each
 *     day's estimated reinvestment (shares x seven-day net yield / 365 x
 *     calendar days since the previous business day) is share creation
 *     WITHOUT cash and is minted without a receipt, so it must pass the BCR
 *     check on existing reserves; only the remainder is receipt-backed cash;
 *   - "cash-receipt-T1": as the base, but each redemption is settled on the
 *     next business day (claims open at month end are settled just before the
 *     month-end snapshot).
 *
 * Continuity adjustments. Each month-end snapshot attests the filed shares as
 * token supply, so it is accepted only if the controller's unit count
 * (previous filing + booked flows) equals the filing. If not, the controller
 * rejects it (LiabilityContinuityFailure). A difference of at most
 * ADJUSTMENT_LIMIT is then booked by the TOKEN_ROLE without any cash
 * movement: a positive difference as a mint without receipt (liabilities
 * rise, reserves do not, the BCR check applies), a negative one as a
 * redemption request whose claim is left pending (liabilities stay, no cash
 * leaves). Both are logged on-chain. A larger difference is not adjusted: the
 * snapshot stays rejected and minting stops when the previous snapshot
 * expires. The adjustment detects and records a mismatch between two filed
 * figures; it does not establish its economic cause.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, toBytes, type Hex } from "viem";

import { POLICY_HASH, WAD, makeSnapshot, signSnapshot, signSubscriptionReceipt, usd } from "./helpers.js";
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
const ADJUSTMENT_LIMIT = usd("1000"); // largest share/flow difference booked as an adjustment
type Leaf = [string, string, string, string, string, string, string, string, boolean, boolean, boolean];
type Flow = { date: string; subscriptions: string; redemptions: string };
type Scenario = "cash-receipt-T0" | "reinvest-T0" | "cash-receipt-T1";
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
  const yields = new Map<string, number>((fund.dailySevenDayNetYield as any[]).map((y) => [y.date, Number(y.yield)]));
  return { dir, snap, fund, tree, yields, leaves: [...tree.entries()].map(([, v]) => v) };
}));

async function deploy() {
  const wallets = await viem.getWalletClients();
  const [admin, custodian, administrator, valuation, legal, verifier, holder] = wallets;
  const signers = [custodian, administrator, valuation, legal, verifier];
  const thetaS = (995n * WAD) / 1000n; // researcher-selected sensitivity threshold
  const c = (await viem.deployContract("PoBPolicyController", [POLICY_HASH, thetaS, WAD, 35n * BigInt(DAY)])) as any;
  const holders = [custodian, administrator, valuation, legal, verifier, admin, admin];
  for (const [i, r] of ROLES.entries()) await c.write.grantRole([keccak256(toBytes(r)), holders[i].account.address], { account: admin.account });
  const client = await viem.getPublicClient();
  return { c, client, custodian, holder, signers, chainId: await client.getChainId(), as: { account: admin.account } };
}

async function run(scenario: Scenario, opts: { verify: boolean; injectDiscrepancyAt?: number } = { verify: false }) {
  const env = await deploy();
  const { c, client, custodian, holder, signers, chainId, as } = env;
  let nonce = 0n;
  const rows: string[] = [];
  const tot = { cashMints: 0, cashRejected: 0, nonCashMints: 0, nonCashRejected: 0, nonCashUsd: 0n, queued: 0, settled: 0, minRlc: Infinity, adjustments: 0, adjustedUsd: 0n, halted: "" };
  let prevIds: Set<string> | null = null;
  let prevDate = "2026-05-31";
  const open: bigint[] = []; // redemption ids awaiting settlement (T+1)

  const settle = async (id: bigint) => {
    const amount = (await c.read.redemptions([id]))[1] as bigint;
    await c.write.confirmSettlement([id, amount], as);
    tot.settled++;
  };
  const receiptMint = async (units: bigint) => {
    if (!(await c.read.canMintWithReceipt([units, units]))) return false;
    const epoch = (await c.read.latestSnapshot()).epoch;
    const sig = await signSubscriptionReceipt(custodian, chainId, c.address, { epoch, amount: units, nonce });
    await c.write.authorizeMintWithReceipt([units, units, nonce++, sig], as);
    return true;
  };

  for (const [k, mo] of months.entries()) {
    const A = mo.snap.aggregates;
    let filedShares = cents(mo.fund.numberOfSharesOutstanding);
    assert.equal(BigInt(A.tokenLiabilities), filedShares);
    if (opts.injectDiscrepancyAt === k) filedShares += usd("1000000"); // synthetic

    // 1. This month's disclosed daily flows (not for the first month).
    let subs = 0n, reds = 0n, reinvestEst = 0n;
    if (k > 0) {
      for (const f of mo.fund.dailyFlows as Flow[]) {
        const gap = (Date.parse(f.date) - Date.parse(prevDate)) / 86_400_000;
        if (gap > 0) await networkHelpers.time.increase(gap * DAY);
        prevDate = f.date;
        // T+1: settle yesterday's claims at the start of the day.
        while (open.length) await settle(open.shift()!);
        const sub = cents(f.subscriptions), red = cents(f.redemptions);
        subs += sub; reds += red;
        // Estimated reinvested dividends for the calendar days since the
        // previous business day (upper bound: full reinvestment).
        const units = await c.read.tokenUnits();
        const y = mo.yields.get(f.date) ?? 0;
        const reinvest = (units * BigInt(Math.round(y * 1e8)) * BigInt(gap)) / (365n * 10n ** 8n);
        reinvestEst += reinvest;
        let nonCash = 0n;
        if (scenario === "reinvest-T0") nonCash = reinvest < sub ? (reinvest / 10n ** 16n) * 10n ** 16n : sub;
        const cash = sub - nonCash;
        if (nonCash > 0n) {
          if (await c.read.canMint([nonCash])) { await c.write.authorizeMint([nonCash], as); tot.nonCashMints++; tot.nonCashUsd += nonCash; }
          else tot.nonCashRejected++;
        }
        if (cash > 0n) { if (await receiptMint(cash)) tot.cashMints++; else tot.cashRejected++; }
        if (red > 0n) {
          const pending = await c.read.currentPendingRedemptions();
          const rlc = Number((((await c.read.currentLiquidAssets()) * WAD) / (pending + red)) / 10n ** 12n) / 1e6;
          tot.minRlc = Math.min(tot.minRlc, rlc);
          await c.write.requestRedemption([holder.account.address, red], as);
          const id = (await c.read.nextRedemptionId()) - 1n;
          if (Number((await c.read.redemptions([id]))[3]) !== 0) tot.queued++;
          if (scenario === "cash-receipt-T1") open.push(id); else await settle(id);
        }
      }
    }
    const reportGap = (Date.parse(mo.snap.reportDate) - Date.parse(prevDate)) / 86_400_000;
    await networkHelpers.time.increase(Math.max(reportGap, 0) * DAY + 3_600);
    prevDate = mo.snap.reportDate;
    while (open.length) await settle(open.shift()!);

    // 2. Month-end snapshot from the filing.
    const make = async () => {
      const now = (await client.getBlock()).timestamp;
      return makeSnapshot(now, {
        epoch: BigInt(k + 1), validUntil: now + 35n * BigInt(DAY),
        reserveRoot: mo.tree.root as Hex,
        grossReserves: BigInt(A.grossReserves), eligibleReserves: BigInt(A.eligibleReserves),
        liquidAssets: BigInt(A.liquidAssets), tokenLiabilities: filedShares,
        pendingRedemptions: await c.read.currentPendingRedemptions(), otherLiabilities: BigInt(A.otherLiabilities),
      });
    };
    const residual = k === 0 ? 0n : filedShares - (await c.read.tokenUnits());
    let firstRejected = false, adjustment = "";
    if (residual !== 0n) {
      const s = await make();
      await assert.rejects(c.write.submitSnapshot([s, await signSnapshot(signers, chainId, c.address, s)], as), /LiabilityContinuityFailure/);
      firstRejected = true;
      const abs = residual < 0n ? -residual : residual;
      if (abs > ADJUSTMENT_LIMIT) {
        tot.halted = mo.snap.reportDate;
        rows.push([scenario, mo.snap.reportDate, mo.tree.root, mo.leaves.length, "", "", "", m(subs), m(reds), m(reinvestEst), usd2(residual), true, "none (above limit; halted)", m(filedShares), "", "", "", "", ""].join(","));
        break;
      }
      if (residual > 0n) { await c.write.authorizeMint([residual], as); adjustment = "mint without receipt"; }
      else { await c.write.requestRedemption([holder.account.address, -residual], as); adjustment = "claim left pending"; }
      tot.adjustments++; tot.adjustedUsd += abs;
      await networkHelpers.time.increase(60);
    }
    const s = await make();
    await c.write.submitSnapshot([s, await signSnapshot(signers, chainId, c.address, s)], as);
    assert.equal(await c.read.tokenUnits(), filedShares);

    // 3. Positions verify against the committed root and reconcile.
    let verified = 0;
    if (opts.verify) {
      assert.equal(mo.tree.root, mo.snap.merkleRoot);
      for (const [i, leaf] of mo.tree.entries()) {
        assert.equal(await c.read.verifyReservePosition([toStruct(leaf), mo.tree.getProof(i)]), true);
        assert.equal(Number(await c.read.positionInconsistency([toStruct(leaf)])), 0);
        verified++;
      }
      const recon = reconcile(mo.leaves, A, externalFromFund(mo.fund));
      assert.equal(recon.findings.length, 0, `${mo.snap.reportDate}: reconciliation`);
    }
    // 4. Position-set changes (by instrument identifier).
    const ids = new Set(mo.leaves.filter((l) => !/^(CASH|OTHER)/.test(l[1])).map((l) => l[1]));
    const added = prevIds ? [...ids].filter((x) => !prevIds!.has(x)).length : 0;
    const removed = prevIds ? [...prevIds].filter((x) => !ids.has(x)).length : 0;
    prevIds = ids;
    const stress = BigInt(A.stressPendingRedemptions);
    rows.push([
      scenario, mo.snap.reportDate, mo.tree.root, mo.leaves.length, verified, added, removed,
      m(subs), m(reds), m(reinvestEst), usd2(residual), firstRejected, adjustment || "none", m(filedShares),
      m(BigInt(A.eligibleReserves)), m(BigInt(A.liquidAssets)), usd2(await c.read.currentPendingRedemptions()),
      pct(await c.read.currentBCR()), (Number((BigInt(A.liquidAssets) * 10_000n) / stress) / 100).toFixed(2),
    ].join(","));
  }
  return { rows, tot, c };
}

const HEADER = "scenario,report_date,merkle_root,leaves,leaves_verified,securities_added,securities_removed,"
  + "month_gross_subscriptions_usd_m,month_gross_redemptions_usd_m,estimated_reinvested_dividends_usd_m,"
  + "flow_vs_shares_residual_usd,continuity_rejected_first,adjustment,filed_shares_usd_m,eligible_usd_m,liquid_usd_m,"
  + "pending_after_snapshot_usd,bcr_pct,stress_rlc_pct";

describe("FOBXX May-September 2026 month-end snapshots on a persistent controller", function () {
  const summary: string[] = [];
  const allRows: string[] = [];
  const add = (scenario: Scenario, r: Awaited<ReturnType<typeof run>>) => {
    allRows.push(...r.rows);
    const t = r.tot;
    summary.push([scenario, t.cashMints, t.cashRejected, t.nonCashMints, t.nonCashRejected, m(t.nonCashUsd), t.queued, t.settled,
      Number.isFinite(t.minRlc) ? (t.minRlc * 100).toFixed(2) : "", t.adjustments, usd2(t.adjustedUsd), t.halted || "no"].join(","));
  };

  it("base (modelled cash receipts, T+0): five filings verify, flows are booked, continuity is enforced", async function () {
    const r = await run("cash-receipt-T0", { verify: true });
    assert.equal(r.rows.length, 5);
    assert.equal(r.tot.cashRejected, 0);
    assert.equal(r.tot.adjustments, 4);
    assert.equal(Number((await r.c.read.latestSnapshot()).epoch), 5);
    add("cash-receipt-T0", r);
  });

  it("sensitivity: estimated dividend reinvestment minted without cash; T+1 settlement", async function () {
    const ri = await run("reinvest-T0");
    assert.ok(ri.tot.nonCashMints + ri.tot.nonCashRejected > 0);
    add("reinvest-T0", ri);
    const t1 = await run("cash-receipt-T1");
    assert.equal(t1.rows.length, 5);
    add("cash-receipt-T1", t1);
  });

  it("a discrepancy above the adjustment limit is not adjusted: the snapshot stays rejected and minting stops on expiry", async function () {
    const r = await run("cash-receipt-T0", { verify: false, injectDiscrepancyAt: 1 });
    assert.equal(r.tot.halted, "2026-06-30");
    assert.equal(Number((await r.c.read.latestSnapshot()).epoch), 1);
    await networkHelpers.time.increase(36 * DAY);
    assert.equal(await r.c.read.isSnapshotFresh(), false);
    assert.equal(await r.c.read.canMint([usd("1")]), false);
    summary.push(["synthetic-discrepancy-1m-june", r.tot.cashMints, r.tot.cashRejected, 0, 0, "0.00", r.tot.queued, r.tot.settled, "", 0, "0.00", "halted at 2026-06-30; snapshot rejected; minting stopped after expiry"].join(","));
  });

  it("writes the monthly tables", async function () {
    await writeFile("data/results/fobxx-monthly.csv", HEADER + "\n" + allRows.join("\n") + "\n");
    await writeFile("data/results/fobxx-monthly-scenarios.csv",
      "scenario,cash_mints_accepted,cash_mints_rejected,noncash_mints_accepted,noncash_mints_rejected,noncash_minted_usd_m,redemptions_queued,settlements,min_post_request_rlc_pct,adjustments,adjusted_usd,halted\n"
      + summary.join("\n") + "\n");
  });
});
