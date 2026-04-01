import * as readline from "readline";
import chalk from "chalk";
import { agentLoop } from "./agent/loop.js";
import type { AssistantMessage, ChatMessage } from "./agent/types.js";
import { LARGE_MODEL } from "./api/client.js";

const history: ChatMessage[] = [];
const model = process.argv[2] || LARGE_MODEL;

// ── Terminal helpers ──────────────────────────────────────────────────
const write = (s: string) => process.stdout.write(s);

// ── Layout ───────────────────────────────────────────────────────────
//
// Normal scrolling terminal. The bottom two visible lines are:
//
//   [spinner line]   ← only present when spinner is active
//   ❯ user input     ← always the very last line
//
// Before writing output we erase those bottom lines, write the output,
// then redraw them. This keeps the prompt right below the output and
// allows typing at all times.

const PROMPT = "\x1b[38;5;75m❯\x1b[0m "; // fixed-color ❯

let spinnerShown = false;

// ── Readline ─────────────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

// Suppress readline's own rendering — we draw the prompt ourselves.
(rl as any).output = null;

// Redraw prompt on every keypress so typed characters appear immediately.
process.stdin.on("data", () => {
  setImmediate(() => drawPrompt());
});

function drawPrompt(): void {
  const line: string = (rl as any).line ?? "";
  const cursor: number = (rl as any).cursor ?? 0;
  write("\r\x1b[2K" + PROMPT + line);
  const back = line.length - cursor;
  if (back > 0) write(`\x1b[${back}D`);
}

// ── Bottom-line management ───────────────────────────────────────────
//
// eraseBottom / redrawBottom are called around every write to the output
// area so that the spinner + prompt never get mixed into scrollback.

function eraseBottom(): void {
  // We're on the prompt line. Clear it.
  write("\r\x1b[2K");
  if (spinnerShown) {
    // Move up to spinner line, clear it, come back down.
    write("\x1b[A\r\x1b[2K");
    // Cursor is now on the (cleared) spinner line.
    // Don't move down — the next write will start here, which is correct
    // because we're about to write output that replaces this line.
  }
}

function redrawBottom(): void {
  // After output was written the cursor is at the end of output.
  // Draw spinner (if active) then prompt, each on its own line.
  if (spinnerShown) {
    write("\n" + buildSpinnerText());
  }
  write("\n");
  drawPrompt();
}

/** Write text into the output area (above spinner + prompt). */
function outputWrite(s: string): void {
  eraseBottom();
  write(s);
  redrawBottom();
}

/** Write a complete line into the output area. */
function outputLine(s: string): void {
  eraseBottom();
  write(s + "\n");
  redrawBottom();
}

// ── Spinner ──────────────────────────────────────────────────────────

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

const pickVerb = () => THINK_VERBS[Math.floor(Math.random() * THINK_VERBS.length)];

function buildSpinnerText(): string {
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

/** Animate the spinner in-place without touching the output area. */
function tickSpinner(): void {
  spinnerFrame++;
  // Save cursor (on prompt line), go up to spinner line, redraw it, restore.
  write("\x1b7");
  write("\x1b[A\r\x1b[2K" + buildSpinnerText());
  write("\x1b8");
}

function startSpinner(mode: SpinnerMode, label: string): void {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  spinnerMode = mode; spinnerLabel = label; spinnerFrame = 0;

  if (!spinnerShown) {
    spinnerShown = true;
    // Insert spinner line between output and prompt:
    // clear prompt, write spinner + newline, redraw prompt.
    write("\r\x1b[2K");
    write(buildSpinnerText() + "\n");
    drawPrompt();
  } else {
    // Already showing — just update the spinner line in place.
    write("\x1b7");
    write("\x1b[A\r\x1b[2K" + buildSpinnerText());
    write("\x1b8");
  }

  spinnerInterval = setInterval(tickSpinner, 120);
}

function stopSpinner(): void {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  if (!spinnerShown) return;
  spinnerShown = false;

  // Remove the spinner line: go up from prompt, clear, delete line,
  // then redraw prompt (which shifted up by one).
  write("\x1b[A\r\x1b[2K\x1b[M");
  drawPrompt();
}

// ── State ────────────────────────────────────────────────────────────
let isProcessing = false;
let currentAbort: AbortController | null = null;
let pendingInterrupt: string | null = null;
let streamingActive = false;
// Tracks whether \x1b7 holds a saved output-cursor position.
let streamHasSavedPos = false;

// ── Streaming helpers ────────────────────────────────────────────────
//
// During streaming we keep the prompt visible below the output at all
// times.  After each chunk we:
//   1. Save the output cursor position (\x1b7)
//   2. Draw the prompt on the next line
// On the next chunk we:
//   1. Restore to the saved output position (\x1b8)
//   2. Clear everything below it (\x1b[J) — wipes the temp prompt
//   3. Write the new chunk, then repeat.

function streamStart(): void {
  streamingActive = true;
  streamHasSavedPos = false;
}

function streamEnd(): void {
  if (!streamingActive) return;
  streamingActive = false;
  streamHasSavedPos = false;
  // Prompt is already drawn from the last streamWrite call.
}

/** Write a chunk during streaming, keeping the prompt visible below. */
function streamWrite(s: string): void {
  if (streamHasSavedPos) {
    // Return to where we left off in the output.
    write("\x1b8");      // restore output cursor
    write("\x1b[J");     // clear from here to end of screen (wipes temp prompt)
  } else {
    // First chunk — cursor is on the prompt line.
    write("\r\x1b[2K");  // clear prompt line so output starts here
    streamHasSavedPos = true;
  }

  write(s);              // write the output chunk
  write("\x1b7");        // save output cursor position
  write("\n");           // move below output
  drawPrompt();          // show prompt — cursor lands here
}

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

// ── Boot ─────────────────────────────────────────────────────────────
process.stdout.write("\x1b]0;Bridge Computer\x07");
console.log(logo);
write("\n");
drawPrompt();

process.on("exit", () => write("\x1b[?25h\n"));

// ── Input ────────────────────────────────────────────────────────────
rl.on("line", (rawInput: string) => {
  // readline already printed a newline. If spinner was showing, we now
  // have: output / spinner / (old prompt — now blank) / cursor.
  // Clean up: go back and remove the spinner line if present.
  if (spinnerShown) {
    if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
    spinnerShown = false;
    // Cursor is one line below old prompt (readline's \n).
    // Go up 2 (past blank prompt line, to spinner), clear + delete it.
    write("\x1b[2A\x1b[2K\x1b[M");
    // Now on old prompt line (shifted up). Go down 1 to where \n left us.
    write("\x1b[B");
  }

  const input = rawInput.trim();

  if (!input) {
    drawPrompt();
    return;
  }

  if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
    console.log(chalk.gray("\nGoodbye.\n"));
    process.exit(0);
  }

  if (isProcessing) {
    pendingInterrupt = input;
    currentAbort?.abort();
    write(chalk.dim("  ↩ Added to task — restarting...\n"));
    drawPrompt();
  } else {
    void handleInput(input);
  }
});

// ── Agent loop ───────────────────────────────────────────────────────
async function handleInput(userMessage: string): Promise<void> {
  isProcessing = true;
  currentAbort = new AbortController();
  const { signal } = currentAbort;

  let receivedFirstToken = false;
  let partialAssistantText = "";
  let completedMessage: AssistantMessage | null = null;

  startSpinner("thinking", pickVerb() + "...");

  try {
    for await (const event of agentLoop(userMessage, history, model, signal)) {
      switch (event.type) {
        case "thinking_start":
          streamEnd();
          startSpinner("reasoning", "Reasoning...");
          break;

        case "thinking_end":
          startSpinner("thinking", pickVerb() + "...");
          break;

        case "tool_building":
          streamEnd();
          if (!spinnerInterval) {
            startSpinner("thinking", pickVerb() + "...");
          }
          break;

        case "text_delta":
          if (!receivedFirstToken) {
            receivedFirstToken = true;
            stopSpinner();
            streamStart();
          }
          partialAssistantText += event.content;
          streamWrite(event.content);
          break;

        case "tool_start":
          streamEnd();
          stopSpinner();
          receivedFirstToken = true;
          outputLine(
            chalk.yellow(`  ▶ ${event.name}`) +
            chalk.gray(`(${truncateArgs(event.args, 80)})`),
          );
          startSpinner("working", `${event.name}...`);
          break;

        case "tool_result":
          stopSpinner();
          outputLine(
            event.isError
              ? chalk.red("  ✗ Error: ") + chalk.gray(truncateOutput(event.content, 200))
              : chalk.green("  ✓ ") + chalk.gray(truncateOutput(event.content, 200)),
          );
          startSpinner("thinking", pickVerb() + "...");
          receivedFirstToken = false;
          break;

        case "turn_complete":
          streamEnd();
          stopSpinner();
          completedMessage = event.message;
          break;

        case "error":
          streamEnd();
          stopSpinner();
          if (!signal.aborted) {
            write(chalk.red(`\nError: ${event.message}\n`));
          }
          break;
      }
    }
  } catch (err: unknown) {
    streamEnd();
    stopSpinner();
    if (!signal.aborted) {
      write(chalk.red(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`));
    }
  }

  streamEnd();
  stopSpinner();

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
  write("\n");
  drawPrompt();
}

// ── Helpers ──────────────────────────────────────────────────────────
const truncateArgs   = (s: string, n: number) => s.length <= n ? s : s.slice(0, n) + "...";
const truncateOutput = (s: string, n: number) => {
  const l = (s.split("\n")[0] ?? s);
  return l.length <= n ? l : l.slice(0, n) + "...";
};
