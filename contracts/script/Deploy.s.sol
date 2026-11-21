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

    /// @notice Chain id of Base mainnet. Deploying there also requires the {MAINNET_OPT_IN_ENV} opt-in.
    uint256 public constant BASE_MAINNET_CHAIN_ID = 8453;
    /// @notice Chain id of Base Sepolia.
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    /// @notice Default chain id of a local development node. Never a live network.
    uint256 public constant LOCAL_CHAIN_ID = 31_337;

    /// @notice Environment variable that must be set to `true` for {run} to proceed on Base mainnet.
    string public constant MAINNET_OPT_IN_ENV = "DEPLOY_MAINNET";

    /// @notice CREATE2 salt of IndexRegistry.
    bytes32 public constant REGISTRY_SALT = keccak256("equityos.IndexRegistry.v1");
    /// @notice CREATE2 salt of RebalanceLog.
    bytes32 public constant REBALANCE_LOG_SALT = keccak256("equityos.RebalanceLog.v1");

    /// @notice Addresses and runtime code hashes of the build in this commit. They depend on the exact
    ///         bytecode, metadata included: any change to the contract sources or to the compiler settings
    ///         changes them, and `test/Deploy.t.sol` fails until they are updated on purpose.
    address public constant EXPECTED_REGISTRY = 0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c;
    bytes32 public constant EXPECTED_REGISTRY_CODE_HASH =
        0x3173771214f293dafccb4c612bd272ddd2e923a02946109435a164ca9f2c238b;
    address public constant EXPECTED_REBALANCE_LOG = 0x593449aeF0Efc05528D3BC7bE9eb8d99e39AA41c;
    bytes32 public constant EXPECTED_REBALANCE_LOG_CODE_HASH =
        0x533ec75d5535da54ab81bcd5738f031eb828afac0d68ae4cef1d63a7b5d95405;

    /// @notice The chain is not Base mainnet, Base Sepolia or a local development chain.
    error UnsupportedChain(uint256 chainId);
    /// @notice The chain is Base mainnet and the opt-in was not given.
    error MainnetNotConfirmed();
    /// @notice The deployment proxy is missing or its runtime code is not the pinned one.
    error DeploymentProxyMismatch(bytes32 codeHash);
    /// @notice This build does not produce the address committed in the `EXPECTED_*` constants.
    error PredictedAddressMismatch(string name, address predicted, address expected);
    /// @notice `target` has no code, or code other than the expected runtime code.
    error UnexpectedCode(string name, address target, bytes32 codeHash, bytes32 expected);
    /// @notice The deployment proxy reverted or returned something other than the predicted address.
    error DeploymentFailed(string name);
    /// @notice A check on the deployed contracts failed.
    error PostDeployCheckFailed(string check);

    /// @notice Entry point of `forge script`. Deploys whatever is missing, then verifies both contracts.
    /// @dev On Base mainnet it reverts with {MainnetNotConfirmed} unless the environment variable
    ///      `DEPLOY_MAINNET` is `true`. The variable is not read on any other chain.
    /// @return registry The IndexRegistry at its deterministic address.
    /// @return rebalanceLog The RebalanceLog at its deterministic address.
    function run() external returns (IndexRegistry registry, RebalanceLog rebalanceLog) {
        bool mainnetConfirmed = block.chainid == BASE_MAINNET_CHAIN_ID && vm.envOr(MAINNET_OPT_IN_ENV, false);
        return deploy(mainnetConfirmed);
    }

    /// @notice Deploy whatever is missing, then verify both contracts.
    /// @param mainnetConfirmed Explicit opt-in for Base mainnet. Ignored on every other chain.
    /// @return registry The IndexRegistry at its deterministic address.
    /// @return rebalanceLog The RebalanceLog at its deterministic address.
    function deploy(bool mainnetConfirmed) public returns (IndexRegistry registry, RebalanceLog rebalanceLog) {
        uint256 chainId = block.chainid;
        if (chainId != BASE_MAINNET_CHAIN_ID && chainId != BASE_SEPOLIA_CHAIN_ID && chainId != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(chainId);
        }
        if (chainId == BASE_MAINNET_CHAIN_ID && !mainnetConfirmed) revert MainnetNotConfirmed();
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
        if (registry.MAX_CONSTITUENTS() != 64) revert PostDeployCheckFailed("MAX_CONSTITUENTS");
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
    /// @param salt CREATE2 salt passed to the proxy.
    /// @param initCode Creation code followed by the ABI-encoded constructor arguments.
    /// @return `keccak256(0xff ++ DEPLOYMENT_PROXY ++ salt ++ keccak256(initCode))`, last 20 bytes.
    function predictAddress(bytes32 salt, bytes memory initCode) public pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), DEPLOYMENT_PROXY, salt, keccak256(initCode)))))
        );
    }

    /// @dev Deploys `initCode` through the proxy unless `predicted` already has code. Existing code is left
    ///      alone here and compared with the expected code hash by the caller.
    /// @param name Contract name, for the error.
    /// @param salt CREATE2 salt.
    /// @param initCode Creation code followed by the ABI-encoded constructor arguments.
    /// @param predicted Address the deployment must end up at.
    /// @return deployed True if this call deployed the contract, false if it was already there.
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

    /// @dev Reverts with {UnexpectedCode} unless `target` has code whose keccak256 is `expected`.
    /// @param name Contract name, for the error.
    /// @param target Address to check.
    /// @param expected Expected runtime code hash.
    function _requireCode(string memory name, address target, bytes32 expected) private view {
        bytes32 codeHash = target.codehash;
        if (target.code.length == 0 || codeHash != expected) revert UnexpectedCode(name, target, codeHash, expected);
    }
}
