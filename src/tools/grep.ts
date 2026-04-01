import { spawn } from "child_process";
import { readFile } from "fs/promises";
import { glob } from "glob";
import path from "path";
import type { Tool, ToolResult } from "./types.js";

const MAX_RESULTS = 250;
const MAX_LINE_LENGTH = 500;

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents using a regex pattern. Uses ripgrep (rg) if available, falls back to built-in search.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description: "File or directory to search (defaults to cwd)",
      },
      include: {
        type: "string",
        description: 'Glob to filter files (e.g. "*.ts", "*.{js,jsx}")',
      },
    },
    required: ["pattern"],
  },

  async call(input): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = path.resolve((input.path as string) || process.cwd());
    const include = input.include as string | undefined;

    // Try ripgrep first
    try {
      const result = await tryRipgrep(pattern, searchPath, include);
      if (result !== null) return result;
    } catch {
      // Fall through to built-in
    }

    // Built-in fallback
    return builtinGrep(pattern, searchPath, include);
  },
};

function tryRipgrep(
  pattern: string,
  searchPath: string,
  include?: string,
): Promise<ToolResult | null> {
  return new Promise((resolve) => {
    const args = [
      "--line-number",
      "--no-heading",
      "--color=never",
      "--max-columns",
      String(MAX_LINE_LENGTH),
      "--hidden",
      "--glob",
      "!.git",
      "--glob",
      "!node_modules",
    ];

    if (include) {
      args.push("--glob", include);
    }

    args.push(pattern, searchPath);

    const proc = spawn("rg", args, { timeout: 15000 });
    const chunks: string[] = [];
    let errChunks = "";

    proc.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.stderr?.on("data", (d: Buffer) => {
      errChunks += d.toString();
    });

    proc.on("error", () => resolve(null)); // rg not found

    proc.on("close", (code) => {
      if (code === 2) {
        // rg error
        resolve(null);
        return;
      }

      const output = chunks.join("");
      const lines = output.split("\n").filter(Boolean);

      if (lines.length === 0) {
        resolve({ content: "No matches found." });
        return;
      }

      const truncated = lines.length > MAX_RESULTS;
      const result = lines.slice(0, MAX_RESULTS).join("\n");

      let content = result;
      if (truncated) {
        content += `\n\n[Showing ${MAX_RESULTS} of ${lines.length}+ matches]`;
      } else {
        content += `\n\n[${lines.length} match(es)]`;
      }

      resolve({ content });
    });
  });
}

async function builtinGrep(
  pattern: string,
  searchPath: string,
  include?: string,
): Promise<ToolResult> {
  try {
    const regex = new RegExp(pattern, "i");
    const files = await glob(include || "**/*", {
      cwd: searchPath,
      nodir: true,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
      absolute: true,
    });

    const matches: string[] = [];

    for (const file of files) {
      if (matches.length >= MAX_RESULTS) break;
      try {
        const content = await readFile(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_RESULTS) break;
          if (regex.test(lines[i]!)) {
            const rel = path.relative(searchPath, file);
            const line = lines[i]!.slice(0, MAX_LINE_LENGTH);
            matches.push(`${rel}:${i + 1}:${line}`);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (matches.length === 0) {
      return { content: "No matches found." };
    }

    return {
      content:
        matches.join("\n") + `\n\n[${matches.length} match(es), built-in search]`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}
