# Oscillometry Reference Calculator

A single static page that computes predicted values, LLN, ULN, z-scores and % predicted for Jaeger IOS, Resmon Pro FOT and tremoflo AOS measurements, from the published reference equations in `coefficients.json`.

**Research use only, not for clinical decisions.**

Everything runs in the browser. There is no backend, no analytics, no cookies and no browser storage; the page loads only its own three files.

## Files

| File | Role |
|---|---|
| `index.html` | The page (inputs, results table, z-strip, equation notes) |
| `js/refeq.js` | Scoring engine. Port of `R/refeq.R`; no coefficients inside |
| `coefficients.json` | Single source of every equation. Copied from `IOS/refeq/coefficients.json` |
| `tests/reference_cases.csv` | Golden values from the independent Python implementation |
| `tests/run_golden.js` | Scores every golden case; pred, LLN, ULN, native pred and z must match to 1e-8 |
| `tests/run_checks.js` | Name resolution, defaults, abnormal direction, units, ranges, missing weight |
| `.github/workflows/pages.yml` | Runs both tests on every push; deploys to Pages only if they pass |

## Conventions (from IOS ARCHITECTURE.md)

- Positive z = measured above predicted, for every parameter and equation.
- Abnormal: X parameters when z < -1.645; everything else (R, R differences, AX, Fres, |Z|) when z > +1.645.
- Heights are entered in cm and converted to metres; the engine refuses heights over 3 m.
- Pressures carry their unit (kPa, cmH2O, hPa) and are converted to each set's native unit. Fres is Hz.
- Name resolution: `_insp` / `_exp` from the breath phase; tremoflo `_5_37` / `_7_41` from the waveform (no waveform, no score); `frequency_map` (R11 to R10, R19 to R20, X11 to X10, R5-R19 to R5-R20) only when the set has no native row.
- Default equation from `device_defaults`: child if age < 18 y, otherwise adult.

## Test

Requires Node 18 or later.

```
npm test
```

or `node tests/run_golden.js && node tests/run_checks.js`.

## Preview locally

The page fetches `coefficients.json`, so it must be served, not opened from disk:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

## Updating coefficients

1. Change `IOS/refeq/coefficients.json` and regenerate `reference_cases.csv` with `tools/` in the IOS code base; pass `tests/test_refeq.R` there.
2. Copy both files here (`coefficients.json` at the root, `reference_cases.csv` into `tests/`).
3. `npm test`. Push only when it passes; the workflow will refuse to deploy otherwise.

## Known limits of the equations (not bugs in the page)

- Berger models ln(X + 4 cmH2O): X5 or X10 below -4 cmH2O (-0.39 kPa) has no z.
- Valach 2026 male AX expiratory is not implemented (published S formula duplicates M).
- Ducharme 2022 limits narrow with height; interpret tall adolescents with care.
- Oostveen 2013 has no R5-R20 equation.
- Nowowiejska 2008 and Wu 2022 are kept only to reproduce Paper 1.
