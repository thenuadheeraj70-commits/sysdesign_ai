const COLUMN = 170;
const HEADER = 44;
const ROW = 38;
const PAD = 16;

/** Text kept short enough for its slot. */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A sequence diagram drawn as SVG from participants and steps. Calls are solid arrows, returns dashed,
 * asynchronous messages have an open head, and alt/else/end steps draw a labelled frame.
 */
export default function SequenceDiagram({ participants, steps, title }) {
  const index = new Map(participants.map((p, i) => [p.id, i]));
  const x = (id) => PAD + COLUMN / 2 + (index.get(id) ?? 0) * COLUMN;
  const width = PAD * 2 + participants.length * COLUMN;

  const shapes = [];
  const frames = [];
  const open = [];
  let y = HEADER + 12;

  steps.forEach((step, i) => {
    if (step.kind === "alt") {
      y += 10;
      open.push({ top: y, label: step.label });
      y += 22;
      return;
    }
    if (step.kind === "else") {
      const frame = open[open.length - 1];
      if (frame) {
        shapes.push(
          <g key={i}>
            <line className="seq-else" x1={PAD / 2} x2={width - PAD / 2} y1={y} y2={y} />
            <text className="seq-small" x={PAD / 2 + 6} y={y + 14}>
              [{step.label || "otherwise"}]
            </text>
          </g>
        );
        y += 22;
      }
      return;
    }
    if (step.kind === "end") {
      const frame = open.pop();
      if (frame) frames.push({ ...frame, bottom: y });
      y += 10;
      return;
    }
    if (step.kind === "note") {
      const a = x(step.source);
      const b = x(step.target);
      const left = Math.min(a, b) - 70;
      const w = Math.abs(a - b) + 140;
      y += 8;
      shapes.push(
        <g key={i}>
          <rect className="seq-note" x={left} y={y} width={w} height={26} rx="3" />
          <text className="seq-small" x={left + w / 2} y={y + 17} textAnchor="middle">
            {clip(step.label, Math.floor(w / 6.2))}
          </text>
        </g>
      );
      y += 36;
      return;
    }

    // call, return, async
    y += ROW;
    const from = x(step.source);
    const to = x(step.target);
    const dashed = step.kind === "return";
    const marker = step.kind === "call" ? "seq-solid" : "seq-open";
    if (step.source === step.target) {
      shapes.push(
        <g key={i}>
          <path
            className={`seq-line${dashed ? " dashed" : ""}`}
            d={`M ${from} ${y - 14} h 34 v 16 h -34`}
            fill="none"
            markerEnd={`url(#${marker})`}
          />
          <text className="seq-label" x={from + 42} y={y - 2}>
            {clip(step.label, 28)}
          </text>
        </g>
      );
      y += 6;
    } else {
      shapes.push(
        <g key={i}>
          <line
            className={`seq-line${dashed ? " dashed" : ""}`}
            x1={from}
            x2={to}
            y1={y}
            y2={y}
            markerEnd={`url(#${marker})`}
          />
          <text className="seq-label" x={(from + to) / 2} y={y - 7} textAnchor="middle">
            {clip(step.label, Math.max(10, Math.floor((Math.abs(to - from) - 10) / 6.2)))}
          </text>
        </g>
      );
    }
  });
  const height = y + ROW;
  while (open.length) frames.push({ ...open.pop(), bottom: height - 12 });

  const summary = `${title}. ${steps.filter((s) => ["call", "return", "async"].includes(s.kind)).length} messages between ${participants
    .map((p) => p.name)
    .join(", ")}.`;

  return (
    <div className="seq-scroll">
      <svg
        className="seq"
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
      >
        <defs>
          <marker
            id="seq-solid"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="seq-head" />
          </marker>
          <marker
            id="seq-open"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M 0 1 L 9 5 L 0 9" fill="none" className="seq-head-open" />
          </marker>
        </defs>

        {frames.map((f, i) => (
          <g key={`f${i}`}>
            <rect
              className="seq-frame"
              x={PAD / 2}
              y={f.top}
              width={width - PAD}
              height={f.bottom - f.top}
              rx="4"
            />
            <text className="seq-small strong" x={PAD / 2 + 6} y={f.top + 14}>
              alt {f.label}
            </text>
          </g>
        ))}

        {participants.map((p) => (
          <g key={p.id}>
            <line className="seq-life" x1={x(p.id)} x2={x(p.id)} y1={HEADER} y2={height - 8} />
            <rect className="seq-box" x={x(p.id) - 62} y={6} width={124} height={HEADER - 12} rx="5" />
            <text className="seq-name" x={x(p.id)} y={HEADER / 2 + 4} textAnchor="middle">
              {clip(p.name, 19)}
            </text>
          </g>
        ))}
        {shapes}
      </svg>
    </div>
  );
}
