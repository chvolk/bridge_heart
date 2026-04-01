import { readFile } from "fs/promises";
import path from "path";
import type { Tool, ToolResult } from "./types.js";

const DEFAULT_LIMIT = 500;

export const fileReadTool: Tool = {
  name: "file_read",
  description:
    "Read a file's contents with line numbers. Use offset and limit to read specific sections of large files.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to read",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-based)",
      },
      limit: {
        type: "number",
        description: `Maximum number of lines to read (default: ${DEFAULT_LIMIT})`,
      },
    },
    required: ["file_path"],
  },

  async call(input): Promise<ToolResult> {
    const filePath = path.resolve(input.file_path as string);
    const offset = ((input.offset as number) || 1) - 1; // Convert to 0-based
    const limit = (input.limit as number) || DEFAULT_LIMIT;

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const selected = lines.slice(offset, offset + limit);

      const numbered = selected
        .map((line, i) => {
          const lineNum = String(offset + i + 1).padStart(4, " ");
          return `${lineNum} | ${line}`;
        })
        .join("\n");

      let result = numbered;
      if (offset + limit < totalLines) {
        result += `\n\n[Showing lines ${offset + 1}-${offset + selected.length} of ${totalLines} total]`;
      }

      return { content: result };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error reading file: ${msg}`, isError: true };
    }
  },
};
