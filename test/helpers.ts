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
    { name: "tokenSupply", type: "uint256" },
    { name: "redemptionPrice", type: "uint256" },
  ],
} as const;

/// v1 snapshot type (as submitted), used only by signSnapshotV1.
export const snapshotTypesV1 = {
  Snapshot: snapshotTypes.Snapshot.slice(0, 11),
} as const;

const claimHeader = [
  { name: "epoch", type: "uint64" },
  { name: "asOfTimestamp", type: "uint64" },
  { name: "validUntil", type: "uint64" },
  { name: "policyHash", type: "bytes32" },
  { name: "reserveRoot", type: "bytes32" },
] as const;

/// Role-scoped EIP-712 claim types (v2). Signatures are produced in the
/// fixed role order: custodian, administrator, valuation, legal, verifier.
export const roleClaimTypes = [
  {
    primaryType: "CustodyClaim",
    types: {
      CustodyClaim: [...claimHeader, { name: "grossReserves", type: "uint256" }],
    },
    fields: ["grossReserves"],
  },
  {
    primaryType: "LiabilityClaim",
    types: {
      LiabilityClaim: [
        ...claimHeader,
        { name: "tokenLiabilities", type: "uint256" },
        { name: "pendingRedemptions", type: "uint256" },
        { name: "otherLiabilities", type: "uint256" },
        { name: "tokenSupply", type: "uint256" },
        { name: "redemptionPrice", type: "uint256" },
      ],
    },
    fields: ["tokenLiabilities", "pendingRedemptions", "otherLiabilities", "tokenSupply", "redemptionPrice"],
  },
  {
    primaryType: "ValuationClaim",
    types: {
      ValuationClaim: [
        ...claimHeader,
        { name: "eligibleReserves", type: "uint256" },
        { name: "liquidAssets", type: "uint256" },
      ],
    },
    fields: ["eligibleReserves", "liquidAssets"],
  },
  {
    primaryType: "LegalClaim",
    types: { LegalClaim: [...claimHeader] },
    fields: [],
  },
  { primaryType: "Snapshot", types: snapshotTypes, fields: null },
] as const;

export function roleClaimMessage(roleIndex: number, snapshot: Snapshot) {
  const claim = roleClaimTypes[roleIndex];
  if (claim.fields === null) return snapshot;
  const message: Record<string, unknown> = {
    epoch: snapshot.epoch,
    asOfTimestamp: snapshot.asOfTimestamp,
    validUntil: snapshot.validUntil,
    policyHash: snapshot.policyHash,
    reserveRoot: snapshot.reserveRoot,
  };
  for (const field of claim.fields) {
    message[field] = snapshot[field as keyof Snapshot];
  }
  return message;
}

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
  tokenSupply: bigint;
  redemptionPrice: bigint;
};

/// USD liability of `units` at `price` (18 decimals), rounded up as on-chain.
export function liabilityOf(units: bigint, price: bigint): bigint {
  return (units * price + WAD - 1n) / WAD;
}

/// Completes a unit-price snapshot: tokenSupply = tokenLiabilities, price 1.
export function unitPrice<T extends Omit<Snapshot, "tokenSupply" | "redemptionPrice"> & Partial<Snapshot>>(s: T): Snapshot {
  return { ...s, tokenSupply: s.tokenSupply ?? s.tokenLiabilities, redemptionPrice: s.redemptionPrice ?? WAD } as Snapshot;
}

export function makeSnapshot(
  now: bigint,
  overrides: Partial<Snapshot> = {},
): Snapshot {
  return unitPrice({
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
  });
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

  // wallets[i] signs the claim of role i (custodian, administrator,
  // valuation, legal, verifier). Each role signs only its own fields.
  const signatures: Hex[] = [];
  for (const [index, wallet] of wallets.entries()) {
    const claim = roleClaimTypes[Math.min(index, roleClaimTypes.length - 1)];
    const signature = await wallet.signTypedData({
      account: wallet.account,
      domain,
      types: claim.types,
      primaryType: claim.primaryType,
      message: roleClaimMessage(index, snapshot),
    });
    signatures.push(signature as Hex);
  }
  return signatures;
}

/// v1 signing (as submitted): every role signs the complete snapshot.
/// Used only to reproduce the v1-vs-v2 comparison.
export async function signSnapshotV1(
  wallets: any[],
  chainId: number,
  verifyingContract: Address,
  snapshot: Snapshot,
): Promise<Hex[]> {
  const domain = { name: "RWA-PoB", version: "1", chainId, verifyingContract } as const;
  const signatures: Hex[] = [];
  for (const wallet of wallets) {
    signatures.push(
      (await wallet.signTypedData({
        account: wallet.account,
        domain,
        types: snapshotTypesV1,
        primaryType: "Snapshot",
        message: snapshot,
      })) as Hex,
    );
  }
  return signatures;
}

export async function signSubscriptionReceipt(
  custodian: any,
  chainId: number,
  verifyingContract: Address,
  receipt: { epoch: bigint; amount: bigint; nonce: bigint },
): Promise<Hex> {
  return (await custodian.signTypedData({
    account: custodian.account,
    domain: { name: "RWA-PoB", version: "1", chainId, verifyingContract },
    types: {
      SubscriptionReceipt: [
        { name: "epoch", type: "uint64" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SubscriptionReceipt",
    message: receipt,
  })) as Hex;
}

/// One signature over the complete (v2) snapshot digest, as the verifier
/// signs it. Used for the single-attestor ablation.
export async function signFullSnapshot(
  wallet: any,
  chainId: number,
  verifyingContract: Address,
  snapshot: Snapshot,
): Promise<Hex[]> {
  const domain = { name: "RWA-PoB", version: "1", chainId, verifyingContract } as const;
  return [
    (await wallet.signTypedData({
      account: wallet.account,
      domain,
      types: snapshotTypes,
      primaryType: "Snapshot",
      message: snapshot,
    })) as Hex,
  ];
}
