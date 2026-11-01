/**
 * Real position-level reserve snapshot: the 85 positions of the Franklin
 * OnChain U.S. Government Money Fund (FOBXX) as filed on Form N-MFP3 for
 * 30 September 2026 (83 securities, cash, other assets). The tree and
 * aggregates come from scripts/build-franklin-snapshot.mjs.
 *
 * The test (1) commits the real root on-chain and verifies every position,
 * (2) evaluates the mint policy on the real balance sheet at two BCR
 * thresholds, and (3) tampers with real positions and checks that a
 * permissionless challenge suspends minting.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, toBytes, type Hex } from "viem";

import { POLICY_HASH, WAD, makeSnapshot, signSnapshot, usd } from "./helpers.js";
// @ts-ignore - plain ES module shared with the CLI
import { reconcile, externalFromFund } from "../scripts/reconcile-snapshot.mjs";

const { viem } = await hre.network.create();

const DIR = "data/input/franklin-fobxx";
const TYPES = ["string", "string", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bool", "bool", "bool"];
type Leaf = [string, string, string, string, string, string, string, string, boolean, boolean, boolean];
const ROLES = ["CUSTODIAN_ROLE", "ADMINISTRATOR_ROLE", "VALUATION_ROLE", "LEGAL_ROLE", "VERIFIER_ROLE", "SETTLEMENT_ROLE", "TOKEN_ROLE"];
const REASONS = ["None", "EncumberedButEligible", "LegallyIneligibleButEligible", "UnsettledButEligible", "EligibleExceedsHaircutValue", "LiquidExceedsEligible"];

const toStruct = (p: Leaf) => ({
  positionId: p[0], instrumentId: p[1], faceValue: BigInt(p[2]), marketValue: BigInt(p[3]),
  eligibleValue: BigInt(p[4]), liquidValue: BigInt(p[5]), maturityDays: BigInt(p[6]),
  haircutBps: BigInt(p[7]), encumbered: p[8], legallyEligible: p[9], settlementFinal: p[10],
});
const pct = (wad: bigint) => (Number((wad * 1_000_000n) / WAD) / 10_000).toFixed(2);
const usdText = (v: bigint) => (Number(v / 10n ** 16n) / 100).toFixed(2);

const snapshotData = JSON.parse(await readFile(`${DIR}/snapshot.json`, "utf8"));
const tree = StandardMerkleTree.load<Leaf>(JSON.parse(await readFile(`${DIR}/tree.json`, "utf8")));
const leaves = [...tree.entries()].map(([, v]) => v);
const A = snapshotData.aggregates;

async function deploy(minBcr: bigint) {
  const wallets = await viem.getWalletClients();
  const [admin, custodian, administrator, valuation, legal, verifier, outsider] = wallets;
  const controller = (await viem.deployContract("PoBPolicyController", [POLICY_HASH, minBcr, WAD, 86_400n])) as any;
  const holders = [custodian, administrator, valuation, legal, verifier, admin, admin];
  for (const [i, role] of ROLES.entries()) {
    await controller.write.grantRole([keccak256(toBytes(role)), holders[i].account.address], { account: admin.account });
  }
  const client = await viem.getPublicClient();
  return {
    controller, client, admin, outsider,
    chainId: await client.getChainId(),
    now: (await client.getBlock()).timestamp,
    signers: [custodian, administrator, valuation, legal, verifier],
  };
}

// Aggregates as filed; the stress redemption queue (largest five-business-day
// gross redemptions in September 2026) is moved out of token liabilities, so
// total liabilities are unchanged.
function realSnapshot(now: bigint, root: Hex) {
  const pending = BigInt(A.stressPendingRedemptions);
  return makeSnapshot(now, {
    reserveRoot: root,
    grossReserves: BigInt(A.grossReserves),
    eligibleReserves: BigInt(A.eligibleReserves),
    liquidAssets: BigInt(A.liquidAssets),
    tokenLiabilities: BigInt(A.tokenLiabilities) - pending,
    pendingRedemptions: pending,
    otherLiabilities: BigInt(A.otherLiabilities),
  });
}

async function submit(env: Awaited<ReturnType<typeof deploy>>, root: Hex) {
  const snap = realSnapshot(env.now, root);
  const sigs = await signSnapshot(env.signers, env.chainId, env.controller.address, snap);
  const hash = await env.controller.write.submitSnapshot([snap, sigs], { account: env.admin.account });
  return (await env.client.waitForTransactionReceipt({ hash })).gasUsed as bigint;
}

const find = (id: string) => leaves.findIndex((l) => l[1] === id);

describe("Real position-level snapshot (FOBXX N-MFP3, 30 Sep 2026)", function () {
  const rows: Record<string, string>[] = [];
  const out: any = { reportDate: snapshotData.reportDate, merkleRoot: tree.root, positions: leaves.length };

  it("the committed tree matches the filing and every real position verifies on-chain", async function () {
    assert.equal(tree.root, snapshotData.merkleRoot);
    assert.equal(leaves.length, 85);
    const env = await deploy(WAD);
    const gas = await submit(env, tree.root as Hex);
    let maxProof = 0, minProof = Infinity;
    for (const [i, leaf] of tree.entries()) {
      const proof = tree.getProof(i);
      maxProof = Math.max(maxProof, proof.length); minProof = Math.min(minProof, proof.length);
      assert.equal(await env.controller.read.reservePositionLeaf([toStruct(leaf)]), tree.leafHash(leaf));
      assert.equal(await env.controller.read.verifyReservePosition([toStruct(leaf), proof]), true);
      assert.equal(Number(await env.controller.read.positionInconsistency([toStruct(leaf)])), 0);
    }
    Object.assign(out, { submitSnapshotGas: gas.toString(), proofLength: `${minProof}-${maxProof}`, verifiedPositions: leaves.length, inconsistentPositions: 0 });
  });

  it("evaluates the mint policy on the real balance sheet", async function () {
    // 99.5% and the sweep values are researcher-selected sensitivity
    // thresholds, not a regulatory minimum.
    const sweep: Array<[string, bigint]> = [["100%", WAD], ["99.5%", (995n * WAD) / 1000n], ["99.7%", (997n * WAD) / 1000n], ["99.6%", (996n * WAD) / 1000n], ["99.0%", (990n * WAD) / 1000n]];
    for (const [label, minBcr] of sweep) {
      const env = await deploy(minBcr);
      await submit(env, tree.root as Hex);
      const bcr = await env.controller.read.currentBCR();
      const rlc = await env.controller.read.currentRLC();
      const eligible = await env.controller.read.currentEligibleReserves();
      const liabilities = await env.controller.read.currentTotalLiabilities();
      // Largest mint the policy allows without new cash: E / (L + m) >= minBCR.
      const headroom = (eligible * WAD) / minBcr > liabilities ? (eligible * WAD) / minBcr - liabilities : 0n;
      const oneMillion = usd("1000000");
      const row = {
        policy: `minBCR ${label}, minRLC 100%`,
        bcr: pct(bcr),
        rlc: pct(rlc),
        mint1mWithoutReceipt: String(await env.controller.read.canMint([oneMillion])),
        mint1mWithReceipt: String(await env.controller.read.canMintWithReceipt([oneMillion, oneMillion])),
        mintHeadroomUsd: usdText(headroom),
        // With a receipt, BCR after mint = (E + m) / (L + m): it moves toward
        // 100% but cannot reach it while E < L, so a strict 100% rule cannot be
        // cured by new subscriptions alone.
        bcrAfter100mReceiptMint: pct(((eligible + usd("100000000")) * WAD) / (liabilities + usd("100000000"))),
      };
      if (headroom > 0n) {
        assert.equal(await env.controller.read.canMint([headroom]), true);
        assert.equal(await env.controller.read.canMint([headroom + usd("1")]), false);
      } else {
        assert.equal(await env.controller.read.canMint([usd("1")]), false);
      }
      rows.push(row);
    }
    out.policy = rows.slice();
    const r100 = rows[0];
    assert.equal(r100.mint1mWithReceipt, "false");
    assert.ok(Number(r100.bcrAfter100mReceiptMint) < 100);
    assert.equal(rows[0].mint1mWithoutReceipt, "false"); // a 1:1 fund sits below 100% BCR at market value
    assert.equal(rows[1].mint1mWithoutReceipt, "true");
  });

  it("aggregate reconciliation: what the contract checks and what it does not", async function () {
    const fund = JSON.parse(await readFile(`${DIR}/fund.json`, "utf8"));
    const external = externalFromFund(fund);
    const recon: Record<string, string>[] = [];
    const run = async (name: string, ls: Leaf[], aggregates: any, expectOnchain: boolean) => {
      const t = StandardMerkleTree.of(ls, TYPES);
      const env = await deploy((995n * WAD) / 1000n);
      const pending = BigInt(A.stressPendingRedemptions);
      const snap = makeSnapshot(env.now, {
        reserveRoot: t.root as Hex,
        grossReserves: BigInt(aggregates.grossReserves), eligibleReserves: BigInt(aggregates.eligibleReserves),
        liquidAssets: BigInt(aggregates.liquidAssets), tokenLiabilities: BigInt(A.tokenLiabilities) - pending,
        pendingRedemptions: pending, otherLiabilities: BigInt(A.otherLiabilities),
      });
      await env.controller.write.submitSnapshot([snap, await signSnapshot(env.signers, env.chainId, env.controller.address, snap)], { account: env.admin.account });
      // Every committed leaf is individually consistent, so no challenge can succeed.
      let challengeable = 0;
      for (const [, l] of t.entries()) if (Number(await env.controller.read.positionInconsistency([toStruct(l)]))) challengeable++;
      const r = reconcile(ls, aggregates, external);
      const leafCheck = r.findings.filter((f: any) => f.check === "leaves-vs-signed");
      const extCheck = r.findings.filter((f: any) => f.check === "leaves-vs-external");
      assert.equal(await env.controller.read.isSnapshotFresh(), expectOnchain);
      recon.push({
        case: name,
        acceptedOnChain: String(await env.controller.read.isSnapshotFresh()),
        challengeableLeaves: String(challengeable),
        leafVsSignedMismatch: leafCheck.length ? leafCheck.map((f: any) => `${f.field} ${usdText(f.difference)}`).join("; ") : "none",
        leafVsFilingMismatch: extCheck.length ? extCheck.map((f: any) => f.field === "positionCount" ? `count ${f.fromLeaves} vs ${f.external}` : `${f.field} ${usdText(f.difference < 0n ? -f.difference : f.difference)}`).join("; ") : "none",
        bcrSigned: pct(await env.controller.read.currentBCR()),
        bcrFromLeaves: pct((r.totals.eligibleReserves * WAD) / (BigInt(A.tokenLiabilities) + BigInt(A.otherLiabilities))),
      });
      return r;
    };
    const plus = (a: any, k: string, d: bigint) => ({ ...a, [k]: (BigInt(a[k]) + d).toString() });
    // R0 honest file.
    const r0 = await run("R0 honest position file", leaves, A, true);
    assert.equal(r0.findings.length, 0);
    // R1 signed eligible and liquid aggregates inflated by USD 20 m; leaves untouched.
    const inflatedAgg = plus(plus(plus(A, "eligibleReserves", usd("20000000")), "grossReserves", usd("20000000")), "liquidAssets", usd("20000000"));
    const r1 = await run("R1 aggregates inflated by USD 20m", leaves, inflatedAgg, true);
    assert.ok(r1.findings.some((f: any) => f.check === "leaves-vs-signed"));
    // R2 largest position omitted from the file, aggregates unchanged.
    const big = leaves.reduce((b, l, i) => (BigInt(l[3]) > BigInt(leaves[b][3]) ? i : b), 0);
    const omitted = leaves.filter((_, i) => i !== big);
    const r2 = await run("R2 position omitted, aggregates unchanged", omitted, A, true);
    assert.ok(r2.findings.some((f: any) => f.check === "leaves-vs-signed"));
    // R3 position omitted and aggregates reduced to match (consistent file).
    const cut = (a: any) => ({ ...a,
      grossReserves: (BigInt(a.grossReserves) - BigInt(leaves[big][3])).toString(),
      eligibleReserves: (BigInt(a.eligibleReserves) - BigInt(leaves[big][4])).toString(),
      liquidAssets: (BigInt(a.liquidAssets) - BigInt(leaves[big][5])).toString() });
    const r3 = await run("R3 position omitted, aggregates consistent", omitted, cut(A), true);
    assert.ok(!r3.findings.some((f: any) => f.check === "leaves-vs-signed"));
    assert.ok(r3.findings.some((f: any) => f.check === "leaves-vs-external"));
    // R4 fabricated consistent position added, aggregates raised to match.
    const fake: Leaf = ["FOBXX-2026-09-30-999", "912797ZZ9", usd("20000000").toString(), usd("20000000").toString(), usd("20000000").toString(), usd("20000000").toString(), "5", "0", false, true, true];
    const r4 = await run("R4 fabricated position, aggregates consistent", [...leaves, fake], plus(plus(plus(A, "eligibleReserves", usd("20000000")), "grossReserves", usd("20000000")), "liquidAssets", usd("20000000")), true);
    assert.ok(!r4.findings.some((f: any) => f.check === "leaves-vs-signed"));
    assert.ok(r4.findings.some((f: any) => f.check === "leaves-vs-external"));
    out.reconciliation = recon;
  });

  it("reviewer example: signed 100 eligible vs leaves summing to 80, liabilities 90", async function () {
    const env = await deploy(WAD);
    const mk = (id: string, v: string): Leaf => [id, `SYN-${id}`, usd(v).toString(), usd(v).toString(), usd(v).toString(), "0", "30", "0", false, true, true];
    const ls = [mk("P1", "40"), mk("P2", "40")];
    const t = StandardMerkleTree.of(ls, TYPES);
    const snap = makeSnapshot(env.now, { reserveRoot: t.root as Hex, grossReserves: usd("100"), eligibleReserves: usd("100"), liquidAssets: usd("10"), tokenLiabilities: usd("90"), pendingRedemptions: 0n, otherLiabilities: 0n });
    await env.controller.write.submitSnapshot([snap, await signSnapshot(env.signers, env.chainId, env.controller.address, snap)], { account: env.admin.account });
    assert.equal(pct(await env.controller.read.currentBCR()), "111.11");
    const r = reconcile(ls, { grossReserves: usd("100"), eligibleReserves: usd("100"), liquidAssets: usd("10") });
    assert.equal(pct((r.totals.eligibleReserves * WAD) / usd("90")), "88.89");
    for (const [i, l] of t.entries()) {
      await assert.rejects(env.controller.write.challengeReservePosition([toStruct(l), t.getProof(i)], { account: env.outsider.account }), /PositionIsConsistent/);
    }
    out.reviewerExample = { signedBcr: "111.11", leafBcr: "88.89", acceptedOnChain: true, challengeSucceeds: false, offchainReconciliationFlags: r.findings.length > 0 };
  });

  it("challenges against tampered real positions suspend minting", async function () {
    const challenges: Record<string, string>[] = [];
    const tamper = async (name: string, index: number, edit: (l: Leaf) => Leaf, expected: number | null) => {
      const tampered = leaves.map((l, i) => (i === index ? edit([...l] as Leaf) : l));
      const t = StandardMerkleTree.of(tampered, TYPES);
      const env = await deploy((995n * WAD) / 1000n);
      await submit(env, t.root as Hex);
      const leaf = tampered[index];
      const reason = Number(await env.controller.read.positionInconsistency([toStruct(leaf)]));
      let gas = "";
      if (expected === null) {
        assert.equal(reason, 0);
        await assert.rejects(
          env.controller.write.challengeReservePosition([toStruct(leaf), t.getProof(index)], { account: env.outsider.account }),
          /PositionIsConsistent/,
        );
      } else {
        assert.equal(reason, expected);
        const hash = await env.controller.write.challengeReservePosition([toStruct(leaf), t.getProof(index)], { account: env.outsider.account });
        gas = String((await env.client.waitForTransactionReceipt({ hash })).gasUsed);
        assert.equal(await env.controller.read.isSnapshotFresh(), false);
        assert.equal(await env.controller.read.canMint([usd("1")]), false);
      }
      challenges.push({ tamper: name, instrument: leaf[1], detected: String(expected !== null), reason: REASONS[reason], challengeGas: gas });
    };
    const repo = find("ZS48579");
    const longNote = leaves.reduce((b, l, i) => (Number(l[6]) > Number(leaves[b][6]) ? i : b), 0);
    const bill = find("912797VN4");
    const notWeekly = leaves.findIndex((l) => l[5] === "0" && l[4] !== "0");
    const other = find("OTHER-ASSETS");
    await tamper("repo pledged elsewhere but counted", repo, (l) => { l[8] = true; return l; }, 1);
    await tamper("receivables counted as eligible", other, (l) => { l[4] = l[3]; return l; }, 2);
    await tamper("unsettled bill counted", bill, (l) => { l[10] = false; return l; }, 3);
    await tamper("haircut skipped on longest note", longNote, (l) => { l[4] = l[3]; return l; }, 4);
    await tamper("liquid value above eligible", notWeekly, (l) => { l[5] = (BigInt(l[4]) + 1n).toString(); return l; }, 5);
    // Limitation: liquidity beyond the 7-day horizon is not a challenge rule.
    await tamper("non-weekly-liquid note reported liquid", notWeekly, (l) => { l[5] = l[4]; return l; }, null);

    // Controls on the untampered tree.
    const env = await deploy((995n * WAD) / 1000n);
    await submit(env, tree.root as Hex);
    await assert.rejects(
      env.controller.write.challengeReservePosition([toStruct(leaves[repo]), tree.getProof(repo)], { account: env.outsider.account }),
      /PositionIsConsistent/,
    );
    const forged = [...leaves[repo]] as Leaf; forged[8] = true;
    await assert.rejects(
      env.controller.write.challengeReservePosition([toStruct(forged), tree.getProof(repo)], { account: env.outsider.account }),
      /InvalidMerkleProof/,
    );
    out.challenges = challenges;

    const csv = (rs: Record<string, string>[]) => [Object.keys(rs[0]).join(","), ...rs.map((r) => Object.values(r).map((v) => (/[",]/.test(v) ? `"${v}"` : v)).join(","))].join("\n") + "\n";
    await writeFile("data/results/real-position-policy.csv", csv(out.policy));
    await writeFile("data/results/real-position-challenges.csv", csv(challenges));
    await writeFile("data/results/real-position-reconciliation.csv", csv(out.reconciliation));
    await writeFile("data/results/real-position-snapshot.json", JSON.stringify({ ...out, usd: snapshotData.usd, ratiosPercent: snapshotData.ratiosPercent, haircutSchedule: snapshotData.haircutSchedule }, null, 2) + "\n");
  });
});
