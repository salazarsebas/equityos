// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {RegistryHandler} from "./invariant/RegistryHandler.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// @notice Stateful invariants of the registry and the log under random sequences of calls from four actors.
/// @dev The ids I1 to I12 are the ones documented in docs/security/index-registry.md. I12 is asserted inside
///      the handler, next to the call it is about. Each `invariant_` function runs its own campaign.
contract IndexRegistryInvariantTest is RegistryTestBase {
    RegistryHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new RegistryHandler(registry, rebalanceLog);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = RegistryHandler.createIndex.selector;
        selectors[1] = RegistryHandler.publishVersion.selector;
        selectors[2] = RegistryHandler.publishWithWrongVersion.selector;
        selectors[3] = RegistryHandler.publishInvalidArguments.selector;
        selectors[4] = RegistryHandler.actAsNonCreator.selector;
        selectors[5] = RegistryHandler.deprecate.selector;
        selectors[6] = RegistryHandler.recordRebalance.selector;
        selectors[7] = RegistryHandler.sendEther.selector;
        selectors[8] = RegistryHandler.advanceTime.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev I1, I4, I5, I9, I10: index records and enumeration match the ghost model exactly.
    function invariant_IndexesMatchTheModel() public view {
        uint256 count = handler.ghostIndexCount();
        assertEq(registry.indexCount(), count, "I10: indexCount equals successful creations");
        assertEq(count, handler.created(), "I10: indexCount equals successful creations");

        for (uint256 i = 0; i < count; ++i) {
            bytes32 indexId = handler.ghostIndexIdAt(i);
            assertEq(registry.indexIdAt(i), indexId, "I10: enumeration order is stable");
            assertTrue(registry.exists(indexId));

            IIndexRegistry.IndexInfo memory info = registry.getIndex(indexId);
            uint32 latest = handler.ghostLatestVersion(indexId);
            assertGe(info.latestVersion, 1, "I1: at least one version");
            assertEq(info.latestVersion, latest, "I1/I9: latestVersion only moves on a successful publish");
            assertEq(info.creator, handler.ghostCreator(indexId), "I4: creator never changes");
            assertEq(registry.computeIndexId(info.creator, handler.ghostSalt(indexId)), indexId, "I4: id derivation");
            assertEq(info.createdAt, handler.ghostCreatedAt(indexId), "createdAt never changes");
            assertEq(info.deprecatedAt, handler.ghostDeprecatedAt(indexId), "I9: deprecatedAt is set at most once");

            assertFalse(registry.versionExists(indexId, 0), "I5: version 0 never exists");
            assertFalse(registry.versionExists(indexId, latest + 1), "I5: nothing after the latest version");
            assertFalse(registry.versionExists(indexId, type(uint32).max), "I5: nothing after the latest version");
            for (uint32 version = 1; version <= latest; ++version) {
                assertTrue(registry.versionExists(indexId, version), "I5: every version up to latest exists");
            }
        }
    }

    /// @dev I2, I3, I6, I7, I8: every version ever published is unchanged and well formed.
    function invariant_VersionsAreImmutableAndWellFormed() public view {
        uint256 count = handler.ghostIndexCount();
        uint256 versions = 0;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 indexId = handler.ghostIndexIdAt(i);
            uint32 latest = handler.ghostLatestVersion(indexId);
            for (uint32 version = 1; version <= latest; ++version) {
                assertEq(
                    handler.versionDigest(indexId, version),
                    handler.ghostVersionDigest(indexId, version),
                    "I2: a published version changed"
                );
                _assertVersionWellFormed(indexId, version);
                ++versions;
            }
        }
        assertEq(versions, handler.created() + handler.published(), "one version per successful publish");
    }

    /// @dev I11: neither contract ever holds ETH.
    function invariant_ContractsHoldNoEther() public view {
        assertEq(address(registry).balance, 0, "I11: registry balance");
        assertEq(address(rebalanceLog).balance, 0, "I11: log balance");
    }
}
