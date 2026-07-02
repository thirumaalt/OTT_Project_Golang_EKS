const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, LevelFormat, ExternalHyperlink
} = require("docx");
const fs = require("fs");

// ── Colors ───────────────────────────────────────────────────────────────────
const BLUE       = "1F4E79";
const LIGHT_BLUE = "D6E4F0";
const MID_BLUE   = "2E75B6";
const ORANGE     = "C55A11";
const GREEN      = "375623";
const LIGHT_GREEN= "E2EFDA";
const LIGHT_ORANGE="FCE4D6";
const LIGHT_GRAY = "F2F2F2";
const CRITICAL_BG= "FFE0E0";
const WARNING_BG = "FFF3CD";
const HEADER_BG  = "1F4E79";
const WHITE      = "FFFFFF";

const PAGE_W = 12240;
const PAGE_H = 15840;
const MARGIN = 1080;
const CONTENT_W = PAGE_W - MARGIN * 2; // 10080

// ── Helpers ──────────────────────────────────────────────────────────────────
const border = (color = "CCCCCC") => ({ style: BorderStyle.SINGLE, size: 1, color });
const cellBorders = (color = "CCCCCC") => ({
  top: border(color), bottom: border(color),
  left: border(color), right: border(color)
});
const noBorders = () => ({
  top:    { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  left:   { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right:  { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
});

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 120 },
    children: [new TextRun({ text, bold: true, size: 36, color: BLUE, font: "Arial" })]
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 80 },
    children: [new TextRun({ text, bold: true, size: 28, color: MID_BLUE, font: "Arial" })]
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 60 },
    children: [new TextRun({ text, bold: true, size: 24, color: ORANGE, font: "Arial" })]
  });
}

function para(text, options = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 80 },
    children: [new TextRun({ text, size: 22, font: "Arial", ...options })]
  });
}

function bullet(text, bold = false) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text, size: 22, font: "Arial", bold })]
  });
}

function subbullet(text) {
  return new Paragraph({
    numbering: { reference: "subbullets", level: 0 },
    spacing: { before: 30, after: 30 },
    children: [new TextRun({ text, size: 20, font: "Arial" })]
  });
}

function code(text) {
  return new Paragraph({
    spacing: { before: 40, after: 40 },
    indent: { left: 720 },
    children: [new TextRun({ text, size: 18, font: "Courier New", color: "2E2E2E" })]
  });
}

function divider() {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: MID_BLUE, space: 1 } },
    children: []
  });
}

function spacer(before = 100, after = 100) {
  return new Paragraph({ spacing: { before, after }, children: [] });
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

// ── Header cell (bold white on blue) ────────────────────────────────────────
function hCell(text, w) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    borders: cellBorders(MID_BLUE),
    shading: { fill: HEADER_BG, type: ShadingType.CLEAR },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({
      children: [new TextRun({ text, bold: true, size: 20, color: WHITE, font: "Arial" })]
    })]
  });
}

// ── Data cell ────────────────────────────────────────────────────────────────
function dCell(text, w, bg = null, bold = false, color = "2E2E2E") {
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    borders: cellBorders(),
    shading: { fill: bg || WHITE, type: ShadingType.CLEAR },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({
      children: [new TextRun({ text, size: 20, font: "Arial", bold, color })]
    })]
  });
}

// ── Monospace cell ───────────────────────────────────────────────────────────
function monoCell(text, w, bg = null) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    borders: cellBorders(),
    shading: { fill: bg || LIGHT_GRAY, type: ShadingType.CLEAR },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({
      children: [new TextRun({ text, size: 18, font: "Courier New", color: "2E2E2E" })]
    })]
  });
}

// ── Info box ─────────────────────────────────────────────────────────────────
function infoBox(lines, bg = LIGHT_BLUE) {
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [CONTENT_W],
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT_W, type: WidthType.DXA },
        borders: { top: border(MID_BLUE), bottom: border(MID_BLUE), left: { style: BorderStyle.SINGLE, size: 12, color: MID_BLUE }, right: border(MID_BLUE) },
        shading: { fill: bg, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 200, right: 120 },
        children: lines.map(l => new Paragraph({
          spacing: { before: 40, after: 40 },
          children: [new TextRun({ text: l, size: 20, font: "Courier New", color: "2E2E2E" })]
        }))
      })]
    })]
  });
}

// ── Architecture box (fixed-width art) ───────────────────────────────────────
function archBox(lines) {
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [CONTENT_W],
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT_W, type: WidthType.DXA },
        borders: cellBorders(MID_BLUE),
        shading: { fill: "1E1E1E", type: ShadingType.CLEAR },
        margins: { top: 160, bottom: 160, left: 280, right: 280 },
        children: lines.map(l => new Paragraph({
          spacing: { before: 30, after: 30 },
          children: [new TextRun({ text: l, size: 18, font: "Courier New", color: "D4D4D4" })]
        }))
      })]
    })]
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENT SECTIONS
// ═══════════════════════════════════════════════════════════════════════════

// ── Cover Page ──────────────────────────────────────────────────────────────
const coverPage = [
  spacer(1440),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 80 },
    children: [new TextRun({ text: "MyFlix OTT Platform", bold: true, size: 52, color: BLUE, font: "Arial" })]
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 200 },
    children: [new TextRun({ text: "Observability Stack Documentation", bold: true, size: 40, color: MID_BLUE, font: "Arial" })]
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: MID_BLUE, space: 1 } },
    spacing: { before: 0, after: 400 },
    children: []
  }),
  spacer(200),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 60 },
    children: [new TextRun({ text: "Version 1.0", size: 24, color: "595959", font: "Arial" })]
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 60 },
    children: [new TextRun({ text: "June 2026", size: 24, color: "595959", font: "Arial" })]
  }),
  spacer(400),
  new Table({
    width: { size: 6000, type: WidthType.DXA },
    columnWidths: [6000],
    rows: [
      new TableRow({ children: [new TableCell({
        width: { size: 6000, type: WidthType.DXA },
        borders: cellBorders(MID_BLUE),
        shading: { fill: LIGHT_BLUE, type: ShadingType.CLEAR },
        margins: { top: 200, bottom: 200, left: 300, right: 300 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60, after: 60 }, children: [new TextRun({ text: "Stack Components", bold: true, size: 24, color: BLUE, font: "Arial" })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "Prometheus  |  Grafana  |  Loki  |  Promtail", size: 22, font: "Arial", color: "2E2E2E" })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "Jaeger  |  OpenTelemetry  |  Alertmanager", size: 22, font: "Arial", color: "2E2E2E" })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "cAdvisor  |  Node Exporter", size: 22, font: "Arial", color: "2E2E2E" })] }),
        ]
      })] })
    ]
  }),
  pageBreak()
];

// ── Section 1: Overview ──────────────────────────────────────────────────────
const section1 = [
  h1("1. Overview"),
  para("The MyFlix OTT platform implements a complete three-pillar observability strategy across all microservices. Every service is instrumented to provide full visibility into system health, performance, and behaviour in production."),
  spacer(80),
  h2("Three Pillars"),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [2400, 2400, 5280],
    rows: [
      new TableRow({ children: [hCell("Pillar", 2400), hCell("Technology", 2400), hCell("Purpose", 5280)] }),
      new TableRow({ children: [dCell("Metrics", 2400, LIGHT_BLUE, true, BLUE), dCell("Prometheus + Grafana", 2400), dCell("Scrape and visualise time-series metrics from all services, containers, and host.", 5280)] }),
      new TableRow({ children: [dCell("Logs", 2400, LIGHT_BLUE, true, BLUE), dCell("Loki + Promtail", 2400), dCell("Aggregate structured logs from all Docker containers into a central queryable store.", 5280)] }),
      new TableRow({ children: [dCell("Traces", 2400, LIGHT_BLUE, true, BLUE), dCell("Jaeger + OpenTelemetry", 2400), dCell("Distributed end-to-end request tracing across service boundaries with DB and HTTP spans.", 5280)] }),
      new TableRow({ children: [dCell("Alerting", 2400, LIGHT_BLUE, true, BLUE), dCell("Alertmanager", 2400), dCell("Route and deduplicate Prometheus alerts to notification channels (Slack, email, PagerDuty).", 5280)] }),
    ]
  }),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 2: Architecture ──────────────────────────────────────────────────
const section2 = [
  h1("2. Architecture"),
  h2("Observability Data Flow"),
  archBox([
    "  +------------------+    +------------------+    +------------------+",
    "  |  Go Services     |    |  Go Services     |    |  Go Services     |",
    "  |  (Gin + GORM)    |    |  (Gin + GORM)    |    |  (Gin + GORM)    |",
    "  +--------+---------+    +--------+---------+    +--------+---------+",
    "           |                       |                       |           ",
    "  [/metrics]  [OTLP gRPC]  [stdout logs]                              ",
    "       |           |              |                                    ",
    "       v           v              v                                    ",
    "  +----------+ +--------+ +-------------+                             ",
    "  |Prometheus| | Jaeger | |  Promtail   |                             ",
    "  |  :9090   | | :4317  | |   :9080     |                             ",
    "  +----+-----+ +---+----+ +------+------+                             ",
    "       |           |             |                                     ",
    "       |           v             v                                     ",
    "       |      +--------+   +----------+                               ",
    "       |      |Jaeger  |   |  Loki    |                               ",
    "       |      |UI:16686|   |  :3100   |                               ",
    "       |      +--------+   +----+-----+                               ",
    "       |                        |                                      ",
    "       +------------------------+                                      ",
    "       |        Grafana :3001   |                                      ",
    "       +------------------------+                                      ",
    "       |                                                               ",
    "       v                                                               ",
    "  +-------------+      +-----------------+                            ",
    "  | Alertmanager|----->| Webhook / Slack |                            ",
    "  |   :9093     |      | / Email / PD    |                            ",
    "  +-------------+      +-----------------+                            ",
    "                                                                       ",
    "  cAdvisor :8081  +  Node Exporter :9100  -->  Prometheus             ",
  ]),
  spacer(120),
  h2("Service-to-Service Trace Propagation"),
  para("Distributed traces are propagated using the W3C TraceContext standard (traceparent header). Three complete business flows are traced end-to-end:"),
  spacer(80),
  infoBox([
    "  LOGIN FLOW",
    "  Frontend  -->  api-gateway  -->  auth-service  -->  user-service",
    "                                       |                   |",
    "                                  gorm.query          gorm.query",
    "",
    "  DISCOVERY FLOW",
    "  Frontend  -->  api-gateway  -->  metadata-service",
    "                                       |",
    "                          +-----------+-----------+",
    "                          |                       |",
    "                 recommendation-service    watchhistory-service",
    "                       gorm.query               gorm.query",
    "",
    "  SUBSCRIPTION FLOW",
    "  Frontend  -->  api-gateway  -->  payment-service  -->  subscription-service",
    "                                       |                        |",
    "                                  gorm.create             gorm.create",
  ]),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 3: Services and Ports ────────────────────────────────────────────
const section3 = [
  h1("3. Services and Ports"),
  h2("Application Services"),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [3200, 1600, 5280],
    rows: [
      new TableRow({ children: [hCell("Service", 3200), hCell("Port", 1600), hCell("Responsibility", 5280)] }),
      new TableRow({ children: [monoCell("api-gateway", 3200), monoCell(":8094", 1600), dCell("JWT auth, reverse proxy, Prometheus metrics, otelhttp tracing", 5280)] }),
      new TableRow({ children: [monoCell("auth-service", 3200), monoCell(":8083", 1600), dCell("User registration and login, bcrypt passwords, JWT HS512 tokens", 5280)] }),
      new TableRow({ children: [monoCell("user-service", 3200), monoCell(":8085", 1600), dCell("User profiles, watchlist, watch history (profile-scoped)", 5280)] }),
      new TableRow({ children: [monoCell("metadata-service", 3200), monoCell(":8088", 1600), dCell("Media CRUD, TMDB proxy, full-text search, discover endpoint", 5280)] }),
      new TableRow({ children: [monoCell("media-library-service", 3200), monoCell(":8001", 1600), dCell("File streaming, HTTP Range/206, HLS delivery", 5280)] }),
      new TableRow({ children: [monoCell("payment-service", 3200), monoCell(":8091", 1600), dCell("Order create/capture, notifies subscription-service on capture", 5280)] }),
      new TableRow({ children: [monoCell("subscription-service", 3200), monoCell(":8093", 1600), dCell("Per-user subscription plan management (upsert on payment capture)", 5280)] }),
      new TableRow({ children: [monoCell("recommendation-service", 3200), monoCell(":8087", 1600), dCell("Per-user content recommendation store", 5280)] }),
      new TableRow({ children: [monoCell("watchhistory-service", 3200), monoCell(":8090", 1600), dCell("User-scoped content watch events (userId + contentId)", 5280)] }),
      new TableRow({ children: [monoCell("analytics-service", 3200), monoCell(":8086", 1600), dCell("Action logging and aggregate statistics", 5280)] }),
      new TableRow({ children: [monoCell("interaction-service", 3200), monoCell(":8089", 1600), dCell("Likes and ratings per content item", 5280)] }),
      new TableRow({ children: [monoCell("transcoding-service", 3200, LIGHT_ORANGE), monoCell(":8092", 1600, LIGHT_ORANGE), dCell("Python service — video transcoding pipeline (no Go OTEL)", 5280, LIGHT_ORANGE)] }),
    ]
  }),
  spacer(200),
  h2("Observability Infrastructure"),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [3200, 1600, 5280],
    rows: [
      new TableRow({ children: [hCell("Component", 3200), hCell("Port", 1600), hCell("Access URL", 5280)] }),
      new TableRow({ children: [dCell("Prometheus", 3200), monoCell(":9090", 1600), monoCell("http://localhost:9090", 5280, LIGHT_BLUE)] }),
      new TableRow({ children: [dCell("Grafana", 3200), monoCell(":3001", 1600), monoCell("http://localhost:3001  (admin / admin)", 5280, LIGHT_BLUE)] }),
      new TableRow({ children: [dCell("Jaeger UI", 3200), monoCell(":16686", 1600), monoCell("http://localhost:16686", 5280, LIGHT_BLUE)] }),
      new TableRow({ children: [dCell("Alertmanager", 3200), monoCell(":9093", 1600), monoCell("http://localhost:9093", 5280, LIGHT_BLUE)] }),
      new TableRow({ children: [dCell("Loki", 3200), monoCell(":3100", 1600), monoCell("http://localhost:3100  (internal)", 5280)] }),
      new TableRow({ children: [dCell("Promtail", 3200), monoCell(":9080", 1600), monoCell("http://localhost:9080  (internal)", 5280)] }),
      new TableRow({ children: [dCell("cAdvisor", 3200), monoCell(":8081", 1600), monoCell("http://localhost:8081", 5280, LIGHT_BLUE)] }),
      new TableRow({ children: [dCell("Node Exporter", 3200), monoCell(":9100", 1600), monoCell("http://localhost:9100/metrics  (internal)", 5280)] }),
    ]
  }),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 4: Metrics ───────────────────────────────────────────────────────
const section4 = [
  h1("4. Metrics — Prometheus + Grafana"),
  h2("Configuration"),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [3600, 6480],
    rows: [
      new TableRow({ children: [hCell("Setting", 3600), hCell("Value", 6480)] }),
      new TableRow({ children: [dCell("Scrape interval", 3600), monoCell("15s", 6480)] }),
      new TableRow({ children: [dCell("Evaluation interval", 3600), monoCell("30s", 6480)] }),
      new TableRow({ children: [dCell("Config file", 3600), monoCell("observability/prometheus.yml", 6480)] }),
      new TableRow({ children: [dCell("Rules file", 3600), monoCell("observability/alert_rules.yml", 6480)] }),
      new TableRow({ children: [dCell("Alertmanager endpoint", 3600), monoCell("alertmanager:9093", 6480)] }),
    ]
  }),
  spacer(160),
  h2("Available Metrics"),
  h3("Go Services (gin_prometheus)"),
  bullet("gin_requests_total — request count labelled by method, path, status code"),
  bullet("gin_request_duration_seconds_bucket — latency histogram (p50, p90, p99)"),
  bullet("go_goroutines, go_gc_duration_seconds — Go runtime metrics"),
  spacer(80),
  h3("Container Metrics (cAdvisor)"),
  bullet("container_memory_usage_bytes — current memory consumption per container"),
  bullet("container_cpu_usage_seconds_total — cumulative CPU time per container"),
  bullet("container_network_receive_bytes_total — inbound network traffic"),
  bullet("container_network_transmit_bytes_total — outbound network traffic"),
  spacer(80),
  h3("Host Metrics (Node Exporter)"),
  bullet("node_cpu_seconds_total — host CPU usage by mode"),
  bullet("node_memory_MemAvailable_bytes — available system memory"),
  bullet("node_filesystem_avail_bytes — available disk space"),
  bullet("node_network_receive_bytes_total — host network I/O"),
  spacer(160),
  h2("Useful PromQL Queries"),
  infoBox([
    "# Request rate per service (req/s over 5 minutes)",
    "rate(gin_requests_total[5m])",
    "",
    "# p99 latency per service",
    "histogram_quantile(0.99, rate(gin_request_duration_seconds_bucket[5m]))",
    "",
    "# 5xx error rate",
    "rate(gin_requests_total{status=~\"5..\"}[5m]) / rate(gin_requests_total[5m])",
    "",
    "# Container memory usage (MiB)",
    "container_memory_usage_bytes{name=~\"ott_project_golang.*\"} / 1024 / 1024",
    "",
    "# Services that are down",
    "up == 0",
  ]),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 5: Distributed Tracing ───────────────────────────────────────────
const section5 = [
  h1("5. Distributed Tracing — Jaeger + OpenTelemetry"),
  h2("Setup"),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [3600, 6480],
    rows: [
      new TableRow({ children: [hCell("Component", 3600), hCell("Detail", 6480)] }),
      new TableRow({ children: [dCell("OTLP exporter", 3600), monoCell("jaeger:4317  (gRPC, insecure)", 6480)] }),
      new TableRow({ children: [dCell("Propagation format", 3600), monoCell("W3C TraceContext  (traceparent / tracestate headers)", 6480)] }),
      new TableRow({ children: [dCell("Telemetry package", 3600), monoCell("telemetry/tracer.go  in each service", 6480)] }),
      new TableRow({ children: [dCell("DB instrumentation", 3600), monoCell("telemetry/gorm.go  (inline GORM plugin, no external deps)", 6480)] }),
      new TableRow({ children: [dCell("HTTP client spans", 3600), monoCell("otelhttp.NewTransport  wrapping all outbound http.Client", 6480)] }),
      new TableRow({ children: [dCell("Jaeger UI", 3600), monoCell("http://localhost:16686", 6480)] }),
    ]
  }),
  spacer(160),
  h2("Instrumented Business Flows"),
  h3("Login Flow"),
  infoBox([
    "POST /api/auth/login",
    "",
    "api-gateway (HTTP GET span)",
    "  auth-service  POST /api/auth/login",
    "    gorm.query    db.sql.table=users   SELECT * FROM users WHERE username = ?",
    "    user-service  GET /api/user/by-username",
    "      gorm.query  db.sql.table=users   SELECT * FROM users WHERE username = ?",
  ]),
  spacer(120),
  h3("Discovery Flow"),
  infoBox([
    "GET /api/metadata/discover?userId=<id>",
    "",
    "api-gateway (HTTP GET span)",
    "  metadata-service  GET /api/metadata/discover",
    "    recommendation-service  GET /api/recommendations/get",
    "      gorm.query    db.sql.table=recommendations",
    "    watchhistory-service    GET /api/watch-history/user",
    "      gorm.query    db.sql.table=watch_histories",
  ]),
  spacer(120),
  h3("Subscription Flow"),
  infoBox([
    "POST /api/payment/capture-payment?orderId=<id>",
    "",
    "api-gateway (HTTP GET span)",
    "  payment-service  POST /api/payment/capture-payment",
    "    gorm.query     db.sql.table=payment_orders",
    "    gorm.create    db.sql.table=payment_orders",
    "    subscription-service  POST /api/subscription/upgrade",
    "      gorm.query   db.sql.table=subscriptions",
    "      gorm.create  db.sql.table=subscriptions",
  ]),
  spacer(160),
  h2("GORM Database Spans"),
  para("All database queries are traced as child spans of the HTTP handler span. The inline GormPlugin (telemetry/gorm.go) hooks GORM callbacks with zero external dependencies."),
  spacer(80),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [2800, 3640, 3640],
    rows: [
      new TableRow({ children: [hCell("Span Name", 2800), hCell("GORM Callback", 3640), hCell("Span Attributes", 3640)] }),
      new TableRow({ children: [monoCell("gorm.query", 2800), dCell("Query (SELECT)", 3640), monoCell("db.sql.table, db.statement", 3640)] }),
      new TableRow({ children: [monoCell("gorm.create", 2800), dCell("Create (INSERT)", 3640), monoCell("db.sql.table, db.statement", 3640)] }),
      new TableRow({ children: [monoCell("gorm.update", 2800), dCell("Update (UPDATE)", 3640), monoCell("db.sql.table, db.statement", 3640)] }),
      new TableRow({ children: [monoCell("gorm.delete", 2800), dCell("Delete (DELETE)", 3640), monoCell("db.sql.table, db.statement", 3640)] }),
      new TableRow({ children: [monoCell("gorm.row", 2800), dCell("Row / Raw", 3640), monoCell("db.sql.table, db.statement", 3640)] }),
    ]
  }),
  spacer(100),
  para("Context propagation requirement: all DB calls must pass the request context:"),
  code("db.WithContext(c.Request.Context()).Where(...).Find(...)"),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 6: Logs ───────────────────────────────────────────────────────────
const section6 = [
  h1("6. Log Aggregation — Loki + Promtail"),
  h2("How It Works"),
  para("Promtail runs as a Docker container with access to the Docker socket. It scrapes stdout/stderr from every container and ships them to Loki with labels derived from the container name and stream."),
  spacer(80),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [3200, 6880],
    rows: [
      new TableRow({ children: [hCell("Component", 3200), hCell("Detail", 6880)] }),
      new TableRow({ children: [dCell("Promtail config", 3200), monoCell("observability/promtail-config.yml", 6880)] }),
      new TableRow({ children: [dCell("Loki config", 3200), monoCell("observability/loki.yml", 6880)] }),
      new TableRow({ children: [dCell("Log source", 3200), monoCell("/var/lib/docker/containers/*/*-json.log", 6880)] }),
      new TableRow({ children: [dCell("Default labels", 3200), monoCell("job, container_name, stream (stdout/stderr)", 6880)] }),
      new TableRow({ children: [dCell("Query UI", 3200), monoCell("Grafana → Explore → Loki data source", 6880)] }),
    ]
  }),
  spacer(160),
  h2("LogQL Query Examples"),
  infoBox([
    "# All logs from api-gateway",
    "{job=\"api-gateway\"}",
    "",
    "# Error logs across all services",
    "{job=~\".+\"} |= \"error\"",
    "",
    "# Slow upstream requests from proxy log",
    "{job=\"api-gateway\"} |~ \"Proxying\" | logfmt | duration > 1s",
    "",
    "# Login failures",
    "{job=\"auth-service\"} |= \"invalid credentials\"",
    "",
    "# All 5xx responses",
    "{job=~\".+\"} |= \"status=5\"",
    "",
    "# Payment service errors",
    "{job=\"payment-service\"} |= \"error\" | json",
  ]),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 7: Alerting ──────────────────────────────────────────────────────
const section7 = [
  h1("7. Alerting — Prometheus Alertmanager"),
  h2("Alert Rules"),
  para("Rules are defined in observability/alert_rules.yml and loaded by Prometheus at startup. Alerts evaluate every 30 seconds."),
  spacer(80),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [2800, 3000, 1200, 1400, 1680],
    rows: [
      new TableRow({ children: [hCell("Alert Name", 2800), hCell("Condition", 3000), hCell("For", 1200), hCell("Severity", 1400), hCell("Group", 1680)] }),
      new TableRow({ children: [monoCell("ServiceDown", 2800, CRITICAL_BG), dCell("up == 0", 3000, CRITICAL_BG), dCell("1m", 1200, CRITICAL_BG), dCell("CRITICAL", 1400, CRITICAL_BG, true, "CC0000"), dCell("service_health", 1680, CRITICAL_BG)] }),
      new TableRow({ children: [monoCell("HighErrorRate", 2800, CRITICAL_BG), dCell(">5% 5xx rate over 5m window", 3000, CRITICAL_BG), dCell("2m", 1200, CRITICAL_BG), dCell("CRITICAL", 1400, CRITICAL_BG, true, "CC0000"), dCell("service_health", 1680, CRITICAL_BG)] }),
      new TableRow({ children: [monoCell("PostgresDown", 2800, CRITICAL_BG), dCell("postgres up == 0", 3000, CRITICAL_BG), dCell("1m", 1200, CRITICAL_BG), dCell("CRITICAL", 1400, CRITICAL_BG, true, "CC0000"), dCell("service_health", 1680, CRITICAL_BG)] }),
      new TableRow({ children: [monoCell("HighLatency", 2800, WARNING_BG), dCell("p99 latency > 2s", 3000, WARNING_BG), dCell("2m", 1200, WARNING_BG), dCell("warning", 1400, WARNING_BG, false, "856404"), dCell("service_health", 1680, WARNING_BG)] }),
      new TableRow({ children: [monoCell("HighMemoryUsage", 2800, WARNING_BG), dCell("container > 500 MiB", 3000, WARNING_BG), dCell("5m", 1200, WARNING_BG), dCell("warning", 1400, WARNING_BG, false, "856404"), dCell("service_health", 1680, WARNING_BG)] }),
      new TableRow({ children: [monoCell("HighCPUUsage", 2800, WARNING_BG), dCell("container CPU > 80%", 3000, WARNING_BG), dCell("5m", 1200, WARNING_BG), dCell("warning", 1400, WARNING_BG, false, "856404"), dCell("service_health", 1680, WARNING_BG)] }),
      new TableRow({ children: [monoCell("GatewayHighRequestRate", 2800, WARNING_BG), dCell("api-gateway > 100 req/s", 3000, WARNING_BG), dCell("2m", 1200, WARNING_BG), dCell("warning", 1400, WARNING_BG, false, "856404"), dCell("api_gateway", 1680, WARNING_BG)] }),
      new TableRow({ children: [monoCell("GatewayNoTraffic", 2800, WARNING_BG), dCell("api-gateway 0 req/s", 3000, WARNING_BG), dCell("10m", 1200, WARNING_BG), dCell("warning", 1400, WARNING_BG, false, "856404"), dCell("api_gateway", 1680, WARNING_BG)] }),
    ]
  }),
  spacer(160),
  h2("Alert Routing"),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [2600, 2000, 2000, 3480],
    rows: [
      new TableRow({ children: [hCell("Severity", 2600), hCell("group_wait", 2000), hCell("repeat_interval", 2000), hCell("Receiver", 3480)] }),
      new TableRow({ children: [dCell("CRITICAL", 2600, CRITICAL_BG, true, "CC0000"), dCell("10s", 2000, CRITICAL_BG), dCell("30 minutes", 2000, CRITICAL_BG), monoCell("critical (webhook)", 3480, CRITICAL_BG)] }),
      new TableRow({ children: [dCell("warning", 2600, WARNING_BG), dCell("30s", 2000, WARNING_BG), dCell("1 hour", 2000, WARNING_BG), monoCell("default (webhook)", 3480, WARNING_BG)] }),
    ]
  }),
  spacer(120),
  h2("Inhibition Rules"),
  para("When a CRITICAL alert fires for a service, all WARNING alerts for the same service and alert name are suppressed. This prevents alert storms when a service is completely down."),
  spacer(120),
  h2("Configuring Notification Channels"),
  para("The current configuration uses a webhook placeholder. Replace it in observability/alertmanager.yml with your notification channel:"),
  spacer(80),
  h3("Slack"),
  infoBox([
    "receivers:",
    "  - name: 'critical'",
    "    slack_configs:",
    "      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'",
    "        channel: '#alerts-critical'",
    "        title: '{{ .GroupLabels.alertname }}'",
    "        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'",
    "        send_resolved: true",
  ]),
  spacer(100),
  h3("Email"),
  infoBox([
    "global:",
    "  smtp_smarthost: 'smtp.gmail.com:587'",
    "  smtp_from: 'alerts@myflix.com'",
    "  smtp_auth_username: 'alerts@myflix.com'",
    "  smtp_auth_password: 'YOUR_APP_PASSWORD'",
    "",
    "receivers:",
    "  - name: 'critical'",
    "    email_configs:",
    "      - to: 'oncall@myflix.com'",
    "        send_resolved: true",
  ]),
  spacer(120),
  h2("Accessing Alert Status"),
  bullet("Prometheus alert list:  http://localhost:9090/alerts"),
  bullet("Alertmanager UI:        http://localhost:9093"),
  bullet("Silencing an alert:     Alertmanager UI → New Silence"),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 8: OTel Implementation ───────────────────────────────────────────
const section8 = [
  h1("8. OpenTelemetry Implementation Details"),
  h2("Telemetry Package Structure"),
  para("Every Go service contains an identical telemetry/ package with two files:"),
  spacer(80),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [3200, 6880],
    rows: [
      new TableRow({ children: [hCell("File", 3200), hCell("Responsibility", 6880)] }),
      new TableRow({ children: [monoCell("telemetry/tracer.go", 3200), dCell("InitTracer(serviceName) — registers OTLP gRPC exporter, sets W3C propagator, returns shutdown func", 6880)] }),
      new TableRow({ children: [monoCell("telemetry/gorm.go", 3200), dCell("NewGormPlugin() — GORM plugin that hooks all DB callbacks and creates child spans (zero external deps)", 6880)] }),
    ]
  }),
  spacer(160),
  h2("InitTracer"),
  para("Called once at service startup before the HTTP server starts:"),
  infoBox([
    "shutdown := telemetry.InitTracer(\"auth-service\")",
    "defer shutdown()",
    "",
    "// Exports to:  jaeger:4317  (OTLP gRPC, insecure)",
    "// Propagator:  W3C TraceContext  (traceparent / tracestate)",
    "// Batcher:     sdktrace.WithBatcher (async, buffered)",
  ]),
  spacer(120),
  h2("TracingMiddleware"),
  para("Applied to the Gin router in every service. Extracts incoming trace context from the request headers and starts a server span for the route:"),
  infoBox([
    "func TracingMiddleware() gin.HandlerFunc {",
    "    tracer := otel.Tracer(\"service-name\")",
    "    return func(c *gin.Context) {",
    "        ctx := otel.GetTextMapPropagator().Extract(",
    "            c.Request.Context(),",
    "            propagation.HeaderCarrier(c.Request.Header),",
    "        )",
    "        ctx, span := tracer.Start(ctx, c.Request.Method+\" \"+c.FullPath())",
    "        defer span.End()",
    "        c.Request = c.Request.WithContext(ctx)",
    "        c.Next()",
    "    }",
    "}",
  ]),
  spacer(120),
  h2("GormPlugin"),
  para("Hooks GORM callbacks before and after each operation. Uses db.WithContext(c.Request.Context()) on every query to link DB spans to the active trace:"),
  infoBox([
    "// Register plugin after InitTracer:",
    "db.Use(telemetry.NewGormPlugin())",
    "",
    "// Every DB call must pass the request context:",
    "db.WithContext(c.Request.Context()).Where(\"user_id = ?\", id).Find(&records)",
    "",
    "// Resulting spans include attributes:",
    "//   db.sql.table = \"users\"",
    "//   db.statement = \"SELECT * FROM users WHERE user_id = ?\"",
  ]),
  spacer(120),
  h2("HTTP Client Spans"),
  para("All outbound service-to-service HTTP calls are wrapped with otelhttp.NewTransport. This automatically creates client spans and injects the traceparent header into the outbound request:"),
  infoBox([
    "// api-gateway proxy (package-level, reused across requests)",
    "var proxyClient = &http.Client{",
    "    Transport: otelhttp.NewTransport(http.DefaultTransport),",
    "    Timeout:   30 * time.Second,",
    "}",
    "",
    "// Service-to-service calls (auth → user, metadata → recommendation, etc.)",
    "client := &http.Client{",
    "    Transport: otelhttp.NewTransport(http.DefaultTransport),",
    "}",
    "req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)",
    "resp, err := client.Do(req)  // span created automatically",
  ]),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 9: Infrastructure as Code ────────────────────────────────────────
const section9 = [
  h1("9. Infrastructure as Code"),
  h2("Docker Compose"),
  para("All services and observability infrastructure are defined in docker-compose.yml at the project root. Use a single command to start the entire platform:"),
  spacer(80),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [4200, 5880],
    rows: [
      new TableRow({ children: [hCell("Command", 4200), hCell("Effect", 5880)] }),
      new TableRow({ children: [monoCell("docker compose up -d", 4200), dCell("Start all services in detached mode", 5880)] }),
      new TableRow({ children: [monoCell("docker compose up --build", 4200), dCell("Rebuild images and start", 5880)] }),
      new TableRow({ children: [monoCell("docker compose build --no-cache <svc>", 4200), dCell("Force-rebuild a single service", 5880)] }),
      new TableRow({ children: [monoCell("docker compose logs -f <svc>", 4200), dCell("Stream logs for a service", 5880)] }),
      new TableRow({ children: [monoCell("docker compose ps", 4200), dCell("Show running containers and health", 5880)] }),
      new TableRow({ children: [monoCell("docker compose down", 4200), dCell("Stop and remove containers (volumes preserved)", 5880)] }),
      new TableRow({ children: [monoCell("docker compose down -v", 4200), dCell("Stop and remove containers AND volumes (data loss)", 5880)] }),
    ]
  }),
  spacer(160),
  h2("Observability Config Files"),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [4200, 5880],
    rows: [
      new TableRow({ children: [hCell("File", 4200), hCell("Purpose", 5880)] }),
      new TableRow({ children: [monoCell("observability/prometheus.yml", 4200), dCell("Scrape targets, Alertmanager endpoint, rules file path", 5880)] }),
      new TableRow({ children: [monoCell("observability/alert_rules.yml", 4200), dCell("All Prometheus alerting rules (8 rules across 2 groups)", 5880)] }),
      new TableRow({ children: [monoCell("observability/alertmanager.yml", 4200), dCell("Alert routing, receivers (webhook/Slack/email), inhibition rules", 5880)] }),
      new TableRow({ children: [monoCell("observability/loki.yml", 4200), dCell("Loki storage and retention configuration", 5880)] }),
      new TableRow({ children: [monoCell("observability/promtail-config.yml", 4200), dCell("Promtail Docker log scrape configuration", 5880)] }),
    ]
  }),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 10: Known Issues ─────────────────────────────────────────────────
const section10 = [
  h1("10. Known Issues and Tech Debt"),
  h2("Critical Issues"),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [400, 3200, 6480],
    rows: [
      new TableRow({ children: [hCell("#", 400), hCell("Issue", 3200), hCell("Detail", 6480)] }),
      new TableRow({ children: [
        dCell("1", 400, CRITICAL_BG, true, "CC0000"),
        dCell("Dual watch_histories tables", 3200, CRITICAL_BG, true),
        dCell("user-service stores history profile-scoped with progress tracking; watchhistory-service stores it user-scoped with contentId. Incompatible schemas — data is split across two tables.", 6480, CRITICAL_BG)
      ]}),
      new TableRow({ children: [
        dCell("2", 400, CRITICAL_BG, true, "CC0000"),
        dCell("Shared users table", 3200, CRITICAL_BG, true),
        dCell("auth-service and user-service both AutoMigrate the users table. Co-ownership is fragile and migrations can conflict.", 6480, CRITICAL_BG)
      ]}),
    ]
  }),
  spacer(160),
  h2("Warnings"),
  new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [400, 3200, 6480],
    rows: [
      new TableRow({ children: [hCell("#", 400), hCell("Issue", 3200), hCell("Detail", 6480)] }),
      new TableRow({ children: [
        dCell("3", 400, WARNING_BG),
        dCell("Redis unused", 3200, WARNING_BG),
        dCell("Redis is deployed and running but no service uses it. Either wire up caching (sessions, rate limiting, recommendations) or remove it.", 6480, WARNING_BG)
      ]}),
      new TableRow({ children: [
        dCell("4", 400, WARNING_BG),
        dCell("Hardcoded Jaeger endpoint", 3200, WARNING_BG),
        dCell("All telemetry/tracer.go files hardcode jaeger:4317. Not configurable via environment variable. Needs OTEL_EXPORTER_OTLP_ENDPOINT support before Kubernetes migration.", 6480, WARNING_BG)
      ]}),
      new TableRow({ children: [
        dCell("5", 400, WARNING_BG),
        dCell("OTEL version split", 3200, WARNING_BG),
        dCell("api-gateway, auth-service, subscription-service use v1.44.0. All other services use v1.34.0. Standardise to v1.44.0 in the next phase.", 6480, WARNING_BG)
      ]}),
      new TableRow({ children: [
        dCell("6", 400, WARNING_BG),
        dCell("Alertmanager placeholder receiver", 3200, WARNING_BG),
        dCell("The webhook URL (http://localhost:5001/alerts) is a placeholder. Configure a real channel (Slack/email/PagerDuty) before deploying to production.", 6480, WARNING_BG)
      ]}),
      new TableRow({ children: [
        dCell("7", 400, WARNING_BG),
        dCell("Python transcoding-service uninstrumented", 3200, WARNING_BG),
        dCell("The transcoding-service is written in Python. It has no OpenTelemetry instrumentation. Use opentelemetry-sdk-python with OTLP exporter to add traces.", 6480, WARNING_BG)
      ]}),
      new TableRow({ children: [
        dCell("8", 400, WARNING_BG),
        dCell("D:/media hardcoded in compose", 3200, WARNING_BG),
        dCell("The media-library-service volume uses a Windows-specific path D:/media. Must be made configurable before Linux/CI/Kubernetes deployment.", 6480, WARNING_BG)
      ]}),
    ]
  }),
  spacer(120),
  divider(),
  pageBreak()
];

// ── Section 11: Next Steps ────────────────────────────────────────────────────
const section11 = [
  h1("11. Next Steps"),
  h2("Immediate (Before Production)"),
  bullet("Configure Alertmanager with a real notification channel (Slack recommended)", true),
  bullet("Standardise all services to OpenTelemetry v1.44.0"),
  bullet("Make Jaeger endpoint configurable via OTEL_EXPORTER_OTLP_ENDPOINT env var"),
  bullet("Resolve the dual watch_histories table ownership"),
  spacer(120),
  h2("Short Term"),
  bullet("Add Python OpenTelemetry instrumentation to transcoding-service"),
  bullet("Wire up Redis for session caching or rate limiting"),
  bullet("Add database connection pool metrics (pgx instrumentation)"),
  bullet("Create Grafana dashboards for each service with latency, error rate, and throughput"),
  spacer(120),
  h2("Medium Term — Kubernetes Migration"),
  bullet("Convert docker-compose.yml to Kubernetes manifests (Deployments, Services, ConfigMaps)"),
  bullet("Use Kubernetes secrets for JWT_SECRET, database credentials"),
  bullet("Deploy Prometheus Operator for automated scrape configuration"),
  bullet("Use OpenTelemetry Operator for standardised OTLP collector sidecar injection"),
  bullet("Add HorizontalPodAutoscaler for api-gateway and metadata-service"),
  spacer(120),
  divider()
];

// ═══════════════════════════════════════════════════════════════════════════
// BUILD DOCUMENT
// ═══════════════════════════════════════════════════════════════════════════
const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "•",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 540, hanging: 360 } } }
        }]
      },
      {
        reference: "subbullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "-",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 1080, hanging: 360 } } }
        }]
      },
    ]
  },
  styles: {
    default: {
      document: { run: { font: "Arial", size: 22, color: "2E2E2E" } }
    },
    paragraphStyles: [
      {
        id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: BLUE },
        paragraph: { spacing: { before: 360, after: 120 }, outlineLevel: 0 }
      },
      {
        id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: MID_BLUE },
        paragraph: { spacing: { before: 280, after: 80 }, outlineLevel: 1 }
      },
      {
        id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: ORANGE },
        paragraph: { spacing: { before: 200, after: 60 }, outlineLevel: 2 }
      },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: PAGE_W, height: PAGE_H },
        margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: MID_BLUE, space: 1 } },
          children: [
            new TextRun({ text: "MyFlix OTT Platform  —  Observability Stack Documentation", size: 18, font: "Arial", color: "595959" }),
          ]
        })]
      })
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: MID_BLUE, space: 1 } },
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: "Page ", size: 18, font: "Arial", color: "595959" }),
            new TextRun({ children: [PageNumber.CURRENT], size: 18, font: "Arial", color: "595959" }),
            new TextRun({ text: " of ", size: 18, font: "Arial", color: "595959" }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, font: "Arial", color: "595959" }),
          ]
        })]
      })
    },
    children: [
      ...coverPage,
      ...section1,
      ...section2,
      ...section3,
      ...section4,
      ...section5,
      ...section6,
      ...section7,
      ...section8,
      ...section9,
      ...section10,
      ...section11,
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("F:/Projects/OTT_Project_Golang/docs/observability.docx", buffer);
  console.log("Done: observability.docx written");
}).catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
