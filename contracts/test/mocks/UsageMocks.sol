// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

/// @title Local usage mocks
/// @notice Stand-ins that the local seed installs on an Anvil node with `anvil_setCode`, so that the usage
///         metrics can be exercised end to end. They exist on no public network. None has a constructor: code
///         installed with `anvil_setCode` starts with empty storage, and every value is set by a call.

/// @notice A token with only what the usage metrics read: `Transfer` logs, `balanceOf` and `decimals`. Anyone
///         can mint.
contract MockStockToken {
    event Transfer(address indexed from, address indexed to, uint256 value);

    mapping(address account => uint256 balance) public balanceOf;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// @notice A reference feed with the AggregatorV3 read surface. Every round is dated at the block it is read
///         in, so a read at any block returns a current price for that block.
contract MockReferenceFeed {
    string public description;
    int256 public answer;

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function configure(string calldata newDescription, int256 newAnswer) external {
        description = newDescription;
        answer = newAnswer;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 roundAnswer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}

/// @notice An account contract that runs several calls in one transaction, as a smart account does. It has no
///         access control: it is test data on a local chain.
contract MockSmartAccount {
    error LengthMismatch();
    error CallFailed(uint256 index, bytes reason);

    function execute(address[] calldata targets, bytes[] calldata data) external {
        if (targets.length != data.length) revert LengthMismatch();
        for (uint256 i = 0; i < targets.length; ++i) {
            (bool success, bytes memory reason) = targets[i].call(data[i]);
            if (!success) revert CallFailed(i, reason);
        }
    }
}
