// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {Vm} from "forge-std/Vm.sol";

import {IRebalanceLog} from "../src/interfaces/IRebalanceLog.sol";
import {MockReferenceFeed, MockSmartAccount, MockStockToken} from "./mocks/UsageMocks.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// @dev The local seed relies on these behaviors to produce attestations with matching token flows.
contract UsageMocksTest is RegistryTestBase {
    MockStockToken internal token;
    MockReferenceFeed internal feed;
    MockSmartAccount internal account;

    function setUp() public override {
        super.setUp();
        token = new MockStockToken();
        feed = new MockReferenceFeed();
        account = new MockSmartAccount();
    }

    function test_Feed_AnswersAtTheBlockItIsReadIn() public {
        feed.configure("Coinbase TEST", 100e8);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();
        assertEq(feed.decimals(), 8);
        assertEq(feed.description(), "Coinbase TEST");
        assertEq(answer, 100e8);
        assertEq(updatedAt, block.timestamp);
        assertEq(startedAt, block.timestamp);
        assertEq(roundId, answeredInRound);
    }

    function test_Token_MintsAndTransfersWithLogs() public {
        vm.expectEmit(address(token));
        emit MockStockToken.Transfer(address(0), alice, 5e18);
        token.mint(alice, 5e18);
        vm.prank(alice);
        token.transfer(bob, 2e18);
        assertEq(token.balanceOf(alice), 3e18);
        assertEq(token.balanceOf(bob), 2e18);
        assertEq(token.decimals(), 18);
    }

    function test_Account_FlowsAndAttestationShareOneTransaction() public {
        bytes32 indexId = _createStatic(alice, SALT, 3);
        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        targets[0] = address(token);
        data[0] = abi.encodeCall(MockStockToken.mint, (address(account), 1e18));
        targets[1] = address(rebalanceLog);
        data[1] = abi.encodeCall(IRebalanceLog.recordRebalance, (indexId, 1));

        vm.recordLogs();
        account.execute(targets, data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].emitter, address(token));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(address(account)))));
        assertEq(logs[1].emitter, address(rebalanceLog));
        assertEq(logs[1].topics[1], bytes32(uint256(uint160(address(account)))));
    }

    function test_Account_RevertsWithTheFailingCall() public {
        address[] memory targets = new address[](1);
        bytes[] memory data = new bytes[](1);
        targets[0] = address(rebalanceLog);
        data[0] = abi.encodeCall(IRebalanceLog.recordRebalance, (bytes32(0), 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                MockSmartAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(IRebalanceLog.UnknownIndexVersion.selector, bytes32(0), uint32(1))
            )
        );
        account.execute(targets, data);

        vm.expectRevert(MockSmartAccount.LengthMismatch.selector);
        account.execute(targets, new bytes[](0));
    }
}
