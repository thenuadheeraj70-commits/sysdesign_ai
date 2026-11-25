/** Saves text as a file download. */
export function downloadText(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Copies text to the clipboard. Returns true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The number as a short sentence fragment: 99.9 -> "99.9%". */
export const pct = (n, digits = 3) =>
  `${Number(n)
    .toFixed(digits)
    .replace(/\.?0+$/, "")}%`;

/** 125 -> "2 h 5 min", 0.5 -> "30 s", 1500 -> "1 day 1 h" */
export function duration(minutes) {
  const m = Number(minutes);
  if (m === 0) return "0";
  if (m < 1) return `${Math.round(m * 60)} s`;
  if (m < 60) return `${Math.round(m * 10) / 10} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
  const d = Math.floor(m / 1440);
  const h = Math.round((m % 1440) / 60);
  return `${d} day${d === 1 ? "" : "s"}${h ? ` ${h} h` : ""}`;
}
