import type { Camera, Object3D, Scene } from "three";

/** Anything an owner can free: a Three.js object, or anything with a `dispose()` method. */
export type Ownable = Object3D | { dispose(): void };

/** A thing in a game: its root object, and a way to bring it up to date with new state. */
export interface Entity<State> {
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

  /** Keeps one entity per item under `parent`, matched by `key`. See `List`. */
  list<Item>(
    parent: Object3D,
    key: (item: Item) => unknown,
    build: (owner: Owner, item: Item) => Entity<Item>,
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
  readonly entity: Entity<Item>;
  generation: number;
}

/**
 * One entity per item, matched by key. Each `update(items)` builds an entity
 * for every new key and adds its root to the parent, updates every entity with
 * its item, and disposes the entities whose keys are gone. Keys must be unique;
 * items that share a key share one entity. Create one with `owner.list()`: it
 * is disposed, with all its entities, with that owner.
 */
export class List<Item> {
  readonly #owner: Owner;
  readonly #parent: Object3D;
  readonly #key: (item: Item) => unknown;
  readonly #build: (owner: Owner, item: Item) => Entity<Item>;
  readonly #entries = new Map<unknown, ListEntry<Item>>();
  #generation = 0;

  constructor(
    owner: Owner,
    parent: Object3D,
    key: (item: Item) => unknown,
    build: (owner: Owner, item: Item) => Entity<Item>,
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
      entry.entity.update(item);
    }
    if (kept < this.#entries.size) this.#removeOlderThan(generation);
  }

  #add(key: unknown, item: Item): ListEntry<Item> {
    const owner = this.#owner.child();
    let entity: Entity<Item>;
    try {
      entity = this.#build(owner, item);
    } catch (error) {
      owner.dispose();
      throw error;
    }
    owner.onDispose(() => entity.root.removeFromParent());
    this.#parent.add(entity.root);
    const entry: ListEntry<Item> = { key, owner, entity, generation: 0 };
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

/** The canvas a stage draws on: its size in CSS px, and its device pixels per CSS px. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly density: number;
}

/**
 * One screen or layer of a game, such as a title screen, a match or a HUD: what it shows, the camera it is seen
 * through, and how it lays itself out. A stage draws it.
 */
export interface GameScene {
  /** What the scene shows. A Three.js scene, so a stage can draw it on its own. */
  readonly root: Scene;
  /** The camera the scene is seen through right now. A scene may keep several, and switch by changing this. */
  readonly camera: Camera;
  /** Lays the scene out for `viewport`. A stage calls it when the scene is shown and when the viewport changes. */
  layOut(viewport: Viewport): void;
}

/** What a stage needs from a renderer. Three.js's `WebGLRenderer` has all of it. */
export interface StageRenderer {
  readonly domElement: HTMLCanvasElement;
  autoClear: boolean;
  setPixelRatio(density: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setAnimationLoop(callback: ((time: number) => void) | null): void;
  clear(): void;
  clearDepth(): void;
  render(scene: Object3D, camera: Camera): void;
}

export interface StageOptions {
  /**
   * The most device pixels per CSS px the stage draws at. Each step up costs the square in pixels to fill, for less and
   * less to see, so 2 by default.
   */
  readonly maxDensity?: number;
}

/**
 * Draws a game's scenes on a renderer's canvas, a frame each time the display refreshes, in layers: each layer shows
 * one scene, drawn through that scene's camera over the layers below. The page sets the canvas's size, with CSS; the
 * stage draws at that size and the screen's pixel density, up to `maxDensity`, and has every scene lay itself out when
 * they change. The stage only draws: whoever makes a scene frees it, through its owner.
 */
export class Stage {
  readonly #renderer: StageRenderer;
  readonly #maxDensity: number;
  readonly #layers: { readonly layer: number; readonly scene: GameScene }[] = [];
  #viewport: Viewport | undefined;

  constructor(renderer: StageRenderer, { maxDensity = 2 }: StageOptions = {}) {
    this.#renderer = renderer;
    this.#maxDensity = maxDensity;
    renderer.autoClear = false;
    renderer.setAnimationLoop(() => this.#frame());
  }

  /** The viewport the stage last drew at, or `undefined` before its first frame. */
  get viewport(): Viewport | undefined {
    return this.#viewport;
  }

  /**
   * Shows `scene` on `layer`, in place of the scene that layer showed; `undefined` empties the layer. Lower layers are
   * drawn first. Once the stage has a viewport, a scene it's given is laid out at once.
   */
  show(layer: number, scene: GameScene | undefined): void {
    const index = this.#layers.findIndex((shown) => shown.layer === layer);
    if (index !== -1) this.#layers.splice(index, 1);
    if (scene === undefined) return;
    const above = this.#layers.findIndex((shown) => shown.layer > layer);
    this.#layers.splice(above === -1 ? this.#layers.length : above, 0, { layer, scene });
    if (this.#viewport !== undefined) scene.layOut(this.#viewport);
  }

  /** Stops drawing. Owning the stage stops it with its owner. */
  dispose(): void {
    this.#renderer.setAnimationLoop(null);
    this.#layers.length = 0;
  }

  #frame(): void {
    const renderer = this.#renderer;
    const { clientWidth: width, clientHeight: height } = renderer.domElement;
    // A canvas the page hasn't given a size has nothing to draw on.
    if (width === 0 || height === 0) return;
    const density = Math.min(globalThis.devicePixelRatio, this.#maxDensity);
    const last = this.#viewport;
    if (last === undefined || width !== last.width || height !== last.height || density !== last.density) {
      const viewport = { width, height, density };
      this.#viewport = viewport;
      renderer.setPixelRatio(density);
      renderer.setSize(width, height, false);
      for (const { scene } of this.#layers) scene.layOut(viewport);
    }
    renderer.clear();
    const layers = this.#layers;
    for (let index = 0; index < layers.length; index++) {
      const shown = layers[index];
      if (shown === undefined) continue;
      if (index > 0) renderer.clearDepth();
      renderer.render(shown.scene.root, shown.scene.camera);
    }
  }
}
