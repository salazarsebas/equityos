// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {Test} from "forge-std/Test.sol";

import {IndexRegistry} from "../../src/IndexRegistry.sol";
import {RebalanceLog} from "../../src/RebalanceLog.sol";
import {IIndexRegistry} from "../../src/interfaces/IIndexRegistry.sol";

/// @notice Shared deployment, input builders and assertions for the registry and log tests.
abstract contract RegistryTestBase is Test {
    IndexRegistry internal registry;
    RebalanceLog internal rebalanceLog;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    bytes32 internal constant SALT = keccak256("blue-chips");

    function setUp() public virtual {
        registry = new IndexRegistry();
        rebalanceLog = new RebalanceLog(registry);
        // Realistic, non-zero clock so that timestamps and block numbers are distinguishable from defaults.
        vm.warp(1_800_000_000);
        vm.roll(60_000_000);
    }

    /// @dev `size` bytes of JSON-like ASCII with no zero byte, so calldata is priced like a real spec.
    function _spec(uint256 size) internal pure returns (bytes memory spec) {
        bytes memory pattern = bytes(
            "{\"schema\":\"equityos.index/1\",\"chainId\":8453,\"weighting\":\"static\",\"rebalance\":{\"driftBps\":500}}"
        );
        spec = new bytes(size);
        for (uint256 i = 0; i < size; ++i) {
            spec[i] = pattern[i % pattern.length];
        }
    }

    /// @dev `count` strictly ascending addresses with mostly non-zero bytes, like real token addresses.
    function _tokens(uint256 count) internal pure returns (address[] memory tokens) {
        tokens = new address[](count);
        uint160 base = uint160(0x00B2a1C3d4E5f60718293a4b5C6d7e8F90A1b200);
        for (uint256 i = 0; i < count; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            tokens[i] = address(base + uint160(i + 1) * uint160(0x0101010101010101010101010101010101));
        }
    }

    /// @dev `count` positive weights that sum to exactly 10_000 bps. The remainder goes to the first weight.
    function _weights(uint256 count) internal pure returns (uint16[] memory weights) {
        weights = new uint16[](count);
        if (count == 0) return weights;
        uint256 each = 10_000 / count;
        for (uint256 i = 0; i < count; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            weights[i] = uint16(each);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        weights[0] += uint16(10_000 - each * count);
    }

    function _noTokens() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _noWeights() internal pure returns (uint16[] memory) {
        return new uint16[](0);
    }

    /// @dev Creates a static index with `count` constituents as `creator`.
    function _createStatic(address creator, bytes32 salt, uint256 count) internal returns (bytes32 indexId) {
        vm.prank(creator);
        indexId = registry.createIndex(salt, _spec(600), _tokens(count), _weights(count));
    }

    /// @dev Asserts every structural guarantee the registry gives about a stored version.
    function _assertVersionWellFormed(bytes32 indexId, uint32 version) internal view {
        IIndexRegistry.VersionInfo memory info = registry.getVersion(indexId, version);
        bytes memory spec = registry.specOf(indexId, version);
        IIndexRegistry.Constituent[] memory constituents = registry.constituentsOf(indexId, version);

        assertEq(info.specHash, keccak256(spec), "specHash is the hash of the stored spec");
        assertEq(info.specSize, spec.length, "specSize is the stored spec length");
        assertGt(info.specSize, 0, "spec is not empty");
        assertLe(info.specSize, registry.MAX_SPEC_BYTES(), "spec within the size cap");
        assertEq(info.constituentCount, constituents.length, "constituentCount is the stored count");
        assertLe(info.constituentCount, registry.MAX_CONSTITUENTS(), "constituents within the cap");

        uint256 sum = 0;
        address previous = address(0);
        for (uint256 i = 0; i < constituents.length; ++i) {
            assertGt(uint160(constituents[i].token), uint160(previous), "tokens strictly ascending");
            previous = constituents[i].token;
            sum += constituents[i].weightBps;
            if (info.composition == IIndexRegistry.Composition.Static) {
                assertGt(constituents[i].weightBps, 0, "static weight is positive");
            } else {
                assertEq(constituents[i].weightBps, 0, "non-static weight is zero");
            }
        }

        if (info.composition == IIndexRegistry.Composition.Static) {
            assertGt(constituents.length, 0, "static has constituents");
            assertEq(sum, registry.BPS(), "static weights sum to BPS");
        } else if (info.composition == IIndexRegistry.Composition.DynamicWeights) {
            assertGt(constituents.length, 0, "dynamic has constituents");
        } else {
            assertEq(constituents.length, 0, "rule based has no constituents");
        }
    }
}
