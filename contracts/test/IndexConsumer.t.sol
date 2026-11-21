// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {IndexConsumer} from "./examples/IndexConsumer.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// @notice Composability: a contract that knows only the interface reads an index and uses it onchain.
contract IndexConsumerTest is RegistryTestBase {
    IndexConsumer internal consumer;

    function setUp() public override {
        super.setUp();
        consumer = new IndexConsumer(registry);
    }

    function test_TargetAllocation_UsesStoredWeights() public {
        address[] memory tokens = _tokens(3);
        uint16[] memory weights = new uint16[](3);
        (weights[0], weights[1], weights[2]) = (5000, 3000, 2000);
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(200), tokens, weights);

        (address[] memory outTokens, uint256[] memory amounts, uint256 unallocated) =
            consumer.targetAllocation(indexId, 1, 1_000_000);

        assertEq(outTokens, tokens);
        assertEq(amounts[0], 500_000);
        assertEq(amounts[1], 300_000);
        assertEq(amounts[2], 200_000);
        assertEq(unallocated, 0);
    }

    function test_TargetAllocation_RoundsDownAndReportsTheRemainder() public {
        uint16[] memory weights = new uint16[](3);
        (weights[0], weights[1], weights[2]) = (3333, 3333, 3334);
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(200), _tokens(3), weights);

        (, uint256[] memory amounts, uint256 unallocated) = consumer.targetAllocation(indexId, 1, 100);
        assertEq(amounts[0], 33);
        assertEq(amounts[1], 33);
        assertEq(amounts[2], 33);
        assertEq(unallocated, 1);
    }

    function testFuzz_TargetAllocation_ConservesTotal(uint256 countSeed, uint128 total) public {
        uint256 count = bound(countSeed, 1, 64);
        bytes32 indexId = _createStatic(alice, SALT, count);

        (address[] memory tokens, uint256[] memory amounts, uint256 unallocated) =
            consumer.targetAllocation(indexId, 1, total);

        assertEq(tokens.length, count);
        uint256 sum = unallocated;
        for (uint256 i = 0; i < count; ++i) {
            sum += amounts[i];
        }
        assertEq(sum, total);
        assertLt(unallocated, count, "less than one unit lost per constituent");
    }

    function test_TargetAllocation_FollowsThePinnedVersion() public {
        bytes32 indexId = _createStatic(alice, SALT, 2);
        vm.prank(alice);
        registry.publishVersion(indexId, 2, _spec(200), _tokens(4), _weights(4));

        (address[] memory v1Tokens,,) = consumer.targetAllocation(indexId, 1, 1000);
        (address[] memory v2Tokens,,) = consumer.targetAllocation(indexId, 2, 1000);
        assertEq(v1Tokens.length, 2);
        assertEq(v2Tokens.length, 4);
    }

    function test_RevertWhen_TargetAllocationOnNonStaticVersion() public {
        vm.startPrank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(200), _tokens(3), _noWeights());
        registry.publishVersion(indexId, 2, _spec(200), _noTokens(), _noWeights());
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(IndexConsumer.NotStatic.selector, indexId, 1));
        consumer.targetAllocation(indexId, 1, 1000);
        vm.expectRevert(abi.encodeWithSelector(IndexConsumer.NotStatic.selector, indexId, 2));
        consumer.targetAllocation(indexId, 2, 1000);
    }

    function test_RevertWhen_TargetAllocationOnUnknownVersion() public {
        bytes32 indexId = _createStatic(alice, SALT, 2);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, indexId, 2));
        consumer.targetAllocation(indexId, 2, 1000);
    }

    function test_StaticWeightOf_BinarySearchOverAscendingTokens() public {
        address[] memory tokens = _tokens(64);
        uint16[] memory weights = _weights(64);
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(200), tokens, weights);

        for (uint256 i = 0; i < tokens.length; ++i) {
            assertEq(consumer.staticWeightOf(indexId, 1, tokens[i]), weights[i]);
            assertTrue(consumer.isConstituent(indexId, 1, tokens[i]));

            // The address right after a constituent is never one, because of the gap between tokens.
            address neighbour = address(uint160(tokens[i]) + 1);
            assertEq(consumer.staticWeightOf(indexId, 1, neighbour), 0);
            assertFalse(consumer.isConstituent(indexId, 1, neighbour));
        }

        assertFalse(consumer.isConstituent(indexId, 1, address(0)));
        assertFalse(consumer.isConstituent(indexId, 1, address(type(uint160).max)));
        assertEq(consumer.staticWeightOf(indexId, 1, address(0)), 0);
    }

    /// @dev A DynamicWeights version stores zero weights. The consumer must refuse to read them as weights.
    function test_RevertWhen_StaticWeightOfOnDynamicWeightsVersion() public {
        address[] memory tokens = _tokens(3);
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(200), tokens, _noWeights());

        for (uint256 i = 0; i < tokens.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IndexConsumer.NotStatic.selector, indexId, 1));
            consumer.staticWeightOf(indexId, 1, tokens[i]);
            // Membership is still a valid question for a dynamic version.
            assertTrue(consumer.isConstituent(indexId, 1, tokens[i]));
        }
    }

    function test_RevertWhen_StaticWeightOfOnRuleBasedVersion() public {
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(200), _noTokens(), _noWeights());

        vm.expectRevert(abi.encodeWithSelector(IndexConsumer.NotStatic.selector, indexId, 1));
        consumer.staticWeightOf(indexId, 1, _tokens(1)[0]);
        assertFalse(consumer.isConstituent(indexId, 1, _tokens(1)[0]));
    }

    function test_RevertWhen_LookupOnUnknownVersion() public {
        bytes32 indexId = _createStatic(alice, SALT, 2);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, indexId, 2));
        consumer.staticWeightOf(indexId, 2, _tokens(1)[0]);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, indexId, 2));
        consumer.isConstituent(indexId, 2, _tokens(1)[0]);
    }
}
