// Tests for the session watchdog. Run with: npm test
//
// The watchdog restarts the agent on its own, so the cases that matter are the ones where it
// must NOT: a short outage, the never_acked minutes after its own restart, a gap in its
// checks, and the hourly cap. Each test drives the real script once per simulated minute
// against stubs first on PATH: `date` answers the test's clock for `date +%s` (and hands
// formatting to the real date), `curl` answers what the test set, and `pm2` records its calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatchdogRestartsReader } from "../channels/watchdog-restarts.js";

const SCRIPT = "scripts/session-watchdog.sh";
const URL = "http://127.0.0.1:8788/health/session";
const T0 = Date.parse("2026-10-28T09:00:00Z") / 1000;
const MINUTE = 60;

const REAL_DATE = spawnSync("bash", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim();

type Answer = "ok" | "stale" | "never_acked" | "unreachable";

const BODIES: Record<Exclude<Answer, "unreachable">, { code: number; body: string }> = {
  ok: { code: 200, body: '{"status":"ok","last_ack_at":"2026-10-28T08:59:00.000Z","age_seconds":60,"max_age_seconds":720,"heartbeat_interval_seconds":300}' },
  stale: { code: 503, body: '{"status":"stale","last_ack_at":"2026-10-28T08:40:00.000Z","age_seconds":1200,"max_age_seconds":720,"heartbeat_interval_seconds":300}' },
  never_acked: { code: 503, body: '{"status":"never_acked","last_ack_at":null,"age_seconds":null,"max_age_seconds":720,"heartbeat_interval_seconds":300}' },
};

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function executable(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function watchdog(options: { pm2Exit?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sre-watchdog-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const fake = join(root, "fake");
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(fake);

  executable(join(bin, "date"), `if [ "$*" = "+%s" ]; then cat "${fake}/now"; else exec "${REAL_DATE}" "$@"; fi`);
  executable(
    join(bin, "curl"),
    [
      `printf '%s\\n' "$@" > "${fake}/curl-args"`,
      `if [ "$(cat "${fake}/answer")" = unreachable ]; then`,
      `  echo "curl: (7) Failed to connect to 127.0.0.1 port 8788" >&2; printf '\\n000'; exit 7`,
      `fi`,
      `cat "${fake}/body"; printf '\\n%s' "$(cat "${fake}/code")"`,
    ].join("\n")
  );
  executable(join(bin, "pm2"), `echo "pm2 $*" >> "${fake}/pm2-calls"; exit ${options.pm2Exit ?? 0}`);

  let clock = T0;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE_DIRECTORY: state, SRE_WATCHDOG_URL: URL };

  function answer(kind: Answer) {
    writeFileSync(join(fake, "answer"), kind);
    if (kind !== "unreachable") {
      writeFileSync(join(fake, "code"), String(BODIES[kind].code));
      writeFileSync(join(fake, "body"), BODIES[kind].body);
    }
  }

  function check(): RunResult {
    writeFileSync(join(fake, "now"), String(clock));
    const result = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  return {
    state,
    answer,
    check,
    at: () => clock,
    advance: (seconds: number) => {
      clock += seconds;
    },
    /** One check per minute, `minutes` times, starting one minute from now; returns the last. */
    minutes(count: number): RunResult[] {
      const results: RunResult[] = [];
      for (let i = 0; i < count; i++) {
        clock += MINUTE;
        results.push(check());
      }
      return results;
    },
    restarts: () => (existsSync(join(fake, "pm2-calls")) ? readFileSync(join(fake, "pm2-calls"), "utf8").trim().split("\n") : []),
    curlArgs: () => readFileSync(join(fake, "curl-args"), "utf8").trim().split("\n"),
    stateFile: (name: string) => join(state, name),
  };
}

function iso(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace(".000Z", "Z");
}

test("a healthy session is never restarted, and no failure window is kept", () => {
  const w = watchdog();
  w.answer("ok");

  const runs = [w.check(), ...w.minutes(10)];

  for (const run of runs) {
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /^<6>\[session-watchdog\] session healthy \(HTTP 200, ok\)$/m);
  }
  assert.deepEqual(w.restarts(), []);
  assert.equal(existsSync(w.stateFile("first_failure")), false);
  assert.equal(existsSync(w.stateFile("last_restart")), false);
});

test("the probe is bounded and goes to the configured URL", () => {
  const w = watchdog();
  w.answer("ok");

  w.check();

  const args = w.curlArgs();
  assert.equal(args.at(-1), URL);
  assert.equal(args[args.indexOf("--max-time") + 1], "5");
  assert.equal(args[args.indexOf("--connect-timeout") + 1], "2");
});

test("4 min of failures restart nothing", () => {
  const w = watchdog();
  w.answer("stale");

  const first = w.check();
  const later = w.minutes(4);

  assert.match(first.stderr, /<4>\[session-watchdog\] session unhealthy \(HTTP 503, stale\); window of 300s starts/);
  assert.match(later.at(-1)!.stderr, /session unhealthy for 240s \(HTTP 503, stale\); restart only after 300s/);
  assert.deepEqual(w.restarts(), []);
});

test("exactly 5 min of failures is not yet more than 5 min", () => {
  const w = watchdog();
  w.answer("stale");

  w.check();
  w.minutes(5);

  assert.deepEqual(w.restarts(), []);
});

test("6 min of failures restart the agent once, and record it", () => {
  const w = watchdog();
  w.answer("stale");

  w.check();
  const runs = w.minutes(6);

  assert.deepEqual(w.restarts(), ["pm2 restart sre-agent"]);
  const restart = runs.at(-1)!;
  assert.equal(restart.status, 0, restart.stderr);
  assert.match(restart.stderr, /<4>\[session-watchdog\] session unhealthy for 360s \(HTTP 503, stale\); running pm2 restart sre-agent \(restart 1 of 2 this hour\)/);
  assert.match(restart.stderr, /<6>\[session-watchdog\] pm2 restart sre-agent done/);

  const at = T0 + 6 * MINUTE;
  assert.deepEqual(JSON.parse(readFileSync(w.stateFile("last_restart"), "utf8")), {
    last_restart_at: iso(at),
    restarts_last_hour: 1,
    restarts: [iso(at)],
  });
  assert.equal(readFileSync(w.stateFile("restart_history"), "utf8").trim(), String(at));
  assert.equal(existsSync(w.stateFile("first_failure")), false, "the restart ends the window");
});

test("the record the script writes is the one /health/session reads", async () => {
  const w = watchdog();
  w.answer("stale");
  w.check();
  w.minutes(6);

  const read = createWatchdogRestartsReader({ path: w.stateFile("last_restart"), now: () => (w.at() + 30) * 1000, log: assert.fail });
  assert.deepEqual(await read(), { last_restart_at: iso(T0 + 6 * MINUTE), restarts_last_hour: 1 });
});

test("an unreachable channel (no HTTP answer) counts as a failure", () => {
  const w = watchdog();
  w.answer("unreachable");

  const first = w.check();
  w.minutes(6);

  assert.match(first.stderr, /session unhealthy \(HTTP 000, curl exit 7\)/);
  assert.match(first.stderr, /Failed to connect/, "curl's own error reaches the journal");
  assert.deepEqual(w.restarts(), ["pm2 restart sre-agent"]);
});

test("after a restart the window starts again: never_acked does not restart before another 5 min", () => {
  const w = watchdog();
  w.answer("stale");
  w.check();
  w.minutes(6);
  assert.equal(w.restarts().length, 1);

  // The new session answers 503 never_acked for its first ~2 min, and here never recovers
  w.answer("never_acked");
  const afterRestart = w.minutes(6);

  assert.equal(w.restarts().length, 1, "no restart within 6 checks of the previous one");
  assert.match(afterRestart[0].stderr, /session unhealthy \(HTTP 503, never_acked\); window of 300s starts/);
  assert.match(afterRestart.at(-1)!.stderr, /session unhealthy for 300s \(HTTP 503, never_acked\); restart only after 300s/);

  const next = w.minutes(1)[0];
  assert.equal(w.restarts().length, 2);
  assert.match(next.stderr, /restart 2 of 2 this hour/);
});

test("a session that acks within 2 min of its restart is left alone", () => {
  const w = watchdog();
  w.answer("stale");
  w.check();
  w.minutes(6);

  w.answer("never_acked");
  w.minutes(2);
  w.answer("ok");
  const healthy = w.minutes(1)[0];
  w.minutes(60);

  assert.equal(w.restarts().length, 1);
  assert.match(healthy.stderr, /session healthy again \(HTTP 200, ok\) after 120s of failures; window cleared/);
});

test("once 2 restarts happened in the last hour, a third is refused and only logged", () => {
  const w = watchdog();
  w.answer("stale");
  w.check();
  w.minutes(6); // restart 1 at +6 min
  w.minutes(7); // window restarts at +7, restart 2 at +13 min
  assert.equal(w.restarts().length, 2);

  const refused = w.minutes(10);

  assert.equal(w.restarts().length, 2);
  const last = refused.at(-1)!;
  assert.equal(last.status, 0, last.stderr);
  assert.match(last.stderr, /<4>\[session-watchdog\] session unhealthy for \d+s \(HTTP 503, stale\), but 2 restarts in the last hour reached the cap of 2; not restarting/);
  assert.equal(JSON.parse(readFileSync(w.stateFile("last_restart"), "utf8")).restarts_last_hour, 2);
});

test("the cap is a rolling hour: once the first restart is an hour old, one more is allowed", () => {
  const w = watchdog();
  w.answer("stale");
  w.check();
  w.minutes(6); // restart at +6 min
  w.minutes(7); // restart at +13 min
  w.minutes(52); // up to +65 min: the first restart is 59 min old, still capped
  assert.equal(w.restarts().length, 2);

  w.minutes(1); // +66 min: the first restart is exactly an hour old and drops out
  assert.equal(w.restarts().length, 3);
  const record = JSON.parse(readFileSync(w.stateFile("last_restart"), "utf8"));
  assert.deepEqual(record, {
    last_restart_at: iso(T0 + 66 * MINUTE),
    restarts_last_hour: 2,
    restarts: [iso(T0 + 13 * MINUTE), iso(T0 + 66 * MINUTE)],
  });
});

test("a success in between resets the window", () => {
  const w = watchdog();
  w.answer("stale");
  w.check();
  w.minutes(4);
  w.answer("ok");
  w.minutes(1);
  w.answer("stale");
  w.minutes(5);

  assert.deepEqual(w.restarts(), []);
});

test("a gap between checks starts the window again rather than counting an old first failure", () => {
  const w = watchdog();
  w.answer("stale");
  w.check();
  // The timer did not run for 10 min (VM rebooted, for instance)
  w.advance(10 * MINUTE);
  const resumed = w.check();
  w.minutes(5);

  assert.deepEqual(w.restarts(), []);
  assert.match(resumed.stderr, /but the previous check was 600s ago; the failures are not consecutive, window of 300s starts again/);
  w.minutes(1);
  assert.equal(w.restarts().length, 1);
});

test("a failed pm2 restart still counts toward the cap, ends the window, and fails the run", () => {
  const w = watchdog({ pm2Exit: 1 });
  w.answer("stale");
  w.check();
  const runs = w.minutes(6);

  const restart = runs.at(-1)!;
  assert.equal(restart.status, 1);
  assert.match(restart.stderr, /<3>\[session-watchdog\] pm2 restart sre-agent failed or did not finish in 120s; it still counts toward the cap/);
  assert.equal(JSON.parse(readFileSync(w.stateFile("last_restart"), "utf8")).restarts_last_hour, 1);
  w.minutes(5);
  assert.equal(w.restarts().length, 1, "the window started again after the failed attempt");
});

test("a corrupt restart history refuses every restart, loudly", () => {
  const w = watchdog();
  writeFileSync(w.stateFile("restart_history"), "yesterday\n");
  w.answer("stale");
  w.check();
  const runs = w.minutes(6);

  assert.deepEqual(w.restarts(), []);
  const refused = runs.at(-1)!;
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /<3>\[session-watchdog\] restart history .* holds 'yesterday', not an epoch; refusing to restart until it is fixed/);
});

test("a corrupt first_failure only restarts the window", () => {
  const w = watchdog();
  w.answer("stale");
  w.check();
  writeFileSync(w.stateFile("first_failure"), "garbage\n");
  const run = w.minutes(1)[0];

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /ignoring the corrupt .*first_failure; the failure window starts again/);
  assert.equal(readFileSync(w.stateFile("first_failure"), "utf8").trim(), String(w.at()));
  w.minutes(5);
  assert.deepEqual(w.restarts(), []);
});

test("it refuses to run without its URL or state directory", () => {
  for (const missing of ["SRE_WATCHDOG_URL", "STATE_DIRECTORY"]) {
    const env: NodeJS.ProcessEnv = { ...process.env, SRE_WATCHDOG_URL: URL, STATE_DIRECTORY: tmpdir() };
    delete env[missing];
    const result = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${missing} must be set`));
  }
});

test("the systemd units run the script every minute as sre-agent, bounded, with private state", () => {
  const service = readFileSync("provision/systemd/sre-agent-session-watchdog.service", "utf8");
  const timer = readFileSync("provision/systemd/sre-agent-session-watchdog.timer", "utf8");

  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^User=sre-agent$/m);
  assert.match(service, /^ExecStart=\/bin\/bash \/home\/sre-agent\/sre-agent\/scripts\/session-watchdog\.sh$/m);
  assert.match(service, /^StateDirectory=sre-agent-watchdog$/m);
  assert.match(service, /^StateDirectoryMode=0750$/m);
  assert.match(service, /^UMask=0027$/m);
  assert.match(service, new RegExp(`^Environment=SRE_WATCHDOG_URL=${URL.replace(/[.]/g, "\\.")}$`, "m"));
  assert.match(service, /^TimeoutStartSec=\d+$/m);
  assert.match(timer, /^OnUnitActiveSec=1min$/m);
  assert.match(timer, /^Unit=sre-agent-session-watchdog\.service$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});
