import {
  BufferAttribute,
  type BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  type Material,
  Mesh,
} from "three";
import type { Owner } from "./index.ts";

/** How a batch's instances are laid out: each value's name, as its material's shader reads it, and how many numbers it has, 1 to 4. */
export type BatchFields = Readonly<Record<string, number>>;

export interface BatchOptions<Fields extends BatchFields, Shared extends BatchFields> {
  /** The material every instance is drawn with. It reads `fields` and `shared` as attributes of those names. */
  readonly material: Material;
  /** The values each instance has of its own, which a run holds in `values`. */
  readonly fields: Fields;
  /** The values every instance of a run has alike, which it holds once, in `shared`. They come first in each instance. */
  readonly shared?: Shared;
  /** The geometry each instance draws: a flat square with corners from -1 to 1 unless it's given one. The batch owns it. */
  readonly shape?: BufferGeometry;
}

/**
 * Draws many copies of a shape in a single draw call, each copy an instance with values of its own that its material's
 * shader reads. Whoever draws adds runs of instances and writes their values, and before each frame is drawn, `flush`
 * copies every run that's shown into one buffer on the GPU. A run paints over the runs before it, in the order of
 * `BatchRun.order`, then the order they were added. When nothing has changed, `flush` copies nothing. A batch with
 * nothing in it isn't drawn, except on its first frame, which sets it up: Three.js then compiles its material and sends
 * its buffers to the GPU without drawing anything, rather than on the frame its first instance shows.
 */
export class Batch<Fields extends BatchFields = BatchFields, Shared extends BatchFields = Record<never, number>> {
  /** The one object that draws every instance. Add it to a scene. Its instances are never left out as off screen. */
  readonly mesh: Mesh<InstancedBufferGeometry, Material>;
  readonly #shape: BufferGeometry;
  readonly #fields: readonly (readonly [string, number])[];
  readonly #places: readonly FieldPlace[];
  readonly #own: number;
  readonly #shared: number;
  readonly #runs: BatchRun<Fields, Shared>[] = [];
  #capacity = 0;
  #values = new Float32Array(0);
  #buffer: InstancedInterleavedBuffer | undefined;
  /** The part of the buffer the last flush wrote, which the GPU copies: from its start. */
  readonly #range = { start: 0, count: 0 };
  #changed = false;
  #unsorted = false;
  #first = true;
  #added = 0;

  constructor(owner: Owner, { material, fields, shared, shape = square() }: BatchOptions<Fields, Shared>) {
    const alike: BatchFields = shared ?? {};
    this.#shape = owner.own(shape);
    this.#fields = [...Object.entries(alike), ...Object.entries(fields)];
    this.#places = [...placesOf(alike, true), ...placesOf(fields, false)];
    this.#shared = total(alike);
    this.#own = total(fields);
    this.mesh = owner.own(new Mesh(this.#geometry(INITIAL_CAPACITY), owner.own(material)));
    // The shape's bounds say nothing about where its instances are.
    this.mesh.frustumCulled = false;
    owner.onDispose(() => this.mesh.geometry.dispose());
  }

  /** Adds `count` instances, painted over every run before them, until `owner` is freed. */
  add(owner: Owner, count: number): BatchRun<Fields, Shared> {
    const run = new BatchRun<Fields, Shared>(this.#notes, this.#places, count, this.#own, this.#shared, this.#added++);
    this.#runs.push(run);
    this.#changed = true;
    this.#unsorted = true;
    owner.onDispose(() => {
      this.#runs.splice(this.#runs.indexOf(run), 1);
      this.#changed = true;
    });
    return run;
  }

  /** How a run tells the batch what `flush` has to do. */
  readonly #notes: BatchNotes = {
    changed: () => {
      this.#changed = true;
    },
    moved: () => {
      this.#changed = true;
      this.#unsorted = true;
    },
  };

  /** Copies the runs to the GPU if anything changed since the last time. Call it each frame before the batch is drawn. */
  flush(): void {
    const runs = this.#runs;
    let count = 0;
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index] as BatchRun<Fields, Shared>;
      if (run.visible) count += run.count;
    }
    // With nothing to draw it's skipped: Three.js does a mesh's work each frame it's shown, even with nothing in it.
    this.mesh.visible = count > 0 || this.#first;
    this.#first = false;
    if (!this.#changed) return;
    if (this.#unsorted) {
      runs.sort(paintOrder);
      this.#unsorted = false;
    }
    if (count > this.#capacity) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = this.#geometry(Math.max(count, this.#capacity * 2));
    }
    const stride = this.#shared + this.#own;
    let at = 0;
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index] as BatchRun<Fields, Shared>;
      if (run.visible) at = run.write(this.#values, at, stride);
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

  /** The shape, with room for `capacity` instances. */
  #geometry(capacity: number): InstancedBufferGeometry {
    this.#capacity = capacity;
    const stride = this.#shared + this.#own;
    this.#values = new Float32Array(capacity * stride);
    const buffer = new InstancedInterleavedBuffer(this.#values, stride).setUsage(DynamicDrawUsage);
    this.#buffer = buffer;
    const geometry = new InstancedBufferGeometry();
    for (const [name, attribute] of Object.entries(this.#shape.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(this.#shape.getIndex());
    let offset = 0;
    for (const [name, size] of this.#fields) {
      geometry.setAttribute(name, new InterleavedBufferAttribute(buffer, size, offset));
      offset += size;
    }
    geometry.instanceCount = 0;
    return geometry;
  }
}

/**
 * A run of instances in a `Batch`. Its `fields` set its values by name: `run.fields.position.set(10, 20)`. Code that writes
 * many at once can write its instances' fields straight into `values`, one instance after another, and what they all have
 * alike into `shared`, then call `changed`.
 */
export class BatchRun<Fields extends BatchFields = BatchFields, Shared extends BatchFields = Record<never, number>> {
  /** The values every instance of the run has alike. */
  readonly shared: Float32Array;
  readonly #notes: BatchNotes;
  readonly #places: readonly FieldPlace[];
  /** How many values each instance has of its own. */
  readonly #fields: number;
  /** When it was added, which settles the order of runs of the same `order`. */
  readonly #added: number;
  #count: number;
  #values: Float32Array;
  #order = 0;
  #visible = true;
  #named: Readonly<Record<keyof Fields | keyof Shared, BatchField>> | undefined;

  constructor(notes: BatchNotes, places: readonly FieldPlace[], count: number, fields: number, shared: number, added: number) {
    this.#notes = notes;
    this.#places = places;
    this.#count = count;
    this.#fields = fields;
    this.#added = added;
    this.#values = new Float32Array(count * fields);
    this.shared = new Float32Array(shared);
  }

  /** The run's values by name, made the first time they're asked for, so a run written through `values` holds none. */
  get fields(): Readonly<Record<keyof Fields | keyof Shared, BatchField>> {
    this.#named ??= Object.fromEntries(this.#places.map((place) => [place.name, new BatchField(this, place, this.#fields)])) as Record<keyof Fields | keyof Shared, BatchField>;
    return this.#named;
  }

  /** How many instances the run has. */
  get count(): number {
    return this.#count;
  }

  /**
   * The run's instances' own fields: `count` instances, each the batch's `fields` in order, then any room it keeps for
   * growing back into.
   */
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
    this.#notes.moved();
  }

  /** When it was added, for sorting runs of one order. */
  get added(): number {
    return this.#added;
  }

  /** Whether the run is drawn at all. */
  get visible(): boolean {
    return this.#visible;
  }

  set visible(visible: boolean) {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.#notes.changed();
  }

  /**
   * Gives the run `count` instances, keeping its place in the batch. The instances it keeps keep their values, and those
   * it gains start at 0, as a new run's do; it makes room only when it grows past any size it has had.
   */
  resize(count: number): void {
    if (count === this.#count) return;
    const fields = this.#fields;
    if (count * fields > this.#values.length) {
      const values = new Float32Array(count * fields);
      values.set(this.#values.subarray(0, this.#count * fields));
      this.#values = values;
    } else if (count > this.#count) {
      this.#values.fill(0, this.#count * fields, count * fields);
    }
    this.#count = count;
    this.#notes.changed();
  }

  /** Says `values` or `shared` changed, so the batch copies them before the next frame. */
  changed(): void {
    this.#notes.changed();
  }

  /** Writes the run's instances into `target` from value `at`, `stride` values each. Returns where it ended. */
  write(target: Float32Array, at: number, stride: number): number {
    const shared = this.shared;
    const values = this.#values;
    const size = shared.length;
    const fields = this.#fields;
    // Copied value by value: a view of `values` would be a new object for each instance, each frame something moves.
    for (let index = 0; index < this.#count; index++) {
      const start = at + index * stride;
      for (let value = 0; value < size; value++) target[start + value] = shared[value] ?? 0;
      const from = index * fields;
      for (let field = 0; field < fields; field++) target[start + size + field] = values[from + field] ?? 0;
    }
    return at + this.#count * stride;
  }
}

/**
 * One named value of a run, set with up to four numbers: `position.set(10, 20)`, or `position.setAt(3, 10, 20)` for an
 * instance past the first. A value every instance shares has one place, whichever instance it's asked for.
 */
export class BatchField {
  readonly #run: Pick<BatchRun, "values" | "shared" | "changed">;
  readonly #place: FieldPlace;
  readonly #stride: number;

  constructor(run: Pick<BatchRun, "values" | "shared" | "changed">, place: FieldPlace, stride: number) {
    this.#run = run;
    this.#place = place;
    this.#stride = stride;
  }

  /** Sets the value of the run's first instance, or of all of them if it's shared. */
  set(a: number, b = 0, c = 0, d = 0): void {
    this.setAt(0, a, b, c, d);
  }

  /** Sets instance `index`'s value. Numbers past the value's size are left out. */
  setAt(index: number, a: number, b = 0, c = 0, d = 0): void {
    const { offset, size, shared } = this.#place;
    const values = shared ? this.#run.shared : this.#run.values;
    const at = shared ? offset : index * this.#stride + offset;
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
  readonly offset: number;
  readonly size: number;
  readonly shared: boolean;
}

/** What a run tells its batch: that something in it changed, or that it paints in a new place. */
interface BatchNotes {
  changed(): void;
  moved(): void;
}

/** Where each of `fields` sits, in order. */
function placesOf(fields: BatchFields, shared: boolean): FieldPlace[] {
  let offset = 0;
  return Object.entries(fields).map(([name, size]) => {
    const place = { name, offset, size, shared };
    offset += size;
    return place;
  });
}

/** How many numbers `fields` take. */
function total(fields: BatchFields): number {
  return Object.values(fields).reduce((sum, size) => sum + size, 0);
}

/** Runs in the order they paint. */
function paintOrder(a: Pick<BatchRun, "order" | "added">, b: Pick<BatchRun, "order" | "added">): number {
  return a.order - b.order || a.added - b.added;
}

/** A flat square with corners from -1 to 1. */
function square(): BufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(SQUARE), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

/** How many instances a batch has room for at first; it doubles its room whenever it runs out. */
const INITIAL_CAPACITY = 64;
/** The square's corners, each x, y and z. */
const SQUARE = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
