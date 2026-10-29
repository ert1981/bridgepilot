#!/usr/bin/env bash
# Mutation check: deliberately breaks one safety control at a time and verifies that the test suite
# FAILS. A mutation that "survives" means the tests do not protect that control.
# Run from the project root after `npm ci` and with Foundry installed:  bash scripts/mutation-check.sh
# Every source file is restored after each mutation (also on Ctrl-C).
set -u
cd "$(dirname "$0")/.."
FORGE=${FORGE_PATH:-$( [ -x /opt/foundry/forge ] && echo /opt/foundry/forge || echo forge )}
export FOUNDRY_OFFLINE=true
[ -x /opt/foundry/solc-0.8.28 ] && export FOUNDRY_SOLC=/opt/foundry/solc-0.8.28
LOG=$(mktemp); CAUGHT=0; SURVIVED=0; RESULTS=()
restore() { for f in $(find . -name '*.mutorig' -not -path './node_modules/*'); do mv "$f" "${f%.mutorig}"; done; }
trap 'restore; exit 130' INT TERM
(cd contracts/evm && "$FORGE" build >/dev/null) || { echo "forge build failed"; exit 1; }

mutate() { # name file old new -- test command...
  local name=$1 file=$2 old=$3 new=$4; shift 5
  cp "$file" "$file.mutorig"
  if ! python3 -c "import sys;p,o,n=sys.argv[1:4];s=open(p).read();assert o in s;open(p,'w').write(s.replace(o,n,1))" "$file" "$old" "$new"; then
    mv "$file.mutorig" "$file"; echo "  ? $name: pattern not found (source changed?)"; SURVIVED=$((SURVIVED+1)); RESULTS+=("PATTERN-MISSING $name"); return
  fi
  if "$@" >"$LOG" 2>&1; then echo "  ✘ SURVIVED  $name"; SURVIVED=$((SURVIVED+1)); RESULTS+=("SURVIVED $name")
  else echo "  ✔ caught    $name"; CAUGHT=$((CAUGHT+1)); RESULTS+=("caught $name"); fi
  mv "$file.mutorig" "$file"
}
FT=(bash -c "cd contracts/evm && $FORGE test")
RT=(bash -c "cd contracts/evm && $FORGE test --match-contract VerifierRouterTest")
VT=(npx vitest run tests/protocol-e2e.test.ts tests/protocol-unit.test.ts)
C=contracts/evm/src

echo "Contracts"
mutate "router: allow downgrade" $C/VerifierRouter.sol $'if (level < required) revert Downgrade(level, required);\n        uint64 eta' 'uint64 eta' -- "${RT[@]}"
mutate "router: skip upgrade delay" $C/VerifierRouter.sol 'if (block.timestamp < p.eta) revert UpgradeNotReady(p.eta);' '' -- "${RT[@]}"
mutate "router: no level ratchet" $C/VerifierRouter.sol 'r.minLevel = level; // ratchet' '// r.minLevel = level; // ratchet' -- "${RT[@]}"
mutate "composite: OR instead of AND" $C/CompositeVerifier.sol '_parts[i].verify(m, abi.decode(proof[i], (bytes[])));' 'if (i == 0) _parts[i].verify(m, abi.decode(proof[i], (bytes[])));' -- "${RT[@]}"
mutate "verifier: accept unknown signer" $C/MessageVerifier.sol 'if (!isSigner[s]) revert UnknownSigner(s);' '' -- "${FT[@]}"
mutate "replay protection removed" $C/ReplayProtection.sol 'if (processed[messageId]) revert MessageAlreadyProcessed(messageId);' '' -- "${FT[@]}"
mutate "vault: refund without initiated lock" $C/BridgeVault.sol 'if (!initiated[originalId]) revert InvalidMessage("unknown or already refunded");' '' -- "${FT[@]}"

echo "Relayer / attester / gate"
mutate "relayer: reject on missing receipt without proof" protocol/relayer.ts "if (proof.proven) return rec.move('REJECTED', this.now(), \`proven not locked (reorg)" "if (true) return rec.move('REJECTED', this.now(), \`proven not locked (reorg)" -- "${VT[@]}"
mutate "relayer: ignore provider independence" protocol/relayer.ts 'if (ind.independent < need) {' 'if (false) {' -- "${VT[@]}"
mutate "relayer: treat refunded as never locked" protocol/relayer.ts "if (await read('processed', refundId)) return" "if (false && await read('processed', refundId)) return" -- "${VT[@]}"
mutate "relayer: no lease check before send" protocol/relayer.ts 'this.assertLeaseHeld(rec.id); // a slow step' '// this.assertLeaseHeld(rec.id); // a slow step' -- "${VT[@]}"
mutate "relayer: memory store allowed in prod" protocol/relayer.ts 'if (!opts.devMode && (!opts.store' 'if (false && (!opts.store' -- "${VT[@]}"
mutate "relayer: closed gate does not hold forward" protocol/relayer.ts 'if (!this.forwardAllowed) {' 'if (false) {' -- "${VT[@]}"
mutate "attester: count connections not operators" protocol/attester.ts 'if (ind.independent < quorum) {' 'if (agreeing.length < quorum) {' -- "${VT[@]}"
mutate "providers: no shared-IP merging" protocol/rpc-providers.ts 'if ([...ips.get(ops[j]!)!].some((x) => a.has(x))) parent.set' 'if (false) parent.set' -- "${VT[@]}"
mutate "gate: running attesters != on-chain set accepted" protocol/attester-config.ts 'ok: sameSet(running, set.signers),' 'ok: true,' -- "${VT[@]}"
mutate "gate: deployBlock not verified" protocol/verify-deployment.ts "prior !== undefined && (!prior.code || prior.code === '0x')" 'true' -- "${VT[@]}"
mutate "gate: un-audited pending upgrade accepted" protocol/verify-deployment.ts 'allowed.includes(pending![2].toLowerCase())' 'true' -- "${VT[@]}"
mutate "gate: extra (hidden) admin accepted" protocol/verify-deployment.ts 'JSON.stringify(got) === JSON.stringify(want)' 'want.every((w) => got.includes(w))' -- "${VT[@]}"

restore; rm -f "$LOG"
{ echo "generated_at: $(date -u +%FT%TZ)"; echo "caught: $CAUGHT  survived: $SURVIVED"; printf '%s\n' "${RESULTS[@]}"; } > mutation-report.txt
echo; echo "caught $CAUGHT / $((CAUGHT+SURVIVED))  (mutation-report.txt)"
[ "$SURVIVED" -eq 0 ]
