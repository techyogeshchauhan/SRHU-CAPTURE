import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../src/services/api";
import { downloadEventReport, REPORT_DOWNLOAD_TIMEOUT_MS, REPORT_TIMEOUT_MESSAGE } from "../../src/services/eventManager";

vi.mock("../../src/services/api", () => ({
  apiFetch: vi.fn(),
  errorFromResponse: async (response, fallback) => new Error((await response.json()).detail || fallback),
}));

describe("report request deadline", () => {
  const click = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetch.mockReset();
    click.mockReset();
    vi.stubGlobal("window", { isSecureContext: true, URL: { createObjectURL: vi.fn(() => "blob:pdf"), revokeObjectURL: vi.fn() } });
    vi.stubGlobal("document", { body: { appendChild: vi.fn() }, createElement: () => ({ click, remove: vi.fn() }) });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each(["request", "body"])("settles and aborts a stalled %s", async (phase) => {
    let signal;
    apiFetch.mockImplementation((_path, options) => {
      signal = options.signal;
      return phase === "request" ? new Promise(() => {})
        : Promise.resolve({ ok: true, blob: () => new Promise(() => {}) });
    });
    const outcome = expect(downloadEventReport("one", "Workshop", {})).rejects.toThrow(REPORT_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(REPORT_DOWNLOAD_TIMEOUT_MS);
    await outcome;
    expect(signal.aborted).toBe(true);
    expect(click).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not download a late response after timing out", async () => {
    let release;
    apiFetch.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = expect(downloadEventReport("one", "Workshop", {})).rejects.toThrow(REPORT_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(REPORT_DOWNLOAD_TIMEOUT_MS);
    await pending;
    release(new Response("%PDF-1.4\n%%EOF", { headers: { "Content-Type": "application/pdf" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(click).not.toHaveBeenCalled();
  });

  it("rejects successful non-PDF responses and allows a later real download", async () => {
    apiFetch.mockResolvedValueOnce(new Response("<html>Proxy error</html>"));
    await expect(downloadEventReport("one", "Workshop", {})).rejects.toThrow("did not return a PDF");
    expect(click).not.toHaveBeenCalled();
    apiFetch.mockResolvedValueOnce(new Response("%PDF-1.4\n%%EOF", { headers: { "Content-Type": "application/pdf" } }));
    await expect(downloadEventReport("one", "Workshop", {})).resolves.toBe("downloaded");
    expect(click).toHaveBeenCalledOnce();
  });

  it("reports a broken response body concisely and clears its timer", async () => {
    apiFetch.mockResolvedValue({ ok: true, blob: async () => { throw new TypeError("Failed to fetch"); } });
    await expect(downloadEventReport("one", "Workshop", {})).rejects.toThrow("Check your connection and try again");
    expect(vi.getTimerCount()).toBe(0);
  });
});
