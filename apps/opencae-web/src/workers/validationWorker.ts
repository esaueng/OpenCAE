import type { ValidationBenchmarkId } from "../validation/benchmarkRegistry";

self.onmessage = async (event: MessageEvent<{ id: ValidationBenchmarkId }>) => {
  try {
    const { configureValidationGmshWasm } = await import("../validation/validationWasmRuntime");
    configureValidationGmshWasm();
    const { runValidationBenchmark } = await import("../validation/runValidationBenchmark");
    const result = await runValidationBenchmark(event.data.id);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : "Validation benchmark failed." });
  }
};
