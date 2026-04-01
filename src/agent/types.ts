import type OpenAI from "openai";

// Re-export the OpenAI message types we use
export type ChatMessage = OpenAI.ChatCompletionMessageParam;
export type AssistantMessage = OpenAI.ChatCompletionAssistantMessageParam;
export type ToolMessage = OpenAI.ChatCompletionToolMessageParam;

export type AgentEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking_start" }
  | { type: "thinking_end" }
  | { type: "tool_building" }
  | { type: "tool_start"; name: string; id: string; args: string }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { type: "turn_complete"; message: AssistantMessage }
  | { type: "error"; message: string };
