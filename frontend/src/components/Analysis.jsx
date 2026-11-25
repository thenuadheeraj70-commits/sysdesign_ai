import { useEffect, useRef, useState } from "react";
import { analyzeArchitecture, previewFix } from "../api/client.js";
import { useCatalog } from "../catalog.jsx";
import PerformanceResults from "./PerformanceResults.jsx";
import CostResults from "./CostResults.jsx";
import RecommendationsView from "./RecommendationsView.jsx";

const DEBOUNCE_MS = 500;
const EMPTY_FIELDS = {
  users: "",
  peak: "",
  budget: "",
  capacity: "",
  latency: "",
  // traffic profile (percentages are typed as percentages, stored as fractions)
  peakToAvg: "",
  surge: "",
  readPct: "",
  hitPct: "",
  // discounts
  commit: "",
  spotShare: "",
  spotDiscount: "",
};

// Allowed ranges, matching the backend. An empty box means "use the default".
const RANGES = {
  peakToAvg: [1, 100, "Peak-to-average ratio must be between 1 and 100."],
  surge: [1, 20, "Surge multiplier must be between 1 and 20."],
  readPct: [0, 100, "Read share must be between 0 and 100 percent."],
  hitPct: [0, 100, "Cache hit rate must be between 0 and 100 percent."],
  commit: [0, 70, "Commitment discount must be between 0 and 70 percent."],
  spotShare: [0, 100, "Spot share must be between 0 and 100 percent."],
  spotDiscount: [0, 90, "Spot discount must be between 0 and 90 percent."],
};

const text = (n) => (n == null ? "" : String(n));
const toNumber = (value) => (value.trim() === "" ? null : Number(value));
const invalid = (value, min) => {
  if (value.trim() === "") return false;
  const n = Number(value);
  return !(Number.isFinite(n) && n >= min);
};

/** A stored fraction (0.8) as the percentage typed in the box ("80"). */
const percentText = (fraction) => (fraction == null ? "" : String(Math.round(fraction * 10000) / 100));
const outOfRange = (value, [min, max]) => {
  if (value.trim() === "") return false;
  const n = Number(value);
  return !(Number.isFinite(n) && n >= min && n <= max);
};
/** A number from a box, or null when it is empty or not valid. */
const validNumber = (value, min) => (invalid(value, min) ? null : toNumber(value));

/** The traffic profile and discounts objects for the boxes' current text (empty boxes are left out). */
function profileFrom(f) {
  const out = {};
  const put = (key, value, scale = 1) => {
    if (value.trim() !== "" && !Number.isNaN(Number(value))) out[key] = Number(value) / scale;
  };
  put("peak_to_average", f.peakToAvg);
  put("surge_multiplier", f.surge);
  put("read_ratio", f.readPct, 100);
  put("cache_hit_ratio", f.hitPct, 100);
  return out;
}
function discountsFrom(f) {
  const out = {};
  const put = (key, value) => {
    if (value.trim() !== "" && !Number.isNaN(Number(value))) out[key] = Number(value);
  };
  put("commitment_percent", f.commit);
  put("spot_share_percent", f.spotShare);
  put("spot_discount_percent", f.spotDiscount);
  return out;
}

/** The text boxes' starting values for a set of requirements. */
const seedFields = (requirements) => ({
  ...EMPTY_FIELDS,
  users: text(requirements?.expected_users),
  peak: text(requirements?.peak_requests_per_second),
  budget: text(requirements?.monthly_budget),
  peakToAvg: text(requirements?.traffic_profile?.peak_to_average),
  surge: text(requirements?.traffic_profile?.surge_multiplier),
  readPct: percentText(requirements?.traffic_profile?.read_ratio),
  hitPct: percentText(requirements?.traffic_profile?.cache_hit_ratio),
  commit: text(requirements?.discounts?.commitment_percent),
  spotShare: text(requirements?.discounts?.spot_share_percent),
  spotDiscount: text(requirements?.discounts?.spot_discount_percent),
});
const seedNotes = (requirements) => (requirements?.notes ?? []).join("\n");

function problemWith(f) {
  if (invalid(f.users, 0)) return "Expected users must be 0 or more.";
  if (invalid(f.peak, 0)) return "Peak requests per second must be 0 or more.";
  if (invalid(f.budget, 0)) return "Monthly budget must be 0 or more.";
  if (invalid(f.capacity, 1e-9)) return "Capacity per server must be greater than 0.";
  if (invalid(f.latency, 0)) return "Average latency must be 0 or more.";
  for (const [field, range] of Object.entries(RANGES)) {
    if (outOfRange(f[field], range)) return range[2];
  }
  return "";
}

/**
 * One connected analysis: performance, cost and recommendations are all derived from the
 * architecture and the requirements, and recomputed whenever either changes. Every
 * requirement can be edited. Numbers left empty are estimated by the backend and listed
 * under "Assumptions made". Editing the user count clears the peak so it is re-estimated.
 */
export default function Analysis({
  architecture,
  requirements,
  onRequirementsChange,
  onSettingsChange,
  trafficScale = 1,
  seedKey,
  requirementsStatus,
  onApplyFix,
  applying,
  fixError,
}) {
  const { providers } = useCatalog();
  const [fields, setFields] = useState(() => seedFields(requirements));
  const [notes, setNotes] = useState(() => seedNotes(requirements));
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(0);

  // Fill the boxes when requirements arrive from the AI or from a saved project (when `seedKey`
  // changes), not on every edit, which would overwrite what is being typed. This adjusts state
  // while rendering, as React recommends, instead of in an effect.
  const [seenSeedKey, setSeenSeedKey] = useState(seedKey);
  if (seedKey !== seenSeedKey) {
    setSeenSeedKey(seedKey);
    setFields(seedFields(requirements));
    setNotes(seedNotes(requirements));
  }

  const problem = problemWith(fields);
  const waiting = requirementsStatus === "loading";
  const capacity = toNumber(fields.capacity);
  const latency = toNumber(fields.latency);

  useEffect(() => {
    if (!architecture || problem || waiting) return undefined;
    const id = ++latest.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const data = await analyzeArchitecture({
          architecture,
          requirements: requirements ?? {},
          capacity_per_server: capacity,
          average_latency: latency,
          traffic_scale: trafficScale,
        });
        if (id === latest.current) setAnalysis(data);
      } catch (err) {
        if (id === latest.current) {
          setAnalysis(null);
          setError(err.message);
        }
      } finally {
        if (id === latest.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [architecture, requirements, capacity, latency, trafficScale, problem, waiting]);

  if (!architecture) {
    return (
      <section className="panel perf" aria-labelledby="analysis-title">
        <h2 id="analysis-title">Analysis</h2>
        <p className="perf-intro">
          Generate an architecture first. Performance, cost and recommendations are then worked out from it
          automatically.
        </p>
      </section>
    );
  }

  // ---- editing helpers ----
  // A number box keeps its own text (so "12." can be typed) and pushes only valid values up.
  function setNumber(key, field, min, extra = {}) {
    return (e) => {
      const value = e.target.value;
      setFields((f) => ({ ...f, [field]: value, ...(field === "users" ? { peak: "" } : {}) }));
      if (!invalid(value, min)) {
        onRequirementsChange({
          [key]: toNumber(value),
          ...extra,
          ...(field === "users" ? { peak_requests_per_second: null } : {}),
        });
      }
    };
  }
  const setLocal = (field) => (e) => {
    const next = { ...fields, [field]: e.target.value };
    setFields(next);
    if (field === "capacity" || field === "latency") {
      // The planning tools use the same overrides as this section.
      onSettingsChange?.({
        capacity: validNumber(next.capacity, 1e-9),
        latency: validNumber(next.latency, 0),
      });
    }
  };
  // Traffic profile and discounts: keep the text, and push every valid value up as a whole object.
  const setProfile = (field) => (e) => {
    const next = { ...fields, [field]: e.target.value };
    setFields(next);
    if (!outOfRange(e.target.value, RANGES[field])) {
      onRequirementsChange({ traffic_profile: profileFrom(next), discounts: discountsFrom(next) });
    }
  };
  const customised =
    (fields.peakToAvg !== "" && Number(fields.peakToAvg) !== 10) ||
    (fields.surge !== "" && Number(fields.surge) !== 1) ||
    (fields.readPct !== "" && Number(fields.readPct) !== 80) ||
    (fields.hitPct !== "" && Number(fields.hitPct) !== 70) ||
    Number(fields.commit) > 0 ||
    Number(fields.spotShare) > 0;
  const setText = (key) => (e) => onRequirementsChange({ [key]: e.target.value });
  const r = requirements ?? {};
  const used = analysis?.inputs;
  const nameById = Object.fromEntries(architecture.components.map((c) => [c.id, c.name]));

  const preview = (fix) =>
    previewFix({
      architecture,
      requirements: r,
      capacity_per_server: capacity,
      average_latency: latency,
      traffic_scale: trafficScale,
      patch: fix,
    });

  return (
    <section className="panel perf" aria-labelledby="analysis-title">
      <h2 id="analysis-title">Analysis</h2>
      <p className="perf-intro">
        Performance, cost and recommendations are calculated from your architecture and these requirements,
        and update automatically when you change a component or a value. Leave a number empty to let the app
        estimate it.
      </p>
      {requirementsStatus === "failed" && (
        <p className="hint">
          Couldn't read requirements from your description, so fill in what you know below.
        </p>
      )}

      <h3>Requirements</h3>
      <div className="perf-form">
        <TextField
          id="a-type"
          label="Application type"
          value={r.application_type ?? ""}
          onChange={setText("application_type")}
          placeholder="e.g. e-commerce"
          maxLength={200}
        />
        <Field
          id="a-users"
          label="Expected users"
          value={fields.users}
          onChange={setNumber("expected_users", "users", 0)}
          hint={
            used && r.expected_users != null && r.peak_requests_per_second == null
              ? "Peak traffic is estimated from this"
              : "Used to estimate peak traffic"
          }
        />
        <TextField
          id="a-avail"
          label="Availability target"
          value={r.availability_target ?? ""}
          onChange={setText("availability_target")}
          placeholder="e.g. 99.9%"
          maxLength={100}
        />
        <div className="field">
          <label htmlFor="a-provider">Cloud provider</label>
          <select id="a-provider" value={r.cloud_provider ?? ""} onChange={setText("cloud_provider")}>
            <option value="">Not set</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <TextField
          id="a-region"
          label="Region"
          value={r.region ?? ""}
          onChange={setText("region")}
          placeholder="e.g. eu-west-1"
          maxLength={30}
          hint="Becomes the Terraform default region"
        />
      </div>
      <div className="field notes-field">
        <label htmlFor="a-notes">Other requirements (one per line)</label>
        <textarea
          id="a-notes"
          rows={3}
          value={notes}
          placeholder="e.g. payments must be PCI compliant"
          onChange={(e) => {
            setNotes(e.target.value);
            onRequirementsChange({
              notes: e.target.value
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .slice(0, 20),
            });
          }}
        />
      </div>

      <h3>Traffic, budget and capacity</h3>
      <div className="perf-form">
        <Field
          id="a-peak"
          label="Peak requests per second"
          value={fields.peak}
          onChange={setNumber("peak_requests_per_second", "peak", 0)}
          hint={used ? `Using ${used.peak_requests_per_second.toLocaleString()}` : "Estimated from users"}
        />
        <Field
          id="a-budget"
          label="Monthly budget (USD)"
          value={fields.budget}
          onChange={setNumber("monthly_budget", "budget", 0)}
          hint={used?.monthly_budget != null ? "Compared against the cost" : "None: no budget check"}
        />
        <Field
          id="a-capacity"
          label="Capacity per server (req/s)"
          value={fields.capacity}
          onChange={setLocal("capacity")}
          hint={used ? `Using ${used.capacity_per_server}` : "Estimated"}
        />
        <Field
          id="a-latency"
          label="Average latency (ms)"
          value={fields.latency}
          onChange={setLocal("latency")}
          hint={used ? `Using ${used.average_latency}` : "Estimated"}
        />
      </div>
      {trafficScale !== 1 && (
        <p className="hint">
          This variant serves {Math.round(trafficScale * 10000) / 100}% of the peak traffic, so the numbers
          below use that share. Change it above the diagram.
        </p>
      )}

      <details className="how profile-details">
        <summary>Traffic profile and discounts{customised ? " (customised)" : ""}</summary>
        <p className="hint">
          Beyond one peak number: how spiky the traffic is and how it splits between reads and writes, and
          optional price reductions. Leave a box empty to use the default.
        </p>
        <h4>Traffic profile</h4>
        <div className="perf-form">
          <Field
            id="a-p2a"
            label="Peak vs daily average (×)"
            value={fields.peakToAvg}
            onChange={setProfile("peakToAvg")}
            placeholder="10"
            hint="How much busier the busiest moment is than the daily average"
          />
          <Field
            id="a-surge"
            label="Surge multiplier (×)"
            value={fields.surge}
            onChange={setProfile("surge")}
            placeholder="1"
            hint="Short spikes on top of the peak. Servers are sized for peak × this."
          />
          <Field
            id="a-read"
            label="Reads (% of requests)"
            value={fields.readPct}
            onChange={setProfile("readPct")}
            placeholder="80"
            hint="Used to estimate database and cache load in the growth tool"
          />
          <Field
            id="a-hit"
            label="Cache hit rate (% of reads)"
            value={fields.hitPct}
            onChange={setProfile("hitPct")}
            placeholder="70"
            hint="Only matters when the design has a cache"
          />
        </div>
        <h4>Discounts</h4>
        <div className="perf-form">
          <Field
            id="a-commit"
            label="Reserved / savings plan (% off)"
            value={fields.commit}
            onChange={setProfile("commit")}
            placeholder="0"
            hint="On always-on compute, database, cache and search"
          />
          <Field
            id="a-spot-share"
            label="Workers on spot (%)"
            value={fields.spotShare}
            onChange={setProfile("spotShare")}
            placeholder="0"
            hint="Background workers that can be interrupted. Web servers never use spot."
          />
          <Field
            id="a-spot-off"
            label="Spot discount (% off)"
            value={fields.spotDiscount}
            onChange={setProfile("spotDiscount")}
            placeholder="70"
            hint="Typical spot savings are 60 to 90%"
          />
        </div>
      </details>
      {problem && <p className="form-error">{problem}</p>}

      <p className="hint" aria-live="polite">
        {waiting ? "Reading your requirements…" : loading ? "Recalculating…" : analysis ? "Up to date." : ""}
      </p>

      {error && (
        <div className="state error perf-error" role="alert">
          <h3>Couldn't analyze the architecture</h3>
          <p>{error}</p>
        </div>
      )}

      {analysis && !error && (
        <div className={loading ? "analysis-stale" : undefined}>
          <details className="how" open>
            <summary>Assumptions made ({analysis.derived.length})</summary>
            <ul>
              {analysis.derived.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </details>

          <h3>Performance</h3>
          <PerformanceResults result={analysis.performance} />

          <h3>Cost</h3>
          <CostResults result={analysis.cost} />

          <h3>Recommendations</h3>
          <RecommendationsView
            data={analysis.optimization}
            nameById={nameById}
            onApplyFix={onApplyFix}
            onPreviewFix={preview}
            applying={applying}
            fixError={fixError}
          />
        </div>
      )}
    </section>
  );
}

function Field({ id, label, value, onChange, hint, placeholder = "Auto" }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
      />
      <span className="hint">{hint}</span>
    </div>
  );
}

function TextField({ id, label, value, onChange, placeholder, maxLength, hint }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        maxLength={maxLength}
      />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
