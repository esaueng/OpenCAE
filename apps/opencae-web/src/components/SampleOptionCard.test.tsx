import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { SAMPLE_OPTIONS } from "./sampleOptions";
import { SampleOptionCard } from "./SampleOptionCard";

describe("SampleOptionCard", () => {
  test("renders every sample option with accessible card labels", () => {
    const html = renderToStaticMarkup(
      <div>
        {SAMPLE_OPTIONS.map((option) => (
          <SampleOptionCard key={option.id} option={option} selected={option.id === "bracket"} onSelect={vi.fn()} onOpen={vi.fn()} />
        ))}
      </div>
    );

    expect(html).toContain("Bracket Demo");
    expect(html).toContain("Beam Demo");
    expect(html).toContain("Cantilever Demo");
    expect(html).toContain('aria-label="Select Bracket Demo sample"');
    expect(html).toContain('aria-label="Select Beam Demo sample"');
    expect(html).toContain('aria-label="Select Cantilever Demo sample"');
    expect(html).toContain("sample-thumbnail");
  });

  test("wires single click, double click, and keyboard selection handlers", () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const element = SampleOptionCard({
      option: SAMPLE_OPTIONS[1]!,
      selected: false,
      onSelect,
      onOpen
    });

    element.props.onClick();
    element.props.onDoubleClick();
    element.props.onKeyDown({ key: " ", preventDefault: vi.fn() });
    element.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });

    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenCalledWith("plate");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("plate");
  });
});
