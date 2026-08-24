// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPoBPolicyController} from
    "./interfaces/IPoBPolicyController.sol";

/// @title RWA-PoB Backed Token
/// @notice Research prototype that atomically couples token supply changes to
///         the RWA-PoB controller's liability accounting.
/// @dev The prototype assumes one 18-decimal token unit creates one
///      18-decimal USD liability unit. Products with a changing NAV require an
///      authenticated conversion and rounding policy.
contract RWABackedToken is ERC20, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    IPoBPolicyController public immutable pobController;

    event Issued(address indexed recipient, uint256 amount);
    event RedemptionInitiated(
        uint256 indexed redemptionId,
        address indexed holder,
        uint256 amount,
        uint8 disposition
    );

    error ZeroAddress();
    error ZeroAmount();

    constructor(address controller, address governance)
        ERC20("RWA Proof-of-Backing Token", "RWA-PoB")
    {
        if (controller == address(0) || governance == address(0)) {
            revert ZeroAddress();
        }

        pobController = IPoBPolicyController(controller);
        _grantRole(DEFAULT_ADMIN_ROLE, governance);
        _grantRole(ISSUER_ROLE, governance);
    }

    /// @notice Issues tokens only after the controller records and approves
    ///         an exactly equal liability increase.
    /// @dev If either the controller call or `_mint` reverts, the entire EVM
    ///      transaction rolls back.
    function issue(address recipient, uint256 amount)
        external
        onlyRole(ISSUER_ROLE)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        pobController.authorizeMint(amount);
        _mint(recipient, amount);

        emit Issued(recipient, amount);
    }

    /// @notice Burns a holder's tokens and atomically reclassifies the same
    ///         value as a pending redemption in the controller.
    /// @dev The burn is rolled back if the controller rejects the request.
    function requestRedemption(uint256 amount)
        external
        returns (uint256 redemptionId, uint8 disposition)
    {
        if (amount == 0) revert ZeroAmount();

        _burn(msg.sender, amount);
        (redemptionId, disposition) =
            pobController.requestRedemption(msg.sender, amount);

        emit RedemptionInitiated(
            redemptionId,
            msg.sender,
            amount,
            disposition
        );
    }
}
