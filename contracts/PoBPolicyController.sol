// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title RWA-PoB Policy Controller
/// @notice Research prototype. Values use 18-decimal fixed-point USD units.
/// @dev The contract authenticates institutional claims; it does not prove
///      that off-chain statements are true.
///
///      v2 changes (response to review):
///      - Role-scoped attestations: each snapshot role signs an EIP-712 claim
///        that covers only the fields it is responsible for, plus a common
///        header (epoch, times, policy, reserve root). Only the independent
///        verifier signs the complete snapshot.
///      - Settlement is propagated to liquid, eligible, and gross reserves, so
///        BCR is no longer overstated between snapshots.
///      - Position-level Merkle verification and a permissionless challenge
///        that suspends an accepted snapshot when a committed position
///        contradicts the eligibility rules.
///      - Custodian-signed subscription receipts: a mint can count its own
///        confirmed subscription cash atomically (authorizeMintWithReceipt).
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
    uint256 private constant BPS = 10_000;

    /// @dev Signatures are supplied in this fixed role order.
    uint8 public constant CUSTODIAN_INDEX = 0;
    uint8 public constant ADMINISTRATOR_INDEX = 1;
    uint8 public constant VALUATION_INDEX = 2;
    uint8 public constant LEGAL_INDEX = 3;
    uint8 public constant VERIFIER_INDEX = 4;

    bytes32 public constant CUSTODY_CLAIM_TYPEHASH = keccak256(
        "CustodyClaim(uint64 epoch,uint64 asOfTimestamp,uint64 validUntil,bytes32 policyHash,bytes32 reserveRoot,uint256 grossReserves)"
    );
    bytes32 public constant LIABILITY_CLAIM_TYPEHASH = keccak256(
        "LiabilityClaim(uint64 epoch,uint64 asOfTimestamp,uint64 validUntil,bytes32 policyHash,bytes32 reserveRoot,uint256 tokenLiabilities,uint256 pendingRedemptions,uint256 otherLiabilities)"
    );
    bytes32 public constant VALUATION_CLAIM_TYPEHASH = keccak256(
        "ValuationClaim(uint64 epoch,uint64 asOfTimestamp,uint64 validUntil,bytes32 policyHash,bytes32 reserveRoot,uint256 eligibleReserves,uint256 liquidAssets)"
    );
    bytes32 public constant SUBSCRIPTION_RECEIPT_TYPEHASH = keccak256(
        "SubscriptionReceipt(uint64 epoch,uint256 amount,uint256 nonce)"
    );
    bytes32 public constant LEGAL_CLAIM_TYPEHASH = keccak256(
        "LegalClaim(uint64 epoch,uint64 asOfTimestamp,uint64 validUntil,bytes32 policyHash,bytes32 reserveRoot)"
    );

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

    /// @notice One reserve position as committed in the reserve Merkle tree
    ///         (OpenZeppelin StandardMerkleTree leaf encoding). USD values
    ///         use 6 decimals, as in the published position files.
    struct ReservePosition {
        string positionId;
        string instrumentId;
        uint256 faceValue;
        uint256 marketValue;
        uint256 eligibleValue;
        uint256 liquidValue;
        uint256 maturityDays;
        uint256 haircutBps;
        bool encumbered;
        bool legallyEligible;
        bool settlementFinal;
    }

    enum ChallengeReason {
        None,
        EncumberedButEligible,
        LegallyIneligibleButEligible,
        UnsettledButEligible,
        EligibleExceedsHaircutValue,
        LiquidExceedsEligible
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
    /// @notice Settled redemption cash paid out after the latest snapshot.
    ///         Settlement is assumed to be paid from eligible liquid cash, so
    ///         it reduces liquid, eligible, and gross reserves alike.
    uint256 public liquidAssetsConsumed;
    /// @notice Subscription cash received after the latest snapshot and
    ///         confirmed by a custodian-signed receipt. It is credited to
    ///         gross, eligible, and liquid reserves until the next snapshot.
    uint256 public creditedSubscriptionCash;
    mapping(bytes32 => bool) public usedSubscriptionReceipts;

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
    event ReservePositionChallenged(
        uint64 indexed epoch,
        bytes32 indexed leaf,
        ChallengeReason reason,
        address challenger
    );
    event SubscriptionCashCredited(
        uint64 indexed epoch,
        uint256 amount,
        uint256 nonce,
        address custodian
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
    error InvalidMerkleProof();
    error PositionIsConsistent();
    error InvalidSubscriptionReceipt();

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
        _verifyRoleScopedSignatures(snapshot, digest, signatures);

        _latestSnapshot = snapshot;
        latestSnapshotDigest = digest;
        usedSnapshotDigests[digest] = true;
        currentSnapshotRevoked = false;

        additionalMintLiabilities = 0;
        tokenLiabilitiesMovedToPending = 0;
        settledPendingLiabilities = 0;
        liquidAssetsConsumed = 0;
        creditedSubscriptionCash = 0;

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
        uint256 liquid =
            _latestSnapshot.liquidAssets + creditedSubscriptionCash;
        if (liquidAssetsConsumed >= liquid) {
            return 0;
        }
        return liquid - liquidAssetsConsumed;
    }

    /// @notice Eligible reserves after post-snapshot settlement outflows.
    function currentEligibleReserves() public view returns (uint256) {
        uint256 eligible =
            _latestSnapshot.eligibleReserves + creditedSubscriptionCash;
        if (liquidAssetsConsumed >= eligible) {
            return 0;
        }
        return eligible - liquidAssetsConsumed;
    }

    /// @notice Gross reserves after post-snapshot settlement outflows.
    function currentGrossReserves() public view returns (uint256) {
        uint256 gross =
            _latestSnapshot.grossReserves + creditedSubscriptionCash;
        if (liquidAssetsConsumed >= gross) {
            return 0;
        }
        return gross - liquidAssetsConsumed;
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
        return (currentEligibleReserves() * WAD) / liabilities;
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
        return (currentEligibleReserves() * WAD) / postMintLiabilities;
    }

    function canMint(uint256 mintLiability) public view virtual returns (bool) {
        if (!isSnapshotFresh() || mintLiability == 0) {
            return false;
        }
        return
            bcrAfterMint(mintLiability) >= minimumBCR &&
            currentRLC() >= minimumRLC;
    }

    /// @notice Policy check for a mint whose cash is confirmed by a custodian
    ///         receipt: `receivedCash` (the subscription plus any issuer
    ///         buffer top-up) is counted in eligible and liquid reserves
    ///         together with the new liability.
    function canMintWithReceipt(uint256 mintLiability, uint256 receivedCash)
        public
        view
        virtual
        returns (bool)
    {
        if (!isSnapshotFresh() || mintLiability == 0) {
            return false;
        }
        uint256 liabilities = currentTotalLiabilities() + mintLiability;
        uint256 bcr = ((currentEligibleReserves() + receivedCash) * WAD) /
            liabilities;
        uint256 pending = currentPendingRedemptions();
        uint256 rlc = pending == 0
            ? type(uint256).max
            : ((currentLiquidAssets() + receivedCash) * WAD) / pending;
        return bcr >= minimumBCR && rlc >= minimumRLC;
    }

    /// @notice Atomically credits custodian-confirmed cash and authorizes the
    ///         mint. The receipt is an EIP-712 statement by a CUSTODIAN_ROLE
    ///         account that `receivedCash` (18-decimal USD) arrived in the
    ///         segregated cash account during the current epoch. If the policy
    ///         check fails the whole call reverts, so no cash is credited for
    ///         a rejected mint (the subscriber is refunded off-chain).
    function authorizeMintWithReceipt(
        uint256 mintLiability,
        uint256 receivedCash,
        uint256 nonce,
        bytes calldata custodianSignature
    ) external onlyRole(TOKEN_ROLE) {
        if (
            _latestSnapshot.epoch == 0 ||
            mintLiability == 0 ||
            receivedCash == 0
        ) {
            revert InvalidSubscriptionReceipt();
        }
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SUBSCRIPTION_RECEIPT_TYPEHASH,
                    _latestSnapshot.epoch,
                    receivedCash,
                    nonce
                )
            )
        );
        if (usedSubscriptionReceipts[digest]) {
            revert InvalidSubscriptionReceipt();
        }
        address signer = ECDSA.recover(digest, custodianSignature);
        if (!hasRole(CUSTODIAN_ROLE, signer)) {
            revert InvalidSubscriptionReceipt();
        }
        if (!canMintWithReceipt(mintLiability, receivedCash)) {
            revert MintPolicyFailed();
        }
        usedSubscriptionReceipts[digest] = true;
        creditedSubscriptionCash += receivedCash;
        additionalMintLiabilities += mintLiability;
        emit SubscriptionCashCredited(
            _latestSnapshot.epoch,
            receivedCash,
            nonce,
            signer
        );
        emit MintAuthorized(mintLiability, currentTotalLiabilities());
    }

    /// @notice Records a mint authorization. Subscription cash counts toward
    ///         reserves only once it is in the latest snapshot or credited by a
    ///         custodian-signed receipt (authorizeMintWithReceipt).
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
        virtual
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

    // ------------------------------------------------------------------
    // Position-level Merkle verification and challenge
    // ------------------------------------------------------------------

    function reservePositionLeaf(ReservePosition calldata p)
        public
        pure
        returns (bytes32)
    {
        // abi.encode(p) of a struct with dynamic members is one offset word
        // (0x20) followed by abi.encode(p.positionId, ..., p.settlementFinal),
        // which is the OpenZeppelin StandardMerkleTree leaf preimage. Hashing
        // past the offset word avoids a stack-too-deep 11-argument encode.
        bytes memory encoded = abi.encode(p);
        bytes32 inner;
        assembly ("memory-safe") {
            inner := keccak256(add(encoded, 64), sub(mload(encoded), 32))
        }
        return keccak256(bytes.concat(inner));
    }

    /// @notice True when `p` is committed in the latest accepted reserve root.
    function verifyReservePosition(
        ReservePosition calldata p,
        bytes32[] calldata proof
    ) public view returns (bool) {
        if (_latestSnapshot.epoch == 0) {
            return false;
        }
        return MerkleProof.verifyCalldata(
            proof,
            _latestSnapshot.reserveRoot,
            reservePositionLeaf(p)
        );
    }

    /// @notice Checks a committed position against the eligibility rules of
    ///         Eq. (2)-(3): an encumbered, legally ineligible, or unsettled
    ///         position must contribute zero eligible value; eligible value may
    ///         not exceed the haircut market value; liquid value may not exceed
    ///         eligible value.
    function positionInconsistency(ReservePosition calldata p)
        public
        pure
        returns (ChallengeReason)
    {
        if (p.eligibleValue > 0) {
            if (p.encumbered) return ChallengeReason.EncumberedButEligible;
            if (!p.legallyEligible) {
                return ChallengeReason.LegallyIneligibleButEligible;
            }
            if (!p.settlementFinal) return ChallengeReason.UnsettledButEligible;
        }
        if (
            p.haircutBps > BPS ||
            p.eligibleValue > (p.marketValue * (BPS - p.haircutBps)) / BPS
        ) {
            return ChallengeReason.EligibleExceedsHaircutValue;
        }
        if (p.liquidValue > p.eligibleValue) {
            return ChallengeReason.LiquidExceedsEligible;
        }
        return ChallengeReason.None;
    }

    /// @notice Permissionless fraud proof. Anyone holding the published
    ///         position file can show that a position committed under the
    ///         accepted root violates the eligibility rules. The snapshot is
    ///         then suspended: minting stops and redemptions are queued until
    ///         all roles sign a corrected snapshot.
    function challengeReservePosition(
        ReservePosition calldata p,
        bytes32[] calldata proof
    ) external returns (ChallengeReason reason) {
        if (!verifyReservePosition(p, proof)) {
            revert InvalidMerkleProof();
        }
        reason = positionInconsistency(p);
        if (reason == ChallengeReason.None) {
            revert PositionIsConsistent();
        }
        currentSnapshotRevoked = true;
        emit ReservePositionChallenged(
            _latestSnapshot.epoch,
            reservePositionLeaf(p),
            reason,
            msg.sender
        );
        emit SnapshotRevoked(_latestSnapshot.epoch, latestSnapshotDigest);
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

    /// @notice EIP-712 digest that the signer at `roleIndex` must sign.
    function hashRoleClaim(uint8 roleIndex, Snapshot calldata snapshot)
        external
        view
        returns (bytes32)
    {
        return _roleClaimDigest(roleIndex, snapshot, _snapshotDigest(snapshot));
    }

    function _roleClaimDigest(
        uint8 roleIndex,
        Snapshot calldata s,
        bytes32 fullSnapshotDigest
    ) internal view returns (bytes32) {
        if (roleIndex == VERIFIER_INDEX) {
            return fullSnapshotDigest;
        }
        bytes32 structHash;
        if (roleIndex == CUSTODIAN_INDEX) {
            structHash = keccak256(
                abi.encode(
                    CUSTODY_CLAIM_TYPEHASH,
                    s.epoch,
                    s.asOfTimestamp,
                    s.validUntil,
                    s.policyHash,
                    s.reserveRoot,
                    s.grossReserves
                )
            );
        } else if (roleIndex == ADMINISTRATOR_INDEX) {
            structHash = keccak256(
                abi.encode(
                    LIABILITY_CLAIM_TYPEHASH,
                    s.epoch,
                    s.asOfTimestamp,
                    s.validUntil,
                    s.policyHash,
                    s.reserveRoot,
                    s.tokenLiabilities,
                    s.pendingRedemptions,
                    s.otherLiabilities
                )
            );
        } else if (roleIndex == VALUATION_INDEX) {
            structHash = keccak256(
                abi.encode(
                    VALUATION_CLAIM_TYPEHASH,
                    s.epoch,
                    s.asOfTimestamp,
                    s.validUntil,
                    s.policyHash,
                    s.reserveRoot,
                    s.eligibleReserves,
                    s.liquidAssets
                )
            );
        } else if (roleIndex == LEGAL_INDEX) {
            structHash = keccak256(
                abi.encode(
                    LEGAL_CLAIM_TYPEHASH,
                    s.epoch,
                    s.asOfTimestamp,
                    s.validUntil,
                    s.policyHash,
                    s.reserveRoot
                )
            );
        } else {
            revert MissingRequiredRole();
        }
        return _hashTypedDataV4(structHash);
    }

    function _verifyRoleScopedSignatures(
        Snapshot calldata snapshot,
        bytes32 fullSnapshotDigest,
        bytes[] calldata signatures
    ) internal view virtual {
        if (signatures.length != REQUIRED_SIGNATURES) {
            revert InvalidSignatureCount();
        }

        uint256 roleMask;
        address[] memory recoveredSigners = new address[](signatures.length);

        for (uint256 i = 0; i < signatures.length; ++i) {
            bytes32 claimDigest =
                _roleClaimDigest(uint8(i), snapshot, fullSnapshotDigest);
            address signer = ECDSA.recover(claimDigest, signatures[i]);

            for (uint256 j = 0; j < i; ++j) {
                if (recoveredSigners[j] == signer) {
                    revert DuplicateSigner();
                }
            }
            recoveredSigners[i] = signer;

            uint256 roleBit = _requiredRoleBit(signer);
            // Signature i must come from the holder of role i, so that a
            // signer can only vouch for the fields of its own claim.
            if (roleBit != (1 << i)) {
                revert MissingRequiredRole();
            }
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
