import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { keccak256, toBytes, type Hash } from "viem";

import {
  POLICY_HASH,
  WAD,
  makeSnapshot,
  signSnapshot,
  usd,
} from "./helpers.js";

const { viem, networkHelpers } = await hre.network.create();

const SAMPLE_COUNT = 10;
const MINT_AMOUNT = usd("1000000");
const ISSUED_AMOUNT = usd("10000000");
const REDEMPTION_AMOUNT = usd("4000000");
const PARTIAL_PAYMENT = usd("1500000");

type GasRow = {
  operation: string;
  repetition: number;
  gasUsed: bigint;
};

type GasSummary = {
  operation: string;
  samples: number;
  minimum: bigint;
  median: bigint;
  maximum: bigint;
};

async function deployUnsignedFixture() {
  const wallets = await viem.getWalletClients();
  const [
    governance,
    custodian,
    administrator,
    valuation,
    legal,
    verifier,
    holder,
    settlement,
  ] = wallets;

  const controller = await viem.deployContract("PoBPolicyController", [
    POLICY_HASH,
    (105n * WAD) / 100n,
    WAD,
    86_400n,
  ]);
  const baseline = await viem.deployContract("AggregatePoRBaseline");
  const token = await viem.deployContract("RWABackedToken", [
    controller.address,
    governance.account.address,
  ]);
  const advisoryAdapter = await viem.deployContract(
    "ControllerBypassHarness",
  );
  const independentToken = await viem.deployContract(
    "IndependentMintToken",
    [governance.account.address],
  );

  const roleAssignments = [
    ["CUSTODIAN_ROLE", custodian.account.address],
    ["ADMINISTRATOR_ROLE", administrator.account.address],
    ["VALUATION_ROLE", valuation.account.address],
    ["LEGAL_ROLE", legal.account.address],
    ["VERIFIER_ROLE", verifier.account.address],
    ["TOKEN_ROLE", token.address],
    ["SETTLEMENT_ROLE", settlement.account.address],
  ] as const;

  for (const [roleName, address] of roleAssignments) {
    await controller.write.grantRole(
      [keccak256(toBytes(roleName)), address],
      { account: governance.account },
    );
  }
  await controller.write.revokeRole(
    [keccak256(toBytes("SETTLEMENT_ROLE")), governance.account.address],
    { account: governance.account },
  );

  const client = await viem.getPublicClient();
  const chainId = await client.getChainId();
  const block = await client.getBlock();
  const snapshot = makeSnapshot(block.timestamp);
  const signatures = await signSnapshot(
    [custodian, administrator, valuation, legal, verifier],
    chainId,
    controller.address,
    snapshot,
  );

  return {
    governance,
    holder,
    settlement,
    controller,
    baseline,
    token,
    advisoryAdapter,
    independentToken,
    client,
    snapshot,
    signatures,
  };
}

async function deployReadyFixture() {
  const env = await networkHelpers.loadFixture(deployUnsignedFixture);
  await env.controller.write.submitSnapshot(
    [env.snapshot, env.signatures],
    { account: env.governance.account },
  );
  return env;
}

async function deployAdvisoryFixture() {
  const env = await networkHelpers.loadFixture(deployReadyFixture);
  await env.controller.write.grantRole(
    [
      keccak256(toBytes("TOKEN_ROLE")),
      env.advisoryAdapter.address,
    ],
    { account: env.governance.account },
  );
  return env;
}

async function deployIssuedFixture() {
  const env = await networkHelpers.loadFixture(deployReadyFixture);
  await env.token.write.issue(
    [env.holder.account.address, ISSUED_AMOUNT],
    { account: env.governance.account },
  );
  return env;
}

async function deployRedemptionFixture() {
  const env = await networkHelpers.loadFixture(deployIssuedFixture);
  await env.token.write.requestRedemption([REDEMPTION_AMOUNT], {
    account: env.holder.account,
  });
  return env;
}

async function deployPartialSettlementFixture() {
  const env = await networkHelpers.loadFixture(deployRedemptionFixture);
  await env.controller.write.confirmSettlement([1n, PARTIAL_PAYMENT], {
    account: env.settlement.account,
  });
  return env;
}

async function gasUsed(hash: Hash, client: Awaited<ReturnType<typeof viem.getPublicClient>>) {
  const receipt = await client.getTransactionReceipt({ hash });
  return receipt.gasUsed;
}

async function collectSamples<T>(
  operation: string,
  fixture: () => Promise<T>,
  execute: (env: T) => Promise<{ hash: Hash; client: Awaited<ReturnType<typeof viem.getPublicClient>> }>,
  rows: GasRow[],
) {
  for (let repetition = 1; repetition <= SAMPLE_COUNT; repetition += 1) {
    const env = await networkHelpers.loadFixture(fixture);
    const { hash, client } = await execute(env);
    rows.push({
      operation,
      repetition,
      gasUsed: await gasUsed(hash, client),
    });
  }
}

function summarize(rows: GasRow[]): GasSummary[] {
  const operations = [...new Set(rows.map((row) => row.operation))];
  return operations.map((operation) => {
    const values = rows
      .filter((row) => row.operation === operation)
      .map((row) => row.gasUsed)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const middle = values.length / 2;
    const median =
      values.length % 2 === 0
        ? (values[middle - 1] + values[middle]) / 2n
        : values[Math.floor(middle)];
    return {
      operation,
      samples: values.length,
      minimum: values[0],
      median,
      maximum: values[values.length - 1],
    };
  });
}

describe("Atomic controller-token gas evaluation", function () {
  it("writes repeated raw measurements and summary statistics", async function () {
    const rows: GasRow[] = [];

    await collectSamples(
      "submitSnapshot",
      deployUnsignedFixture,
      async (env) => ({
        hash: await env.controller.write.submitSnapshot(
          [env.snapshot, env.signatures],
          { account: env.governance.account },
        ),
        client: env.client,
      }),
      rows,
    );

    await collectSamples(
      "aggregatePoRReport",
      deployUnsignedFixture,
      async (env) => ({
        hash: await env.baseline.write.updateReport([
          env.snapshot.grossReserves,
          env.snapshot.tokenLiabilities,
          env.snapshot.validUntil,
        ]),
        client: env.client,
      }),
      rows,
    );

    await collectSamples(
      "advisoryAuthorization",
      deployAdvisoryFixture,
      async (env) => ({
        hash: await env.advisoryAdapter.write.attemptMintAuthorization([
          env.controller.address,
          MINT_AMOUNT,
        ]),
        client: env.client,
      }),
      rows,
    );

    await collectSamples(
      "independentTokenMint",
      deployUnsignedFixture,
      async (env) => ({
        hash: await env.independentToken.write.mint([
          env.holder.account.address,
          MINT_AMOUNT,
        ], { account: env.governance.account }),
        client: env.client,
      }),
      rows,
    );

    await collectSamples(
      "atomicIssue",
      deployReadyFixture,
      async (env) => ({
        hash: await env.token.write.issue(
          [env.holder.account.address, MINT_AMOUNT],
          { account: env.governance.account },
        ),
        client: env.client,
      }),
      rows,
    );

    await collectSamples(
      "redemptionRequest",
      deployIssuedFixture,
      async (env) => ({
        hash: await env.token.write.requestRedemption([
          REDEMPTION_AMOUNT,
        ], { account: env.holder.account }),
        client: env.client,
      }),
      rows,
    );

    await collectSamples(
      "partialSettlement",
      deployRedemptionFixture,
      async (env) => ({
        hash: await env.controller.write.confirmSettlement(
          [1n, PARTIAL_PAYMENT],
          { account: env.settlement.account },
        ),
        client: env.client,
      }),
      rows,
    );

    await collectSamples(
      "finalSettlement",
      deployPartialSettlementFixture,
      async (env) => ({
        hash: await env.controller.write.confirmSettlement(
          [1n, REDEMPTION_AMOUNT - PARTIAL_PAYMENT],
          { account: env.settlement.account },
        ),
        client: env.client,
      }),
      rows,
    );

    const summaries = summarize(rows);
    assert.equal(rows.length, 8 * SAMPLE_COUNT);
    assert.equal(summaries.length, 8);
    assert.equal(summaries.every((summary) => summary.samples === SAMPLE_COUNT), true);

    const advisory = summaries.find(
      (summary) => summary.operation === "advisoryAuthorization",
    );
    const independent = summaries.find(
      (summary) => summary.operation === "independentTokenMint",
    );
    const atomic = summaries.find(
      (summary) => summary.operation === "atomicIssue",
    );
    assert.ok(advisory && independent && atomic);

    const comparisonRows = [
      {
        comparison: "atomic_vs_advisory_only",
        atomicGas: atomic.median,
        comparisonGas: advisory.median,
        deltaGas: atomic.median - advisory.median,
      },
      {
        comparison: "atomic_vs_two_transaction_sum",
        atomicGas: atomic.median,
        comparisonGas: advisory.median + independent.median,
        deltaGas:
          atomic.median - (advisory.median + independent.median),
      },
    ];

    await mkdir("data/results", { recursive: true });
    await writeFile(
      "data/results/atomic-gas-raw.csv",
      [
        "operation,repetition,gasUsed",
        ...rows.map(
          (row) => `${row.operation},${row.repetition},${row.gasUsed}`,
        ),
      ].join("\n") + "\n",
    );
    await writeFile(
      "data/results/atomic-gas-summary.csv",
      [
        "operation,samples,minimum,median,maximum",
        ...summaries.map(
          (summary) =>
            `${summary.operation},${summary.samples},${summary.minimum},${summary.median},${summary.maximum}`,
        ),
      ].join("\n") + "\n",
    );
    await writeFile(
      "data/results/atomic-gas-comparison.csv",
      [
        "comparison,atomicGas,comparisonGas,deltaGas",
        ...comparisonRows.map(
          (row) =>
            `${row.comparison},${row.atomicGas},${row.comparisonGas},${row.deltaGas}`,
        ),
      ].join("\n") + "\n",
    );
  });
});
