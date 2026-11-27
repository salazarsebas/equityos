// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {IndexSliceSender} from "./examples/IndexSliceSender.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// @notice An ERC-20 with an open mint whose `transferFrom` returns true, false, or nothing.
contract SliceToken {
    enum Mode {
        ReturnsTrue,
        ReturnsFalse,
        ReturnsNothing
    }

    Mode public mode;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error InsufficientAllowance();
    error InsufficientBalance();

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        if (mode == Mode.ReturnsFalse) _return(false);
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (mode == Mode.ReturnsTrue) _return(true);
    }

    /// @dev Ends the call with an ABI-encoded bool, so one function can return a value or nothing.
    function _return(bool value) private pure {
        bytes memory data = abi.encode(value);
        assembly ("memory-safe") {
            return(add(data, 32), mload(data))
        }
    }
}

/// @notice Composability: a contract that knows only the interface reads an index and moves its constituents.
contract IndexSliceSenderTest is RegistryTestBase {
    uint16 internal constant HALF = 5000;

    IndexSliceSender internal sender;
    SliceToken[] internal tokens;

    event SliceSent(bytes32 indexed indexId, uint32 indexed version, address indexed from, address to, uint16 shareBps);

    function setUp() public override {
        super.setUp();
        sender = new IndexSliceSender(registry);
    }

    /// @dev `count` tokens sorted by address, as the registry requires. Alice holds `balance` of each and has
    ///      approved the sender for all of it.
    function _deployTokens(uint256 count, uint256 balance) internal returns (address[] memory addresses) {
        delete tokens;
        for (uint256 i = 0; i < count; ++i) {
            tokens.push(new SliceToken());
        }
        for (uint256 i = 1; i < count; ++i) {
            for (uint256 j = i; j > 0 && address(tokens[j - 1]) > address(tokens[j]); --j) {
                (tokens[j - 1], tokens[j]) = (tokens[j], tokens[j - 1]);
            }
        }
        addresses = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            addresses[i] = address(tokens[i]);
            tokens[i].mint(alice, balance);
            vm.prank(alice);
            tokens[i].approve(address(sender), type(uint256).max);
        }
    }

    function _staticIndex(address[] memory addresses) internal returns (bytes32 indexId) {
        vm.prank(alice);
        indexId = registry.createIndex(SALT, _spec(200), addresses, _weights(addresses.length));
    }

    function test_SendSlice_MovesTheShareOfEveryConstituent() public {
        address[] memory addresses = _deployTokens(3, 1000);
        tokens[1].mint(alice, 600); // 1_600 of the second token
        bytes32 indexId = _staticIndex(addresses);

        vm.expectEmit(address(sender));
        emit SliceSent(indexId, 1, alice, bob, 2500);
        vm.prank(alice);
        (address[] memory sent, uint256[] memory amounts) = sender.sendSlice(indexId, 1, bob, 2500);

        assertEq(sent, addresses);
        assertEq(amounts[0], 250);
        assertEq(amounts[1], 400);
        assertEq(amounts[2], 250);
        assertEq(tokens[0].balanceOf(bob), 250);
        assertEq(tokens[1].balanceOf(bob), 400);
        assertEq(tokens[1].balanceOf(alice), 1200);
        assertEq(tokens[2].balanceOf(alice), 750);
    }

    function test_SendSlice_NeverHoldsAnything() public {
        bytes32 indexId = _staticIndex(_deployTokens(2, 1000));

        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, HALF);

        for (uint256 i = 0; i < tokens.length; ++i) {
            assertEq(tokens[i].balanceOf(address(sender)), 0);
        }
    }

    function test_SendSlice_AllOfIt() public {
        bytes32 indexId = _staticIndex(_deployTokens(2, 777));

        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, 10_000);

        assertEq(tokens[0].balanceOf(alice), 0);
        assertEq(tokens[1].balanceOf(bob), 777);
    }

    function test_SendSlice_RoundsDownAndSkipsWhatRoundsToZero() public {
        address[] memory addresses = _deployTokens(2, 0);
        tokens[0].mint(alice, 3);
        tokens[1].mint(alice, 1);
        bytes32 indexId = _staticIndex(addresses);

        // Without an allowance a transfer of the second token would revert: it is not attempted.
        vm.prank(alice);
        tokens[1].approve(address(sender), 0);
        vm.prank(alice);
        (, uint256[] memory amounts) = sender.sendSlice(indexId, 1, bob, HALF);

        assertEq(amounts[0], 1);
        assertEq(amounts[1], 0);
        assertEq(tokens[0].balanceOf(bob), 1);
        assertEq(tokens[1].balanceOf(alice), 1);
    }

    function test_SendSlice_WorksForDynamicWeights() public {
        address[] memory addresses = _deployTokens(3, 100);
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(200), addresses, _noWeights());

        vm.prank(alice);
        (, uint256[] memory amounts) = sender.sendSlice(indexId, 1, bob, 1000);

        assertEq(amounts[0], 10);
        assertEq(tokens[2].balanceOf(bob), 10);
    }

    function test_SendSlice_FollowsThePinnedVersion() public {
        address[] memory addresses = _deployTokens(3, 100);
        bytes32 indexId = _staticIndex(addresses);
        address[] memory second = new address[](1);
        second[0] = addresses[2];
        uint16[] memory whole = new uint16[](1);
        whole[0] = 10_000;
        vm.prank(alice);
        registry.publishVersion(indexId, 2, _spec(200), second, whole);

        vm.prank(alice);
        (address[] memory sent,) = sender.sendSlice(indexId, 2, bob, HALF);

        assertEq(sent.length, 1);
        assertEq(tokens[0].balanceOf(bob), 0);
        assertEq(tokens[2].balanceOf(bob), 50);
    }

    function test_SliceOf_PreviewsTheSlice() public {
        address[] memory addresses = _deployTokens(2, 1000);
        bytes32 indexId = _staticIndex(addresses);

        (address[] memory preview, uint256[] memory amounts) = sender.sliceOf(indexId, 1, alice, 100);

        assertEq(preview, addresses);
        assertEq(amounts[0], 10);
        assertEq(tokens[0].balanceOf(alice), 1000, "a preview moves nothing");
    }

    function test_SendSlice_AcceptsATokenThatReturnsNothing() public {
        address[] memory addresses = _deployTokens(2, 1000);
        tokens[0].setMode(SliceToken.Mode.ReturnsNothing);
        bytes32 indexId = _staticIndex(addresses);

        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, HALF);

        assertEq(tokens[0].balanceOf(bob), 500);
    }

    function test_RevertWhen_ATokenReturnsFalse() public {
        address[] memory addresses = _deployTokens(2, 1000);
        tokens[1].setMode(SliceToken.Mode.ReturnsFalse);
        bytes32 indexId = _staticIndex(addresses);

        vm.expectRevert(abi.encodeWithSelector(IndexSliceSender.TransferFailed.selector, addresses[1]));
        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, HALF);
    }

    function test_RevertWhen_ATransferReverts() public {
        address[] memory addresses = _deployTokens(2, 1000);
        bytes32 indexId = _staticIndex(addresses);
        vm.prank(alice);
        tokens[0].approve(address(sender), 0);

        vm.expectRevert(abi.encodeWithSelector(IndexSliceSender.TransferFailed.selector, addresses[0]));
        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, HALF);
    }

    function test_RevertWhen_AConstituentHasNoCode() public {
        address[] memory addresses = _deployTokens(1, 1000);
        address[] memory withEmpty = new address[](2);
        (withEmpty[0], withEmpty[1]) = (addresses[0], address(type(uint160).max));
        bytes32 indexId = _staticIndex(withEmpty);

        // Its balance cannot be read, so nothing is sent, not even the constituent that has code.
        vm.expectRevert();
        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, HALF);
        assertEq(tokens[0].balanceOf(bob), 0);
    }

    function test_RevertWhen_TheVersionIsRuleBased() public {
        vm.prank(alice);
        bytes32 indexId = registry.createIndex(SALT, _spec(200), _noTokens(), _noWeights());

        vm.expectRevert(abi.encodeWithSelector(IndexSliceSender.NoConstituents.selector, indexId, uint32(1)));
        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, HALF);
    }

    function test_RevertWhen_TheIndexIsDeprecated() public {
        bytes32 indexId = _staticIndex(_deployTokens(2, 1000));
        vm.prank(alice);
        registry.deprecate(indexId);

        vm.expectRevert(abi.encodeWithSelector(IndexSliceSender.Deprecated.selector, indexId));
        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, HALF);
    }

    function test_RevertWhen_TheVersionIsUnknown() public {
        bytes32 indexId = _staticIndex(_deployTokens(2, 1000));

        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.VersionNotFound.selector, indexId, uint32(2)));
        vm.prank(alice);
        sender.sendSlice(indexId, 2, bob, HALF);

        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexNotFound.selector, unknown));
        sender.sliceOf(unknown, 1, alice, HALF);
    }

    function test_RevertWhen_TheShareIsOutOfRange() public {
        bytes32 indexId = _staticIndex(_deployTokens(1, 1000));

        vm.expectRevert(abi.encodeWithSelector(IndexSliceSender.InvalidShare.selector, uint16(0)));
        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, 0);

        vm.expectRevert(abi.encodeWithSelector(IndexSliceSender.InvalidShare.selector, uint16(10_001)));
        vm.prank(alice);
        sender.sendSlice(indexId, 1, bob, 10_001);
    }

    function test_RevertWhen_TheRecipientIsZeroOrTheCaller() public {
        bytes32 indexId = _staticIndex(_deployTokens(1, 1000));

        vm.expectRevert(abi.encodeWithSelector(IndexSliceSender.InvalidRecipient.selector, address(0)));
        vm.prank(alice);
        sender.sendSlice(indexId, 1, address(0), HALF);

        vm.expectRevert(abi.encodeWithSelector(IndexSliceSender.InvalidRecipient.selector, alice));
        vm.prank(alice);
        sender.sendSlice(indexId, 1, alice, HALF);
    }

    function testFuzz_SendSlice_ConservesEveryBalance(uint256 countSeed, uint16 shareSeed, uint128 balance) public {
        uint256 count = bound(countSeed, 1, 8);
        uint16 share = uint16(bound(shareSeed, 1, 10_000));
        bytes32 indexId = _staticIndex(_deployTokens(count, balance));

        vm.prank(alice);
        (, uint256[] memory amounts) = sender.sendSlice(indexId, 1, bob, share);

        uint256 expected = uint256(balance) * share / 10_000;
        for (uint256 i = 0; i < count; ++i) {
            assertEq(amounts[i], expected);
            assertEq(tokens[i].balanceOf(bob), expected);
            assertEq(tokens[i].balanceOf(alice) + tokens[i].balanceOf(bob), balance);
        }
    }
}
