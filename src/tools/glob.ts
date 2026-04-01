import { glob } from "glob";
import path from "path";
import type { Tool, ToolResult } from "./types.js";

const MAX_RESULTS = 100;

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Returns matching file paths sorted by modification time.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern to match (e.g. "**/*.ts", "src/**/*.tsx")',
      },
      path: {
        type: "string",
        description: "Directory to search in (defaults to current working directory)",
      },
    },
    required: ["pattern"],
  },

  async call(input): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) || process.cwd();
    const cwd = path.resolve(searchPath);

    try {
      const files = await glob(pattern, {
        cwd,
        nodir: true,
        dot: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
      });

      if (files.length === 0) {
        return { content: "No files matched the pattern." };
      }

      const truncated = files.length > MAX_RESULTS;
      const result = files.slice(0, MAX_RESULTS).join("\n");

      let output = result;
      if (truncated) {
        output += `\n\n[Showing ${MAX_RESULTS} of ${files.length} matches]`;
      } else {
        output += `\n\n[${files.length} file(s) matched]`;
      }

      return { content: output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: ${msg}`, isError: true };
    }
  },
};
