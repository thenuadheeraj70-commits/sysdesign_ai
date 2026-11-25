import { useEffect, useRef, useState } from "react";

/**
 * Calls `fetcher()` after the inputs stop changing for `delay` ms, and keeps the latest answer.
 * Answers that arrive after a newer request was made are ignored. `deps` lists everything the fetcher uses.
 *
 *   const { data, loading, error } = useRemote(() => compareVariants(list, settings), [list, settings]);
 */
export function useRemote(fetcher, deps, { enabled = true, delay = 400 } = {}) {
  const [state, setState] = useState({ data: null, loading: false, error: "" });
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const id = ++latest.current;
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true, error: "" }));
      try {
        const data = await fetcher();
        if (id === latest.current) setState({ data, loading: false, error: "" });
      } catch (err) {
        if (id === latest.current) setState({ data: null, loading: false, error: err.message });
      }
    }, delay);
    return () => clearTimeout(timer);
    // `deps` is the caller's list of everything `fetcher` depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, delay, ...deps]);

  return state;
}
