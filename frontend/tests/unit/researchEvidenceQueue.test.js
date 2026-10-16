import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import EvidenceQueue from "../../src/components/research/EvidenceQueue";

describe("Event Manager research evidence upload control", () => {
  it("uses a compact optional upload button inside the form", () => {
    const markup = renderToStaticMarkup(
      React.createElement(EvidenceQueue, {
        tags: ["Filing receipt"],
        limits: { max_evidence_files: 5, max_evidence_total_bytes: 1024 * 1024 },
        required: false,
        existing: [],
        queued: [],
        setQueued: () => {},
        compact: true,
      }),
    );

    expect(markup).toContain("Upload Research Evidence");
    expect(markup).toContain("Optional.");
    expect(markup).not.toContain("Drop files here or choose files");
    expect(markup).toContain('data-testid="evidence-input"');
  });
});
