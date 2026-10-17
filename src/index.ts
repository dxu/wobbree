import type { Object3D } from "three";

/** Anything an owner can free: a Three.js object, or anything with a `dispose()` method. */
export type Ownable = Object3D | { dispose(): void };

/** A piece of a scene: its root object, and a way to bring it up to date with new state. */
export interface Component<State> {
  readonly root: Object3D;
  update(state: State): void;
}

type Entry = Ownable | (() => void);

/**
 * Frees everything it owns at once. Disposing an owner disposes its children
 * first, then frees what it owns, newest first: Three.js objects leave their
 * parents (and are disposed too if they can be, like `InstancedMesh`),
 * resources are disposed, and cleanup functions run.
 */
export class Owner {
  #entries: Entry[] = [];
  #children: Set<Owner> | undefined;
  #parent: Owner | undefined;
  #disposed = false;

  /** Whether `dispose()` has run. Anything owned after that is freed at once. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Owns `thing` and returns it, so it can wrap a constructor: `owner.own(new BoxGeometry())`. */
  own<T extends Ownable>(thing: T): T {
    if (this.#disposed) release(thing);
    else this.#entries.push(thing);
    return thing;
  }

  /** Runs `cleanup` when this owner is disposed. */
  onDispose(cleanup: () => void): void {
    if (this.#disposed) cleanup();
    else this.#entries.push(cleanup);
  }

  /** A new owner that is disposed with this one, unless it is disposed first. */
  child(): Owner {
    const child = new Owner();
    child.#parent = this;
    if (this.#disposed) child.#disposed = true;
    else (this.#children ??= new Set()).add(child);
    return child;
  }

  /** Keeps one component per item under `parent`, matched by `key`. See `List`. */
  list<Item>(
    parent: Object3D,
    key: (item: Item) => unknown,
    build: (owner: Owner, item: Item) => Component<Item>,
  ): List<Item> {
    return new List(this, parent, key, build);
  }

  /**
   * Frees everything, children first. Running it again does nothing. If freeing
   * something throws, the rest is still freed and the first error is rethrown.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#parent !== undefined) this.#parent.#children?.delete(this);
    let failure: { error: unknown } | undefined;
    const children = this.#children === undefined ? [] : [...this.#children];
    this.#children = undefined;
    for (let child = children.pop(); child !== undefined; child = children.pop()) {
      try {
        child.dispose();
      } catch (error) {
        failure ??= { error };
      }
    }
    for (let entry = this.#entries.pop(); entry !== undefined; entry = this.#entries.pop()) {
      try {
        release(entry);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure !== undefined) throw failure.error;
  }
}

function release(entry: Entry): void {
  if (typeof entry === "function") {
    entry();
  } else if (isObject3D(entry)) {
    entry.removeFromParent();
    if (hasDispose(entry)) entry.dispose();
  } else {
    entry.dispose();
  }
}

function isObject3D(thing: Ownable): thing is Object3D {
  return "isObject3D" in thing && thing.isObject3D === true;
}

function hasDispose(object: Object3D): object is Object3D & { dispose(): void } {
  return "dispose" in object && typeof object.dispose === "function";
}

interface ListEntry<Item> {
  readonly key: unknown;
  readonly owner: Owner;
  readonly component: Component<Item>;
  generation: number;
}

/**
 * One component per item, matched by key. Each `update(items)` builds a
 * component for every new key and adds its root to the parent, updates every
 * component with its item, and disposes the components whose keys are gone.
 * Keys must be unique; items that share a key share one component. Create one
 * with `owner.list()`: it is disposed, with all its components, with that owner.
 */
export class List<Item> {
  readonly #owner: Owner;
  readonly #parent: Object3D;
  readonly #key: (item: Item) => unknown;
  readonly #build: (owner: Owner, item: Item) => Component<Item>;
  readonly #entries = new Map<unknown, ListEntry<Item>>();
  #generation = 0;

  constructor(
    owner: Owner,
    parent: Object3D,
    key: (item: Item) => unknown,
    build: (owner: Owner, item: Item) => Component<Item>,
  ) {
    this.#owner = owner;
    this.#parent = parent;
    this.#key = key;
    this.#build = build;
    owner.onDispose(() => this.#entries.clear());
  }

  update(items: readonly Item[]): void {
    if (this.#owner.disposed) return;
    const generation = ++this.#generation;
    let kept = 0;
    for (const item of items) {
      const key = this.#key(item);
      const entry = this.#entries.get(key) ?? this.#add(key, item);
      if (entry.generation !== generation) {
        entry.generation = generation;
        kept++;
      }
      entry.component.update(item);
    }
    if (kept < this.#entries.size) this.#removeOlderThan(generation);
  }

  #add(key: unknown, item: Item): ListEntry<Item> {
    const owner = this.#owner.child();
    let component: Component<Item>;
    try {
      component = this.#build(owner, item);
    } catch (error) {
      owner.dispose();
      throw error;
    }
    owner.onDispose(() => component.root.removeFromParent());
    this.#parent.add(component.root);
    const entry: ListEntry<Item> = { key, owner, component, generation: 0 };
    this.#entries.set(key, entry);
    return entry;
  }

  #removeOlderThan(generation: number): void {
    for (const entry of this.#entries.values()) {
      if (entry.generation !== generation) {
        this.#entries.delete(entry.key);
        entry.owner.dispose();
      }
    }
  }
}
