// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// @dev A contract, not an EOA, acting as the creator of an index.
contract ContractCreator {
    IIndexRegistry private immutable REGISTRY;

    constructor(IIndexRegistry registry) {
        REGISTRY = registry;
    }

    function create(
        bytes32 salt,
        bytes calldata spec,
        address[] calldata tokens,
        uint16[] calldata weightsBps
    )
        external
        returns (bytes32)
    {
        return REGISTRY.createIndex(salt, spec, tokens, weightsBps);
    }

    function publish(bytes32 indexId, uint32 expectedVersion, bytes calldata spec) external returns (uint32) {
        return REGISTRY.publishVersion(indexId, expectedVersion, spec, new address[](0), new uint16[](0));
    }

    function deprecate(bytes32 indexId) external {
        REGISTRY.deprecate(indexId);
    }
}

contract IndexRegistryTest is RegistryTestBase {
    // ---------------------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------------------

    function test_Constants() public view {
        assertEq(registry.BPS(), 10_000);
        assertEq(registry.MAX_SPEC_BYTES(), 8192);
        assertEq(registry.MAX_CONSTITUENTS(), 64);
    }

    // ---------------------------------------------------------------------------------------------------------
    // createIndex
    // ---------------------------------------------------------------------------------------------------------

    function test_CreateIndex_StoresIndexAndVersionOne() public {
        bytes memory spec = _spec(600);
        address[] memory tokens = _tokens(10);
        uint16[] memory weights = _weights(10);

        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, spec, tokens, weights);

        assertEq(indexId, keccak256(abi.encode(alice, SALT)));
        assertTrue(registry.exists(indexId));

        IIndexRegistry.IndexInfo memory index = registry.getIndex(indexId);
        assertEq(index.creator, alice);
        assertEq(index.latestVersion, 1);
        assertEq(index.createdAt, 1_800_000_000);
        assertEq(index.deprecatedAt, 0);

        IIndexRegistry.VersionInfo memory version = registry.getVersion(indexId, 1);
        assertEq(version.specHash, keccak256(spec));
        assertEq(version.publishedAt, 1_800_000_000);
        assertEq(version.publishedBlock, 60_000_000);
        assertEq(uint8(version.composition), uint8(IIndexRegistry.Composition.Static));
        assertEq(version.specSize, 600);
        assertEq(version.constituentCount, 10);

        assertEq(registry.specOf(indexId, 1), spec);
        _assertVersionWellFormed(indexId, 1);
    }

    function test_CreateIndex_EmitsIndexCreatedThenVersionPublished() public {
        bytes memory spec = _spec(600);
        bytes32 indexId = registry.computeIndexId(alice, SALT);

        vm.expectEmit(address(registry));
        emit IIndexRegistry.IndexCreated(indexId, alice, SALT);
        vm.expectEmit(address(registry));
        emit IIndexRegistry.VersionPublished(
            indexId, 1, keccak256(spec), alice, IIndexRegistry.Composition.Static, 600, 10
        );

        vm.recordLogs();
        vm.prank(alice);
        registry.createIndex(SALT, spec, _tokens(10), _weights(10));
        assertEq(vm.getRecordedLogs().length, 2, "exactly two events");
    }

    function testFuzz_ComputeIndexId(address creator, bytes32 salt) public view {
        assertEq(registry.computeIndexId(creator, salt), keccak256(abi.encode(creator, salt)));
    }

    function test_ComputeIndexId_DoesNotDependOnChainId() public {
        bytes32 before = registry.computeIndexId(alice, SALT);
        vm.chainId(84_532);
        assertEq(registry.computeIndexId(alice, SALT), before);
    }

    function test_CreateIndex_SameSaltTwoCreatorsAreDistinctIndexes() public {
        bytes32 aliceId = _createStatic(alice, SALT, 3);
        bytes32 bobId = _createStatic(bob, SALT, 3);

        assertTrue(aliceId != bobId);
        assertEq(registry.getIndex(aliceId).creator, alice);
        assertEq(registry.getIndex(bobId).creator, bob);
        assertEq(registry.indexCount(), 2);
    }

    function test_RevertWhen_CreateIndexTwiceWithSameSalt() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexAlreadyExists.selector, indexId));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(1), _noTokens(), _noWeights());

        assertEq(registry.indexCount(), 1);
        assertEq(registry.getIndex(indexId).latestVersion, 1);
    }

    function test_RevertWhen_CreateIndexTwiceEvenAfterDeprecation() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);
        vm.prank(alice);
        registry.deprecate(indexId);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexAlreadyExists.selector, indexId));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(1), _noTokens(), _noWeights());
    }

    function test_CreateIndex_FailedCreationLeavesNoTrace() public {
        bytes32 indexId = registry.computeIndexId(alice, SALT);

        vm.expectRevert(IIndexRegistry.EmptySpec.selector);
        vm.prank(alice);
        registry.createIndex(SALT, "", _noTokens(), _noWeights());

        assertFalse(registry.exists(indexId));
        assertFalse(registry.versionExists(indexId, 1));
        assertEq(registry.indexCount(), 0);

        // The same salt is still available afterwards.
        _createStatic(alice, SALT, 2);
        assertEq(registry.indexCount(), 1);
    }

    function test_CreateIndex_ContractCanBeCreator() public {
        ContractCreator creator = new ContractCreator(registry);

        bytes32 indexId = creator.create(SALT, _spec(64), _tokens(2), _weights(2));
        assertEq(indexId, registry.computeIndexId(address(creator), SALT));
        assertEq(registry.getIndex(indexId).creator, address(creator));

        assertEq(creator.publish(indexId, 2, _spec(65)), 2);
        creator.deprecate(indexId);
        assertEq(registry.getIndex(indexId).deprecatedAt, 1_800_000_000);

        // The account that called the creator contract has no rights on the index.
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotCreator.selector, indexId, address(this)));
        registry.deprecate(indexId);
    }

    // ---------------------------------------------------------------------------------------------------------
    // publishVersion
    // ---------------------------------------------------------------------------------------------------------

    function test_PublishVersion_AppendsAndLeavesVersionOneUntouched() public {
        bytes32 indexId = _createStatic(alice, SALT, 10);
        IIndexRegistry.VersionInfo memory v1 = registry.getVersion(indexId, 1);
        bytes memory spec1 = registry.specOf(indexId, 1);
        bytes32 constituents1 = keccak256(abi.encode(registry.constituentsOf(indexId, 1)));

        vm.warp(1_800_000_500);
        vm.roll(60_002_500);
        bytes memory spec2 = _spec(700);

        vm.expectEmit(address(registry));
        emit IIndexRegistry.VersionPublished(
            indexId, 2, keccak256(spec2), alice, IIndexRegistry.Composition.DynamicWeights, 700, 4
        );
        vm.recordLogs();
        vm.prank(alice);
        uint32 version = registry.publishVersion(indexId, 2, spec2, _tokens(4), _noWeights());
        assertEq(vm.getRecordedLogs().length, 1, "exactly one event");

        assertEq(version, 2);
        IIndexRegistry.IndexInfo memory index = registry.getIndex(indexId);
        assertEq(index.latestVersion, 2);
        assertEq(index.createdAt, 1_800_000_000, "createdAt stays the timestamp of version 1");
        assertEq(index.creator, alice);

        IIndexRegistry.VersionInfo memory v2 = registry.getVersion(indexId, 2);
        assertEq(v2.specHash, keccak256(spec2));
        assertEq(v2.publishedAt, 1_800_000_500);
        assertEq(v2.publishedBlock, 60_002_500);
        assertEq(uint8(v2.composition), uint8(IIndexRegistry.Composition.DynamicWeights));
        assertEq(registry.specOf(indexId, 2), spec2);

        assertEq(keccak256(abi.encode(registry.getVersion(indexId, 1))), keccak256(abi.encode(v1)));
        assertEq(registry.specOf(indexId, 1), spec1);
        assertEq(keccak256(abi.encode(registry.constituentsOf(indexId, 1))), constituents1);
        assertEq(registry.indexCount(), 1, "a new version is not a new index");
    }

    function test_PublishVersion_ManySequentialVersions() public {
        bytes32 indexId = _createStatic(alice, SALT, 2);
        for (uint32 v = 2; v <= 20; ++v) {
            vm.prank(alice);
            assertEq(registry.publishVersion(indexId, v, _spec(v), _noTokens(), _noWeights()), v);
        }
        assertEq(registry.getIndex(indexId).latestVersion, 20);
        for (uint32 v = 2; v <= 20; ++v) {
            assertEq(registry.getVersion(indexId, v).specSize, v);
        }
    }

    function test_RevertWhen_PublishVersionByNonCreator() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotCreator.selector, indexId, bob));
        vm.prank(bob);
        registry.publishVersion(indexId, 2, _spec(10), _noTokens(), _noWeights());

        assertEq(registry.getIndex(indexId).latestVersion, 1);
        assertFalse(registry.versionExists(indexId, 2));
    }

    function test_RevertWhen_PublishVersionOnUnknownIndex() public {
        bytes32 unknown = registry.computeIndexId(alice, SALT);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexNotFound.selector, unknown));
        vm.prank(alice);
        registry.publishVersion(unknown, 1, _spec(10), _noTokens(), _noWeights());

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexNotFound.selector, unknown));
        vm.prank(alice);
        registry.publishVersion(unknown, 2, _spec(10), _noTokens(), _noWeights());

        assertFalse(registry.exists(unknown));
    }

    function test_RevertWhen_ExpectedVersionIsWrong() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);
        vm.prank(alice);
        registry.publishVersion(indexId, 2, _spec(10), _noTokens(), _noWeights());

        uint32[5] memory wrong = [uint32(0), 1, 2, 4, type(uint32).max];
        for (uint256 i = 0; i < wrong.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.UnexpectedVersion.selector, wrong[i], 3));
            vm.prank(alice);
            registry.publishVersion(indexId, wrong[i], _spec(10), _noTokens(), _noWeights());
        }
        assertEq(registry.getIndex(indexId).latestVersion, 2);
    }

    /// @dev Two submissions built against the same state: the second one must not publish a duplicate.
    function test_RevertWhen_SameExpectedVersionIsSubmittedTwice() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);
        bytes memory spec = _spec(321);

        vm.prank(alice);
        registry.publishVersion(indexId, 2, spec, _tokens(3), _weights(3));

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.UnexpectedVersion.selector, 2, 3));
        vm.prank(alice);
        registry.publishVersion(indexId, 2, spec, _tokens(3), _weights(3));

        assertEq(registry.getIndex(indexId).latestVersion, 2);
        assertFalse(registry.versionExists(indexId, 3));
    }

    /// @dev A failed publish must not consume the version number.
    function test_PublishVersion_FailedValidationDoesNotAdvanceVersion() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);

        vm.expectRevert(IIndexRegistry.EmptySpec.selector);
        vm.prank(alice);
        registry.publishVersion(indexId, 2, "", _noTokens(), _noWeights());

        assertEq(registry.getIndex(indexId).latestVersion, 1);
        assertFalse(registry.versionExists(indexId, 2));

        vm.prank(alice);
        assertEq(registry.publishVersion(indexId, 2, _spec(5), _noTokens(), _noWeights()), 2);
    }

    /// @dev The creator check runs before the version check, so a stranger learns nothing from the guard.
    function test_RevertWhen_NonCreatorUsesWrongVersion() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotCreator.selector, indexId, bob));
        vm.prank(bob);
        registry.publishVersion(indexId, 7, "", _noTokens(), _noWeights());
    }

    // ---------------------------------------------------------------------------------------------------------
    // Spec bounds
    // ---------------------------------------------------------------------------------------------------------

    function test_RevertWhen_SpecIsEmpty() public {
        vm.expectRevert(IIndexRegistry.EmptySpec.selector);
        vm.prank(alice);
        registry.createIndex(SALT, "", _tokens(2), _weights(2));
    }

    function test_SpecOfOneByteSucceeds() public {
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, hex"7b", _noTokens(), _noWeights());
        assertEq(registry.specOf(indexId, 1), hex"7b");
        assertEq(registry.getVersion(indexId, 1).specSize, 1);
    }

    function test_SpecOfExactlyMaxBytesSucceeds() public {
        bytes memory spec = _spec(8192);
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, spec, _noTokens(), _noWeights());

        assertEq(registry.getVersion(indexId, 1).specSize, 8192);
        assertEq(registry.specOf(indexId, 1), spec);
        assertEq(registry.getVersion(indexId, 1).specHash, keccak256(spec));
    }

    function test_RevertWhen_SpecIsOneByteOverMax() public {
        bytes memory spec = _spec(8193);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.SpecTooLarge.selector, 8193, 8192));
        vm.prank(alice);
        registry.createIndex(SALT, spec, _noTokens(), _noWeights());

        bytes32 indexId = _createStatic(alice, SALT, 2);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.SpecTooLarge.selector, 8193, 8192));
        vm.prank(alice);
        registry.publishVersion(indexId, 2, spec, _noTokens(), _noWeights());
    }

    // ---------------------------------------------------------------------------------------------------------
    // Constituent bounds
    // ---------------------------------------------------------------------------------------------------------

    function test_MaxConstituentsSucceeds() public {
        address[] memory tokens = _tokens(64);
        uint16[] memory weights = _weights(64);

        vm.prank(alice);
        bytes32 staticId = registry.createIndex(SALT, _spec(100), tokens, weights);
        assertEq(registry.getVersion(staticId, 1).constituentCount, 64);
        assertEq(registry.constituentsOf(staticId, 1).length, 64);
        _assertVersionWellFormed(staticId, 1);

        vm.prank(alice);
        bytes32 dynamicId = registry.createIndex(keccak256("dynamic"), _spec(100), tokens, _noWeights());
        assertEq(registry.getVersion(dynamicId, 1).constituentCount, 64);
        _assertVersionWellFormed(dynamicId, 1);
    }

    function test_RevertWhen_OneConstituentOverMax() public {
        address[] memory tokens = _tokens(65);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TooManyConstituents.selector, 65, 64));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), tokens, _weights(65));

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TooManyConstituents.selector, 65, 64));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), tokens, _noWeights());
    }

    // ---------------------------------------------------------------------------------------------------------
    // Composition derivation
    // ---------------------------------------------------------------------------------------------------------

    function test_Composition_RuleBased() public {
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(100), _noTokens(), _noWeights());

        IIndexRegistry.VersionInfo memory version = registry.getVersion(indexId, 1);
        assertEq(uint8(version.composition), uint8(IIndexRegistry.Composition.RuleBased));
        assertEq(version.constituentCount, 0);
        assertEq(registry.constituentsOf(indexId, 1).length, 0);
    }

    function test_Composition_DynamicWeights() public {
        address[] memory tokens = _tokens(5);
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(100), tokens, _noWeights());

        IIndexRegistry.VersionInfo memory version = registry.getVersion(indexId, 1);
        assertEq(uint8(version.composition), uint8(IIndexRegistry.Composition.DynamicWeights));
        assertEq(version.constituentCount, 5);

        IIndexRegistry.Constituent[] memory constituents = registry.constituentsOf(indexId, 1);
        assertEq(constituents.length, 5);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(constituents[i].token, tokens[i]);
            assertEq(constituents[i].weightBps, 0);
        }
    }

    function test_Composition_Static() public {
        address[] memory tokens = _tokens(4);
        uint16[] memory weights = new uint16[](4);
        (weights[0], weights[1], weights[2], weights[3]) = (4000, 3000, 2999, 1);

        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(100), tokens, weights);

        IIndexRegistry.VersionInfo memory version = registry.getVersion(indexId, 1);
        assertEq(uint8(version.composition), uint8(IIndexRegistry.Composition.Static));
        assertEq(version.constituentCount, 4);

        IIndexRegistry.Constituent[] memory constituents = registry.constituentsOf(indexId, 1);
        assertEq(constituents.length, 4);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(constituents[i].token, tokens[i]);
            assertEq(constituents[i].weightBps, weights[i]);
        }
    }

    function test_Composition_SingleConstituentWithFullWeight() public {
        address[] memory tokens = _tokens(1);
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;

        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(100), tokens, weights);

        IIndexRegistry.Constituent[] memory constituents = registry.constituentsOf(indexId, 1);
        assertEq(constituents.length, 1);
        assertEq(constituents[0].token, tokens[0]);
        assertEq(constituents[0].weightBps, 10_000);
    }

    function test_Composition_CanChangeBetweenVersions() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);
        vm.startPrank(alice);
        registry.publishVersion(indexId, 2, _spec(10), _noTokens(), _noWeights());
        registry.publishVersion(indexId, 3, _spec(10), _tokens(7), _noWeights());
        registry.publishVersion(indexId, 4, _spec(10), _tokens(2), _weights(2));
        vm.stopPrank();

        assertEq(uint8(registry.getVersion(indexId, 1).composition), uint8(IIndexRegistry.Composition.Static));
        assertEq(uint8(registry.getVersion(indexId, 2).composition), uint8(IIndexRegistry.Composition.RuleBased));
        assertEq(uint8(registry.getVersion(indexId, 3).composition), uint8(IIndexRegistry.Composition.DynamicWeights));
        assertEq(uint8(registry.getVersion(indexId, 4).composition), uint8(IIndexRegistry.Composition.Static));
        assertEq(registry.constituentsOf(indexId, 1).length, 3);
        assertEq(registry.constituentsOf(indexId, 2).length, 0);
        assertEq(registry.constituentsOf(indexId, 3).length, 7);
        assertEq(registry.constituentsOf(indexId, 4).length, 2);
    }

    function test_RevertWhen_WeightsWithoutTokens() public {
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.LengthMismatch.selector, 0, 2));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _noTokens(), _weights(2));
    }

    function test_RevertWhen_WeightsLengthDiffersFromTokens() public {
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.LengthMismatch.selector, 3, 2));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _tokens(3), _weights(2));

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.LengthMismatch.selector, 3, 4));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _tokens(3), _weights(4));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Token ordering
    // ---------------------------------------------------------------------------------------------------------

    function test_RevertWhen_DuplicateToken() public {
        address[] memory tokens = _tokens(4);
        tokens[2] = tokens[1];

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TokensNotStrictlyAscending.selector, 2));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), tokens, _weights(4));

        // Ordering is also enforced when no weights are given.
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TokensNotStrictlyAscending.selector, 2));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), tokens, _noWeights());
    }

    function test_RevertWhen_DuplicateTokenInLastPosition() public {
        address[] memory tokens = _tokens(4);
        tokens[3] = tokens[2];

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TokensNotStrictlyAscending.selector, 3));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), tokens, _weights(4));
    }

    function test_RevertWhen_DescendingPair() public {
        address[] memory tokens = _tokens(4);
        (tokens[0], tokens[1]) = (tokens[1], tokens[0]);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TokensNotStrictlyAscending.selector, 1));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), tokens, _weights(4));

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TokensNotStrictlyAscending.selector, 1));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), tokens, _noWeights());
    }

    function test_RevertWhen_ZeroAddressToken() public {
        address[] memory tokens = _tokens(3);
        tokens[0] = address(0);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TokensNotStrictlyAscending.selector, 0));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), tokens, _weights(3));

        address[] memory single = new address[](1);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TokensNotStrictlyAscending.selector, 0));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), single, _noWeights());
    }

    function test_LowestAndHighestAddressesAreAccepted() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(1);
        tokens[1] = address(type(uint160).max);

        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(100), tokens, _weights(2));
        IIndexRegistry.Constituent[] memory constituents = registry.constituentsOf(indexId, 1);
        assertEq(constituents[0].token, address(1));
        assertEq(constituents[1].token, address(type(uint160).max));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Weights
    // ---------------------------------------------------------------------------------------------------------

    function test_RevertWhen_StaticWeightIsZero() public {
        uint16[] memory weights = new uint16[](3);
        (weights[0], weights[1], weights[2]) = (5000, 0, 5000);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.ZeroWeight.selector, 1));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _tokens(3), weights);

        (weights[0], weights[1], weights[2]) = (5000, 5000, 0);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.ZeroWeight.selector, 2));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _tokens(3), weights);
    }

    function test_RevertWhen_WeightSumIsOff() public {
        uint16[] memory weights = _weights(3);

        weights[2] -= 1;
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.InvalidWeightSum.selector, 9999));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _tokens(3), weights);

        weights[2] += 2;
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.InvalidWeightSum.selector, 10_001));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _tokens(3), weights);
    }

    function test_RevertWhen_SingleWeightIsNotFull() public {
        uint16[] memory weights = new uint16[](1);

        weights[0] = 9999;
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.InvalidWeightSum.selector, 9999));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _tokens(1), weights);

        weights[0] = type(uint16).max;
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.InvalidWeightSum.selector, 65_535));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _tokens(1), weights);
    }

    /// @dev The sum is accumulated in 256 bits: the largest possible input cannot wrap around to 10_000.
    function test_RevertWhen_WeightSumIsTheLargestPossible() public {
        uint16[] memory weights = new uint16[](64);
        for (uint256 i = 0; i < 64; ++i) {
            weights[i] = type(uint16).max;
        }

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.InvalidWeightSum.selector, 64 * 65_535));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(100), _tokens(64), weights);
    }

    // ---------------------------------------------------------------------------------------------------------
    // deprecate
    // ---------------------------------------------------------------------------------------------------------

    function test_Deprecate_SetsTimestampAndEmits() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);
        vm.warp(1_800_000_777);

        vm.expectEmit(address(registry));
        emit IIndexRegistry.IndexDeprecated(indexId, alice);
        vm.recordLogs();
        vm.prank(alice);
        registry.deprecate(indexId);
        assertEq(vm.getRecordedLogs().length, 1, "exactly one event");

        IIndexRegistry.IndexInfo memory index = registry.getIndex(indexId);
        assertEq(index.deprecatedAt, 1_800_000_777);
        assertEq(index.latestVersion, 1);
        assertEq(index.creator, alice);
        assertEq(index.createdAt, 1_800_000_000);
        assertTrue(registry.exists(indexId));
    }

    function test_RevertWhen_DeprecateByNonCreator() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotCreator.selector, indexId, bob));
        vm.prank(bob);
        registry.deprecate(indexId);

        assertEq(registry.getIndex(indexId).deprecatedAt, 0);
    }

    function test_RevertWhen_DeprecateUnknownIndex() public {
        bytes32 unknown = registry.computeIndexId(alice, SALT);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexNotFound.selector, unknown));
        vm.prank(alice);
        registry.deprecate(unknown);
    }

    function test_RevertWhen_DeprecateTwice() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);
        vm.prank(alice);
        registry.deprecate(indexId);

        vm.warp(1_800_009_999);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexIsDeprecated.selector, indexId));
        vm.prank(alice);
        registry.deprecate(indexId);

        assertEq(registry.getIndex(indexId).deprecatedAt, 1_800_000_000, "first timestamp is kept");
    }

    function test_RevertWhen_PublishVersionAfterDeprecation() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);
        vm.prank(alice);
        registry.deprecate(indexId);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexIsDeprecated.selector, indexId));
        vm.prank(alice);
        registry.publishVersion(indexId, 2, _spec(10), _tokens(3), _weights(3));

        assertEq(registry.getIndex(indexId).latestVersion, 1);
        assertFalse(registry.versionExists(indexId, 2));
    }

    function test_Deprecate_DoesNotAffectOtherIndexes() public {
        bytes32 first = _createStatic(alice, SALT, 3);
        bytes32 second = _createStatic(alice, keccak256("other"), 3);
        vm.prank(alice);
        registry.deprecate(first);

        assertEq(registry.getIndex(second).deprecatedAt, 0);
        vm.prank(alice);
        assertEq(registry.publishVersion(second, 2, _spec(10), _noTokens(), _noWeights()), 2);
    }

    function test_Deprecate_AllVersionsStayReadable() public {
        bytes32 indexId = _createStatic(alice, SALT, 10);
        bytes memory spec2 = _spec(900);
        vm.prank(alice);
        registry.publishVersion(indexId, 2, spec2, _tokens(6), _noWeights());

        bytes32 before1 = _versionDigest(indexId, 1);
        bytes32 before2 = _versionDigest(indexId, 2);

        vm.prank(alice);
        registry.deprecate(indexId);

        assertTrue(registry.versionExists(indexId, 1));
        assertTrue(registry.versionExists(indexId, 2));
        assertEq(_versionDigest(indexId, 1), before1);
        assertEq(_versionDigest(indexId, 2), before2);
        assertEq(registry.specOf(indexId, 2), spec2);
        assertEq(registry.indexIdAt(0), indexId);
        assertEq(registry.indexCount(), 1);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------------------------

    function test_RevertWhen_ReadingUnknownIndex() public {
        bytes32 unknown = keccak256("unknown");

        assertFalse(registry.exists(unknown));
        assertFalse(registry.versionExists(unknown, 0));
        assertFalse(registry.versionExists(unknown, 1));

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexNotFound.selector, unknown));
        registry.getIndex(unknown);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, unknown, 1));
        registry.getVersion(unknown, 1);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, unknown, 1));
        registry.specOf(unknown, 1);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, unknown, 1));
        registry.constituentsOf(unknown, 1);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, unknown, 0));
        registry.getVersion(unknown, 0);
    }

    function test_RevertWhen_ReadingVersionOutOfRange() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);
        vm.prank(alice);
        registry.publishVersion(indexId, 2, _spec(10), _noTokens(), _noWeights());

        assertFalse(registry.versionExists(indexId, 0));
        assertTrue(registry.versionExists(indexId, 1));
        assertTrue(registry.versionExists(indexId, 2));
        assertFalse(registry.versionExists(indexId, 3));
        assertFalse(registry.versionExists(indexId, type(uint32).max));

        uint32[3] memory missing = [uint32(0), 3, type(uint32).max];
        for (uint256 i = 0; i < missing.length; ++i) {
            bytes memory err = abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, indexId, missing[i]);
            vm.expectRevert(err);
            registry.getVersion(indexId, missing[i]);
            vm.expectRevert(err);
            registry.specOf(indexId, missing[i]);
            vm.expectRevert(err);
            registry.constituentsOf(indexId, missing[i]);
        }
    }

    function test_Enumeration_FollowsCreationOrder() public {
        assertEq(registry.indexCount(), 0);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.PositionOutOfBounds.selector, 0, 0));
        registry.indexIdAt(0);

        bytes32 first = _createStatic(alice, SALT, 3);
        bytes32 second = _createStatic(bob, SALT, 3);
        bytes32 third = _createStatic(alice, keccak256("third"), 3);

        // Publishing and deprecating do not move or add entries.
        vm.startPrank(alice);
        registry.publishVersion(first, 2, _spec(10), _noTokens(), _noWeights());
        registry.deprecate(first);
        vm.stopPrank();

        assertEq(registry.indexCount(), 3);
        assertEq(registry.indexIdAt(0), first);
        assertEq(registry.indexIdAt(1), second);
        assertEq(registry.indexIdAt(2), third);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.PositionOutOfBounds.selector, 3, 3));
        registry.indexIdAt(3);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.PositionOutOfBounds.selector, type(uint256).max, 3));
        registry.indexIdAt(type(uint256).max);
    }

    /// @dev The whole registry can be rebuilt from state alone, with no logs.
    function test_Enumeration_RegistryIsReconstructibleFromState() public {
        _createStatic(alice, SALT, 3);
        _createStatic(bob, keccak256("b"), 5);
        bytes32 third = _createStatic(carol, keccak256("c"), 7);
        vm.prank(carol);
        registry.publishVersion(third, 2, _spec(42), _tokens(2), _noWeights());

        uint256 versions = 0;
        for (uint256 i = 0; i < registry.indexCount(); ++i) {
            bytes32 indexId = registry.indexIdAt(i);
            IIndexRegistry.IndexInfo memory index = registry.getIndex(indexId);
            for (uint32 v = 1; v <= index.latestVersion; ++v) {
                _assertVersionWellFormed(indexId, v);
                ++versions;
            }
        }
        assertEq(versions, 4);
    }

    // ---------------------------------------------------------------------------------------------------------
    // ETH is rejected
    // ---------------------------------------------------------------------------------------------------------

    function test_RevertWhen_EtherIsSentToAnyFunction() public {
        bytes32 indexId = _createStatic(address(this), SALT, 3);
        bytes32 freshSalt = keccak256("fresh");

        bytes[] memory calls = new bytes[](14);
        calls[0] = abi.encodeCall(registry.createIndex, (freshSalt, _spec(10), _noTokens(), _noWeights()));
        calls[1] = abi.encodeCall(registry.publishVersion, (indexId, 2, _spec(10), _noTokens(), _noWeights()));
        calls[2] = abi.encodeCall(registry.deprecate, (indexId));
        calls[3] = abi.encodeCall(registry.computeIndexId, (alice, SALT));
        calls[4] = abi.encodeCall(registry.indexCount, ());
        calls[5] = abi.encodeCall(registry.indexIdAt, (0));
        calls[6] = abi.encodeCall(registry.exists, (indexId));
        calls[7] = abi.encodeCall(registry.versionExists, (indexId, 1));
        calls[8] = abi.encodeCall(registry.getIndex, (indexId));
        calls[9] = abi.encodeCall(registry.getVersion, (indexId, 1));
        calls[10] = abi.encodeCall(registry.specOf, (indexId, 1));
        calls[11] = abi.encodeCall(registry.constituentsOf, (indexId, 1));
        calls[12] = abi.encodeCall(registry.BPS, ());
        calls[13] = abi.encodeCall(registry.MAX_SPEC_BYTES, ());

        vm.deal(address(this), 1 ether);
        uint256 snapshot = vm.snapshotState();
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool withValue,) = address(registry).call{value: 1}(calls[i]);
            assertFalse(withValue, "a call with value must revert");
            assertEq(address(registry).balance, 0);

            // The same call without value succeeds, so the value is the only reason for the revert.
            (bool withoutValue,) = address(registry).call(calls[i]);
            assertTrue(withoutValue, "the same call without value succeeds");
            vm.revertToState(snapshot);
        }
    }

    function test_RevertWhen_EtherIsSentWithoutCalldataOrToUnknownSelector() public {
        vm.deal(address(this), 1 ether);

        (bool plainTransfer,) = address(registry).call{value: 1}("");
        assertFalse(plainTransfer, "no receive function");

        (bool emptyCall,) = address(registry).call("");
        assertFalse(emptyCall, "no fallback function");

        (bool unknownSelector,) = address(registry).call(abi.encodeWithSignature("withdraw()"));
        assertFalse(unknownSelector, "no fallback function");

        (bool unknownWithValue,) = address(registry).call{value: 1}(abi.encodeWithSignature("withdraw()"));
        assertFalse(unknownWithValue, "no payable fallback function");

        assertEq(address(registry).balance, 0);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------

    function _versionDigest(bytes32 indexId, uint32 version) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                registry.getVersion(indexId, version),
                registry.specOf(indexId, version),
                registry.constituentsOf(indexId, version)
            )
        );
    }
}
