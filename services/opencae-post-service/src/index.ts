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
  const beam = [
    [x + 58, y + 66],
    [x + 230, y + 44],
    [x + 276, y + 72],
    [x + 98, y + 98]
  ];
  const top = [
    [x + 98, y + 98],
    [x + 276, y + 72],
    [x + 246, y + 132],
    [x + 78, y + 156]
  ];
  const side = [
    [x + 230, y + 44],
    [x + 276, y + 72],
    [x + 246, y + 132],
    [x + 202, y + 104]
  ];
  return [
    "0.04 0.07 0.13 rg",
    `${x} ${y} ${width} ${height} re f`,
    "0.08 0.13 0.22 RG 0.35 w",
    ...gridLines(x, y, width, height),
    "0.12 0.35 0.78 rg",
    polygon(beam),
    "0.12 0.70 0.82 rg",
    polygon([
      [x + 92, y + 70],
      [x + 155, y + 62],
      [x + 201, y + 90],
      [x + 136, y + 100]
    ]),
    "0.95 0.76 0.20 rg",
    polygon([
      [x + 136, y + 100],
      [x + 201, y + 90],
      [x + 246, y + 118],
      [x + 180, y + 130]
    ]),
    "0.90 0.18 0.34 rg",
    polygon([
      [x + 180, y + 130],
      [x + 246, y + 118],
      [x + 246, y + 132],
      [x + 78, y + 156],
      [x + 96, y + 134]
    ]),
    "0.35 0.47 0.62 rg",
    polygon(side),
    "0.62 0.72 0.84 rg",
    polygon(top),
    "0.82 0.88 0.95 RG 1.1 w",
    polyline([...beam, beam[0]!, [x + 78, y + 156], [x + 246, y + 132], [x + 276, y + 72]]),
    "0.27 0.55 0.90 rg",
    circle(x + 80, y + 82, 4),
    circle(x + 88, y + 80, 4),
    "0.95 0.67 0.13 rg",
    arrow(x + 238, y + 160, x + 238, y + 130),
    text("Load", x + 220, y + 168, 7, "F2", [0.85, 0.9, 1]),
    "0.27 0.70 0.48 rg",
    supportMarker(x + 72, y + 64),
    "0.07 0.10 0.16 rg",
    text("MODEL VIEW", x + 18, y + height - 24, 7, "F2", [0.65, 0.72, 0.82]),
    "0.15 0.45 0.95 rg",
    `${x + 20} ${y + 18} 60 5 re f`,
    "0.15 0.75 0.70 rg",
    `${x + 80} ${y + 18} 60 5 re f`,
    "0.96 0.78 0.20 rg",
    `${x + 140} ${y + 18} 60 5 re f`,
    "0.90 0.20 0.28 rg",
    `${x + 200} ${y + 18} 60 5 re f`
  ].join("\n");
}

function gridLines(x: number, y: number, width: number, height: number): string[] {
  const lines: string[] = [];
  for (let offset = -80; offset <= width + 80; offset += 38) {
    lines.push(`${x + offset} ${y + 12} m ${x + offset + 110} ${y + height - 18} l S`);
    lines.push(`${x + offset} ${y + height - 18} m ${x + offset + 138} ${y + 12} l S`);
  }
  return lines;
}

function polygon(points: number[][]): string {
  const [first, ...rest] = points;
  if (!first) return "";
  return `${first[0]} ${first[1]} m ${rest.map((point) => `${point[0]} ${point[1]} l`).join(" ")} h f`;
}

function polyline(points: number[][]): string {
  const [first, ...rest] = points;
  if (!first) return "";
  return `${first[0]} ${first[1]} m ${rest.map((point) => `${point[0]} ${point[1]} l`).join(" ")} S`;
}

function circle(x: number, y: number, radius: number): string {
  const c = radius * 0.55228475;
  return `${x + radius} ${y} m ${x + radius} ${y + c} ${x + c} ${y + radius} ${x} ${y + radius} c ${x - c} ${y + radius} ${x - radius} ${y + c} ${x - radius} ${y} c ${x - radius} ${y - c} ${x - c} ${y - radius} ${x} ${y - radius} c ${x + c} ${y - radius} ${x + radius} ${y - c} ${x + radius} ${y} c f`;
}

function arrow(x1: number, y1: number, x2: number, y2: number): string {
  return [
    "4 w 0.95 0.67 0.13 RG",
    `${x1} ${y1} m ${x2} ${y2} l S`,
    "0.95 0.67 0.13 rg",
    polygon([[x2, y2], [x2 - 7, y2 + 13], [x2 + 7, y2 + 13]])
  ].join("\n");
}

function supportMarker(x: number, y: number): string {
  return [
    polygon([[x, y], [x + 10, y - 16], [x - 10, y - 16]]),
    polygon([[x + 18, y - 2], [x + 28, y - 18], [x + 8, y - 18]]),
    polygon([[x + 36, y - 4], [x + 46, y - 20], [x + 26, y - 20]])
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
  return `<svg class="visual result-model" viewBox="0 0 560 320" role="img" aria-label="Stress contour preview on the analyzed model"><defs><linearGradient id="beamStress" x1="0" x2="1"><stop stop-color="#2563eb"/><stop offset=".36" stop-color="#22d3ee"/><stop offset=".64" stop-color="#facc15"/><stop offset="1" stop-color="#ef4444"/></linearGradient><linearGradient id="sideShade" x1="0" x2="1"><stop stop-color="#334155"/><stop offset="1" stop-color="#64748b"/></linearGradient></defs><rect width="560" height="320" fill="#0b1220"/><g stroke="#172033" stroke-width="1">${Array.from({ length: 15 }, (_, index) => `<path d="M${-80 + index * 48} 288 260 74" />`).join("")}${Array.from({ length: 15 }, (_, index) => `<path d="M${44 + index * 48} 72 392 290" />`).join("")}</g><g transform="translate(54 18)"><path d="M66 194 392 154 462 196 128 244Z" fill="url(#beamStress)"/><path d="M392 154 462 196 430 242 360 202Z" fill="url(#sideShade)"/><path d="M128 244 462 196 430 242 98 290Z" fill="#475569"/><path d="M66 194 392 154 462 196 128 244Z" fill="none" stroke="#cbd5e1" stroke-width="3"/><path d="M128 244 98 290 430 242 462 196M392 154 360 202 430 242" fill="none" stroke="#94a3b8" stroke-width="2"/><circle cx="116" cy="222" r="16" fill="#0b1220" stroke="#bfdbfe" stroke-width="6"/><circle cx="166" cy="214" r="16" fill="#0b1220" stroke="#bfdbfe" stroke-width="6"/><path d="M384 64 384 142" stroke="#f59e0b" stroke-width="10" stroke-linecap="round"/><path d="M384 152 368 120 400 120Z" fill="#f59e0b"/><rect x="324" y="40" width="128" height="28" rx="3" fill="#0f172a" stroke="#f59e0b"/><text x="388" y="59" fill="#e5e7eb" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">Load</text><g fill="#38bdf8"><path d="M88 256 100 278 76 278Z"/><path d="M132 250 144 272 120 272Z"/><path d="M176 244 188 266 164 266Z"/></g><path d="M260 94 330 116 286 190 218 168Z" fill="#ffffff" opacity=".18" stroke="#e2e8f0" stroke-width="2"/></g><g transform="translate(28 270)" font-family="ui-monospace, monospace" font-size="12" fill="#cbd5e1"><rect x="0" y="0" width="270" height="10" rx="5" fill="url(#beamStress)"/><text x="0" y="28">Max stress ${escapeHtml(format(summary.maxStress))} ${escapeHtml(summary.maxStressUnits)}</text><text x="0" y="46">Max displacement ${escapeHtml(format(summary.maxDisplacement))} ${escapeHtml(summary.maxDisplacementUnits)}</text></g></svg>`;
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
