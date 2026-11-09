import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  type Material,
  Mesh,
} from "three";
import type { Owner } from "./index.ts";

/** Named values, each with how many numbers it has, 1 to 4. A shader reads each as an attribute of that name. */
export type FieldSizes = Readonly<Record<string, number>>;

export interface BatchOptions<Fields extends FieldSizes, Shared extends FieldSizes> {
  /**
   * The material every instance is drawn with. The batch doesn't free it: whoever made it owns it. It has to draw in one
   * pass for runs to paint in order, so a see-through material drawn on both sides needs `forceSinglePass`.
   */
  readonly material: Material;
  /** The values each instance has of its own, which a run holds in `values`. */
  readonly fields: Fields;
  /** The values every instance of a run has alike, which it holds once, in `shared`. They come first in each instance. */
  readonly shared?: Shared;
  /**
   * The geometry each instance draws: a flat square with corners from -1 to 1 unless it's given one. The batch draws a
   * copy, its attributes, index and draw range, so the one it's given stays as it was; its morph targets aren't drawn.
   */
  readonly shape?: BufferGeometry;
}

/**
 * Draws many copies of a shape in a single draw call, each copy an instance with values of its own that its material's
 * shader reads. Whoever draws adds runs of instances and writes their values, and before each frame is drawn, `flush`
 * copies every shown run into one buffer on the GPU. A run paints over the runs before it, in the order of
 * `BatchRun.order`, then the order they were added. When nothing has changed, `flush` copies nothing. A batch with
 * nothing in it draws nothing, but its first frame sets it up: Three.js compiles its material and sends its buffers to
 * the GPU then, rather than on the frame its first instance shows.
 */
export class Batch<Fields extends FieldSizes = FieldSizes, Shared extends FieldSizes = Record<never, number>> {
  /**
   * The one object that draws every instance. Add it to a scene. Its instances are never left out as off screen. It gets
   * a new geometry when the batch outgrows its room, so read `mesh.geometry` where it's needed rather than keeping it.
   */
  readonly mesh: Mesh<InstancedBufferGeometry, Material>;
  /** The batch's own copy of the shape each instance draws. */
  readonly #shape: BufferGeometry;
  readonly #layout: Layout;
  readonly #runs: BatchRun<Fields, Shared>[] = [];
  #capacity = 0;
  #values = new Float32Array(0);
  #buffer: InstancedInterleavedBuffer | undefined;
  /** The part of the buffer the last flush wrote, which the GPU copies: from its start. */
  readonly #range = { start: 0, count: 0 };
  #changed = false;
  #unsorted = false;
  #added = 0;
  /** How a run tells the batch what `flush` has to do. */
  readonly #listener: RunListener = {
    changed: () => {
      this.#changed = true;
    },
    moved: () => {
      this.#changed = true;
      this.#unsorted = true;
    },
  };

  constructor(owner: Owner, { material, fields, shared, shape }: BatchOptions<Fields, Shared>) {
    // Three.js draws such a material in two passes, every instance's back, then every instance's front, so an earlier
    // run's front would paint over a later run's back.
    if (material.transparent && material.side === DoubleSide && !material.forceSinglePass) {
      throw new Error("A batch's see-through material drawn on both sides needs forceSinglePass, or its runs paint out of order.");
    }
    // A copy of its own: outgrowing its room frees the GPU's copy of the shape, which anything else drawing it still uses.
    this.#shape = owner.own(shape?.clone() ?? square());
    this.#layout = layoutOf(fields, shared ?? {}, this.#shape);
    this.mesh = owner.own(new Mesh(this.#geometry(INITIAL_CAPACITY), material));
    // The shape's bounds say nothing about where its instances are.
    this.mesh.frustumCulled = false;
    owner.onDispose(() => this.mesh.geometry.dispose());
  }

  /** Adds `count` instances, painted over every run before them, until `owner` is freed. */
  add(owner: Owner, count: number): BatchRun<Fields, Shared> {
    const run = new BatchRun<Fields, Shared>(this.#listener, this.#layout, count, this.#added++);
    this.#runs.push(run);
    this.#listener.moved();
    owner.onDispose(() => {
      this.#runs.splice(this.#runs.indexOf(run), 1);
      this.#listener.changed();
    });
    return run;
  }

  /**
   * If anything changed, copies every shown run to the GPU. Call it once a frame, before Three.js walks the scene to draw
   * it: before `renderer.render`, or from the scene's `onBeforeRender`. A mesh's `onBeforeRender` is too late, since
   * Three.js has sent the frame's buffers by then: the change would show a frame late, and a batch that outgrew its room
   * would be drawn with the geometry it had just freed.
   */
  flush(): void {
    if (!this.#changed) return;
    const runs = this.#runs;
    if (this.#unsorted) {
      sortIntoPaintOrder(runs);
      this.#unsorted = false;
    }
    let count = 0;
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index] as BatchRun<Fields, Shared>;
      if (run.visible) count += run.count;
    }
    if (count > this.#capacity) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = this.#geometry(Math.max(count, this.#capacity * 2));
    }
    let at = 0;
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index] as BatchRun<Fields, Shared>;
      if (run.visible) at = this.#write(run, at);
    }
    const buffer = this.#buffer;
    // With nothing shown there's nothing to copy; a range of nothing would make WebGL copy the whole buffer.
    if (buffer !== undefined && at > 0) {
      buffer.clearUpdateRanges();
      // The same range each time, so a frame where something moves makes no new object.
      this.#range.count = at;
      buffer.updateRanges.push(this.#range);
      buffer.needsUpdate = true;
    }
    this.mesh.geometry.instanceCount = count;
    this.#changed = false;
  }

  /** Writes `run`'s instances into the buffer from value `at`. Returns where it ended. */
  #write(run: BatchRun<Fields, Shared>, at: number): number {
    const { sharedSize, ownSize } = this.#layout;
    const target = this.#values;
    const { shared, values, count } = run;
    const stride = sharedSize + ownSize;
    // Copied value by value: a view of `values` would be a new object for each instance, each frame something moves.
    for (let index = 0; index < count; index++) {
      const start = at + index * stride;
      for (let value = 0; value < sharedSize; value++) target[start + value] = shared[value] ?? 0;
      const from = index * ownSize;
      for (let value = 0; value < ownSize; value++) target[start + sharedSize + value] = values[from + value] ?? 0;
    }
    return at + count * stride;
  }

  /** The shape, with room for `capacity` instances. */
  #geometry(capacity: number): InstancedBufferGeometry {
    this.#capacity = capacity;
    const { places, sharedSize, ownSize } = this.#layout;
    const stride = sharedSize + ownSize;
    this.#values = new Float32Array(capacity * stride);
    const buffer = new InstancedInterleavedBuffer(this.#values, stride).setUsage(DynamicDrawUsage);
    this.#buffer = buffer;
    const geometry = new InstancedBufferGeometry();
    const shape = this.#shape;
    for (const [name, attribute] of Object.entries(shape.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(shape.getIndex());
    geometry.setDrawRange(shape.drawRange.start, shape.drawRange.count);
    for (const { name, size, shared, offset } of places) {
      geometry.setAttribute(name, new InterleavedBufferAttribute(buffer, size, shared ? offset : sharedSize + offset));
    }
    geometry.instanceCount = 0;
    return geometry;
  }
}

/**
 * A run of instances in a `Batch`. Its `fields` set its values by name: `run.fields.place.set(10, 20)`. Code that writes
 * many at once can write its instances' values straight into `values`, one instance after another, and what they all have
 * alike into `shared`, then call `changed`.
 */
export class BatchRun<Fields extends FieldSizes = FieldSizes, Shared extends FieldSizes = Record<never, number>> {
  /** The values every instance of the run has alike. */
  readonly shared: Float32Array;
  /** When it was added, among its batch's runs, which settles the order of runs of the same `order`. */
  readonly added: number;
  readonly #listener: RunListener;
  readonly #layout: Layout;
  #count: number;
  #values: Float32Array;
  #order = 0;
  #visible = true;
  #fields: Readonly<Record<keyof Fields | keyof Shared, BatchField>> | undefined;

  constructor(listener: RunListener, layout: Layout, count: number, added: number) {
    checkCount(count);
    this.#listener = listener;
    this.#layout = layout;
    this.#count = count;
    this.added = added;
    this.#values = new Float32Array(count * layout.ownSize);
    this.shared = new Float32Array(layout.sharedSize);
  }

  /** The run's values by name, made the first time they're asked for, so a run written through `values` holds none. */
  get fields(): Readonly<Record<keyof Fields | keyof Shared, BatchField>> {
    const { places, ownSize } = this.#layout;
    this.#fields ??= Object.fromEntries(places.map((place) => [place.name, new BatchField(this, place, ownSize)])) as Record<keyof Fields | keyof Shared, BatchField>;
    return this.#fields;
  }

  /** How many instances the run has. */
  get count(): number {
    return this.#count;
  }

  /** The run's instances' own values: `count` instances, then any room it keeps for growing back into. */
  get values(): Float32Array {
    return this.#values;
  }

  /** Where the run paints: over every run of a lower order, and of the same order, over those added before it. 0 unless it's set. */
  get order(): number {
    return this.#order;
  }

  set order(order: number) {
    if (order === this.#order) return;
    this.#order = order;
    this.#listener.moved();
  }

  /** Whether the run is drawn at all. */
  get visible(): boolean {
    return this.#visible;
  }

  set visible(visible: boolean) {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.#listener.changed();
  }

  /**
   * Gives the run `count` instances, keeping its place in the batch. The instances it keeps keep their values, and those
   * it gains start at 0, as a new run's do; it makes room only when it grows past any size it has had.
   */
  resize(count: number): void {
    checkCount(count);
    if (count === this.#count) return;
    const { ownSize } = this.#layout;
    if (count * ownSize > this.#values.length) {
      const values = new Float32Array(count * ownSize);
      values.set(this.#values.subarray(0, this.#count * ownSize));
      this.#values = values;
    } else if (count > this.#count) {
      this.#values.fill(0, this.#count * ownSize, count * ownSize);
    }
    this.#count = count;
    this.#listener.changed();
  }

  /** Says `values` or `shared` changed, so the batch copies them before the next frame. */
  changed(): void {
    this.#listener.changed();
  }
}

/**
 * One named value of a run, set with up to four numbers: `place.set(10, 20)`, or `place.setAt(3, 10, 20)` for an instance
 * past the first. A value every instance shares has one place, whichever instance it's asked for.
 */
export class BatchField {
  readonly #run: Pick<BatchRun, "values" | "shared" | "changed">;
  readonly #place: FieldPlace;
  /** How many values each instance of the run has of its own. */
  readonly #ownSize: number;

  constructor(run: Pick<BatchRun, "values" | "shared" | "changed">, place: FieldPlace, ownSize: number) {
    this.#run = run;
    this.#place = place;
    this.#ownSize = ownSize;
  }

  /** Sets the value of the run's first instance, or of all of them if it's shared. */
  set(a: number, b = 0, c = 0, d = 0): void {
    this.setAt(0, a, b, c, d);
  }

  /** Sets instance `index`'s value. Numbers past the value's size are left out. */
  setAt(index: number, a: number, b = 0, c = 0, d = 0): void {
    const { offset, size, shared } = this.#place;
    const values = shared ? this.#run.shared : this.#run.values;
    const at = shared ? offset : index * this.#ownSize + offset;
    values[at] = a;
    if (size > 1) values[at + 1] = b;
    if (size > 2) values[at + 2] = c;
    if (size > 3) values[at + 3] = d;
    this.#run.changed();
  }
}

/** Where a named value sits: in a run's `shared` or its instances' own `values`, how far in, and how many numbers it has. */
interface FieldPlace {
  readonly name: string;
  readonly size: number;
  readonly shared: boolean;
  readonly offset: number;
}

/** Where a batch's values sit, and how many numbers each instance shares with its run and has of its own. */
interface Layout {
  readonly places: readonly FieldPlace[];
  readonly sharedSize: number;
  readonly ownSize: number;
}

/** What a run tells its batch: that something in it changed, or that it paints in a new place. */
interface RunListener {
  changed(): void;
  moved(): void;
}

/**
 * The layout of `fields` and `shared`, which can't reuse a name, or a name `shape` already has, such as `position`, nor
 * need more attributes, with the shape's, than WebGL 2 promises.
 */
function layoutOf(fields: FieldSizes, shared: FieldSizes, shape: BufferGeometry): Layout {
  const places: FieldPlace[] = [];
  const sizes = { own: 0, shared: 0 };
  const place = (group: FieldSizes, isShared: boolean) => {
    for (const [name, size] of Object.entries(group)) {
      if (Object.hasOwn(shape.attributes, name)) throw new Error(`A batch's value can't be named ${name}: its shape has an attribute of that name.`);
      if (places.some((each) => each.name === name)) throw new Error(`A batch has two values named ${name}.`);
      if (!Number.isInteger(size) || size < 1 || size > 4) throw new Error(`A batch's value ${name} has ${size} numbers; a value has 1 to 4.`);
      places.push({ name, size, shared: isShared, offset: isShared ? sizes.shared : sizes.own });
      if (isShared) sizes.shared += size;
      else sizes.own += size;
    }
  };
  place(shared, true);
  place(fields, false);
  // Past this the shader fails to link, and only on a GPU.
  const attributes = places.length + Object.keys(shape.attributes).length;
  if (attributes > MOST_ATTRIBUTES) {
    throw new Error(`A batch's shape and values need ${attributes} attributes, and WebGL 2 promises ${MOST_ATTRIBUTES}: put small values together in one of up to 4 numbers.`);
  }
  return { places, sharedSize: sizes.shared, ownSize: sizes.own };
}

/** The most attributes, a shape's and a batch's values together, that every WebGL 2 device draws with. */
const MOST_ATTRIBUTES = 16;

/** Throws unless `count` can be a run's number of instances: a whole number, 0 or more. */
function checkCount(count: number): void {
  if (!Number.isInteger(count) || count < 0) throw new Error(`A run can't have ${count} instances: it has a whole number of them, 0 or more.`);
}

/**
 * Puts `runs` in paint order, in place. Runs change places little from one frame to the next, so they're nearly in order,
 * where an insertion sort takes one pass and, unlike `Array.sort`, makes no new objects.
 */
function sortIntoPaintOrder<Run extends Pick<BatchRun, "order" | "added">>(runs: Run[]): void {
  for (let index = 1; index < runs.length; index++) {
    const run = runs[index] as Run;
    let at = index - 1;
    for (; at >= 0; at--) {
      const before = runs[at] as Run;
      if (before.order < run.order || (before.order === run.order && before.added < run.added)) break;
      runs[at + 1] = before;
    }
    runs[at + 1] = run;
  }
}

/** A flat square with corners from -1 to 1. */
function square(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(SQUARE), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

/** How many instances a batch has room for at first; it doubles its room whenever it runs out. */
const INITIAL_CAPACITY = 64;
/** The square's corners, each x, y and z. */
const SQUARE = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
