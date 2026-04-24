import { spawn } from "node:child_process";

export interface ExecResult {
  command: string;
  args: string[];
  cwd: string;
  code: number;
  stdout: string;
  stderr: string;
}

export async function execCommand(command: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString();
    });

    child.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });

    child.on("error", reject);
    child.on("close", (code: number | null) => {
      resolve({
        command,
        args,
        cwd,
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}
