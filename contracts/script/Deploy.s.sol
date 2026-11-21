// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {Script, console2} from "forge-std/Script.sol";

import {IndexRegistry} from "../src/IndexRegistry.sol";
import {RebalanceLog} from "../src/RebalanceLog.sol";

/// @title Deploy
/// @notice Deterministic deployment of IndexRegistry and RebalanceLog through the canonical deterministic
///         deployment proxy, so both contracts get the same addresses on Base mainnet and Base Sepolia.
/// @dev Idempotent: a contract that is already at its address with the expected code is skipped. Neither
///      contract has an owner or an initializer, so it does not matter who sends the deployment transactions.
///      The script holds no key: the sender comes from the forge command line.
contract Deploy is Script {
    /// @notice Deterministic deployment proxy (https://github.com/Arachnid/deterministic-deployment-proxy).
    address public constant DEPLOYMENT_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// @notice keccak256 of the proxy runtime code, identical on Base mainnet and Base Sepolia.
    bytes32 public constant DEPLOYMENT_PROXY_CODE_HASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    uint256 public constant BASE_MAINNET_CHAIN_ID = 8453;
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    /// @notice Default chain id of a local development node. Never a live network.
    uint256 public constant LOCAL_CHAIN_ID = 31_337;

    bytes32 public constant REGISTRY_SALT = keccak256("equityos.IndexRegistry.v1");
    bytes32 public constant REBALANCE_LOG_SALT = keccak256("equityos.RebalanceLog.v1");

    /// @notice Addresses and runtime code hashes of the build in this commit. They depend on the exact
    ///         bytecode, metadata included: any change to the contract sources or to the compiler settings
    ///         changes them, and `test/Deploy.t.sol` fails until they are updated on purpose.
    address public constant EXPECTED_REGISTRY = 0x51f3b528E5fE8250BD6DbC7E8A4EC25522120007;
    bytes32 public constant EXPECTED_REGISTRY_CODE_HASH =
        0x634f3dc149426b45f4e654c68cad648217bbfdbad42cdc4ca18589cffd523d8e;
    address public constant EXPECTED_REBALANCE_LOG = 0xa246EE3E17bE401076742a85CB6eBB6A9625da14;
    bytes32 public constant EXPECTED_REBALANCE_LOG_CODE_HASH =
        0x542226eb702a128c8e2cb3275792e4a34df2fc7fd9fd59cb16db101ff414df32;

    error UnsupportedChain(uint256 chainId);
    error DeploymentProxyMismatch(bytes32 codeHash);
    error PredictedAddressMismatch(string name, address predicted, address expected);
    error UnexpectedCode(string name, address target, bytes32 codeHash, bytes32 expected);
    error DeploymentFailed(string name);
    error PostDeployCheckFailed(string check);

    /// @notice Deploy whatever is missing, then verify both contracts.
    /// @return registry The IndexRegistry at its deterministic address.
    /// @return rebalanceLog The RebalanceLog at its deterministic address.
    function run() external returns (IndexRegistry registry, RebalanceLog rebalanceLog) {
        uint256 chainId = block.chainid;
        if (chainId != BASE_MAINNET_CHAIN_ID && chainId != BASE_SEPOLIA_CHAIN_ID && chainId != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(chainId);
        }
        if (DEPLOYMENT_PROXY.codehash != DEPLOYMENT_PROXY_CODE_HASH) {
            revert DeploymentProxyMismatch(DEPLOYMENT_PROXY.codehash);
        }

        bytes memory registryInitCode = type(IndexRegistry).creationCode;
        address predictedRegistry = predictAddress(REGISTRY_SALT, registryInitCode);
        if (predictedRegistry != EXPECTED_REGISTRY) {
            revert PredictedAddressMismatch("IndexRegistry", predictedRegistry, EXPECTED_REGISTRY);
        }

        bytes memory logInitCode = abi.encodePacked(type(RebalanceLog).creationCode, abi.encode(predictedRegistry));
        address predictedLog = predictAddress(REBALANCE_LOG_SALT, logInitCode);
        if (predictedLog != EXPECTED_REBALANCE_LOG) {
            revert PredictedAddressMismatch("RebalanceLog", predictedLog, EXPECTED_REBALANCE_LOG);
        }

        // ETH can be sent to an address before any code exists there, so a balance is reported, not rejected:
        // rejecting it would let anyone block the deployment with 1 wei. Nothing in the contracts reads it.
        uint256 registryBalanceBefore = predictedRegistry.balance;
        uint256 logBalanceBefore = predictedLog.balance;

        vm.startBroadcast();
        bool registryDeployed = _deployIfMissing("IndexRegistry", REGISTRY_SALT, registryInitCode, predictedRegistry);
        bool logDeployed = _deployIfMissing("RebalanceLog", REBALANCE_LOG_SALT, logInitCode, predictedLog);
        vm.stopBroadcast();

        registry = IndexRegistry(predictedRegistry);
        rebalanceLog = RebalanceLog(predictedLog);

        _requireCode("IndexRegistry", predictedRegistry, EXPECTED_REGISTRY_CODE_HASH);
        _requireCode("RebalanceLog", predictedLog, EXPECTED_REBALANCE_LOG_CODE_HASH);
        if (registry.BPS() != 10_000) revert PostDeployCheckFailed("BPS");
        if (registry.MAX_SPEC_BYTES() != 8192) revert PostDeployCheckFailed("MAX_SPEC_BYTES");
        if (registry.MAX_CONSTITUENTS() != 128) revert PostDeployCheckFailed("MAX_CONSTITUENTS");
        if (registryDeployed && registry.indexCount() != 0) revert PostDeployCheckFailed("indexCount");
        if (address(rebalanceLog.REGISTRY()) != predictedRegistry) revert PostDeployCheckFailed("REGISTRY");
        if (predictedRegistry.balance != registryBalanceBefore) revert PostDeployCheckFailed("registry balance");
        if (predictedLog.balance != logBalanceBefore) revert PostDeployCheckFailed("log balance");

        console2.log("chain id:", chainId);
        console2.log("block number at simulation:", block.number);
        console2.log("git commit:", vm.envOr("GIT_COMMIT", string("not provided (set GIT_COMMIT)")));
        console2.log("IndexRegistry:", predictedRegistry);
        console2.log(registryDeployed ? "  deployed by this run" : "  already deployed, skipped");
        console2.log("  balance (wei):", predictedRegistry.balance);
        console2.log("RebalanceLog:", predictedLog);
        console2.log(logDeployed ? "  deployed by this run" : "  already deployed, skipped");
        console2.log("  balance (wei):", predictedLog.balance);
    }

    /// @notice CREATE2 address of `initCode` deployed through the deployment proxy with `salt`.
    function predictAddress(bytes32 salt, bytes memory initCode) public pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), DEPLOYMENT_PROXY, salt, keccak256(initCode)))))
        );
    }

    /// @dev Returns true if this call deployed the contract, false if it was already there. Existing code is
    ///      left alone here and compared with the expected code hash by the caller.
    function _deployIfMissing(
        string memory name,
        bytes32 salt,
        bytes memory initCode,
        address predicted
    )
        private
        returns (bool deployed)
    {
        if (predicted.code.length != 0) return false;

        // The proxy takes `salt ++ initCode`, sends no value on, and returns the 20-byte address.
        (bool success, bytes memory returned) = DEPLOYMENT_PROXY.call(abi.encodePacked(salt, initCode));
        // forge-lint: disable-next-line(unsafe-typecast)
        if (!success || returned.length != 20 || address(bytes20(returned)) != predicted) {
            revert DeploymentFailed(name);
        }
        return true;
    }

    function _requireCode(string memory name, address target, bytes32 expected) private view {
        bytes32 codeHash = target.codehash;
        if (target.code.length == 0 || codeHash != expected) revert UnexpectedCode(name, target, codeHash, expected);
    }
}
