// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {Vm} from "forge-std/Vm.sol";

import {RebalanceLog} from "../src/RebalanceLog.sol";
import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {IRebalanceLog} from "../src/interfaces/IRebalanceLog.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// @dev Stands in for a smart account or a batching contract that forwards the call.
contract Forwarder {
    function record(IRebalanceLog target, bytes32 indexId, uint32 version) external {
        target.recordRebalance(indexId, version);
    }
}

contract RebalanceLogTest is RegistryTestBase {
    bytes32 internal indexId;

    function setUp() public override {
        super.setUp();
        indexId = _createStatic(alice, SALT, 5);
        vm.prank(alice);
        registry.publishVersion(indexId, 2, _spec(100), _tokens(3), _noWeights());
    }

    function test_Registry_IsTheConstructorArgument() public {
        assertEq(address(rebalanceLog.REGISTRY()), address(registry));

        IIndexRegistry other = IIndexRegistry(makeAddr("other registry"));
        assertEq(address(new RebalanceLog(other).REGISTRY()), address(other));
    }

    function test_RecordRebalance_EmitsForCaller() public {
        vm.expectEmit(address(rebalanceLog));
        emit IRebalanceLog.RebalanceRecorded(bob, indexId, 1);
        vm.prank(bob);
        rebalanceLog.recordRebalance(indexId, 1);

        vm.expectEmit(address(rebalanceLog));
        emit IRebalanceLog.RebalanceRecorded(carol, indexId, 2);
        vm.prank(carol);
        rebalanceLog.recordRebalance(indexId, 2);
    }

    function test_RecordRebalance_EmitsExactlyOneEventAndWritesNoStorage() public {
        vm.record();
        vm.recordLogs();
        vm.prank(bob);
        rebalanceLog.recordRebalance(indexId, 2);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "exactly one event");
        assertEq(logs[0].emitter, address(rebalanceLog));
        assertEq(logs[0].topics.length, 4);
        assertEq(logs[0].topics[0], IRebalanceLog.RebalanceRecorded.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(bob))));
        assertEq(logs[0].topics[2], indexId);
        assertEq(logs[0].topics[3], bytes32(uint256(2)));
        assertEq(logs[0].data.length, 0);

        (, bytes32[] memory logWrites) = vm.accesses(address(rebalanceLog));
        assertEq(logWrites.length, 0, "the log writes no storage");
        (, bytes32[] memory registryWrites) = vm.accesses(address(registry));
        assertEq(registryWrites.length, 0, "the registry is only read");
    }

    function test_RevertWhen_IndexIsUnknown() public {
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(IRebalanceLog.UnknownIndexVersion.selector, unknown, 1));
        rebalanceLog.recordRebalance(unknown, 1);
    }

    function test_RevertWhen_VersionIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(IRebalanceLog.UnknownIndexVersion.selector, indexId, 0));
        rebalanceLog.recordRebalance(indexId, 0);
    }

    function test_RevertWhen_VersionIsAfterLatest() public {
        vm.expectRevert(abi.encodeWithSelector(IRebalanceLog.UnknownIndexVersion.selector, indexId, 3));
        rebalanceLog.recordRebalance(indexId, 3);

        vm.expectRevert(abi.encodeWithSelector(IRebalanceLog.UnknownIndexVersion.selector, indexId, type(uint32).max));
        rebalanceLog.recordRebalance(indexId, type(uint32).max);
    }

    function test_RevertedCallEmitsNothing() public {
        vm.recordLogs();
        vm.expectRevert();
        rebalanceLog.recordRebalance(indexId, 3);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_RecordRebalance_VersionBecomesValidOncePublished() public {
        vm.expectRevert(abi.encodeWithSelector(IRebalanceLog.UnknownIndexVersion.selector, indexId, 3));
        rebalanceLog.recordRebalance(indexId, 3);

        vm.prank(alice);
        registry.publishVersion(indexId, 3, _spec(10), _noTokens(), _noWeights());

        vm.expectEmit(address(rebalanceLog));
        emit IRebalanceLog.RebalanceRecorded(address(this), indexId, 3);
        rebalanceLog.recordRebalance(indexId, 3);
    }

    function test_RecordRebalance_DeprecatedIndexIsAccepted() public {
        vm.prank(alice);
        registry.deprecate(indexId);

        vm.expectEmit(address(rebalanceLog));
        emit IRebalanceLog.RebalanceRecorded(bob, indexId, 1);
        vm.prank(bob);
        rebalanceLog.recordRebalance(indexId, 1);
    }

    function test_RecordRebalance_AccountIsTheDirectCallerNotTxOrigin() public {
        Forwarder forwarder = new Forwarder();

        vm.expectEmit(address(rebalanceLog));
        emit IRebalanceLog.RebalanceRecorded(address(forwarder), indexId, 1);
        vm.prank(bob, bob);
        forwarder.record(rebalanceLog, indexId, 1);
    }

    function testFuzz_RecordRebalance(address caller, bytes32 anyIndexId, uint32 version) public {
        bool valid = anyIndexId == indexId && (version == 1 || version == 2);
        if (valid) {
            vm.expectEmit(address(rebalanceLog));
            emit IRebalanceLog.RebalanceRecorded(caller, anyIndexId, version);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IRebalanceLog.UnknownIndexVersion.selector, anyIndexId, version));
        }
        vm.prank(caller);
        rebalanceLog.recordRebalance(anyIndexId, version);
    }

    function testFuzz_RecordRebalance_ExistingVersions(address caller, uint32 version) public {
        version = uint32(bound(version, 1, 2));
        vm.expectEmit(address(rebalanceLog));
        emit IRebalanceLog.RebalanceRecorded(caller, indexId, version);
        vm.prank(caller);
        rebalanceLog.recordRebalance(indexId, version);
    }

    function test_RevertWhen_EtherIsSent() public {
        vm.deal(address(this), 1 ether);
        bytes memory record = abi.encodeCall(rebalanceLog.recordRebalance, (indexId, 1));

        (bool recordWithValue,) = address(rebalanceLog).call{value: 1}(record);
        assertFalse(recordWithValue, "recordRebalance is not payable");
        (bool recordWithoutValue,) = address(rebalanceLog).call(record);
        assertTrue(recordWithoutValue, "the same call without value succeeds");

        (bool getterWithValue,) = address(rebalanceLog).call{value: 1}(abi.encodeCall(rebalanceLog.REGISTRY, ()));
        assertFalse(getterWithValue, "REGISTRY is not payable");
        (bool plainTransfer,) = address(rebalanceLog).call{value: 1}("");
        assertFalse(plainTransfer, "no receive function");
        (bool emptyCall,) = address(rebalanceLog).call("");
        assertFalse(emptyCall, "no fallback function");
        (bool unknownSelector,) = address(rebalanceLog).call{value: 1}(abi.encodeWithSignature("withdraw()"));
        assertFalse(unknownSelector, "no payable fallback function");

        assertEq(address(rebalanceLog).balance, 0);
    }

    /// @dev A log pointed at an address without code is inert: every call reverts.
    function test_RevertWhen_RegistryHasNoCode() public {
        RebalanceLog orphan = new RebalanceLog(IIndexRegistry(makeAddr("no code")));
        vm.expectRevert();
        orphan.recordRebalance(indexId, 1);
    }
}
