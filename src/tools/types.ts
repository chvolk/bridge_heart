import type OpenAI from "openai";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  call(input: Record<string, unknown>): Promise<ToolResult>;
}

export function toolToFunction(tool: Tool): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
