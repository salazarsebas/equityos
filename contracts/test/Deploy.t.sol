// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {IndexRegistry} from "../src/IndexRegistry.sol";
import {RebalanceLog} from "../src/RebalanceLog.sol";

/// @notice Runs the deployment script against the local test chain, with the deterministic deployment proxy
///         placed at its canonical address.
contract DeployTest is Test {
    /// @dev Runtime code of the deployment proxy, as returned by `eth_getCode` on Base mainnet and Base Sepolia.
    bytes internal constant PROXY_RUNTIME_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    Deploy internal script;
    address internal proxy;

    function setUp() public {
        script = new Deploy();
        proxy = script.DEPLOYMENT_PROXY();
        vm.etch(proxy, PROXY_RUNTIME_CODE);
        // Base Sepolia. Base mainnet needs an explicit opt-in and has its own tests below.
        vm.chainId(84_532);
    }

    function test_ProxyFixtureMatchesThePinnedCodeHash() public view {
        assertEq(proxy, 0x4e59b44847b379578588920cA78FbF26c0B4956C);
        assertEq(keccak256(PROXY_RUNTIME_CODE), script.DEPLOYMENT_PROXY_CODE_HASH());
        assertEq(proxy.codehash, script.DEPLOYMENT_PROXY_CODE_HASH());
    }

    function test_Salts() public view {
        assertEq(script.REGISTRY_SALT(), keccak256("equityos.IndexRegistry.v1"));
        assertEq(script.REBALANCE_LOG_SALT(), keccak256("equityos.RebalanceLog.v1"));
    }

    /// @dev The committed constants describe the bytecode this commit builds. If this fails after an intended
    ///      change to the contracts or the compiler settings, update the constants in `script/Deploy.s.sol`
    ///      with the values printed here.
    function test_ExpectedConstantsMatchTheBuild() public {
        bytes memory registryInitCode = type(IndexRegistry).creationCode;
        address registryAddress = script.predictAddress(script.REGISTRY_SALT(), registryInitCode);
        address logAddress = script.predictAddress(
            script.REBALANCE_LOG_SALT(), abi.encodePacked(type(RebalanceLog).creationCode, abi.encode(registryAddress))
        );
        IndexRegistry localRegistry = new IndexRegistry();
        RebalanceLog localLog = new RebalanceLog(IndexRegistry(registryAddress));

        emit log_named_address("IndexRegistry address", registryAddress);
        emit log_named_bytes32("IndexRegistry runtime code hash", address(localRegistry).codehash);
        emit log_named_address("RebalanceLog address", logAddress);
        emit log_named_bytes32("RebalanceLog runtime code hash", address(localLog).codehash);

        assertEq(registryAddress, script.EXPECTED_REGISTRY(), "IndexRegistry address");
        assertEq(address(localRegistry).codehash, script.EXPECTED_REGISTRY_CODE_HASH(), "IndexRegistry code hash");
        assertEq(keccak256(type(IndexRegistry).runtimeCode), script.EXPECTED_REGISTRY_CODE_HASH());
        assertEq(logAddress, script.EXPECTED_REBALANCE_LOG(), "RebalanceLog address");
        assertEq(address(localLog).codehash, script.EXPECTED_REBALANCE_LOG_CODE_HASH(), "RebalanceLog code hash");
    }

    function test_PredictAddress_IsTheCreate2Formula() public view {
        bytes memory initCode = hex"6000";
        bytes32 salt = keccak256("salt");
        assertEq(script.predictAddress(salt, initCode), vm.computeCreate2Address(salt, keccak256(initCode), proxy));
    }

    function test_Run_DeploysAtThePredictedAddresses() public {
        assertEq(script.EXPECTED_REGISTRY().code.length, 0);
        assertEq(script.EXPECTED_REBALANCE_LOG().code.length, 0);
        uint64 nonceBefore = vm.getNonce(proxy);

        (IndexRegistry registry, RebalanceLog rebalanceLog) = script.run();

        assertEq(address(registry), script.EXPECTED_REGISTRY());
        assertEq(address(rebalanceLog), script.EXPECTED_REBALANCE_LOG());
        assertEq(address(registry).codehash, script.EXPECTED_REGISTRY_CODE_HASH());
        assertEq(address(rebalanceLog).codehash, script.EXPECTED_REBALANCE_LOG_CODE_HASH());
        assertEq(vm.getNonce(proxy), nonceBefore + 2, "two CREATE2 deployments through the proxy");

        assertEq(registry.BPS(), 10_000);
        assertEq(registry.MAX_SPEC_BYTES(), 8192);
        assertEq(registry.MAX_CONSTITUENTS(), 64);
        assertEq(registry.indexCount(), 0);
        assertEq(address(rebalanceLog.REGISTRY()), address(registry));
        assertEq(address(registry).balance, 0);
        assertEq(address(rebalanceLog).balance, 0);
    }

    function test_Run_DeployedContractsWorkTogether() public {
        (IndexRegistry registry, RebalanceLog rebalanceLog) = script.run();

        bytes32 indexId = registry.createIndex(bytes32(0), hex"7b7d", new address[](0), new uint16[](0));
        registry.publishVersion(indexId, 2, hex"7b7d", new address[](0), new uint16[](0));
        rebalanceLog.recordRebalance(indexId, 2);
        registry.deprecate(indexId);

        assertEq(registry.getIndex(indexId).latestVersion, 2);
        assertEq(registry.specOf(indexId, 2), hex"7b7d");
    }

    function test_Run_IsIdempotent() public {
        (IndexRegistry registry, RebalanceLog rebalanceLog) = script.run();
        // State created between two runs must survive and must not make the second run fail.
        bytes32 indexId = registry.createIndex(bytes32(0), hex"7b7d", new address[](0), new uint16[](0));
        uint64 nonceAfterFirstRun = vm.getNonce(proxy);

        (IndexRegistry registryAgain, RebalanceLog rebalanceLogAgain) = script.run();

        assertEq(address(registryAgain), address(registry));
        assertEq(address(rebalanceLogAgain), address(rebalanceLog));
        assertEq(vm.getNonce(proxy), nonceAfterFirstRun, "nothing is deployed twice");
        assertEq(registry.indexCount(), 1);
        assertTrue(registry.exists(indexId));
    }

    function test_Run_DeploysOnlyTheMissingContract() public {
        (bool success,) = proxy.call(abi.encodePacked(script.REGISTRY_SALT(), type(IndexRegistry).creationCode));
        assertTrue(success);
        assertGt(script.EXPECTED_REGISTRY().code.length, 0);
        uint64 nonceBefore = vm.getNonce(proxy);

        (, RebalanceLog rebalanceLog) = script.run();

        assertEq(vm.getNonce(proxy), nonceBefore + 1, "only the log is deployed");
        assertEq(address(rebalanceLog.REGISTRY()), script.EXPECTED_REGISTRY());
    }

    function test_Deploy_SameAddressesOnEverySupportedChain() public {
        uint256[3] memory chainIds = [uint256(8453), 84_532, 31_337];
        uint256 snapshot = vm.snapshotState();
        for (uint256 i = 0; i < chainIds.length; ++i) {
            vm.chainId(chainIds[i]);
            (IndexRegistry registry, RebalanceLog rebalanceLog) = script.deploy(true);
            assertEq(address(registry), script.EXPECTED_REGISTRY());
            assertEq(address(rebalanceLog), script.EXPECTED_REBALANCE_LOG());
            vm.revertToState(snapshot);
        }
    }

    function test_RevertWhen_MainnetIsNotConfirmed() public {
        vm.chainId(8453);
        uint64 nonceBefore = vm.getNonce(proxy);

        vm.expectRevert(Deploy.MainnetNotConfirmed.selector);
        script.deploy(false);

        assertEq(vm.getNonce(proxy), nonceBefore, "nothing is deployed");
        assertEq(script.EXPECTED_REGISTRY().code.length, 0);
        assertEq(script.EXPECTED_REBALANCE_LOG().code.length, 0);
    }

    function test_Deploy_MainnetWithConfirmation() public {
        vm.chainId(8453);
        (IndexRegistry registry, RebalanceLog rebalanceLog) = script.deploy(true);
        assertEq(address(registry), script.EXPECTED_REGISTRY());
        assertEq(address(rebalanceLog), script.EXPECTED_REBALANCE_LOG());
        assertGt(address(registry).code.length, 0);
    }

    /// @dev The confirmation flag is ignored outside mainnet: no flag is needed on the other chains.
    function test_Deploy_ConfirmationIsNotNeededOnOtherChains() public {
        uint256[2] memory chainIds = [uint256(84_532), 31_337];
        uint256 snapshot = vm.snapshotState();
        for (uint256 i = 0; i < chainIds.length; ++i) {
            vm.chainId(chainIds[i]);
            (IndexRegistry registry,) = script.deploy(false);
            assertGt(address(registry).code.length, 0);
            vm.revertToState(snapshot);
        }
    }

    /// @dev `run` on mainnet follows the DEPLOY_MAINNET environment variable. This is the only test that
    ///      touches the variable or calls `run` on mainnet, because the environment is shared by all tests.
    function test_Run_MainnetRequiresTheEnvironmentOptIn() public {
        assertEq(script.MAINNET_OPT_IN_ENV(), "DEPLOY_MAINNET");
        vm.chainId(8453);
        uint256 snapshot = vm.snapshotState();

        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_MAINNET", "false");
        vm.expectRevert(Deploy.MainnetNotConfirmed.selector);
        script.run();
        assertEq(script.EXPECTED_REGISTRY().code.length, 0);

        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_MAINNET", "true");
        (IndexRegistry registry,) = script.run();
        assertEq(address(registry), script.EXPECTED_REGISTRY());
        assertGt(address(registry).code.length, 0);

        vm.revertToState(snapshot);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_MAINNET", "false");
        vm.expectRevert(Deploy.MainnetNotConfirmed.selector);
        script.run();
    }

    /// @dev Anyone can send ETH to the addresses before the deployment. That must not block it.
    function test_Run_PrefundedAddressesDoNotBlockTheDeployment() public {
        vm.deal(script.EXPECTED_REGISTRY(), 1 wei);
        vm.deal(script.EXPECTED_REBALANCE_LOG(), 3 ether);

        (IndexRegistry registry, RebalanceLog rebalanceLog) = script.run();

        assertGt(address(registry).code.length, 0);
        assertEq(address(registry).balance, 1 wei);
        assertEq(address(rebalanceLog).balance, 3 ether);
    }

    function test_RevertWhen_ChainIsNotSupported() public {
        uint256[4] memory chainIds = [uint256(1), 10, 11_155_111, 8454];
        for (uint256 i = 0; i < chainIds.length; ++i) {
            vm.chainId(chainIds[i]);
            vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, chainIds[i]));
            script.run();
            // The mainnet confirmation does not unlock any other chain.
            vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, chainIds[i]));
            script.deploy(true);
        }
    }

    function test_RevertWhen_ProxyIsMissing() public {
        vm.etch(proxy, "");
        vm.expectRevert(abi.encodeWithSelector(Deploy.DeploymentProxyMismatch.selector, proxy.codehash));
        script.run();
    }

    function test_RevertWhen_ProxyCodeDiffers() public {
        bytes memory other = PROXY_RUNTIME_CODE;
        other[other.length - 1] = 0x00;
        vm.etch(proxy, other);

        vm.expectRevert(abi.encodeWithSelector(Deploy.DeploymentProxyMismatch.selector, keccak256(other)));
        script.run();
    }

    function test_RevertWhen_UnexpectedCodeAtTheRegistryAddress() public {
        vm.etch(script.EXPECTED_REGISTRY(), hex"00");
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.UnexpectedCode.selector,
                "IndexRegistry",
                script.EXPECTED_REGISTRY(),
                keccak256(hex"00"),
                script.EXPECTED_REGISTRY_CODE_HASH()
            )
        );
        script.run();
    }

    function test_RevertWhen_UnexpectedCodeAtTheLogAddress() public {
        vm.etch(script.EXPECTED_REBALANCE_LOG(), hex"00");
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.UnexpectedCode.selector,
                "RebalanceLog",
                script.EXPECTED_REBALANCE_LOG(),
                keccak256(hex"00"),
                script.EXPECTED_REBALANCE_LOG_CODE_HASH()
            )
        );
        script.run();
    }
}
