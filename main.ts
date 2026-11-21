// The harness runs `node /bot/main.ts`. It reads every case from /input/cases.json and writes
// /output/answers.json: one answer per case, in the cases' order. Outside the sandbox
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it.
setFlagsFromString('--no-incremental-marking');

const { answerBuffer } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  answerBuffer: (input: unknown) => Buffer;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const parts: Buffer[] = [Buffer.from('[')];
for (let i = 0; i < cases.length; i++) {
  if (i > 0) parts.push(Buffer.from(','));
  parts.push(answerBuffer(cases[i].input));
}
parts.push(Buffer.from(']'));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), Buffer.concat(parts));
