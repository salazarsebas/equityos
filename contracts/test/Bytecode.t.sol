// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {Test} from "forge-std/Test.sol";

import {IndexRegistry} from "../src/IndexRegistry.sol";
import {RebalanceLog} from "../src/RebalanceLog.sol";
import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";

/// @notice Structural guarantees checked on the compiled runtime bytecode instead of on behavior: the
///         opcodes that would be needed to move funds, call out, delegate or self-destruct are not present.
contract BytecodeTest is Test {
    uint8 internal constant TLOAD = 0x5c;
    uint8 internal constant TSTORE = 0x5d;
    uint8 internal constant SSTORE = 0x55;
    uint8 internal constant CREATE = 0xf0;
    uint8 internal constant CALL = 0xf1;
    uint8 internal constant CALLCODE = 0xf2;
    uint8 internal constant DELEGATECALL = 0xf4;
    uint8 internal constant CREATE2 = 0xf5;
    uint8 internal constant STATICCALL = 0xfa;
    uint8 internal constant SELFDESTRUCT = 0xff;

    function test_Registry_HasNoCallCreateOrSelfdestructOpcode() public {
        uint256[256] memory counts = _opcodeCounts(address(new IndexRegistry()).code);

        assertEq(counts[CALL], 0, "CALL");
        assertEq(counts[CALLCODE], 0, "CALLCODE");
        assertEq(counts[DELEGATECALL], 0, "DELEGATECALL");
        assertEq(counts[STATICCALL], 0, "STATICCALL");
        assertEq(counts[CREATE], 0, "CREATE");
        assertEq(counts[CREATE2], 0, "CREATE2");
        assertEq(counts[SELFDESTRUCT], 0, "SELFDESTRUCT");
        assertGt(counts[SSTORE], 0, "sanity: the walk sees the storage writes");
    }

    function test_Log_OnlyMakesStaticCallsAndWritesNoStorage() public {
        uint256[256] memory counts = _opcodeCounts(address(new RebalanceLog(IIndexRegistry(address(1)))).code);

        assertEq(counts[STATICCALL], 1, "exactly one STATICCALL, to the registry");
        assertEq(counts[CALL], 0, "CALL");
        assertEq(counts[CALLCODE], 0, "CALLCODE");
        assertEq(counts[DELEGATECALL], 0, "DELEGATECALL");
        assertEq(counts[CREATE], 0, "CREATE");
        assertEq(counts[CREATE2], 0, "CREATE2");
        assertEq(counts[SELFDESTRUCT], 0, "SELFDESTRUCT");
        assertEq(counts[SSTORE], 0, "SSTORE");
        assertEq(counts[TSTORE], 0, "TSTORE");
        assertEq(counts[TLOAD], 0, "TLOAD");
    }

    function test_BothContractsFitTheCodeSizeLimit() public {
        assertLt(address(new IndexRegistry()).code.length, 24_576);
        assertLt(address(new RebalanceLog(IIndexRegistry(address(1)))).code.length, 24_576);
    }

    /// @dev Linear walk over the instructions. PUSH data is skipped, and so is the CBOR metadata that solc
    ///      appends after the code: its length is in the last two bytes.
    function _opcodeCounts(bytes memory code) private pure returns (uint256[256] memory counts) {
        uint256 metadataLength = (uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]);
        uint256 end = code.length - 2 - metadataLength;
        uint256 i = 0;
        while (i < end) {
            uint8 opcode = uint8(code[i]);
            ++counts[opcode];
            // PUSH1 (0x60) to PUSH32 (0x7f) carry 1 to 32 bytes of immediate data.
            i += opcode >= 0x60 && opcode <= 0x7f ? uint256(opcode) - 0x5e : 1;
        }
    }
}
