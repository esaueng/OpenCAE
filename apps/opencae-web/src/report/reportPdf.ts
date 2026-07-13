import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import regularFontUrl from "./fonts/IBMPlexSans-Regular.ttf?url";
import semiBoldFontUrl from "./fonts/IBMPlexSans-SemiBold.ttf?url";
import type { ReportData, ReportFigure, ReportRow, ReportTable } from "./reportData";
import { REPORT_LAYOUT, REPORT_THEME, REPORT_TYPE } from "./reportTheme";

const FONT_FAMILY = "IBMPlexSans";
const BUILTIN_FONT = "helvetica";
const FOOTER_GAP = 7;

let fontAssetsPromise: Promise<{ regular: string; semiBold: string } | null> | null = null;
let logoAssetPromise: Promise<string | null> | null = null;

export async function renderReportPdf(data: ReportData): Promise<Blob> {
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: data.pageFormat,
    compress: true,
    putOnlyUsedFonts: true
  });
  const fontFamily = await registerReportFonts(doc);
  const logo = await loadLogo();
  const report = new PdfReport(doc, data, fontFamily);

  report.cover(logo);
  report.modelDefinition();
  report.results();
  report.drawFooters();

  return new Blob([doc.output("arraybuffer")], { type: "application/pdf" });
}

class PdfReport {
  private y: number = REPORT_LAYOUT.margin;
  private readonly pageWidth: number;
  private readonly pageHeight: number;
  private readonly contentWidth: number;

  constructor(
    private readonly doc: jsPDF,
    private readonly data: ReportData,
    private readonly fontFamily: string
  ) {
    this.pageWidth = doc.internal.pageSize.getWidth();
    this.pageHeight = doc.internal.pageSize.getHeight();
    this.contentWidth = this.pageWidth - REPORT_LAYOUT.margin * 2;
  }

  cover(logo: string | null): void {
    this.drawBrandHeader(logo);
    this.y = 43;
    this.text(this.data.title, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.title, REPORT_THEME.ink, "bold");
    this.y += 8;
    this.text(this.data.projectName, REPORT_LAYOUT.margin, this.y, 13, REPORT_THEME.ink, "bold");
    this.y += 5.5;
    this.text(`${this.data.studyName} · ${this.data.unitSystemLabel}`, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.body, REPORT_THEME.inkMuted);
    this.y += 8;

    this.coverMetaStrip();
    if (this.data.provenanceTier !== "production_fea") {
      this.callout(this.data.provenanceLabel, "warning", 10);
      this.y += 4;
    }
    this.table({ headers: ["Key result", "Value"], rows: this.data.keyResults.map((row) => [row.label, row.value]) }, { compact: true, keyResults: true, headerless: true });
    this.verdictLine();

    this.text("Primary result", REPORT_LAYOUT.margin, this.y, 10, REPORT_THEME.accent, "bold");
    this.y += 4;
    const remainingHeight = Math.max(42, this.pageHeight - REPORT_LAYOUT.footerHeight - FOOTER_GAP - this.y - 8);
    this.figure(this.data.figures.stress, remainingHeight);
  }

  modelDefinition(): void {
    this.addPage();
    this.sectionHeading(1, "Geometry");
    this.keyValueRows(this.data.geometry);
    this.subheading("Geometry files");
    this.table(this.data.geometryFiles);

    this.sectionHeading(2, "Material");
    this.table(this.data.materials);
    this.subheading("Manufacturing");
    this.table(this.data.manufacturing);

    this.sectionHeading(3, "Boundary conditions");
    this.subheading("Supports");
    this.table(this.data.supports);
    this.subheading("Loads");
    this.table(this.data.loads);

    this.sectionHeading(4, "Mesh");
    this.keyValueRows(this.data.mesh);

    this.sectionHeading(5, "Solver");
    this.keyValueRows(this.data.solver);
  }

  results(): void {
    // Keep the heading with its first figure: a figure claims up to 96mm, so a
    // heading that fits alone in less strands itself above a page break.
    this.sectionHeading(6, "Result figures", 108);
    this.figure(this.data.figures.stress, 82);
    this.ensureSpace(36);
    this.figure(this.data.figures.displacement, 82);

    this.sectionHeading(7, "Results table");
    this.keyValueRows(this.data.results);
    if (this.data.loadCapacity.length) {
      this.subheading("Load capacity (reverse check)");
      this.keyValueRows(this.data.loadCapacity);
      const note = "Estimated by linearly scaling the current result against the material yield limit; verify with a run at the target load.";
      const noteLines = this.splitText(note, this.contentWidth, REPORT_TYPE.caption);
      this.ensureSpace(noteLines.length * 3.5 + 4);
      this.text(noteLines, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.caption, REPORT_THEME.inkMuted);
      this.y += noteLines.length * 3.5 + 5;
    }
    if (this.data.transientResults.length) {
      this.subheading("Transient results");
      this.keyValueRows(this.data.transientResults);
    }

    this.sectionHeading(8, "Diagnostics & limitations");
    const diagnostics = [...this.data.diagnostics];
    if (this.data.includeSmoothingDisclaimer) {
      diagnostics.push("Displayed contours are smoothed for visualization; the summary max stress is the unaveraged element peak.");
    }
    if (!diagnostics.length) diagnostics.push("No active diagnostics were reported for this result.");
    for (const diagnostic of diagnostics) this.bullet(diagnostic);
  }

  drawFooters(): void {
    const pageCount = this.doc.getNumberOfPages();
    for (let page = 1; page <= pageCount; page += 1) {
      this.doc.setPage(page);
      const ruleY = this.pageHeight - REPORT_LAYOUT.footerHeight;
      this.doc.setDrawColor(REPORT_THEME.hairline);
      this.doc.setLineWidth(0.15);
      this.doc.line(REPORT_LAYOUT.margin, ruleY, this.pageWidth - REPORT_LAYOUT.margin, ruleY);
      this.text("Generated by OpenCAE - cae.esau.app", REPORT_LAYOUT.margin, ruleY + 4, REPORT_TYPE.caption, REPORT_THEME.inkMuted);
      this.text(`Page ${page} of ${pageCount}`, this.pageWidth - REPORT_LAYOUT.margin, ruleY + 4, REPORT_TYPE.caption, REPORT_THEME.inkMuted, "normal", "right");
      this.text(this.data.footerDisclaimer, this.pageWidth / 2, ruleY + 7.5, 6.5, REPORT_THEME.inkMuted, "normal", "center");
    }
  }

  private drawBrandHeader(logo: string | null): void {
    if (logo) {
      this.doc.addImage(logo, "PNG", REPORT_LAYOUT.margin, REPORT_LAYOUT.margin - 2, 10, 10, undefined, "FAST");
    } else {
      this.doc.setFillColor(REPORT_THEME.accent);
      this.doc.roundedRect(REPORT_LAYOUT.margin, REPORT_LAYOUT.margin - 2, 10, 10, 1.5, 1.5, "F");
      this.text("O", REPORT_LAYOUT.margin + 5, REPORT_LAYOUT.margin + 5.2, 12, "#ffffff", "bold", "center");
    }
    this.text("OpenCAE", REPORT_LAYOUT.margin + 14, REPORT_LAYOUT.margin + 5.2, 15, REPORT_THEME.ink, "bold");
    this.text(this.data.reportDate, this.pageWidth - REPORT_LAYOUT.margin, REPORT_LAYOUT.margin + 4.2, REPORT_TYPE.body, REPORT_THEME.inkMuted, "normal", "right");
    this.doc.setDrawColor(REPORT_THEME.ink);
    this.doc.setLineWidth(0.5);
    this.doc.line(REPORT_LAYOUT.margin, REPORT_LAYOUT.margin + 11, this.pageWidth - REPORT_LAYOUT.margin, REPORT_LAYOUT.margin + 11);
  }

  private coverMetaStrip(): void {
    const rows = this.data.coverMeta;
    if (!rows.length) return;
    const cellWidth = this.contentWidth / rows.length;
    const topY = this.y;
    this.doc.setDrawColor(REPORT_THEME.hairline);
    this.doc.setLineWidth(0.2);
    this.doc.line(REPORT_LAYOUT.margin, topY, this.pageWidth - REPORT_LAYOUT.margin, topY);
    rows.forEach((row, index) => {
      const x = REPORT_LAYOUT.margin + index * cellWidth;
      this.text(row.label.toUpperCase(), x, topY + 4, 6.2, REPORT_THEME.inkMuted);
      const value = this.splitText(row.value, cellWidth - 4, 8, "bold")[0] ?? row.value;
      this.text(value, x, topY + 8, 8, REPORT_THEME.ink, "bold");
    });
    this.doc.line(REPORT_LAYOUT.margin, topY + 10.5, this.pageWidth - REPORT_LAYOUT.margin, topY + 10.5);
    this.y = topY + 15;
  }

  private verdictLine(): void {
    const assessment = this.data.failureAssessment;
    const color = assessment.status === "pass" ? REPORT_THEME.success : assessment.status === "fail" ? REPORT_THEME.error : REPORT_THEME.warning;
    const textX = REPORT_LAYOUT.margin + 4.5;
    this.doc.setFillColor(color);
    this.doc.circle(REPORT_LAYOUT.margin + 1.2, this.y - 1.2, 1.1, "F");
    this.text(assessment.title, textX, this.y, REPORT_TYPE.body, REPORT_THEME.ink, "bold");
    const titleWidth = this.doc.getTextWidth(assessment.title);
    const messageLines = this.splitText(`— ${assessment.message}`, this.contentWidth - 4.5 - titleWidth - 2, REPORT_TYPE.body);
    this.text(messageLines[0] ?? "", textX + titleWidth + 2, this.y, REPORT_TYPE.body, REPORT_THEME.ink);
    if (messageLines.length > 1) {
      this.y += 4.2;
      const wrapped = this.splitText(messageLines.slice(1).join(" "), this.contentWidth - 4.5, REPORT_TYPE.body);
      this.text(wrapped, textX, this.y, REPORT_TYPE.body, REPORT_THEME.ink);
      this.y += (wrapped.length - 1) * 4.2;
    }
    this.y += 8;
  }

  private sectionHeading(number: number, title: string, keepTogether: number = REPORT_LAYOUT.sectionKeepTogether): void {
    this.ensureSpace(keepTogether);
    this.y += 2;
    this.text(`${number}  ${title}`, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.section, REPORT_THEME.accent, "bold");
    this.y += 3;
    this.doc.setDrawColor(REPORT_THEME.accent);
    this.doc.setLineWidth(0.5);
    this.doc.line(REPORT_LAYOUT.margin, this.y, this.pageWidth - REPORT_LAYOUT.margin, this.y);
    this.y += 6;
  }

  private subheading(title: string): void {
    this.ensureSpace(18);
    this.text(title, REPORT_LAYOUT.margin, this.y, 10, REPORT_THEME.ink, "bold");
    this.y += 4;
  }

  private keyValueRows(rows: ReportRow[]): void {
    this.table({ headers: ["Item", "Value"], rows: rows.map((row) => [row.label, row.value]) });
  }

  private table(table: ReportTable, options: { compact?: boolean; keyResults?: boolean; headerless?: boolean } = {}): void {
    this.ensureSpace(22);
    const rows = table.rows.length ? table.rows : [[table.emptyMessage ?? "Not available (--)", ...table.headers.slice(1).map(() => "--")]];
    autoTable(this.doc, {
      startY: this.y,
      margin: { left: REPORT_LAYOUT.margin, right: REPORT_LAYOUT.margin, bottom: REPORT_LAYOUT.footerHeight + FOOTER_GAP },
      tableWidth: this.contentWidth,
      theme: "plain",
      head: [table.headers],
      body: rows,
      showHead: options.headerless ? false : "everyPage",
      pageBreak: "auto",
      rowPageBreak: "avoid",
      styles: {
        font: this.fontFamily,
        fontStyle: "normal",
        fontSize: options.compact ? 8.6 : REPORT_TYPE.body,
        textColor: REPORT_THEME.ink,
        cellPadding: options.compact ? 1.5 : 2.1,
        lineColor: REPORT_THEME.hairline,
        lineWidth: { bottom: 0.15 },
        valign: "middle",
        overflow: "linebreak"
      },
      headStyles: {
        font: this.fontFamily,
        fontStyle: "bold",
        textColor: REPORT_THEME.accent,
        fillColor: REPORT_THEME.accentSoft,
        lineWidth: { bottom: 0.15 },
        lineColor: REPORT_THEME.hairline
      },
      didParseCell: (hook) => {
        if (!options.keyResults || hook.section !== "body" || hook.column.index !== 1) return;
        hook.cell.styles.fontSize = REPORT_TYPE.keyValue;
        hook.cell.styles.fontStyle = "bold";
      },
      columnStyles: table.headers.length === 2
        ? { 0: { cellWidth: this.contentWidth * 0.38 }, 1: { halign: "right" } }
        : undefined
    });
    const finalY = (this.doc as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY;
    this.y = (finalY ?? this.y + 18) + 5;
  }

  private figure(figure: ReportFigure, maxHeight: number): void {
    this.ensureSpace(Math.min(maxHeight + 18, 96));
    this.text(figure.title, REPORT_LAYOUT.margin, this.y, 10, REPORT_THEME.ink, "bold");
    this.y += 4;
    const legendWidth = 24;
    const gap = 5;
    const imageAreaWidth = this.contentWidth - legendWidth - gap;
    const frameHeight = Math.max(35, Math.min(maxHeight - 14, imageAreaWidth * 0.56));
    const imageX = REPORT_LAYOUT.margin;
    const imageY = this.y;

    this.doc.setDrawColor(REPORT_THEME.hairline);
    this.doc.setLineWidth(0.2);
    this.doc.rect(imageX, imageY, imageAreaWidth, frameHeight);
    if (figure.png) {
      const dimensions = pngDimensions(figure.png);
      const fit = fitImage(dimensions.width, dimensions.height, imageAreaWidth - 4, frameHeight - 4);
      this.doc.addImage(
        figure.png,
        "PNG",
        imageX + (imageAreaWidth - fit.width) / 2,
        imageY + (frameHeight - fit.height) / 2,
        fit.width,
        fit.height,
        undefined,
        "FAST"
      );
    } else {
      this.doc.setFillColor("#f6f8fa");
      this.doc.rect(imageX + 0.2, imageY + 0.2, imageAreaWidth - 0.4, frameHeight - 0.4, "F");
      this.text(figure.unavailableLabel, imageX + imageAreaWidth / 2, imageY + frameHeight / 2, REPORT_TYPE.body, REPORT_THEME.inkMuted, "normal", "center");
    }

    this.legend(imageX + imageAreaWidth + gap, imageY, legendWidth, frameHeight, figure);
    this.y += frameHeight + 4;
    const captionLines = this.splitText(figure.caption, this.contentWidth, REPORT_TYPE.caption);
    this.text(captionLines, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.caption, REPORT_THEME.inkMuted);
    this.y += captionLines.length * 3.5 + 6;
  }

  private legend(x: number, y: number, width: number, height: number, figure: ReportFigure): void {
    const barWidth = 5;
    const barHeight = Math.max(18, height - 18);
    const segmentHeight = barHeight / REPORT_THEME.ramp.length;
    const barY = y + 8;
    for (let index = 0; index < REPORT_THEME.ramp.length; index += 1) {
      this.doc.setFillColor(REPORT_THEME.ramp[REPORT_THEME.ramp.length - 1 - index]!);
      this.doc.rect(x, barY + index * segmentHeight, barWidth, segmentHeight + 0.1, "F");
    }
    this.doc.setDrawColor(REPORT_THEME.hairline);
    this.doc.rect(x, barY, barWidth, barHeight);
    this.text(figure.legendMax, x + barWidth + 2, barY + 2, 7.2, REPORT_THEME.ink, "bold");
    this.text(figure.legendMin, x + barWidth + 2, barY + barHeight, 7.2, REPORT_THEME.ink, "bold");
    this.text("Max", x, y + 4, 6.8, REPORT_THEME.inkMuted);
    this.text("Min", x, Math.min(y + height, barY + barHeight + 4), 6.8, REPORT_THEME.inkMuted);
    void width;
  }

  private bullet(message: string): void {
    const lines = this.splitText(message, this.contentWidth - 7, REPORT_TYPE.body);
    const height = Math.max(5, lines.length * 4.2);
    this.ensureSpace(height + 2);
    this.doc.setFillColor(REPORT_THEME.accent);
    this.doc.circle(REPORT_LAYOUT.margin + 1.2, this.y - 1, 0.7, "F");
    this.text(lines, REPORT_LAYOUT.margin + 5, this.y, REPORT_TYPE.body, REPORT_THEME.ink);
    this.y += height + 1;
  }

  private callout(message: string | string[], tone: "success" | "warning" | "error", height: number): void {
    const color = tone === "success" ? REPORT_THEME.success : tone === "error" ? REPORT_THEME.error : REPORT_THEME.warning;
    const fill = tone === "success" ? REPORT_THEME.successSoft : tone === "error" ? REPORT_THEME.errorSoft : REPORT_THEME.warningSoft;
    this.doc.setFillColor(fill);
    this.doc.setDrawColor(color);
    this.doc.setLineWidth(0.35);
    this.doc.roundedRect(REPORT_LAYOUT.margin, this.y, this.contentWidth, height, 1.5, 1.5, "FD");
    this.text(message, REPORT_LAYOUT.margin + 4, this.y + 6.2, REPORT_TYPE.body, color, "bold");
    this.y += height;
  }

  private ensureSpace(requiredHeight: number): void {
    if (this.y + requiredHeight <= this.pageHeight - REPORT_LAYOUT.footerHeight - FOOTER_GAP) return;
    this.addPage();
  }

  private addPage(): void {
    this.doc.addPage(this.data.pageFormat, "portrait");
    this.y = REPORT_LAYOUT.margin;
  }

  private splitText(value: string, width: number, size: number, weight: "normal" | "bold" = "normal"): string[] {
    this.doc.setFont(this.fontFamily, weight);
    this.doc.setFontSize(size);
    return this.doc.splitTextToSize(value, width) as string[];
  }

  private text(
    value: string | string[],
    x: number,
    y: number,
    size: number,
    color: string,
    weight: "normal" | "bold" = "normal",
    align: "left" | "center" | "right" = "left"
  ): void {
    this.doc.setFont(this.fontFamily, weight);
    this.doc.setFontSize(size);
    this.doc.setTextColor(color);
    this.doc.text(value, x, y, { align });
  }
}

async function registerReportFonts(doc: jsPDF): Promise<string> {
  try {
    fontAssetsPromise ??= Promise.all([fetchAssetBase64(regularFontUrl), fetchAssetBase64(semiBoldFontUrl)])
      .then(([regular, semiBold]) => ({ regular, semiBold }))
      .catch(() => null);
    const fonts = await fontAssetsPromise;
    if (!fonts) return BUILTIN_FONT;
    doc.addFileToVFS("IBMPlexSans-Regular.ttf", fonts.regular);
    doc.addFont("IBMPlexSans-Regular.ttf", FONT_FAMILY, "normal");
    doc.addFileToVFS("IBMPlexSans-SemiBold.ttf", fonts.semiBold);
    doc.addFont("IBMPlexSans-SemiBold.ttf", FONT_FAMILY, "bold");
    return FONT_FAMILY;
  } catch {
    return BUILTIN_FONT;
  }
}

async function loadLogo(): Promise<string | null> {
  logoAssetPromise ??= fetchAssetBase64("/opencae-logo.png")
    .then((base64) => `data:image/png;base64,${base64}`)
    .catch(() => null);
  return logoAssetPromise;
}

async function fetchAssetBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load report asset: ${url}`);
  return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function pngDimensions(dataUri: string): { width: number; height: number } {
  try {
    const base64 = dataUri.split(",", 2)[1];
    if (!base64) throw new Error("Missing PNG data");
    const header = atob(base64.slice(0, 40));
    const width = readUint32(header, 16);
    const height = readUint32(header, 20);
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // A malformed capture is handled by jsPDF; this fallback keeps layout deterministic.
  }
  return { width: 1600, height: 900 };
}

function readUint32(binary: string, offset: number): number {
  return (((binary.charCodeAt(offset) << 24) >>> 0) +
    (binary.charCodeAt(offset + 1) << 16) +
    (binary.charCodeAt(offset + 2) << 8) +
    binary.charCodeAt(offset + 3)) >>> 0;
}

function fitImage(pixelWidth: number, pixelHeight: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const naturalWidth = pixelWidth / 150 * 25.4;
  const naturalHeight = pixelHeight / 150 * 25.4;
  const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
  return {
    width: Math.max(0.2, naturalWidth * scale),
    height: Math.max(0.2, naturalHeight * scale)
  };
}
