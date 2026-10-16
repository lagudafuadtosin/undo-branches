// Runs inside a real VS Code (see run.ts): real typing, the real undo and
// redo commands, and the extension's own commands.
import * as vscode from "vscode";
import * as path from "node:path";
import { writeFileSync } from "node:fs";
import type { History } from "../../src/history";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
  let failed = 0;
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `  [text: ${JSON.stringify(vscode.window.activeTextEditor?.document.getText())}]`}`);
    if (!ok) failed++;
  };

  const dir = process.env.UNDO_BRANCHES_TMP!;
  const file = path.join(dir, "notes.txt");
  writeFileSync(file, "start\n");

  try {
    const api = (await vscode.extensions.getExtension("lagudafuadtosin.undo-branches")!.activate()) as {
      history: (u: vscode.Uri) => History | undefined;
      flush: () => void;
      drop: (u: vscode.Uri) => boolean;
    };
    const doc = await vscode.workspace.openTextDocument(file);
    let editor = await vscode.window.showTextDocument(doc);
    // One character at a time with no undo stop in between, the way typing
    // reaches the document: one native undo takes the whole run back.
    const keys = async (text: string) => {
      let first = true;
      for (const ch of text) {
        await editor.edit((e) => e.insert(doc.positionAt(doc.getText().length), ch), { undoStopBefore: first, undoStopAfter: false });
        first = false;
      }
    };
    const type = async (text: string) => {
      await keys(text);
      api.flush();
    };
    const h = () => api.history(doc.uri)!;

    await type("first idea");
    check(doc.getText() === "start\nfirst idea", "typing works");
    check(h().states.size === 2, "typing one run makes one state");

    await vscode.commands.executeCommand("undo");
    await wait(100);
    check(doc.getText() === "start\n", "native undo goes back");
    check(h().current === h().root, "the tree follows the native undo to the start");

    await type("second idea");
    check(doc.getText() === "start\nsecond idea", "new typing after undo");
    check(h().get(h().root).children.length === 2, "the first idea is kept as its own branch");

    await vscode.commands.executeCommand("redo");
    await wait(100);
    check(doc.getText() === "start\nsecond idea", "native redo has nothing to bring back, as usual");

    // Back to the lost branch through the view's command.
    const lost = h().get(h().root).children[0];
    await vscode.commands.executeCommand("undoBranches.goTo", { type: "state", key: doc.uri.toString(), id: lost });
    check(doc.getText() === "start\nfirst idea", "clicking the lost state brings it back");
    check(h().current === lost, "the tree points at it");

    await vscode.commands.executeCommand("undo");
    await wait(100);
    check(doc.getText() === "start\nsecond idea", "one native undo reverses the jump");
    check(h().get(h().current).hash === h().get(h().get(h().root).children[1]).hash, "and the tree follows it");

    await vscode.commands.executeCommand("undoBranches.earlier");
    check(doc.getText() === "start\nfirst idea", "Earlier in Time steps onto the other branch");
    await vscode.commands.executeCommand("undoBranches.earlier");
    check(doc.getText() === "start\n", "Earlier again reaches the start");
    await vscode.commands.executeCommand("undoBranches.later");
    await vscode.commands.executeCommand("undoBranches.later");
    check(doc.getText() === "start\nsecond idea", "Later twice comes back to the newest");

    await vscode.commands.executeCommand("undoBranches.undo");
    check(doc.getText() === "start\n", "Back to the Parent State");
    await vscode.commands.executeCommand("undoBranches.redo");
    check(doc.getText() === "start\nsecond idea", "Forward retraces the branch last taken");

    // Compare: the left side is the old state's text.
    await vscode.commands.executeCommand("undoBranches.compare", { type: "state", key: doc.uri.toString(), id: lost });
    await wait(500);
    const left = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "undo-branches");
    check(left?.getText() === "start\nfirst idea", "Compare shows the old state next to now");
    editor = await vscode.window.showTextDocument(doc);

    // A multi-cursor edit is one event with several changes.
    const before = doc.getText();
    await editor.edit((e) => {
      e.insert(new vscode.Position(0, 0), "A");
      e.insert(new vscode.Position(1, 0), "B");
    });
    api.flush();
    const multi = h().current;
    await vscode.commands.executeCommand("undoBranches.undo");
    check(doc.getText() === before, "an edit in two places at once goes back cleanly");
    await vscode.commands.executeCommand("undoBranches.goTo", { type: "state", key: doc.uri.toString(), id: multi });
    check(doc.getText() === "Astart\nBsecond idea", "and forward again");

    // Typing pauses: two runs with a pause make two states.
    const n = h().states.size;
    await keys("x");
    await wait(1300);
    await keys("y");
    await wait(1300);
    check(h().states.size === n + 2, "a pause in typing starts a new state");

    // Saving and the file on disk are untouched by the history itself.
    await doc.save();
    check(!doc.isDirty, "saves as normal");

    // Closing and reopening the same text keeps the history.
    const size = h().states.size;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await wait(300);
    const again = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(again);
    await wait(300);
    check(api.history(again.uri)?.states.size === size, "reopening the unchanged file keeps its history");
    const saved = api.history(again.uri)!;
    check(saved.lastSave === saved.current && saved.get(saved.current).saved === true, "the saved state is marked as the last save");

    // Kept across a restart when asked: close, forget it in memory, reopen.
    await vscode.workspace.getConfiguration("undoBranches").update("persist", true, vscode.ConfigurationTarget.Global);
    editor = vscode.window.activeTextEditor!;
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), "z"));
    await again.save();
    const size2 = api.history(again.uri)!.states.size;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await wait(300);
    api.drop(again.uri);
    const third = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(third);
    await wait(300);
    check(size2 === size + 1 && api.history(third.uri)?.states.size === size2, "with persist on, the history comes back from disk");

    // A file changed while closed does not get a history that no longer fits.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await wait(300);
    api.drop(third.uri);
    writeFileSync(file, "changed outside\n");
    const fourth = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(fourth);
    await wait(300);
    // The tab closed but the document stayed loaded, so VS Code reloads it in
    // place: the outside change becomes one more state you can go back from.
    // (A file changed while VS Code was closed is refused in history.test.ts.)
    await wait(500);
    api.flush();
    const hh = api.history(fourth.uri)!;
    check(fourth.getText() === "changed outside\n" && hh.textOf(hh.parentOf()!, fourth.getText()).startsWith("zAstart"), "a change made outside VS Code becomes a state you can go back from");
    await vscode.workspace.getConfiguration("undoBranches").update("persist", undefined, vscode.ConfigurationTarget.Global);

    // Settings files are tracked too.
    await vscode.commands.executeCommand("workbench.action.openSettingsJson");
    await wait(800);
    const settings = vscode.window.activeTextEditor?.document;
    check(settings?.uri.scheme === "vscode-userdata" && api.history(settings.uri) !== undefined, "settings.json gets a history");
  } catch (err) {
    console.error(err);
    failed++;
  }
  if (failed) throw new Error(`${failed} host checks failed`);
}
