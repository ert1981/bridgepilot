#!/usr/bin/env node
/**
 * Runs the complete verification pipeline three times with different random seeds:
 *   1. TypeScript typecheck
 *   2. Production build
 *   3. Vitest (units, engines, adapters, API, x402, security fuzz, protocol e2e on 2 anvil chains)
 *   4. Foundry (contract unit, fuzz, invariant)
 * then repeats the protocol e2e suite N times on its own (stability; `--e2e-repeats N`, default 10).
 *
 * Reporting rules (test-report.json):
 *   - at START the previous report is replaced by one with status "running", complete=false, so a
 *     crash or early exit can never leave an older successful report behind;
 *   - EVERY exit path (missing Foundry, failed forge build, failed round, crash) writes a final
 *     report with the real outcome; `complete` is true only if everything ran AND passed;
 *   - Foundry (forge + anvil) is REQUIRED; any skipped test fails the run;
 *   - `--app-only` runs only application tests on purpose and records complete=false,
 *     contracts_tested=false, protocol_e2e_tested=false.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = join(root, 'test-report.json');
const runId = randomUUID();
const startedAt = new Date().toISOString();
// Resolve Foundry binaries to ABSOLUTE paths: the protocol e2e test checks existsSync(ANVIL_PATH), so a bare
// "anvil" (found via PATH) would make it fail. Order: env override, /opt/foundry, ~/.foundry/bin (foundryup), PATH.
function resolveBin(name, override) {
  if (override) return override;
  const candidates = [join('/opt/foundry', name), join(homedir(), '.foundry', 'bin', name)];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir) candidates.push(join(dir, name));
  return candidates.find((p) => existsSync(p)) ?? name;
}
const forge = resolveBin('forge', process.env.FORGE_PATH);
const anvil = resolveBin('anvil', process.env.ANVIL_PATH);
const appOnly = process.argv.includes('--app-only');
const repIdx = process.argv.indexOf('--e2e-repeats');
const e2eRepeats = appOnly ? 0 : repIdx >= 0 ? Math.max(0, Number(process.argv[repIdx + 1] ?? 10)) : 10;
const forgeEnv = existsSync('/opt/foundry/solc-0.8.28') ? { FOUNDRY_SOLC: '/opt/foundry/solc-0.8.28', FOUNDRY_OFFLINE: 'true' } : {};

const state = { rounds: [], e2e_stability: [], error: undefined };

function writeReport(status) {
  const roundsOk = state.rounds.length === 3 && state.rounds.every((r) => r.ok);
  const stabilityOk = state.e2e_stability.length === e2eRepeats && state.e2e_stability.every((r) => r.ok);
  const passed = status === 'finished' && !state.error && roundsOk && stabilityOk;
  const report = {
    run_id: runId,
    started_at: startedAt,
    generated_at: new Date().toISOString(),
    status, // running | failed | finished
    passed,
    complete: passed && !appOnly,
    mode: appOnly ? 'app-only' : 'full',
    contracts_tested: !appOnly && state.rounds.some((r) => r.steps.some((s) => s.name.startsWith('forge'))),
    protocol_e2e_tested: !appOnly && state.rounds.length > 0,
    error: state.error,
    rounds: state.rounds,
    e2e_stability: { requested: e2eRepeats, executed: state.e2e_stability.length, failures: state.e2e_stability.filter((r) => !r.ok).length, runs: state.e2e_stability },
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return report;
}

function fail(message, details = '') {
  state.error = message;
  writeReport('failed');
  console.error(`FAILED: ${message}${details ? `\n${details}` : ''}`);
  process.exit(1);
}

process.on('uncaughtException', (e) => fail(`crash: ${e.message}`));

// Invalidate any previous report before doing anything else.
writeReport('running');

function run(name, cmd, args, opts = {}) {
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  // A skipped test is a test that did not run: never count it as a pass (except --app-only).
  const skipped = Number((out.match(/Tests\s+.*?(\d+) skipped/) ?? out.match(/(\d+) skipped/) ?? [0, 0])[1]);
  const ok = r.status === 0 && (opts.allowSkips || skipped === 0);
  const summary = (out.match(/Tests\s+\d+ passed[^\n]*/) ?? out.match(/Tests\s+\d+ failed[^\n]*/) ?? out.match(/\d+ tests passed, \d+ failed[^\n]*/) ?? [ok ? 'ok' : 'FAILED'])[0].trim();
  const failedTests = [...out.matchAll(/^\s*(?:×|FAIL)\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 20);
  if (!opts.quiet) console.log(`  ${ok ? '✔' : '✘'} ${name.padEnd(28)} ${summary}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  if (!ok && !opts.quiet) console.log(out.split('\n').slice(-60).join('\n'));
  if (r.status === 0 && !ok) console.log(`    ${skipped} test(s) were SKIPPED — a full run requires every test to execute`);
  return { name, ok, summary, skipped, failed_tests: failedTests, seconds: (Date.now() - t) / 1000 };
}

const haveForge = spawnSync(forge, ['--version'], { encoding: 'utf8' }).status === 0;
const haveAnvil = spawnSync(anvil, ['--version'], { encoding: 'utf8' }).status === 0;
if (!appOnly && (!haveForge || !haveAnvil)) {
  fail(
    `Foundry is required (forge: ${haveForge ? 'ok' : 'MISSING'}, anvil: ${haveAnvil ? 'ok' : 'MISSING'})`,
    'Install Foundry (https://book.getfoundry.sh) or run `npm run test:3x -- --app-only` to run application tests only.',
  );
}
if (appOnly) console.log('*** --app-only: contract tests and protocol e2e will NOT run; this is NOT a full verification ***');
if (!appOnly) {
  // Contract artifacts are needed by the protocol e2e tests.
  const b = spawnSync(forge, ['build'], { cwd: join(root, 'contracts', 'evm'), env: { ...process.env, ...forgeEnv }, encoding: 'utf8' });
  if (b.status !== 0) fail('forge build failed', (b.stdout ?? '') + (b.stderr ?? ''));
}

const e2eEnv = appOnly ? {} : { ANVIL_PATH: anvil, REQUIRE_E2E: '1' };
for (let i = 1; i <= 3; i++) {
  const seed = Math.floor(Math.random() * 1_000_000);
  console.log(`\nRound ${i}/3  (TEST_SEED=${seed})`);
  const steps = [
    run('typecheck', 'npx', ['tsc', '--noEmit']),
    run('build', 'npx', ['tsc', '-p', 'tsconfig.build.json']),
    run('vitest', 'npx', ['vitest', 'run'], { env: { TEST_SEED: String(seed), ...e2eEnv }, allowSkips: appOnly }),
  ];
  if (!appOnly) steps.push(run('forge (unit+fuzz+invariant)', forge, ['test', '--fuzz-seed', String(seed)], { cwd: join(root, 'contracts', 'evm'), env: forgeEnv }));
  else console.log('  - contract tests NOT RUN (--app-only)');
  state.rounds.push({ round: i, seed, ok: steps.every((s) => s.ok), steps });
  writeReport('running');
}

if (e2eRepeats > 0) {
  console.log(`\nProtocol e2e stability: ${e2eRepeats} separate runs`);
  for (let i = 1; i <= e2eRepeats; i++) {
    const r = run(`e2e run ${i}/${e2eRepeats}`, 'npx', ['vitest', 'run', 'tests/protocol-e2e.test.ts'], { env: e2eEnv });
    state.e2e_stability.push({ run: i, id: randomUUID(), at: new Date().toISOString(), ok: r.ok, summary: r.summary, failed_tests: r.failed_tests, seconds: r.seconds });
    writeReport('running');
  }
}

const report = writeReport('finished');
console.log(
  `\n${!report.passed ? 'FAILURES — see above' : appOnly ? 'APP TESTS PASSED (3 rounds) — CONTRACT TESTS AND PROTOCOL E2E NOT RUN' : `ALL 3 ROUNDS PASSED (app + protocol e2e + contracts) + ${e2eRepeats}/${e2eRepeats} e2e stability runs`}`,
);
process.exit(report.passed ? 0 : 1);
