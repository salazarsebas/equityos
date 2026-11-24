// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {Test} from "forge-std/Test.sol";

import {MockExecutor, MockRouter, MockToken, SwapDescriptionV2, SwapExecutionParams} from "./ExecutionMocks.sol";

/// @dev The mocks of the browser tests behave as the app's verification assumes the router does.
contract ExecutionMocksTest is Test {
    MockToken internal usdc;
    MockToken internal stock;
    MockRouter internal router;
    MockExecutor internal executor;
    address internal user = makeAddr("user");

    function setUp() public {
        usdc = new MockToken();
        usdc.initialize("USDC", 6);
        stock = new MockToken();
        stock.initialize("STKc", 8);
        router = new MockRouter();
        executor = new MockExecutor();
        usdc.mint(user, 1000e6);
        stock.mint(address(executor), 100e8);
    }

    function _targetData(uint256 payout, address recipient, uint256 deadline) internal view returns (bytes memory) {
        bytes32[] memory words = new bytes32[](18);
        words[0] = bytes32(uint256(uint160(address(stock))));
        words[1] = bytes32(payout);
        words[8] = bytes32(uint256(uint160(recipient)));
        words[16] = bytes32(deadline);
        return abi.encodePacked(bytes20(0xD7a5C6B52756E795F680b0f7e0C2f21281DDe6ef), words);
    }

    function _params(
        uint256 amount,
        uint256 minimum,
        uint256 payout
    )
        internal
        view
        returns (SwapExecutionParams memory)
    {
        address[] memory receivers = new address[](1);
        receivers[0] = address(executor);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        return SwapExecutionParams({
            callTarget: address(executor),
            approveTarget: address(0),
            targetData: _targetData(payout, user, block.timestamp + 60),
            desc: SwapDescriptionV2({
                srcToken: address(usdc),
                dstToken: address(stock),
                srcReceivers: receivers,
                srcAmounts: amounts,
                feeReceivers: new address[](0),
                feeAmounts: new uint256[](0),
                dstReceiver: user,
                amount: amount,
                minReturnAmount: minimum,
                flags: 0x200,
                permit: ""
            }),
            clientData: ""
        });
    }

    function test_Swap_PullsExactlyAndDeliversAtLeastTheMinimum() public {
        vm.startPrank(user);
        usdc.approve(address(router), 300e6);
        (uint256 returned,) = router.swap(_params(300e6, 1e8, 2e8));
        vm.stopPrank();
        assertEq(returned, 2e8);
        assertEq(usdc.balanceOf(user), 700e6);
        assertEq(stock.balanceOf(user), 2e8);
        assertEq(usdc.allowance(user, address(router)), 0);
    }

    function test_Swap_RevertsBelowTheMinimum() public {
        vm.startPrank(user);
        usdc.approve(address(router), 300e6);
        vm.expectRevert(abi.encodeWithSelector(MockRouter.ReturnAmountIsNotEnough.selector, 1e8, 2e8));
        router.swap(_params(300e6, 2e8, 1e8));
        vm.stopPrank();
    }

    function test_Swap_RevertsWithoutTheApproval() public {
        vm.prank(user);
        vm.expectRevert(MockToken.InsufficientAllowance.selector);
        router.swap(_params(300e6, 1e8, 2e8));
    }

    function test_Swap_AcceptsTrailingCalldata() public {
        vm.prank(user);
        usdc.approve(address(router), 300e6);
        bytes memory call = abi.encodeCall(MockRouter.swap, (_params(300e6, 1e8, 2e8)));
        vm.prank(user);
        (bool ok,) = address(router).call(abi.encodePacked(call, hex"0102030080218021802180218021802180218021"));
        assertTrue(ok);
    }

    function test_Executor_RefusesAnExpiredRoute() public {
        bytes memory data = _targetData(1, user, block.timestamp - 1);
        (bool ok,) = address(executor).call(data);
        assertFalse(ok);
    }

    function test_Token_InitializesOnce() public {
        vm.expectRevert(MockToken.AlreadyInitialized.selector);
        usdc.initialize("X", 1);
    }
}
