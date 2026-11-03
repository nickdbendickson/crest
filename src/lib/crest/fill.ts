/**
 * FLDPLN-style flood fill (step 4 of the terrain-inundation plan, Nick, 2026-11-01). Lay the routed water surface
 * onto the terrain and spread it, turning the per-section stages from the router (routing.ts) into an inundation
 * depth grid.
 *
 * The channel cells along the traced centreline are seeded with the routed water-surface elevation (WSE) interpolated
 * by distance downstream. A max-heap then spreads outward, highest water first: a neighbour floods when the carried
 * water surface is above its ground, and the surface it carries falls with the distance travelled across the
 * floodplain at the reach's thalweg slope. The decay is lateral only — the down-channel drop is already in the routed
 * stages, and every channel cell is its own seed at its own routed WSE, so spreading never attenuates a second time
 * down the valley (Nick's review, 2026-11-01). Processing highest-water-first means water backs up into depressions
 * and spills over saddles into the next basin (no fixed corridor width stops it); the ground and the lateral decay
 * are what end the spread.
 *
 * The fill is a maximum-water-surface envelope, not a volume-routed flood, so it reports the water volume it lays
 * down and flags it against the volume the breach actually supplies: a flag, not an impossibility (Nick's review).
 *
 * Pure module (no DOM, no fetch). Metres throughout; the local frame (east/north from the dam) matches aoi.ts,
 * outline.ts and sections.ts.
 */

import type { DemGrid } from "./outline.ts";
import type { RoutedSection } from "./routing.ts";
import type { Centerline } from "./sections.ts";

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQ = 111320;
const kxOf = (lat: number) => M_PER_DEG_LON_EQ * Math.cos((lat * Math.PI) / 180);
const NODATA = -9999;
const ACRE_M2 = 4046.8564224;

export type FillOptions = {
  /** A cell is wet when the carried surface is at least this far above its ground (m). Default 0.03 (~0.1 ft). */
  minDepthM?: number;
  /** Floor on the lateral decay slope, so a flat reach still stops eventually (m/m). Default 0.0005. */
  slopeFloor?: number;
  /** Stop seeding/spreading past this many wet cells (a guard on a runaway flat fill). Default 4,000,000. */
  maxWetCells?: number;
  /** The water volume the breach supplies (m³); when given, the result flags a fill that lays down more. */
  availableVolumeM3?: number;
  /**
   * Cap each off-channel cell's depth at its seed's routed stage plus this margin (m). Off the channel the carried
   * surface pours into lower ground, so without a cap a 1 m channel stage makes many-metre-deep water wherever the
   * terrain falls away — the envelope's volume blows out while its footprint stays about right. Capping the floodplain
   * depth to the stage that fed it keeps the extent and takes out the spurious depth. Default Infinity (no cap).
   */
  maxFloodplainDepthM?: number;
  /**
   * Cap the fill at availableVolumeM3 instead of only flagging it. The heap spreads highest-water-first, so stopping
   * at the cap keeps the deepest, most connected water and trims the shallow far-spread fringe the volume can't
   * support. Default false (envelope + flag, the method as first agreed).
   */
  volumeLimit?: boolean;
  /**
   * Attribute every wet cell to the routed section whose channel seed carried its surface, and return the water
   * volume laid down per section (FillResult.sectionVolumeM3). Used by the volume-aware stage selection.
   */
  trackSections?: boolean;
  /**
   * Per-section storage budget (m³, one per routed section; implies trackSections). A cell whose section has already
   * laid down its budget stays dry and spreads no further, so each stretch of valley holds only the water the routed
   * wave carries there. The heap pops highest water first, so within a section the deep near-channel water is kept and
   * the far fringe is what the budget trims.
   */
  sectionBudgetM3?: number[];
  /**
   * Station cap: no cell's carried surface may exceed the routed WSE at its own nearest channel station (plus this
   * margin, m). Without it a near-dam surface spreads laterally off the channel and then runs down the valley at the
   * tiny lateral decay, holding an upstream stage over ground the routed water surface is far below. Default off.
   */
  stationCapM?: number;
};

export type FillResult = {
  width: number;
  height: number;
  /** Depth (m) per cell, 0 where dry. */
  depthM: Float32Array;
  /** Water-surface elevation (m) per cell, NaN where dry. */
  wseM: Float32Array;
  wetCells: number;
  floodedAc: number;
  /** Water volume laid down (m³). */
  volumeM3: number;
  /** True when volumeM3 exceeds the supplied availableVolumeM3 (the envelope is larger than the breach supports). */
  volumeFlag: boolean;
  /** The flood reached the DEM edge, so it would spread further than the DEM shows. */
  reachedEdge: boolean;
  /** Water volume (m³) laid down per routed section, when trackSections is set. */
  sectionVolumeM3?: Float64Array;
};

/** Binary max-heap of cell indices keyed by `key[k]` (highest first). */
class MaxHeap {
  private a: Int32Array;
  private key: Float64Array;
  size = 0;
  constructor(key: Float64Array, cap: number) {
    this.key = key;
    this.a = new Int32Array(Math.max(16, cap));
  }
  push(k: number) {
    const a = this.a;
    const key = this.key;
    if (this.size >= a.length) {
      const bigger = new Int32Array(a.length * 2);
      bigger.set(a);
      this.a = bigger;
    }
    let i = this.size++;
    const arr = this.a;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (key[arr[p]] >= key[k]) break;
      arr[i] = arr[p];
      i = p;
    }
    arr[i] = k;
  }
  pop(): number {
    const a = this.a;
    const key = this.key;
    const top = a[0];
    const last = a[--this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && key[a[c + 1]] > key[a[c]]) c++;
      if (key[a[c]] <= key[last]) break;
      a[i] = a[c];
      i = c;
    }
    a[i] = last;
    return top;
  }
}

/** Routed WSE and reach slope at a distance downstream, from the routed sections (clamped to the ends). */
function stageAt(sections: RoutedSection[], x: number): { wse: number; slope: number; sec: number } {
  if (x <= sections[0].x) return { wse: sections[0].wseM, slope: sections[0].slopeStage, sec: 0 };
  for (let i = 1; i < sections.length; i++)
    if (sections[i].x >= x) {
      const a = sections[i - 1];
      const b = sections[i];
      const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0;
      return { wse: a.wseM + t * (b.wseM - a.wseM), slope: a.slopeStage + t * (b.slopeStage - a.slopeStage), sec: t < 0.5 ? i - 1 : i };
    }
  const last = sections[sections.length - 1];
  return { wse: last.wseM, slope: last.slopeStage, sec: sections.length - 1 };
}

/**
 * Fill the flood from the routed stages. Seeds the channel cells under the centreline with the routed WSE, then
 * spreads with the max-heap.
 */
export function fillFlood(
  g: DemGrid,
  line: Centerline,
  sections: RoutedSection[],
  opts: FillOptions = {},
): FillResult {
  const W = g.width;
  const H = g.height;
  const N = W * H;
  const minDepth = opts.minDepthM ?? 0.03;
  const slopeFloor = opts.slopeFloor ?? 0.0005;
  const maxWet = opts.maxWetCells ?? 4_000_000;
  const volumeCap =
    opts.volumeLimit && opts.availableVolumeM3 != null ? opts.availableVolumeM3 : Infinity;
  const kx = kxOf(line.loc.lat);
  const dlon = (g.bbox[2] - g.bbox[0]) / W;
  const dlat = (g.bbox[3] - g.bbox[1]) / H;
  const cellMx = dlon * kx;
  const cellMy = dlat * M_PER_DEG_LAT;
  const cellM = Math.min(cellMx, cellMy);
  const cellM2 = cellMx * cellMy;
  const valid = (k: number) => {
    const z = g.z[k];
    return Number.isFinite(z) && z > NODATA + 1 && z < 9000;
  };
  const cellAt = (e: number, n: number) => {
    const lon = line.loc.lon + e / kx;
    const lat = line.loc.lat + n / M_PER_DEG_LAT;
    const i = Math.floor((lon - g.bbox[0]) / dlon);
    const j = Math.floor((g.bbox[3] - lat) / dlat);
    return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i;
  };

  const wse = new Float64Array(N).fill(-Infinity);
  const srcSlope = new Float64Array(N);
  // The routed stage (m above bed) at each cell's seed, carried with the surface so a floodplain cell's depth can be
  // capped to the channel depth that fed it (plus the margin). Seeded cells get the section's stage; spread copies it.
  const srcStage = new Float64Array(N);
  const stageCap = opts.maxFloodplainDepthM ?? Infinity;
  const heap = new MaxHeap(wse, Math.max(1024, Math.ceil(N / 8)));
  const seeded = new Uint8Array(N);
  const budgetBySec = opts.sectionBudgetM3;
  const srcSec = opts.trackSections || budgetBySec ? new Int32Array(N).fill(-1) : null;
  const sectionVolumeM3 = opts.trackSections || budgetBySec ? new Float64Array(sections.length) : undefined;

  // Seed every channel cell with its routed WSE (interpolated along the centreline). Sub-sample the centreline so a
  // step longer than the cell still seeds every cell it crosses.
  const pts = line.pts;
  for (let p = 0; p + 1 < pts.length; p++) {
    const a = pts[p];
    const b = pts[p + 1];
    const segM = Math.hypot(b.e - a.e, b.n - a.n);
    const steps = Math.max(1, Math.ceil(segM / (cellM * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const e = a.e + f * (b.e - a.e);
      const n = a.n + f * (b.n - a.n);
      const x = a.x + f * (b.x - a.x);
      const k = cellAt(e, n);
      if (k < 0 || !valid(k) || seeded[k]) continue;
      const st = stageAt(sections, x);
      // Seed with the routed surface even where it sits below the DEM ground at the channel cell (a reach the 10 m
      // DEM reads cut-in): its neighbours may be lower and flood, carrying this surface.
      if (st.wse > wse[k]) {
        wse[k] = st.wse;
        srcSlope[k] = Math.max(slopeFloor, st.slope);
        srcStage[k] = st.wse - g.z[k];
        if (srcSec) srcSec[k] = st.sec;
        seeded[k] = 1;
        heap.push(k);
      }
    }
  }

  const depthM = new Float32Array(N);
  const outWse = new Float32Array(N).fill(NaN);
  let wetCells = 0;
  let volumeM3 = 0;
  let reachedEdge = false;
  const done = new Uint8Array(N);
  const DI = [1, -1, 0, 0, 1, 1, -1, -1];
  const DJ = [0, 0, 1, -1, 1, -1, 1, -1];

  // Station cap: a multi-source BFS from the seeded channel cells gives every cell the station (x down the channel) of
  // its nearest seed, and with it the routed WSE there.
  let capWse: Float64Array | null = null;
  if (opts.stationCapM != null) {
    const seedX = new Float64Array(N).fill(NaN);
    for (let p = 0; p + 1 < pts.length; p++) {
      const a = pts[p];
      const b = pts[p + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / (cellM * 0.5)));
      for (let s2 = 0; s2 <= steps; s2++) {
        const f = s2 / steps;
        const k = cellAt(a.e + f * (b.e - a.e), a.n + f * (b.n - a.n));
        if (k >= 0 && Number.isNaN(seedX[k])) seedX[k] = a.x + f * (b.x - a.x);
      }
    }
    const q = new Int32Array(N);
    let qh = 0;
    let qt = 0;
    for (let k = 0; k < N; k++) if (!Number.isNaN(seedX[k])) q[qt++] = k;
    while (qh < qt) {
      const c = q[qh++];
      const ci = c % W;
      const cj = (c - ci) / W;
      for (let t = 0; t < 4; t++) {
        const ii = ci + (t === 0 ? 1 : t === 1 ? -1 : 0);
        const jj = cj + (t === 2 ? 1 : t === 3 ? -1 : 0);
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
        const m = jj * W + ii;
        if (!Number.isNaN(seedX[m])) continue;
        seedX[m] = seedX[c];
        q[qt++] = m;
      }
    }
    capWse = new Float64Array(N);
    for (let k = 0; k < N; k++) capWse[k] = Number.isNaN(seedX[k]) ? Infinity : stageAt(sections, seedX[k]).wse + opts.stationCapM;
  }

  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    const surf = wse[c];
    const cap = Number.isFinite(stageCap) ? Math.max(0, srcStage[c]) + stageCap : Infinity;
    const d = Math.min(surf - g.z[c], cap);
    if (budgetBySec && srcSec && sectionVolumeM3 && srcSec[c] >= 0 && d >= minDepth) {
      const sc = srcSec[c];
      if (sectionVolumeM3[sc] + d * cellM2 > budgetBySec[sc]) continue; // this stretch's water is used up
    }
    if (d >= minDepth) {
      depthM[c] = d;
      outWse[c] = surf;
      wetCells++;
      volumeM3 += d * cellM2;
      if (srcSec && sectionVolumeM3 && srcSec[c] >= 0) sectionVolumeM3[srcSec[c]] += d * cellM2;
      if (wetCells > maxWet) break;
      // Volume-limited fill: once the laid-down volume reaches what the breach supplies, stop. The heap pops highest
      // water first, so every cell still queued carries a lower surface than this one — stopping trims the shallow,
      // far-spread fringe and keeps the deepest water.
      if (volumeM3 >= volumeCap) break;
    }
    const ci = c % W;
    const cj = (c - ci) / W;
    if (ci === 0 || cj === 0 || ci === W - 1 || cj === H - 1) {
      if (d >= minDepth) reachedEdge = true;
      continue;
    }
    for (let t = 0; t < 8; t++) {
      const m = (cj + DJ[t]) * W + ci + DI[t];
      if (done[m] || !valid(m)) continue;
      const stepLen = DI[t] !== 0 && DJ[t] !== 0 ? cellM * Math.SQRT2 : cellM;
      // Carried surface falls laterally at the reach slope; the down-channel drop is already in the routed stages.
      let carried = surf - srcSlope[c] * stepLen;
      if (capWse && carried > capWse[m]) carried = capWse[m];
      if (carried - g.z[m] < minDepth) continue; // not deep enough here to spread into
      if (carried > wse[m]) {
        wse[m] = carried;
        srcSlope[m] = srcSlope[c];
        srcStage[m] = srcStage[c];
        if (srcSec) srcSec[m] = srcSec[c];
        heap.push(m);
      }
    }
  }

  const floodedAc = (wetCells * cellM2) / ACRE_M2;
  const volumeFlag = opts.availableVolumeM3 != null && volumeM3 > opts.availableVolumeM3;
  return {
    width: W,
    height: H,
    depthM,
    wseM: outWse,
    wetCells,
    floodedAc,
    volumeM3,
    volumeFlag,
    reachedEdge,
    sectionVolumeM3,
  };
}
