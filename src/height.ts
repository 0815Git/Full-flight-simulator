/**
 * CPU-side height grids for `groundHeight` queries. 128 KB per 256² tile
 * (uint16) vs 256 KB for a retained RGBA image.
 */
import type { TerrainAnchor, WorldConfig } from './config';
import { keyId, type Vec3Like } from './lod';
import type { RgbaImage } from './synth';

/**
 * `round(height_m) + 32768` per texel — integer-meter resolution (the
 * Terrarium source is only meter-accurate; bilinear sampling smooths it).
 */
export class HeightGrid {
  constructor(
    /** Grid width in texels (matches the source heightmap). */
    public readonly w: number,
    /** Grid height in texels. */
    public readonly h: number,
    /** Row-major samples, encoded `round(height_m) + 32768`. */
    public readonly samples: Uint16Array,
  ) {}

  /**
   * Decode a Terrarium heightmap into a grid (quantized to whole meters — the
   * source data is only meter-accurate; {@link sample} interpolates).
   */
  static fromTerrarium(img: RgbaImage): HeightGrid {
    const n = img.width * img.height;
    const samples = new Uint16Array(n);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const h = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
      const v = Math.round(h) + 32768;
      samples[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    }
    return new HeightGrid(img.width, img.height, samples);
  }

  /**
   * Bilinear sample at normalized (u, v) ∈ [0, 1]; texel centers at
   * (i + 0.5)/n, edges clamped. Returns meters.
   */
  sample(u: number, v: number): number {
    const w = this.w;
    const h = this.h;
    const s = (x: number, y: number): number => {
      const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
      const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
      return this.samples[cy * w + cx];
    };
    const fx = u * w - 0.5;
    const fy = v * h - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = s(x0, y0) * (1 - tx) + s(x0 + 1, y0) * tx;
    const bot = s(x0, y0 + 1) * (1 - tx) + s(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bot * ty - 32768;
  }
}

/** All resident tiles' height grids, keyed by {@link keyId}. */
export type HeightGrids = Map<string, HeightGrid>;

/**
 * Terrain altitude under `pos` (user space): walks zooms finest→coarsest and
 * samples the first resident grid containing the XZ point. O(zoom levels).
 * Returns `undefined` when no resident tile covers the point.
 */
export function groundHeight(
  grids: HeightGrids,
  world: WorldConfig,
  anchor: TerrainAnchor,
  pos: Vec3Like,
): number | undefined {
  const ax = pos.x - anchor.worldOffset.x;
  const az = pos.z - anchor.worldOffset.z;
  for (let zoom = world.maxZoom; zoom >= world.baseZoom; zoom--) {
    const size = world.tileSize / 2 ** (zoom - world.baseZoom);
    const tx = Math.floor(ax / size);
    const tz = Math.floor(az / size);
    const grid = grids.get(keyId({ zoom, x: tx, z: tz }));
    if (grid) {
      const u = (ax - tx * size) / size;
      const v = (az - tz * size) / size;
      return grid.sample(u, v);
    }
  }
  return undefined;
}

/** How a {@link sightBlocked} walk is run. */
export interface SightOptions {
  /** How many places along the line are asked. More is finer and dearer;
   *  192 over 30 km is a reading every 150 m. Default 192. */
  steps?: number;
  /** How far the ground must rise ABOVE the straight line before it counts
   *  as being in the way, in meters. Far off, the resident tile is a coarse
   *  one and a hilltop can read tens of meters out, so a little slack here
   *  keeps a clear sight from blinking shut. Default 0. */
  overBy?: number;
  /** A stretch at the EYE end left out of the walk, in meters: flying low,
   *  the ground a few paces ahead is always near the line and is never what
   *  hides something 30 km off. Default 0. */
  skipNear?: number;
  /** A stretch at the FAR end left out of the walk, in meters. Default 0. */
  skipFar?: number;
}

/**
 * Is the ground in the way between `eye` and `at` (both user space)?
 *
 * The straight line between the two is walked, and at each place along it the
 * terrain's own height is asked for and set against the height of the line
 * there. Ground standing above the line means the one point cannot be seen
 * from the other.
 *
 * Where NO tile covers a place, nothing is known about the ground there and
 * it is taken as not being in the way — so a sight line does not close
 * merely because the landscape it crosses has not been fetched yet.
 */
export function sightBlocked(
  grids: HeightGrids,
  world: WorldConfig,
  anchor: TerrainAnchor,
  eye: Vec3Like,
  at: Vec3Like,
  opts: SightOptions = {},
): boolean {
  const dx = at.x - eye.x;
  const dy = at.y - eye.y;
  const dz = at.z - eye.z;
  const span = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(span > 0)) return false;
  const steps = Math.max(1, Math.floor(opts.steps ?? 192));
  const over = opts.overBy ?? 0;
  const from = Math.min(0.5, Math.max(0, (opts.skipNear ?? 0) / span));
  const to = Math.max(from, 1 - Math.min(0.5, Math.max(0, (opts.skipFar ?? 0) / span)));
  const p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    p.x = eye.x + dx * t;
    p.y = eye.y + dy * t;
    p.z = eye.z + dz * t;
    const ground = groundHeight(grids, world, anchor, p);
    if (ground === undefined) continue;
    if (ground > p.y + over) return true;
  }
  return false;
}
