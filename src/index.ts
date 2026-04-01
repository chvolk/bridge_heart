import * as readline from "readline";
import chalk from "chalk";
import { agentLoop } from "./agent/loop.js";
import type { AssistantMessage, ChatMessage } from "./agent/types.js";
import { LARGE_MODEL } from "./api/client.js";

const history: ChatMessage[] = [];
const model = process.argv[2] || LARGE_MODEL;

// ── Terminal helpers ──────────────────────────────────────────────────
const write = (s: string) => process.stdout.write(s);

// ── Readline ─────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// ── Spinner ──────────────────────────────────────────────────────────
//
// Layout when spinner is active:
//
//   ... scrollable output ...
//   "  ⠙ Thinking..."          ← spinner line
//   "❯ user typing here"       ← prompt line (readline manages cursor here)
//
// renderSpinnerFrame uses save/restore cursor (\x1b7 / \x1b8) so
// readline's cursor position on the prompt line is never disturbed.
// The user can type freely while the spinner animates.

const THINK_FRAMES  = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORK_FRAMES   = ["·∙∙∙", "∙·∙∙", "∙∙·∙", "∙∙∙·", "∙∙·∙", "∙·∙∙"];
const REASON_FRAMES = ["·  ", "·· ", "···", " ··", "  ·", "   "];
const THINK_VERBS   = [
  "Thinking", "Analyzing", "Processing", "Computing", "Formulating",
  "Evaluating", "Synthesizing", "Deliberating", "Pondering", "Calculating",
];

type SpinnerMode = "thinking" | "working" | "reasoning";
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;
let spinnerLabel = "";
let spinnerMode: SpinnerMode = "thinking";
let spinnerActive = false;

const pickVerb = () => THINK_VERBS[Math.floor(Math.random() * THINK_VERBS.length)];

function buildSpinnerLine(): string {
  if (spinnerMode === "thinking") {
    return chalk.cyan(`  ${THINK_FRAMES[spinnerFrame % THINK_FRAMES.length]} `) +
           chalk.gray(spinnerLabel);
  } else if (spinnerMode === "working") {
    return chalk.yellow(`  ${WORK_FRAMES[spinnerFrame % WORK_FRAMES.length]} `) +
           chalk.yellow(spinnerLabel);
  } else {
    return chalk.dim(`  ${REASON_FRAMES[spinnerFrame % REASON_FRAMES.length]} `) +
           chalk.dim(spinnerLabel);
  }
}

// Update spinner in place. DEC save/restore (\x1b7/\x1b8) keeps
// readline's cursor exactly where it was on the prompt line.
function renderSpinnerFrame(): void {
  write(
    "\x1b7" +              // DEC save cursor
    "\x1b[A" +             // up to spinner line
    "\x1b[2K\r" +          // clear line, go to col 0
    buildSpinnerLine() +
    "\x1b8"                // DEC restore cursor
  );
}

function redrawPrompt(): void {
  const line = (rl as any).line as string || "";
  const cursor = (rl as any).cursor as number || 0;
  write("\r\x1b[2K" + chalk.cyan("❯ ") + line);
  // Move cursor to correct position (readline's cursor may not be at end)
  const diff = line.length - cursor;
  if (diff > 0) write(`\x1b[${diff}D`);
}

function startSpinner(mode: SpinnerMode, label: string): void {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  spinnerMode = mode; spinnerLabel = label; spinnerFrame = 0;
  write("\x1b[?25l");       // hide hardware cursor

  if (spinnerActive) {
    // Transition: update spinner line in place
    write(
      "\x1b7" +
      "\x1b[A\x1b[2K\r" + buildSpinnerLine() +
      "\x1b8"
    );
  } else {
    spinnerActive = true;
    // Insert spinner line above prompt:
    // 1. Clear current line (prompt), write spinner, newline, then re-draw prompt
    write("\r\x1b[2K");
    write(buildSpinnerLine() + "\n");
    redrawPrompt();
  }

  spinnerInterval = setInterval(() => { spinnerFrame++; renderSpinnerFrame(); }, 120);
}

function stopSpinner(): void {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  write("\x1b[?25h");       // show hardware cursor
  if (!spinnerActive) return;
  spinnerActive = false;

  // Remove spinner line:
  // 1. Go up to spinner line, clear it, delete it (shifts prompt up)
  // 2. Redraw prompt on its new (shifted-up) position
  write(
    "\x1b[A" +             // up to spinner line
    "\x1b[2K" +            // clear it
    "\x1b[M"               // delete line — scrolls everything below up
  );
  // Cursor is now on the line that was below spinner (the prompt line,
  // which shifted up to replace the spinner line). Redraw it clean.
  redrawPrompt();
}

process.on("exit", () => write("\x1b[?25h"));

// ── State ────────────────────────────────────────────────────────────
let isProcessing = false;
let currentAbort: AbortController | null = null;
let pendingInterrupt: string | null = null;
let streamingActive = false;

// ── Logo ─────────────────────────────────────────────────────────────
const C = chalk.cyan, W = chalk.bold.white, G = chalk.gray;
const logo = [
  "",
  C("              .o."),
  C("             / | \\"),
  C("            /  |  \\"),
  C("           /") + W("  / \\") + C("  \\"),
  C("          /") + W("  / * \\") + C("  \\"),
  C("         /") + W("  /     \\") + C("  \\"),
  C("        /") + W("  /_     _\\") + C("  \\"),
  C("       /") + W("     |   |") + C("     \\"),
  C("      /") + W("      |   |") + C("      \\"),
  C("     /") + W("       |   |") + C("       \\"),
  C("    /________") + W("|   |") + C("________\\"),
  G("    \\_____________________/"),
  "",
  chalk.bold.cyan("        Bridge Computer"),
  chalk.gray(`  Model: ${model}`),
  "",
  chalk.gray("  Type your message and press Enter. Ctrl+C to quit."),
].join("\n");

process.stdout.write("\x1b]0;Bridge Computer\x07");
console.log(logo);

function showPrompt(): void {
  write("\n" + chalk.cyan("❯ "));
}

// ── Input ────────────────────────────────────────────────────────────
rl.on("line", (rawInput: string) => {
  // readline emits 'line' after echoing \n, so cursor is one line below prompt.
  // If spinner was active, clean it up (spinner line + prompt line + \n = cursor 2 below spinner).
  if (spinnerActive) {
    if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
    write("\x1b[?25h");
    spinnerActive = false;
    // Go up 2 to spinner line, delete it
    write("\x1b[2A\x1b[2K\x1b[M");
    // Now on the prompt line (shifted up). Go down past it to where \n left us.
    write("\x1b[B");
  }

  const input = rawInput.trim();

  if (!input) {
    if (!isProcessing) showPrompt();
    return;
  }

  if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
    console.log(chalk.gray("\nGoodbye.\n"));
    process.exit(0);
  }

  if (isProcessing) {
    pendingInterrupt = input;
    currentAbort?.abort();
    write(chalk.dim("\n  ↩ Added to task — restarting...\n"));
  } else {
    void handleInput(input);
  }
});

showPrompt();

// ── Agent loop ───────────────────────────────────────────────────────
async function handleInput(userMessage: string): Promise<void> {
  isProcessing = true;
  currentAbort = new AbortController();
  const { signal } = currentAbort;

  let receivedFirstToken = false;
  let partialAssistantText = "";
  let completedMessage: AssistantMessage | null = null;

  write("\n");
  startSpinner("thinking", pickVerb() + "...");

  try {
    for await (const event of agentLoop(userMessage, history, model, signal)) {
      switch (event.type) {
        case "thinking_start":
          if (streamingActive) { streamingActive = false; write("\n"); }
          startSpinner("reasoning", "Reasoning...");
          break;

        case "thinking_end":
          startSpinner("thinking", pickVerb() + "...");
          break;

        case "tool_building":
          if (streamingActive) { streamingActive = false; write("\n"); }
          if (!spinnerActive) {
            startSpinner("thinking", pickVerb() + "...");
          }
          break;

        case "text_delta":
          if (!receivedFirstToken) {
            receivedFirstToken = true;
            stopSpinner();
            // Clear prompt line to start streaming text there
            write("\r\x1b[2K");
            streamingActive = true;
          }
          partialAssistantText += event.content;
          write(event.content);
          break;

        case "tool_start":
          if (streamingActive) { streamingActive = false; write("\n"); }
          stopSpinner();
          receivedFirstToken = true;
          write(
            chalk.yellow(`  ▶ ${event.name}`) +
            chalk.gray(`(${truncateArgs(event.args, 80)})`) +
            "\n",
          );
          startSpinner("working", `${event.name}...`);
          break;

        case "tool_result":
          stopSpinner();
          write(
            event.isError
              ? chalk.red("  ✗ Error: ") + chalk.gray(truncateOutput(event.content, 200)) + "\n"
              : chalk.green("  ✓ ") + chalk.gray(truncateOutput(event.content, 200)) + "\n",
          );
          startSpinner("thinking", pickVerb() + "...");
          receivedFirstToken = false;
          break;

        case "turn_complete":
          if (streamingActive) { streamingActive = false; write("\n"); }
          stopSpinner();
          completedMessage = event.message;
          break;

        case "error":
          if (streamingActive) { streamingActive = false; write("\n"); }
          stopSpinner();
          if (!signal.aborted) write(chalk.red(`\nError: ${event.message}\n`));
          break;
      }
    }
  } catch (err: unknown) {
    if (streamingActive) { streamingActive = false; write("\n"); }
    stopSpinner();
    if (!signal.aborted) {
      write(chalk.red(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`));
    }
  }

  if (streamingActive) { streamingActive = false; write("\n"); }
  stopSpinner(); // safety

  if (signal.aborted && pendingInterrupt) {
    history.push({ role: "user", content: userMessage });
    if (partialAssistantText) history.push({ role: "assistant", content: partialAssistantText });
    const interrupt = pendingInterrupt;
    pendingInterrupt = null;
    isProcessing = false;
    currentAbort = null;
    await handleInput(interrupt);
    return;
  }

  if (completedMessage) {
    history.push({ role: "user", content: userMessage });
    if (completedMessage.content) history.push(completedMessage);
  }

  isProcessing = false;
  currentAbort = null;
  showPrompt();
}

// ── Helpers ──────────────────────────────────────────────────────────
const truncateArgs   = (s: string, n: number) => s.length <= n ? s : s.slice(0, n) + "...";
const truncateOutput = (s: string, n: number) => {
  const l = (s.split("\n")[0] ?? s);
  return l.length <= n ? l : l.slice(0, n) + "...";
};
