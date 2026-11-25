import { estimateCapacity } from "../../api/client.js";
import { useRemote } from "../../useRemote.js";
import { List, NumberField, ToolState } from "./fields.jsx";
import { GlossaryText } from "./glossary.jsx";

const SOURCE_LABEL = { yours: "your value", requirements: "from requirements", default: "assumed" };

const format = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * Back-of-the-envelope capacity estimate. Every assumption is a box: leave it empty to use the value worked out
 * from the requirements (shown as the grey number) or type your own. Each result shows its formula.
 */
export default function Capacity({ architecture, requirements, onRequirementsChange }) {
  const key = JSON.stringify([architecture, requirements]);
  const { data, loading, error } = useRemote(() => estimateCapacity(architecture, requirements), [key]);
  const mine = requirements?.capacity_inputs ?? {};

  const setInput = (name, value) => {
    const next = { ...mine, [name]: value };
    if (value === null) delete next[name];
    onRequirementsChange({ capacity_inputs: next });
  };

  if (!data) return <ToolState data={data} loading={loading} error={error} />;

  const sections = [];
  for (const line of data.lines) {
    let s = sections.find((x) => x.name === line.section);
    if (!s) sections.push((s = { name: line.section, lines: [] }));
    s.lines.push(line);
  }

  return (
    <div className={loading ? "analysis-stale" : undefined}>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ul className="tool-headlines">
        {data.headlines.map((h, i) => (
          <li key={i}>
            <GlossaryText>{h}</GlossaryText>
          </li>
        ))}
      </ul>

      <h4>Assumptions</h4>
      <p className="hint">
        Leave a box empty to use the grey value. Changing one updates everything below, and is saved with the
        project.
      </p>
      <div className="tool-fields">
        {data.inputs.map((i) => (
          <NumberField
            key={i.key}
            id={`cap-${i.key}`}
            label={`${i.label} (${i.unit})`}
            value={mine[i.key] ?? null}
            placeholder={format(i.value)}
            min={i.minimum}
            max={i.maximum}
            onChange={(v) => setInput(i.key, v)}
            hint={`${SOURCE_LABEL[i.source]}. ${i.hint}`}
          />
        ))}
      </div>

      {sections.map((s) => (
        <div key={s.name}>
          <h4>{s.name}</h4>
          <div className="table-scroll">
            <table className="plain-table">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Estimate</th>
                  <th>How it is worked out</th>
                </tr>
              </thead>
              <tbody>
                {s.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <GlossaryText>{l.label}</GlossaryText>
                    </td>
                    <td>
                      <strong>{format(l.value)}</strong> {l.unit}
                    </td>
                    <td>
                      <code>{l.formula}</code>
                      {l.note && <div className="hint">{l.note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {data.comparison.length > 0 && (
        <>
          <h4>Compared with your design</h4>
          <List items={data.comparison} />
        </>
      )}
      <details className="how">
        <summary>About these estimates</summary>
        <List items={data.notes} />
      </details>
    </div>
  );
}
