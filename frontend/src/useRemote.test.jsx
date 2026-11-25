import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRemote } from "./useRemote.js";

describe("useRemote", () => {
  it("fetches after the inputs settle and keeps the answer", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const { result } = renderHook(() => useRemote(fetcher, ["a"], { delay: 0 }));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    expect(result.current).toMatchObject({ loading: false, error: "" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("calls once for a burst of changes (debounce)", async () => {
    const fetcher = vi.fn().mockResolvedValue("ok");
    const { rerender } = renderHook(({ dep }) => useRemote(fetcher, [dep], { delay: 80 }), {
      initialProps: { dep: 1 },
    });
    rerender({ dep: 2 });
    rerender({ dep: 3 });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("ignores an answer that arrives after a newer request", async () => {
    let releaseSlow;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (releaseSlow = () => resolve("old"))))
      .mockResolvedValueOnce("new");
    const { result, rerender } = renderHook(({ dep }) => useRemote(fetcher, [dep], { delay: 0 }), {
      initialProps: { dep: 1 },
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    rerender({ dep: 2 });
    await waitFor(() => expect(result.current.data).toBe("new"));
    await act(async () => releaseSlow());
    expect(result.current.data).toBe("new");
  });

  it("reports an error and clears the data", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useRemote(fetcher, [], { delay: 0 }));
    await waitFor(() => expect(result.current.error).toBe("nope"));
    expect(result.current.data).toBeNull();
  });

  it("does nothing while disabled", async () => {
    const fetcher = vi.fn().mockResolvedValue("x");
    renderHook(() => useRemote(fetcher, [], { delay: 0, enabled: false }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
