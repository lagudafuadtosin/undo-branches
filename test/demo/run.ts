// Starts a clean VS Code for the demo recording (see record.ps1).
import * as path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { runTests } from "@vscode/test-electron";

async function main() {
  const root = path.resolve(__dirname, "..");
  const dir = process.env.UNDO_BRANCHES_TMP!;
  const ws = path.join(dir, "greet-project");
  mkdirSync(ws, { recursive: true });
  const userData = path.join(root, ".vscode-test", "demo-user-data");
  mkdirSync(path.join(userData, "User"), { recursive: true });
  writeFileSync(
    path.join(userData, "User", "settings.json"),
    JSON.stringify({
      "workbench.startupEditor": "none",
      "workbench.colorTheme": "Default Dark Modern",
      "editor.fontSize": 17,
      "editor.minimap.enabled": false,
      "window.commandCenter": false,
      "workbench.layoutControl.enabled": false,
      "workbench.tips.enabled": false,
      "chat.disableAIFeatures": true,
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "update.mode": "none",
      "telemetry.telemetryLevel": "off",
      "breadcrumbs.enabled": false,
      "undoBranches.groupDelay": 800,
    }),
  );
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, ".test-build", "demo-suite.cjs"),
    extensionTestsEnv: { UNDO_BRANCHES_TMP: dir, UNDO_BRANCHES_WS: ws },
    launchArgs: [ws, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--disable-gpu", `--user-data-dir=${userData}`],
  });
}

void main();
