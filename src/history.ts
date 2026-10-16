// One file's history as a tree of states. Each state stores only the edit that
// leads to it from its parent, so any state can be rebuilt from the current
// text by walking the tree.

export interface Op {
  at: number;
  del: string;
  ins: string;
}

export interface Change {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export type Kind = "start" | "edit" | "undo" | "redo";

export interface State {
  id: number;
  parent: number;
  children: number[];
  seq: number;
  time: number;
  kind: Kind;
  ops: Op[];
  hash: string;
  added: number;
  removed: number;
  saved?: boolean;
}

export interface Saved {
  states: State[];
  root: number;
  current: number;
  nextId: number;
  nextSeq: number;
  lastSave: number;
}

export function apply(text: string, ops: Op[]): string {
  for (const o of ops) text = text.slice(0, o.at) + o.ins + text.slice(o.at + o.del.length);
  return text;
}

export function invert(ops: Op[]): Op[] {
  return ops
    .slice()
    .reverse()
    .map((o) => ({ at: o.at, del: o.ins, ins: o.del }));
}

// The changes in one VS Code event all use offsets into the text before the
// event. Applied from the end backwards they become a plain sequence.
export function fromChanges(before: string, changes: readonly Change[]): Op[] {
  return changes
    .slice()
    .sort((a, b) => b.rangeOffset - a.rangeOffset)
    .map((c) => ({ at: c.rangeOffset, del: before.substr(c.rangeOffset, c.rangeLength), ins: c.text }));
}

// What the state typed, or else what it removed. Typing arrives one key at a
// time, so the pieces are joined in the order they happened.
export function snippet(s: Pick<State, "ops">): string {
  const typed = s.ops.map((o) => o.ins).join("").replace(/\s+/g, " ").trim();
  const removed = s.ops
    .map((o) => o.del)
    .reverse()
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const text = typed || removed;
  if (!text) return "";
  return (typed ? "" : "removed: ") + (text.length > 40 ? text.slice(0, 40) + "…" : text);
}

export class History {
  readonly states = new Map<number, State>();
  root = 0;
  current = 0;
  lastSave = -1;
  private nextId = 1;
  private nextSeq = 1;
  private pending: Op[] = [];
  // The child each state last moved to, so "forward" retraces it.
  private lastChild = new Map<number, number>();

  constructor(
    text: string,
    private readonly hash: (text: string) => string,
    public maxStates = 1000,
    now = Date.now(),
  ) {
    this.states.set(0, { id: 0, parent: -1, children: [], seq: 0, time: now, kind: "start", ops: [], hash: hash(text), added: 0, removed: 0 });
  }

  toJSON(): Saved {
    return { states: [...this.states.values()], root: this.root, current: this.current, nextId: this.nextId, nextSeq: this.nextSeq, lastSave: this.lastSave };
  }

  // Rebuilds a saved history, but only when the file is still at the state the
  // history was left on.
  static fromJSON(data: Saved, text: string, hash: (text: string) => string, maxStates = 1000): History | undefined {
    const cur = data.states.find((s) => s.id === data.current);
    if (!cur || cur.hash !== hash(text)) return undefined;
    const h = new History(text, hash, maxStates);
    h.states.clear();
    for (const s of data.states) h.states.set(s.id, s);
    h.root = data.root;
    h.nextId = data.nextId;
    h.nextSeq = data.nextSeq;
    h.lastSave = data.lastSave;
    h.moveTo(data.current);
    return h;
  }

  markSaved(): void {
    this.get(this.current).saved = true;
    this.lastSave = this.current;
  }

  get(id: number): State {
    const s = this.states.get(id);
    if (!s) throw new Error(`no state ${id}`);
    return s;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  record(ops: Op[]): void {
    this.pending.push(...ops);
  }

  // Closes the edits recorded so far into a new state. `text` is the document
  // now. Returns the new state, or undefined when nothing changed overall.
  commit(text: string, kind: Kind = "edit", now = Date.now()): State | undefined {
    if (!this.pending.length) return undefined;
    const ops = this.pending;
    this.pending = [];
    const h = this.hash(text);
    const cur = this.get(this.current);
    if (h === cur.hash) return undefined;
    const same = cur.children.map((c) => this.get(c)).find((c) => c.hash === h);
    if (same) {
      this.moveTo(same.id);
      return same;
    }
    const s: State = {
      id: this.nextId++,
      parent: cur.id,
      children: [],
      seq: this.nextSeq++,
      time: now,
      kind,
      ops,
      hash: h,
      added: ops.reduce((n, o) => n + o.ins.length, 0),
      removed: ops.reduce((n, o) => n + o.del.length, 0),
    };
    this.states.set(s.id, s);
    cur.children.push(s.id);
    this.moveTo(s.id);
    this.prune();
    return s;
  }

  // A native undo or redo landed the document on `text`. Points at the state
  // with that text when there is one, nearest first. Returns false when no
  // state matches, and the caller records it as a new state instead.
  follow(text: string): boolean {
    const h = this.hash(text);
    const cur = this.get(this.current);
    const near = [cur.parent, ...cur.children.slice().reverse()].filter((i) => i >= 0).map((i) => this.get(i));
    const hit = near.find((s) => s.hash === h) ?? [...this.states.values()].sort((a, b) => b.seq - a.seq).find((s) => s.hash === h);
    if (!hit) return false;
    this.moveTo(hit.id);
    return true;
  }

  // Ids from `from` up to the shared ancestor, and from there down to `to`.
  path(from: number, to: number): { up: number[]; down: number[] } {
    const ancestors = new Set<number>();
    for (let i = to; i >= 0; i = this.get(i).parent) ancestors.add(i);
    const up: number[] = [];
    let i = from;
    while (!ancestors.has(i)) {
      up.push(i);
      i = this.get(i).parent;
    }
    const down: number[] = [];
    for (let j = to; j !== i; j = this.get(j).parent) down.push(j);
    return { up, down: down.reverse() };
  }

  // The text of state `id`, given the text of the current state.
  textOf(id: number, currentText: string): string {
    const { up, down } = this.path(this.current, id);
    let t = currentText;
    for (const u of up) t = apply(t, invert(this.get(u).ops));
    for (const d of down) t = apply(t, this.get(d).ops);
    return t;
  }

  moveTo(id: number): void {
    const s = this.get(id);
    for (let c = s, p = s.parent; p >= 0; c = this.get(p), p = c.parent) this.lastChild.set(p, c.id);
    this.current = id;
  }

  parentOf(id = this.current): number | undefined {
    const p = this.get(id).parent;
    return p >= 0 ? p : undefined;
  }

  childOf(id = this.current): number | undefined {
    const s = this.get(id);
    if (!s.children.length) return undefined;
    const last = this.lastChild.get(id);
    return last !== undefined && s.children.includes(last) ? last : s.children[s.children.length - 1];
  }

  // Vim's g- and g+: the state made just before or after this one, on any branch.
  earlier(id = this.current): number | undefined {
    return this.bySeq(this.get(id).seq, -1);
  }

  later(id = this.current): number | undefined {
    return this.bySeq(this.get(id).seq, 1);
  }

  private bySeq(seq: number, dir: 1 | -1): number | undefined {
    let best: State | undefined;
    for (const s of this.states.values()) {
      if (dir < 0 ? s.seq < seq && (!best || s.seq > best.seq) : s.seq > seq && (!best || s.seq < best.seq)) best = s;
    }
    return best?.id;
  }

  // The main line shown in the view: from `id` down through the child on the
  // way to the current state, or else the newest child.
  line(id: number): number[] {
    const onPath = new Set<number>();
    for (let i = this.current; i >= 0; i = this.get(i).parent) onPath.add(i);
    const out = [id];
    for (let s = this.get(id); s.children.length; ) {
      const next = s.children.find((c) => onPath.has(c)) ?? s.children[s.children.length - 1];
      out.push(next);
      s = this.get(next);
    }
    return out;
  }

  // Oldest first: a leaf that is not the current state, or the start state
  // when only one line leaves it.
  private prune(): void {
    while (this.states.size > this.maxStates) {
      let victim: State | undefined;
      for (const s of this.states.values()) {
        if (s.id === this.current) continue;
        const leaf = s.children.length === 0;
        const soloRoot = s.id === this.root && s.children.length === 1;
        if ((leaf || soloRoot) && (!victim || s.seq < victim.seq)) victim = s;
      }
      if (!victim) return;
      if (victim.id === this.root) {
        const child = this.get(victim.children[0]);
        child.parent = -1;
        child.ops = [];
        child.kind = "start";
        this.root = child.id;
      } else {
        const p = this.get(victim.parent);
        p.children = p.children.filter((c) => c !== victim!.id);
        if (this.lastChild.get(p.id) === victim.id) this.lastChild.delete(p.id);
      }
      if (this.lastSave === victim.id) this.lastSave = -1;
      this.states.delete(victim.id);
    }
  }
}
