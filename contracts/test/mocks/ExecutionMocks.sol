// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

/// @title Execution mocks for the browser tests on a local node
/// @notice Stand-ins for a token, the aggregator router and its executor, installed by
///         `apps/web/e2e-chain/execution-chain.ts` with `anvil_setCode` at the Base mainnet addresses the calldata
///         verification pins, on a local Anvil node only. They are never deployed anywhere else.
/// @dev The router has the router's `swap` function with the same structs, so the calldata the app verifies is
///      the calldata these contracts execute. What it enforces is what the app relies on: it pulls exactly
///      `desc.amount` of `srcToken` from the caller to the single source receiver, calls `callTarget` with
///      `targetData`, and reverts unless `dstReceiver` received at least `minReturnAmount`. The executor pays out
///      the token and amount written at words 0 and 1 of its data to the recipient at word 8, before the deadline
///      at word 16. None of the routing of the real executor is reproduced.

/// @notice A minimal ERC-20 with an open mint, initialized once after its code is installed.
contract MockToken {
    string public symbol;
    uint8 public decimals;
    bool private initialized;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error AlreadyInitialized();
    error InsufficientBalance();
    error InsufficientAllowance();

    function initialize(string calldata symbol_, uint8 decimals_) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice The structs of the router's `swap`, field for field.
struct SwapDescriptionV2 {
    address srcToken;
    address dstToken;
    address[] srcReceivers;
    uint256[] srcAmounts;
    address[] feeReceivers;
    uint256[] feeAmounts;
    address dstReceiver;
    uint256 amount;
    uint256 minReturnAmount;
    uint256 flags;
    bytes permit;
}

struct SwapExecutionParams {
    address callTarget;
    address approveTarget;
    bytes targetData;
    SwapDescriptionV2 desc;
    bytes clientData;
}

/// @notice Stands in for the aggregator router: pulls the exact amount, runs the executor, enforces the minimum.
contract MockRouter {
    error NativeValue();
    error UnsupportedRoute();
    error ExecutorFailed();
    error ReturnAmountIsNotEnough(uint256 returned, uint256 minimum);

    function swap(SwapExecutionParams calldata execution) external payable returns (uint256 returnAmount, uint256) {
        if (msg.value != 0) revert NativeValue();
        SwapDescriptionV2 calldata desc = execution.desc;
        if (desc.srcReceivers.length != 1 || desc.srcAmounts.length != 1 || desc.srcAmounts[0] != desc.amount) {
            revert UnsupportedRoute();
        }
        MockToken(desc.srcToken).transferFrom(msg.sender, desc.srcReceivers[0], desc.amount);
        uint256 before = MockToken(desc.dstToken).balanceOf(desc.dstReceiver);
        (bool ok,) = execution.callTarget.call(execution.targetData);
        if (!ok) revert ExecutorFailed();
        returnAmount = MockToken(desc.dstToken).balanceOf(desc.dstReceiver) - before;
        if (returnAmount < desc.minReturnAmount) revert ReturnAmountIsNotEnough(returnAmount, desc.minReturnAmount);
        return (returnAmount, 0);
    }
}

/// @notice Stands in for the executor: pays the amount its data names, to the recipient its data names.
contract MockExecutor {
    /// @dev Length of the header before the 32-byte words: a 4-byte selector and 16 bytes.
    uint256 private constant HEADER = 20;

    error Expired();
    error ShortData();

    fallback() external {
        if (msg.data.length < HEADER + 17 * 32) revert ShortData();
        address tokenOut = address(uint160(_word(0)));
        uint256 payout = _word(1);
        address recipient = address(uint160(_word(8)));
        if (block.timestamp > _word(16)) revert Expired();
        MockToken(tokenOut).transfer(recipient, payout);
    }

    function _word(uint256 index) private pure returns (uint256) {
        uint256 start = HEADER + index * 32;
        return uint256(bytes32(msg.data[start:start + 32]));
    }
}
