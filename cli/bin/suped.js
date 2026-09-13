#!/usr/bin/env node
import { applyWorkspaceFile } from '../lib/dotfile.js';

// Before anything reads SUPED_*: a .suped file in this directory or a parent
// names the workspace, and the rest of the CLI reads the environment at load.
try { applyWorkspaceFile(); }
catch (err) { console.error(`suped: ${err?.message ?? err}`); process.exit(1); }

const { main } = await import('../lib/cli.js');
main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`suped: ${err?.message ?? err}`);
    process.exit(1);
  },
);
