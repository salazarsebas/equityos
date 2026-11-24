#!/usr/bin/env bash
# Post-deployment checks of IndexRegistry and RebalanceLog on any chain. Read-only: eth_chainId, eth_getCode and
# eth_call. No key is read, and no transaction is sent.
#
#   contracts/script/check-deployment.sh <rpc-url>
#   DEPLOY_BLOCK=<block of the receipt> contracts/script/check-deployment.sh <rpc-url>
#
# Checks: the chain is one the deployment script accepts; the runtime code at both addresses has the code hash
# committed in script/Deploy.s.sol; the registry constants (BPS, MAX_SPEC_BYTES, MAX_CONSTITUENTS); the registry
# address stored in the log. With DEPLOY_BLOCK, also that the registry has no code at the block before and has it
# at that block, which is the value to record in the deployment map (the endpoint must serve historical state).
set -euo pipefail

cd "$(dirname "$0")/.."

RPC="${1:-}"
[ -n "${RPC}" ] || {
  echo "usage: $0 <rpc-url>" >&2
  exit 2
}

fail() {
  echo "check-deployment: FAIL $1" >&2
  exit 1
}
ok() {
  echo "check-deployment: ok   $1"
}

constant() {
  sed -n "/constant $1 =/,/;/p" script/Deploy.s.sol | grep -oE '0x[0-9a-fA-F]+' | head -n 1
}
lower() {
  tr '[:upper:]' '[:lower:]'
}
REGISTRY="$(constant EXPECTED_REGISTRY)"
REBALANCE_LOG="$(constant EXPECTED_REBALANCE_LOG)"
REGISTRY_CODE_HASH="$(constant EXPECTED_REGISTRY_CODE_HASH)"
REBALANCE_LOG_CODE_HASH="$(constant EXPECTED_REBALANCE_LOG_CODE_HASH)"

CHAIN_ID="$(cast chain-id --rpc-url "${RPC}")"
case "${CHAIN_ID}" in
  8453 | 84532 | 31337) ok "chain id ${CHAIN_ID}" ;;
  *) fail "chain id ${CHAIN_ID} is not Base mainnet, Base Sepolia or a local chain" ;;
esac

check_code() {
  local code
  code="$(cast code "$2" --rpc-url "${RPC}")"
  [ "${code}" != "0x" ] || fail "$1: no code at $2"
  [ "$(cast keccak "${code}")" = "$3" ] || fail "$1: the code at $2 is not the build of this commit"
  ok "$1 $2 code hash $3"
}
check_code IndexRegistry "${REGISTRY}" "${REGISTRY_CODE_HASH}"
check_code RebalanceLog "${REBALANCE_LOG}" "${REBALANCE_LOG_CODE_HASH}"

# The decoded value alone: cast appends a scientific form to large numbers, as in "10000 [1e4]".
call() {
  cast call "$1" "$2" --rpc-url "${RPC}" | awk '{print $1}'
}
[ "$(call "${REGISTRY}" 'BPS()(uint16)')" = "10000" ] || fail "BPS"
[ "$(call "${REGISTRY}" 'MAX_SPEC_BYTES()(uint32)')" = "8192" ] || fail "MAX_SPEC_BYTES"
[ "$(call "${REGISTRY}" 'MAX_CONSTITUENTS()(uint16)')" = "64" ] || fail "MAX_CONSTITUENTS"
ok "BPS 10000, MAX_SPEC_BYTES 8192, MAX_CONSTITUENTS 64"
LOG_REGISTRY="$(call "${REBALANCE_LOG}" 'REGISTRY()(address)')"
[ "$(echo "${LOG_REGISTRY}" | lower)" = "$(echo "${REGISTRY}" | lower)" ] || fail "the log points at ${LOG_REGISTRY}"
ok "RebalanceLog.REGISTRY() is ${REGISTRY}"
ok "IndexRegistry.indexCount() is $(call "${REGISTRY}" 'indexCount()(uint256)')"

if [ -n "${DEPLOY_BLOCK:-}" ]; then
  [[ "${DEPLOY_BLOCK}" =~ ^[1-9][0-9]*$ ]] || fail "DEPLOY_BLOCK is not a positive integer"
  [ "$(cast code "${REGISTRY}" --block "$((DEPLOY_BLOCK - 1))" --rpc-url "${RPC}")" = "0x" ] ||
    fail "the registry already has code at block $((DEPLOY_BLOCK - 1))"
  [ "$(cast code "${REGISTRY}" --block "${DEPLOY_BLOCK}" --rpc-url "${RPC}")" != "0x" ] ||
    fail "the registry has no code at block ${DEPLOY_BLOCK}"
  ok "the registry was deployed in block ${DEPLOY_BLOCK}"
fi

echo "check-deployment: all checks passed on chain ${CHAIN_ID}"
