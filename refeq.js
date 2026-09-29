/*
 * refeq.js — oscillometry reference-equation engine (browser + Node).
 *
 * Port of R/refeq.R. Every coefficient comes from coefficients.json, which the
 * caller loads and passes in as `reg`; nothing numeric about any equation set
 * lives in this file.
 *
 * Model types
 *   linear         transformed-scale regression, constant RSD
 *   gamlss_normal  mean and SD as functions of height (Ducharme 2022)
 *   lms            Box-Cox L, M, S with a shift y' = a*y + b (Valach 2026)
 *
 * z convention: positive z = measured above predicted, for every parameter.
 *   Abnormal low:  names starting with reg.abnormal_low_prefix ("X"): z < lln_z
 *   Abnormal high: everything else:                                  z > uln_z
 *
 * Inputs: sex "M"/"F", age (years), height in METRES, weight (kg), measured
 * value with its unit ("kPa", "cmH2O", "hPa"; Fres is always Hz).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RefEq = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Helpers ------

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const safeLog = (v) => (isNum(v) && v > 0 ? Math.log(v) : NaN);
  const fin = (v) => (isNum(v) ? v : null);

  function getSet(reg, setId) {
    const s = reg.sets.find((x) => x.id === setId);
    if (!s) throw new Error("Unknown set_id: " + setId);
    return s;
  }

  // Predictors ------

  function predictors(sex, age, heightM, weight) {
    if (isNum(heightM) && heightM > 3) {
      throw new Error("height_m > 3: heights must be in metres.");
    }
    const hcm = heightM * 100;
    const bmi = weight / (heightM * heightM);
    return {
      intercept: 1,
      height_m: heightM,
      height_cm: hcm,
      height_cm2: hcm * hcm,
      inv_height_cm: 1 / hcm,
      ln_height_cm: safeLog(hcm),
      age: age,
      ln_age: safeLog(age),
      weight: weight,
      bmi: bmi,
      inv_bmi: 1 / bmi,
      ln_bmi: safeLog(bmi),
      sex_male: sex === "M" ? 1 : 0
    };
  }

  function lin(terms, x) {
    let out = 0;
    for (const k of Object.keys(terms)) {
      if (!(k in x)) throw new Error("Unknown predictor in registry: " + k);
      out += terms[k] * x[k];
    }
    return out;
  }

  // Transforms ------

  function transform(y, tf, c) {
    switch (tf) {
      case "identity": return y;
      case "log": return safeLog(y);
      case "log_plus": return safeLog(y + c);
      case "log_c_minus": return safeLog(c - y);
      case "sqrt": return isNum(y) && y >= 0 ? Math.sqrt(y) : NaN;
      default: return NaN;
    }
  }

  function inverse(mu, tf, c) {
    switch (tf) {
      case "identity": return mu;
      case "log": return Math.exp(mu);
      case "log_plus": return Math.exp(mu) - c;
      case "log_c_minus": return c - Math.exp(mu);
      case "sqrt": return Math.pow(Math.max(mu, 0), 2);
      default: return NaN;
    }
  }

  // One model, one subject ------
  // Returns pred, the values at z = lln_z and z = uln_z (unsorted), and the
  // oriented z, all in the set's native units.

  function modelScore(mod, x, y, zl, zu) {
    const typ = mod.type || "linear";

    if (typ === "lms") {
      const L = lin(mod.L_terms, x);
      const M = Math.exp(lin(mod.M_terms, x));
      const S = Math.exp(lin(mod.S_terms, x));
      const a = mod.shift.a;
      const b = mod.shift.b;
      const l0 = Math.abs(L) < 1e-10;
      const q = (z) => {
        let v;
        if (l0) v = M * Math.exp(S * z);
        else {
          const base = 1 + L * S * z;
          v = base > 0 ? M * Math.pow(base, 1 / L) : NaN;
        }
        return (v - b) / a;
      };
      let yp = a * y + b;
      if (!(isNum(yp) && yp > 0)) yp = NaN;
      const z = l0 ? Math.log(yp / M) / S : (Math.pow(yp / M, L) - 1) / (L * S);
      return { pred: (M - b) / a, endA: q(zl), endB: q(zu), z: Math.sign(a) * z };
    }

    let mu, sd, tf, c, orient;
    if (typ === "gamlss_normal") {
      const eta = lin(mod.mu_terms, x);
      mu = mod.mu_link === "log" ? Math.exp(eta) : eta;
      sd = lin(mod.sigma_terms, x);
      if (!(sd > 0)) sd = NaN;
      tf = mod.transform;
      c = NaN;
      orient = 1;
    } else if (typ === "linear") {
      mu = lin(mod.terms, x);
      sd = mod.rsd;
      tf = mod.transform;
      c = mod.c === undefined || mod.c === null ? NaN : mod.c;
      orient = tf === "log_c_minus" ? -1 : 1;
    } else {
      throw new Error("Unknown model type: " + typ);
    }
    return {
      pred: inverse(mu, tf, c),
      endA: inverse(mu + zl * sd, tf, c),
      endB: inverse(mu + zu * sd, tf, c),
      z: (orient * (transform(y, tf, c) - mu)) / sd
    };
  }

  function pickModel(spec, sex, age) {
    for (const mod of spec.models) {
      if (mod.sex !== "any" && mod.sex !== sex) continue;
      if (mod.age_from !== undefined && !(age >= mod.age_from && age < mod.age_to)) continue;
      return mod;
    }
    return null;
  }

  // Derivation-population ranges ------
  // Returns { in_range, issues: [{what, value, range}] }, sex-specific where
  // the source gives them.

  function rangeCheck(set, sex, age, heightM, weight) {
    const v = set.valid && set.valid[sex] ? set.valid[sex] : set.valid || {};
    const issues = [];
    if (v.age && !(age >= v.age[0] && age <= v.age[1])) {
      issues.push({ what: "age", value: age, lo: v.age[0], hi: v.age[1], unit: "y" });
    }
    if (v.height_m && !(heightM >= v.height_m[0] && heightM <= v.height_m[1])) {
      issues.push({ what: "height", value: heightM * 100, lo: v.height_m[0] * 100, hi: v.height_m[1] * 100, unit: "cm" });
    }
    if (v.height_cm && !(heightM * 100 >= v.height_cm[0] && heightM * 100 <= v.height_cm[1])) {
      issues.push({ what: "height", value: heightM * 100, lo: v.height_cm[0], hi: v.height_cm[1], unit: "cm" });
    }
    if (v.bmi_max !== undefined && isNum(weight)) {
      const bmi = weight / (heightM * heightM);
      if (bmi > v.bmi_max) issues.push({ what: "BMI", value: bmi, lo: null, hi: v.bmi_max, unit: "kg/m²" });
    }
    return { in_range: issues.length === 0, issues: issues };
  }

  // Score one parameter for one subject ------

  const PCT_RE = /^(R[0-9]+|Z[0-9]+|AX|Fres)(_insp|_exp|_5_37|_7_41)*$/;

  function score(reg, setId, param, inp) {
    const set = getSet(reg, setId);
    const spec = set.parameters[param];
    const sex = inp.sex;
    const age = inp.age;
    const heightM = inp.height_m;
    // Missing weight must stay missing: null would coerce to 0 in arithmetic.
    const weight = isNum(inp.weight_kg) ? inp.weight_kg : NaN;
    const out = {
      set_id: setId, param: param,
      pred_kpa: null, lln_kpa: null, uln_kpa: null, pred_native: null,
      z: null, pct_pred: null, abnormal: null, has_equation: !!spec,
      in_range: null, issues: [], units_native: null, reason: null
    };
    if (!spec) {
      out.reason = "no equation in this set";
      return out;
    }

    const rc = rangeCheck(set, sex, age, heightM, weight);
    out.in_range = rc.in_range;
    out.issues = rc.issues;

    const isPressure = spec.class === "pressure";
    const toKpa = reg.unit_factors_to_kPa;
    const kNative = isPressure ? toKpa[set.units] : 1;
    out.units_native = isPressure ? set.units : "Hz";

    let yNative = NaN;
    if (isNum(inp.measured)) {
      let kIn = 1;
      if (isPressure) {
        kIn = toKpa[inp.unit];
        if (kIn === undefined) throw new Error("Unknown pressure unit '" + inp.unit + "'. Use kPa, cmH2O or hPa.");
      }
      yNative = (inp.measured * kIn) / kNative;
    }

    if (!isNum(age) || !isNum(heightM) || !sex) {
      out.reason = "missing sex, age or height";
      return out;
    }
    const mod = pickModel(spec, sex, age);
    if (!mod) {
      out.reason = "no equation for this sex or age";
      return out;
    }

    const x = predictors(sex, age, heightM, weight);
    const r = modelScore(mod, x, yNative, reg.lln_z, reg.uln_z);

    if (!isNum(r.pred)) {
      out.reason = isNum(weight) ? "prediction undefined for these inputs" : "weight needed for this equation";
    }
    out.pred_native = fin(r.pred);
    out.pred_kpa = fin(r.pred * kNative);
    const lo = Math.min(r.endA, r.endB);
    const hi = Math.max(r.endA, r.endB);
    out.lln_kpa = fin(lo * kNative);
    out.uln_kpa = fin(hi * kNative);
    // Math.min/max propagate NaN, as R pmin/pmax do.
    out.z = fin(r.z);
    if (out.z === null && isNum(yNative) && out.pred_native !== null) {
      out.reason = "measured value outside the equation's domain";
    }

    const lowPrefix = reg.abnormal_low_prefix || "X";
    if (out.z !== null) {
      out.abnormal = param.startsWith(lowPrefix) ? out.z < reg.lln_z : out.z > reg.uln_z;
    }
    if (PCT_RE.test(param) && isNum(yNative) && out.pred_native) {
      out.pct_pred = fin((100 * yNative) / r.pred);
    }
    return out;
  }

  // Name resolution ------
  // 1. within-breath: append _insp / _exp from phase;
  // 2. waveform-specific rows (set.mode_params, tremoflo AX and Fres):
  //    append _5_37 / _7_41 from mode; missing mode -> null, never a guess;
  // 3. if the set has no row with that name, try reg.frequency_map
  //    (R11 -> R10, ...), so native 11/19 Hz rows are always preferred.
  // Returns { name, mapped_from } or { name: null, reason }.

  function normaliseMode(mode) {
    if (!mode) return null;
    const m = String(mode).match(/([0-9]+)[-–]([0-9]+)/);
    return m ? m[1] + "-" + m[2] : null;
  }

  function resolveName(reg, setId, param, phase, mode) {
    const set = getSet(reg, setId);
    const fmap = reg.frequency_map || {};
    const modeParams = set.mode_params || [];
    let p = param;
    if (phase === "insp" || phase === "exp") p = p + "_" + phase;
    const base = p.replace(/_(insp|exp)$/, "");
    if (modeParams.includes(base)) {
      const m = normaliseMode(mode);
      if (!m) return { name: null, reason: "needs tremoflo waveform" };
      p = p.replace(base, base + "_" + m.replace("-", "_"));
    }
    if (set.parameters[p]) return { name: p, mapped_from: null };
    if (fmap[base] && typeof fmap[base] === "string") {
      const alt = p.replace(base, fmap[base]);
      if (set.parameters[alt]) return { name: alt, mapped_from: p };
    }
    return { name: p, mapped_from: null, missing: true };
  }

  // Defaults and listing ------

  const CHILD_AGE_LIMIT = 18; // age < 18 uses the "child" default

  function defaultSetId(reg, device, age) {
    const d = reg.device_defaults && reg.device_defaults[device];
    if (!d) return null;
    return isNum(age) && age < CHILD_AGE_LIMIT ? d.child : d.adult;
  }

  function hasWithinBreath(set) {
    return Object.keys(set.parameters).some((k) => /_(insp|exp)$/.test(k));
  }

  function isAbnormalLow(reg, param) {
    return param.startsWith(reg.abnormal_low_prefix || "X");
  }

  return {
    predictors, transform, inverse, modelScore, pickModel, rangeCheck, score,
    resolveName, normaliseMode, defaultSetId, hasWithinBreath,
    isAbnormalLow, getSet, CHILD_AGE_LIMIT
  };
});
