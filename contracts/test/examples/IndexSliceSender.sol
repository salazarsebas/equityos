// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "../../src/interfaces/IIndexRegistry.sol";

/// @notice The ERC-20 read the example makes.
interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title IndexSliceSender
/// @notice Example of a third-party contract that acts on the constituents of an index. It sends a slice of the
///         caller's replication: the same share of every constituent the caller holds goes to a recipient, so the
///         recipient receives the caller's own proportions. It is a test fixture that shows the pattern, not a
///         deployed or supported contract.
/// @dev It imports only the registry interface and reads one pinned version: `getIndex` for deprecation,
///      `getVersion` for the composition and `constituentsOf` for the tokens. It needs no price, because it keeps
///      the caller's proportions instead of moving toward the target weights, and it ignores the stored weights,
///      so a DynamicWeights version works as well as a Static one.
///
///      Non-custodial and stateless: every token moves from the caller to the recipient with `transferFrom`,
///      never through this contract, which holds nothing and stores nothing. The caller approves this contract
///      for each constituent first. A constituent is any contract the creator of the index chose, and this
///      contract calls it: point it only at an index whose creator you trust.
contract IndexSliceSender {
    /// @notice Basis points in a whole: a share of 10_000 sends everything.
    uint16 public constant BPS = 10_000;

    IIndexRegistry public immutable REGISTRY;

    /// @notice Emitted once per slice, after every transfer.
    event SliceSent(bytes32 indexed indexId, uint32 indexed version, address indexed from, address to, uint16 shareBps);

    /// @notice The version is RuleBased: its universe is a rule in the spec and no constituent is stored.
    error NoConstituents(bytes32 indexId, uint32 version);
    /// @notice The creator deprecated the index.
    error Deprecated(bytes32 indexId);
    /// @notice `shareBps` is 0 or above {BPS}.
    error InvalidShare(uint16 shareBps);
    /// @notice The recipient is the zero address or the caller.
    error InvalidRecipient(address to);
    /// @notice A transfer reverted or returned false.
    error TransferFailed(address token);

    constructor(IIndexRegistry registry) {
        REGISTRY = registry;
    }

    /// @notice What {sendSlice} would move for `holder`: per constituent, `balance * shareBps / 10_000`.
    /// @dev Rounds down, so a slice never takes more than the share asked for. A constituent the holder does not
    ///      hold, or holds too little of, gets 0 and is not transferred. Reverts with the registry's
    ///      `VersionNotFound` or `IndexNotFound` for an unknown version.
    /// @return tokens The constituents of the version, in ascending order.
    /// @return amounts The base units of each token in the slice.
    function sliceOf(
        bytes32 indexId,
        uint32 version,
        address holder,
        uint16 shareBps
    )
        public
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        if (shareBps == 0 || shareBps > BPS) revert InvalidShare(shareBps);
        if (REGISTRY.getIndex(indexId).deprecatedAt != 0) revert Deprecated(indexId);
        if (REGISTRY.getVersion(indexId, version).composition == IIndexRegistry.Composition.RuleBased) {
            revert NoConstituents(indexId, version);
        }

        IIndexRegistry.Constituent[] memory constituents = REGISTRY.constituentsOf(indexId, version);
        tokens = new address[](constituents.length);
        amounts = new uint256[](constituents.length);
        for (uint256 i = 0; i < constituents.length; ++i) {
            address token = constituents[i].token;
            tokens[i] = token;
            amounts[i] = IERC20Balance(token).balanceOf(holder) * shareBps / BPS;
        }
    }

    /// @notice Send `shareBps` of every constituent the caller holds to `to`.
    /// @dev Needs an allowance from the caller for each constituent with a non-zero amount. All or nothing: one
    ///      failed transfer reverts the whole slice.
    /// @return tokens The constituents of the version, in ascending order.
    /// @return amounts The base units of each token sent.
    function sendSlice(
        bytes32 indexId,
        uint32 version,
        address to,
        uint16 shareBps
    )
        external
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        if (to == address(0) || to == msg.sender) revert InvalidRecipient(to);
        (tokens, amounts) = sliceOf(indexId, version, msg.sender, shareBps);
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (amounts[i] != 0) _transferFrom(tokens[i], msg.sender, to, amounts[i]);
        }
        emit SliceSent(indexId, version, msg.sender, to, shareBps);
    }

    /// @dev Accepts a token that returns true and one that returns nothing, as many ERC-20 tokens do, and rejects a
    ///      revert or a false return. An address without code never gets here: reading its balance in {sliceOf}
    ///      returns no data, which does not decode as a balance, so the slice reverts first.
    function _transferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount));
        if (!success || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert TransferFailed(token);
        }
    }
}
