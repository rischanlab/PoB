import { keccak256, parseUnits, toBytes, type Address, type Hex } from "viem";

export const WAD = 10n ** 18n;
export const usd = (value: string) => parseUnits(value, 18);

export const POLICY_HASH = keccak256(toBytes("RWA-PoB policy v1"));
export const RESERVE_ROOT = keccak256(toBytes("synthetic reserve tree root v1"));

export const snapshotTypes = {
  Snapshot: [
    { name: "epoch", type: "uint64" },
    { name: "asOfTimestamp", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "reserveRoot", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "grossReserves", type: "uint256" },
    { name: "eligibleReserves", type: "uint256" },
    { name: "liquidAssets", type: "uint256" },
    { name: "tokenLiabilities", type: "uint256" },
    { name: "pendingRedemptions", type: "uint256" },
    { name: "otherLiabilities", type: "uint256" },
  ],
} as const;

export type Snapshot = {
  epoch: bigint;
  asOfTimestamp: bigint;
  validUntil: bigint;
  reserveRoot: Hex;
  policyHash: Hex;
  grossReserves: bigint;
  eligibleReserves: bigint;
  liquidAssets: bigint;
  tokenLiabilities: bigint;
  pendingRedemptions: bigint;
  otherLiabilities: bigint;
};

export function makeSnapshot(
  now: bigint,
  overrides: Partial<Snapshot> = {},
): Snapshot {
  return {
    epoch: 1n,
    asOfTimestamp: now,
    validUntil: now + 86_400n,
    reserveRoot: RESERVE_ROOT,
    policyHash: POLICY_HASH,
    grossReserves: usd("1050000000"),
    eligibleReserves: usd("1020000000"),
    liquidAssets: usd("120000000"),
    tokenLiabilities: usd("900000000"),
    pendingRedemptions: 0n,
    otherLiabilities: usd("10000000"),
    ...overrides,
  };
}

export async function signSnapshot(
  wallets: any[],
  chainId: number,
  verifyingContract: Address,
  snapshot: Snapshot,
): Promise<Hex[]> {
  const domain = {
    name: "RWA-PoB",
    version: "1",
    chainId,
    verifyingContract,
  } as const;

  const signatures: Hex[] = [];
  for (const wallet of wallets) {
    const signature = await wallet.signTypedData({
      account: wallet.account,
      domain,
      types: snapshotTypes,
      primaryType: "Snapshot",
      message: snapshot,
    });
    signatures.push(signature as Hex);
  }
  return signatures;
}
