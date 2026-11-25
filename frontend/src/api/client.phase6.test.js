import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareVersion,
  createShare,
  fetchAllProjects,
  fetchCostCsv,
  fetchDiagramFile,
  fetchDocumentFile,
  generateArchitecture,
  getSharedDesign,
  importDesign,
  refineArchitecture,
  restoreVersion,
  saveBlob,
  setToken,
  setUnauthorizedHandler,
  sharedDiagramUrl,
  sendFeedback,
} from "./client.js";

const json = (status, body, headers = {}) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  });

/** A streamed response whose body arrives in the given pieces of text. */
function streamed(pieces, status = 200) {
  const encoder = new TextEncoder();
  let i = 0;
  return Promise.resolve({
    ok: status === 200,
    status,
    headers: new Headers(),
    json: () => Promise.resolve({ detail: "Too many requests." }),
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            i < pieces.length ? { done: false, value: encoder.encode(pieces[i++]) } : { done: true }
          ),
      }),
    },
  });
}

const file = (name, type = "text/plain") =>
  Promise.resolve({
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Disposition": `attachment; filename="${name}"`, "Content-Type": type }),
    blob: () => Promise.resolve(new Blob(["data"])),
  });

describe("API client: AI, export and sharing", () => {
  let fetchMock;
  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setUnauthorizedHandler(() => {});
    setToken("tok");
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("generateArchitecture", () => {
    const ARCH = { project_name: "Shop", components: [], connections: [] };

    it("without progress it makes one plain request and reports a cached answer", async () => {
      fetchMock.mockReturnValue(json(200, ARCH, { "X-AI-Cached": "1" }));
      const meta = {};
      expect(await generateArchitecture("shop", { meta })).toEqual(ARCH);
      expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/architecture$/);
      expect(meta.cached).toBe(true);
    });

    it("says an answer was not cached when the header is absent", async () => {
      fetchMock.mockReturnValue(json(200, ARCH));
      const meta = {};
      await generateArchitecture("shop", { meta });
      expect(meta.cached).toBe(false);
    });

    it("streams progress then the result, even when a line is split across chunks", async () => {
      const lines = [
        JSON.stringify({ event: "progress", characters: 0 }),
        JSON.stringify({ event: "progress", characters: 400 }),
        JSON.stringify({ event: "result", cached: true, architecture: ARCH }),
      ].join("\n");
      const cut = lines.indexOf("400") + 1; // in the middle of a number
      fetchMock.mockReturnValue(streamed([lines.slice(0, cut), lines.slice(cut) + "\n"]));
      const progress = [];
      const meta = {};
      const result = await generateArchitecture("shop", { onProgress: (n) => progress.push(n), meta });
      expect(result).toEqual(ARCH);
      expect(progress).toEqual([0, 400]);
      expect(meta.cached).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/architecture\/stream$/);
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
    });

    it("handles a final result line that has no trailing newline", async () => {
      fetchMock.mockReturnValue(
        streamed([JSON.stringify({ event: "result", cached: false, architecture: ARCH })])
      );
      expect(await generateArchitecture("shop", { onProgress: () => {} })).toEqual(ARCH);
    });

    it("throws the server's message from an error event", async () => {
      fetchMock.mockReturnValue(
        streamed([JSON.stringify({ event: "error", status: 502, message: "AI service is busy" }) + "\n"])
      );
      await expect(generateArchitecture("shop", { onProgress: () => {} })).rejects.toThrow(
        "AI service is busy"
      );
    });

    it("throws if the stream ends without a design", async () => {
      fetchMock.mockReturnValue(streamed([JSON.stringify({ event: "progress", characters: 5 }) + "\n"]));
      await expect(generateArchitecture("shop", { onProgress: () => {} })).rejects.toThrow(/stopped before/);
    });

    it("throws the HTTP error before streaming starts (for example a rate limit)", async () => {
      fetchMock.mockReturnValue(streamed([], 429));
      await expect(generateArchitecture("shop", { onProgress: () => {} })).rejects.toThrow(
        "Too many requests."
      );
    });

    it("says when the backend cannot be reached", async () => {
      fetchMock.mockRejectedValue(new TypeError("network"));
      await expect(generateArchitecture("shop", { onProgress: () => {} })).rejects.toThrow(
        /Can't reach the backend/
      );
    });

    it("signs the user out when the login has expired", async () => {
      const onUnauthorized = vi.fn();
      setUnauthorizedHandler(onUnauthorized);
      fetchMock.mockReturnValue(json(401, { detail: "Please log in." }));
      await expect(generateArchitecture("shop")).rejects.toThrow("Please log in.");
      expect(onUnauthorized).toHaveBeenCalled();
    });
  });

  describe("requests", () => {
    it("sends the right bodies", async () => {
      fetchMock.mockReturnValue(json(200, {}));
      await refineArchitecture({ a: 1 }, null, "add search");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        architecture: { a: 1 },
        requirements: {},
        instruction: "add search",
      });
      await sendFeedback("p", undefined, 1);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        prompt: "p",
        project_name: "",
        rating: 1,
        comment: "",
      });
      await importDesign({ components: [] });
      expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ data: { components: [] } });
    });

    it("builds the share, version and public URLs", async () => {
      fetchMock.mockReturnValue(json(200, {}));
      await createShare(7);
      await compareVersion(7, 3);
      await restoreVersion(7, 3);
      await getSharedDesign("a/b");
      const urls = fetchMock.mock.calls.map((c) => c[0].replace(/^https?:\/\/[^/]+/, ""));
      expect(urls).toEqual([
        "/api/projects/7/share",
        "/api/projects/7/versions/3/compare",
        "/api/projects/7/versions/3/restore",
        "/api/shared/a%2Fb",
      ]);
      expect(sharedDiagramUrl("tok")).toMatch(/\/api\/shared\/tok\/diagram\.svg$/);
    });
  });

  describe("file downloads", () => {
    it("takes the file name from the response and sends the analysis settings", async () => {
      fetchMock.mockReturnValue(file("shop.md"));
      const { blob, filename } = await fetchDocumentFile(
        { a: 1 },
        { r: 1 },
        { capacity: 100, latency: 20, trafficScale: 0.5 }
      );
      expect(filename).toBe("shop.md");
      expect(blob).toBeInstanceOf(Blob);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/\/api\/export\/document\?format=markdown$/);
      expect(JSON.parse(init.body)).toEqual({
        architecture: { a: 1 },
        requirements: { r: 1 },
        capacity_per_server: 100,
        average_latency: 20,
        traffic_scale: 0.5,
      });
    });

    it("leaves out settings that were not set", async () => {
      fetchMock.mockReturnValue(file("c.csv"));
      await fetchCostCsv({ a: 1 }, null, {});
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        architecture: { a: 1 },
        requirements: {},
      });
    });

    it("uses a fallback name when the server sends none, and picks the diagram format", async () => {
      fetchMock.mockReturnValue(
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          blob: () => Promise.resolve(new Blob(["x"])),
        })
      );
      expect((await fetchDiagramFile({}, "svg")).filename).toBe("diagram.svg");
      expect((await fetchDiagramFile({}, "mermaid")).filename).toBe("diagram.mmd");
      expect(fetchMock.mock.calls[1][0]).toMatch(/format=mermaid$/);
    });

    it("downloads all projects with a GET and the login", async () => {
      fetchMock.mockReturnValue(file("all.json"));
      expect((await fetchAllProjects()).filename).toBe("all.json");
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
      expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    });

    it("throws the server's reason when a download is refused", async () => {
      fetchMock.mockReturnValue(json(422, { detail: "The design has no components." }));
      await expect(fetchDocumentFile({}, {}, {})).rejects.toThrow("The design has no components.");
      fetchMock.mockRejectedValue(new TypeError("offline"));
      await expect(fetchAllProjects()).rejects.toThrow(/Can't reach the backend/);
    });

    it("saves a blob through a temporary link and cleans up", () => {
      vi.useFakeTimers();
      const created = vi.fn().mockReturnValue("blob:x");
      const revoked = vi.fn();
      URL.createObjectURL = created;
      URL.revokeObjectURL = revoked;
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      saveBlob(new Blob(["x"]), "out.txt");
      expect(click).toHaveBeenCalled();
      expect(document.querySelector("a[download]")).toBeNull(); // the link is removed again
      vi.advanceTimersByTime(1100);
      expect(revoked).toHaveBeenCalledWith("blob:x");
      click.mockRestore();
      vi.useRealTimers();
    });
  });
});
