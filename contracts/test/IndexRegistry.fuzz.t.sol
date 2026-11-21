// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

contract IndexRegistryFuzzTest is RegistryTestBase {
    /// @dev Arbitrary bytes, including 0x00 and invalid UTF-8, come back byte for byte.
    function testFuzz_SpecRoundTrip(bytes calldata spec) public {
        vm.assume(spec.length > 0 && spec.length <= 8192);

        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, spec, _noTokens(), _noWeights());

        assertEq(registry.specOf(indexId, 1), spec);
        assertEq(registry.getVersion(indexId, 1).specHash, keccak256(spec));
        assertEq(registry.getVersion(indexId, 1).specSize, spec.length);
    }

    /// @dev Lengths around the 31/32-byte boundary where Solidity switches between short and long storage
    ///      layouts for `bytes`, with arbitrary content.
    function testFuzz_SpecRoundTrip_StorageLayoutBoundaries(bytes32 seed) public {
        uint16[9] memory sizes = [uint16(1), 31, 32, 33, 63, 64, 65, 8191, 8192];
        for (uint256 i = 0; i < sizes.length; ++i) {
            bytes memory spec = _randomBytes(seed, sizes[i]);
            vm.prank(alice);
            bytes32 indexId = registry.createIndex(bytes32(i), spec, _noTokens(), _noWeights());
            assertEq(registry.specOf(indexId, 1), spec);
            assertEq(registry.getVersion(indexId, 1).specHash, keccak256(spec));
        }
    }

    function test_SpecRoundTrip_ZeroBytesAndInvalidUtf8() public {
        bytes[4] memory specs = [bytes(hex"00"), hex"0000000000", hex"c328a0a1fffe", hex"7b22610000ff22807d00"];
        for (uint256 i = 0; i < specs.length; ++i) {
            vm.prank(alice);
            bytes32 indexId = registry.createIndex(bytes32(i), specs[i], _noTokens(), _noWeights());
            assertEq(registry.specOf(indexId, 1), specs[i]);
            assertEq(registry.getVersion(indexId, 1).specSize, specs[i].length);
        }
    }

    /// @dev A longer spec in a later version never bleeds into an earlier, shorter one, and the reverse.
    function testFuzz_SpecsOfDifferentVersionsAreIndependent(bytes calldata first, bytes calldata second) public {
        vm.assume(first.length > 0 && first.length <= 8192);
        vm.assume(second.length > 0 && second.length <= 8192);

        vm.startPrank(alice);
        bytes32 indexId = registry.createIndex(SALT, first, _noTokens(), _noWeights());
        registry.publishVersion(indexId, 2, second, _noTokens(), _noWeights());
        vm.stopPrank();

        assertEq(registry.specOf(indexId, 1), first);
        assertEq(registry.specOf(indexId, 2), second);
    }

    /// @dev Random sorted tokens with random positive weights normalized to 10_000 always publish and read back.
    function testFuzz_ValidStaticSet(uint256 seed, uint256 countSeed) public {
        uint256 count = bound(countSeed, 1, 128);
        address[] memory tokens = _randomSortedTokens(seed, count);
        uint16[] memory weights = _randomWeights(seed, count);

        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(64), tokens, weights);

        IIndexRegistry.VersionInfo memory version = registry.getVersion(indexId, 1);
        assertEq(uint8(version.composition), uint8(IIndexRegistry.Composition.Static));
        assertEq(version.constituentCount, count);

        IIndexRegistry.Constituent[] memory constituents = registry.constituentsOf(indexId, 1);
        assertEq(constituents.length, count);
        for (uint256 i = 0; i < count; ++i) {
            assertEq(constituents[i].token, tokens[i]);
            assertEq(constituents[i].weightBps, weights[i]);
        }
        _assertVersionWellFormed(indexId, 1);
    }

    /// @dev Random sorted tokens without weights always publish as DynamicWeights with zero weights.
    function testFuzz_ValidDynamicSet(uint256 seed, uint256 countSeed) public {
        uint256 count = bound(countSeed, 1, 128);
        address[] memory tokens = _randomSortedTokens(seed, count);

        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(64), tokens, _noWeights());

        assertEq(uint8(registry.getVersion(indexId, 1).composition), uint8(IIndexRegistry.Composition.DynamicWeights));
        IIndexRegistry.Constituent[] memory constituents = registry.constituentsOf(indexId, 1);
        assertEq(constituents.length, count);
        for (uint256 i = 0; i < count; ++i) {
            assertEq(constituents[i].token, tokens[i]);
            assertEq(constituents[i].weightBps, 0);
        }
    }

    /// @dev Breaking the order at a random position reverts with that position, with or without weights.
    function testFuzz_RevertWhen_TokensAreNotAscending(
        uint256 seed,
        uint256 countSeed,
        uint256 positionSeed,
        bool duplicate,
        bool withWeights
    )
        public
    {
        uint256 count = bound(countSeed, 2, 128);
        uint256 position = bound(positionSeed, 1, count - 1);
        address[] memory tokens = _randomSortedTokens(seed, count);
        if (duplicate) {
            tokens[position] = tokens[position - 1];
        } else {
            (tokens[position - 1], tokens[position]) = (tokens[position], tokens[position - 1]);
        }

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TokensNotStrictlyAscending.selector, position));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(64), tokens, withWeights ? _randomWeights(seed, count) : _noWeights());
        assertEq(registry.indexCount(), 0);
    }

    /// @dev Moving the sum away from 10_000 by any amount, in either direction, reverts with the actual sum.
    function testFuzz_RevertWhen_WeightSumIsNotBps(
        uint256 seed,
        uint256 countSeed,
        uint256 positionSeed,
        uint256 deltaSeed,
        bool increase
    )
        public
    {
        uint256 count = bound(countSeed, 1, 128);
        uint256 position = bound(positionSeed, 0, count - 1);
        address[] memory tokens = _randomSortedTokens(seed, count);
        uint16[] memory weights = _randomWeights(seed, count);

        uint256 expectedSum;
        if (increase || weights[position] == 1) {
            uint256 delta = bound(deltaSeed, 1, 65_535 - weights[position]);
            // forge-lint: disable-next-line(unsafe-typecast)
            weights[position] += uint16(delta);
            expectedSum = 10_000 + delta;
        } else {
            // Keep the weight positive so that the sum check, not the zero check, is the one that fires.
            uint256 delta = bound(deltaSeed, 1, weights[position] - 1);
            // forge-lint: disable-next-line(unsafe-typecast)
            weights[position] -= uint16(delta);
            expectedSum = 10_000 - delta;
        }

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.InvalidWeightSum.selector, expectedSum));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(64), tokens, weights);
        assertEq(registry.indexCount(), 0);
    }

    function testFuzz_RevertWhen_AnyStaticWeightIsZero(uint256 seed, uint256 countSeed, uint256 positionSeed) public {
        uint256 count = bound(countSeed, 1, 128);
        uint256 position = bound(positionSeed, 0, count - 1);
        uint16[] memory weights = _randomWeights(seed, count);
        weights[position] = 0;

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.ZeroWeight.selector, position));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(64), _randomSortedTokens(seed, count), weights);
    }

    function testFuzz_RevertWhen_LengthsDiffer(uint256 tokenCountSeed, uint256 weightCountSeed) public {
        uint256 tokenCount = bound(tokenCountSeed, 0, 128);
        uint256 weightCount = bound(weightCountSeed, 1, 200);
        vm.assume(tokenCount != weightCount);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.LengthMismatch.selector, tokenCount, weightCount));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(64), _tokens(tokenCount), new uint16[](weightCount));
    }

    function testFuzz_RevertWhen_SpecOrConstituentsExceedCaps(uint256 specSizeSeed, uint256 countSeed) public {
        uint256 specSize = bound(specSizeSeed, 8193, 20_000);
        uint256 count = bound(countSeed, 129, 400);

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.SpecTooLarge.selector, specSize, 8192));
        vm.prank(alice);
        registry.createIndex(SALT, new bytes(specSize), _noTokens(), _noWeights());

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.TooManyConstituents.selector, count, 128));
        vm.prank(alice);
        registry.createIndex(SALT, _spec(64), _tokens(count), _noWeights());
    }

    /// @dev Completely arbitrary arguments either revert or leave a version that satisfies every guarantee.
    function testFuzz_ArbitraryArgumentsNeverStoreAnInvalidVersion(
        bytes32 salt,
        bytes calldata spec,
        address[] calldata tokens,
        uint16[] calldata weights
    )
        public
    {
        vm.prank(alice);
        try registry.createIndex(salt, spec, tokens, weights) returns (bytes32 indexId) {
            assertEq(indexId, registry.computeIndexId(alice, salt));
            assertEq(registry.specOf(indexId, 1), spec);
            assertEq(registry.constituentsOf(indexId, 1).length, tokens.length);
            _assertVersionWellFormed(indexId, 1);
        } catch {
            assertEq(registry.indexCount(), 0);
            assertFalse(registry.exists(registry.computeIndexId(alice, salt)));
        }
    }

    /// @dev Only `latestVersion + 1` is ever accepted as the expected version.
    function testFuzz_VersionGuard(uint8 published, uint32 expectedVersion) public {
        uint32 latest = uint32(bound(published, 1, 12));
        bytes32 indexId = _createStatic(alice, SALT, 2);
        for (uint32 v = 2; v <= latest; ++v) {
            vm.prank(alice);
            registry.publishVersion(indexId, v, _spec(8), _noTokens(), _noWeights());
        }

        if (expectedVersion != latest + 1) {
            vm.expectRevert(
                abi.encodeWithSelector(IIndexRegistry.UnexpectedVersion.selector, expectedVersion, latest + 1)
            );
        }
        vm.prank(alice);
        registry.publishVersion(indexId, expectedVersion, _spec(8), _noTokens(), _noWeights());

        assertEq(registry.getIndex(indexId).latestVersion, expectedVersion == latest + 1 ? latest + 1 : latest);
    }

    /// @dev No caller other than the creator can publish to or deprecate an index, whatever the arguments.
    function testFuzz_RevertWhen_CallerIsNotCreator(address caller, uint32 expectedVersion, bool deprecated) public {
        vm.assume(caller != alice);
        bytes32 indexId = _createStatic(alice, SALT, 2);
        if (deprecated) {
            vm.prank(alice);
            registry.deprecate(indexId);
        }
        bytes32 before = keccak256(abi.encode(registry.getIndex(indexId)));

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotCreator.selector, indexId, caller));
        vm.prank(caller);
        registry.publishVersion(indexId, expectedVersion, _spec(8), _noTokens(), _noWeights());

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotCreator.selector, indexId, caller));
        vm.prank(caller);
        registry.deprecate(indexId);

        assertEq(keccak256(abi.encode(registry.getIndex(indexId))), before);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Generators
    // ---------------------------------------------------------------------------------------------------------

    function _randomBytes(bytes32 seed, uint256 size) private pure returns (bytes memory data) {
        data = new bytes(size);
        bytes32 word;
        for (uint256 i = 0; i < size; ++i) {
            if (i % 32 == 0) word = keccak256(abi.encode(seed, i));
            data[i] = word[i % 32];
        }
    }

    /// @dev Strictly ascending non-zero addresses. Each gap is below 2**152, so 128 of them fit in 160 bits.
    function _randomSortedTokens(uint256 seed, uint256 count) private pure returns (address[] memory tokens) {
        tokens = new address[](count);
        uint160 previous = 0;
        for (uint256 i = 0; i < count; ++i) {
            uint160 gap = uint160(uint256(keccak256(abi.encode(seed, "token", i))) % (1 << 152)) + 1;
            previous += gap;
            tokens[i] = address(previous);
        }
    }

    /// @dev Positive weights that sum to exactly 10_000: one bps each, then the rest split at random.
    function _randomWeights(uint256 seed, uint256 count) private pure returns (uint16[] memory weights) {
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
