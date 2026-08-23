# Atomic Controller-Token Contribution: Phase A Baseline

## Status

Phase A was executed successfully on 2026-08-23 (Asia/Jakarta) before adding
the atomic controller-token implementation.

Feature branch:

```text
feature/atomic-controller-token
```

Baseline source commit:

```text
d14b8a5e0ac27ab7985685ddd136ef42fc9d9d8a
```

Commit date and subject:

```text
2026-07-29T16:48:26+07:00
fixed unsupported a simple equation
```

The working tree already contained a `package.json` modification, the paper
PDF, and `your-contribution-roadmap.md`. These were preserved and were not
treated as baseline contract changes.

## Environment

```text
Operating system: Windows (PowerShell)
Node.js:         v24.18.0
npm:             12.0.1
Hardhat:         3.11.1
Git:             2.55.0.windows.3
Solidity:        0.8.28 (configured)
Optimizer:       enabled, 200 runs
```

Installed top-level packages:

```text
@nomicfoundation/hardhat-toolbox-viem 5.0.7
@openzeppelin/contracts              5.6.1
@openzeppelin/merkle-tree            1.0.8
@types/node                          22.20.1
hardhat                              3.11.1
typescript                           5.9.3
viem                                 2.55.10
```

`package-lock.json` SHA-256:

```text
76DF0DACF151A3F20B5CAE7802B9A1EED4E5B9EF2EE9016F3105C5D8F3E3F9A5
```

`npm ci` completed successfully. npm reported 21 dependency audit findings:
11 low, 6 moderate, and 4 high. This baseline records the report without
running `npm audit fix`, because dependency mutation would invalidate the
locked baseline and needs a separate reviewed change.

## Commands executed

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run generate:data
npm.cmd test
npm.cmd run experiment
```

Compilation succeeded. Hardhat reported `No contracts to compile` because the
existing cached artifacts were current.

## Test baseline

The complete existing test suite passed:

```text
8 passing (8 nodejs)
```

This comprises one experiment-generation test and seven
`PoBPolicyController` tests:

1. complete mandatory-role snapshot acceptance;
2. missing mandatory signature rejection;
3. snapshot replay rejection;
4. eligible-reserve enforcement versus aggregate PoR;
5. liquidity-based redemption queuing;
6. pending-redemption liability retention until settlement; and
7. stale-snapshot mint suspension.

The standalone experiment also passed:

```text
1 passing (1 nodejs)
```

## Deterministic scenario baseline

The generator reproduced the committed policy inputs and Merkle roots:

| Scenario | Token liabilities | Eligible reserves | Liquid assets | Merkle root |
|---|---:|---:|---:|---|
| Valid | $2,161,765,036.997564 | $2,479,361,762.407983 | $216,176,503.699756 | `0x50363b2ecc5eb8f344003716a7de7645a678556583512712bbfab22f0ff47903` |
| Encumbered assets | $2,161,765,036.997564 | $2,093,076,978.470358 | $216,176,503.699756 | `0x51a3707a10405c3e7e5dee33a0fcdd516c6a7ec62bc920d86cabace46b14b9fe` |
| Liquidity stress | $2,161,765,036.997564 | $2,479,361,762.407983 | $43,235,300.739951 | `0xe949f27447550c77bc34bddb0d96ec6851f12bbf309a647311557189afd48b16` |

`data/results/scenario-results.csv` was content-identical to the committed
baseline after regeneration.

Scenario-results SHA-256:

```text
91A7FF37B094750AEFD5C304C570B74FD525CFFBD70F98A61F068F977B758F29
```

Policy decisions reproduced as follows:

| Scenario | Aggregate PoR mint | RWA-PoB mint | Redemption | BCR | Post-request RLC |
|---|---:|---:|---|---:|---:|
| Valid | Accept | Accept | Instant | 114.1209% | 199.9999% |
| Encumbered assets | Accept | Reject | Instant | 96.3408% | 199.9999% |
| Liquidity stress | Accept | Accept | Queue | 114.1209% | 39.9999% |

## Gas baseline and reproducibility observation

The regenerated gas results were:

| Operation | Gas used |
|---|---:|
| `submitSnapshot:valid` | 362,253 |
| `baselineReport:valid` | 94,689 |
| `submitSnapshot:encumbered-assets` | 194,904 |
| `baselineReport:encumbered-assets` | 37,789 |
| `submitSnapshot:liquidity-stress` | 197,704 |
| `baselineReport:liquidity-stress` | 37,789 |

Gas-results SHA-256:

```text
FB53F8A798D80765DFE5FD5AA43F8C6AE962541361239B6BD1B79D2B95EB96AD
```

Two snapshot gas observations differed from the previously committed CSV:

| Operation | Committed | Regenerated | Difference |
|---|---:|---:|---:|
| `submitSnapshot:valid` | 362,241 | 362,253 | +12 |
| `submitSnapshot:liquidity-stress` | 197,716 | 197,704 | -12 |

All policy decisions and scenario data were unchanged. A likely explanation is
calldata gas variation from timestamp-dependent EIP-712 signatures: different
signature bytes can contain a different number of zero bytes, which have a
different calldata gas cost. This is an inference and should be tested before
being stated as a confirmed cause.

Consequently, the experiment should not claim bit-identical gas CSV output
across runs until timestamps/signatures are fixed or the expected variation is
explicitly modeled. The atomic-architecture evaluation should use repeated
measurements and report median, minimum, maximum, and sample count.

## Phase A conclusion

The original functional baseline is established:

- contracts compile;
- all existing tests pass;
- scenario generation and Merkle roots reproduce;
- all policy decisions reproduce; and
- the gas baseline has been captured with a small reproducibility variation
  documented rather than hidden.

Phase B can now add the controller interface, backed token, atomic mint fixture,
and first supply-liability synchronization test.
