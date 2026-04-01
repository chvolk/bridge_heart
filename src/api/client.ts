import OpenAI from "openai";

export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";

export const SMALL_MODEL = process.env.BH_SMALL_MODEL || "qwen3:8b";
export const LARGE_MODEL = process.env.BH_LARGE_MODEL || "qwen3-coder:30b";

export function createClient(): OpenAI {
  return new OpenAI({
    baseURL: OLLAMA_BASE_URL,
    apiKey: "ollama", // Ollama ignores this but the SDK requires it
  });
}
