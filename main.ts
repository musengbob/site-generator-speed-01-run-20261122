// Entry point for site-generator-speed-01-run-20261122.
// Reads /input/cases.json (or MAKEFUN_INPUT_DIR), answers every case with run()
// from solve.js, and writes /output/answers.json (or MAKEFUN_OUTPUT_DIR).
// run() returns each case's answer already as JSON text, so this driver only
// joins the three texts instead of re-walking a 7 MB object tree.
// Runs on Node 22 with TypeScript stripped as-is.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Keep V8's incremental marking off for the whole build, as the house baseline does.
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => string;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const texts: string[] = [];
for (const c of cases) texts.push(run(c.input));

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), '[' + texts.join(',') + ']');
