import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import EventMediaSections from "../../src/components/common/EventMediaSections";
import ReportPhotoPicker from "../../src/components/teacher/ReportPhotoPicker";

const photo = { id: "photo-1", media_type: "image", media_url: "/photo.jpg", file_name: "photo.jpg" };
const video = { id: "video-1", media_type: "video", media_url: "/video.mp4", file_name: "video.mp4" };

const renderMedia = (items) =>
  renderToStaticMarkup(React.createElement(EventMediaSections, { items, eventName: "Annual event" }));

describe("event media sections", () => {
  it("shows both media sections and accurate counts when both kinds exist", () => {
    const markup = renderMedia([photo, video, { ...photo, id: "photo-2" }]);

    expect(markup).toContain("Photos");
    expect(markup).toContain("Videos");
    expect(markup).toContain('aria-label="2 photos"');
    expect(markup).toContain('aria-label="1 video"');
  });

  it("shows only the photo section when the event has photos only", () => {
    const markup = renderMedia([photo]);

    expect(markup).toContain("Photos");
    expect(markup).not.toContain("Videos");
    expect(markup).not.toContain("0 videos");
  });

  it("shows only the video section when the event has videos only", () => {
    const markup = renderMedia([video]);

    expect(markup).not.toContain("Photos");
    expect(markup).toContain("Videos");
    expect(markup).not.toContain("0 photos");
  });

  it("renders no media section or report photo picker for an event without photos or videos", () => {
    const markup = renderMedia([]);
    const reportPicker = renderToStaticMarkup(
      React.createElement(ReportPhotoPicker, {
        eventId: "event-1",
        api: "/event-manager",
        photos: [],
        initial: [],
      }),
    );

    expect(markup).not.toContain("Photos");
    expect(markup).not.toContain("Videos");
    expect(markup).not.toContain("No photos uploaded");
    expect(markup).not.toContain("No videos uploaded");
    expect(reportPicker).toBe("");
  });
});
