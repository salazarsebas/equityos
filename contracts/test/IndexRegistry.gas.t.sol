// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// @notice Measured gas of publishing. The numbers are written to `snapshots/IndexRegistry.json`, which is
///         committed: a change in bytecode that moves them shows up in review and fails
///         `FORGE_SNAPSHOT_CHECK=true forge test`.
/// @dev Two figures per scenario. "execution" is the gas used by the call frame. "transaction" adds what a
///      real transaction pays on top: the 21_000 base cost and the calldata cost. The L1 data fee that Base
///      charges separately is not gas and is not included.
///
///      Only calls that touch fresh storage are measured. A test runs as a single transaction, so a slot that
///      the same test already wrote is warm and dirty, and a call that rewrites it (`publishVersion`,
///      `deprecate`) would be reported cheaper than it is onchain.
contract IndexRegistryGasTest is RegistryTestBase {
    string internal constant GROUP = "IndexRegistry";

    /// @dev Ceiling asserted for the worst case. Base caps a transaction at 16_777_216 gas (EIP-7825) and a
    ///      mainnet block at 40_000_000.
    uint256 internal constant WORST_CASE_CEILING = 12_000_000;
    uint256 internal constant TRANSACTION_GAS_CAP = 16_777_216;

    function test_Gas_CreateIndex_Typical() public {
        bytes memory spec = _spec(600);
        address[] memory tokens = _tokens(10);
        uint16[] memory weights = _weights(10);

        vm.prank(alice);
        registry.createIndex(SALT, spec, tokens, weights);
        uint256 execution = vm.snapshotGasLastCall(GROUP, "createIndex typical (600 bytes, 10 static): execution");
        uint256 transaction =
            execution + _intrinsicGas(abi.encodeCall(registry.createIndex, (SALT, spec, tokens, weights)));

        vm.snapshotValue(GROUP, "createIndex typical (600 bytes, 10 static): transaction", transaction);
        assertLt(transaction, 1_000_000, "typical create stays under 1M gas");
    }

    function test_Gas_CreateIndex_WorstCase() public {
        bytes memory spec = _spec(8192);
        address[] memory tokens = _tokens(128);
        uint16[] memory weights = _weights(128);

        vm.prank(alice);
        registry.createIndex(SALT, spec, tokens, weights);
        uint256 execution = vm.snapshotGasLastCall(GROUP, "createIndex worst case (8192 bytes, 128 static): execution");
        uint256 transaction =
            execution + _intrinsicGas(abi.encodeCall(registry.createIndex, (SALT, spec, tokens, weights)));

        vm.snapshotValue(GROUP, "createIndex worst case (8192 bytes, 128 static): transaction", transaction);
        assertLt(transaction, WORST_CASE_CEILING, "worst case stays under the asserted ceiling");
        assertLt(WORST_CASE_CEILING, TRANSACTION_GAS_CAP, "the ceiling is below the per-transaction cap");
    }

    /// @dev Reading the largest possible version must stay cheap enough for another contract to do onchain.
    ///      The storage is warm here because the test wrote it, so a cold read costs more: 2_000 gas per slot,
    ///      about 0.26M for the constituents and 0.52M for the spec.
    function test_Gas_ReadWorstCaseVersion() public {
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(8192), _tokens(128), _weights(128));

        registry.constituentsOf(indexId, 1);
        uint256 constituentsGas = vm.snapshotGasLastCall(GROUP, "constituentsOf worst case (128), warm: execution");
        registry.specOf(indexId, 1);
        uint256 specGas = vm.snapshotGasLastCall(GROUP, "specOf worst case (8192 bytes), warm: execution");

        assertLt(constituentsGas, 250_000);
        assertLt(specGas, 250_000);
    }

    /// @dev Gas a transaction pays before execution: 21_000 plus 4 per zero byte and 16 per non-zero byte of
    ///      calldata. The EIP-7623 floor (10 per calldata token) only applies when execution costs less than 6
    ///      gas per token, which is never the case for a publish.
    function _intrinsicGas(bytes memory data) private pure returns (uint256) {
        uint256 zeros = 0;
        for (uint256 i = 0; i < data.length; ++i) {
            if (data[i] == 0) ++zeros;
        }
        uint256 nonZeros = data.length - zeros;
        return 21_000 + zeros * 4 + nonZeros * 16;
    }
}
