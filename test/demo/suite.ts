// Plays the README demo inside a real VS Code while record.ps1 records the
// window. Waits for the recorder to start, then types, undoes and branches.
import * as vscode from "vscode";
import * as path from "node:path";
import { existsSync, writeFileSync } from "node:fs";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
  const dir = process.env.UNDO_BRANCHES_TMP!;
  const file = path.join(process.env.UNDO_BRANCHES_WS!, "greet.ts");
  writeFileSync(file, 'function greet(name: string) {\n  return "Hello, " + name;\n}\n');

  await vscode.extensions.getExtension("lagudafuadtosin.undo-branches")!.activate();
  const doc = await vscode.workspace.openTextDocument(file);
  let editor = await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("workbench.view.explorer");
  for (const c of ["outline.removeView", "timeline.removeView", "notifications.clearAll"]) {
    await Promise.resolve(vscode.commands.executeCommand(c)).catch(() => undefined);
  }
  await vscode.commands.executeCommand("workbench.files.action.collapseExplorerFolders");
  await vscode.commands.executeCommand("undoBranches.tree.focus");
  editor = await vscode.window.showTextDocument(doc);
  writeFileSync(path.join(dir, "ready"), "");

  await vscode.commands.executeCommand("notifications.clearAll");
  for (let i = 0; i < 300 && !existsSync(path.join(dir, "recording")); i++) await wait(100);
  await wait(1200);

  const type = async (text: string) => {
    let first = true;
    for (const ch of text) {
      await editor.edit((e) => e.insert(doc.positionAt(doc.getText().length), ch), { undoStopBefore: first, undoStopAfter: false });
      const end = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(end, end);
      first = false;
      await wait(45);
    }
  };
  const key = (k: string) => (vscode.commands.executeCommand as (c: string) => Thenable<unknown>)(k);
  const tree = (id: number) => vscode.commands.executeCommand("undoBranches.goTo", { type: "state", key: doc.uri.toString(), id });

  // Version one.
  await type('\nconsole.log(greet("world").toUpperCase());');
  await wait(1800);
  // Ctrl+Z, then type something else: in plain VS Code version one is now gone.
  await key("undo");
  await wait(1200);
  await type('\nconsole.log(greet("world").toLowerCase());');
  await wait(1800);
  // Redo cannot bring it back.
  await key("redo");
  await wait(1200);
  // The tree can.
  await tree(1);
  await wait(2500);
  await tree(2);
  await wait(1500);
  await vscode.commands.executeCommand("undoBranches.compare", { type: "state", key: doc.uri.toString(), id: 1 });
  await wait(3500);

  writeFileSync(path.join(dir, "done"), "");
  await wait(800);
}
