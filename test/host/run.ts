// Starts a real VS Code with the extension loaded and runs test/host/suite.ts
// inside it. VS Code is downloaded once into .vscode-test (git-ignored).
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { runTests } from "@vscode/test-electron";

async function main() {
  // Bundled into .test-build, so the repo is one folder up.
  const root = path.resolve(__dirname, "..");
  const dir = mkdtempSync(path.join(tmpdir(), "undo-branches-"));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, ".test-build", "host-suite.cjs"),
      extensionTestsEnv: { UNDO_BRANCHES_TMP: dir },
      launchArgs: [dir, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
    });
  } catch (err) {
    console.error("host tests failed", err);
    process.exit(1);
  }
}

void main();
