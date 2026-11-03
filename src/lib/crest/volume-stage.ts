/**
 * Volume-aware stage selection for the routed terrain fill (Lumo's review of the flood-size gate, 2026-11-03).
 *
 * fill.ts seeds every channel cell with the routed Manning peak stage and floods to it with no volume accounting, so
 * on a small flood it pours a stage the breach can't supply into every low the surface can reach (the four-dam
 * baseline laid down 5–5,000× the released volume). This module picks, for each routed section, the highest water
 * surface at or below the Manning peak whose fill the routed wave can actually hold.
 *
 * Budget (the time question, Lumo Q12): MC routing with frozen coefficients conserves volume, so the volume that
 * passes every section is the whole released volume — the same number everywhere, not a per-section limit. What does
 * vary by section is how much water the wave holds in that stretch of valley at its peak: the routed peak flow area
 * times the section's share of the channel length (A*dx, the MC reach storage K·Q at the peak). That is an
 * instantaneous storage at the section's own peak time, so the bound is time-consistent per slice; the result is
 * still an envelope of slices that peak at different times.
 *
 * Footprint (Lumo Q13): iterate. Each pass runs the full fill, attributes every wet cell to the section whose seed
 * carried its surface, and bisects the stage of each section whose footprint holds more than its budget. A big flood
 * whose fill fits its budget everywhere comes out unchanged; a small one self-limits.
 *
 * Pure module (no DOM, no fetch). Metres throughout.
 */

import { type FillOptions, type FillResult, fillFlood } from "./fill.ts";
import type { DemGrid } from "./outline.ts";
import type { RoutedSection } from "./routing.ts";
import type { Centerline } from "./sections.ts";

export type VolumeStageOptions = {
  /** Bisection passes (each one full fill). Default 14 (~1 mm on a 15 m bracket). */
  iterations?: number;
  /** Multiplier on each section's storage budget (1 = the MC reach storage K*Qpeak). Default 1. */
  budgetFactor?: number;
  /**
   * "stage": lower each section's surface (Lumo's proposal). "spread": keep the Manning stage and stop each section's
   * spread once it has laid down its budget. Default "stage".
   */
  mode?: "stage" | "spread";
};

export type VolumeStageResult = {
  /** The sections with the volume-supported water surface (wseM/stageM lowered where the budget bound). */
  sections: RoutedSection[];
  fill: FillResult;
  /** Storage budget per section (m³). */
  budgetM3: number[];
  /** Sections whose stage was lowered below the Manning peak. */
  lowered: number;
  /** Total storage budget over the reach (m³). */
  totalBudgetM3: number;
};

/**
 * The wave's mean celerity down the reach (m/s), from the routed peak times: channel length over the time the peak
 * takes to travel it. Clamped to 0.2–10 m/s so a reach with no clean peak travel still gets a usable number.
 */
export function waveCelerity(sections: RoutedSection[]): number {
  const a = sections[0];
  const b = sections[sections.length - 1];
  const dt = b.tPeakS - a.tPeakS;
  const c = dt > 0 ? (b.x - a.x) / dt : 10;
  return Math.min(10, Math.max(0.2, c));
}

/**
 * Per-section storage budget: the Muskingum-Cunge reach storage at the routed peak, K*Qpeak with K = Δx / c — the
 * water the wave holds in that stretch at its peak. Not the section table's flow area: on a section that can't carry
 * the peak ("capped") that is the whole cut table, which would let the fill keep its invented spread.
 */
export function sectionBudgets(sections: RoutedSection[], factor = 1): number[] {
  const n = sections.length;
  const c = waveCelerity(sections);
  return sections.map((s, j) => {
    const xa = j > 0 ? sections[j - 1].x : s.x;
    const xb = j < n - 1 ? sections[j + 1].x : s.x;
    const dx = n > 1 ? (xb - xa) / (j > 0 && j < n - 1 ? 2 : 1) : 1;
    return (Math.max(0, s.peakCms) * Math.max(0, dx) * factor) / c;
  });
}

/** Fill with the volume-aware stage per section. */
export function volumeAwareFill(
  g: DemGrid,
  line: Centerline,
  routed: RoutedSection[],
  fillOpts: FillOptions = {},
  opts: VolumeStageOptions = {},
): VolumeStageResult {
  if (opts.mode === "spread") {
    const budgetM3 = sectionBudgets(routed, opts.budgetFactor ?? 1);
    const fill = fillFlood(g, line, routed, { ...fillOpts, volumeLimit: false, sectionBudgetM3: budgetM3 });
    const vol = fill.sectionVolumeM3!;
    const lowered = budgetM3.reduce((a, b, j) => a + (vol[j] >= 0.98 * b ? 1 : 0), 0);
    return { sections: routed, fill, budgetM3, lowered, totalBudgetM3: budgetM3.reduce((a, b) => a + b, 0) };
  }
  const n = routed.length;
  const iters = opts.iterations ?? 14;
  const budget = sectionBudgets(routed, opts.budgetFactor ?? 1);
  const lo = routed.map((s) => s.bedM);
  const hi = routed.map((s) => s.wseM);
  const feasible = routed.map((s) => s.bedM); // highest surface seen inside the budget
  const bound = new Uint8Array(n);
  const withWse = (w: number[]) => routed.map((s, j) => ({ ...s, wseM: w[j], stageM: Math.max(0, w[j] - s.bedM) }));
  const run = (w: number[]) => fillFlood(g, line, withWse(w), { ...fillOpts, volumeLimit: false, trackSections: true });

  // Pass 0 at the Manning peak: sections inside their budget stay there unless a neighbour's lowering pushes them over.
  const cur = hi.slice();
  let f = run(cur);
  for (let it = 0; it < iters; it++) {
    const vol = f.sectionVolumeM3!;
    let changed = false;
    for (let j = 0; j < n; j++) {
      if (vol[j] > budget[j]) {
        bound[j] = 1;
        hi[j] = cur[j];
      } else {
        lo[j] = cur[j];
        feasible[j] = cur[j];
      }
      if (bound[j]) {
        const next = 0.5 * (lo[j] + hi[j]);
        if (Math.abs(next - cur[j]) > 1e-4) changed = true;
        cur[j] = next;
      }
    }
    if (!changed) break;
    f = run(cur);
  }
  // Finish on the last feasible surface of every section the budget bound (never above the Manning peak).
  const final = routed.map((s, j) => (bound[j] ? Math.min(s.wseM, feasible[j]) : s.wseM));
  const sections = withWse(final);
  const fill = fillFlood(g, line, sections, { ...fillOpts, volumeLimit: false, trackSections: true });
  return { sections, fill, budgetM3: budget, lowered: bound.reduce((a, b) => a + b, 0), totalBudgetM3: budget.reduce((a, b) => a + b, 0) };
}
