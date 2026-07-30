// ============================================================
// Human-Paced and Structured Typing into a PTY
//
// Interactive agent CLIs redraw asynchronously and drop characters that
// arrive in one fast chunk; @inquirer-style autocomplete menus also swallow
// the first Enter. This module holds the one implementation of "type this
// text like a person would", shared by the workflow engine's Send Input
// block and the quick-send bar so their behaviour can never drift apart.
// Generated result-contract/handoff prompts explicitly opt into a bounded
// bracketed-paste path because their payloads can be tens of kilobytes.
// ============================================================

/** Delay between characters. Slow enough for a CLI event loop to keep up. */
export const CHAR_DELAY_MS = 75;

/** Pause between the menu-dismissing Enter and the submitting Enter. */
export const ENTER_GAP_MS = 150;

/** Bounded writes keep a paste responsive without one IPC call per character. */
export const STRUCTURED_PASTE_CHUNK_CHARS = 1024;
/** Let the terminal echo/redraw a closed paste before taking its checkpoint. */
export const STRUCTURED_PASTE_DRAIN_MS = CHAR_DELAY_MS;
export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

const BRACKETED_PASTE_DELIMITERS = [
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  '\x9b200~',
  '\x9b201~',
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

function structuredChunks(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + STRUCTURED_PASTE_CHUNK_CHARS);
    if (
      end < text.length
      && end > start
      && isHighSurrogate(text.charCodeAt(end - 1))
      && isLowSurrogate(text.charCodeAt(end))
    ) {
      end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
}

async function closePasteBestEffort(write, sessionId) {
  try {
    await write(sessionId, BRACKETED_PASTE_END);
  } catch (_error) {
    // Abort cleanup must not replace the stopped outcome with a send error.
  }
}

/**
 * Type `text` into a session, optionally submitting. Ordinary input is paced
 * one character at a time; structured prompts explicitly opt into bounded
 * bracketed-paste chunks.
 *
 * @param {object} opts
 * @param {string} opts.sessionId       PTY to type into
 * @param {string} opts.text            text to send (may be empty)
 * @param {boolean} [opts.pressEnter]   submit afterwards (default true)
 * @param {function} [opts.send]        (sessionId, text) => Promise<boolean>
 * @param {function} [opts.isAborted]   () => boolean, checked between keys
 * @param {function} [opts.onTyped]     async hook after text, before Enter
 * @param {number} [opts.charDelayMs]
 * @param {boolean} [opts.structured]   bounded bracketed paste for generated
 *                                      result-contract / handoff prompts only
 * @param {function} [opts.sleepFn]     injectable delay for deterministic tests
 * @returns {Promise<{ sent: boolean, aborted: boolean }>}
 * @throws when the target session refuses input (it exited, or never existed)
 */
export async function typeInto({
  sessionId,
  text = '',
  pressEnter = true,
  send,
  isAborted = () => false,
  onTyped,
  charDelayMs = CHAR_DELAY_MS,
  structured = false,
  sleepFn = sleep,
} = {}) {
  if (!sessionId) throw new Error('No active session to receive input');
  const write = send || ((id, chunk) => window.api.sendInput({ id, text: chunk }));

  if (structured) {
    if (BRACKETED_PASTE_DELIMITERS.some(delimiter => text.includes(delimiter))) {
      throw new Error('Structured prompt contains a bracketed-paste control delimiter');
    }
    if (isAborted()) return { sent: false, aborted: true };

    let pasteOpen = false;
    try {
      if (!await write(sessionId, BRACKETED_PASTE_START)) {
        throw new Error('No active process to receive input');
      }
      pasteOpen = true;

      for (const chunk of structuredChunks(text)) {
        if (isAborted()) {
          await closePasteBestEffort(write, sessionId);
          pasteOpen = false;
          return { sent: false, aborted: true };
        }
        if (!await write(sessionId, chunk)) {
          throw new Error('No active process to receive input');
        }
      }

      if (isAborted()) {
        await closePasteBestEffort(write, sessionId);
        pasteOpen = false;
        return { sent: false, aborted: true };
      }
      if (!await write(sessionId, BRACKETED_PASTE_END)) {
        pasteOpen = false;
        throw new Error('No active process to receive input');
      }
      pasteOpen = false;
      // IPC completion only means the bytes reached main. Give the PTY one
      // fixed drain window so its prompt echo/redraw lands before onTyped
      // records the output checkpoint used by a later Wait or Join.
      await sleepFn(STRUCTURED_PASTE_DRAIN_MS);
    } catch (error) {
      if (pasteOpen) await closePasteBestEffort(write, sessionId);
      throw error;
    }
  } else {
    for (const char of text) {
      if (isAborted()) return { sent: false, aborted: true };
      if (!await write(sessionId, char)) {
        throw new Error('No active process to receive input');
      }
      await sleepFn(charDelayMs);
    }
  }

  // Output-aware workflows take their activity checkpoint here: ordinary
  // prompt echo has had one character delay to drain, and a structured paste
  // has already closed its frame. No response can start before Enter below.
  if (isAborted()) return { sent: false, aborted: true };
  if (onTyped) await onTyped();

  if (!pressEnter) return { sent: true, aborted: false };
  if (isAborted()) return { sent: false, aborted: true };

  // Two Enters: the first confirms any autocomplete selection the CLI popped
  // up, the second actually submits the prompt.
  if (!await write(sessionId, '\r')) {
    throw new Error('No active process to receive Enter');
  }
  await sleepFn(ENTER_GAP_MS);
  if (isAborted()) return { sent: false, aborted: true };
  if (!await write(sessionId, '\r')) {
    throw new Error('No active process to receive Enter');
  }

  return { sent: true, aborted: false };
}
