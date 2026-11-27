// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "../../src/interfaces/IIndexRegistry.sol";

/// @notice The ERC-20 surface the simulation calls.
interface ISimulationToken {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice The Chainlink AggregatorV3 read the simulation makes.
interface ISimulationFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title BoundedExecutorSimulation
/// @notice SIMULATION ONLY. Not deployed on any network, not audited, and not part of the product: it lives under
///         `contracts/test` so that no deployment script can reach it. It shows, with tests, the bounds a contract
///         that rebalances for a user without a signature per trade would have to enforce. The design and why it
///         is not shipped are in `docs/architecture/bounded-executor.md`.
/// @dev A user grants a mandate: a keeper may swap between USDC and the constituents of one pinned index version,
///      through one router fixed at construction, at no worse than a deviation band under a fresh Chainlink
///      reference, within a notional cap per period, until the mandate expires or is revoked. The user approves this
///      contract for the tokens it may sell. Each swap pulls exactly its input from the user, approves the router
///      for exactly that amount, measures what came back, and sends all of it to the user in the same transaction,
///      so the contract holds nothing between calls. What it cannot bound is listed in the design document.
contract BoundedExecutorSimulation {
    /// @notice Basis points in a whole.
    uint16 public constant BPS = 10_000;
    /// @notice Widest deviation band a mandate may allow: 5%.
    uint16 public constant MAX_DEVIATION_BPS = 500;
    /// @notice One base unit of the quote token is worth this much USD scaled by 1e8 (6 decimals).
    uint256 internal constant QUOTE_UNIT_USD_E8 = 100;

    IIndexRegistry public immutable REGISTRY;
    /// @notice The only contract the executor ever calls with router calldata.
    address public immutable ROUTER;
    /// @notice USDC: one side of every swap.
    address public immutable QUOTE;

    /// @notice What a user allows. Fixed until revoked or replaced by the user.
    struct Mandate {
        bytes32 indexId;
        uint32 version;
        address keeper;
        uint64 expiresAt;
        uint64 periodSeconds;
        uint16 maxDeviationBps;
        uint32 maxStalenessSeconds;
        uint128 maxNotionalPerPeriodUsdE8;
    }

    struct Usage {
        uint64 periodStart;
        uint128 usedUsdE8;
    }

    mapping(address user => Mandate) public mandateOf;
    mapping(address user => Usage) public usageOf;
    /// @notice The Chainlink feed of each token, fixed at construction.
    mapping(address token => address feed) public feedOf;

    bool private locked;

    event MandateSet(address indexed user, bytes32 indexed indexId, uint32 version, address keeper, uint64 expiresAt);
    event MandateRevoked(address indexed user);
    event Executed(
        address indexed user,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 notionalUsdE8
    );

    error LengthMismatch();
    error InvalidMandate();
    error NoMandate(address user);
    error NotKeeper(address caller);
    error MandateExpired(uint64 expiresAt);
    error IndexDeprecated(bytes32 indexId);
    error PairNotAllowed(address tokenIn, address tokenOut);
    error ReferenceUnusable(address token);
    error MinimumBelowBand(uint256 minAmountOut, uint256 floor);
    error NotionalCapExceeded(uint256 used, uint256 cap);
    error RouterCallFailed(bytes reason);
    error InputNotSpent(uint256 left);
    error OutputBelowMinimum(uint256 received, uint256 minimum);
    error TokenCallFailed(address token);
    error Reentrancy();

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    constructor(
        IIndexRegistry registry,
        address router,
        address quote,
        address[] memory tokens,
        address[] memory feeds
    ) {
        if (tokens.length != feeds.length) revert LengthMismatch();
        REGISTRY = registry;
        ROUTER = router;
        QUOTE = quote;
        for (uint256 i = 0; i < tokens.length; ++i) {
            feedOf[tokens[i]] = feeds[i];
        }
    }

    /// @notice Grant or replace the caller's mandate. The version must exist and store its constituents.
    function setMandate(Mandate calldata mandate) external {
        if (
            mandate.keeper == address(0) || mandate.expiresAt <= block.timestamp || mandate.periodSeconds == 0
                || mandate.maxDeviationBps > MAX_DEVIATION_BPS || mandate.maxNotionalPerPeriodUsdE8 == 0
                || mandate.maxStalenessSeconds == 0
        ) revert InvalidMandate();
        // Reverts with VersionNotFound for an unknown version.
        IIndexRegistry.VersionInfo memory info = REGISTRY.getVersion(mandate.indexId, mandate.version);
        if (info.composition == IIndexRegistry.Composition.RuleBased) revert InvalidMandate();
        mandateOf[msg.sender] = mandate;
        delete usageOf[msg.sender];
        emit MandateSet(msg.sender, mandate.indexId, mandate.version, mandate.keeper, mandate.expiresAt);
    }

    /// @notice Revoke the caller's mandate. The user should also revoke the token approvals.
    function revokeMandate() external {
        delete mandateOf[msg.sender];
        delete usageOf[msg.sender];
        emit MandateRevoked(msg.sender);
    }

    /// @notice Swap `amountIn` of `tokenIn` for at least `minAmountOut` of `tokenOut` for `user`, through the
    ///         router, with `routerCalldata`. Only the user's keeper, within every bound of the mandate.
    /// @return amountOut What the router returned, all of it sent to the user.
    function execute(
        address user,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minAmountOut,
        bytes calldata routerCalldata
    )
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        Mandate memory mandate = mandateOf[user];
        if (mandate.keeper == address(0)) revert NoMandate(user);
        if (msg.sender != mandate.keeper) revert NotKeeper(msg.sender);
        if (block.timestamp >= mandate.expiresAt) revert MandateExpired(mandate.expiresAt);
        if (REGISTRY.getIndex(mandate.indexId).deprecatedAt != 0) revert IndexDeprecated(mandate.indexId);

        bool sell = tokenOut == QUOTE;
        address constituent = sell ? tokenIn : tokenOut;
        if ((sell == (tokenIn == QUOTE)) || !_isConstituent(mandate, constituent)) {
            revert PairNotAllowed(tokenIn, tokenOut);
        }

        uint256 notionalUsdE8 = _checkPrice(mandate, constituent, sell, amountIn, minAmountOut);
        _useNotional(user, mandate, notionalUsdE8);

        amountOut = _swap(user, tokenIn, amountIn, tokenOut, minAmountOut, routerCalldata);
        emit Executed(user, tokenIn, tokenOut, amountIn, amountOut, notionalUsdE8);
    }

    /// @dev The worst outcome `minAmountOut` allows must be within the band under the reference. Returns the
    ///      reference value of the swap, the amount counted against the cap.
    function _checkPrice(
        Mandate memory mandate,
        address constituent,
        bool sell,
        uint256 amountIn,
        uint256 minAmountOut
    )
        private
        view
        returns (uint256 notionalUsdE8)
    {
        uint256 priceE8 = _reference(constituent, mandate.maxStalenessSeconds);
        uint256 unit = 10 ** ISimulationToken(constituent).decimals();
        uint256 referenceOut;
        if (sell) {
            notionalUsdE8 = amountIn * priceE8 / unit;
            referenceOut = notionalUsdE8 / QUOTE_UNIT_USD_E8;
        } else {
            notionalUsdE8 = amountIn * QUOTE_UNIT_USD_E8;
            referenceOut = notionalUsdE8 * unit / priceE8;
        }
        // Rounds up: the floor is never lower than the band allows.
        uint256 floor = (referenceOut * (BPS - mandate.maxDeviationBps) + BPS - 1) / BPS;
        if (minAmountOut < floor || minAmountOut == 0) revert MinimumBelowBand(minAmountOut, floor);
    }

    /// @dev A positive, complete, fresh round from the token's fixed feed, in USD scaled by 1e8.
    function _reference(address token, uint32 maxStalenessSeconds) private view returns (uint256) {
        address feed = feedOf[token];
        if (feed == address(0) || ISimulationFeed(feed).decimals() != 8) revert ReferenceUnusable(token);
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            ISimulationFeed(feed).latestRoundData();
        if (
            answer <= 0 || answeredInRound < roundId || updatedAt > block.timestamp
                || block.timestamp - updatedAt > maxStalenessSeconds
        ) revert ReferenceUnusable(token);
        return uint256(answer);
    }

    function _useNotional(address user, Mandate memory mandate, uint256 notionalUsdE8) private {
        Usage memory usage = usageOf[user];
        if (block.timestamp >= uint256(usage.periodStart) + mandate.periodSeconds) {
            usage = Usage({periodStart: uint64(block.timestamp), usedUsdE8: 0});
        }
        uint256 used = uint256(usage.usedUsdE8) + notionalUsdE8;
        if (used > mandate.maxNotionalPerPeriodUsdE8) {
            revert NotionalCapExceeded(used, mandate.maxNotionalPerPeriodUsdE8);
        }
        // The cap is a uint128, so `used` fits.
        // forge-lint: disable-next-line(unsafe-typecast)
        usageOf[user] = Usage({periodStart: usage.periodStart, usedUsdE8: uint128(used)});
    }

    /// @dev Pulls the input, lets the router spend exactly it, and forwards everything that came back.
    function _swap(
        address user,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minAmountOut,
        bytes calldata routerCalldata
    )
        private
        returns (uint256 received)
    {
        uint256 inBefore = ISimulationToken(tokenIn).balanceOf(address(this));
        uint256 outBefore = ISimulationToken(tokenOut).balanceOf(address(this));
        _call(tokenIn, abi.encodeCall(ISimulationToken.transferFrom, (user, address(this), amountIn)));
        _call(tokenIn, abi.encodeCall(ISimulationToken.approve, (ROUTER, amountIn)));
        (bool success, bytes memory reason) = ROUTER.call(routerCalldata);
        if (!success) revert RouterCallFailed(reason);
        _call(tokenIn, abi.encodeCall(ISimulationToken.approve, (ROUTER, 0)));
        uint256 inAfter = ISimulationToken(tokenIn).balanceOf(address(this));
        if (inAfter != inBefore) revert InputNotSpent(inAfter - inBefore);
        received = ISimulationToken(tokenOut).balanceOf(address(this)) - outBefore;
        if (received < minAmountOut) revert OutputBelowMinimum(received, minAmountOut);
        _call(tokenOut, abi.encodeCall(ISimulationToken.transfer, (user, received)));
    }

    function _isConstituent(Mandate memory mandate, address token) private view returns (bool) {
        IIndexRegistry.Constituent[] memory constituents = REGISTRY.constituentsOf(mandate.indexId, mandate.version);
        for (uint256 i = 0; i < constituents.length; ++i) {
            if (constituents[i].token == token) return true;
        }
        return false;
    }

    /// @dev A token call that reverts or returns false fails the swap; one that returns nothing is accepted.
    function _call(address token, bytes memory data) private {
        (bool success, bytes memory result) = token.call(data);
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenCallFailed(token);
    }
}
