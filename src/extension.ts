import * as vscode from "vscode";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { History, fromChanges, snippet, type Kind, type Saved, type State } from "./history";

const SCHEME = "undo-branches";
const hash = (t: string) => createHash("sha1").update(t).digest("base64");

interface Tracked {
  history: History;
  text?: string; // the document text now; undefined while the file is closed
  timer?: ReturnType<typeof setTimeout>;
}

const files = new Map<string, Tracked>();
let applying: string | undefined;
let storeDir = "";

// Local files, remote files (SSH, WSL, containers), settings files, notebook
// cells and files opened from a remote repository.
const SCHEMES = new Set(["file", "untitled", "vscode-remote", "vscode-userdata", "vscode-notebook-cell", "vscode-vfs"]);

function config() {
  const c = vscode.workspace.getConfiguration("undoBranches");
  return {
    groupDelay: c.get<number>("groupDelay", 1000),
    maxStates: c.get<number>("maxStates", 1000),
    maxFileSize: c.get<number>("maxFileSize", 5_000_000),
    persist: c.get<boolean>("persist", false),
  };
}

function trackable(doc: vscode.TextDocument): boolean {
  return SCHEMES.has(doc.uri.scheme) && doc.getText().length <= config().maxFileSize;
}

// ---- History kept across restarts (off by default, like Vim's undofile) ----

function storePath(key: string): string {
  return path.join(storeDir, createHash("sha1").update(key).digest("hex") + ".json");
}

function load(key: string, text: string): History | undefined {
  if (!config().persist || !storeDir || key.startsWith("untitled:")) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(storePath(key), "utf8")) as Saved & { key: string };
    if (data.key !== key) return undefined;
    return History.fromJSON(data, text, hash, config().maxStates);
  } catch {
    return undefined;
  }
}

function store(key: string, t: Tracked): void {
  if (!config().persist || !storeDir || key.startsWith("untitled:") || t.history.states.size < 2) return;
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(storePath(key), JSON.stringify({ key, ...t.history.toJSON() }));
  } catch {
    // Not being able to keep the history must never get in the way of editing.
  }
}

function unstore(key: string): void {
  try {
    fs.rmSync(storePath(key), { force: true });
  } catch {
    // nothing to remove
  }
}

function open(doc: vscode.TextDocument): Tracked | undefined {
  const key = doc.uri.toString();
  const known = files.get(key);
  if (!trackable(doc)) {
    files.delete(key);
    return undefined;
  }
  const text = doc.getText();
  if (known) {
    if (known.text !== undefined) return known;
    // Reopened: keep the history only if the file is still where it was left.
    if (known.history.get(known.history.current).hash === hash(text)) {
      known.text = text;
      return known;
    }
  }
  const t: Tracked = { history: load(key, text) ?? new History(text, hash, config().maxStates), text };
  files.set(key, t);
  return t;
}

function commit(t: Tracked, kind: Kind = "edit"): State | undefined {
  if (t.timer) clearTimeout(t.timer);
  t.timer = undefined;
  if (t.text === undefined) return undefined;
  t.history.maxStates = config().maxStates;
  return t.history.commit(t.text, kind);
}

function onChange(e: vscode.TextDocumentChangeEvent, view: View): void {
  if (!e.contentChanges.length) return;
  const key = e.document.uri.toString();
  const t = files.get(key);
  if (!t || t.text === undefined) {
    open(e.document);
    return void view.refresh(key);
  }
  const now = e.document.getText();
  if (now.length > config().maxFileSize) {
    files.delete(key);
    return void view.refresh(key);
  }
  const before = t.text;
  const ops = fromChanges(before, e.contentChanges);
  t.text = now;
  if (applying === key) return;

  // TextDocumentChangeReason: 1 is Undo, 2 is Redo.
  const reason = (e as { reason?: number }).reason;
  if (reason === 1 || reason === 2) {
    // Close what was being typed first, then follow the native undo or redo
    // to the state it landed on, or keep it as a state of its own.
    t.text = before;
    commit(t);
    t.text = now;
    if (!t.history.follow(now)) {
      t.history.record(ops);
      commit(t, reason === 1 ? "undo" : "redo");
    }
    return void view.refresh(key);
  }

  t.history.record(ops);
  if (t.timer) clearTimeout(t.timer);
  t.timer = setTimeout(() => {
    if (commit(t)) view.refresh(key);
  }, config().groupDelay);
}

async function goTo(uri: vscode.Uri, id: number, view: View): Promise<boolean> {
  const key = uri.toString();
  const t = files.get(key);
  if (!t || t.text === undefined || !t.history.states.has(id)) return false;
  commit(t);
  if (id === t.history.current) return true;
  const doc = await vscode.workspace.openTextDocument(uri);
  const from = t.text;
  const to = t.history.textOf(id, from);

  // One replace covering only what differs, so a native undo reverses the
  // whole jump in one step.
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let end = 0;
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(from.length - end)), to.slice(start, to.length - end));

  applying = key;
  try {
    if (!(await vscode.workspace.applyEdit(edit))) return false;
  } finally {
    applying = undefined;
  }
  t.text = doc.getText();
  t.history.moveTo(id);
  view.refresh(key);

  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
  if (editor) {
    const at = doc.positionAt(start);
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  return true;
}

// ---- The view ----

export type Item = { type: "state" | "branch"; key: string; id: number };

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}


class View implements vscode.TreeDataProvider<Item> {
  private emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer?: ReturnType<typeof setTimeout>;

  activeKey(): string | undefined {
    return vscode.window.activeTextEditor?.document.uri.toString();
  }

  refresh(key?: string): void {
    if (key && key !== this.activeKey()) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emitter.fire(undefined);
    }, 100);
  }

  getChildren(el?: Item): Item[] {
    const key = el?.key ?? this.activeKey();
    const t = key ? files.get(key) : undefined;
    if (!key || !t || t.text === undefined) return [];
    const h = t.history;
    if (!el) return h.line(h.root).map((id) => ({ type: "state", key, id }));
    if (el.type === "branch") return h.line(el.id).map((id) => ({ type: "state", key, id }));
    const main = h.line(el.id)[1];
    return h.get(el.id).children.filter((c) => c !== main).map((id) => ({ type: "branch", key, id }));
  }

  getTreeItem(el: Item): vscode.TreeItem {
    const h = files.get(el.key)!.history;
    const s = h.get(el.id);
    const onPath = new Set<number>();
    for (let i = h.current; i >= 0; i = h.get(i).parent) onPath.add(i);

    if (el.type === "branch") {
      const line = h.line(el.id);
      const item = new vscode.TreeItem(`Branch, ${line.length} ${line.length === 1 ? "state" : "states"}`, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `b:${el.key}:${el.id}`;
      item.iconPath = new vscode.ThemeIcon("git-branch");
      item.description = ago(h.get(line[line.length - 1]).time);
      return item;
    }

    // Forks start open, so the versions plain undo would have lost are in view.
    const forks = s.children.length - 1;
    const item = new vscode.TreeItem(
      s.kind === "start" ? "Start" : `#${s.seq}  +${s.added} −${s.removed}`,
      forks > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    const current = s.id === h.current;
    // The id changes when a fork appears, so VS Code opens it instead of
    // keeping the closed state it had as a plain row.
    item.id = `s:${el.key}:${el.id}:${s.children.length}`;
    item.description = [
      current ? "current" : ago(s.time),
      s.id === h.lastSave ? "last save" : s.saved ? "saved" : "",
      s.id === h.childOf() ? "next redo" : "",
      s.kind === "undo" || s.kind === "redo" ? s.kind : "",
      snippet(s),
    ].filter(Boolean).join("  ");
    item.iconPath = new vscode.ThemeIcon(current ? "circle-filled" : onPath.has(s.id) ? "circle-outline" : "circle-small");
    item.tooltip = [
      new Date(s.time).toLocaleString(),
      s.kind === "start" ? "When this file was first seen" : `${s.added} characters added, ${s.removed} removed`,
      s.saved ? (s.id === h.lastSave ? "The last version you saved" : "A version you saved") : "",
      forks > 0 ? `${forks} other ${forks === 1 ? "branch" : "branches"} from here` : "",
    ].filter(Boolean).join("\n");
    item.contextValue = current ? "current" : "state";
    item.command = { command: "undoBranches.goTo", title: "Go to this state", arguments: [el] };
    return item;
  }
}

// ---- Compare ----

class StateText implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const q = new URLSearchParams(uri.query);
    const t = files.get(q.get("doc") ?? "");
    const id = Number(q.get("state"));
    if (!t || t.text === undefined || !t.history.states.has(id)) return "";
    commit(t);
    return t.history.textOf(id, t.text);
  }
}

export function activate(context: vscode.ExtensionContext) {
  storeDir = path.join(context.globalStorageUri.fsPath, "histories");
  const view = new View();
  const tree = vscode.window.createTreeView("undoBranches.tree", { treeDataProvider: view, showCollapseAll: true });

  for (const doc of vscode.workspace.textDocuments) open(doc);

  const active = (): { uri: vscode.Uri; t: Tracked } | undefined => {
    const doc = vscode.window.activeTextEditor?.document;
    const t = doc && (files.get(doc.uri.toString()) ?? open(doc));
    return doc && t ? { uri: doc.uri, t } : undefined;
  };

  const step = (pick: (t: Tracked) => number | undefined) => async () => {
    const a = active();
    if (!a) return;
    commit(a.t);
    const id = pick(a.t);
    if (id === undefined) return void vscode.window.setStatusBarMessage("Undo Branches: nothing further that way", 2000);
    await goTo(a.uri, id, view);
  };

  context.subscriptions.push(
    tree,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new StateText()),
    vscode.workspace.onDidOpenTextDocument((d) => open(d)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      const t = files.get(d.uri.toString());
      if (!t) return;
      commit(t);
      store(d.uri.toString(), t);
      t.text = undefined;
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      const t = files.get(d.uri.toString());
      if (!t) return;
      commit(t);
      t.history.markSaved();
      store(d.uri.toString(), t);
      view.refresh(d.uri.toString());
    }),
    vscode.workspace.onDidChangeTextDocument((e) => onChange(e, view)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      for (const t of files.values()) commit(t);
      if (ed) open(ed.document);
      view.refresh();
    }),
    vscode.commands.registerCommand("undoBranches.goTo", async (el?: Item) => {
      if (el) await goTo(vscode.Uri.parse(el.key), el.id, view);
    }),
    vscode.commands.registerCommand("undoBranches.compare", async (el?: Item) => {
      const t = el && files.get(el.key);
      if (!el || !t) return;
      commit(t);
      const uri = vscode.Uri.parse(el.key);
      const s = t.history.get(el.id);
      const left = vscode.Uri.from({ scheme: SCHEME, path: uri.path, query: new URLSearchParams({ doc: el.key, state: String(el.id), at: String(Date.now()) }).toString() });
      await vscode.commands.executeCommand("vscode.diff", left, uri, `${uri.path.split("/").pop()} (${s.kind === "start" ? "start" : `#${s.seq}`}) ↔ now`);
    }),
    vscode.commands.registerCommand("undoBranches.undo", step((t) => t.history.parentOf())),
    vscode.commands.registerCommand("undoBranches.redo", step((t) => t.history.childOf())),
    vscode.commands.registerCommand("undoBranches.earlier", step((t) => t.history.earlier())),
    vscode.commands.registerCommand("undoBranches.later", step((t) => t.history.later())),
    vscode.commands.registerCommand("undoBranches.forget", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
      files.delete(doc.uri.toString());
      unstore(doc.uri.toString());
      open(doc);
      view.refresh();
    }),
  );

  // For the host tests only.
  return {
    history: (uri: vscode.Uri) => files.get(uri.toString())?.history,
    flush: () => {
      for (const t of files.values()) commit(t);
    },
    drop: (uri: vscode.Uri) => files.delete(uri.toString()),
  };
}

export function deactivate(): void {
  for (const [key, t] of files) {
    if (t.text === undefined) continue;
    commit(t);
    store(key, t);
  }
}
