/**
 * A small, dependency-free line chart (SVG) for the planning tools.
 *
 * series:    [{ name, points: [{ x, y }], step?: true }]  (step draws stair steps, for counts and costs)
 * refLines:  [{ y, label, tone?: "warn" | "limit" }]       horizontal reference lines
 * vLines:    [{ x, label }]                                 vertical markers, such as "capacity runs out here"
 * marker:    { x, y }                                       the point the user selected
 *
 * Colours come from CSS (see phase3.css) so the chart follows the page's look. Every chart has a text summary
 * (`summary`) for screen readers, and the planning tools also show the same numbers in a table.
 */
const WIDTH = 640;
const HEIGHT = 250;
const PAD = { left: 56, right: 16, top: 14, bottom: 38 };

const niceMax = (value) => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
};

export default function LineChart({
  series,
  refLines = [],
  vLines = [],
  marker,
  xMax,
  yMax,
  formatX = String,
  formatY = String,
  xLabel,
  yLabel,
  summary,
}) {
  const allPoints = series.flatMap((s) => s.points);
  const maxX = xMax ?? Math.max(1, ...allPoints.map((p) => p.x));
  const maxY = yMax ?? niceMax(Math.max(1, ...allPoints.map((p) => p.y), ...refLines.map((r) => r.y)));
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const sx = (x) => PAD.left + (Math.min(x, maxX) / maxX) * plotW;
  const sy = (y) => PAD.top + plotH - (Math.min(Math.max(y, 0), maxY) / maxY) * plotH;

  const path = (s) => {
    if (s.points.length === 0) return "";
    const parts = [`M ${sx(s.points[0].x)} ${sy(s.points[0].y)}`];
    for (let i = 1; i < s.points.length; i += 1) {
      const { x, y } = s.points[i];
      if (s.step) parts.push(`L ${sx(x)} ${sy(s.points[i - 1].y)}`);
      parts.push(`L ${sx(x)} ${sy(y)}`);
    }
    return parts.join(" ");
  };

  const ticks = [0, 1, 2, 3, 4];

  return (
    <figure className="chart planning-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={summary} className="line-chart">
        {ticks.map((i) => {
          const y = (maxY * i) / 4;
          return (
            <g key={`y${i}`}>
              <line className="grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={sy(y)} y2={sy(y)} />
              <text className="tick" x={PAD.left - 8} y={sy(y) + 4} textAnchor="end">
                {formatY(y)}
              </text>
            </g>
          );
        })}
        {ticks.map((i) => {
          const x = (maxX * i) / 4;
          return (
            <text key={`x${i}`} className="tick" x={sx(x)} y={HEIGHT - PAD.bottom + 16} textAnchor="middle">
              {formatX(x)}
            </text>
          );
        })}
        <line className="axis" x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} />
        <line
          className="axis"
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
        />

        {refLines.map((r) => (
          <g key={r.label}>
            <line
              className={`ref ${r.tone ?? ""}`}
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={sy(r.y)}
              y2={sy(r.y)}
            />
            <text
              className={`ref-label ${r.tone ?? ""}`}
              x={WIDTH - PAD.right - 4}
              y={sy(r.y) - 4}
              textAnchor="end"
            >
              {r.label}
            </text>
          </g>
        ))}
        {vLines
          .filter((v) => v.x <= maxX)
          .map((v) => (
            <g key={v.label}>
              <line className="vline" x1={sx(v.x)} x2={sx(v.x)} y1={PAD.top} y2={PAD.top + plotH} />
              <text className="ref-label limit" x={sx(v.x) - 4} y={PAD.top + 12} textAnchor="end">
                {v.label}
              </text>
            </g>
          ))}

        {series.map((s, index) => (
          <path key={s.name} className={`series series-${index % 4}`} d={path(s)} fill="none" />
        ))}
        {marker && <circle className="marker" cx={sx(marker.x)} cy={sy(marker.y)} r="5" />}

        {xLabel && (
          <text className="axis-label" x={PAD.left + plotW / 2} y={HEIGHT - 4} textAnchor="middle">
            {xLabel}
          </text>
        )}
        {yLabel && (
          <text
            className="axis-label"
            transform={`translate(12 ${PAD.top + plotH / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            {yLabel}
          </text>
        )}
      </svg>
      {series.length > 1 && (
        <figcaption className="legend">
          {series.map((s, index) => (
            <span key={s.name}>
              <i className={`swatch series-${index % 4}`} /> {s.name}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
