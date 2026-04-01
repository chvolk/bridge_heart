import type OpenAI from "openai";
import { createClient } from "../api/client.js";
import { getSystemPrompt } from "../prompt/system.js";
import { allTools, findTool } from "../tools/index.js";
import { toolToFunction } from "../tools/types.js";
import type { AgentEvent, ChatMessage } from "./types.js";

const MAX_TOOL_TURNS = 25;

// Strip <think>...</think> blocks from qwen3 output
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trimStart();
}

export async function* agentLoop(
  userMessage: string,
  history: ChatMessage[],
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const client = createClient();
  const tools = allTools.map(toolToFunction);
  const systemPrompt = getSystemPrompt(process.cwd());

  // Build messages: system + history + new user message
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  let toolTurns = 0;

  while (toolTurns < MAX_TOOL_TURNS) {
    // Call the model with streaming
    let assistantContent = "";
    let displayContent = "";
    let insideThinking = false;
    const toolCalls: Map<
      number,
      { id: string; name: string; arguments: string }
    > = new Map();
    let finishReason: string | null = null;

    try {
      const stream = await client.chat.completions.create(
        { model, messages, tools, stream: true },
        { signal },
      );

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        // Accumulate text content, filtering out <think> blocks
        if (choice.delta?.content) {
          assistantContent += choice.delta.content;

          // Track thinking blocks for display filtering
          const chunk = choice.delta.content;
          const wasThinking = insideThinking;
          if (chunk.includes("<think>")) insideThinking = true;
          if (insideThinking && !wasThinking) {
            yield { type: "thinking_start" };
          }
          if (!insideThinking) {
            yield { type: "text_delta", content: chunk };
            displayContent += chunk;
          }
          if (chunk.includes("</think>")) {
            insideThinking = false;
            yield { type: "thinking_end" };
          }
        }

        // Accumulate tool calls (they arrive incrementally)
        if (choice.delta?.tool_calls) {
          if (toolCalls.size === 0 && choice.delta.tool_calls.length > 0) {
            yield { type: "tool_building" };
          }
          for (const tc of choice.delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              // Append to existing tool call's arguments
              if (tc.function?.arguments) {
                existing.arguments += tc.function.arguments;
              }
            } else {
              // New tool call
              toolCalls.set(tc.index, {
                id: tc.id || `call_${Date.now()}_${tc.index}`,
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              });
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `API error: ${msg}` };
      return;
    }

    // Build the assistant message to add to history (strip thinking from context)
    const cleanContent = stripThinking(assistantContent);
    const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: cleanContent || null,
    };

    if (toolCalls.size > 0) {
      assistantMsg.tool_calls = Array.from(toolCalls.values()).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }

    messages.push(assistantMsg);

    // If no tool calls, we're done
    if (toolCalls.size === 0 || finishReason === "stop") {
      yield { type: "turn_complete", message: assistantMsg };
      return;
    }

    // Execute tool calls
    toolTurns++;

    for (const tc of toolCalls.values()) {
      const tool = findTool(tc.name);

      if (!tool) {
        const errorResult = `Error: Unknown tool "${tc.name}"`;
        yield {
          type: "tool_result",
          id: tc.id,
          name: tc.name,
          content: errorResult,
          isError: true,
        };
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: errorResult,
        });
        continue;
      }

      // Parse arguments
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.arguments || "{}");
      } catch {
        const errorResult = `Error: Invalid JSON in tool arguments: ${tc.arguments}`;
        yield {
          type: "tool_result",
          id: tc.id,
          name: tc.name,
          content: errorResult,
          isError: true,
        };
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: errorResult,
        });
        continue;
      }

      yield { type: "tool_start", name: tc.name, id: tc.id, args: tc.arguments };

      // Execute the tool
      const result = await tool.call(args);

      yield {
        type: "tool_result",
        id: tc.id,
        name: tc.name,
        content: result.content,
        isError: result.isError || false,
      };

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content,
      });
    }

    // Loop continues — model will process tool results
  }

  yield {
    type: "error",
    message: `Reached maximum tool turns (${MAX_TOOL_TURNS})`,
  };
}

// Returns the updated history (without system prompt) after a complete turn
export function extractHistory(
  messages: ChatMessage[],
): ChatMessage[] {
  // Skip the system message at index 0
  return messages.filter((m) => m.role !== "system");
}
