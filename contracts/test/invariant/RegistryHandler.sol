// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {Test} from "forge-std/Test.sol";

import {IndexRegistry} from "../../src/IndexRegistry.sol";
import {RebalanceLog} from "../../src/RebalanceLog.sol";
import {IIndexRegistry} from "../../src/interfaces/IIndexRegistry.sol";
import {IRebalanceLog} from "../../src/interfaces/IRebalanceLog.sol";

/// @notice Invariant handler: drives the registry and the log from several actors and keeps a ghost model of
///         everything that was ever published.
/// @dev Every action is expected to complete. Calls that must revert are wrapped in `vm.expectRevert` with the
///      exact error, so an unexpected success or an unexpected error fails the campaign (`fail_on_revert`).
contract RegistryHandler is Test {
    IndexRegistry public immutable REGISTRY;
    RebalanceLog public immutable REBALANCE_LOG;

    uint256 internal constant SALT_SPACE = 4;

    address[] internal _actors;

    // Ghost model.
    bytes32[] internal _ghostIds;
    mapping(bytes32 indexId => bool) public ghostExists;
    mapping(bytes32 indexId => address) public ghostCreator;
    mapping(bytes32 indexId => bytes32) public ghostSalt;
    mapping(bytes32 indexId => uint32) public ghostLatestVersion;
    mapping(bytes32 indexId => uint64) public ghostCreatedAt;
    mapping(bytes32 indexId => uint64) public ghostDeprecatedAt;
    /// @dev Digest of everything readable about a version, taken right after it was published.
    mapping(bytes32 indexId => mapping(uint32 version => bytes32)) public ghostVersionDigest;

    // Call counters, used to prove that the campaign reached every kind of action.
    uint256 public created;
    uint256 public published;
    uint256 public deprecated;
    uint256 public rejectedDuplicateCreate;
    uint256 public rejectedNonCreator;
    uint256 public rejectedWrongVersion;
    uint256 public rejectedAfterDeprecation;
    uint256 public rejectedInvalidArguments;
    uint256 public rebalancesRecorded;
    uint256 public rebalancesRejected;
    uint256 public etherRejected;

    constructor(IndexRegistry registry, RebalanceLog rebalanceLog) {
        REGISTRY = registry;
        REBALANCE_LOG = rebalanceLog;
        _actors.push(makeAddr("actor one"));
        _actors.push(makeAddr("actor two"));
        _actors.push(makeAddr("actor three"));
        _actors.push(makeAddr("actor four"));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------------------

    function createIndex(uint256 actorSeed, uint256 saltSeed, uint256 shapeSeed) external {
        address actor = _actor(actorSeed);
        bytes32 salt = bytes32(saltSeed % SALT_SPACE);
        bytes32 indexId = REGISTRY.computeIndexId(actor, salt);
        (bytes memory spec, address[] memory tokens, uint16[] memory weights) = _shape(shapeSeed);

        if (ghostExists[indexId]) {
            bytes32 before = indexDigest(indexId);
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexAlreadyExists.selector, indexId));
            vm.prank(actor);
            REGISTRY.createIndex(salt, spec, tokens, weights);
            assertEq(indexDigest(indexId), before, "duplicate create changed the index");
            ++rejectedDuplicateCreate;
            return;
        }

        vm.prank(actor);
        bytes32 returned = REGISTRY.createIndex(salt, spec, tokens, weights);
        assertEq(returned, indexId, "createIndex returned an unexpected id");

        _ghostIds.push(indexId);
        ghostExists[indexId] = true;
        ghostCreator[indexId] = actor;
        ghostSalt[indexId] = salt;
        ghostLatestVersion[indexId] = 1;
        ghostCreatedAt[indexId] = uint64(block.timestamp);
        ghostVersionDigest[indexId][1] = versionDigest(indexId, 1);
        ++created;
    }

    function publishVersion(uint256 indexSeed, uint256 shapeSeed) external {
        (bool any, bytes32 indexId) = _pickIndex(indexSeed);
        if (!any) return;
        (bytes memory spec, address[] memory tokens, uint16[] memory weights) = _shape(shapeSeed);
        uint32 next = ghostLatestVersion[indexId] + 1;

        if (ghostDeprecatedAt[indexId] != 0) {
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexIsDeprecated.selector, indexId));
            vm.prank(ghostCreator[indexId]);
            REGISTRY.publishVersion(indexId, next, spec, tokens, weights);
            ++rejectedAfterDeprecation;
            return;
        }

        vm.prank(ghostCreator[indexId]);
        uint32 version = REGISTRY.publishVersion(indexId, next, spec, tokens, weights);
        assertEq(version, next, "publishVersion returned an unexpected version");

        ghostLatestVersion[indexId] = next;
        ghostVersionDigest[indexId][next] = versionDigest(indexId, next);
        ++published;
    }

    function publishWithWrongVersion(uint256 indexSeed, uint32 expectedVersion, uint256 shapeSeed) external {
        (bool any, bytes32 indexId) = _pickIndex(indexSeed);
        if (!any || ghostDeprecatedAt[indexId] != 0) return;
        uint32 next = ghostLatestVersion[indexId] + 1;
        if (expectedVersion == next) expectedVersion = next - 1;
        (bytes memory spec, address[] memory tokens, uint16[] memory weights) = _shape(shapeSeed);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.UnexpectedVersion.selector, expectedVersion, next));
        vm.prank(ghostCreator[indexId]);
        REGISTRY.publishVersion(indexId, expectedVersion, spec, tokens, weights);
        ++rejectedWrongVersion;
    }

    function publishInvalidArguments(uint256 indexSeed, uint256 kindSeed) external {
        (bool any, bytes32 indexId) = _pickIndex(indexSeed);
        if (!any || ghostDeprecatedAt[indexId] != 0) return;
        uint32 next = ghostLatestVersion[indexId] + 1;

        bytes memory spec = hex"7b7d";
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(0x1000), address(0x2000));
        uint16[] memory weights = new uint16[](2);
        (weights[0], weights[1]) = (6000, 4000);
        bytes memory expectedError;

        uint256 kind = kindSeed % 7;
        if (kind == 0) {
            spec = "";
            expectedError = abi.encodeWithSelector(IIndexRegistry.EmptySpec.selector);
        } else if (kind == 1) {
            spec = new bytes(8193);
            expectedError = abi.encodeWithSelector(IIndexRegistry.SpecTooLarge.selector, 8193, 8192);
        } else if (kind == 2) {
            tokens = new address[](129);
            weights = new uint16[](0);
            expectedError = abi.encodeWithSelector(IIndexRegistry.TooManyConstituents.selector, 129, 128);
        } else if (kind == 3) {
            weights = new uint16[](1);
            expectedError = abi.encodeWithSelector(IIndexRegistry.LengthMismatch.selector, 2, 1);
        } else if (kind == 4) {
            tokens[1] = tokens[0];
            expectedError = abi.encodeWithSelector(IIndexRegistry.TokensNotStrictlyAscending.selector, 1);
        } else if (kind == 5) {
            (weights[0], weights[1]) = (10_000, 0);
            expectedError = abi.encodeWithSelector(IIndexRegistry.ZeroWeight.selector, 1);
        } else {
            weights[1] = 4001;
            expectedError = abi.encodeWithSelector(IIndexRegistry.InvalidWeightSum.selector, 10_001);
        }

        vm.expectRevert(expectedError);
        vm.prank(ghostCreator[indexId]);
        REGISTRY.publishVersion(indexId, next, spec, tokens, weights);
        ++rejectedInvalidArguments;
    }

    /// @dev I12: a call by anyone other than the creator leaves the index exactly as it was.
    function actAsNonCreator(uint256 indexSeed, uint256 actorSeed, uint256 shapeSeed, bool tryDeprecate) external {
        (bool any, bytes32 indexId) = _pickIndex(indexSeed);
        if (!any) return;
        address stranger = _actor(actorSeed);
        if (stranger == ghostCreator[indexId]) stranger = address(this);
        bytes32 before = indexDigest(indexId);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotCreator.selector, indexId, stranger));
        vm.prank(stranger);
        if (tryDeprecate) {
            REGISTRY.deprecate(indexId);
        } else {
            (bytes memory spec, address[] memory tokens, uint16[] memory weights) = _shape(shapeSeed);
            REGISTRY.publishVersion(indexId, ghostLatestVersion[indexId] + 1, spec, tokens, weights);
        }

        assertEq(indexDigest(indexId), before, "a non-creator changed the index");
        ++rejectedNonCreator;
    }

    function deprecate(uint256 indexSeed) external {
        (bool any, bytes32 indexId) = _pickIndex(indexSeed);
        if (!any) return;

        if (ghostDeprecatedAt[indexId] != 0) {
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexIsDeprecated.selector, indexId));
            vm.prank(ghostCreator[indexId]);
            REGISTRY.deprecate(indexId);
            ++rejectedAfterDeprecation;
            return;
        }

        vm.prank(ghostCreator[indexId]);
        REGISTRY.deprecate(indexId);
        ghostDeprecatedAt[indexId] = uint64(block.timestamp);
        ++deprecated;
    }

    function recordRebalance(uint256 actorSeed, uint256 indexSeed, uint32 version) external {
        (bool any, bytes32 indexId) = _pickIndex(indexSeed);
        if (!any) indexId = bytes32(indexSeed);
        version = uint32(bound(version, 0, uint256(ghostLatestVersion[indexId]) + 1));
        address actor = _actor(actorSeed);

        if (version == 0 || version > ghostLatestVersion[indexId]) {
            vm.expectRevert(abi.encodeWithSelector(IRebalanceLog.UnknownIndexVersion.selector, indexId, version));
            vm.prank(actor);
            REBALANCE_LOG.recordRebalance(indexId, version);
            ++rebalancesRejected;
            return;
        }

        vm.expectEmit(address(REBALANCE_LOG));
        emit IRebalanceLog.RebalanceRecorded(actor, indexId, version);
        vm.prank(actor);
        REBALANCE_LOG.recordRebalance(indexId, version);
        ++rebalancesRecorded;
    }

    /// @dev I11: no call path accepts ETH, with or without calldata.
    function sendEther(uint256 actorSeed, uint256 targetSeed, uint256 amount, uint256 callSeed) external {
        address actor = _actor(actorSeed);
        address target = targetSeed % 2 == 0 ? address(REGISTRY) : address(REBALANCE_LOG);
        amount = bound(amount, 1, 100 ether);
        vm.deal(actor, amount);

        bytes memory data;
        uint256 kind = callSeed % 4;
        if (kind == 1) {
            data = abi.encodeCall(
                IIndexRegistry.createIndex, (bytes32(callSeed), hex"7b7d", new address[](0), new uint16[](0))
            );
        } else if (kind == 2) {
            data = abi.encodeCall(IRebalanceLog.recordRebalance, (bytes32(callSeed), 1));
        } else if (kind == 3) {
            data = abi.encodeWithSignature("deposit()");
        }

        vm.prank(actor);
        (bool success,) = target.call{value: amount}(data);
        assertFalse(success, "a contract accepted ETH");
        ++etherRejected;
    }

    function advanceTime(uint256 secondsSeed) external {
        uint256 elapsed = bound(secondsSeed, 1, 7 days);
        vm.warp(block.timestamp + elapsed);
        vm.roll(block.number + elapsed * 5);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views used by the invariants
    // ---------------------------------------------------------------------------------------------------------

    function ghostIndexCount() external view returns (uint256) {
        return _ghostIds.length;
    }

    function ghostIndexIdAt(uint256 position) external view returns (bytes32) {
        return _ghostIds[position];
    }

    function versionDigest(bytes32 indexId, uint32 version) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                REGISTRY.getVersion(indexId, version),
                REGISTRY.specOf(indexId, version),
                REGISTRY.constituentsOf(indexId, version)
            )
        );
    }

    /// @dev Digest of the index record and of every one of its versions.
    function indexDigest(bytes32 indexId) public view returns (bytes32 digest) {
        IIndexRegistry.IndexInfo memory info = REGISTRY.getIndex(indexId);
        digest = keccak256(abi.encode(info));
        for (uint32 version = 1; version <= info.latestVersion; ++version) {
            digest = keccak256(abi.encode(digest, versionDigest(indexId, version)));
        }
        digest = keccak256(abi.encode(digest, REGISTRY.versionExists(indexId, info.latestVersion + 1)));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Input generation
    // ---------------------------------------------------------------------------------------------------------

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }

    function _pickIndex(uint256 seed) internal view returns (bool any, bytes32 indexId) {
        if (_ghostIds.length == 0) return (false, bytes32(0));
        return (true, _ghostIds[seed % _ghostIds.length]);
    }

    /// @dev A valid publish of a random composition. Mostly small, occasionally at the exact caps.
    function _shape(uint256 seed)
        internal
        pure
        returns (bytes memory spec, address[] memory tokens, uint16[] memory weights)
    {
        uint256 specSize = seed % 41 == 0 ? 8192 : 1 + (seed >> 8) % 96;
        spec = new bytes(specSize);
        bytes32 word;
        for (uint256 i = 0; i < specSize; ++i) {
            if (i % 32 == 0) word = keccak256(abi.encode(seed, i));
            spec[i] = word[i % 32];
        }

        uint256 kind = (seed >> 16) % 3;
        if (kind == 0) return (spec, new address[](0), new uint16[](0));

        uint256 count = seed % 43 == 0 ? 128 : 1 + (seed >> 24) % 8;
        tokens = new address[](count);
        uint160 previous = 0;
        for (uint256 i = 0; i < count; ++i) {
            previous += uint160(uint256(keccak256(abi.encode(seed, "token", i))) % (1 << 152)) + 1;
            tokens[i] = address(previous);
        }
        if (kind == 1) return (spec, tokens, new uint16[](0));

        weights = new uint16[](count);
        uint256 remaining = 10_000 - count;
        for (uint256 i = 0; i < count; ++i) {
            uint256 extra =
                i == count - 1 ? remaining : uint256(keccak256(abi.encode(seed, "weight", i))) % (remaining + 1);
            remaining -= extra;
            // forge-lint: disable-next-line(unsafe-typecast)
            weights[i] = uint16(1 + extra);
        }
    }
}
