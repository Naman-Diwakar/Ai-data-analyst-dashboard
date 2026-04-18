import { useMemo, useState } from "react";
import Papa from "papaparse";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell
} from "recharts";

const COLORS = ["#0B6E4F", "#2C7BE5", "#F29E4C", "#D7263D", "#6A4C93", "#1B998B", "#FF6B6B"];
const QUICK_PROMPTS = [
  "Top 5 products by revenue",
  "Show monthly trend of sales",
  "Which region contributes most?",
  "Give me a concise business summary"
];

function toNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function detectColumns(rows) {
  if (!rows.length) return { numeric: [], textual: [] };
  const columns = Object.keys(rows[0]);
  const numeric = columns.filter((col) => {
    let numericCount = 0;
    let sampled = 0;
    for (const row of rows) {
      if (sampled >= 40) break;
      const value = row[col];
      if (value !== "" && value !== null && value !== undefined) {
        sampled += 1;
        if (!Number.isNaN(toNumber(value))) numericCount += 1;
      }
    }
    return sampled > 0 && numericCount / sampled > 0.7;
  });
  const textual = columns.filter((col) => !numeric.includes(col));
  return { numeric, textual };
}

function aggregateBy(rows, groupBy, valueKey, type = "sum", topN = 0) {
  const map = new Map();
  const countMap = new Map();

  for (const row of rows) {
    const key = row[groupBy] ?? "Unknown";
    const num = toNumber(row[valueKey]);
    if (Number.isNaN(num)) continue;
    map.set(key, (map.get(key) ?? 0) + num);
    countMap.set(key, (countMap.get(key) ?? 0) + 1);
  }

  let data = [...map.entries()].map(([name, value]) => ({
    name,
    value: type === "avg" ? value / (countMap.get(name) ?? 1) : value
  }));

  data = data.sort((a, b) => b.value - a.value);
  if (topN > 0) data = data.slice(0, topN);
  return data;
}

function sortTrendData(data) {
  const looksDateLike = data.some((item) =>
    /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|\d{1,2}[/-]\d{1,2}/i.test(String(item.name))
  );
  if (!looksDateLike) return data;
  return [...data].sort((a, b) => {
    const da = Date.parse(a.name);
    const db = Date.parse(b.name);
    if (Number.isFinite(da) && Number.isFinite(db)) return da - db;
    return String(a.name).localeCompare(String(b.name));
  });
}

function buildOverviewAnalysis(rows) {
  const { numeric, textual } = detectColumns(rows);

  if (!rows.length) {
    return {
      insight: "Upload CSV files and click Analyze Uploaded Data to generate insights.",
      chartType: "bar",
      data: [],
      metricUsed: null,
      groupUsed: null
    };
  }

  const metric = numeric[0] || null;
  const group =
    textual.find((col) => /category|product|region|segment|type|name/i.test(col)) || textual[0] || null;

  if (!metric) {
    return {
      insight: "No numeric column detected, so chart analysis is limited. Try uploading a dataset with sales/revenue/amount columns.",
      chartType: "table",
      data: rows.slice(0, 12).map((row, index) => ({ name: `Row ${index + 1}`, value: 1 })),
      metricUsed: null,
      groupUsed: null
    };
  }

  if (!group) {
    const values = rows.map((row) => toNumber(row[metric])).filter((n) => !Number.isNaN(n));
    const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return {
      insight: `Detected one strong metric (${metric}). Average is ${formatNumber(avg)} across ${values.length} valid rows.`,
      chartType: "bar",
      data: [{ name: `Average ${metric}`, value: Number(avg.toFixed(2)) }],
      metricUsed: metric,
      groupUsed: null
    };
  }

  const topData = aggregateBy(rows, group, metric, "sum", 8);
  const best = topData[0];

  return {
    insight: best
      ? `Dataset overview: ${best.name} is currently leading ${metric} at ${formatNumber(best.value)}.`
      : `Overview generated on ${metric} grouped by ${group}.`,
    chartType: "bar",
    data: topData,
    metricUsed: metric,
    groupUsed: group
  };
}

function buildDatasetSummary(rows) {
  if (!rows.length) {
    return {
      title: "No dataset loaded yet",
      bullets: ["Upload at least one CSV file to get automated summary and AI insights."]
    };
  }

  const columns = Object.keys(rows[0] || {});
  const { numeric, textual } = detectColumns(rows);
  const bullets = [
    `Rows: ${rows.length.toLocaleString()}`,
    `Columns: ${columns.length} (${numeric.length} numeric, ${textual.length} categorical/text)`
  ];

  if (numeric[0]) {
    const values = rows.map((row) => toNumber(row[numeric[0]])).filter((n) => !Number.isNaN(n));
    if (values.length) {
      const total = values.reduce((sum, value) => sum + value, 0);
      const avg = total / values.length;
      bullets.push(`Primary metric (${numeric[0]}) total is ${formatNumber(total)}, average is ${formatNumber(avg)}.`);
    }
  }

  if (numeric[0] && textual[0]) {
    const top = aggregateBy(rows, textual[0], numeric[0], "sum", 1)[0];
    if (top) {
      bullets.push(`Top ${textual[0]} by ${numeric[0]}: ${top.name} (${formatNumber(top.value)}).`);
    }
  }

  return {
    title: "Snapshot of your current dataset",
    bullets
  };
}

function parseQuestionFallback(question, rows) {
  const q = question.trim().toLowerCase();
  const { numeric, textual } = detectColumns(rows);
  const metric = numeric[0];
  const group = textual[0];

  if (!rows.length) {
    return {
      insight: "Upload at least one CSV file first.",
      chartType: "bar",
      data: [],
      metricUsed: null,
      groupUsed: null
    };
  }

  if (!metric || !group) {
    return {
      insight: "I need at least one numeric and one categorical column to visualize this question.",
      chartType: "bar",
      data: [],
      metricUsed: metric,
      groupUsed: group
    };
  }

  const topMatch = q.match(/top\s+(\d+)/);
  const requestedTop = topMatch ? Number(topMatch[1]) : 5;

  if (q.includes("top")) {
    return {
      insight: `Top ${requestedTop} ${group} by ${metric}.`,
      chartType: "bar",
      data: aggregateBy(rows, group, metric, "sum", requestedTop),
      metricUsed: metric,
      groupUsed: group
    };
  }

  if (q.includes("trend") || q.includes("monthly") || q.includes("over time")) {
    const dateLikeColumn =
      textual.find((c) => c.toLowerCase().includes("month")) ||
      textual.find((c) => c.toLowerCase().includes("date")) ||
      group;
    return {
      insight: `${metric} trend across ${dateLikeColumn}.`,
      chartType: "line",
      data: sortTrendData(aggregateBy(rows, dateLikeColumn, metric, "sum", 0)),
      metricUsed: metric,
      groupUsed: dateLikeColumn
    };
  }

  if (q.includes("average") || q.includes("avg")) {
    const values = rows.map((row) => toNumber(row[metric])).filter((n) => !Number.isNaN(n));
    const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return {
      insight: `Average ${metric}: ${formatNumber(avg)} from ${values.length} records.`,
      chartType: "bar",
      data: [{ name: `Average ${metric}`, value: Number(avg.toFixed(2)) }],
      metricUsed: metric,
      groupUsed: null
    };
  }

  return {
    insight: `Showing distribution of ${metric} by ${group}.`,
    chartType: "bar",
    data: aggregateBy(rows, group, metric, "sum", 8),
    metricUsed: metric,
    groupUsed: group
  };
}

function applyAiPlan(rows, plan, fallbackAnalysis) {
  const { numeric, textual } = detectColumns(rows);
  const metric = numeric.includes(plan.metric) ? plan.metric : numeric[0] || null;
  const group = textual.includes(plan.groupBy) ? plan.groupBy : textual[0] || null;
  const intent = plan.intent || "distribution";
  const aggregation = plan.aggregation === "avg" ? "avg" : "sum";
  const limit = Number.isFinite(Number(plan.limit)) ? Math.max(1, Number(plan.limit)) : 5;

  if (intent === "insight_only") {
    return {
      ...fallbackAnalysis,
      chartType: fallbackAnalysis?.chartType || "bar"
    };
  }

  if (!metric || !group) {
    return fallbackAnalysis;
  }

  if (intent === "top_n") {
    return {
      insight: `Top ${limit} ${group} by ${metric}.`,
      chartType: plan.chartType || "bar",
      data: aggregateBy(rows, group, metric, aggregation, limit),
      metricUsed: metric,
      groupUsed: group
    };
  }

  if (intent === "trend") {
    return {
      insight: `${metric} trend across ${group}.`,
      chartType: plan.chartType || "line",
      data: sortTrendData(aggregateBy(rows, group, metric, "sum", 0)),
      metricUsed: metric,
      groupUsed: group
    };
  }

  if (intent === "highest") {
    const highest = aggregateBy(rows, group, metric, "sum", 1)[0];
    return {
      insight: highest
        ? `${highest.name} has the highest ${metric} (${formatNumber(highest.value)}).`
        : `No valid values found for ${metric}.`,
      chartType: plan.chartType || "pie",
      data: aggregateBy(rows, group, metric, "sum", 6),
      metricUsed: metric,
      groupUsed: group
    };
  }

  if (intent === "average") {
    return {
      insight: `Average ${metric} by ${group}.`,
      chartType: plan.chartType || "bar",
      data: aggregateBy(rows, group, metric, "avg", 8),
      metricUsed: metric,
      groupUsed: group
    };
  }

  return {
    insight: `Showing distribution of ${metric} by ${group}.`,
    chartType: plan.chartType || "bar",
    data: aggregateBy(rows, group, metric, "sum", 8),
    metricUsed: metric,
    groupUsed: group
  };
}

function DataChart({ chartType, data }) {
  if (!data.length) {
    return <div className="empty">No visualization available yet. Run analysis to generate charts.</div>;
  }

  if (chartType === "table") {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {data.slice(0, 20).map((row, index) => (
              <tr key={`${row.name}-${index}`}>
                <td>{row.name}</td>
                <td>{formatNumber(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (chartType === "line") {
    return (
      <ResponsiveContainer width="100%" height={360}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#d8dde8" />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="value" stroke="#2C7BE5" strokeWidth={3} dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "pie") {
    return (
      <ResponsiveContainer width="100%" height={360}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={115} label>
            {data.map((entry, index) => (
              <Cell key={`${entry.name}-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={360}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#d8dde8" />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Legend />
        <Bar dataKey="value" fill="#0B6E4F" radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function App() {
  const [datasets, setDatasets] = useState([]);
  const [selectedFile, setSelectedFile] = useState("all");
  const [question, setQuestion] = useState("Top 5 products by revenue");
  const [analysis, setAnalysis] = useState(buildOverviewAnalysis([]));
  const [datasetSummary, setDatasetSummary] = useState(buildDatasetSummary([]));
  const [aiNarrative, setAiNarrative] = useState("Ask a question after analysis and your AI answer will appear here.");
  const [aiMeta, setAiMeta] = useState({ modelUsed: null, source: "ready" });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGeneratingOverview, setIsGeneratingOverview] = useState(false);
  const [chartMode, setChartMode] = useState("auto");

  const combinedRows = useMemo(() => {
    if (selectedFile === "all") return datasets.flatMap((set) => set.rows);
    const found = datasets.find((set) => set.id === selectedFile);
    return found ? found.rows : [];
  }, [datasets, selectedFile]);

  const effectiveChartType = chartMode === "auto" ? analysis.chartType : chartMode;

  function onFilesUpload(event) {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;

    Promise.all(
      files.map(
        (file) =>
          new Promise((resolve, reject) => {
            Papa.parse(file, {
              header: true,
              skipEmptyLines: true,
              complete: (result) => {
                resolve({
                  id: `${file.name}-${file.lastModified}`,
                  name: file.name,
                  rows: result.data ?? []
                });
              },
              error: reject
            });
          })
      )
    )
      .then((newData) => {
        setDatasets((prev) => {
          const map = new Map(prev.map((item) => [item.id, item]));
          for (const item of newData) map.set(item.id, item);
          return [...map.values()];
        });
        setAiNarrative("Files uploaded. Click Analyze Uploaded Data to generate your first dashboard view.");
      })
      .catch(() => {
        setAiNarrative("One or more CSV files could not be parsed. Please verify format and headers.");
      });
  }

  function runOverviewAnalysis() {
    setIsGeneratingOverview(true);
    const overview = buildOverviewAnalysis(combinedRows);
    const summary = buildDatasetSummary(combinedRows);
    setAnalysis(overview);
    setDatasetSummary(summary);
    setChartMode("auto");
    setAiMeta({ modelUsed: null, source: "overview" });
    setAiNarrative("Overview generated. Ask a question to let AI dig deeper into this data.");
    setTimeout(() => setIsGeneratingOverview(false), 300);
  }

  async function runAiQuestion() {
    if (!combinedRows.length) {
      setAiNarrative("Please upload CSV files and run overview analysis first.");
      return;
    }

    setIsAnalyzing(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, rows: combinedRows })
      });

      const payload = await response.json();
      if (!response.ok) {
        const detail = payload?.details ? ` ${String(payload.details).slice(0, 220)}` : "";
        throw new Error(`${payload?.error || `AI API error (${response.status})`}.${detail}`.trim());
      }

      const fallback = analysis.data.length ? analysis : buildOverviewAnalysis(combinedRows);
      const aiResult = applyAiPlan(combinedRows, payload.plan || {}, fallback);

      setAnalysis({
        ...aiResult,
        insight: payload.insight || aiResult.insight
      });
      setAiNarrative(payload.answer || payload.insight || "AI responded without additional narrative.");
      setAiMeta({
        modelUsed: payload.modelUsed || "unknown",
        source: String(payload.provider || "ai").toUpperCase()
      });
      setChartMode("auto");
    } catch (error) {
      const fallback = parseQuestionFallback(question, combinedRows);
      setAnalysis(fallback);
      setAiNarrative(
        `AI call failed and local analytics handled your question. ${error?.message || "Please check provider config and key."}`
      );
      setAiMeta({ modelUsed: null, source: "rule-based fallback" });
    } finally {
      setIsAnalyzing(false);
    }
  }

  function exportExcel() {
    const workbook = XLSX.utils.book_new();
    const rowsForExport = combinedRows.length ? combinedRows : [{ message: "No rows loaded" }];
    const resultForExport = analysis.data.length ? analysis.data : [{ message: "No analysis data generated" }];

    const rawSheet = XLSX.utils.json_to_sheet(rowsForExport);
    const resultSheet = XLSX.utils.json_to_sheet(resultForExport);
    const insightSheet = XLSX.utils.json_to_sheet([
      {
        question,
        insight: analysis.insight,
        ai_answer: aiNarrative,
        analysis_source: aiMeta.source,
        model: aiMeta.modelUsed || "n/a"
      }
    ]);

    XLSX.utils.book_append_sheet(workbook, rawSheet, "Raw Data");
    XLSX.utils.book_append_sheet(workbook, resultSheet, "Analysis");
    XLSX.utils.book_append_sheet(workbook, insightSheet, "Insight");

    XLSX.writeFile(workbook, "ai-analysis-export.xlsx");
  }

  function exportPdf() {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("AI Data Analyst Dashboard Export", 14, 15);
    doc.setFontSize(11);
    doc.text(`Question: ${question}`, 14, 24);
    doc.text(`Insight: ${analysis.insight}`, 14, 32, { maxWidth: 180 });
    doc.text(`AI Answer: ${aiNarrative}`, 14, 44, { maxWidth: 180 });
    doc.text(`Rows considered: ${combinedRows.length}`, 14, 60);

    const tableBody = analysis.data.length
      ? analysis.data.map((row) => [String(row.name), formatNumber(row.value)])
      : [["No analysis rows", "-"]];

    autoTable(doc, {
      startY: 66,
      head: [["Label", "Value"]],
      body: tableBody
    });

    doc.save("ai-analysis-export.pdf");
  }

  return (
    <div className="app-shell">
      <div className="orb orb-one" />
      <div className="orb orb-two" />
      <div className="orb orb-three" />

      <main className="app">
        <header className="hero card">
          <h1>AI Data Analyst Dashboard</h1>
          <p>
            Upload CSV files, run instant overview analysis, switch chart formats, and ask natural language
            questions that your AI integration answers over your dataset.
          </p>
        </header>

        <section className="card">
          <div className="controls-row">
            <label className="field">
              <span>Upload CSV Files</span>
              <input type="file" accept=".csv" multiple onChange={onFilesUpload} />
            </label>

            <label className="field">
              <span>Dataset Scope</span>
              <select value={selectedFile} onChange={(e) => setSelectedFile(e.target.value)}>
                <option value="all">All files combined</option>
                {datasets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="field action-field">
              <button onClick={runOverviewAnalysis} disabled={isGeneratingOverview || !combinedRows.length}>
                {isGeneratingOverview ? "Preparing overview..." : "Analyze Uploaded Data"}
              </button>
            </div>
          </div>

          <div className="stats">
            <span>Files loaded: {datasets.length}</span>
            <span>Rows in scope: {combinedRows.length.toLocaleString()}</span>
            <span>Mode: {aiMeta.source}{aiMeta.modelUsed ? ` (${aiMeta.modelUsed})` : ""}</span>
          </div>
        </section>

        <section className="card">
          <h2>Dataset Summary</h2>
          <p className="summary-title">{datasetSummary.title}</p>
          <ul className="summary-list">
            {datasetSummary.bullets.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>Ask AI About Your Data</h2>
          <div className="query-row">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder='Example: "Which category is growing fastest month over month?"'
            />
            <button onClick={runAiQuestion} disabled={isAnalyzing || !combinedRows.length}>
              {isAnalyzing ? "AI analyzing..." : "Ask AI"}
            </button>
          </div>

          <div className="chip-row">
            {QUICK_PROMPTS.map((prompt) => (
              <button key={prompt} className="chip" onClick={() => setQuestion(prompt)}>
                {prompt}
              </button>
            ))}
          </div>

          <p className="ai-answer">{aiNarrative}</p>
        </section>

        <section className="card">
          <div className="result-head">
            <div>
              <h2>Insights and Visualization</h2>
              <p className="insight">{analysis.insight}</p>
            </div>
            <div className="actions">
              <button onClick={exportPdf}>Export PDF</button>
              <button onClick={exportExcel}>Export Excel</button>
            </div>
          </div>

          <div className="chart-toggle">
            {["auto", "bar", "line", "pie", "table"].map((option) => (
              <button
                key={option}
                className={chartMode === option ? "chip active" : "chip"}
                onClick={() => setChartMode(option)}
                disabled={!analysis.data.length}
              >
                {option === "auto" ? "Auto" : option.charAt(0).toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>

          <DataChart chartType={effectiveChartType} data={analysis.data} />
        </section>
      </main>
    </div>
  );
}
