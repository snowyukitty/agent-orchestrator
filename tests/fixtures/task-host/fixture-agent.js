// Scripted stand-in for a provider in task-host tests. It never contacts a
// network or a real account: it reads the pointer prompt like a provider
// would, edits its working directory, prints a result frame, and sends the
// same authenticated turn-complete receipt the Codex notify helper sends.
//
// Usage: fixture-agent.js --scenario <name> "<pointer prompt>"

const fs = require('fs');
const net = require('net');
const { createHash } = require('crypto');

const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex > 0 ? process.argv[scenarioIndex + 1] : 'complete';
const pointer = process.argv[process.argv.length - 1];
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const out = text => process.stdout.write(text.replace(/\n/g, '\r\n'));

function readTask() {
  const match = /in the file (.+?) \. Read that file/.exec(pointer);
  if (!match) throw new Error('no task file in the initial prompt');
  const prompt = fs.readFileSync(match[1], 'utf8');
  return {
    nonce: /"nonce":"([0-9a-f]{32})"/.exec(prompt)?.[1],
    begin: /^(AO-TASK-RESULT-BEGIN-[0-9a-f]+)$/m.exec(prompt)?.[1],
    end: /^(AO-TASK-RESULT-END-[0-9a-f]+)$/m.exec(prompt)?.[1],
    resultFile: /but writable\): (.+)$/m.exec(prompt)?.[1]?.trim() || null,
  };
}

function sendReceipt(turn, { thread = 'fixture-thread', input = pointer } = {}) {
  return new Promise((resolve) => {
    const pipe = process.env.AGENT_ORCHESTRATOR_NOTIFY_SECRET_PIPE;
    const token = process.env.AGENT_ORCHESTRATOR_NOTIFY_SECRET_TOKEN;
    const incarnationId = process.env.AGENT_ORCHESTRATOR_NOTIFY_SECRET_INCARNATION;
    if (!pipe || !token || !incarnationId) { resolve(false); return; }
    const socket = net.connect(`\\\\.\\pipe\\${pipe}`, () => {
      socket.end(`${JSON.stringify({
        token,
        incarnationId,
        type: 'agent-turn-complete',
        threadDigest: sha256(thread),
        turnDigest: sha256(`fixture-turn-${turn}`),
        inputDigests: [sha256(input.trim())],
      })}\n`);
    });
    socket.on('close', () => resolve(true));
    socket.on('error', () => resolve(false));
  });
}

function printFrame(task, { nonce = task.nonce, claims = [{ name: 'test', outcome: 'passed' }] } = {}) {
  const body = JSON.stringify({ nonce, summary: `fixture scenario ${scenario} finished`, checks: claims });
  if (task.resultFile) {
    // File channel: report into the outbox the prompt names.
    fs.writeFileSync(task.resultFile, body);
    out('fixture agent wrote its report\n');
    return;
  }
  out(`${task.begin}\n`);
  out(`${body}\n`);
  out(`${task.end}\n`);
}

function doWork() {
  fs.writeFileSync('fixture-output.txt', 'done\n');
  fs.appendFileSync('README.md', 'Edited by the fixture agent.\n');
  fs.writeFileSync('blob.bin', Buffer.from([...Array(256).keys()]));
}

function idle() {
  out('fixture> ');
  process.stdin.on('data', chunk => out(chunk.toString()));
  process.stdin.resume();
}

async function main() {
  out('\x1b[?2004h');
  out(`fixture agent (${scenario}) starting\n`);
  const task = readTask();
  switch (scenario) {
    case 'complete':
      doWork();
      printFrame(task);
      await sendReceipt(1);
      return idle();
    case 'side-thread':
      // A background turn in the same process completes first; it must not
      // complete the task or capture the registration's thread.
      await sendReceipt(0, { thread: 'background-thread', input: 'summarize this session' });
      await new Promise(resolve => setTimeout(resolve, 1_000));
      doWork();
      printFrame(task);
      await sendReceipt(1);
      return idle();
    case 'claim-false':
      // Claims the check passed without producing what the check requires.
      printFrame(task);
      await sendReceipt(1);
      return idle();
    case 'wrong-nonce':
      doWork();
      printFrame(task, { nonce: '0'.repeat(32) });
      await sendReceipt(1);
      return idle();
    case 'no-receipt':
      doWork();
      printFrame(task);
      return idle();
    case 'partial':
      // Starts the frame, then dies mid-report without a receipt.
      doWork();
      process.stdout.write(`${task.begin}\r\n{"nonce":"${task.nonce}","summary":"cut o`, () => process.exit(0));
      return undefined;
    case 'exit-nonzero':
      out('fixture agent gives up\n');
      process.exit(3);
      return undefined;
    case 'ask':
      out('Proceed? type y and press Enter\n');
      process.stdin.resume();
      process.stdin.on('data', async function onData(chunk) {
        if (!chunk.toString().includes('y')) return;
        process.stdin.removeListener('data', onData);
        doWork();
        printFrame(task);
        await sendReceipt(1);
        idle();
      });
      return undefined;
    default:
      out(`unknown scenario ${scenario}\n`);
      process.exit(2);
      return undefined;
  }
}

main().catch((error) => {
  out(`fixture agent failed: ${error.message}\n`);
  process.exit(1);
});
