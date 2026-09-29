// Imported first by tests that must not touch the real ~/.config/penguin-stream.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.PENGUIN_STREAM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-test-home-'));
