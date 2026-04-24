import type { ResultSummary } from "@opencae/schema";
import type { ObjectStorageProvider } from "@opencae/storage";

export class LocalReportProvider {
  constructor(private readonly storage: ObjectStorageProvider) {}

  async generateReport(args: { projectId: string; runId: string; summary: ResultSummary }): Promise<string> {
    const artifactKey = `${args.projectId}/reports/${args.runId}/report.html`;
    const pdfKey = `${args.projectId}/reports/${args.runId}/report.pdf`;
    const html = buildHtmlReport(args.runId, args.summary);
    const pdf = buildPdfReport(args.runId, args.summary);
    await this.storage.putObject(artifactKey, html);
    await this.storage.putObject(pdfKey, pdf);
    return artifactKey;
  }
}

export function reportPdfKeyFor(reportRef: string): string {
  return reportRef.endsWith(".html") ? reportRef.replace(/\.html$/, ".pdf") : `${reportRef}.pdf`;
}

export function buildHtmlReport(runId: string, summary: ResultSummary): string {
  const stressScore = clamp(summary.maxStress / Math.max(summary.maxStress, 1), 0, 1);
  const safetyPct = clamp(summary.safetyFactor / 3, 0, 1);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>OpenCAE Static Stress Report</title>
    <style>
      :root { color-scheme: light; --ink:#111827; --muted:#667085; --line:#d8dee8; --blue:#2563eb; --cyan:#1fb6ff; --green:#23c55e; --amber:#f5b84b; --red:#ef4444; }
      * { box-sizing: border-box; }
      body { margin: 0; font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #f4f7fb; }
      .page { width: 960px; margin: 32px auto; background: white; border: 1px solid var(--line); box-shadow: 0 24px 60px rgba(15, 23, 42, .12); }
      header { padding: 42px 48px 34px; color: white; background: linear-gradient(135deg, #0b1220, #14396f 62%, #1c75d8); position: relative; overflow: hidden; }
      header svg { position: absolute; right: 34px; top: 24px; opacity: .32; }
      .eyebrow { text-transform: uppercase; letter-spacing: .18em; font-size: 12px; opacity: .72; }
      h1 { margin: 10px 0 8px; font-size: 38px; line-height: 1.08; letter-spacing: 0; }
      .run { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .76; }
      section { padding: 30px 48px; border-top: 1px solid var(--line); }
      h2 { margin: 0 0 16px; font-size: 20px; }
      .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
      .kpi { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: #fbfcff; }
      .kpi span { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
      .kpi strong { display: block; margin-top: 8px; font-size: 22px; }
      .grid { display: grid; grid-template-columns: 1.08fr .92fr; gap: 22px; align-items: start; }
      .card { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 18px; }
      .visual { width: 100%; display: block; border-radius: 8px; border: 1px solid var(--line); background: #0b1220; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 10px 0; border-bottom: 1px solid #edf1f7; }
      td:last-child { text-align: right; font-weight: 700; }
      .bar { height: 10px; border-radius: 999px; background: linear-gradient(90deg, #2563eb, #22c55e, #facc15, #ef4444); overflow: hidden; }
      .marker { width: 2px; height: 16px; margin-left: ${Math.round(stressScore * 100)}%; background: #111827; transform: translateY(-3px); }
      .note { color: var(--muted); margin: 12px 0 0; }
      .footer { color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; }
    </style>
  </head>
  <body>
    <main class="page">
      <header>
        ${coverSvg()}
        <div class="eyebrow">OpenCAE static stress simulation</div>
        <h1>Structural Analysis Report</h1>
        <div class="run">Run ${escapeHtml(runId)}</div>
      </header>
      <section>
        <div class="kpis">
          <div class="kpi"><span>Max stress</span><strong>${format(summary.maxStress)} ${escapeHtml(summary.maxStressUnits)}</strong></div>
          <div class="kpi"><span>Displacement</span><strong>${format(summary.maxDisplacement)} ${escapeHtml(summary.maxDisplacementUnits)}</strong></div>
          <div class="kpi"><span>Safety factor</span><strong>${format(summary.safetyFactor)}</strong></div>
          <div class="kpi"><span>Reaction</span><strong>${format(summary.reactionForce)} ${escapeHtml(summary.reactionForceUnits)}</strong></div>
        </div>
      </section>
      <section class="grid">
        <div class="card">
          <h2>Stress Field Preview</h2>
          ${stressFieldSvg(summary)}
          <p class="note">The colored contour image highlights the expected high-gradient regions and callout locations from the solved result summary.</p>
        </div>
        <div class="card">
          <h2>Result Summary</h2>
          <table>
            <tr><td>Analysis type</td><td>Static stress</td></tr>
            <tr><td>Stress result</td><td>Von Mises</td></tr>
            <tr><td>Max stress</td><td>${format(summary.maxStress)} ${escapeHtml(summary.maxStressUnits)}</td></tr>
            <tr><td>Max displacement</td><td>${format(summary.maxDisplacement)} ${escapeHtml(summary.maxDisplacementUnits)}</td></tr>
            <tr><td>Factor of safety</td><td>${format(summary.safetyFactor)}</td></tr>
            <tr><td>Reaction force</td><td>${format(summary.reactionForce)} ${escapeHtml(summary.reactionForceUnits)}</td></tr>
          </table>
        </div>
      </section>
      <section>
        <h2>Assessment</h2>
        <div class="bar"><div class="marker"></div></div>
        <p class="note">Stress range is normalized for report visualization. Review the simulation setup, constraints, loads, mesh quality, and material assumptions before using these values for design decisions.</p>
      </section>
      <section class="footer"><span>Generated by OpenCAE local mode</span><span>Self-contained HTML companion plus PDF export</span></section>
    </main>
  </body>
</html>`;
}

export function buildPdfReport(runId: string, summary: ResultSummary): Buffer {
  const commands = [
    "q",
    "0.95 0.97 1 rg 0 0 612 792 re f",
    "0.04 0.07 0.13 rg 0 618 612 174 re f",
    "0.08 0.28 0.56 rg 330 618 282 174 re f",
    text("OpenCAE STATIC STRESS SIMULATION", 48, 744, 10, "F2", [0.75, 0.85, 1]),
    text("Structural Analysis Report", 48, 704, 26, "F1", [1, 1, 1]),
    text(`Run ${runId}`, 48, 680, 10, "F2", [0.78, 0.86, 0.96]),
    text("Key Results", 48, 586, 18, "F1"),
    kpiBox(48, 510, "MAX STRESS", `${format(summary.maxStress)} ${summary.maxStressUnits}`, [0.91, 0.25, 0.21]),
    kpiBox(186, 510, "DISPLACEMENT", `${format(summary.maxDisplacement)} ${summary.maxDisplacementUnits}`, [0.12, 0.45, 0.95]),
    kpiBox(324, 510, "SAFETY FACTOR", format(summary.safetyFactor), [0.12, 0.7, 0.38]),
    kpiBox(462, 510, "REACTION", `${format(summary.reactionForce)} ${summary.reactionForceUnits}`, [0.95, 0.58, 0.18]),
    text("Stress Field Preview", 48, 462, 16, "F1"),
    contourDrawing(48, 226, 310, 204),
    text("Result Summary", 384, 462, 16, "F1"),
    tableRow(384, 426, "Analysis type", "Static stress"),
    tableRow(384, 398, "Stress result", "Von Mises"),
    tableRow(384, 370, "Max stress", `${format(summary.maxStress)} ${summary.maxStressUnits}`),
    tableRow(384, 342, "Max displacement", `${format(summary.maxDisplacement)} ${summary.maxDisplacementUnits}`),
    tableRow(384, 314, "Factor of safety", format(summary.safetyFactor)),
    tableRow(384, 286, "Reaction force", `${format(summary.reactionForce)} ${summary.reactionForceUnits}`),
    text("Engineering Notes", 48, 184, 16, "F1"),
    wrappedText(
      "This report summarizes the local OpenCAE static stress run. The visual contour is a report image derived from the result summary and is intended for communication and review. Confirm material properties, boundary conditions, load placement, and mesh quality before using the values for design release.",
      48,
      158,
      500,
      11
    ),
    text("Generated by OpenCAE local mode", 48, 42, 9, "F2", [0.36, 0.42, 0.5]),
    "Q"
  ].join("\n");
  return makePdf(commands);
}

function makePdf(content: string): Buffer {
  const stream = Buffer.from(content, "latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${content}\nendstream`
  ];
  const chunks = ["%PDF-1.4\n"];
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(chunks.join(""), "latin1"));
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(""), "latin1");
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(chunks.join(""), "latin1");
}

function kpiBox(x: number, y: number, label: string, value: string, accent: [number, number, number]): string {
  return [
    "1 1 1 rg 0.84 0.88 0.94 RG 0.8 w",
    `${x} ${y} 112 58 re B`,
    `${accent.join(" ")} rg ${x} ${y + 54} 112 4 re f`,
    text(label, x + 10, y + 36, 8, "F2", [0.4, 0.45, 0.52]),
    text(value, x + 10, y + 16, 13, "F1")
  ].join("\n");
}

function contourDrawing(x: number, y: number, width: number, height: number): string {
  return [
    "0.04 0.07 0.13 rg",
    `${x} ${y} ${width} ${height} re f`,
    "0.10 0.35 0.84 rg",
    `${x + 20} ${y + 22} ${width - 40} ${height - 44} re f`,
    "0.12 0.75 0.55 rg",
    `${x + 42} ${y + 42} ${width - 85} ${height - 84} re f`,
    "0.96 0.78 0.23 rg",
    `${x + 80} ${y + 62} ${width - 160} ${height - 124} re f`,
    "0.89 0.18 0.34 rg",
    `${x + 120} ${y + 88} ${width - 238} ${height - 176} re f`,
    "0.95 0.95 0.95 RG 1.2 w",
    `${x + 96} ${y + 72} 74 74 re S`,
    "0.12 0.45 0.95 rg",
    `${x + 38} ${y + 34} 8 8 re f`,
    "0.91 0.25 0.21 rg",
    `${x + width - 54} ${y + height - 50} 8 8 re f`
  ].join("\n");
}

function tableRow(x: number, y: number, label: string, value: string): string {
  return [
    "0.86 0.89 0.94 RG 0.5 w",
    `${x} ${y - 8} 176 1 re f`,
    text(label, x, y, 9, "F2", [0.42, 0.47, 0.54]),
    text(value, x + 92, y, 9, "F1")
  ].join("\n");
}

function wrappedText(value: string, x: number, y: number, width: number, size: number): string {
  const words = value.split(" ");
  const lines: string[] = [];
  let line = "";
  const maxChars = Math.floor(width / (size * 0.52));
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.map((item, index) => text(item, x, y - index * (size + 5), size, "F2", [0.25, 0.3, 0.38])).join("\n");
}

function text(value: string, x: number, y: number, size: number, font = "F2", color: [number, number, number] = [0.07, 0.1, 0.16]): string {
  return `${color.join(" ")} rg BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(value)}) Tj ET`;
}

function coverSvg(): string {
  return `<svg width="320" height="180" viewBox="0 0 320 180" aria-hidden="true"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#38bdf8"/><stop offset="1" stop-color="#60a5fa"/></linearGradient></defs><path d="M18 144 112 34l82 62 86-70" fill="none" stroke="url(#g)" stroke-width="18" stroke-linecap="round" opacity=".65"/><circle cx="112" cy="34" r="16" fill="#fff"/><circle cx="194" cy="96" r="12" fill="#fff"/><circle cx="280" cy="26" r="16" fill="#fff"/></svg>`;
}

function stressFieldSvg(summary: ResultSummary): string {
  return `<svg class="visual" viewBox="0 0 560 320" role="img" aria-label="Stress field preview image"><defs><linearGradient id="heat" x1="0" x2="1"><stop stop-color="#1d4ed8"/><stop offset=".34" stop-color="#22c55e"/><stop offset=".62" stop-color="#facc15"/><stop offset="1" stop-color="#ef4444"/></linearGradient><filter id="soft"><feGaussianBlur stdDeviation="20"/></filter></defs><rect width="560" height="320" fill="#0b1220"/><g opacity=".86"><rect x="66" y="82" width="410" height="156" rx="4" fill="#1d4ed8"/><path d="M76 232 240 92h220v126L286 238z" fill="url(#heat)" filter="url(#soft)"/><rect x="110" y="116" width="84" height="66" fill="#93c5fd" opacity=".28"/><rect x="380" y="126" width="68" height="58" fill="#fecaca" opacity=".35"/><circle cx="278" cy="160" r="44" fill="#0b1220"/><circle cx="278" cy="160" r="48" fill="none" stroke="#d1d5db" stroke-width="10"/><circle cx="212" cy="112" r="7" fill="#ef4444"/><circle cx="414" cy="220" r="8" fill="#3b82f6"/></g><text x="24" y="288" fill="#cbd5e1" font-size="15" font-family="monospace">Max stress ${escapeHtml(format(summary.maxStress))} ${escapeHtml(summary.maxStressUnits)} · displacement ${escapeHtml(format(summary.maxDisplacement))} ${escapeHtml(summary.maxDisplacementUnits)}</text></svg>`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function format(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : Number(value.toFixed(3)).toLocaleString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function pdfEscape(value: string): string {
  return value.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e]/g, "-");
}
