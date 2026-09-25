// Imported first by every test file: points HOME (and the Windows-style
// folders the tools use) at a throwaway directory *before* any tool module
// loads, so tests never read or write the real ~/.ultron or workspace.
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "ultron-test-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = path.join(TEST_HOME, "AppData", "Local");
process.env.TMPDIR = path.join(TEST_HOME, "tmp");
process.env.TEMP = process.env.TMPDIR;
process.env.TMP = process.env.TMPDIR;
mkdirSync(process.env.TMPDIR, { recursive: true });
process.env.ULTRON_SESSION_SECRET = "test-secret";
