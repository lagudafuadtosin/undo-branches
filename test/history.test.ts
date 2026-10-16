import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { History, apply, fromChanges, invert, type Change } from "../src/history";

const hash = (t: string) => createHash("sha1").update(t).digest("base64");

// Plays a VS Code style event (offsets into the text before it) and records it.
function edit(h: History, text: string, changes: Change[]): string {
  const ops = fromChanges(text, changes);
  h.record(ops);
  return apply(text, ops);
}
const ins = (at: number, text: string): Change => ({ rangeOffset: at, rangeLength: 0, text });
const del = (at: number, n: number): Change => ({ rangeOffset: at, rangeLength: n, text: "" });

test("simultaneous changes become a sequence that rebuilds the same text", () => {
  const before = "aaa bbb ccc";
  const changes = [{ rangeOffset: 0, rangeLength: 3, text: "X" }, { rangeOffset: 8, rangeLength: 3, text: "YYYY" }];
  const ops = fromChanges(before, changes);
  assert.equal(apply(before, ops), "X bbb YYYY");
  assert.equal(apply(apply(before, ops), invert(ops)), before);
});

test("a branch survives undo then a new edit, and every state rebuilds", () => {
  let t = "hello";
  const h = new History(t, hash);
  t = edit(h, t, [ins(5, " world")]);
  const a = h.commit(t)!;
  t = edit(h, t, [ins(11, "!")]);
  const b = h.commit(t)!;

  // Go back to a, then type something else: b must still be reachable.
  t = h.textOf(a.id, t);
  h.moveTo(a.id);
  assert.equal(t, "hello world");
  t = edit(h, t, [ins(11, "?")]);
  const c = h.commit(t)!;

  assert.deepEqual(h.get(a.id).children, [b.id, c.id]);
  assert.equal(h.textOf(b.id, t), "hello world!");
  assert.equal(h.textOf(c.id, t), "hello world?");
  assert.equal(h.textOf(0, t), "hello");
});

test("typing that ends where it started makes no state", () => {
  let t = "abc";
  const h = new History(t, hash);
  t = edit(h, t, [ins(3, "d")]);
  t = edit(h, t, [del(3, 1)]);
  assert.equal(h.commit(t), undefined);
  assert.equal(h.states.size, 1);
});

test("an edit that matches an existing child moves there instead of duplicating", () => {
  let t = "x";
  const h = new History(t, hash);
  t = edit(h, t, [ins(1, "y")]);
  const a = h.commit(t)!;
  t = h.textOf(0, t);
  h.moveTo(0);
  t = edit(h, t, [ins(1, "y")]);
  assert.equal(h.commit(t)!.id, a.id);
  assert.equal(h.states.size, 2);
});

test("follow finds the state a native undo or redo landed on", () => {
  let t = "1";
  const h = new History(t, hash);
  t = edit(h, t, [ins(1, "2")]);
  h.commit(t);
  t = edit(h, t, [ins(2, "3")]);
  const b = h.commit(t)!;
  assert.equal(h.follow("12"), true);
  assert.equal(h.current, b.parent);
  assert.equal(h.follow("123"), true);
  assert.equal(h.current, b.id);
  assert.equal(h.follow("nothing like it"), false);
});

test("earlier and later walk creation order across branches, like Vim g- and g+", () => {
  let t = "";
  const h = new History(t, hash);
  t = edit(h, t, [ins(0, "a")]);
  const a = h.commit(t)!;
  t = edit(h, t, [ins(1, "b")]);
  const b = h.commit(t)!;
  t = h.textOf(a.id, t);
  h.moveTo(a.id);
  t = edit(h, t, [ins(1, "c")]);
  const c = h.commit(t)!;
  assert.equal(h.earlier(), b.id); // b was made before c, on the other branch
  assert.equal(h.earlier(b.id), a.id);
  assert.equal(h.later(b.id), c.id);
  assert.equal(h.later(), undefined);
});

test("forward retraces the branch last taken", () => {
  let t = "";
  const h = new History(t, hash);
  t = edit(h, t, [ins(0, "a")]);
  const a = h.commit(t)!;
  t = h.textOf(0, t);
  h.moveTo(0);
  t = edit(h, t, [ins(0, "b")]);
  h.commit(t);
  h.moveTo(a.id);
  h.moveTo(0);
  assert.equal(h.childOf(), a.id);
});

test("the main line follows the branch with the current state", () => {
  let t = "";
  const h = new History(t, hash);
  t = edit(h, t, [ins(0, "a")]);
  const a = h.commit(t)!;
  t = edit(h, t, [ins(1, "b")]);
  const b = h.commit(t)!;
  t = h.textOf(a.id, t);
  h.moveTo(a.id);
  t = edit(h, t, [ins(1, "c")]);
  const c = h.commit(t)!;
  assert.deepEqual(h.line(0), [0, a.id, c.id]);
  h.moveTo(b.id);
  assert.deepEqual(h.line(0), [0, a.id, b.id]);
});

test("pruning drops the oldest state it can, and keeps every kept state correct", () => {
  let t = "";
  const h = new History(t, hash, 4);
  t = edit(h, t, [ins(0, "a")]);
  const a = h.commit(t)!;
  t = edit(h, t, [ins(1, "b")]);
  const b = h.commit(t)!; // side branch, made first
  t = h.textOf(a.id, t);
  h.moveTo(a.id);
  t = edit(h, t, [ins(1, "c")]);
  h.commit(t);
  t = edit(h, t, [ins(2, "d")]);
  h.commit(t); // 5 states: the start is oldest and has one line, so it goes
  assert.equal(h.states.size, 4);
  assert.equal(h.root, a.id);
  assert.equal(h.get(a.id).parent, -1);
  assert.equal(h.textOf(b.id, t), "ab");
  t = edit(h, t, [ins(3, "e")]);
  h.commit(t); // 5 again: a now forks, so the oldest leaf, b, goes
  assert.equal(h.states.size, 4);
  assert.equal(h.states.has(b.id), false);
  assert.deepEqual(h.get(a.id).children.length, 1);
  assert.equal(h.textOf(a.id, t), "a");
  assert.equal(t, "acde");
});

test("the current state is never pruned", () => {
  let t = "";
  const h = new History(t, hash, 2);
  for (const ch of "abcdef") {
    t = edit(h, t, [ins(t.length, ch)]);
    h.commit(t);
  }
  assert.equal(h.states.size, 2);
  assert.equal(h.get(h.current).hash, hash("abcdef"));
  assert.equal(h.textOf(h.root, t), "abcde");
});

test("random edits, jumps and branches: every state always rebuilds to what it was", () => {
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  let t = "The quick brown fox\njumps over the lazy dog\n";
  const h = new History(t, hash, 10000);
  const seen = new Map<number, string>([[0, t]]);
  for (let i = 0; i < 400; i++) {
    if (rnd(5) === 0 && seen.size > 1) {
      const ids = [...seen.keys()];
      const id = ids[rnd(ids.length)];
      t = h.textOf(id, t);
      h.moveTo(id);
      assert.equal(t, seen.get(id));
      continue;
    }
    const n = 1 + rnd(3);
    for (let k = 0; k < n; k++) {
      const at = rnd(t.length + 1);
      const len = rnd(Math.min(4, t.length - at) + 1);
      const changes: Change[] = [{ rangeOffset: at, rangeLength: len, text: ["", "x", "yz\n", "😀"][rnd(4)] }];
      if (rnd(3) === 0 && at > 6) changes.push({ rangeOffset: rnd(at - 5), rangeLength: 1, text: "Q" });
      t = edit(h, t, changes);
    }
    const s = h.commit(t);
    if (s) seen.set(s.id, t);
  }
  for (const [id, text] of seen) assert.equal(h.textOf(id, t), text, `state ${id}`);
});

test("a saved history comes back whole, and only onto the same text", () => {
  let t = "one";
  const h = new History(t, hash);
  t = edit(h, t, [ins(3, " two")]);
  const a = h.commit(t)!;
  h.markSaved();
  t = h.textOf(0, t);
  h.moveTo(0);
  t = edit(h, t, [ins(3, " three")]);
  h.commit(t);
  const data = JSON.parse(JSON.stringify(h.toJSON()));

  assert.equal(History.fromJSON(data, "something else", hash), undefined);
  const back = History.fromJSON(data, t, hash)!;
  assert.equal(back.states.size, 3);
  assert.equal(back.textOf(a.id, t), "one two");
  assert.equal(back.lastSave, a.id);
  assert.equal(back.get(a.id).saved, true);
  t = edit(back, t, [ins(0, ">")]);
  assert.equal(back.commit(t)!.seq, 3);
});

test("pruning the last saved state clears the mark", () => {
  let t = "";
  const h = new History(t, hash, 2);
  t = edit(h, t, [ins(0, "a")]);
  h.commit(t);
  h.markSaved();
  t = edit(h, t, [ins(1, "b")]);
  h.commit(t);
  t = edit(h, t, [ins(2, "c")]);
  h.commit(t);
  assert.equal(h.lastSave, -1);
});
