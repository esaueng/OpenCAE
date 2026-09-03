import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("viewer exploded");
}

describe("AppErrorBoundary", () => {
  test("renders its children when nothing throws", () => {
    const html = renderToStaticMarkup(
      <AppErrorBoundary><p>workspace</p></AppErrorBoundary>
    );

    expect(html).toContain("workspace");
    expect(html).not.toContain("app-crash");
  });

  test("catches a throw and offers a way out instead of a blank document", () => {
    // renderToStaticMarkup does not run error boundaries, so drive the boundary's own
    // contract directly: the state it derives from an error, and what that state renders.
    const error = new Error("viewer exploded");
    // React renders the fallback BETWEEN deriving state and calling componentDidCatch, so
    // whether the user's work survived has to be captured here or the card renders a
    // render too late and tells them it is gone when it is not.
    const derived = AppErrorBoundary.getDerivedStateFromError(error);
    expect(derived.error).toBe(error);
    expect(derived).toHaveProperty("autosavePresent");

    const boundary = new AppErrorBoundary({ children: null });
    boundary.state = { error, autosavePresent: true };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    boundary.componentDidCatch(error, { componentStack: "\n    at Viewer" });
    consoleError.mockRestore();

    const html = renderToStaticMarkup(boundary.render() as JSX.Element);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Something in the app crashed.");
    expect(html).toContain("Reload OpenCAE");
    // The message is surfaced, not swallowed.
    expect(html).toContain("viewer exploded");
    // And it says where the user's work stands rather than leaving them guessing.
    expect(html).toContain("still autosaved in this browser");

    boundary.state = { error, autosavePresent: false };
    expect(renderToStaticMarkup(boundary.render() as JSX.Element)).toContain("start from the home screen");
  });
});
