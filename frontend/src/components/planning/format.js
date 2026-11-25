export const money = (n) => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
export const money2 = (n) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const percent = (n) => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
export const number = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
/** Compact numbers for chart axes: 1,200 -> 1.2k */
export const compact = (n) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
