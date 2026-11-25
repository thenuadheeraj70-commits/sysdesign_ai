import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeArchitecture,
  deleteProject,
  generateInfrastructureCode,
  getToken,
  listProjects,
  setToken,
  setUnauthorizedHandler,
} from "./client.js";

function reply(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  });
}

describe("API client", () => {
  let fetchMock;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setUnauthorizedHandler(() => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stores and clears the login token", () => {
    expect(getToken()).toBeNull();
    setToken("abc");
    expect(getToken()).toBe("abc");
    setToken(null);
    expect(getToken()).toBeNull();
  });

  it("sends JSON with the token and returns the parsed answer", async () => {
    setToken("tok");
    fetchMock.mockReturnValue(reply(200, { ok: true }));
    expect(await analyzeArchitecture({ a: 1 })).toEqual({ ok: true });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/analyze$/);
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    });
    expect(JSON.parse(options.body)).toEqual({ a: 1 });
  });

  it("sends no Authorization header when logged out", async () => {
    fetchMock.mockReturnValue(reply(200, {}));
    await analyzeArchitecture({});
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("treats 204 as an empty success", async () => {
    fetchMock.mockReturnValue(reply(204));
    expect(await deleteProject(5)).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/projects\/5$/);
  });

  it("can delete permanently", async () => {
    fetchMock.mockReturnValue(reply(204));
    await deleteProject(5, { permanent: true });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/projects\/5\?permanent=true$/);
  });

  it("reads a plain error message from the server", async () => {
    fetchMock.mockReturnValue(reply(409, { detail: "Already exists." }));
    await expect(analyzeArchitecture({})).rejects.toThrow("Already exists.");
  });

  it("reads the first validation message and drops the 'Value error' prefix", async () => {
    fetchMock.mockReturnValue(reply(422, { detail: [{ msg: "Value error, Enter a valid email address" }] }));
    await expect(analyzeArchitecture({})).rejects.toThrow("Enter a valid email address");
  });

  it("falls back to the status code when the error has no readable body", async () => {
    fetchMock.mockReturnValue(reply(500));
    await expect(analyzeArchitecture({})).rejects.toThrow("Request failed (500).");
  });

  it("explains a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(analyzeArchitecture({})).rejects.toThrow(/Can't reach the backend/);
  });

  it("calls the unauthorized handler on a 401 when a token was sent", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    setToken("expired");
    fetchMock.mockReturnValue(reply(401, { detail: "Please log in." }));
    await expect(analyzeArchitecture({})).rejects.toThrow("Please log in.");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not treat a failed login (401 with no token) as an expired session", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockReturnValue(reply(401, { detail: "Incorrect email or password." }));
    await expect(analyzeArchitecture({})).rejects.toThrow("Incorrect");
    expect(handler).not.toHaveBeenCalled();
  });

  it("builds the project list query, skipping an empty search", async () => {
    fetchMock.mockReturnValue(reply(200, { items: [] }));
    await listProjects({ q: "  ", limit: 5, offset: 10, sort: "name" });
    await listProjects({ q: " shop ", limit: 5, offset: 0 });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\?limit=5&offset=10&sort=name$/);
    expect(fetchMock.mock.calls[1][0]).toContain("q=shop");
  });

  it("adds the region to code generation only when there is one", async () => {
    fetchMock.mockReturnValue(reply(200, {}));
    await generateInfrastructureCode({ project_name: "x" }, "eu-west-1");
    await generateInfrastructureCode({ project_name: "x" });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/generate-code\?region=eu-west-1$/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/generate-code$/);
  });
});
