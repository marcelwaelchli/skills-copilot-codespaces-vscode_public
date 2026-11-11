// Answers a macro's questions on the terminal, for `buildwerk run` when a
// person is sitting in front of it.

import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

const YES = /^(j|ja|y|yes)$/i;

/**
 * Asks the questions of one `prompt` event and returns the reply in the shape
 * the engine expects: a boolean for a confirmation, `{ NAME: value }` for a form.
 * An empty line accepts the suggested value.
 */
export async function askOnTerminal(event, { input = process.stdin, output = process.stdout, signal, onInterrupt } = {}) {
  // Typed characters are echoed through this stream, so muting it hides passwords.
  let muted = false;
  const echo = new Writable({
    write(chunk, encoding, done) {
      if (!muted) output.write(chunk, encoding);
      done();
    },
  });
  const rl = readline.createInterface({ input, output: echo, terminal: Boolean(input.isTTY) });
  // While readline owns the terminal, Ctrl+C arrives here and not as a process signal.
  rl.on('SIGINT', () => onInterrupt?.());
  const question = async (text, hidden = false) => {
    output.write(text);
    muted = hidden;
    try {
      return (await rl.question('', { signal })).trim();
    } finally {
      muted = false;
      if (hidden) output.write('\n');
    }
  };

  try {
    if (event.kind === 'confirm') return YES.test(await question(`${event.message} (j/n) `));
    if (event.message) output.write(`${event.message}\n`);
    const values = {};
    for (const field of event.fields) {
      const choices = field.choices.length ? ` (${field.choices.join(' / ')})` : '';
      const suggestion = !field.secret && field.default ? ` [${field.default}]` : '';
      const typed = await question(`${field.label}${choices}${suggestion}: `, field.secret);
      values[field.name] = typed === '' ? field.default : typed;
    }
    return values;
  } finally {
    rl.close();
  }
}
