// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PoBPolicyController} from "../PoBPolicyController.sol";

/// @title Ablation variants of the RWA-PoB controller (test only)
/// @notice Same accounting, receipts, settlement and Merkle challenge as
///         PoBPolicyController, with two switches used only to isolate the
///         contribution of each feature in the evaluation:
///         - singleAttestor: a snapshot is accepted on ONE signature over the
///           full EIP-712 snapshot digest by any VERIFIER_ROLE holder,
///           instead of five role-scoped claims;
///         - liquidityPolicy = false: no RLC condition on minting, and every
///           redemption is classified instant while the snapshot is fresh.
///         Do not deploy.
contract AblationController is PoBPolicyController {
    bool public immutable singleAttestor;
    bool public immutable liquidityPolicy;

    constructor(
        bytes32 initialPolicyHash,
        uint256 initialMinimumBCR,
        uint256 initialMinimumRLC,
        uint64 initialMaximumSnapshotAge,
        bool singleAttestor_,
        bool liquidityPolicy_
    )
        PoBPolicyController(
            initialPolicyHash,
            initialMinimumBCR,
            initialMinimumRLC,
            initialMaximumSnapshotAge
        )
    {
        singleAttestor = singleAttestor_;
        liquidityPolicy = liquidityPolicy_;
    }

    function _verifyRoleScopedSignatures(
        Snapshot calldata snapshot,
        bytes32 fullSnapshotDigest,
        bytes[] calldata signatures
    ) internal view override {
        if (!singleAttestor) {
            super._verifyRoleScopedSignatures(snapshot, fullSnapshotDigest, signatures);
            return;
        }
        if (signatures.length != 1) {
            revert InvalidSignatureCount();
        }
        address signer = ECDSA.recover(fullSnapshotDigest, signatures[0]);
        if (!hasRole(VERIFIER_ROLE, signer)) {
            revert MissingRequiredRole();
        }
    }

    function canMint(uint256 mintUnits) public view override returns (bool) {
        if (liquidityPolicy) return super.canMint(mintUnits);
        if (!isSnapshotFresh() || mintUnits == 0) return false;
        return bcrAfterMint(mintUnits) >= minimumBCR;
    }

    function canMintWithReceipt(uint256 mintUnits, uint256 receivedCash)
        public
        view
        override
        returns (bool)
    {
        if (liquidityPolicy) return super.canMintWithReceipt(mintUnits, receivedCash);
        if (!isSnapshotFresh() || mintUnits == 0) return false;
        uint256 liabilities = mintCheckLiabilities(mintUnits);
        return ((currentEligibleReserves() + receivedCash) * WAD) / liabilities >= minimumBCR;
    }

    function redemptionDisposition(uint256 redemptionValue)
        public
        view
        override
        returns (RedemptionDisposition)
    {
        if (liquidityPolicy) return super.redemptionDisposition(redemptionValue);
        return isSnapshotFresh() ? RedemptionDisposition.Instant : RedemptionDisposition.Queue;
    }
}
