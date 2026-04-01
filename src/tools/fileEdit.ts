import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { Tool, ToolResult } from "./types.js";

export const fileEditTool: Tool = {
  name: "file_edit",
  description:
    "Edit a file by replacing an exact string match. You must read the file first and use the exact text as old_string. If old_string is empty and the file doesn't exist, a new file is created with new_string as content.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact text to find and replace (empty string to create new file)",
      },
      new_string: {
        type: "string",
        description: "The replacement text",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences (default: false)",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },

  async call(input): Promise<ToolResult> {
    const filePath = path.resolve(input.file_path as string);
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;

    try {
      // Create new file if old_string is empty
      if (oldString === "") {
        await writeFile(filePath, newString, "utf-8");
        return { content: `Created new file: ${filePath}` };
      }

      const content = await readFile(filePath, "utf-8");

      // Check that old_string exists
      const index = content.indexOf(oldString);
      if (index === -1) {
        return {
          content: `Error: old_string not found in ${filePath}. Make sure you copied the exact text from file_read.`,
          isError: true,
        };
      }

      // Check uniqueness if not replace_all
      if (!replaceAll) {
        const secondIndex = content.indexOf(oldString, index + 1);
        if (secondIndex !== -1) {
          return {
            content: `Error: old_string appears multiple times in ${filePath}. Use replace_all: true or provide a larger, unique string.`,
            isError: true,
          };
        }
      }

      const updated = replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);

      await writeFile(filePath, updated, "utf-8");

      const count = replaceAll
        ? content.split(oldString).length - 1
        : 1;

      return {
        content: `Edited ${filePath}: replaced ${count} occurrence(s).`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error editing file: ${msg}`, isError: true };
    }
  },
};
