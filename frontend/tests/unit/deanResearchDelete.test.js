import { afterEach, describe, expect, it, vi } from "vitest";

import * as apiModule from "../../src/services/api";
import { deanBulkDeleteResearch, deanDeleteResearch } from "../../src/services/research";

describe("Dean research delete API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("deletes one record through the Dean endpoint", async () => {
    const apiJson = vi.spyOn(apiModule, "apiJson").mockResolvedValue({ success: true });

    await deanDeleteResearch("record-1");

    expect(apiJson).toHaveBeenCalledWith("/dean/research/records/record-1", { method: "DELETE" });
  });

  it("sends selected record ids together through the Dean bulk endpoint", async () => {
    const apiJson = vi.spyOn(apiModule, "apiJson").mockResolvedValue({ success: true });
    const ids = ["record-1", "record-2"];

    await deanBulkDeleteResearch(ids);

    expect(apiJson).toHaveBeenCalledWith("/dean/research/bulk-delete", {
      method: "POST",
      body: { ids },
    });
  });
});
