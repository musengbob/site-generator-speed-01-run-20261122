// Entry point for site-generator-speed-01-run-20261122.
// Reads /input/cases.json (or MAKEFUN_INPUT_DIR), answers every case with run()
// from solve.js, and writes /output/answers.json (or MAKEFUN_OUTPUT_DIR).
// Runs on Node 22 with TypeScript stripped as-is.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Keep V8's incremental marking off for the whole build, as the house baseline does.
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  answers[i] = run(cases[i].input);
  // Release the case's input once answered: only the answers are kept, so
  // the collector reclaims each input while the output grows.
  cases[i] = undefined as unknown as (typeof cases)[number];
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
