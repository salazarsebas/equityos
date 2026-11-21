// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "../../src/interfaces/IIndexRegistry.sol";

/// @title IndexConsumer
/// @notice Example of a third-party contract that reads an index from the registry. It is a test fixture that
///         shows the read pattern, not a deployed or supported contract.
/// @dev It imports only the interface. It trusts the creator of the index it is pointed at: the registry
///      guarantees the shape of the mirror (ordering, weights), not that the tokens are what a user expects.
contract IndexConsumer {
    IIndexRegistry public immutable REGISTRY;

    /// @notice The version has no static weights to allocate with.
    error NotStatic(bytes32 indexId, uint32 version);

    constructor(IIndexRegistry registry) {
        REGISTRY = registry;
    }

    /// @notice Split `total` across the constituents of a static version by target weight.
    /// @dev Each amount is `total * weightBps / 10_000` rounded down, in the same unit as `total`. What the
    ///      rounding leaves over is returned as `unallocated`, so `sum(amounts) + unallocated == total`.
    function targetAllocation(
        bytes32 indexId,
        uint32 version,
        uint256 total
    )
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts, uint256 unallocated)
    {
        // Check the composition before using the weights: they are zero for a DynamicWeights version.
        if (REGISTRY.getVersion(indexId, version).composition != IIndexRegistry.Composition.Static) {
            revert NotStatic(indexId, version);
        }

        IIndexRegistry.Constituent[] memory constituents = REGISTRY.constituentsOf(indexId, version);
        uint256 bps = REGISTRY.BPS();
        tokens = new address[](constituents.length);
        amounts = new uint256[](constituents.length);
        unallocated = total;
        for (uint256 i = 0; i < constituents.length; ++i) {
            tokens[i] = constituents[i].token;
            amounts[i] = total * constituents[i].weightBps / bps;
            unallocated -= amounts[i];
        }
    }

    /// @notice Whether `token` is a constituent of the version. Valid for every composition.
    /// @dev A RuleBased version stores no constituents, so this is always false for it: membership of a
    ///      rule-based universe cannot be decided from the mirror.
    function isConstituent(bytes32 indexId, uint32 version, address token) external view returns (bool) {
        IIndexRegistry.Constituent[] memory constituents = REGISTRY.constituentsOf(indexId, version);
        (bool found,) = _find(constituents, token);
        return found;
    }

    /// @notice Stored weight of `token` in a static version, in basis points. 0 means "not a constituent".
    /// @dev Reverts with {NotStatic} for any other composition. A DynamicWeights version stores 0 for every
    ///      token, which means "not known onchain", not "zero weight": returning it would be wrong.
    function staticWeightOf(bytes32 indexId, uint32 version, address token) external view returns (uint16) {
        if (REGISTRY.getVersion(indexId, version).composition != IIndexRegistry.Composition.Static) {
            revert NotStatic(indexId, version);
        }
        IIndexRegistry.Constituent[] memory constituents = REGISTRY.constituentsOf(indexId, version);
        (bool found, uint256 position) = _find(constituents, token);
        return found ? constituents[position].weightBps : 0;
    }

    /// @dev Binary search, valid because the registry stores tokens in strictly ascending order.
    function _find(
        IIndexRegistry.Constituent[] memory constituents,
        address token
    )
        private
        pure
        returns (bool found, uint256 position)
    {
        uint256 low = 0;
        uint256 high = constituents.length;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            address candidate = constituents[middle].token;
            if (candidate == token) return (true, middle);
            if (candidate < token) low = middle + 1;
            else high = middle;
        }
        return (false, 0);
    }
}
