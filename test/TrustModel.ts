/**
 * Institutional trust, collusion, and liveness evaluation (review point 9).
 *
 * Each case is executed against the deployed controller. The outcome column
 * of data/results/trust-model-results.csv uses five categories:
 *   prevented  - the contract rejects the action;
 *   detected   - a permissionless on-chain check can expose it;
 *   logged     - the action succeeds but leaves an on-chain event trail;
 *   governance - only governance or legal remedies apply;
 *   out-of-scope - not observable on-chain.
 * "Single attestor" is AblationController with singleAttestor = true (same
 * accounting, one verifier signature over the full snapshot).
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { keccak256, toBytes, type Hex } from "viem";

import { POLICY_HASH, WAD, makeSnapshot, signSnapshot, snapshotTypes, usd } from "./helpers.js";

const { viem, networkHelpers } = await hre.network.create();

const ROLE_NAMES = ["CUSTODIAN_ROLE", "ADMINISTRATOR_ROLE", "VALUATION_ROLE", "LEGAL_ROLE", "VERIFIER_ROLE", "SETTLEMENT_ROLE", "TOKEN_ROLE"];
const role = (name: string) => keccak256(toBytes(name));

async function deploy(name: "PoBPolicyController" | "SingleAttestor" = "PoBPolicyController") {
  const wallets = await viem.getWalletClients();
  const [admin, custodian, administrator, valuation, legal, verifier, outsider, holder, a1, a2, a3, a4, a5] = wallets;
  const controller = (name === "SingleAttestor"
    ? await viem.deployContract("AblationController", [POLICY_HASH, WAD, WAD, 86_400n, true, true])
    : await viem.deployContract(name, [POLICY_HASH, WAD, WAD, 86_400n])) as any;
  const holders = [custodian, administrator, valuation, legal, verifier, admin, admin];
  for (const [i, r] of ROLE_NAMES.entries()) {
    await controller.write.grantRole([role(r), holders[i].account.address], { account: admin.account });
  }
  const client = await viem.getPublicClient();
  return {
    controller, client, admin, custodian, verifier, outsider, holder,
    attackers: [a1, a2, a3, a4, a5],
    chainId: await client.getChainId(),
    now: (await client.getBlock()).timestamp,
    signers: [custodian, administrator, valuation, legal, verifier],
  };
}
type Env = Awaited<ReturnType<typeof deploy>>;

// Honest state: 100 eligible against 99 liabilities (BCR 101%).
const honest = (now: bigint, epoch = 1n) =>
  makeSnapshot(now, {
    epoch,
    grossReserves: usd("101"), eligibleReserves: usd("100"), liquidAssets: usd("20"),
    tokenLiabilities: usd("99"), pendingRedemptions: 0n, otherLiabilities: 0n,
  });
// The same state with eligible reserves inflated by 50.
const inflated = (now: bigint, epoch = 1n) => ({ ...honest(now, epoch), grossReserves: usd("151"), eligibleReserves: usd("150") });

async function signFull(wallet: any, env: Env, snap: any): Promise<Hex> {
  return wallet.signTypedData({
    account: wallet.account,
    domain: { name: "RWA-PoB", version: "1", chainId: env.chainId, verifyingContract: env.controller.address },
    types: snapshotTypes, primaryType: "Snapshot", message: snap,
  });
}

const rows: Record<string, string>[] = [];
const record = (id: string, threat: string, setting: string, outcome: string, evidence: string) =>
  rows.push({ id, threat, setting, outcome, evidence });

describe("Trust model: collusion, compromise, and liveness", function () {
  it("T1 a withholding signer halts snapshot updates (safety kept, liveness lost)", async function () {
    const env = await deploy();
    const s1 = honest(env.now);
    await env.controller.write.submitSnapshot([s1, await signSnapshot(env.signers, env.chainId, env.controller.address, s1)], { account: env.admin.account });
    await env.controller.write.requestRedemption([env.holder.account.address, usd("5")], { account: env.admin.account });
    const claimId = (await env.controller.read.nextRedemptionId()) - 1n;
    // The valuation agent withholds its signature for the next epoch.
    await networkHelpers.time.increase(3_600);
    const now = (await env.client.getBlock()).timestamp;
    const s2 = { ...honest(now, 2n), tokenLiabilities: usd("94"), tokenSupply: usd("94"), pendingRedemptions: usd("5") };
    const sigs = await signSnapshot(env.signers, env.chainId, env.controller.address, s2);
    await assert.rejects(env.controller.write.submitSnapshot([s2, [sigs[0], sigs[1], sigs[3], sigs[4]]], { account: env.admin.account }), /InvalidSignatureCount/);
    // After the last snapshot expires: no minting, new redemptions queue,
    // but the existing claim can still be settled from attested liquidity.
    await networkHelpers.time.increase(86_401);
    assert.equal(await env.controller.read.isSnapshotFresh(), false);
    assert.equal(await env.controller.read.canMint([usd("1")]), false);
    assert.equal(Number(await env.controller.read.redemptionDisposition([usd("1")])), 1);
    await env.controller.write.confirmSettlement([claimId, usd("5")], { account: env.admin.account });
    record("T1", "Absent or withholding signer", "role-scoped", "prevented (safety); liveness lost",
      "4-of-5 signatures rejected (InvalidSignatureCount); after expiry canMint=false and new redemptions queue; existing claim still settles");
  });

  it("T2 one compromised key: role-scoped vs single attestor", async function () {
    // Role-scoped: the verifier key alone (or with a forged custodian claim)
    // cannot move the eligible figure, which the valuation agent signs.
    const env = await deploy();
    const bad = inflated(env.now);
    const honestSigs = await signSnapshot(env.signers, env.chainId, env.controller.address, honest(env.now));
    const verifierOnBad = await signFull(env.verifier, env, bad);
    await assert.rejects(env.controller.write.submitSnapshot([bad, [honestSigs[0], honestSigs[1], honestSigs[2], honestSigs[3], verifierOnBad]], { account: env.admin.account }));
    record("T2a", "Compromised single key (verifier)", "role-scoped", "prevented",
      "inflated eligible reserves need the valuation-agent claim; snapshot rejected");
    // Single attestor: the one verifier key publishes the inflated state.
    const single = await deploy("SingleAttestor");
    const bad2 = inflated(single.now);
    await single.controller.write.submitSnapshot([bad2, [await signFull(single.verifier, single, bad2)]], { account: single.admin.account });
    assert.equal(await single.controller.read.currentEligibleReserves(), usd("150"));
    assert.equal(await single.controller.read.canMint([usd("40")]), true);
    record("T2b", "Compromised single key (verifier)", "single attestor", "not prevented",
      "one signature publishes eligible 150 instead of 100; a 40 mint becomes allowed");
  });

  it("T3 compromised governance can re-assign every role and lower the policy", async function () {
    const env = await deploy();
    const fake = env.attackers;
    for (const [i, r] of ROLE_NAMES.slice(0, 5).entries()) {
      await env.controller.write.grantRole([role(r), fake[i].account.address], { account: env.admin.account });
      const old = [env.signers[i]][0];
      await env.controller.write.revokeRole([role(r), old.account.address], { account: env.admin.account });
    }
    const bad = inflated(env.now);
    await env.controller.write.submitSnapshot([bad, await signSnapshot(fake, env.chainId, env.controller.address, bad)], { account: env.admin.account });
    await env.controller.write.setPolicy([POLICY_HASH, (50n * WAD) / 100n, 1n, 86_400n], { account: env.admin.account });
    assert.equal(await env.controller.read.currentEligibleReserves(), usd("150"));
    const granted = await env.client.getContractEvents({ address: env.controller.address, abi: env.controller.abi, eventName: "RoleGranted", fromBlock: 0n });
    const policy = await env.client.getContractEvents({ address: env.controller.address, abi: env.controller.abi, eventName: "PolicyUpdated", fromBlock: 0n });
    assert.ok(granted.length >= 12 && policy.length === 1);
    record("T3", "Compromised governance (DEFAULT_ADMIN_ROLE)", "role-scoped", "logged; governance remedy only",
      "admin re-assigned all five roles to attacker keys, published eligible 150 and lowered thresholds; RoleGranted/RoleRevoked/PolicyUpdated events emitted");
  });

  it("T4 all five roles sign an internally consistent false state", async function () {
    const env = await deploy();
    const bad = inflated(env.now);
    await env.controller.write.submitSnapshot([bad, await signSnapshot(env.signers, env.chainId, env.controller.address, bad)], { account: env.admin.account });
    assert.equal(await env.controller.read.isSnapshotFresh(), true);
    record("T4", "Collusion of all roles / consistent false statement", "role-scoped", "out-of-scope (on-chain)",
      "accepted; detectable only by off-chain reconciliation against the position file or external records");
  });

  it("T5 role reassignment: a revoked key can no longer sign, and the change is logged", async function () {
    const env = await deploy();
    const replacement = env.attackers[0];
    await env.controller.write.revokeRole([role("CUSTODIAN_ROLE"), env.custodian.account.address], { account: env.admin.account });
    await env.controller.write.grantRole([role("CUSTODIAN_ROLE"), replacement.account.address], { account: env.admin.account });
    const s = honest(env.now);
    await assert.rejects(env.controller.write.submitSnapshot([s, await signSnapshot(env.signers, env.chainId, env.controller.address, s)], { account: env.admin.account }), /SignerHasNoRequiredRole/);
    const rotated = [replacement, ...env.signers.slice(1)];
    await env.controller.write.submitSnapshot([s, await signSnapshot(rotated, env.chainId, env.controller.address, s)], { account: env.admin.account });
    // One address may not hold two required roles.
    await env.controller.write.grantRole([role("LEGAL_ROLE"), replacement.account.address], { account: env.admin.account });
    await networkHelpers.time.increase(60);
    const now = (await env.client.getBlock()).timestamp;
    const s2 = honest(now, 2n);
    await assert.rejects(env.controller.write.submitSnapshot([s2, await signSnapshot(rotated, env.chainId, env.controller.address, s2)], { account: env.admin.account }), /SignerHasMultipleRequiredRoles/);
    record("T5", "Role reassignment / one key holding two roles", "role-scoped", "prevented; logged",
      "revoked custodian rejected (SignerHasNoRequiredRole); one address with two roles rejected (SignerHasMultipleRequiredRoles); five addresses of one institution cannot be distinguished");
  });

  it("T6 snapshot expiry while redemptions are pending", async function () {
    const env = await deploy();
    const s = honest(env.now);
    await env.controller.write.submitSnapshot([s, await signSnapshot(env.signers, env.chainId, env.controller.address, s)], { account: env.admin.account });
    assert.equal(Number(await env.controller.read.redemptionDisposition([usd("10")])), 0);
    await env.controller.write.requestRedemption([env.holder.account.address, usd("10")], { account: env.admin.account });
    const first = (await env.controller.read.nextRedemptionId()) - 1n;
    assert.equal(Number((await env.controller.read.redemptions([first]))[3]), 0); // instant
    await networkHelpers.time.increase(86_401);
    await env.controller.write.requestRedemption([env.holder.account.address, usd("5")], { account: env.admin.account });
    const second = (await env.controller.read.nextRedemptionId()) - 1n;
    assert.equal(Number((await env.controller.read.redemptions([second]))[3]), 1); // queued
    await env.controller.write.confirmSettlement([first, usd("10")], { account: env.admin.account });
    assert.equal(await env.controller.read.currentPendingRedemptions(), usd("5"));
    record("T6", "Snapshot expiry during redemptions", "role-scoped", "prevented (fail-safe)",
      "after expiry new requests are queued and minting stops; settlement of earlier claims continues within attested liquidity");
  });

  it("writes the trust-model table", async function () {
    assert.equal(rows.length, 7);
    const esc = (v: string) => (/[",]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    await writeFile("data/results/trust-model-results.csv",
      ["id,threat,setting,outcome,evidence", ...rows.map((r) => Object.values(r).map(esc).join(","))].join("\n") + "\n");
  });
});
