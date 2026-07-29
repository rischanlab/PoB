// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Aggregate PoR baseline
/// @notice Minimal comparison model that checks only gross reserves against
///         reported token liabilities. It deliberately ignores legal
///         eligibility, encumbrance, liquidity, and multi-party credentials.
contract AggregatePoRBaseline is AccessControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint256 public grossReserves;
    uint256 public tokenLiabilities;
    uint256 public additionalMintLiabilities;
    uint64 public validUntil;

    event ReportUpdated(
        uint256 grossReserves,
        uint256 tokenLiabilities,
        uint64 validUntil
    );
    event MintAuthorized(uint256 mintLiability, uint256 liabilitiesAfterMint);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    function updateReport(
        uint256 newGrossReserves,
        uint256 newTokenLiabilities,
        uint64 newValidUntil
    ) external onlyRole(OPERATOR_ROLE) {
        require(newValidUntil > block.timestamp, "PoR: expired report");
        grossReserves = newGrossReserves;
        tokenLiabilities = newTokenLiabilities;
        additionalMintLiabilities = 0;
        validUntil = newValidUntil;
        emit ReportUpdated(newGrossReserves, newTokenLiabilities, newValidUntil);
    }

    function liabilitiesAfterMint(uint256 mintLiability)
        public
        view
        returns (uint256)
    {
        return tokenLiabilities + additionalMintLiabilities + mintLiability;
    }

    function canMint(uint256 mintLiability) public view returns (bool) {
        if (block.timestamp > validUntil) {
            return false;
        }
        return grossReserves >= liabilitiesAfterMint(mintLiability);
    }

    function authorizeMint(uint256 mintLiability)
        external
        onlyRole(OPERATOR_ROLE)
    {
        require(canMint(mintLiability), "PoR: insufficient gross reserves");
        additionalMintLiabilities += mintLiability;
        emit MintAuthorized(mintLiability, liabilitiesAfterMint(0));
    }
}
