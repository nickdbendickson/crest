import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

import { analyze, damLocation } from "./engine.ts";
import { volumeCheck } from "./inundation.ts";
import {
  bowlM3,
  buildOutline,
  channelPitBudget,
  channelPitsNote,
  type DemGrid,
  SMALL_RELEASE_ACFT,
  SMALL_RELEASE_LABEL,
  smallRelease,
  TRACE_VERSION,
  VOLUME_SHRINK_ABOVE,
  VOLUME_TARGET_RATIO,
  volumeLimitNote,
} from "./outline.ts";
import { SAMPLE_DAMS } from "./samples.ts";
import type { DamRecord } from "./types.ts";

// The ND00199 3DEP fixture (30 m), as outline.test.ts uses it.
const fx = (name: string) => new URL(`./__fixtures__/${name}`, import.meta.url);
const META = JSON.parse(readFileSync(fx("dem3dep_nd00199_30m.json"), "utf8"));
const U16 = new Uint16Array(new Uint8Array(gunzipSync(readFileSync(fx("dem3dep_nd00199_30m.u16cm.gz")))).buffer);
const DEM: DemGrid = { bbox: META.bbox, width: META.width, height: META.height, cellM: META.cellM, z: Float32Array.from(U16, (v) => v / 100 + 250) };
const ND = SAMPLE_DAMS.find((d) => d.nid === "ND00199")!;
const NOW = new Date("2026-11-03T20:30:00-06:00");
const ACRE_FT_M3 = 1233.48184;

/** ND00199 with its storage (the released volume) set to `acFt`. */
const withRelease = (acFt: number): DamRecord => ({ ...ND, storageAcFt: acFt });
async function build(dam: DamRecord, g: DemGrid = DEM) {
  const result = analyze(dam);
  const b = await buildOutline(dam, result, g, { builtAt: NOW });
  assert.ok(b.ok, b.ok ? "" : b.reason);
  return { result, released: result.breach.volumeAcFt, stats: b.cache.stats, outline: b.cache.outline, centerline: b.centerline };
}

describe("volume soft limit: about 5× the release (Nick, 2026-11-03)", () => {
  it("the target and the trigger are 5× and 6×, and saved layers rebuild (trace version 5)", () => {
    assert.equal(VOLUME_TARGET_RATIO, 5);
    assert.equal(VOLUME_SHRINK_ABOVE, 6);
    assert.equal(TRACE_VERSION, 5);
  });

  it("inside the band (2.4× on the full ND00199 release) the outline is left as the desk lays it", async () => {
    const { stats, released } = await build(ND);
    const ratio = stats.laidAcFt! / released;
    assert.ok(ratio > 2 && ratio < VOLUME_SHRINK_ABOVE, String(ratio));
    assert.equal(stats.volumeLimit, undefined);
    assert.equal(stats.volumeLabel, undefined);
    const vc = volumeCheck(stats.laidAcFt, released, {})!;
    assert.equal(vc.warn, false);
    assert.equal(vc.label, null);
  });

  for (const acFt of [300, 100]) {
    it(`over 6× (${acFt} ac-ft released) it lowers the water surface until the outline lays about 5×`, async () => {
      const { stats, released, outline } = await build(withRelease(acFt));
      const v = stats.volumeLimit;
      assert.ok(v, "the limit applied");
      // As first laid it was over the trigger…
      assert.ok(v.rawLaidAcFt / released > VOLUME_SHRINK_ABOVE, String(v.rawLaidAcFt / released));
      // …and now it lays about 5×, never over it.
      const ratio = stats.laidAcFt! / released;
      assert.ok(ratio <= VOLUME_TARGET_RATIO + 0.01 && ratio >= 0.9 * VOLUME_TARGET_RATIO, String(ratio));
      // Depth and extent shrink together: one factor on the desk depths, a smaller wet area.
      assert.ok(v.depthScale > 0 && v.depthScale < 1, String(v.depthScale));
      assert.ok(stats.wetCellAc < v.rawWetAc, `${stats.wetCellAc} vs ${v.rawWetAc}`);
      // The 2–6× warning stays on, saying the layer was limited, and the note says by how much.
      const vc = volumeCheck(stats.laidAcFt, released, { rawLaidAcFt: v.rawLaidAcFt })!;
      assert.equal(vc.warn, true);
      assert.match(vc.text, /Volume-limited: as first laid it held [\d,]+ ac-ft \(\d+\.\d×, above 6×\), so its water surface was lowered to about 5×/);
      const note = volumeLimitNote(stats, released)!;
      assert.match(note, new RegExp(`lowered to ${Math.round(v.depthScale * 100)} % of the desk depths, aiming for about 5×`));
      assert.ok(outline.properties.volume_limit?.startsWith("Volume-limited:"));
    });
  }

  it("a smaller release lowers the surface further", async () => {
    const a = await build(withRelease(300));
    const b = await build(withRelease(100));
    assert.ok(b.stats.volumeLimit!.depthScale < a.stats.volumeLimit!.depthScale);
    assert.ok(b.stats.outlineAc < a.stats.outlineAc);
  });

  it("the warning without the limit is unchanged", () => {
    const over = volumeCheck(2130, 167)!;
    assert.ok(over.warn && /Above 6×/.test(over.text));
    assert.equal(volumeCheck(310, 71)!.warn, false);
    // A limited layer whose first lay was inside the band is not called limited.
    assert.equal(volumeCheck(310, 71, { rawLaidAcFt: 400 })!.warn, false);
  });
});

describe('releases under 25 ac-ft: "volume-limited, run the Runner"', () => {
  it("labels by the release alone", () => {
    assert.equal(SMALL_RELEASE_ACFT, 25);
    assert.equal(SMALL_RELEASE_LABEL, "volume-limited, run the Runner");
    assert.equal(smallRelease(6.9), true);
    assert.equal(smallRelease(24.9), true);
    assert.equal(smallRelease(25), false);
    assert.equal(smallRelease(167), false);
    assert.equal(smallRelease(0), false);
    assert.equal(smallRelease(Number.NaN), false);
    assert.equal(volumeCheck(34, 6.9)!.label, SMALL_RELEASE_LABEL);
    assert.equal(volumeCheck(120, 25)!.label, null);
    // Small releases read to a tenth of an ac-ft, not rounded to 7.
    assert.match(volumeCheck(34, 6.9)!.text, /for 6\.9 ac-ft released \(4\.9×\)/);
  });

  it("an outline built on a 20 ac-ft release carries the label on its stats and its export", async () => {
    const { stats, outline } = await build(withRelease(20));
    assert.equal(stats.volumeLabel, SMALL_RELEASE_LABEL);
    assert.equal(outline.properties.volume_label, SMALL_RELEASE_LABEL);
    const big = await build(withRelease(100));
    assert.equal(big.stats.volumeLabel, undefined);
    assert.equal(big.outline.properties.volume_label, undefined);
  });
});

describe("channel pits count only up to the release (Nick, 2026-11-03)", () => {
  const cellM2 = 100;
  // Two pits in channel order: 1 m and 2 m deep, 10 and 5 cells: bowls of 1000 m³ each.
  const p1 = { z: Array(10).fill(9), spill: Array(10).fill(10) };
  const p2 = { z: Array(5).fill(8), spill: Array(5).fill(10) };

  it("a large release counts every pit in full", () => {
    assert.equal(bowlM3(p1, 10, cellM2), 1000);
    const b = channelPitBudget([p1, p2], 5000, cellM2);
    assert.equal(b.stop, null);
    assert.equal(b.storageM3, 2000);
    assert.equal(b.countedM3, 2000);
    assert.equal(channelPitBudget([p1, p2], Infinity, cellM2).countedM3, 2000);
  });

  it("a small release fills the pits upstream first and runs out in the next, at the level it reaches", () => {
    const b = channelPitBudget([p1, p2], 1500, cellM2);
    assert.ok(b.stop);
    assert.equal(b.stop.index, 1);
    assert.ok(Math.abs(b.stop.heldM3 - 500) < 1e-3, String(b.stop.heldM3));
    assert.ok(Math.abs(b.stop.levelM - 9) < 1e-6, String(b.stop.levelM)); // 500 m³ over 5 cells of 100 m²: 1 m up from 8 m
    assert.ok(Math.abs(b.countedM3 - 1500) < 1e-3);
    assert.equal(b.storageM3, 2000);
    // Not even the first pit fills: it holds the whole release.
    const tiny = channelPitBudget([p1, p2], 400, cellM2);
    assert.equal(tiny.stop?.index, 0);
    assert.ok(Math.abs(tiny.countedM3 - 400) < 1e-3);
  });

  it("the desk note says where the release runs out", () => {
    assert.match(
      channelPitsNote({ channelPits: { pits: 3, storageAcFt: 35, countedAcFt: 6.9, stop: { pitAcFt: 9.7, heldAcFt: 6.5, atKm: 0.437 } } })!,
      /runs through 3 pits holding 35 ac-ft below their spill levels; they take their storage out of the release before the flood moves on downstream\. The release runs out in the pit at 0\.44 km \(it fills 6\.5 of its 9\.7 ac-ft\), so the outline stops there\./,
    );
    assert.match(channelPitsNote({ channelPits: { pits: 1, storageAcFt: 2, countedAcFt: 2 } })!, /runs through 1 pit .* The release fills them all \(2\.0 ac-ft counted in full\)\./);
    assert.equal(channelPitsNote({}), null);
  });

  // A pit dug into the traced channel `x` m down: 5 × 5 cells (30 m) lowered 4 m, about 73 ac-ft of bowl.
  const dug = async (x: number) => {
    const base = await build(withRelease(300));
    const pt = base.centerline.pts.find((p) => p.x > x)!;
    const loc = damLocation(ND)!;
    const kx = 111320 * Math.cos((loc.lat * Math.PI) / 180);
    const dlon = (DEM.bbox[2] - DEM.bbox[0]) / DEM.width;
    const dlat = (DEM.bbox[3] - DEM.bbox[1]) / DEM.height;
    const i = Math.round((pt.e / kx + loc.lon - DEM.bbox[0]) / dlon - 0.5);
    const j = Math.round((DEM.bbox[3] - (pt.n / 110574 + loc.lat)) / dlat - 0.5);
    const z = Float32Array.from(DEM.z);
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) z[(j + dj) * DEM.width + i + di] -= 4;
    return { g: { ...DEM, z }, atKm: pt.x / 1000 };
  };

  it("on terrain: a large release counts the dug pit in full and the flood runs on past it", async () => {
    const { g, atKm } = await dug(3000);
    const plain = await build(ND);
    const big = await build(ND, g);
    const c = big.stats.channelPits!;
    assert.equal(c.stop, undefined);
    assert.equal(c.countedAcFt, c.storageAcFt);
    // The dug bowl (25 × 900 m² × 4 m ≈ 73 ac-ft, less what the natural ground there already held) is now counted.
    const added = c.storageAcFt - plain.stats.channelPits!.storageAcFt;
    assert.ok(added > 40 && added < (25 * 900 * 4.5) / ACRE_FT_M3, String(added));
    assert.ok(big.stats.reachKm! > atKm + 3, `${big.stats.reachKm} vs pit at ${atKm}`);
  });

  it("on terrain: a small release is used up in the dug pit and the outline stops there", async () => {
    const { g, atKm } = await dug(1200);
    const small = await build(withRelease(50), g);
    const c = small.stats.channelPits!;
    assert.ok(c.stop, JSON.stringify(c));
    assert.ok(Math.abs(c.stop.atKm - atKm) < 0.3, `${c.stop.atKm} vs ${atKm}`);
    assert.ok(c.stop.heldAcFt < c.stop.pitAcFt);
    // The pits hold the release, no more.
    assert.ok(Math.abs(c.countedAcFt - small.released) < 0.01, `${c.countedAcFt} vs ${small.released}`);
    // Nothing downstream of the pit is wet (the corridor spreads a cell's water a little way from the channel).
    assert.ok(small.stats.reachKm! < atKm + 0.5, `${small.stats.reachKm} vs ${atKm}`);
    // The same release on the undug ground runs on past it.
    const plain = await build(withRelease(50));
    assert.equal(plain.stats.channelPits!.stop, undefined);
    assert.ok(plain.stats.reachKm! > atKm + 0.5, `${plain.stats.reachKm} vs ${atKm}`);
  });
});
