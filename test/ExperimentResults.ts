import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { formatUnits, keccak256, toBytes, type Hex } from "viem";

import {
  POLICY_HASH,
  WAD,
  makeSnapshot,
  signSnapshot,
  usd,
} from "./helpers.js";

const { viem } = await hre.network.create();

const SCENARIO_DIRECTORY = "data/input/usdy-scenarios";
const BPS_DENOMINATOR = 10_000n;
const OTHER_LIABILITY_BPS = 50n; // 0.5% controlled assumption
const REDEMPTION_REQUEST_BPS = 500n; // 5% of observed token value

function csvEscape(value: string | bigint | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function ratioToPercent(ratioWad: bigint): string {
  // Two decimal places in percentage-point form, rounded half up (v2; the
  // submitted version truncated to four decimals, e.g. 199.9999).
  const scaled = (ratioWad * 10_000n + WAD / 2n) / WAD;
  const whole = scaled / 100n;
  const fraction = (scaled % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

type ScenarioSummary = {
  scenario: string;
  description: string;
  liabilityDate: string;
  tokenLiabilitiesUsd: string;
  grossReservesUsd: string;
  eligibleReservesUsd: string;
  liquidAssetsUsd: string;
  merkleRoot: Hex;
};

async function loadScenario(name: string): Promise<ScenarioSummary> {
  const path = `${SCENARIO_DIRECTORY}/${name}-summary.json`;
  return JSON.parse(await readFile(path, "utf8")) as ScenarioSummary;
}

describe("RWA-PoB USDY-calibrated experiment", function () {
  it("writes reproducible scenario and gas results", async function () {
    const wallets = await viem.getWalletClients();
    const [admin, custodian, administrator, valuation, legal, verifier] = wallets;

    const controller = await viem.deployContract("PoBPolicyController", [
      POLICY_HASH,
      (105n * WAD) / 100n,
      WAD,
      86_400n,
    ]);
    const baseline = await viem.deployContract("AggregatePoRBaseline");

    const assignments = [
      ["CUSTODIAN_ROLE", custodian.account.address],
      ["ADMINISTRATOR_ROLE", administrator.account.address],
      ["VALUATION_ROLE", valuation.account.address],
      ["LEGAL_ROLE", legal.account.address],
      ["VERIFIER_ROLE", verifier.account.address],
    ] as const;

    for (const [name, address] of assignments) {
      await controller.write.grantRole([keccak256(toBytes(name)), address], {
        account: admin.account,
      });
    }

    const client = await viem.getPublicClient();
    const chainId = await client.getChainId();
    const signers = [custodian, administrator, valuation, legal, verifier];

    const scenarioDefinitions = [
      {
        name: "valid",
        expectedBaselineMint: true,
        expectedPobMint: true,
        expectedDisposition: "instant",
      },
      {
        name: "encumbered-assets",
        expectedBaselineMint: true,
        expectedPobMint: false,
        expectedDisposition: "instant",
      },
      {
        name: "liquidity-stress",
        expectedBaselineMint: true,
        expectedPobMint: true,
        expectedDisposition: "queue",
      },
    ] as const;

    const scenarioRows: Array<Record<string, string | bigint | boolean>> = [];
    const gasRows: Array<Record<string, string | bigint>> = [];

    let epoch = 1n;

    for (const definition of scenarioDefinitions) {
      const scenario = await loadScenario(definition.name);
      const currentBlock = await client.getBlock();

      const tokenLiabilities = usd(scenario.tokenLiabilitiesUsd);
      const grossReserves = usd(scenario.grossReservesUsd);
      const eligibleReserves = usd(scenario.eligibleReservesUsd);
      const liquidAssets = usd(scenario.liquidAssetsUsd);
      const otherLiabilities =
        (tokenLiabilities * OTHER_LIABILITY_BPS) / BPS_DENOMINATOR;
      const redemptionRequest =
        (tokenLiabilities * REDEMPTION_REQUEST_BPS) / BPS_DENOMINATOR;

      const snapshot = makeSnapshot(currentBlock.timestamp, {
        epoch,
        reserveRoot: scenario.merkleRoot,
        grossReserves,
        eligibleReserves,
        liquidAssets,
        tokenLiabilities,
        pendingRedemptions: 0n,
        otherLiabilities,
      });

      const signatures = await signSnapshot(
        signers,
        chainId,
        controller.address,
        snapshot,
      );

      const submitHash = await controller.write.submitSnapshot(
        [snapshot, signatures],
        { account: admin.account },
      );
      const submitReceipt = await client.getTransactionReceipt({
        hash: submitHash,
      });
      gasRows.push({
        operation: `submitSnapshot:${definition.name}`,
        gasUsed: submitReceipt.gasUsed,
      });

      const baselineHash = await baseline.write.updateReport([
        snapshot.grossReserves,
        snapshot.tokenLiabilities,
        snapshot.validUntil,
      ]);
      const baselineReceipt = await client.getTransactionReceipt({
        hash: baselineHash,
      });
      gasRows.push({
        operation: `baselineReport:${definition.name}`,
        gasUsed: baselineReceipt.gasUsed,
      });

      const baselineMint = await baseline.read.canMint([usd("1")]);
      const pobMint = await controller.read.canMint([usd("1")]);
      const dispositionCode = await controller.read.redemptionDisposition([
        redemptionRequest,
      ]);
      const redemptionDisposition = dispositionCode === 0 ? "instant" : "queue";

      const bcr = (await controller.read.currentBCR()) as bigint;
      const postRequestRlc =
        redemptionRequest === 0n
          ? 2n ** 256n - 1n
          : (liquidAssets * WAD) / redemptionRequest;

      assert.equal(
        baselineMint,
        definition.expectedBaselineMint,
        `${definition.name}: unexpected baseline mint decision`,
      );
      assert.equal(
        pobMint,
        definition.expectedPobMint,
        `${definition.name}: unexpected RWA-PoB mint decision`,
      );
      assert.equal(
        redemptionDisposition,
        definition.expectedDisposition,
        `${definition.name}: unexpected redemption disposition`,
      );

      scenarioRows.push({
        scenario: definition.name,
        description: scenario.description,
        liabilityDate: scenario.liabilityDate,
        tokenLiabilitiesUsd: scenario.tokenLiabilitiesUsd,
        grossReservesUsd: scenario.grossReservesUsd,
        eligibleReservesUsd: scenario.eligibleReservesUsd,
        liquidAssetsUsd: scenario.liquidAssetsUsd,
        redemptionRequestUsd: formatUnits(redemptionRequest, 18),
        baselineMint,
        pobMint,
        redemptionDisposition,
        bcrPercent: ratioToPercent(bcr),
        postRequestRlcPercent: ratioToPercent(postRequestRlc),
        reserveRoot: scenario.merkleRoot,
      });

      epoch += 1n;
    }

    await mkdir("data/results", { recursive: true });

    const scenarioHeaders = [
      "scenario",
      "description",
      "liabilityDate",
      "tokenLiabilitiesUsd",
      "grossReservesUsd",
      "eligibleReservesUsd",
      "liquidAssetsUsd",
      "redemptionRequestUsd",
      "baselineMint",
      "pobMint",
      "redemptionDisposition",
      "bcrPercent",
      "postRequestRlcPercent",
      "reserveRoot",
    ];

    const scenarioCsv = [
      scenarioHeaders.join(","),
      ...scenarioRows.map((row) =>
        scenarioHeaders.map((key) => csvEscape(row[key])).join(","),
      ),
    ].join("\n");

    const gasCsv = [
      "operation,gasUsed",
      ...gasRows.map(
        (row) => `${csvEscape(row.operation)},${csvEscape(row.gasUsed)}`,
      ),
    ].join("\n");

    await writeFile("data/results/scenario-results.csv", `${scenarioCsv}\n`);
    await writeFile("data/results/gas-results.csv", `${gasCsv}\n`);

    assert.equal(scenarioRows.length, 3);
  });
});
