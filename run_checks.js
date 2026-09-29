#!/usr/bin/env node
/*
 * Behaviour checks that the golden cases do not cover: name resolution
 * (phase, tremoflo waveform, frequency map), device defaults, abnormal
 * direction, unit conversion, range warnings and the metres guard.
 * Usage: node tests/run_checks.js   (exit 1 on any failure)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const R = require("../js/refeq.js");
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "coefficients.json"), "utf8"));

let n = 0, bad = 0;
function check(label, cond) {
  n++;
  if (!cond) { bad++; console.log("FAIL " + label); }
}

// Name resolution
const rn = (set, p, ph, m) => R.resolveName(reg, set, p, ph, m);
check("Oostveen R11 maps to R10", rn("oostveen2013", "R11").name === "R10" && rn("oostveen2013", "R11").mapped_from === "R11");
check("Ducharme Resmon R11 is native", rn("ducharme2022_resmon", "R11").name === "R11" && !rn("ducharme2022_resmon", "R11").mapped_from);
check("Valach R19 is native", rn("valach2026", "R19").name === "R19");
check("Oostveen R5_R19 -> no equation", rn("oostveen2013", "R5_R19").missing === true);
check("Berger R5_R19 maps to R5_R20", rn("berger2021", "R5_R19").name === "R5_R20");
check("Tremoflo AX without waveform refuses", rn("ducharme2022_tremoflo", "AX").name === null);
check("Tremoflo AX 5-37", rn("ducharme2022_tremoflo", "AX", null, "AOS 5-37 - Adult").name === "AX_5_37");
check("Tremoflo Fres 7-41", rn("ducharme2022_tremoflo", "Fres", null, "7–41").name === "Fres_7_41");
check("Within-breath R5 insp", rn("valach2026", "R5", "insp").name === "R5_insp");
check("Within-breath X11 exp", rn("valach2026", "X11", "exp").name === "X11_exp");
check("Within-breath absent in Oostveen", rn("oostveen2013", "R5", "insp").missing === true);

// Defaults (child < 18 y)
check("Jaeger adult default", R.defaultSetId(reg, "Jaeger", 40) === reg.device_defaults.Jaeger.adult);
check("Jaeger child default", R.defaultSetId(reg, "Jaeger", 10) === reg.device_defaults.Jaeger.child);
check("Tremoflo child default", R.defaultSetId(reg, "Tremoflo", 17.9) === reg.device_defaults.Tremoflo.child);
check("Resmon at 18 is adult", R.defaultSetId(reg, "Resmon", 18) === reg.device_defaults.Resmon.adult);

// Valach male AX_exp has no model; female does
const base = { sex: "M", age: 50, height_m: 1.78, weight_kg: 80, measured: 0.3, unit: "kPa" };
const axm = R.score(reg, "valach2026", "AX_exp", base);
check("Valach male AX_exp returns no prediction", axm.pred_kpa === null && axm.reason === "no equation for this sex or age");
check("Valach female AX_exp scores", R.score(reg, "valach2026", "AX_exp", { ...base, sex: "F", height_m: 1.65, weight_kg: 62 }).pred_kpa !== null);

// Abnormal direction: very negative X5 is abnormal; very positive X5 is not
const x5lo = R.score(reg, "berger2021", "X5", { ...base, measured: -0.3 });
// Berger models ln(X + 4 cmH2O): X5 below -4 cmH2O (-0.392 kPa) has no z, by design of the equation
const x5dom = R.score(reg, "berger2021", "X5", { ...base, measured: -0.5 });
check("Berger X5 below -4 cmH2O: no z, reason given", x5dom.z === null && /domain/.test(x5dom.reason) && x5dom.pred_kpa !== null);
const x5hi = R.score(reg, "berger2021", "X5", { ...base, measured: 0.1 });
check("X5 low -> abnormal", x5lo.z < reg.lln_z && x5lo.abnormal === true);
check("X5 high -> not abnormal", x5hi.z > 0 && x5hi.abnormal === false);
const axhi = R.score(reg, "berger2021", "AX", { ...base, measured: 3 });
check("AX high -> abnormal, positive z", axhi.z > reg.uln_z && axhi.abnormal === true);
check("Oostveen X5 sign: lower X gives lower z",
  R.score(reg, "oostveen2013", "X5", { ...base, measured: -0.3 }).z < R.score(reg, "oostveen2013", "X5", { ...base, measured: -0.1 }).z);
check("Valach X5 sign: lower X gives lower z",
  R.score(reg, "valach2026", "X5", { ...base, measured: -0.3 }).z < R.score(reg, "valach2026", "X5", { ...base, measured: -0.1 }).z);

// Unit conversion: same pressure in three units gives the same z
const zk = R.score(reg, "oostveen2013", "R5", { ...base, measured: 0.35, unit: "kPa" }).z;
const zh = R.score(reg, "oostveen2013", "R5", { ...base, measured: 3.5, unit: "hPa" }).z;
const zc = R.score(reg, "oostveen2013", "R5", { ...base, measured: 0.35 / 0.0980665, unit: "cmH2O" }).z;
check("Unit conversion kPa = hPa = cmH2O", Math.abs(zk - zh) < 1e-12 && Math.abs(zk - zc) < 1e-12);

// Percent predicted only for strictly positive parameters
check("%pred defined for R5", R.score(reg, "berger2021", "R5", base).pct_pred !== null);
check("%pred undefined for X5", R.score(reg, "berger2021", "X5", base).pct_pred === null);
check("%pred undefined for R5_R20", R.score(reg, "berger2021", "R5_R20", base).pct_pred === null);

// Ranges
const berF = R.score(reg, "berger2021", "R5", { ...base, sex: "F", age: 80, height_m: 1.62, weight_kg: 60 });
check("Berger female age 80 out of range", berF.in_range === false && berF.issues.some((i) => i.what === "age"));
const val = R.score(reg, "valach2026", "R5", { ...base, weight_kg: 120 });
check("Valach BMI > 35 flagged", val.in_range === false && val.issues.some((i) => i.what === "BMI"));
check("Ducharme 3-17 y, 100-189 cm in range", R.score(reg, "ducharme2022_resmon", "R5", { ...base, age: 10, height_m: 1.4, weight_kg: 32 }).in_range === true);

// Tremoflo AX LLN floored at 0
const ax = R.score(reg, "ducharme2022_tremoflo", "AX_7_41", { ...base, age: 16, height_m: 1.89, weight_kg: 75 });
check("Tremoflo AX LLN >= 0", ax.lln_kpa >= 0);

// Missing weight: weight-dependent sets give no prediction; height-only sets still score
const noW = { ...base, weight_kg: null };
check("Berger without weight: no prediction", R.score(reg, "berger2021", "R5", noW).pred_kpa === null);
check("Ducharme without weight: scores", R.score(reg, "ducharme2022_resmon", "R5", { ...noW, age: 10, height_m: 1.4 }).pred_kpa !== null);

// Metres guard
let threw = false;
try { R.score(reg, "berger2021", "R5", { ...base, height_m: 178 }); } catch (e) { threw = true; }
check("Height in cm is refused", threw);

console.log(`${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
