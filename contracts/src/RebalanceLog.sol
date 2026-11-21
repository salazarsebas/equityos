// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "./interfaces/IIndexRegistry.sol";
import {IRebalanceLog} from "./interfaces/IRebalanceLog.sol";

/// @title RebalanceLog
/// @notice Stateless event emitter for rebalance declarations. See {IRebalanceLog}.
/// @dev No storage, no owner, no funds. There is no payable function, no `receive` and no `fallback`, so any
///      call that carries value or matches no function reverts. The only external call is a static call to the
///      registry, whose address is fixed in the bytecode.
contract RebalanceLog is IRebalanceLog {
    /// @inheritdoc IRebalanceLog
    IIndexRegistry public immutable REGISTRY;

    /// @param registry The IndexRegistry to validate against. It is not checked here: while the address has no
    ///        code every {recordRebalance} call reverts, so a log deployed before its registry is inert, not
    ///        unsafe.
    constructor(IIndexRegistry registry) {
        REGISTRY = registry;
    }

    /// @inheritdoc IRebalanceLog
    function recordRebalance(bytes32 indexId, uint32 version) external {
        if (!REGISTRY.versionExists(indexId, version)) revert UnknownIndexVersion(indexId, version);
        emit RebalanceRecorded(msg.sender, indexId, version);
    }
}
