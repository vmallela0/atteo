// Where the browser checks write screenshots and scratch files: $SHOTS_DIR, else a folder in the OS temp dir. Never the repo.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const SHOTS_DIR = process.env.SHOTS_DIR || join(tmpdir(), "atteo-browser-shots");
mkdirSync(SHOTS_DIR, { recursive: true });
