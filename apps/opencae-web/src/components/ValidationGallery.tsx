import { useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, Gauge, Play, Square, X, XCircle } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  VALIDATION_BENCHMARKS,
  metricPercentError,
  type ValidationBenchmarkId,
  type ValidationBenchmarkResult
} from "../validation/benchmarkRegistry";
import { cancelValidationBenchmark, runValidationBenchmarkInWorker } from "../workers/validationWorkerClient";

export function ValidationGallery({ onClose }: { onClose: () => void }) {
  const dialogRef = useFocusTrap<HTMLElement>(true, onClose);
  const [selectedId, setSelectedId] = useState<ValidationBenchmarkId>(VALIDATION_BENCHMARKS[0]?.id ?? "cantilever-static");
  const [runningId, setRunningId] = useState<ValidationBenchmarkId | null>(null);
  const [localResults, setLocalResults] = useState<Partial<Record<ValidationBenchmarkId, ValidationBenchmarkResult>>>({});
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(
    () => VALIDATION_BENCHMARKS.find((benchmark) => benchmark.id === selectedId) ?? VALIDATION_BENCHMARKS[0]!,
    [selectedId]
  );
  const displayedResult = localResults[selected.id] ?? selected.releaseBaseline;
  const showingLocal = Boolean(localResults[selected.id]);

  useEffect(() => () => cancelValidationBenchmark(), []);

  async function runSelected() {
    setError(null);
    setRunningId(selected.id);
    try {
      const result = await runValidationBenchmarkInWorker(selected.id);
      setLocalResults((current) => ({ ...current, [selected.id]: result }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Validation benchmark failed.");
    } finally {
      setRunningId(null);
    }
  }

  function cancelRun() {
    cancelValidationBenchmark();
    setRunningId(null);
    setError("Validation run cancelled.");
  }

  return (
    <div className="workflow-modal-backdrop validation-gallery-backdrop" role="presentation">
      <section ref={dialogRef} className="validation-gallery" role="dialog" aria-modal="true" aria-labelledby="validation-gallery-title">
        <header className="validation-gallery-header">
          <span className="validation-gallery-heading-icon"><Activity size={20} aria-hidden="true" /></span>
          <span>
            <strong id="validation-gallery-title">Validation gallery</strong>
            <small>Release baselines and repeatable checks on this device</small>
          </span>
          <button className="icon-button" type="button" aria-label="Close validation gallery" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="validation-gallery-body">
          <nav className="validation-benchmark-list" aria-label="Validation benchmarks">
            {VALIDATION_BENCHMARKS.map((benchmark) => {
              const local = localResults[benchmark.id];
              const passed = local?.passed ?? benchmark.releaseBaseline.passed;
              return (
                <button
                  key={benchmark.id}
                  type="button"
                  className={benchmark.id === selected.id ? "active" : ""}
                  onClick={() => setSelectedId(benchmark.id)}
                >
                  <span className={`validation-status-dot ${passed ? "pass" : "fail"}`} />
                  <span><strong>{benchmark.title}</strong><small>{benchmark.category === "accuracy" ? "Accuracy" : "Performance"}{local ? " · local result" : " · release baseline"}</small></span>
                </button>
              );
            })}
          </nav>

          <main className="validation-benchmark-detail">
            <div className="validation-detail-title">
              <span>
                <small>{selected.category === "accuracy" ? "Numerical accuracy" : "Browser performance"}</small>
                <h2>{selected.title}</h2>
              </span>
              <span className={`validation-pass-badge ${displayedResult.passed ? "pass" : "fail"}`}>
                {displayedResult.passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                {displayedResult.passed ? "Passed" : "Failed"}
              </span>
            </div>
            <p>{selected.summary}</p>
            <div className="validation-oracle"><strong>Reference</strong><span>{selected.oracle}</span></div>

            <div className="validation-metric-grid">
              {displayedResult.metrics.map((metric) => {
                const errorPercent = metricPercentError(metric);
                return (
                  <article key={metric.id}>
                    <small>{metric.label}</small>
                    <strong>{formatMetric(metric.value)}{metric.units ? ` ${metric.units}` : ""}</strong>
                    {metric.reference !== undefined ? (
                      <span>Reference {formatMetric(metric.reference)}{metric.units ? ` ${metric.units}` : ""}{errorPercent !== null ? ` · ${errorPercent.toFixed(2)}% error` : ""}</span>
                    ) : <span>Measured value</span>}
                  </article>
                );
              })}
            </div>

            <div className="validation-run-meta">
              <Gauge size={16} aria-hidden="true" />
              <span><strong>{showingLocal ? "This device" : "Release baseline"}</strong><small>{displayedResult.durationMs.toLocaleString()} ms · {new Date(displayedResult.measuredAt).toLocaleDateString()}</small></span>
            </div>
            <ul className="validation-detail-list">
              {displayedResult.details.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
            {error ? <p className="panel-warning" role="alert">{error}</p> : null}
          </main>
        </div>

        <footer className="validation-gallery-footer">
          <p>These cases validate specific behavior and do not certify arbitrary models.</p>
          {runningId ? (
            <button className="secondary" type="button" onClick={cancelRun}><Square size={15} />Cancel run</button>
          ) : (
            <button className="primary" type="button" onClick={() => void runSelected()}><Play size={15} />Run on this device</button>
          )}
        </footer>
      </section>
    </div>
  );
}

function formatMetric(value: number): string {
  if (Math.abs(value) >= 10_000) return Math.round(value).toLocaleString();
  if (Math.abs(value) >= 100) return value.toFixed(1);
  if (Math.abs(value) >= 1) return value.toFixed(3);
  return value.toPrecision(4);
}
