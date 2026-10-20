// Imported first by every test file that runs flow's hooks: session start writes Claude Code's user settings
// (autoCompactWindow, flow 2.4.4), so hooks spawned by tests get a throwaway config dir, never the engineer's ~/.claude.
// The dir doesn't exist, so session start leaves it alone; tests about the setting create it or pass their own.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDE_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "flow-test-claude-")), "absent");
delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
