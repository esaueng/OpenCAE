import { describe, expect, test } from "vitest";
import {
  mutatingRateLimit,
  pdfFilename,
  projectsReadRateLimit,
  sanitizeFilename,
  sanitizeProjectName
} from "./security";

describe("API security helpers", () => {
  test("sanitizes upload filenames without preserving path components", () => {
    expect(sanitizeFilename("../machine bracket.step")).toBe("machine bracket.step");
    expect(sanitizeFilename("C:\\temp\\bad*name.stl")).toBe("bad_name.stl");
    expect(sanitizeFilename("archive.zip")).toBeUndefined();
  });

  test("builds report PDF filenames from safe ASCII characters", () => {
    expect(pdfFilename("Stress Report: Rev A")).toBe("stress-report-rev-a-report.pdf");
    expect(pdfFilename("../../../")).toBe("opencae-report.pdf");
  });

  test("collapses project-name whitespace without regex replacement", () => {
    expect(sanitizeProjectName("  Beam\tStudy\nA  ")).toBe("Beam Study A");
    expect(sanitizeProjectName("   ")).toBeUndefined();
  });

  test("defines explicit route rate limits for CodeQL-covered reads and mutations", () => {
    expect(projectsReadRateLimit.config.rateLimit).toEqual({ max: 300, timeWindow: "1 minute" });
    expect(mutatingRateLimit.config.rateLimit).toEqual({ max: 60, timeWindow: "1 minute" });
  });
});
