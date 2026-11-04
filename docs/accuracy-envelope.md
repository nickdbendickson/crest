# Crest accuracy envelope (trust map)

**Scored 2026-11-04 on `main` 6bb9869** (after #63: demand-driven reach + exhausted-stretch cap). Layer scored: the
routed volume spread (`score-routed.mjs --spread`, reach on), the layer the desk builds for routed dams. The depth-shape
fix for flat plains is not in this build; re-score when it lands (see "Keeping this current").

Crest is a **screening** stand-in. The ND Breach Runner (LISFLOOD-FP 2-D) is the layer of record. This page says where
a Crest footprint is good enough to screen with and where it is not, so nobody has to guess.

## The trust map

| Terrain class | How Crest's own run tells you | Baseline dam | CSI 0.1 ft | CSI 1 ft | Confidence | Use |
|---|---|---|---|---|---|---|
| **Confined valley or closed basin** | flood ends in a basin or is contained in 0 reach rounds; no incomplete alert | DWR-3034 Wachter Ranch 11 | 0.70 | **0.63** | **High** | Screen with Crest. Precision 96–97 %: what it floods, floods. |
| **Incised valley, moderate release** | contained after the reach grows (no incomplete alert) | DWR-2865 Van Osting | 0.30 | **0.31** | **Medium** | Screen, but read the footprint as a *minimum*: recall 41–50 %, depth 1–2 ft shallow. A receptor just outside it is not cleared. |
| **Tiny pool, thin sheet** (release ≲ 10 ac-ft) | release in ac-ft is small; contained in 0 rounds | DWR-4031 Ward County | 0.35 | **0.10** | **Extent medium, depth low** | Use for "is anything in reach". Do not use the depth: only 8 ac of the Runner's flood is ≥ 1 ft deep, so one-foot depths are noise both ways. |
| **Flat multi-channel plain, large release** (2-D sheet flow) | **incomplete-downstream alert** (reach hit its round cap with water stranded at the edge) | DWR-2801 Swan Buffalo 12 (Absaraka) | 0.23 | **0.18** | **Low** | **Run the Runner.** Crest's footprint is the wrong shape there (pools deeper and narrower than the sheet), and the 2-D references disagree with each other too. |

**The one hard rule:** if the routed layer carries the *incomplete downstream* alert, the dam needs a Runner run. That
alert is the signal that separates the low-confidence class from the others on all four baselines.

**Per-dam triage uses these classes.** Crest's triage call (`src/lib/crest/triage.ts`, `CONFIDENCE_LABEL` /
`RECOMMENDATION_LABEL`) maps them to three confidence words: **High** = confined valley or closed basin, **Medium** =
open terrain (incised valley and tiny pool; read the footprint as a minimum, and on a tiny pool don't trust its
depths), **Low** = incomplete downstream. If a class name changes here, change those strings in the same PR. Design
and baseline results: project folder `crest-inundation/triage-2026-11-04/RESULTS.md`.

## Why 1 ft is the honest number

At 0.1 ft, a CSI mostly measures a thin sheet of water a few inches deep on a flat plain, and the refined 2-D models
do not agree with each other about that sheet. At 1 ft they mostly do. Scores between the 2-D references themselves on
DWR-2801, downstream half-plane only:

| Reference pair | CSI 0.1 ft | CSI 0.5 ft | CSI 1 ft | Source |
|---|---|---|---|---|
| LISFLOOD-FP (Oct 30, 30 m) vs ANUGA (30 m) | 0.46 | — | **0.58** | harness report `Crest_CSI_DWR-2801.docx`, 2026-11-03 |
| LISFLOOD-FP (baseline, 20 m) vs DSS-WISE (8 ft cells, unofficial) | 0.34 | 0.35 | **0.41** | this page (DSS-WISE averaged to 20 m; max-resampled: 0.36 / 0.37 / 0.43) |

So no single model is ground truth on a flat plain, and the 1 ft score is the one that is stable across references.
Quote the 1 ft CSI as the headline and the 0.1 ft CSI next to it, never the 0.1 ft one alone.

**Retire 0.35 as a floor.** Two refined 2-D models of DWR-2801 agree with each other at 0.34–0.46 at 0.1 ft. A fixed
0.35 bar would fail one accepted model against another. Judge Crest by class (table above) and, on flat plains,
against the spread between the references: Crest's 2801 score at 1 ft (0.18–0.21) is about a third to a half of the
model-to-model agreement (0.41–0.58). That gap is why the class is "Low", not the absolute number.

## Scores behind the map

All scores: `scripts/score-routed.mjs --spread --wet-ft <t>` on 6bb9869, downstream of the breach only, cell by cell on
the reference grid. Recall = share of the reference flood Crest caught; precision = share of Crest's flood that is
right; area ratio = Crest acres / reference acres; bias = Crest − reference depth where both are wet.

### Against LISFLOOD-FP (ND Breach Runner, `baseline-2026-11-01`, 20 m)

| Dam | Wet ≥ | Ref ac | Crest ac | CSI | Recall | Precision | Area ratio | Depth bias |
|---|---|---|---|---|---|---|---|---|
| DWR-3034 | 0.1 ft | 45 | 33 | 0.701 | 72 % | 97 % | 0.73 | −1.06 ft |
| | 1 ft | 42 | 29 | **0.633** | 65 % | 96 % | 0.68 | −0.88 ft |
| DWR-2865 | 0.1 ft | 256 | 201 | 0.295 | 41 % | 52 % | 0.78 | −1.08 ft |
| | 1 ft | 109 | 119 | **0.311** | 50 % | 46 % | 1.09 | −2.14 ft |
| DWR-4031 | 0.1 ft | 38 | 27 | 0.354 | 45 % | 62 % | 0.73 | +0.41 ft |
| | 1 ft | 8 | 11 | **0.101** | 22 % | 16 % | 1.42 | +1.16 ft |
| DWR-2801 | 0.1 ft | 6,144 | 4,071 | 0.227 | 31 % | 46 % | 0.66 | +1.33 ft |
| | 1 ft | 2,335 | 3,198 | **0.175** | 35 % | 26 % | 1.37 | +0.76 ft |

### DWR-2801 against every reference on file

| Reference | CSI 0.1 ft | CSI 1 ft | Notes |
|---|---|---|---|
| R1 LISFLOOD-FP, baseline-2026-11-01 (20 m; 6,144 ac wet ≥ 0.1 ft downstream) | 0.227 | 0.175 | the layer of record for these baselines |
| R3 DSS-WISE (unofficial, 8 ft cells; 3,165 ac wet ≥ 0.1 ft downstream) | 0.291 | 0.214 | recall 51–55 %, precision 27–38 %; Crest over-floods at 1 ft (1.9× area) |
| R2 ANUGA (Oct 30, 30 m; 5,334 ac wet ≥ 0.1 ft downstream) | 0.15 | 0.19 | **pre-#63** (main 56800ca, stand-in record, bearing 103°), from the harness report; not re-scored here because the raster is on Nick's workstation |

Two LISFLOOD-FP runs of 2801 exist and disagree: the 20 m baseline wets 6,948 ac, the Oct 30 30 m run wets 9,325 ac at
0.1 ft (+34 %, same model). That spread is itself thin-sheet extent, which is another reason to headline 1 ft.

### What the classes are reading

- **Confined / basin (3034):** the valley walls or a road fill decide the footprint; a level-pool spread gets that
  right. Stable across thresholds.
- **Incised, moderate (2865):** stable across thresholds (0.30/0.31) but recall is the weak side: Crest under-floods and
  runs 1–2 ft shallow. Its record is a stand-in (crest read from 3DEP, synthesized dam line), so its depth bias is soft.
- **Tiny pool (4031):** 6.9 ac-ft makes a 2.5 ft sheet. The extent at 0.1 ft is fair; at 1 ft there are only 8 ac to
  score, so a few cells swing the number. The TM 11 zone still agrees at 337 of 380 receptor points.
- **Flat plain (2801):** the reach fix put Crest's flood in the right place (Runner flood outside Crest's terrain fell
  from 2,334 ac to 1 ac) but the shape is wrong: 79 % of Crest's wet area is ≥ 1 ft deep against 38 % of the Runner's.
  The Runner spreads a thin sheet; the spread stacks the same volume on a narrower strip. At 1 ft that costs precision
  (26 %), which is why the reach fix *lowered* the 1 ft score (0.203 → 0.175) while raising the 0.1 ft one.

## Limits of this envelope

- **Four dams.** One dam per class. The classes are the right shape but the numbers are not statistics; add baselines
  (another flat-plain dam and another incised valley first) before reading second decimals.
- **References are models, not observations.** No dam here has a surveyed flood. On flat plains the references
  disagree by up to ~2× in area.
- **Stand-in records** for 2865 and 3034 (crest from 3DEP at the dam point, dam line synthesized). 2801 and 4031 are
  surveyed.
- **The 2801 reference may move.** A Runner grid-convergence run (20 / 10 / 5 m on one fixed domain) is in progress; if
  the 20 m thin sheet shrinks at finer grids, 2801's R1 changes and so does Crest's score against it.
- **Mask.** Downstream half-plane from the dam point along the record's bearing (107° for 2801). A badly wrong bearing
  on a bent outlet can drop or add cells.

## Keeping this current

Re-score all four dams at both thresholds whenever the spread, the reach, or a baseline record changes, and update the
tables here in the same PR:

```
node --experimental-strip-types scripts/score-routed.mjs --dam <record.json> --runner <dam folder or reference tif> \
  --spread --wet-ft 0.1 --json out-0.1.json
node --experimental-strip-types scripts/score-routed.mjs --dam <record.json> --runner <dam folder or reference tif> \
  --spread --wet-ft 1 --json out-1.json
```

Baseline records and LISFLOOD-FP rasters: project folder `crest-inundation/baseline-2026-11-01/<dam>/`. Score files
for this page and the model-to-model script: `crest-inundation/accuracy-envelope-2026-11-04/`. Cite a CSI only with
its reference, threshold, record, and scorer commit.

### Provenance

| Item | Value |
|---|---|
| Scorer | `nickdbendickson/crest` `main` 6bb9869, `score-routed.mjs --spread` (reach on) |
| R1 LISFLOOD-FP 2801 | `baseline-2026-11-01/DWR-2801/Depth (Max).tif`, sha256 `e89a67b6…c64c8fe` |
| R3 DSS-WISE 2801 | `119062_Hmax_ft_upto_final.tif`, sha256 `25fd0d88…58ddc9a2` |
| R2 ANUGA 2801 | Nick's workstation `hz2210_classify_20261030T1948Z/Dams/DWR-2801/_breach_model/anuga_hmax_ft.tif` (not in this run) |
| Records | `baseline-2026-11-01/<dam>/<dam>_record.json` |
