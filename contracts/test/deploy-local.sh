#!/usr/bin/env bash
# Exercises the broadcast path of script/Deploy.s.sol: real transactions sent to a local Anvil node.
# No private key is involved: Anvil signs for its unlocked development account.
#
# Checks: the first run deploys both contracts with exactly two transactions at the expected addresses, the
# deployed code is the expected one, and a second run sends nothing.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${ANVIL_PORT:-8555}"
RPC="http://127.0.0.1:${PORT}"
# First default Anvil account. Its key is public and only meaningful on a local development chain.
SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

fail() {
  echo "deploy-local: $1" >&2
  exit 1
}

anvil --port "${PORT}" --silent &
ANVIL_PID=$!
trap 'kill "${ANVIL_PID}" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if cast chain-id --rpc-url "${RPC}" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
[ "$(cast chain-id --rpc-url "${RPC}")" = "31337" ] || fail "anvil is not reachable on ${RPC}"

constant() {
  sed -n "/constant $1 =/,/;/p" script/Deploy.s.sol | grep -oE '0x[0-9a-fA-F]+' | head -n 1
}
REGISTRY="$(constant EXPECTED_REGISTRY)"
REBALANCE_LOG="$(constant EXPECTED_REBALANCE_LOG)"
REGISTRY_CODE_HASH="$(constant EXPECTED_REGISTRY_CODE_HASH)"
REBALANCE_LOG_CODE_HASH="$(constant EXPECTED_REBALANCE_LOG_CODE_HASH)"

deploy() {
  forge script script/Deploy.s.sol --rpc-url "${RPC}" --broadcast --unlocked --sender "${SENDER}"
}
nonce() {
  cast nonce "${SENDER}" --rpc-url "${RPC}"
}
code_hash() {
  cast keccak "$(cast code "$1" --rpc-url "${RPC}")"
}

[ "$(cast code "${REGISTRY}" --rpc-url "${RPC}")" = "0x" ] || fail "registry address already has code"

NONCE_START="$(nonce)"
deploy >/dev/null
NONCE_AFTER_FIRST="$(nonce)"
[ "$((NONCE_AFTER_FIRST - NONCE_START))" = "2" ] || fail "first run must send exactly two transactions"
[ "$(code_hash "${REGISTRY}")" = "${REGISTRY_CODE_HASH}" ] || fail "unexpected IndexRegistry code"
[ "$(code_hash "${REBALANCE_LOG}")" = "${REBALANCE_LOG_CODE_HASH}" ] || fail "unexpected RebalanceLog code"
[ "$(cast call "${REGISTRY}" 'indexCount()(uint256)' --rpc-url "${RPC}")" = "0" ] || fail "registry is not empty"
LOG_REGISTRY="$(cast call "${REBALANCE_LOG}" 'REGISTRY()(address)' --rpc-url "${RPC}")"
[ "${LOG_REGISTRY}" = "${REGISTRY}" ] || fail "the log points at ${LOG_REGISTRY}"

deploy >/dev/null
[ "$(nonce)" = "${NONCE_AFTER_FIRST}" ] || fail "second run must send no transaction"

echo "deploy-local: ok (IndexRegistry ${REGISTRY}, RebalanceLog ${REBALANCE_LOG})"
