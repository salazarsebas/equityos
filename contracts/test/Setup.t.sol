// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {Test} from "forge-std/Test.sol";

/// @notice Guards the toolchain configuration in foundry.toml against silent drift.
/// @dev Bytecode must only use opcodes that Base executes, so the EVM version is asserted here.
contract SetupTest is Test {
    function test_EvmVersionIsPrague() public pure {
        assertEq(vm.getEvmVersion(), "prague");
    }

    /// @dev TSTORE and TLOAD exist from Cancun onward, so an older compiler or EVM target fails here.
    function test_TransientStorageIsAvailable() public {
        uint256 loaded;
        assembly ("memory-safe") {
            tstore(0, 42)
            loaded := tload(0)
        }
        assertEq(loaded, 42);
    }
}
