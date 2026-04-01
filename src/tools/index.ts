import type { Tool } from "./types.js";
import { bashTool } from "./bash.js";
import { fileReadTool } from "./fileRead.js";
import { fileEditTool } from "./fileEdit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";

export const allTools: Tool[] = [
  bashTool,
  fileReadTool,
  fileEditTool,
  globTool,
  grepTool,
];

export function findTool(name: string): Tool | undefined {
  return allTools.find((t) => t.name === name);
}
