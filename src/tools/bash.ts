import { spawn } from "child_process";
import type { Tool, ToolResult } from "./types.js";

const MAX_OUTPUT_CHARS = 10000;
const DEFAULT_TIMEOUT_MS = 30000;

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command and return its output (stdout + stderr). Use for running git, npm, build commands, tests, listing files, etc.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
      },
    },
    required: ["command"],
  },

  async call(input): Promise<ToolResult> {
    const command = input.command as string;
    const timeout = (input.timeout as number) || DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      const chunks: string[] = [];
      let killed = false;

      // Use PowerShell on Windows for better Unix command compatibility
      const isWindows = process.platform === "win32";
      const proc = spawn(command, {
        shell: isWindows ? "powershell.exe" : true,
        cwd: process.cwd(),
        timeout,
        env: { ...process.env },
      });

      proc.stdout?.on("data", (data: Buffer) => {
        chunks.push(data.toString());
      });

      proc.stderr?.on("data", (data: Buffer) => {
        chunks.push(data.toString());
      });

      proc.on("error", (err) => {
        resolve({
          content: `Error executing command: ${err.message}`,
          isError: true,
        });
      });

      proc.on("close", (code) => {
        let output = chunks.join("");

        if (output.length > MAX_OUTPUT_CHARS) {
          output =
            output.slice(0, MAX_OUTPUT_CHARS) +
            `\n\n[Output truncated: ${output.length} chars total, showing first ${MAX_OUTPUT_CHARS}]`;
        }

        if (killed) {
          output += `\n[Command timed out after ${timeout}ms]`;
        }

        const prefix = code !== 0 ? `[Exit code: ${code}]\n` : "";
        resolve({ content: prefix + output, isError: code !== 0 });
      });

      setTimeout(() => {
        if (!proc.killed) {
          killed = true;
          proc.kill("SIGTERM");
        }
      }, timeout);
    });
  },
};
