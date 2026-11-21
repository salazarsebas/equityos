// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

/// @title IIndexRegistry
/// @notice Append-only registry of versioned index methodologies. Holds no funds, has no owner, no admin, no
///         upgrade path and makes no external calls.
/// @dev An index is identified by `indexId = keccak256(abi.encode(creator, salt))`. A version is identified by
///      `(indexId, version)` with `version` starting at 1. A complete reference to a version is the tuple
///      `(chainId, registry, indexId, version)`: the id alone is the same on every chain for the same creator
///      and salt.
///
///      The registry is content-agnostic about the spec bytes: it only bounds their size and hashes them. It
///      validates the internal consistency of the structured composition mirror (ordering, weights, sizes) and
///      nothing else. It does NOT check that the mirror matches the spec, that the spec is well-formed, or that
///      the tokens are legitimate. A contract that consumes the mirror trusts the creator of the index.
interface IIndexRegistry {
    /// @notice How much of the composition of a version is static and therefore mirrored onchain.
    /// @dev RuleBased: the universe is defined by a rule in the spec; no constituents are stored.
    ///      DynamicWeights: constituents are stored and every `weightBps` is 0; weights are computed from the
    ///      spec at calculation time.
    ///      Static: constituents and weights are stored; every weight is non-zero and they sum to 10_000.
    enum Composition {
        RuleBased,
        DynamicWeights,
        Static
    }

    /// @notice One constituent of a version. Packs into one storage slot.
    /// @param token Token address. Not checked onchain beyond ordering: it can be any non-zero address.
    /// @param weightBps Target weight in basis points (1 bps = 0.01%). 0 when the version is DynamicWeights.
    struct Constituent {
        address token;
        uint16 weightBps;
    }

    /// @notice Index-level data.
    /// @param creator Address that created the index: the only one allowed to append versions or deprecate.
    /// @param latestVersion Number of versions published. Always >= 1 for an existing index.
    /// @param createdAt `block.timestamp` of version 1, in seconds.
    /// @param deprecatedAt `block.timestamp` of deprecation in seconds, 0 while the index is active.
    struct IndexInfo {
        address creator;
        uint32 latestVersion;
        uint64 createdAt;
        uint64 deprecatedAt;
    }

    /// @notice Version-level data, without the variable-length parts.
    /// @param specHash keccak256 of the stored spec bytes, computed by the registry at publish time.
    /// @param publishedAt `block.timestamp` of publication, in seconds.
    /// @param publishedBlock `block.number` of publication.
    /// @param composition See {Composition}.
    /// @param specSize Length of the stored spec in bytes.
    /// @param constituentCount Number of stored constituents (0 for RuleBased).
    struct VersionInfo {
        bytes32 specHash;
        uint64 publishedAt;
        uint64 publishedBlock;
        Composition composition;
        uint32 specSize;
        uint16 constituentCount;
    }

    /// @notice Emitted once per index, in the same transaction as its version 1 and before {VersionPublished}.
    /// @param indexId Id of the new index.
    /// @param creator `msg.sender` of {createIndex}.
    /// @param salt The salt used, so anyone can recompute `indexId` from `(creator, salt)`.
    event IndexCreated(bytes32 indexed indexId, address indexed creator, bytes32 salt);

    /// @notice Emitted for every version, including version 1.
    /// @dev The spec bytes are not in the event: read them from state with {specOf}.
    /// @param indexId Id of the index.
    /// @param version Version number just published.
    /// @param specHash keccak256 of the stored spec bytes. Indexed so identical specs can be found across indexes.
    /// @param creator Creator of the index, which is also the publisher.
    /// @param composition Composition derived from the arguments.
    /// @param specSize Length of the stored spec in bytes.
    /// @param constituentCount Number of stored constituents.
    event VersionPublished(
        bytes32 indexed indexId,
        uint32 indexed version,
        bytes32 indexed specHash,
        address creator,
        Composition composition,
        uint32 specSize,
        uint16 constituentCount
    );

    /// @notice Emitted once when the creator deprecates the index. Deprecation is terminal.
    /// @param indexId Id of the index.
    /// @param creator Creator of the index.
    event IndexDeprecated(bytes32 indexed indexId, address indexed creator);

    /// @notice {createIndex} was called for a `(creator, salt)` pair that already exists.
    error IndexAlreadyExists(bytes32 indexId);
    /// @notice The index does not exist.
    error IndexNotFound(bytes32 indexId);
    /// @notice The version does not exist for this index, or the index does not exist.
    error VersionNotFound(bytes32 indexId, uint32 version);
    /// @notice The caller is not the creator of the index.
    error NotCreator(bytes32 indexId, address caller);
    /// @notice The index is deprecated: it cannot receive versions or be deprecated again.
    error IndexIsDeprecated(bytes32 indexId);
    /// @notice `expected` (the caller's `expectedVersion`) is not `next` (`latestVersion + 1`).
    error UnexpectedVersion(uint32 expected, uint32 next);
    /// @notice The spec is empty.
    error EmptySpec();
    /// @notice The spec is longer than {MAX_SPEC_BYTES}.
    error SpecTooLarge(uint256 size, uint256 max);
    /// @notice There are more constituents than {MAX_CONSTITUENTS}.
    error TooManyConstituents(uint256 count, uint256 max);
    /// @notice `weightsBps` is neither empty nor the same length as `tokens`.
    error LengthMismatch(uint256 tokens, uint256 weights);
    /// @notice `tokens[position]` is not strictly greater than the previous token. Also raised for `address(0)`
    ///         in first position and for duplicates.
    error TokensNotStrictlyAscending(uint256 position);
    /// @notice `weightsBps[position]` is zero in a static composition.
    error ZeroWeight(uint256 position);
    /// @notice Static weights sum to `sum` instead of {BPS}.
    error InvalidWeightSum(uint256 sum);
    /// @notice `position` is not below `count` (the current {indexCount}).
    error PositionOutOfBounds(uint256 position, uint256 count);

    /// @notice Sum of the weights of a static composition, in basis points: 10_000.
    function BPS() external view returns (uint16);

    /// @notice Maximum spec size in bytes: 8_192.
    function MAX_SPEC_BYTES() external view returns (uint32);

    /// @notice Maximum number of constituents per version: 64.
    function MAX_CONSTITUENTS() external view returns (uint16);

    /// @notice Create an index and publish its version 1. The caller becomes the creator, permanently.
    /// @dev Reverts with {IndexAlreadyExists} if `(msg.sender, salt)` was used before. Validation of `spec`,
    ///      `tokens` and `weightsBps` is the same as in {publishVersion}.
    /// @param salt Creator-chosen salt. Any value is accepted.
    /// @param spec Spec bytes, 1 to {MAX_SPEC_BYTES} long. Stored verbatim; `keccak256(spec)` becomes `specHash`.
    /// @param tokens Constituent tokens, strictly ascending by address, at most {MAX_CONSTITUENTS}. Empty for a
    ///        rule-based universe.
    /// @param weightsBps Empty for a rule-based universe or for dynamic weights. Otherwise the same length as
    ///        `tokens`, each weight > 0, summing to exactly 10_000.
    /// @return indexId `keccak256(abi.encode(msg.sender, salt))`.
    function createIndex(
        bytes32 salt,
        bytes calldata spec,
        address[] calldata tokens,
        uint16[] calldata weightsBps
    )
        external
        returns (bytes32 indexId);

    /// @notice Append a new version to an index. Only the creator, and only while the index is not deprecated.
    /// @dev Checks run in this order: {IndexNotFound}, {NotCreator}, {IndexIsDeprecated}, {UnexpectedVersion},
    ///      then the validation of `spec`, `tokens` and `weightsBps`.
    /// @param indexId Id of an existing index.
    /// @param expectedVersion Must equal `latestVersion + 1`. Makes a duplicate or stale submission revert
    ///        instead of publishing twice.
    /// @param spec See {createIndex}.
    /// @param tokens See {createIndex}.
    /// @param weightsBps See {createIndex}.
    /// @return version The version number just published, equal to `expectedVersion`.
    function publishVersion(
        bytes32 indexId,
        uint32 expectedVersion,
        bytes calldata spec,
        address[] calldata tokens,
        uint16[] calldata weightsBps
    )
        external
        returns (uint32 version);

    /// @notice Mark the index as deprecated. Only the creator. One-way: there is no way to reactivate.
    /// @dev Blocks further versions. Every published version stays readable. Reverts with {IndexNotFound},
    ///      {NotCreator} or {IndexIsDeprecated}, checked in that order.
    /// @param indexId Id of an existing index.
    function deprecate(bytes32 indexId) external;

    /// @notice Id derivation, exposed so clients and contracts do not reimplement it.
    /// @param creator Address that creates, or would create, the index.
    /// @param salt Creator-chosen salt.
    /// @return `keccak256(abi.encode(creator, salt))`. The index may or may not exist.
    function computeIndexId(address creator, bytes32 salt) external pure returns (bytes32);

    /// @notice Number of indexes ever created. Never decreases.
    function indexCount() external view returns (uint256);

    /// @notice Index id at a position in creation order. Positions are stable forever.
    /// @dev Reverts with {PositionOutOfBounds} if `position >= indexCount()`.
    function indexIdAt(uint256 position) external view returns (bytes32);

    /// @notice True if the index exists.
    function exists(bytes32 indexId) external view returns (bool);

    /// @notice True if `version` is in `[1, latestVersion]` of an existing index. Never reverts.
    function versionExists(bytes32 indexId, uint32 version) external view returns (bool);

    /// @notice Index-level data. Reverts with {IndexNotFound}.
    function getIndex(bytes32 indexId) external view returns (IndexInfo memory);

    /// @notice Version-level data. Reverts with {VersionNotFound}.
    function getVersion(bytes32 indexId, uint32 version) external view returns (VersionInfo memory);

    /// @notice The exact spec bytes that were published. `keccak256` of the result equals `specHash`.
    /// @dev Reverts with {VersionNotFound}. Returns up to {MAX_SPEC_BYTES} bytes.
    function specOf(bytes32 indexId, uint32 version) external view returns (bytes memory);

    /// @notice Stored constituents in ascending token order. Empty for RuleBased.
    /// @dev Reverts with {VersionNotFound}. Returns up to {MAX_CONSTITUENTS} entries. Weights are all zero for
    ///      DynamicWeights: callers MUST check `composition` from {getVersion} before using the weights.
    function constituentsOf(bytes32 indexId, uint32 version) external view returns (Constituent[] memory);
}
