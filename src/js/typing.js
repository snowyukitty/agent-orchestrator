// ============================================================
// Human-Paced Typing into a PTY
//
// Interactive agent CLIs redraw asynchronously and drop characters that
// arrive in one fast chunk; @inquirer-style autocomplete menus also swallow
// the first Enter. This module holds the one implementation of "type this
// text like a person would", shared by the workflow engine's Send Input
// block and the quick-send bar so their behaviour can never drift apart.
// ============================================================

/** Delay between characters. Slow enough for a CLI event loop to keep up. */
export const CHAR_DELAY_MS = 75;

/** Pause between the menu-dismissing Enter and the submitting Enter. */
export const ENTER_GAP_MS = 150;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

/**
 * Type `text` into a session one character at a time, optionally submitting.
 *
 * @param {object} opts
 * @param {string} opts.sessionId       PTY to type into
 * @param {string} opts.text            text to send (may be empty)
 * @param {boolean} [opts.pressEnter]   submit afterwards (default true)
 * @param {function} [opts.send]        (sessionId, text) => Promise<boolean>
 * @param {function} [opts.isAborted]   () => boolean, checked between keys
 * @param {number} [opts.charDelayMs]
 * @returns {Promise<{ sent: boolean, aborted: boolean }>}
 * @throws when the target session refuses input (it exited, or never existed)
 */
export async function typeInto({
  sessionId,
  text = '',
  pressEnter = true,
  send,
  isAborted = () => false,
  charDelayMs = CHAR_DELAY_MS,
} = {}) {
  if (!sessionId) throw new Error('No active session to receive input');
  const write = send || ((id, chunk) => window.api.sendInput({ id, text: chunk }));

  for (const char of text) {
    if (isAborted()) return { sent: false, aborted: true };
    if (!await write(sessionId, char)) {
      throw new Error('No active process to receive input');
    }
    await sleep(charDelayMs);
  }

  if (!pressEnter) return { sent: true, aborted: false };
  if (isAborted()) return { sent: false, aborted: true };

  // Two Enters: the first confirms any autocomplete selection the CLI popped
  // up, the second actually submits the prompt.
  if (!await write(sessionId, '\r')) {
    throw new Error('No active process to receive Enter');
  }
  await sleep(ENTER_GAP_MS);
  if (isAborted()) return { sent: false, aborted: true };
  if (!await write(sessionId, '\r')) {
    throw new Error('No active process to receive Enter');
  }

  return { sent: true, aborted: false };
}
