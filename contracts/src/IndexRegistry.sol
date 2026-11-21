// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "./interfaces/IIndexRegistry.sol";

/// @title IndexRegistry
/// @notice Append-only registry of versioned index methodologies. See {IIndexRegistry}.
/// @dev Properties this contract is built to keep, and that its tests assert:
///      - No owner, admin, pause, upgrade path, initializer, `delegatecall` or `selfdestruct`.
///      - No funds: there is no payable function, no `receive` and no `fallback`, so any call that carries value
///        or matches no function reverts. ETH forced in by other means is stuck, and nothing reads the balance.
///      - No external call of any kind.
///      - No function writes to a version after it is published.
///      - Every loop is bounded by MAX_CONSTITUENTS, and nothing iterates over all indexes.
///      - No assembly, no library, no constructor arguments, no immutables.
contract IndexRegistry is IIndexRegistry {
    /// @inheritdoc IIndexRegistry
    uint16 public constant BPS = 10_000;
    /// @inheritdoc IIndexRegistry
    uint32 public constant MAX_SPEC_BYTES = 8192;
    /// @inheritdoc IIndexRegistry
    uint16 public constant MAX_CONSTITUENTS = 128;

    /// @dev One storage slot: 160 + 32 + 64 bits.
    struct IndexRecord {
        address creator;
        // 0 means the index does not exist.
        uint32 latestVersion;
        // 0 means the index is active.
        uint64 deprecatedAt;
    }

    struct VersionRecord {
        bytes32 specHash;
        uint64 publishedAt;
        uint64 publishedBlock;
        Composition composition;
        bytes spec;
        Constituent[] constituents;
    }

    /// @dev Every index id, in creation order. Only ever appended to.
    bytes32[] private _indexIds;
    mapping(bytes32 indexId => IndexRecord) private _indexes;
    /// @dev Versions are 1-based. A slot is written exactly once, when its version is published.
    mapping(bytes32 indexId => mapping(uint32 version => VersionRecord)) private _versions;

    /// @inheritdoc IIndexRegistry
    function createIndex(
        bytes32 salt,
        bytes calldata spec,
        address[] calldata tokens,
        uint16[] calldata weightsBps
    )
        external
        returns (bytes32 indexId)
    {
        indexId = computeIndexId(msg.sender, salt);
        if (_indexes[indexId].latestVersion != 0) revert IndexAlreadyExists(indexId);

        _indexes[indexId] = IndexRecord({creator: msg.sender, latestVersion: 1, deprecatedAt: 0});
        _indexIds.push(indexId);
        emit IndexCreated(indexId, msg.sender, salt);

        _publish(indexId, 1, spec, tokens, weightsBps);
    }

    /// @inheritdoc IIndexRegistry
    function publishVersion(
        bytes32 indexId,
        uint32 expectedVersion,
        bytes calldata spec,
        address[] calldata tokens,
        uint16[] calldata weightsBps
    )
        external
        returns (uint32 version)
    {
        IndexRecord storage index = _indexes[indexId];
        uint32 latestVersion = index.latestVersion;
        if (latestVersion == 0) revert IndexNotFound(indexId);
        if (msg.sender != index.creator) revert NotCreator(indexId, msg.sender);
        if (index.deprecatedAt != 0) revert IndexIsDeprecated(indexId);

        // Checked arithmetic: at type(uint32).max versions this reverts and the index accepts no more.
        version = latestVersion + 1;
        if (expectedVersion != version) revert UnexpectedVersion(expectedVersion, version);

        index.latestVersion = version;
        _publish(indexId, version, spec, tokens, weightsBps);
    }

    /// @inheritdoc IIndexRegistry
    function deprecate(bytes32 indexId) external {
        IndexRecord storage index = _indexes[indexId];
        if (index.latestVersion == 0) revert IndexNotFound(indexId);
        if (msg.sender != index.creator) revert NotCreator(indexId, msg.sender);
        if (index.deprecatedAt != 0) revert IndexIsDeprecated(indexId);

        // A zero timestamp would leave the index active. It cannot happen on a live chain.
        index.deprecatedAt = uint64(block.timestamp);
        emit IndexDeprecated(indexId, msg.sender);
    }

    /// @inheritdoc IIndexRegistry
    function indexCount() external view returns (uint256) {
        return _indexIds.length;
    }

    /// @inheritdoc IIndexRegistry
    function indexIdAt(uint256 position) external view returns (bytes32) {
        uint256 count = _indexIds.length;
        if (position >= count) revert PositionOutOfBounds(position, count);
        return _indexIds[position];
    }

    /// @inheritdoc IIndexRegistry
    function exists(bytes32 indexId) external view returns (bool) {
        return _indexes[indexId].latestVersion != 0;
    }

    /// @inheritdoc IIndexRegistry
    function getIndex(bytes32 indexId) external view returns (IndexInfo memory) {
        IndexRecord storage index = _indexes[indexId];
        if (index.latestVersion == 0) revert IndexNotFound(indexId);
        return IndexInfo({
            creator: index.creator,
            latestVersion: index.latestVersion,
            createdAt: _versions[indexId][1].publishedAt,
            deprecatedAt: index.deprecatedAt
        });
    }

    /// @inheritdoc IIndexRegistry
    function getVersion(bytes32 indexId, uint32 version) external view returns (VersionInfo memory) {
        VersionRecord storage record = _version(indexId, version);
        // Both casts are lossless: the lengths were bounded by MAX_SPEC_BYTES and MAX_CONSTITUENTS at publish.
        return VersionInfo({
            specHash: record.specHash,
            publishedAt: record.publishedAt,
            publishedBlock: record.publishedBlock,
            composition: record.composition,
            specSize: uint32(record.spec.length),
            constituentCount: uint16(record.constituents.length)
        });
    }

    /// @inheritdoc IIndexRegistry
    function specOf(bytes32 indexId, uint32 version) external view returns (bytes memory) {
        return _version(indexId, version).spec;
    }

    /// @inheritdoc IIndexRegistry
    function constituentsOf(bytes32 indexId, uint32 version) external view returns (Constituent[] memory) {
        return _version(indexId, version).constituents;
    }

    /// @inheritdoc IIndexRegistry
    function versionExists(bytes32 indexId, uint32 version) public view returns (bool) {
        return version != 0 && version <= _indexes[indexId].latestVersion;
    }

    /// @inheritdoc IIndexRegistry
    function computeIndexId(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    /// @dev Validates the arguments, then writes the version record and emits {VersionPublished}. Callers have
    ///      already authorized `msg.sender` as the creator and guarantee that `version` was never written.
    ///      Order: spec size checks, composition validation, hash, storage writes, event.
    function _publish(
        bytes32 indexId,
        uint32 version,
        bytes calldata spec,
        address[] calldata tokens,
        uint16[] calldata weightsBps
    )
        private
    {
        uint256 specSize = spec.length;
        if (specSize == 0) revert EmptySpec();
        if (specSize > MAX_SPEC_BYTES) revert SpecTooLarge(specSize, MAX_SPEC_BYTES);

        Composition composition = _validateComposition(tokens, weightsBps);
        bool isStatic = composition == Composition.Static;
        bytes32 specHash = keccak256(spec);

        VersionRecord storage record = _versions[indexId][version];
        record.specHash = specHash;
        record.publishedAt = uint64(block.timestamp);
        record.publishedBlock = uint64(block.number);
        record.composition = composition;
        record.spec = spec;
        for (uint256 i = 0; i < tokens.length; ++i) {
            record.constituents.push(Constituent({token: tokens[i], weightBps: isStatic ? weightsBps[i] : 0}));
        }

        // Both casts are lossless: the values are bounded by MAX_SPEC_BYTES and MAX_CONSTITUENTS.
        // forge-lint: disable-next-item(unsafe-typecast)
        emit VersionPublished(
            indexId, version, specHash, msg.sender, composition, uint32(specSize), uint16(tokens.length)
        );
    }

    /// @dev Derives the composition from the argument lengths and validates the mirror: at most
    ///      MAX_CONSTITUENTS tokens, strictly ascending, and for a static composition one non-zero weight per
    ///      token summing to exactly BPS. Reverts on the first violation.
    function _validateComposition(
        address[] calldata tokens,
        uint16[] calldata weightsBps
    )
        private
        pure
        returns (Composition composition)
    {
        uint256 count = tokens.length;
        if (count > MAX_CONSTITUENTS) revert TooManyConstituents(count, MAX_CONSTITUENTS);

        if (weightsBps.length == 0) {
            composition = count == 0 ? Composition.RuleBased : Composition.DynamicWeights;
        } else {
            if (weightsBps.length != count) revert LengthMismatch(count, weightsBps.length);
            composition = Composition.Static;
        }

        // Strictly ascending from address(0) implies non-zero and unique tokens.
        address previous = address(0);
        // At most MAX_CONSTITUENTS * type(uint16).max, far below overflow.
        uint256 weightSum = 0;
        for (uint256 i = 0; i < count; ++i) {
            address token = tokens[i];
            if (token <= previous) revert TokensNotStrictlyAscending(i);
            previous = token;
            if (composition == Composition.Static) {
                uint16 weightBps = weightsBps[i];
                if (weightBps == 0) revert ZeroWeight(i);
                weightSum += weightBps;
            }
        }
        if (composition == Composition.Static && weightSum != BPS) revert InvalidWeightSum(weightSum);
    }

    /// @dev Storage pointer to an existing version. Reverts with {VersionNotFound} otherwise.
    function _version(bytes32 indexId, uint32 version) private view returns (VersionRecord storage) {
        if (!versionExists(indexId, version)) revert VersionNotFound(indexId, version);
        return _versions[indexId][version];
    }
}
