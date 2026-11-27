// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {BoundedExecutorSimulation} from "./simulation/BoundedExecutorSimulation.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// @notice An ERC-20 with an open mint and fixed decimals.
contract SimToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A Chainlink feed whose round is set by the test.
contract SimFeed {
    uint8 public decimals = 8;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;

    function set(int256 newAnswer, uint256 newUpdatedAt) external {
        answer = newAnswer;
        updatedAt = newUpdatedAt;
    }

    function setAnsweredInRound(uint80 round) external {
        answeredInRound = round;
    }

    function setDecimals(uint8 newDecimals) external {
        decimals = newDecimals;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @notice A router that pulls `pull` of `tokenIn` from its caller and pays `amountOut` of `tokenOut` to `to` from
///         its reserves. The test sets misbehavior through the arguments.
contract SimRouter {
    function swap(address tokenIn, uint256 pull, address tokenOut, uint256 amountOut, address to) external {
        SimToken(tokenIn).transferFrom(msg.sender, address(this), pull);
        SimToken(tokenOut).transfer(to, amountOut);
    }

    /// @dev Calls back into the executor in the middle of a swap.
    function reenter(BoundedExecutorSimulation executor, bytes calldata call) external {
        (bool success, bytes memory reason) = address(executor).call(call);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}

/// @notice The bounds of the bounded executor design, shown on a simulation that is never deployed.
contract BoundedExecutorSimulationTest is RegistryTestBase {
    uint256 internal constant USD = 1e8;
    uint256 internal constant DAY = 86_400;

    BoundedExecutorSimulation internal executor;
    SimRouter internal router;
    SimToken internal usdc;
    SimToken internal stockA;
    SimToken internal stockB;
    SimToken internal outsider;
    SimFeed internal feedA;
    SimFeed internal feedB;
    bytes32 internal indexId;
    address internal keeper = makeAddr("keeper");

    function setUp() public override {
        super.setUp();
        usdc = new SimToken(6);
        outsider = new SimToken(8);
        stockA = new SimToken(8);
        stockB = new SimToken(18);
        feedA = new SimFeed();
        feedB = new SimFeed();
        feedA.set(int256(100 * USD), block.timestamp); // 100 USD per whole token
        feedB.set(int256(25 * USD), block.timestamp); // 25 USD per whole token
        router = new SimRouter();

        // The registry takes the constituents in ascending address order.
        address[] memory constituents = new address[](2);
        (constituents[0], constituents[1]) =
            address(stockA) < address(stockB) ? (address(stockA), address(stockB)) : (address(stockB), address(stockA));
        vm.prank(alice);
        indexId = registry.createIndex(SALT, _spec(200), constituents, _weights(2));

        address[] memory tokens = new address[](3);
        address[] memory feeds = new address[](3);
        (tokens[0], tokens[1], tokens[2]) = (address(stockA), address(stockB), address(outsider));
        (feeds[0], feeds[1], feeds[2]) = (address(feedA), address(feedB), address(feedA));
        executor = new BoundedExecutorSimulation(registry, address(router), address(usdc), tokens, feeds);

        // Router reserves, and a user with 1,000 USDC and 10 of each stock, approving the executor.
        usdc.mint(address(router), 1_000_000e6);
        stockA.mint(address(router), 1_000_000e8);
        stockB.mint(address(router), 1_000_000e18);
        usdc.mint(bob, 1000e6);
        stockA.mint(bob, 10e8);
        stockB.mint(bob, 10e18);
        vm.startPrank(bob);
        usdc.approve(address(executor), type(uint256).max);
        stockA.approve(address(executor), type(uint256).max);
        stockB.approve(address(executor), type(uint256).max);
        executor.setMandate(_mandate());
        vm.stopPrank();
    }

    function _mandate() internal view returns (BoundedExecutorSimulation.Mandate memory) {
        return BoundedExecutorSimulation.Mandate({
            indexId: indexId,
            version: 1,
            keeper: keeper,
            expiresAt: uint64(block.timestamp + 30 * DAY),
            periodSeconds: uint64(DAY),
            maxDeviationBps: 100,
            maxStalenessSeconds: 3600,
            maxNotionalPerPeriodUsdE8: uint128(500 * USD)
        });
    }

    function _route(
        address tokenIn,
        uint256 pull,
        address tokenOut,
        uint256 amountOut,
        address to
    )
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(SimRouter.swap, (tokenIn, pull, tokenOut, amountOut, to));
    }

    /// @dev Sells `amountIn` of stock A for `paid` USDC, asking at least `minimum`.
    function _sellA(uint256 amountIn, uint256 minimum, uint256 paid) internal returns (uint256) {
        vm.prank(keeper);
        return executor.execute(
            bob,
            address(stockA),
            amountIn,
            address(usdc),
            minimum,
            _route(address(stockA), amountIn, address(usdc), paid, address(executor))
        );
    }

    function test_Sell_PaysTheUserEverythingTheRouterReturned() public {
        // 1 stock A at 100 USD; the band is 1%, so the minimum may be as low as 99 USDC.
        uint256 out = _sellA(1e8, 99e6, 100.5e6);

        assertEq(out, 100.5e6);
        assertEq(usdc.balanceOf(bob), 1100.5e6);
        assertEq(stockA.balanceOf(bob), 9e8);
        assertEq(usdc.balanceOf(address(executor)), 0, "holds nothing");
        assertEq(stockA.balanceOf(address(executor)), 0, "holds nothing");
        assertEq(stockA.allowance(address(executor), address(router)), 0, "approval reset");
    }

    function test_Buy_WithinTheBand() public {
        // 100 USDC buys 4 stock B at 25 USD; at 1% the minimum may be 3.96.
        vm.prank(keeper);
        uint256 out = executor.execute(
            bob,
            address(usdc),
            100e6,
            address(stockB),
            3.96e18,
            _route(address(usdc), 100e6, address(stockB), 4e18, address(executor))
        );
        assertEq(out, 4e18);
        assertEq(stockB.balanceOf(bob), 14e18);
        assertEq(usdc.balanceOf(bob), 900e6);
    }

    function test_RevertWhen_TheMinimumIsBelowTheBand() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.MinimumBelowBand.selector, 98.99e6, 99e6));
        _sellA(1e8, 98.99e6, 100e6);
    }

    function test_RevertWhen_TheRouterReturnsLessThanTheMinimum() public {
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.OutputBelowMinimum.selector, 98e6, 99e6));
        _sellA(1e8, 99e6, 98e6);
    }

    function test_RevertWhen_TheRouterPaysSomeoneElse() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.OutputBelowMinimum.selector, 0, 99e6));
        executor.execute(
            bob, address(stockA), 1e8, address(usdc), 99e6, _route(address(stockA), 1e8, address(usdc), 100e6, carol)
        );
    }

    function test_RevertWhen_TheRouterLeavesInputBehind() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.InputNotSpent.selector, 0.5e8));
        executor.execute(
            bob,
            address(stockA),
            1e8,
            address(usdc),
            99e6,
            _route(address(stockA), 0.5e8, address(usdc), 100e6, address(executor))
        );
    }

    function test_RevertWhen_TheRouterReenters() public {
        bytes memory inner = abi.encodeCall(
            BoundedExecutorSimulation.execute, (bob, address(stockA), 1e8, address(usdc), 99e6, bytes(""))
        );
        bytes memory call = abi.encodeCall(SimRouter.reenter, (executor, inner));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoundedExecutorSimulation.RouterCallFailed.selector,
                abi.encodeWithSelector(BoundedExecutorSimulation.Reentrancy.selector)
            )
        );
        executor.execute(bob, address(stockA), 1e8, address(usdc), 99e6, call);
    }

    function test_RevertWhen_TheCallerIsNotTheKeeper() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.NotKeeper.selector, carol));
        executor.execute(bob, address(stockA), 1e8, address(usdc), 99e6, "");
    }

    function test_RevertWhen_TheUserHasNoMandate() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.NoMandate.selector, carol));
        executor.execute(carol, address(stockA), 1e8, address(usdc), 99e6, "");
    }

    function test_RevertWhen_TheMandateIsRevokedOrExpired() public {
        vm.warp(block.timestamp + 30 * DAY);
        feedA.set(int256(100 * USD), block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(BoundedExecutorSimulation.MandateExpired.selector, uint64(block.timestamp))
        );
        _sellA(1e8, 99e6, 100e6);

        vm.prank(bob);
        executor.revokeMandate();
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.NoMandate.selector, bob));
        _sellA(1e8, 99e6, 100e6);
    }

    function test_RevertWhen_TheTokenIsNotAConstituentOfThePinnedVersion() public {
        outsider.mint(bob, 1e8);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(BoundedExecutorSimulation.PairNotAllowed.selector, address(outsider), address(usdc))
        );
        executor.execute(bob, address(outsider), 1e8, address(usdc), 99e6, "");
    }

    function test_RevertWhen_NeitherOrBothSidesAreUsdc() public {
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(BoundedExecutorSimulation.PairNotAllowed.selector, address(stockA), address(stockB))
        );
        executor.execute(bob, address(stockA), 1e8, address(stockB), 1, "");

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(BoundedExecutorSimulation.PairNotAllowed.selector, address(usdc), address(usdc))
        );
        executor.execute(bob, address(usdc), 1e6, address(usdc), 1, "");
    }

    function test_FollowsThePinnedVersionNotTheLatest() public {
        address[] memory onlyB = new address[](1);
        onlyB[0] = address(stockB);
        uint16[] memory whole = new uint16[](1);
        whole[0] = 10_000;
        vm.prank(alice);
        registry.publishVersion(indexId, 2, _spec(200), onlyB, whole);

        // Stock A left the index in version 2, but the mandate pins version 1.
        assertEq(_sellA(1e8, 99e6, 100e6), 100e6);
    }

    function test_RevertWhen_TheIndexIsDeprecated() public {
        vm.prank(alice);
        registry.deprecate(indexId);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.IndexDeprecated.selector, indexId));
        _sellA(1e8, 99e6, 100e6);
    }

    function test_RevertWhen_TheReferenceIsStaleOrInvalid() public {
        uint256 start = block.timestamp;
        vm.warp(start + 3601);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.ReferenceUnusable.selector, address(stockA)));
        _sellA(1e8, 99e6, 100e6);

        feedA.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.ReferenceUnusable.selector, address(stockA)));
        _sellA(1e8, 99e6, 100e6);

        feedA.set(int256(100 * USD), block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.ReferenceUnusable.selector, address(stockA)));
        _sellA(1e8, 99e6, 100e6);

        feedA.set(int256(100 * USD), block.timestamp);
        feedA.setAnsweredInRound(0);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.ReferenceUnusable.selector, address(stockA)));
        _sellA(1e8, 99e6, 100e6);

        feedA.setAnsweredInRound(1);
        feedA.setDecimals(18);
        vm.expectRevert(abi.encodeWithSelector(BoundedExecutorSimulation.ReferenceUnusable.selector, address(stockA)));
        _sellA(1e8, 99e6, 100e6);
    }

    function test_NotionalCapPerPeriod() public {
        // 500 USD per day: five sales of 100 USD fit, a sixth does not.
        for (uint256 i = 0; i < 5; ++i) {
            _sellA(1e8, 99e6, 100e6);
        }
        vm.expectRevert(
            abi.encodeWithSelector(BoundedExecutorSimulation.NotionalCapExceeded.selector, 600 * USD, 500 * USD)
        );
        _sellA(1e8, 99e6, 100e6);

        // The next period starts afresh.
        vm.warp(block.timestamp + DAY);
        feedA.set(int256(100 * USD), block.timestamp);
        _sellA(1e8, 99e6, 100e6);
        (, uint128 used) = executor.usageOf(bob);
        assertEq(used, 100 * USD);
    }

    function test_RevertWhen_TheMandateIsInvalid() public {
        BoundedExecutorSimulation.Mandate memory mandate = _mandate();
        mandate.maxDeviationBps = 501;
        vm.expectRevert(BoundedExecutorSimulation.InvalidMandate.selector);
        vm.prank(bob);
        executor.setMandate(mandate);

        mandate = _mandate();
        mandate.keeper = address(0);
        vm.expectRevert(BoundedExecutorSimulation.InvalidMandate.selector);
        vm.prank(bob);
        executor.setMandate(mandate);

        mandate = _mandate();
        mandate.expiresAt = uint64(block.timestamp);
        vm.expectRevert(BoundedExecutorSimulation.InvalidMandate.selector);
        vm.prank(bob);
        executor.setMandate(mandate);

        mandate = _mandate();
        mandate.version = 2;
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, indexId, uint32(2)));
        vm.prank(bob);
        executor.setMandate(mandate);
    }

    function test_RevertWhen_TheMandatePinsARuleBasedVersion() public {
        vm.prank(alice);
        bytes32 ruleBased = registry.createIndex(keccak256("rules"), _spec(200), _noTokens(), _noWeights());
        BoundedExecutorSimulation.Mandate memory mandate = _mandate();
        mandate.indexId = ruleBased;
        vm.expectRevert(BoundedExecutorSimulation.InvalidMandate.selector);
        vm.prank(bob);
        executor.setMandate(mandate);
    }

    function testFuzz_NeverPaysLessThanTheBandAndHoldsNothing(uint256 amountSeed, uint256 paidSeed) public {
        uint256 amountIn = bound(amountSeed, 1e6, 4e8); // 0.01 to 4 stock A, under the cap
        uint256 referenceOut = amountIn * 100 * USD / 1e8 / 100;
        uint256 floor = (referenceOut * 9900 + 9999) / 10_000;
        uint256 paid = bound(paidSeed, 0, referenceOut * 2);

        vm.prank(keeper);
        try executor.execute(
            bob,
            address(stockA),
            amountIn,
            address(usdc),
            floor,
            _route(address(stockA), amountIn, address(usdc), paid, address(executor))
        ) returns (
            uint256 out
        ) {
            assertGe(out, floor);
            assertEq(out, paid);
        } catch {
            assertLt(paid, floor, "only a payment under the minimum reverts");
        }
        assertEq(usdc.balanceOf(address(executor)), 0);
        assertEq(stockA.balanceOf(address(executor)), 0);
    }
}
