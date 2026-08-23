// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoBPolicyController} from
    "../interfaces/IPoBPolicyController.sol";

/// @notice Test-only contract used to prove that an unregistered contract
///         cannot impersonate the backed token or mutate controller liabilities.
contract ControllerBypassHarness {
    function attemptMintAuthorization(address controller, uint256 amount)
        external
    {
        IPoBPolicyController(controller).authorizeMint(amount);
    }

    function attemptRedemption(
        address controller,
        address beneficiary,
        uint256 amount
    ) external {
        IPoBPolicyController(controller).requestRedemption(
            beneficiary,
            amount
        );
    }
}
