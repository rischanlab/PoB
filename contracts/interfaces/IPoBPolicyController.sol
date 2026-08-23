// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Minimal interface used by an RWA-PoB-backed token
/// @notice Amounts use the controller's 18-decimal USD-liability units.
interface IPoBPolicyController {
    function authorizeMint(uint256 mintLiability) external;

    function requestRedemption(address beneficiary, uint256 redemptionValue)
        external
        returns (uint256 redemptionId, uint8 disposition);
}
