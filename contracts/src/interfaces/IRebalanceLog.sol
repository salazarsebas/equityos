// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "./IIndexRegistry.sol";

/// @title IRebalanceLog
/// @notice Lets an account declare, onchain and at its own cost, that the current transaction replicates or
///         rebalances towards a specific index version. Holds no funds, has no storage and no admin.
/// @dev The event is a claim by `msg.sender` and nothing more. It carries no amounts on purpose: consumers MUST
///      derive amounts from the token `Transfer` logs of the same transaction and MUST NOT count events that
///      have no matching token flows for the same account.
interface IRebalanceLog {
    /// @notice An account declared a rebalance towards an index version.
    /// @param account `msg.sender` of {recordRebalance}. For a smart account this is the account that holds the
    ///        tokens. It is never taken from calldata.
    /// @param indexId Id of the index in {REGISTRY}.
    /// @param version Version of the index the account declares it follows.
    event RebalanceRecorded(address indexed account, bytes32 indexed indexId, uint32 indexed version);

    /// @notice The version does not exist in {REGISTRY}.
    error UnknownIndexVersion(bytes32 indexId, uint32 version);

    /// @notice The registry this log validates against. Set at construction, immutable.
    function REGISTRY() external view returns (IIndexRegistry);

    /// @notice Emit {RebalanceRecorded} for the caller. Reverts with {UnknownIndexVersion} if the version does
    ///         not exist.
    /// @dev Not payable. Makes one external static call, to `REGISTRY.versionExists`. Versions of deprecated
    ///      indexes are accepted: deprecation does not unpublish a version.
    /// @param indexId Id of an existing index.
    /// @param version Existing version of that index.
    function recordRebalance(bytes32 indexId, uint32 version) external;
}
