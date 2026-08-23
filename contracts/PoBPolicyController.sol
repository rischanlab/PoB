// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title RWA-PoB Policy Controller
/// @notice Research prototype. Values use 18-decimal fixed-point USD units.
/// @dev The contract authenticates institutional claims; it does not prove
///      that off-chain statements are true.
contract PoBPolicyController is AccessControl, EIP712 {
    uint256 public constant WAD = 1e18;

    bytes32 public constant CUSTODIAN_ROLE = keccak256("CUSTODIAN_ROLE");
    bytes32 public constant ADMINISTRATOR_ROLE =
        keccak256("ADMINISTRATOR_ROLE");
    bytes32 public constant VALUATION_ROLE = keccak256("VALUATION_ROLE");
    bytes32 public constant LEGAL_ROLE = keccak256("LEGAL_ROLE");
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    /// @notice Assigned only to token contracts or liability adapters whose
    ///         supply transitions are atomically coupled to this controller.
    bytes32 public constant TOKEN_ROLE = keccak256("TOKEN_ROLE");
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    uint256 private constant CUSTODIAN_BIT = 1 << 0;
    uint256 private constant ADMINISTRATOR_BIT = 1 << 1;
    uint256 private constant VALUATION_BIT = 1 << 2;
    uint256 private constant LEGAL_BIT = 1 << 3;
    uint256 private constant VERIFIER_BIT = 1 << 4;
    uint256 private constant REQUIRED_ROLE_MASK =
        CUSTODIAN_BIT |
        ADMINISTRATOR_BIT |
        VALUATION_BIT |
        LEGAL_BIT |
        VERIFIER_BIT;
    uint256 private constant REQUIRED_SIGNATURES = 5;

    bytes32 public constant SNAPSHOT_TYPEHASH = keccak256(
        "Snapshot(uint64 epoch,uint64 asOfTimestamp,uint64 validUntil,bytes32 reserveRoot,bytes32 policyHash,uint256 grossReserves,uint256 eligibleReserves,uint256 liquidAssets,uint256 tokenLiabilities,uint256 pendingRedemptions,uint256 otherLiabilities)"
    );

    enum RedemptionDisposition {
        Instant,
        Queue
    }

    struct Snapshot {
        uint64 epoch;
        uint64 asOfTimestamp;
        uint64 validUntil;
        bytes32 reserveRoot;
        bytes32 policyHash;
        uint256 grossReserves;
        uint256 eligibleReserves;
        uint256 liquidAssets;
        uint256 tokenLiabilities;
        uint256 pendingRedemptions;
        uint256 otherLiabilities;
    }

    struct Redemption {
        address beneficiary;
        uint256 requestedValue;
        uint256 settledValue;
        RedemptionDisposition disposition;
        bool closed;
    }

    Snapshot private _latestSnapshot;
    bytes32 public latestSnapshotDigest;
    bool public currentSnapshotRevoked;
    mapping(bytes32 => bool) public usedSnapshotDigests;

    bytes32 public activePolicyHash;
    uint256 public minimumBCR;
    uint256 public minimumRLC;
    uint64 public maximumSnapshotAge;

    // State changes after the latest signed snapshot.
    uint256 public additionalMintLiabilities;
    uint256 public tokenLiabilitiesMovedToPending;
    uint256 public settledPendingLiabilities;
    uint256 public liquidAssetsConsumed;

    uint256 public nextRedemptionId = 1;
    mapping(uint256 => Redemption) public redemptions;

    event SnapshotAccepted(
        uint64 indexed epoch,
        bytes32 indexed digest,
        uint256 bcr,
        uint256 rlc
    );
    event SnapshotRevoked(uint64 indexed epoch, bytes32 indexed digest);
    event MintAuthorized(uint256 mintLiability, uint256 liabilitiesAfterMint);
    event RedemptionRequested(
        uint256 indexed redemptionId,
        address indexed beneficiary,
        uint256 value,
        RedemptionDisposition disposition
    );
    event RedemptionSettled(
        uint256 indexed redemptionId,
        uint256 amount,
        uint256 totalSettled
    );
    event PolicyUpdated(
        bytes32 indexed policyHash,
        uint256 minimumBCR,
        uint256 minimumRLC,
        uint64 maximumSnapshotAge
    );

    error InvalidSnapshotEpoch();
    error InvalidSnapshotTime();
    error SnapshotExpired();
    error SnapshotTooOld();
    error InvalidSnapshotValues();
    error InvalidPolicyHash();
    error SnapshotReplay();
    error InvalidSignatureCount();
    error DuplicateSigner();
    error DuplicateRole();
    error MissingRequiredRole();
    error SignerHasNoRequiredRole();
    error SignerHasMultipleRequiredRoles();
    error LiabilityContinuityFailure();
    error NoValidSnapshot();
    error MintPolicyFailed();
    error InvalidRedemptionAmount();
    error InsufficientPendingLiability();
    error InsufficientLiquidAssets();

    constructor(
        bytes32 initialPolicyHash,
        uint256 initialMinimumBCR,
        uint256 initialMinimumRLC,
        uint64 initialMaximumSnapshotAge
    ) EIP712("RWA-PoB", "1") {
        require(initialPolicyHash != bytes32(0), "PoB: zero policy hash");
        require(initialMinimumBCR > 0, "PoB: zero BCR threshold");
        require(initialMinimumRLC > 0, "PoB: zero RLC threshold");
        require(initialMaximumSnapshotAge > 0, "PoB: zero max age");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SETTLEMENT_ROLE, msg.sender);

        activePolicyHash = initialPolicyHash;
        minimumBCR = initialMinimumBCR;
        minimumRLC = initialMinimumRLC;
        maximumSnapshotAge = initialMaximumSnapshotAge;
    }

    function latestSnapshot() external view returns (Snapshot memory) {
        return _latestSnapshot;
    }

    function setPolicy(
        bytes32 newPolicyHash,
        uint256 newMinimumBCR,
        uint256 newMinimumRLC,
        uint64 newMaximumSnapshotAge
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newPolicyHash != bytes32(0), "PoB: zero policy hash");
        require(newMinimumBCR > 0, "PoB: zero BCR threshold");
        require(newMinimumRLC > 0, "PoB: zero RLC threshold");
        require(newMaximumSnapshotAge > 0, "PoB: zero max age");

        activePolicyHash = newPolicyHash;
        minimumBCR = newMinimumBCR;
        minimumRLC = newMinimumRLC;
        maximumSnapshotAge = newMaximumSnapshotAge;

        emit PolicyUpdated(
            newPolicyHash,
            newMinimumBCR,
            newMinimumRLC,
            newMaximumSnapshotAge
        );
    }

    function hashSnapshot(Snapshot calldata snapshot)
        external
        view
        returns (bytes32)
    {
        return _snapshotDigest(snapshot);
    }

    function submitSnapshot(
        Snapshot calldata snapshot,
        bytes[] calldata signatures
    ) external {
        _validateSnapshot(snapshot);

        if (_latestSnapshot.epoch != 0) {
            if (
                snapshot.tokenLiabilities != currentTokenLiabilities() ||
                snapshot.pendingRedemptions != currentPendingRedemptions()
            ) {
                revert LiabilityContinuityFailure();
            }
        }

        bytes32 digest = _snapshotDigest(snapshot);
        if (usedSnapshotDigests[digest]) {
            revert SnapshotReplay();
        }
        _verifyRequiredSignatures(digest, signatures);

        _latestSnapshot = snapshot;
        latestSnapshotDigest = digest;
        usedSnapshotDigests[digest] = true;
        currentSnapshotRevoked = false;

        additionalMintLiabilities = 0;
        tokenLiabilitiesMovedToPending = 0;
        settledPendingLiabilities = 0;
        liquidAssetsConsumed = 0;

        emit SnapshotAccepted(
            snapshot.epoch,
            digest,
            currentBCR(),
            currentRLC()
        );
    }

    function revokeCurrentSnapshot() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_latestSnapshot.epoch == 0) {
            revert NoValidSnapshot();
        }
        currentSnapshotRevoked = true;
        emit SnapshotRevoked(_latestSnapshot.epoch, latestSnapshotDigest);
    }

    function isSnapshotFresh() public view returns (bool) {
        if (_latestSnapshot.epoch == 0 || currentSnapshotRevoked) {
            return false;
        }
        if (_latestSnapshot.policyHash != activePolicyHash) {
            return false;
        }
        if (block.timestamp > _latestSnapshot.validUntil) {
            return false;
        }
        if (block.timestamp < _latestSnapshot.asOfTimestamp) {
            return false;
        }
        return
            block.timestamp - _latestSnapshot.asOfTimestamp <=
            maximumSnapshotAge;
    }

    function currentTokenLiabilities() public view returns (uint256) {
        return
            _latestSnapshot.tokenLiabilities +
            additionalMintLiabilities -
            tokenLiabilitiesMovedToPending;
    }

    function currentPendingRedemptions() public view returns (uint256) {
        return
            _latestSnapshot.pendingRedemptions +
            tokenLiabilitiesMovedToPending -
            settledPendingLiabilities;
    }

    function currentLiquidAssets() public view returns (uint256) {
        if (liquidAssetsConsumed >= _latestSnapshot.liquidAssets) {
            return 0;
        }
        return _latestSnapshot.liquidAssets - liquidAssetsConsumed;
    }

    function currentTotalLiabilities() public view returns (uint256) {
        return
            currentTokenLiabilities() +
            currentPendingRedemptions() +
            _latestSnapshot.otherLiabilities;
    }

    function currentBCR() public view returns (uint256) {
        uint256 liabilities = currentTotalLiabilities();
        if (liabilities == 0) {
            return type(uint256).max;
        }
        return (_latestSnapshot.eligibleReserves * WAD) / liabilities;
    }

    function currentRLC() public view returns (uint256) {
        uint256 pending = currentPendingRedemptions();
        if (pending == 0) {
            return type(uint256).max;
        }
        return (currentLiquidAssets() * WAD) / pending;
    }

    function bcrAfterMint(uint256 mintLiability)
        public
        view
        returns (uint256)
    {
        uint256 postMintLiabilities = currentTotalLiabilities() + mintLiability;
        if (postMintLiabilities == 0) {
            return type(uint256).max;
        }
        return
            (_latestSnapshot.eligibleReserves * WAD) / postMintLiabilities;
    }

    function canMint(uint256 mintLiability) public view returns (bool) {
        if (!isSnapshotFresh() || mintLiability == 0) {
            return false;
        }
        return
            bcrAfterMint(mintLiability) >= minimumBCR &&
            currentRLC() >= minimumRLC;
    }

    /// @notice Records a mint authorization. The prototype assumes incoming
    ///         subscription funds have already settled and are included in the
    ///         latest eligible reserve snapshot.
    function authorizeMint(uint256 mintLiability)
        external
        onlyRole(TOKEN_ROLE)
    {
        if (!canMint(mintLiability)) {
            revert MintPolicyFailed();
        }
        additionalMintLiabilities += mintLiability;
        emit MintAuthorized(mintLiability, currentTotalLiabilities());
    }

    function redemptionDisposition(uint256 redemptionValue)
        public
        view
        returns (RedemptionDisposition)
    {
        if (!isSnapshotFresh()) {
            return RedemptionDisposition.Queue;
        }
        uint256 pendingAfter = currentPendingRedemptions() + redemptionValue;
        if (pendingAfter == 0) {
            return RedemptionDisposition.Instant;
        }
        uint256 postRequestRLC = (currentLiquidAssets() * WAD) / pendingAfter;
        if (postRequestRLC >= minimumRLC) {
            return RedemptionDisposition.Instant;
        }
        return RedemptionDisposition.Queue;
    }

    function requestRedemption(address beneficiary, uint256 redemptionValue)
        external
        onlyRole(TOKEN_ROLE)
        returns (uint256 redemptionId, RedemptionDisposition disposition)
    {
        if (
            beneficiary == address(0) ||
            redemptionValue == 0 ||
            redemptionValue > currentTokenLiabilities()
        ) {
            revert InvalidRedemptionAmount();
        }

        disposition = redemptionDisposition(redemptionValue);
        tokenLiabilitiesMovedToPending += redemptionValue;

        redemptionId = nextRedemptionId++;
        redemptions[redemptionId] = Redemption({
            beneficiary: beneficiary,
            requestedValue: redemptionValue,
            settledValue: 0,
            disposition: disposition,
            closed: false
        });

        emit RedemptionRequested(
            redemptionId,
            beneficiary,
            redemptionValue,
            disposition
        );
    }

    function confirmSettlement(uint256 redemptionId, uint256 settlementValue)
        external
        onlyRole(SETTLEMENT_ROLE)
    {
        Redemption storage redemption = redemptions[redemptionId];
        if (
            redemption.beneficiary == address(0) ||
            redemption.closed ||
            settlementValue == 0
        ) {
            revert InvalidRedemptionAmount();
        }

        uint256 remaining =
            redemption.requestedValue - redemption.settledValue;
        if (settlementValue > remaining) {
            revert InsufficientPendingLiability();
        }
        if (settlementValue > currentLiquidAssets()) {
            revert InsufficientLiquidAssets();
        }

        redemption.settledValue += settlementValue;
        settledPendingLiabilities += settlementValue;
        liquidAssetsConsumed += settlementValue;

        if (redemption.settledValue == redemption.requestedValue) {
            redemption.closed = true;
        }

        emit RedemptionSettled(
            redemptionId,
            settlementValue,
            redemption.settledValue
        );
    }

    function _validateSnapshot(Snapshot calldata snapshot) internal view {
        if (snapshot.epoch <= _latestSnapshot.epoch) {
            revert InvalidSnapshotEpoch();
        }
        if (
            snapshot.asOfTimestamp > block.timestamp ||
            snapshot.validUntil <= snapshot.asOfTimestamp
        ) {
            revert InvalidSnapshotTime();
        }
        if (snapshot.validUntil <= block.timestamp) {
            revert SnapshotExpired();
        }
        if (
            block.timestamp - snapshot.asOfTimestamp > maximumSnapshotAge
        ) {
            revert SnapshotTooOld();
        }
        if (
            snapshot.policyHash != activePolicyHash ||
            snapshot.policyHash == bytes32(0)
        ) {
            revert InvalidPolicyHash();
        }
        if (
            snapshot.reserveRoot == bytes32(0) ||
            snapshot.eligibleReserves > snapshot.grossReserves ||
            snapshot.liquidAssets > snapshot.eligibleReserves
        ) {
            revert InvalidSnapshotValues();
        }
    }

    function _snapshotDigest(Snapshot calldata snapshot)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                SNAPSHOT_TYPEHASH,
                snapshot.epoch,
                snapshot.asOfTimestamp,
                snapshot.validUntil,
                snapshot.reserveRoot,
                snapshot.policyHash,
                snapshot.grossReserves,
                snapshot.eligibleReserves,
                snapshot.liquidAssets,
                snapshot.tokenLiabilities,
                snapshot.pendingRedemptions,
                snapshot.otherLiabilities
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function _verifyRequiredSignatures(
        bytes32 digest,
        bytes[] calldata signatures
    ) internal view {
        if (signatures.length != REQUIRED_SIGNATURES) {
            revert InvalidSignatureCount();
        }

        uint256 roleMask;
        address[] memory recoveredSigners = new address[](signatures.length);

        for (uint256 i = 0; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);

            for (uint256 j = 0; j < i; ++j) {
                if (recoveredSigners[j] == signer) {
                    revert DuplicateSigner();
                }
            }
            recoveredSigners[i] = signer;

            uint256 roleBit = _requiredRoleBit(signer);
            if ((roleMask & roleBit) != 0) {
                revert DuplicateRole();
            }
            roleMask |= roleBit;
        }

        if (roleMask != REQUIRED_ROLE_MASK) {
            revert MissingRequiredRole();
        }
    }

    function _requiredRoleBit(address signer)
        internal
        view
        returns (uint256)
    {
        uint256 bit;
        uint256 count;

        if (hasRole(CUSTODIAN_ROLE, signer)) {
            bit = CUSTODIAN_BIT;
            ++count;
        }
        if (hasRole(ADMINISTRATOR_ROLE, signer)) {
            bit = ADMINISTRATOR_BIT;
            ++count;
        }
        if (hasRole(VALUATION_ROLE, signer)) {
            bit = VALUATION_BIT;
            ++count;
        }
        if (hasRole(LEGAL_ROLE, signer)) {
            bit = LEGAL_BIT;
            ++count;
        }
        if (hasRole(VERIFIER_ROLE, signer)) {
            bit = VERIFIER_BIT;
            ++count;
        }

        if (count == 0) {
            revert SignerHasNoRequiredRole();
        }
        if (count > 1) {
            revert SignerHasMultipleRequiredRoles();
        }
        return bit;
    }
}
