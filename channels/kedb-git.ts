// Git operations on the sre-kedb checkout, for the KEDB learning loop (plan §4, "Apply").
//
// The checkout at SRE_KEDB_DIR is owned by this code: the agent itself never runs git (its
// CLAUDE.md FORBIDDEN list stays true), and every sync is `fetch` + `reset --hard` to the
// remote branch, so local drift can never leak into a commit. Untracked files (node_modules,
// which the lint needs) survive a reset.
//
// Every child process is bounded twice: the process is killed at the deadline, and the await
// is wrapped in withTimeout (CLAUDE_ERROR_PATTERNS.md §14). Operations are serialised with
// `exclusive`, because there is one working tree and a propose and an apply must never
// interleave in it.

import { spawn } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withTimeout } from "./with-timeout.js";

/** Commits made by the loop carry this identity; sre-kedb's verify-approvals checks it. */
export const KEDB_COMMIT_AUTHOR = { name: "Claude SRE", email: "sre-agent@alien.club" } as const;

/** Bytes of stdout or stderr kept per process; more and the process fails. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class KedbGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KedbGitError";
  }
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs a process to completion and resolves with its exit code and output, whatever the code.
 * Rejects only when it cannot be started, outgrows MAX_OUTPUT_BYTES, or passes `timeoutMs`
 * (it is then killed).
 */
export function runProcess(command: string, args: string[], options: RunOptions): Promise<ProcessResult> {
  const work = new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) fail(new KedbGitError(`${command} ${args[0] ?? ""} wrote more than ${MAX_OUTPUT_BYTES} bytes`));
      else into.push(chunk);
    };
    const killer = setTimeout(() => fail(new KedbGitError(`${command} ${args[0] ?? ""} timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", (error) => {
      clearTimeout(killer);
      fail(new KedbGitError(`cannot run ${command}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      if (failed) return;
      if (code === null) {
        fail(new KedbGitError(`${command} ${args[0] ?? ""} was killed by ${signal ?? "a signal"}`));
        return;
      }
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => {
      // EPIPE when the process exits without reading its input; its exit code reports why.
    });
    child.stdin.end(options.input ?? "");
  });
  // A margin over the kill, so the killer's own error is the one reported.
  return withTimeout(work, options.timeoutMs + 1000, `${command} ${args[0] ?? ""}`);
}

/** The last lines of a process's stderr, for an error message. Never the stdout (it can be content). */
function tail(text: string): string {
  const lines = text.trim().split("\n").slice(-5).join(" | ");
  return lines.length > 600 ? `${lines.slice(0, 599)}…` : lines;
}

export interface KedbGitOptions {
  /** The sre-kedb checkout. */
  dir: string;
  /** Scratch space for diffs and lint runs; emptied before each use. */
  stageDir: string;
  /** Bound on each git command (fetch and push included). */
  timeoutMs: number;
  /** Bound on one lint run (`npm run lint`). */
  lintTimeoutMs: number;
  remote?: string;
  branch?: string;
}

export interface LintResult {
  ok: boolean;
  /** The lint's findings, one per line, when it failed. */
  output: string;
}

export interface KedbGit {
  /** Runs `work` alone: no other `exclusive` work starts until it settles. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /** Fetches the branch and resets the checkout to it. Returns the HEAD sha. */
  sync(): Promise<string>;
  /** The blob sha of `relPath` at HEAD, or null when it does not exist. */
  blobSha(relPath: string): Promise<string | null>;
  /** The content of `relPath` at HEAD, or null when it does not exist. */
  show(relPath: string): Promise<string | null>;
  /** The newest commit on HEAD with a message line equal to `line`, or null. */
  findCommitWithLine(line: string): Promise<string | null>;
  /** A unified diff of `before` (null: a new file) to `after`, labelled with `relPath`. */
  diff(relPath: string, before: string | null, after: string): Promise<string>;
  /** Lints a copy of the checkout with `relPath` replaced by `content`. */
  lintCandidate(relPath: string, content: string): Promise<LintResult>;
  /**
   * Writes `content` to `relPath`, lints the checkout, commits exactly that path with
   * `message` and pushes to the branch. Returns the commit sha. On any failure the checkout is
   * reset to the remote branch and the error thrown.
   */
  commitAndPush(relPath: string, content: string, message: string): Promise<string>;
}

const SAFE_REL_PATH = /^entries\/[a-z0-9][a-z0-9-]*\/(_family|[a-z0-9][a-z0-9-]*)\.md$/;

function checkRelPath(relPath: string): void {
  // The path allowlist of plan §5a: only entries/**/*.md is ever written.
  if (!SAFE_REL_PATH.test(relPath)) throw new KedbGitError(`refusing path ${JSON.stringify(relPath)}: only entries/<family>/<name>.md`);
}

export function createKedbGit(options: KedbGitOptions): KedbGit {
  const { dir, stageDir, timeoutMs, lintTimeoutMs, remote = "origin", branch = "main" } = options;
  const upstream = `${remote}/${branch}`;
  // No prompt can ever block a command: no terminal, and ssh fails instead of asking.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
  let queue: Promise<unknown> = Promise.resolve();

  async function git(args: string[], input?: string): Promise<ProcessResult> {
    return runProcess("git", ["-C", dir, ...args], { cwd: dir, timeoutMs, input, env });
  }

  async function gitOk(args: string[], input?: string): Promise<string> {
    const result = await git(args, input);
    if (result.code !== 0) throw new KedbGitError(`git ${args[0]} failed (exit ${result.code}): ${tail(result.stderr)}`);
    return result.stdout;
  }

  async function lint(root: string): Promise<LintResult> {
    // The lint is sre-kedb's own (ci/lint.ts, Leo-owned), run with the checkout's node_modules.
    const result = await runProcess("npm", ["run", "--silent", "lint", "--", root], { cwd: dir, timeoutMs: lintTimeoutMs, env });
    if (result.code === 0) return { ok: true, output: "" };
    const output = `${result.stderr}\n${result.stdout}`.trim();
    return { ok: false, output: output.length > 4000 ? `${output.slice(0, 3999)}…` : output };
  }

  async function blobSha(relPath: string): Promise<string | null> {
    checkRelPath(relPath);
    const result = await git(["rev-parse", "--verify", "--quiet", `HEAD:${relPath}`]);
    if (result.code === 0) return result.stdout.trim();
    if (result.code === 1 && result.stderr.trim() === "") return null;
    throw new KedbGitError(`git rev-parse HEAD:${relPath} failed (exit ${result.code}): ${tail(result.stderr)}`);
  }

  async function resetToUpstream(): Promise<void> {
    await gitOk(["reset", "--hard", "--quiet", upstream]);
  }

  return {
    exclusive(work) {
      const run = queue.then(work, work);
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },

    async sync() {
      await gitOk(["fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${upstream}`]);
      await resetToUpstream();
      return (await gitOk(["rev-parse", "HEAD"])).trim();
    },

    blobSha,

    async show(relPath) {
      if ((await blobSha(relPath)) === null) return null;
      return gitOk(["show", `HEAD:${relPath}`]);
    },

    async findCommitWithLine(line) {
      if (!/^[A-Za-z-]+: [A-Za-z0-9 .-]+$/.test(line)) throw new KedbGitError(`refusing to search for ${JSON.stringify(line)}`);
      const pattern = `^${line.replace(/[.]/g, "\\.")}$`;
      const sha = (await gitOk(["log", "--format=%H", "-n", "1", "--extended-regexp", `--grep=${pattern}`, "HEAD"])).trim();
      return sha === "" ? null : sha;
    },

    async diff(relPath, before, after) {
      checkRelPath(relPath);
      const root = join(stageDir, "diff");
      await rm(root, { recursive: true, force: true });
      const newFile = join("b", relPath);
      await mkdir(dirname(join(root, newFile)), { recursive: true });
      await writeFile(join(root, newFile), after, "utf8");
      let oldFile = "/dev/null";
      if (before !== null) {
        oldFile = join("a", relPath);
        await mkdir(dirname(join(root, oldFile)), { recursive: true });
        await writeFile(join(root, oldFile), before, "utf8");
      }
      const result = await runProcess("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", "--", oldFile, newFile], {
        cwd: root,
        timeoutMs,
        env,
      });
      // --no-index exits 1 when the files differ, 0 when they do not.
      if (result.code === 0) return "";
      if (result.code !== 1) throw new KedbGitError(`git diff failed (exit ${result.code}): ${tail(result.stderr)}`);
      return result.stdout;
    },

    async lintCandidate(relPath, content) {
      checkRelPath(relPath);
      const root = join(stageDir, "lint");
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
      await cp(join(dir, "schema"), join(root, "schema"), { recursive: true });
      await cp(join(dir, "entries"), join(root, "entries"), { recursive: true });
      await mkdir(dirname(join(root, relPath)), { recursive: true });
      await writeFile(join(root, relPath), content, "utf8");
      return lint(root);
    },

    async commitAndPush(relPath, content, message) {
      checkRelPath(relPath);
      try {
        await mkdir(dirname(join(dir, relPath)), { recursive: true });
        await writeFile(join(dir, relPath), content, "utf8");
        await gitOk(["add", "--", relPath]);
        const staged = (await gitOk(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
        if (staged.length !== 1 || staged[0] !== relPath) {
          throw new KedbGitError(`refusing to commit: staged ${JSON.stringify(staged)}, expected only ${relPath}`);
        }
        const linted = await lint(dir);
        if (!linted.ok) throw new KedbGitError(`the KEDB lint rejects the entry: ${linted.output}`);
        await gitOk(
          [
            "-c",
            `user.name=${KEDB_COMMIT_AUTHOR.name}`,
            "-c",
            `user.email=${KEDB_COMMIT_AUTHOR.email}`,
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "--no-verify",
            "--cleanup=verbatim",
            "-F",
            "-",
          ],
          message
        );
        const sha = (await gitOk(["rev-parse", "HEAD"])).trim();
        await gitOk(["push", "--quiet", remote, `HEAD:refs/heads/${branch}`]);
        return sha;
      } catch (err) {
        try {
          await resetToUpstream();
        } catch (resetErr) {
          throw new KedbGitError(
            `${err instanceof Error ? err.message : String(err)}; then resetting the checkout failed too: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}`
          );
        }
        throw err;
      }
    },
  };
}
