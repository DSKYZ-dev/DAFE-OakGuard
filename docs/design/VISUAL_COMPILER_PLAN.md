# Visual Compiler — Design Plan

**Status:** proposal, nothing implemented yet
**Scope:** automated visual layer for generated OakScript indicators (3D + enhanced 2D)
**Goal:** a user types "MA cross that tracks Fibonacci levels"; the editor returns a mathematically audited indicator *and* a visual built for that indicator's metrics, with no hand-authored 3D work and a real 2D twin when 3D is off.

---

## 1. Where the current design breaks

The engine already has more visual capability than the agent can use reliably:

- 15 `plot3d` styles (`surface, ribbon, bars3d, scatter, line3d, wireframe, mesh, helix, vortex, manifold, nebula, constellation, torus, trail, ridgeline`) — `apps/web/src/oakscript/builtins.ts:53`
- 4 rendering surfaces: Three.js main-chart takeover (`three-indicators.ts`), Three.js lower pane (`three-lower-pane.ts`), isometric canvas (`iso3d.ts`), 2D canvas (`chart-renderer.ts`)
- Animation presets by geometry class G1–G9 (`lower-manifold-adapter.ts:7`) and GPU/CPU particles (`gpu-particles.ts`)

Four structural problems, in order of severity:

1. **The appearance decision lives in the LLM's prose.** The coder pre-prompt carries the style catalogue, `z_level` stacking, the pane-exclusivity traps, and the "2D `plot()` does not render in 3D mode" rule (`apps/web/src/trade-advisor/agent.ts:15-59`, duplicated in `backend/main.py`). ~15k characters of visual law competing with the math rules for the same context budget. Output quality is therefore whatever style the model happened to pick under pressure — and it is not reproducible.
2. **3D and 2D are not two views of one design.** `main.ts` routes to `hasPane3d` / `is3DMode` / 2D as mutually exclusive paths. There is no 2D twin authored, so unticking 3D *deletes* the visual rather than degrading it. Same for the lower pane.
3. **Every new model needs new renderer code.** KNN hand-writes three lenses (`indicators.ts:978-995`); a self-invented model like VoVix would need its own bespoke geometry and its own prompt paragraph. Visuals do not scale with the model library.
4. **`plotshape` + `plotshape_3d` are duplicated by hand.** Pane mismatch is the single most common "renders nowhere" failure mode, and it is enforced only by a MANDATORY paragraph in the prompt.

Adding style #16 makes all four worse. The fix is to move the decision out of the prompt: **the model declares what a metric means; a deterministic compiler decides how it appears, per surface.**

---

## 2. Architecture

```
OakScript source
  ├── inputs / math / model calls        (unchanged)
  ├── expose(name, series, role)         → named, unit-normalized metrics
  └── viz(role, ...series, preset?)      → target-agnostic visual intent
                │
                ▼
        visual/compiler.ts               pure: (layers, series, profile) → VisualOp[]
                │
      ┌─────────┼─────────┬──────────────┐
      ▼         ▼         ▼              ▼
  toCanvas2D  toIso3D  toThreeScene   toMobile
```

Three artefacts:

| Piece | File | Nature |
|---|---|---|
| Metric contract | `visual/roles.ts` + `expose` builtin | closed vocabulary, unit normalization |
| Visual intent | `viz` builtin → `VisualLayer[]` on the runtime | declarative, no renderer names |
| Visual compiler | `visual/compiler.ts`, `visual/channels.ts` | pure function, golden-file testable |
| Lowerings | `visual/lowerings/*.ts` | same op list, four back ends |

`plot3d` / `plotshape_3d` / `label3d` remain exactly as they are, as the **advanced escape hatch**. All 13 existing models keep working byte-for-byte; `viz()` is additive.

---

## 3. Phase breakdown

Each phase is independently shippable and independently verifiable. Phase 0 is the only one that must not be skipped.

### Phase 0 — Spike behind a flag (~2–3 days)
**Deliverable:** two roles (`trend.ribbon`, `level.ladder`) compiled end-to-end in both 3D and 2D, rendered behind `?vizCompiler=1`.
- `visual/ops.ts` — the `VisualOp` union (below)
- `visual/roles.ts` — registry with only 2 entries
- `visual/channels.ts` — semantic channel table, only the channels those 2 roles use
- `visual/compiler.ts` — role → op list, no lowering yet
- `visual/lowerings/canvas2d.ts` + `lowerings/three.ts`
- A scratch script using `viz()` with a hardcoded layer array (builtins wired in phase 2)

**Exit criteria:** the same two `viz()` lines render as a tapered gradient band + tagged levels in 2D and as a ribbon tube + separated level planes in 3D, with identical source series, and the 2D and 3D posters both pass the §12 blur test. No prompt changes yet.

**Why first:** this proves the op schema is expressive enough before any token is spent on prompt rewriting or registries. If the op shape is wrong, everything downstream is rework.

### Phase 1 — Compiler + 2D lowering + toggle parity
- Full role and channel registries (the tables in §4 and §5)
- `toCanvas2D` complete for every op kind; `toIso3D` next; `toThreeScene` migrated from the existing series builders where they already match
- Render routing in `main.ts` becomes: when `viz()` layers exist, build ops **once**, then lower to the active surface. `hasPane3d` becomes a lowering choice, not a separate design
- Depth-sorted composite so 2D lowerings stack correctly against bars, drawings and trade markers
- Aesthetic pipeline from §6: hero-only emissive, `FogExp2` depth fog, in-scene starfield for `chart3D`, generated HUD chrome
- `validateCombination` in `rendering-matrix.ts` learns about compiled layers

**Exit criteria:** toggling 3D off on a `viz()` indicator keeps the visual (band → glow stroke, surface → contour bands, constellation → particle field) instead of blanking it. Golden op-stream test per role.

### Phase 2 — DSL surface
- `expose()` and `viz()` as builtin calls — **no lexer/parser changes**, one case each in the interpreter plus registry entries in `builtins.ts`
- `validator.ts`: role vocabulary check, arity, `UNKNOWN_VISUAL_ROLE`, `UNBOUND_CHANNEL`, `LAYER_BUDGET_EXCEEDED`, `LEVEL_AS_SURFACE`, `LABEL_STORM`
- `docs.ts`: a "Visual Intent" section replacing the per-style catalogue as the primary path, with `plot3d` moved to "Advanced"
- `backend/oak_kb.py`: index the new section so `/api/oak/search` retrieves it
- Runtime: `VisualLayer[]` accumulated per bar, series pushed like `OakPlot`, reset with the other plot state

**Exit criteria:** a hand-written script using `viz()` passes validation, renders, and every new issue code has a trigger test.

### Phase 3 — Prompt, brief and auto-fix
- Split the pre-prompt into three removable docs: **language**, **math audit**, **visual intent**. The visual-intent doc ships the role table + channel table + six recipes, and drops the 15-style catalogue, `z_level` rules and pane-trap warnings (now enforced by the compiler)
- Single source of truth: whichever of `agent.ts` / `backend/main.py` is authoritative generates the other, or both import one string. Duplicated prompt law is a standing bug source
- **Visual brief**: the model must emit 5 lines before the code —
  `role: trend.ribbon | encodes: spread (ATR-normalized) | why: ...`
  Rendered as chips above the editor, toggleable per layer, and stored in the script header as a comment so it survives copy/paste
- Validator issue codes feed the existing auto-fix loop in `trade-advisor/oakscript-bridge.ts` with a fix instruction each
- `plotshape` + `plotshape_3d` duplication collapses into `viz("signal.entry", …)` for new scripts

**Exit criteria:** the coder prompt loses the style catalogue and shortens measurably; a "MA cross with fib levels" request produces `viz()` calls plus a valid brief with zero renderer terms; an injected bad role is auto-fixed.

### Phase 4 — Metric packs
- `expose()` contracts for KNN (`voteMargin`, `confidence`, `agreement`), regime/ChronoSphere (`regime`, `transitionRisk`), volume profile (`poc`, `valueArea`), and VoVix — whose contract is now fixed (§7.4) against the supplied source, with the port as its prerequisite (§7.5)
- Motion presets: reuse the G1–G9 animation selection so 2D layers animate through the same policy as the lower manifold instead of new hand-written timers
- New role families only when a model genuinely needs one; the vocabulary stays small

**Exit criteria:** adding a model requires zero renderer changes — only an `expose()` contract and a registry entry if it introduces a new role.

### Phase 5 — Mobile, perf and evals
- `toMobile` lowering for `apps/mobile/src/chartscreen.ts` (confirm its plot path first)
- Per-layer budget through `perf-governor.ts`: particle counts, glow passes, geometry rebuild cadence; degrade in a fixed order (motion → glow → density → depth layers) so a slow device loses polish, never legibility
- Eval harness alongside `adapter-agent-test.ts`: intent → expected op stream, both surfaces, run per-role so a regression names the role that broke

---

## 4. Role registry

Closed vocabulary. Closed because determinism, prompt compression and golden tests all depend on a finite set.

| Role | Meaning | Emitted by | 3D form | 2D form | Pane |
|---|---|---|---|---|---|
| `trend.ribbon` | two or more ordered baselines; spread is the signal | EMA/SMA/HMA pairs, MACD | ribbon tube, hue = sign, radius = spread | tapered gradient band, edge stroke | main |
| `trend.direction` | signed trend state over time | ADX/DI, slope | ribbon with directional twist | single line, hue-mapped | main or separate |
| `level.ladder` | discrete price levels that move | fibs, pivots, S/R, VWAP bands | parallel planes separated in Z | steplines + right-edge price tags | main |
| `level.zone` | a band between two levels | golden pocket, value area | translucent slab | filled band at low alpha | main |
| `signal.entry` / `signal.exit` | discrete event at a bar/price | crossovers, model entries | oriented shape via `plotshape_3d` | shape via `plotshape` | main |
| `signal.state` | persistent on/off regime | filter, trend gate | background depth shift | `bgcolor` tint | main |
| `confidence` | 0..1 or signed conviction per bar | KNN margin, ML probability, RL Q | emissive intensity + pulse | glow alpha + halo ring | main or separate |
| `dispersion` | spread / disagreement / stdev | ATR, stdev, vote disagreement | width gauge, particle spread | stroke weight + point spread | separate |
| `density` | participation / count / neighbours | volume, KNN neighbour count | particle count, lattice density | point cloud density | separate |
| `regime` | discrete state per bar | ChronoSphere, clustering | Z-layered terrain, per-state hue | contour bands or `bgcolor` | separate |
| `flow` | signed pressure per bar | CMF, OBV delta, delta volume | column field, converging streams | columns with gradient | separate |
| `structure` | shape of the series itself | ridgeline, profile, distribution | joyplot / terrain surface | contour terrain | separate |
| `projection` | a forecast horizon ahead of price | regression channel, ML path | depth-extruded trail | dashed extension + cone | main |

Rules:
- One role per layer. A layer that "shows everything" is a layer that shows nothing.
- Roles decide **pane placement and label policy**, so pane mismatch stops being a model decision.
- A model that needs a genuinely new role justifies it in the plan, and it lands with both lowerings in the same PR.

### Op schema (sketch)

```ts
type VisualOp =
  | { kind: 'ribbon';  a: Series; b: Series; hue: HueBinding; width: NumBinding; depth?: number }
  | { kind: 'ladder';  levels: Series[]; tags: LabelSpec[] }
  | { kind: 'band';    top: Series; bottom: Series; alpha: NumBinding | number }
  | { kind: 'marker';  at: BarPrice[]; shape: Shape; size: NumBinding | number }
  | { kind: 'glow';    value: Series; intensity: NumBinding }
  | { kind: 'terrain'; value: Series; hue: HueBinding; surface: 'mesh' | 'contour' }
  | { kind: 'field';   value: Series; count: NumBinding | number }
  | { kind: 'text';    at: Anchor[]; text: string }
```

Bindings are either constants or series; a `NumBinding` must be normalized (percentile or ATR units) at compile time, never raw price, so the visual is scale-invariant across symbols and timeframes.

---

## 5. Channel table

A visual is legible when each perceptual channel carries exactly one metric dimension. This table *is* the "understand at a glance" guarantee.

| Channel | Encodes | 3D form | 2D form | Range policy |
|---|---|---|---|---|
| Hue | sign / direction | tube gradient | band gradient | fixed per role, never per value barring sign |
| Luminance / emissive | confidence, conviction | bloom intensity | `shadowBlur` + alpha | 0..1 clamped |
| Width / gauge | dispersion | tube radius | stroke weight | ATR-normalized, clamped 0.5–3 |
| Z depth | horizon, timeframe, regime | parallel planes | vertical offset / order | ordinal, from layer index |
| Motion speed | rate of change | shader drift, vortex spin | dash offset (G-class engines) | capped by perf governor |
| Pulse | volatility burst | torus heartbeat | halo breathing | transient, decays per bar |
| Density | participation, count | particle count | point density | device-budgeted |
| Text | exact numbers | billboard `label3d` | right-edge tag | label budget per pane |

**Honesty invariants** (each enforceable in the validator or compiler, each with a test):

1. Every dynamic channel binds to a real series; unbound channels are constants only.
2. No level is drawn as a surface, and no surface as a level (`LEVEL_AS_SURFACE`).
3. Normalization happens at compile time; a layer must look the same on BTC/1m and on a $3 stock/1d.
4. Layer budget per pane (default 3 main / 3 separate), label budget per pane (default 4).
5. Hue is reserved for sign/regime; magnitude never rides on hue alone.
6. Motion is never the only carrier of a metric — a paused frame must still be readable.

Invariants 1, 4 and 6 are what separate a mesmerising-but-honest visual from decoration. They are also what makes "the visual is the math" defensible in review.

### 3D → 2D lowering map

| 3D style / op | 2D lowering |
|---|---|
| `surface`, `mesh`, `wireframe` | contour terrain bands + isolines |
| `ribbon` | tapered gradient envelope with crisp edges |
| `bars3d`, `scatter` | depth-sorted columns / points, back-to-front alpha |
| `line3d` | crisp level line + right-edge price tag |
| `helix`, `vortex` | polar or spiral decomposition in a dedicated strip |
| `constellation`, `nebula` | node-edge field in the separate pane |
| `torus` | radial gauge ring |
| `trail` | fading afterimage stroke |
| `ridgeline` | stacked mini-profiles in register |

---

## 6. The aesthetic bar

"Reach the level of the reference images" needs no invented look — it is already in the repo (`age-dashboard.ts`, the AGE themes, `iso3d.ts` atmosphere, the starfield behind the chart). Four verified gaps keep the *indicator* renderer from reaching it:

| Gap | Evidence | Effect |
|---|---|---|
| **Bloom is installed but starved** | `three-indicators.ts:39-49` sets `BLOOM_THRESHOLD = 0.6`, and bloom runs before `OutputPass` on **linear** values. Scene materials use `emissiveIntensity` 0.2–0.5 (`:676`, `:715`, `:966`) over mid-tone emissive colors, landing around 0.06–0.3 linear — well under the threshold. | Almost nothing blooms, so the composer outputs a near-flat image. The reference frames are roughly 80% halo. |
| **No depth fog** | `docs.ts:1553-1560` documents "VOLUMETRIC FOG — `FogExp2` — bars further back fade into darkness". There is no `THREE.Fog` anywhere in `three-indicators.ts` or `three-lower-pane.ts`. | Missing the falloff that makes 3D read as depth rather than as flat overlapping lines. |
| **3D mode kills the atmosphere** | `initChart3D()` sets `_scene.background = 0x0a0a18` and clears opaque (`three-indicators.ts:913-914`); the starfield is drawn on the 2D canvas underneath (`main.ts:3639`) and is hidden | The references' strongest cue — luminous geometry floating in a star field — is absent precisely in the mode built for it. |
| **Emission is sometimes random** | `three-indicators.ts:1249` — `emissiveIntensity: 0.4 + Math.random() * 0.5` | Variation the data does not explain. It trains the reader to ignore brightness, which is the channel §7 depends on most. |

The fix is one policy, not a palette change: **hero-only emissive.**

- Semantic geometry — whatever the read depends on — renders at `emissiveIntensity` 1.6–2.6, above the threshold, and owns the bloom.
- Structural geometry (bars, grid, context, ornament) stays below 0.45 and never blooms.
- `FogExp2(0x05070f, 0.028–0.04)`, tuned so the far end of the visible range keeps ~25% contrast. Fog must aid depth reading, not erase data.
- `chart3D` gets an in-scene starfield (or a transparent clear so the 2D atmosphere shows through) plus the horizon grid already at `:191`.
- Chrome: 10–11px monospace, uppercase, letter-spaced, tabular values right-aligned, legend row bottom-left, and the `read` state word plus the generated legend in the **indicator panel** (§11.9 — decided, not chart chrome). Cheapest legibility win in the plan, pure HTML overlay, no renderer work.

That policy does double duty: it produces the reference aesthetic **and** it is law 2 of §7. The scene looks expensive exactly when the important thing is the only thing glowing.

---

## 7. Legibility grammar

The reference images are beautiful and, as instruments, mostly mute. In the reactor frame the sphere's radius, ring count, glow and pulse all vary, but nothing states what any of them measures — the number in the corner is doing the work and the picture is decoration. The test for decoration is simple: **a decoration cannot be wrong.** An instrument can.

So the target is not "look like the images"; it is "look like the images and be falsifiable". Eight laws get there, each enforceable and each with an acceptance test in §12. §5's honesty invariants are the subset a validator can check at compile time; these add the perceptual laws a validator cannot see.

### 7.1 Two channel classes

Every channel in a compiled scene is tagged at compile time:

| Class | May vary with | Examples | Rule |
|---|---|---|---|
| **semantic** | a bound series only | ribbon width, ladder brightness, terrain height, hull opacity | must appear in the binding table and in the generated legend |
| **ornament** | constants, or non-data noise (time, seeded jitter) | starfield, rim light, scanline shimmer, idle drift | may never vary with a metric, and must stay perceptually subordinate |

The compiler emits both, but only semantic channels may be loud. This split is what lets a scene stay atmospheric without the atmosphere lying.

### 7.2 The laws

1. **One read per visual.** The script declares `read("Is the trend intact, and is price at a decision level?")` — one sentence, one question, answerable in the current state. The compiler rejects a layer set with no read or two competing reads (`NO_READ`, `MULTIPLE_READ`). The read's state word becomes the chart title.
2. **Luminance is scarce.** Baseline state renders dim (~20% of peak), notable state mid, and **at most one** must-not-miss element per frame at full bloom. Everything glowing equally is the real reason the references are hard to read: there is no entry point for the eye.
3. **Meaning lives in low frequencies.** Blur the frame until geometry dissolves and the read must survive. Mass, position, hue and luminance blocks survive blur; thin lattice detail, speculars and particles do not. So data goes on envelopes and blocks, and detail is texture.
4. **Position > size > depth > hue.** Quantitative channels in that precedence. Depth is *redundant only* — foreshortening and occlusion make it a liar on its own. Hue carries sign or regime, never magnitude, because it is perceptually non-monotonic.
5. **No decoys.** Nothing may look like data unless it is data. A starfield is honest (tiny, uniform, unlabelled, obviously backdrop); a random scatter of glowing points is not. Concentric rings imply phase, radial symmetry implies a meaningful scalar from a centre — use each only when that is literally true.
6. **Chrome completes the read.** State word, tabular value with units, and a legend generated *from the bindings* — never hand-written, or it drifts and lies. Three words pay down the onboarding cost of any encoding.
7. **Redundant for critical, exclusive for secondary.** The primary metric gets two channels (spread = width *and* edge sharpness); secondary metrics get one each. Prevents crowding.
8. **Locked canonical camera, fixed world scale.** One default view per archetype, chosen so the primary read faces the camera; orbit is an explore gesture with reset. A visual that can be rotated into unreadability is not an instrument. The canonical still is the poster frame, and it is what §12 tests. **Framing must never auto-fit per frame:** `packFrom()` in the VoVix source rescales the axes to the current content bounds (`half = max(w,h)/2*1.12`), which normalises away every magnitude channel across time — a store that grows bar by bar renders at constant size. Scale is fixed per archetype; zoom is a user gesture, not a compiler behaviour.

### 7.3 Archetype → read → form

| Model | The read | Primary encoding | 3D form | 2D twin |
|---|---|---|---|---|
| MA cross + fib | Is the trend intact, and is price at a decision level? | ribbon width (spread/ATR) + intersection | crossing tubes, level rails, confluence flare | tapered band + tagged steplines + flare |
| KNN | Is the decision crisp or contested? | hull opacity + cluster tightness | neighbour constellation around the query bar | confidence rail + agreement stipple + vote text |
| Regime (ChronoSphere) | Which state are we in, and is it changing? | terrain height + state hue | Z-layered terrain, one plane per state | contour bands + `bgcolor` tint |
| Volume profile | Where is value, and is price leaving it? | horizontal density + POC/VAH/VAL rails | extruded density ridge with value rails | sideways histogram + tagged rails |
| Flow (CMF/OBV) | Is pressure building or fading? | column height + hue by sign | converging streams, radius sum fixed | depth-sorted columns |
| VoVix | Is volatility loaded, and is the tape worth trusting when it fires? | store = core radius; impulse = signed piston; lens uniformity = coherence; floor = causal support | pressure core, 4-sector lens ring, signed piston, ground lattice | store rail + 4-row lens strip + zero-filled oscillator |

### 7.4 Worked readings

**MA cross + Fibonacci** — *"Is the trend intact, and is price at a decision level?"*

- **Ribbon width = spread / ATR.** Fat means separating; hairline means compressing. The pinch is pre-attentive — a narrowing shape is read instantly, with no numbers.
- **Physical intersection is the cross.** In 3D the fast and slow tubes actually pass through each other, so the crossing bar is where geometry intersects geometry: spatially literal, no legend needed. The ribbon tapers to zero width at the crossing because spread *is* zero there. The aesthetic falls out of the encoding instead of being applied on top of it — that is the whole thesis in one detail.
- **Fib levels are rails, not surfaces.** Horizontal because they are prices; brightness = times tested; opacity = proximity to price. A level drawn as a surface is a lie (§5 invariant 2) because it implies a continuity the level does not have.
- **The one hero event:** a cross inside the 0.5–0.618 pocket emits a single flare at the intersection. Rare, therefore findable; meaningful, because it is the confluence. This is law 2 spent well — the flare is the only thing at full bloom.
- State words: `COILED`, `EXPANDING`, `AT DECISION`, `BREAKING`.

**KNN** — *"Is the decision crisp or contested?"*

- The model's native objects are the *k* neighbours, their distances, and the vote. The honest form is a constellation around the query bar: neighbours at radius = normalised distance, size = 1/d weight, hue = class (two hues only), convex hull tinted toward the winner with opacity = margin.
- The read is the **shape**, not the number: a tight monochrome core is crisp, a diffuse bicolor haze is contested. That is what confidence means, and the geometry says it before the label does.
- Only the active decision is drawn at full strength; history is a faint margin trail. Every neighbour cloud at once is soup — the three hand-written lenses at `indicators.ts:978-995` each solve part of this, which is why there are three.
- **2D twin:** a constellation cannot survive at bar scale, so 2D lowers to a confidence rail (glow alpha along the band), an agreement stipple (density), and `4–3` vote text on the last bar. Same answer, different instrument — a 2D lowering preserves the *read*, never the picture.

**VoVix** — *"Is volatility loaded, and is the tape worth trusting when it fires?"*

Source: the `VoVix MVD RCM 3D [DAFE]` script. The math is portable and mostly self-contained; the visuals are the part that needs replacing (§7.5).

*Two axes, and they are independent:*

- **Energy.** `compressMem` is a 0.88-per-bar decay store, armed when vol-of-vol is high while ATR and range are low *and still rising* — a coil. `vovix_z` is `(atrFast − atrSlow) / stdev(atrFast, L_z)`, i.e. a normalised MACD on volatility: signed, dimensionless, positive when vol is inflating. `elev` is how many of the four lenses (ATR, close-StDev, bar-range, VoVix) sit above z 0.6.
- **Trust.** The continuation rate `cRate` (does the previous bar's bias predict the next bar's direction over `L_rcm`), the dispersion `mvd_smooth` (z-scored disagreement among the four lenses), and an outlier penalty on |return z|.

The axes are independent, and that is the design constraint: **a large store in a coin-flip tape is a trap, and it must not look like a large store in a causal tape.** One composite channel cannot say that.

*The model already computes the trust axis, and draws none of it:*

```
ctx *= clamp(1 - 0.12·mvdPct, 0.84, 1.00)
ctx *= clamp(0.90 + 0.14·integArr, 0.82, 1.10)
ctx *= (|zscore(ret)| > 2.4) ? 0.90 : 1.00
convAdj = clamp01(max(0.22, DirConv) · agree · clamp(ctx, 0.70, 1.28))
```

Three multiplicative trust terms feed every signal's conviction. In the scene: `mvdPct` is a numeric cell, `integArr` is a 0–100% row labelled `Integ`, the return outlier appears nowhere — while four moons orbit the core at fixed speeds of 0.32/0.46/0.58/0.74 that no value controls. **That is the disconnect in one sentence: the model multiplies three trust terms and the scene draws none of them.**

*Channel allocation — one quantity, one channel, no reuse:*

| Quantity | Channel | 3D form | Why |
|---|---|---|---|
| `compressMem` | size | core radius, 0.35→1.0 of max | a store is a capacity; size is the strongest quantitative channel |
| `vovix_z` | vertical position | piston through the core, height = clamp(z, ±2.5) | sign must be spatial: up = inflating, down = deflating |
| four lens percentiles | per-sector luminance | 4 arcs at 0/90/180/270 on a fixed ring | uniformity of the four *is* coherence — no extra channel needed |
| `cRate` | ground continuity | lattice solidity = abs(2·cRate − 1) | "is there a floor under this?" reads from silhouette alone; a trust *score* does not |
| sign of `DirBias` | hue | piston and fire shell | hue stays reserved for direction (§7.2 law 4) |
| `qualArr` | shell radius at spawn | fire shell, fades over ~6 bars | transient = event |
| `elev` | *derived* | count the bright arcs | redundant by construction — deliberately not encoded twice |

The payoff is two silhouettes that cannot be confused: **a bright core hanging over a dissolving grid** (loaded, untrustworthy) versus **a bright core on a sharp bright grid** (loaded, causal). That contrast, not the glow, is the instrument.

*Why the shipped 3D is not yet readable* — six verified causes, each with the fix:

| Cause | Evidence | Fix |
|---|---|---|
| The default engine renders 1 of its 4 lens values | `buildSphere()` reads `curMVD` (sphere radius, a composite) and `curVoVix` (halo tilt); `moons[].z` is assigned but never read, so ATR/StDev/Range z reach the scene only as dot colours | 4-sector lens ring, luminance = percentile |
| Motion carries no data | moons advance on `CLOCK.beat * speed`, speeds 0.32/0.46/0.58/0.74 | static sectors; motion becomes ornament |
| Magnitude is normalised away | `packFrom()` frames to current bounds, so a growing core is re-framed to the same size every bar | fixed world scale (§7.2 law 8) |
| Haze is pure noise | `ulmaG2` ghosts and torus `flow` use `hashRand` | ornament, or bind particle count to `elev` |
| Terrain multiplies two axes onto one channel | `vals[p] * 7.2 * (0.55 + integ * 0.55)` — a peak means *either* disagreement *or* trust | orthogonal channels. The instinct (two axes) is right; multiplying is the wrong operation |
| 12 geode vertices cycle 4 measures by `a % 4` | `buildGeode()` | 4 fixed sectors are learnable; 12 cycling ones are not |

**One correction before any of this is drawn:** `integArr = clamp01(1 − |cRate − 0.5|·1.4)` is **maximised when the tape is a coin flip** (cRate = 0.5 → 1.0) and minimised when it is perfectly predictive (cRate = 1 → 0.3). It is a noise index wearing an integration label, and it feeds `ctx` directly: a coin-flip tape scores ×1.04 while a perfectly predictive tape scores ×0.94, so the ordering is backwards by about 10% relative. The RCM gate is unaffected (`cRate >= 0.505` is used raw), so the fix is local: expose the raw `cRate` and derive `abs(2·cRate − 1)` in the visual layer, or correct the formula at the source. Either way **the visual contract binds `cRate`, never `integArr`** — a channel whose name and value disagree is precisely what §5's honesty invariants exist to catch.

*State word* (indicator panel, §11.9). Thresholds are the model's own gates, not invented numbers:

| Precedence | Word | Condition |
|---|---|---|
| 1 | `RELEASE` / `EXPANSION` / `EXHAUST` | `eventArr` on the current bar (the shell is drawn) |
| 2 | `UNSTABLE` | store ≥ 0.32 **and** `mvd_smooth` > 1.2 — the source's own `releaseNow` and `expandNow` gates |
| 3 | `LOADED` | `compressMem` ≥ 0.32 |
| 4 | `LOADING` | store rising, < 0.32 |
| 5 | `COIN-FLIP` | `abs(cRate − 0.5) < 0.1` |
| 6 | `QUIET` | otherwise |
| — | `WARMUP` | before `ENGINE_START`; draw nothing |

Blocked bars (`no-bias`, `spacing`, `rcm-gate`, `below-quality`) get **no geometry at all**. The panel already carries the word for why nothing fired, and a decoy marker for a non-event is exactly what law 5 forbids.

*3D.* Pressure core (radius = store, surface faceted by lens dispersion — smooth when the four agree, shattered when they do not); 4-sector lens ring around it; signed piston through the core; ground lattice under it; fire shell on the event bar, imploding for `exhaust`; and a faint **thread** appearing while `watch` is set, so the eye learns *thread → shell* before the first fire. The continuation-fade distinction stays in the panel, not in a third hue.

*2D twin.* Store → a bottom-anchored rail (fill height = store, same 0.32 arm threshold); lenses → a 4-row heat strip, literally the ring unrolled, where a uniformly bright column means agreement; impulse → a zero-centred oscillator in a separate pane, fill above/below zero, hue by bias; trust → the strip's floor line, solid when causal and absent when not; fires → the existing `plotshape` idiom (up = release/expand, down = exhaust, hollow = watch). Same reading logic, different medium.

### 7.5 Running VoVix here

The script targets a different host. All six of its host calls map to existing builtins; two more are unneeded or unwanted, leaving one real gap:

| VoVix call | Repo equivalent |
|---|---|
| `describe_indicator(…)` | **absent** — scripts start directly with code; `indicator()` is rejected as `PINE_DECLARATION` (`validator.ts:347`), and the name lives on the model record |
| `color_candles(arr)` | `barcolor(color)` on the current bar (`interpreter.ts:1319`) |
| `register_signal(cond, title)` | `alertcondition(cond, title)` (`interpreter.ts:1570`) |
| `paint_overlay(…)` rows/cells | `table.new` + cell writes (`interpreter.ts:1278`) — text cells only |
| `paint` / `paint_label_at_line` | `plot` + `plotchar` / `label.new` |
| `input.select` | `input(…)` |
| `input.anchor('visible range')` | **absent** — the chart knows its view, the DSL does not expose it |
| `library('jstat'/'fft-js'/'tinycolor2')` | **not needed** — used only for stdev and colour mixing |
| `paint_overlay`'s embedded `chart` cell | **absent and unwanted** — this repo draws 3D through `plot3d()`, and the compiler is what earns the geometry |

So the phase-4 work is a port, not a redesign: `barcolor`, `alertcondition`, `table.new`, `input`, one new visible-range anchor input, and ~60 lines of the `DAFE` math (it uses only `atr`/`ema`/`sma` plus OHLC). The five hand-built geometries in the source are replaced by the compiler's lowering, which is the entire point.

---

## 8. Target DSL surface

```oak
// one sentence, one question, answerable in the current state
read("Is the trend intact, and is price at a decision level?")

// metrics the rest of the visual layer can address by name
expose("fast", ema(close, 9), "trend")
expose("slow", ema(close, 21), "trend")
expose("spread", ema(close, 9) - ema(close, 21), "dispersion")
expose("voteMargin", (bullVotes - bearVotes) / k, "confidence")

// layout: roles and series only — no style names, no z_level, no pane strings
viz("trend.ribbon", fast, slow)
viz("level.ladder", fib236, fib382, fib618)
viz("level.zone",   fib618, fib500)
viz("confidence",   voteMargin)
viz("signal.entry", buy, low)
```

What the compiler resolves from those lines:

| Surface | Result |
|---|---|
| 3D (`pane="3d"`) | ribbon tube with hue by sign, radius by ATR-normalized spread; three Z-separated level planes with billboard price tags; translucent golden-pocket slab; emissive bloom on the ribbon driven by `voteMargin`; cones below buy bars |
| 2D | tapered gradient band between `fast`/`slow` with edge strokes; three tagged steplines; low-alpha pocket fill; glow alpha on the band stroke and a halo at the last bar driven by `voteMargin`; standard `plotshape` cones |
| Mobile | band + tagged steplines + halo, motion off, tags capped at 2 |

`viz()` argument forms:
- `viz(role, ...series)` — roles with a fixed series arity
- `viz(role, ...peers)` — N-ary roles take a named **set**, not a pair: `viz("level.ring", vol.lenses)` where that binding is four percentiles. This is the first op shape that cannot be expressed as a pair, and it is what makes the lens ring possible (§7.4).
- `viz(role, { ...options })` — object form for depth, preset, budget overrides
- `viz.scene(name)` — ops declared after it share one placement frame. Without grouping, the compiler lays each op out independently and destroys composite reads such as VoVix's "loaded core over a dissolved floor", which is the entire point of rendering two independent axes in one scene.
- The compiler rejects unknown roles at compile time with a fix suggestion listing valid roles.
- `read(text)` is required once per script when any `viz()` layer exists (`NO_READ`); a second call is `MULTIPLE_READ`.

---

## 9. Prompt, skill and toolkit changes

The pre-prompt stops being a per-style manual and becomes an intent manual.

| Change | Effect |
|---|---|
| Split into language / math / visual-intent docs | each retrievable independently; visual doc stops competing with math rules |
| Drop the 15-style catalogue, `z_level` and pane traps | ~1.5k tokens recovered; those decisions move into code |
| Add role table + channel table | the model reasons about metrics, not geometry |
| Add six worked recipes: MA ribbon, fib ladder, KNN vote, VoVix pressure core (§7.4), regime terrain, volume profile | executable examples beat prose; each is ~6 lines |
| Require the read sentence plus a 5-line brief before code | scannable, testable, drives the chips UI |
| Teach `read()` as the first line of any visual | forces the model to name the question before choosing a form |
| Drop the "make it visually stunning" instruction | taste is now a compiler policy (§6), not a prompt adjective |
| Teach auto-fix the new issue codes | existing loop repairs visuals instead of only syntax |
| Keep `plot3d` as documented advanced path | no model breaks, experts keep full control |

Skill/toolkit packaging: the recipes plus role and channel tables are one skill a coding agent can load, with the validator issue codes as its failure contract. That is the concrete replacement for "know 15 styles and 6 traps".

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Op schema too narrow, forces schema churn in phase 3 | phase 0 gate: build 2 roles, both surfaces, before any prompt work |
| Determinism kills the "mesmerising" variety | seed archetype choice deterministically from script name + role, so it varies across scripts but is reproducible for one |
| Glow/particle cost tanks frame rate | per-layer budget in `perf-governor.ts`, fixed degradation order, measured in phase 5 rather than asserted |
| Reader-hostile "everything at once" visuals | layer/label budgets and honesty invariants 4 and 6, enforced with tests |
| Two prompts drift apart | single source of truth for the generated string |
| Three render targets at once | iso3D slots after 2D; a target may lag only if the toggle still shows a visual (never a blank chart) |
| VoVix exists only as a foreign-host script | Contract is settled (§7.4). What remains is a port: 5 of 8 host calls map to existing builtins and `library()` is unneeded. Real gaps: a visible-range anchor input, and its embedded Chart.js panel cell (deliberately unwanted). Port is the phase-4 critical path, not the design. |
| Aesthetic tuning regresses legibility (brighter, denser, busier) | §12 blur and squint tests run in CI on the poster frame; ornament budget is a compiler constant |
| HUD chrome crowds the chart on small viewports | chrome is one generated block with a collapse rule (<640px keeps state word + legend only) |

---

## 11. Open decisions

Defaults below are my recommendation; each needs a yes/no before phase 0 starts.

1. **Determinism of aesthetics.** Seed archetype selection from script name (varied but reproducible) vs. let the model choose a preset per request (more range, less reproducible). *Recommend: seeded, with a `preset:` override for users who want control.*
2. **Iso 3D timing.** Phase 1 (three lowerings at once, slower) vs. phase 5 (2D and Three first, iso canvas later). *Recommend: phase 5, provided the iso path degrades to the 2D lowering in the interim so nothing renders blank.*
3. **Where the visual brief lives.** Comment header inside the script (survives copy/paste and export) vs. sidecar metadata on the indicator record (cleaner script, lost on export). *Recommend: comment header, parsed by the editor, sidecar as cache only.*
4. **Compatibility policy for `plot3d`.** Keep it permanently as advanced (no deprecation pressure) vs. mark it legacy for generated scripts only. *Recommend: permanent, generated scripts prefer `viz()`.*
5. **Role vocabulary change control.** Frozen for v1 with additions requiring both lowerings in one PR, vs. extensible by plugin. *Recommend: frozen for v1.*
6. **Prompt ownership.** Which of `apps/web/src/trade-advisor/agent.ts` and `backend/main.py` becomes the source of truth for the shared string, or generate both from one file. *Recommend: one generated file, verified in CI so the two cannot drift.*
7. **Camera policy.** Locked canonical view per archetype with an explicit reset vs. free orbit from the first frame. *Recommend: locked, because law 8 assumes the poster is the artifact that gets judged; free orbit is available but never the default.*
8. **Where channel-class enforcement lives.** Compiler-time assert in dev builds vs. hard validator rejection of ornament variation at runtime. *Recommend: dev assert plus golden op-stream tests — ornament is legitimate, so it should not be a user-facing error, but it must fail loudly for us.*
9. **Panel ownership (answered).** The state word and generated legend live in the **indicator panel**, not chart chrome — confirmed, and adopted as the default everywhere. Sub-question still open: does the compiler own the whole panel block, or emit `{state, legend, values}` for each script's own panel to place? *Recommend: emit the block plus a fixed three-row form that the script's existing panel appends to; scripts keep their dashboards, and the compiler never fights them for layout.*

---

## 12. Verification plan

- **Golden op streams** per role: intent in, `VisualOp[]` out, byte-stable — the compiler's core contract.
- **Toggle parity test:** for every role, 3D and 2D lowerings both produce non-empty draw lists; 2D may never be empty when a layer exists.
- **Invariant tests:** the six honesty invariants, each with a failing fixture.
- **Validator tests:** one trigger per new issue code, incl. an auto-fix round trip.
- **Scale-invariance test:** same layer on a low-price symbol and a high-price symbol yields identical normalized bindings.
- **Perf test:** script with maximum allowed layers holds frame budget on a mid-tier device profile at both surfaces.
- **Existing suites stay green:** `tsc --noEmit`, `npm run build`, `adapter-agent-test.ts`, `backtest-stress.ts`.

### Legibility acceptance tests
The tests that make "meaningful at a glance" falsifiable rather than a matter of taste:

- **3-second test** — a reader who has not seen the indicator states the current condition from the poster frame plus the read sentence alone. Pass: four of five readers correct, wording irrelevant.
- **Blur test** — 12px gaussian on the poster; the read must survive. Automated by comparing the poster against a low-frequency-only render of the same bindings.
- **Squint test** — 25% downscale, same criterion. Cheap proxy for blur, runs in CI on every lowering change.
- **Channel audit** — the compiler logs semantic bindings per frame. Any channel that varies with data but has no binding is a failure; any semantic channel missing from the generated legend is a failure.
- **Poster test** — the canonical camera still must pass 3-second and blur. Free-orbit views are exempt, which is only defensible because of law 8.
- **Composite test** — for VoVix, the poster frames of "loaded + no floor" (high store, `cRate` ≈ 0.5) and "loaded + solid floor" (high store, `cRate` ≈ 0 or 1) must be told apart by the same five readers who passed the 3-second test, without the panel. This is the test that catches a two-axis model rendered on one channel.

---

## 13. Test prompt suite

Two uses, deliberately the same prompts:

- **Before phase 0** they are a baseline. The compiler does not exist yet, so what they measure is which of the four faults in §1 each request triggers — that is the evidence the phase ordering is right, and it tells us which role to build first.
- **After phase 1** they are the acceptance suite. Same prompts, same scoring, run against the compiler.

Rules for a run: identical symbol, timeframe and bar count; run each prompt twice (3D on, 3D off); repeat across whatever models are under comparison, one variable at a time. Score the **rendered indicator**, not the reply text. Any script that does not compile is scored as a failure regardless of how good the code looks.

### 13.1 Tier A — single-axis (the compiler should make these trivial)

| # | Prompt | Passes when | Baseline failure to look for |
|---|---|---|---|
| A1 | "EMA 9 crossing EMA 21, Fibonacci retracement from the last swing, and mark the cross." | Two lines separable without the legend, fib ladder evenly spaced and labelled, marker only on the cross, 2D twin legible | 2D-only; or `plot3d` fed the same series under several style names |
| A2 | "Mark RSI divergences: price lower low, RSI higher low. Put RSI in a lower pane." | Divergence line joins the two pivots, pane separate, no label spam | Divergence drawn as text labels with no connecting line; 2D shapes vanish in 3D |
| A3 | "Show a 20/50/200 EMA stack and colour the background by which side of the 200 price is on." | Background is atmosphere, not a second chart; stack order readable by luminance | Background competes with the lines; every element glows equally |

### 13.2 Tier B — two-axis (where meaning collapses today)

| # | Prompt | Passes when | Baseline failure to look for |
|---|---|---|---|
| B1 | "KNN vote on the next bar's direction from the last 20 bars, k=7. Show the vote margin and how much the neighbours disagree, and only fire when both agree." | Two channels independently readable at a glance, both named in the legend, fire count visibly gated | Margin and dispersion both mapped to colour, or collapsed into one composite; signal fires regardless of agreement |
| B2 | "Volatility compression: ATR and range coiling while vol-of-vol rises. Show how loaded the coil is and whether the tape has been predictable, as two separate things. Fire on release." | Store readable from silhouette alone; predictability readable independently; release marker follows the store, not the other way round | One composite magnitude (the MAD-Terrain failure); predictability absent or as a number in a panel |
| B3 | "Z-score ATR, StDev, range and vol-of-vol, and show when the four agree and when they disagree." | Four series with coherence readable as uniformity; disagreement visible without counting | Four coloured lines overlaid — technically complete, unreadable in one second |
| B4 | "Show when volatility is loaded but the tape is a coin flip, versus loaded with a strong trend. Those two must not look the same." | Poster frames distinguishable without the panel (the §12 composite test) | Both render as "big" — the exact conflation the VoVix review found |

### 13.3 Tier C — compositional and parity

| # | Prompt | Passes when | Baseline failure to look for |
|---|---|---|---|
| C1 | "Trend ribbon, plus a regime background that reads as trend when the tape trends and chop when it chops. Same script in 2D and 3D." | Both surfaces non-empty and both readable; background never outshines the ribbon | 3D takeover leaves 2D blank; 2D fallback is a wireframe of the 3D scene rather than a design |
| C2 | "Combine 3-period RSI with a Fibonacci ladder so I can see at which fib level momentum dies." | Two indicators share one frame with one read; no duplicated axes | Two panels bolted together, or one indicator silently dropped in 3D |
| C3 | "Same indicator, but make the 3D version and the 2D version carry the same information." | Toggle changes viewpoint, not content | Information is lost in one direction (usually 3D → 2D) |

### 13.4 Tier D — honesty probes

| # | Prompt | Passes when | Baseline failure to look for |
|---|---|---|---|
| D1 | "Make it look amazing." | Asks which metric matters, or declares and exposes one; never invents motion | Particles, scan lines and pulses with no data binding — animation from `Math.random()` or wall clock |
| D2 | "Add a pulsing glow to the signal." | Pulse bound to a real quantity (quality, recency) or declared ornament and confined to it | Period and amplitude unrelated to any series, on the loudest element |
| D3 | "Make it glow more." | Raises hero emission only; context stays under threshold | Whole frame blooms, contrast collapses, the read disappears |

### 13.5 Scoring

One row per run, one column per model. Six fields, all observable from the screenshot plus the compiled script:

1. **Compiles** — no validator errors, no silent-zero outputs (the docs' own misspelling trap).
2. **Both surfaces** — layers non-empty with 3D on *and* off.
3. **Channel audit** — count channels that vary with data; every one must appear in the generated legend, and no ornament may be loud.
4. **3-second read** — a reader who has not seen the script states the condition.
5. **Blur/squint** — the read survives 12px blur and 25% downscale.
6. **Honesty** — one input changed ⇒ exactly the predicted visual channel changes; nothing else moves.

Field 3 is the one that separates "beautiful" from "meaningful", and it is the field current models fail most often — which is the whole reason the compiler owns appearance and the model only declares meaning.

### 13.6 Baseline run — 2026-10-26, A1 on the web app

First recorded run, before any compiler work. The request never reached the visual layer:

| Observed | Cause | Where |
|---|---|---|
| Emitted PineScript (`indicator(...)`, `color=`, `shape.triangleup`) | model defaulted to Pine despite the coder prompt's explicit prohibition; the auto-fix pass returned Pine again | `validator.ts:347-374`, `agent.ts:16-59` |
| "OakScript does not support 3D rendering" | **confirmed** — system prompt cut to its first **2,000 chars**; the 3D block starts at **3,171** of 15,890, so the model was never told 3D exists | `main.py:762`, `agent.ts:35` |
| Auto-fix returned Pine and then "No errors to diagnose" | repair requests were sent as **`agent=trade_advisor`** with **`adaptive_max=400`** output tokens — wrong persona, no room for a script | backend log, `main.py:731-746` |
| Fibonacci ladder missing | nothing checks request coverage; the validator is syntax-only, and the repair prompt's "satisfies the original request" line had 400 tokens and an analyst persona behind it | `validator.ts` |
| 3D toggle changes only the candles | no 3D layer was authored, so there was nothing to toggle | — |

Log evidence from the run (model `SakanaAI-Llama-3-8B-Instruct-Coding-Expert-Q5_K_M`, 8,192 ctx):

```
11:43:47 WARNING prompt 19347 > ctx 8192, truncating from 2 messages
11:43:47 INFO after truncation: prompt_est=3716, 2 messages      ← system msg cut to 2,000 chars
11:44:02 INFO chat request: agent=trade_advisor ... adaptive_max=400   ← repair, wrong agent
11:48:30 WARNING prompt 19922 > ctx 8192 ... prompt_est=3882     ← "where are the 3D elements?"
11:48:44 INFO chat request: agent=trade_advisor ... prompt_est=1470    ← question becomes a repair task
```

The 2,000th character lands mid-sentence at "bgcolor is the exception — it may be conditional)." Everything after it — `plot3d`, `plotshape_3d`, the pane rules, fib-in-3D, the drawing toolkit — is absent from the call. The model did not hallucinate the denial; it answered accurately from a prompt that had been silently amputated. The two failures therefore have nothing to do with each other and one fix does not address both: **capability truncation** and **repair-loop routing** are separate defects.

Three consequences. The phase-0 gate is right but needs a prerequisite: **a coder that reliably emits this DSL at all** — baseline on A1 is zero passes, with the visual layer never attempted, on an 8B model at 8k context. Prompt budget is a defect class of its own: a capability present in the prompt but cut by the context fitter is indistinguishable from one that does not exist, and the model will deny it confidently. And the repair loop is load-bearing infrastructure — it is the only thing standing between a wrong draft and a running chart, so routing it to the advisor at 400 tokens guarantees the user sees the wrong draft.

**Post-fix check, same model.** Moving the 3D contract to the top of the coder prompt (offset 0 in the web copy, 812 in the backend copy) and replacing head-only truncation with a middle trim removed the information deficit: a short probe now answers "Yes" and emits `plot3d`. On the full A1 edit — long coder prompt plus a Pine-flavoured draft in the user message — the same 8B model still replied that OakScript "does not support three-dimensional rendering" and switched to Python, with the sentence forbidding exactly that sitting 700 characters above its context. That is a capability result, not a budget one: an 8B Llama-3 fine-tune at 8k context is not viable for this DSL, and the coder model should be a stronger one. Recorded because it draws the boundary between *the pipeline lied to the model* and *the model cannot follow*.
