// Round 4 Task A0: the fourth provider -- the locally installed `claude`
// CLI running on the owner's own Claude Code subscription (no API key).
// Every process invocation goes through the injected `exec` so tests never
// spawn the real binary; `defaultExec` (child_process.spawn) is what
// production actually uses.
import { spawn } from "node:child_process";
import { LlmProviderUnavailable } from "./types.js";

export type ExecResult = { stdout: string; code: number };
export type Exec = (cmd: string, args: string[], input: string) => Promise<ExecResult>;

/** Production `exec`: spawns `cmd`, writes `input` to stdin, collects stdout, resolves with the exit code (0 if the process reports none). */
export function defaultExec(cmd: string, args: string[], input: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    // stderr is intentionally not captured into the thrown/returned data --
    // callers only need stdout (the JSON envelope) and the exit code.
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code: code ?? 0 }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

// "Check once" per the plan -- cached per `exec` function so production
// (one stable `defaultExec` reference) really only runs `claude --help`
// once, while each test's own fake `exec` gets its own independent check.
const systemPromptFlagCache = new WeakMap<Exec, Promise<boolean>>();

async function hasSystemPromptFlag(exec: Exec): Promise<boolean> {
  let cached = systemPromptFlagCache.get(exec);
  if (!cached) {
    cached = exec("claude", ["--help"], "")
      .then((r) => r.stdout.includes("--system-prompt"))
      .catch(() => false);
    systemPromptFlagCache.set(exec, cached);
  }
  return cached;
}

export type ClaudeCodeCallParams = {
  model: string;
  system: string;
  user: string;
  exec: Exec;
};

export type ClaudeCodeCallResult = {
  raw: unknown;
  tokensIn: number;
  tokensOut: number;
};

type ClaudeCliEnvelope = {
  result?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export async function callClaudeCode(params: ClaudeCodeCallParams): Promise<ClaudeCodeCallResult> {
  const { model, system, user, exec } = params;

  const version = await exec("claude", ["--version"], "").catch(() => null);
  if (!version || version.code !== 0) {
    throw new LlmProviderUnavailable(
      "Claude Code CLI not found (claude --version failed) -- install it, or choose a different provider in Settings.",
    );
  }

  const supportsSystemPromptFlag = await hasSystemPromptFlag(exec);
  const args = ["-p", "--output-format", "json", "--model", model];
  let stdin: string;
  if (supportsSystemPromptFlag) {
    args.push("--system-prompt", system);
    stdin = user;
  } else {
    stdin = `SYSTEM:\n${system}\n\nUSER:\n${user}`;
  }

  const result = await exec("claude", args, stdin);
  if (result.code !== 0) {
    throw new Error(`claude CLI exited with code ${result.code}`);
  }

  let envelope: ClaudeCliEnvelope;
  try {
    envelope = JSON.parse(result.stdout) as ClaudeCliEnvelope;
  } catch {
    throw new Error("claude CLI did not return a valid JSON envelope");
  }

  return {
    raw: envelope.result ?? null,
    tokensIn: envelope.usage?.input_tokens ?? 0,
    tokensOut: envelope.usage?.output_tokens ?? 0,
  };
}
