/**
 * A Vercel isolated-sandbox provider for Sandcastle that adds two things the
 * stock `@ai-hero/sandcastle` `vercel()` adapter (v0.12.0) lacks:
 *
 *   1. Custom image support — boot the sandbox from a Vercel Container Registry
 *      (VCR) image (`image`) instead of only a stock `runtime`. The image bakes
 *      in the agent toolchain (git, gh, claude), so no per-run install is needed.
 *
 *   2. stdin delivery — Sandcastle feeds the agent its prompt on stdin (the
 *      `claude … -p -` command reads it from there), but `@vercel/sandbox`'s
 *      `runCommand` has no stdin parameter, and the stock adapter drops it, so
 *      the prompt never reaches the agent. Here we write stdin to a file in the
 *      sandbox and redirect it into the command.
 *
 * Built on the public `createIsolatedSandboxProvider` seam, so the rest of the
 * Sandcastle run loop (branch reconciliation, review handoff) is unchanged. This
 * is otherwise a faithful port of the stock adapter's handle (exec streaming,
 * copyIn/out, close).
 */

import { createIsolatedSandboxProvider } from "@ai-hero/sandcastle";
import { Sandbox } from "@vercel/sandbox";
import { execSync } from "child_process";
import { mkdir, writeFile, stat, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Writable } from "stream";

/** Where the repo lives inside a Vercel sandbox (matches the stock adapter). */
const REPO_PATH = "/vercel/sandbox/workspace";
/** Cap on retained per-stream output, so a long agent run can't overflow V8's max string. */
const MAX_TAIL_CHARS = 64 * 1024;

/** A git source the sandbox clones on creation (mirrors `@vercel/sandbox`'s shape). */
export interface VercelGitSource {
  readonly type: "git";
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  readonly depth?: number;
  readonly revision?: string;
}

export interface VercelProviderOptions {
  /**
   * A VCR image reference to boot from — `"repo"`, `"repo:tag"`,
   * `"repo@sha256:…"`, or a fully-qualified `vcr.vercel.com/…` URL. Mutually
   * exclusive with {@link runtime}; when set, {@link runtime} is ignored.
   */
  readonly image?: string;
  /** Stock runtime to boot from when no {@link image} is given (default `node24`). */
  readonly runtime?: string;
  readonly token?: string;
  readonly teamId?: string;
  readonly projectId?: string;
  readonly source?: VercelGitSource;
  readonly timeoutMs?: number;
  /** Provider-level env, merged by Sandcastle with the resolved run env. */
  readonly env?: Record<string, string>;
}

/** Keep only the last `max` characters of a growing stream. */
function boundedTail(max: number) {
  let buf = "";
  return {
    push(chunk: string) {
      buf += chunk;
      if (buf.length > max) buf = buf.slice(buf.length - max);
    },
    toString: () => buf,
  };
}

export const vercelProvider = (options: VercelProviderOptions) =>
  createIsolatedSandboxProvider({
    name: options.image ? "vercel-image" : "vercel",
    env: options.env,
    create: async ({ env }) => {
      // `image` and `runtime` are mutually exclusive server-side — send exactly one.
      const boot = options.image
        ? { image: options.image }
        : { runtime: options.runtime ?? "node24" };
      let sandbox: Awaited<ReturnType<typeof Sandbox.create>>;
      try {
        sandbox = await Sandbox.create({
          ...boot,
          ...(options.source ? { source: options.source } : {}),
          ...(options.token ? { token: options.token } : {}),
          ...(options.teamId ? { teamId: options.teamId } : {}),
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
          env,
        } as Parameters<typeof Sandbox.create>[0]);
      } catch (err: unknown) {
        // The SDK's APIError carries Vercel's response body in `.text`/`.json`,
        // but only `.message` ("Status code 500 is not ok") propagates up. Re-throw
        // with the body + status + which image/runtime, so the real cause is visible.
        const e = err as { message?: string; text?: string; json?: unknown; response?: { status?: number } };
        const status = e?.response?.status;
        const body = e?.text ?? (e?.json !== undefined ? JSON.stringify(e.json) : undefined);
        const detail = [
          "Vercel Sandbox.create failed",
          status ? `(HTTP ${status})` : undefined,
          options.image ? `image="${options.image}"` : `runtime="${options.runtime ?? "node24"}"`,
          e?.message,
          body ? `— Vercel response: ${body}` : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        throw new Error(detail, { cause: err });
      }
      await sandbox.mkDir(REPO_PATH);

      const runViaSh = async (
        rawCommand: string,
        opts: { onLine?: (line: string) => void; cwd?: string; sudo?: boolean; stdin?: string } | undefined,
      ) => {
        // The SDK can't pipe stdin, so stage it as a file and redirect it into
        // the command. The sandbox is ephemeral, but we still clean the file up.
        let command = rawCommand;
        let stdinPath: string | undefined;
        if (opts?.stdin !== undefined) {
          stdinPath = `/tmp/sc-stdin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          await sandbox.writeFiles([{ path: stdinPath, content: Buffer.from(opts.stdin) }]);
          command = `( ${rawCommand} ) < ${stdinPath}`;
        }
        const cwd = opts?.cwd ?? REPO_PATH;
        const sudo = opts?.sudo ? { sudo: true } : {};
        try {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            const outTail = boundedTail(MAX_TAIL_CHARS);
            const errTail = boundedTail(MAX_TAIL_CHARS);
            let partial = "";
            const stdout = new Writable({
              write(chunk, _enc, cb) {
                const text = partial + chunk.toString();
                const lines = text.split("\n");
                partial = lines.pop() ?? "";
                for (const line of lines) {
                  outTail.push(line + "\n");
                  onLine(line);
                }
                cb();
              },
              final(cb) {
                if (partial) {
                  outTail.push(partial);
                  onLine(partial);
                  partial = "";
                }
                cb();
              },
            });
            const stderr = new Writable({
              write(chunk, _enc, cb) {
                errTail.push(chunk.toString());
                cb();
              },
            });
            const res = await sandbox.runCommand({ cmd: "sh", args: ["-c", command], cwd, stdout, stderr, ...sudo });
            return { stdout: outTail.toString(), stderr: errTail.toString(), exitCode: res.exitCode };
          }
          const res = await sandbox.runCommand({ cmd: "sh", args: ["-c", command], cwd, ...sudo });
          return { stdout: await res.stdout(), stderr: await res.stderr(), exitCode: res.exitCode };
        } finally {
          if (stdinPath) {
            await sandbox.runCommand({ cmd: "rm", args: ["-f", stdinPath] }).catch(() => {});
          }
        }
      };

      return {
        worktreePath: REPO_PATH,
        exec: (command, opts) => runViaSh(command, opts),
        copyIn: async (hostPath, sandboxPath) => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            const tarPath = join(tmpdir(), `sc-copyin-${Date.now()}.tar.gz`);
            execSync(`tar -czf "${tarPath}" -C "${hostPath}" .`);
            try {
              const content = await readFile(tarPath);
              const dest = `/tmp/sc-copyin-${Date.now()}.tar.gz`;
              await sandbox.writeFiles([{ path: dest, content }]);
              await sandbox.runCommand({
                cmd: "sh",
                args: ["-c", `mkdir -p "${sandboxPath}" && tar -xzf "${dest}" -C "${sandboxPath}" && rm -f "${dest}"`],
              });
            } finally {
              await unlink(tarPath).catch(() => {});
            }
          } else {
            const content = await readFile(hostPath);
            await sandbox.writeFiles([{ path: sandboxPath, content }]);
          }
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          const buffer = await sandbox.readFileToBuffer({ path: sandboxPath });
          if (!buffer) throw new Error(`File not found in Vercel sandbox: ${sandboxPath}`);
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, buffer);
        },
        close: async () => {
          await sandbox.stop();
        },
      };
    },
  });
