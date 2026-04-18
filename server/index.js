import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json({ limit: "8mb" }));

function toNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function detectColumns(rows) {
  if (!rows.length) return { numeric: [], textual: [] };
  const columns = Object.keys(rows[0]);
  const numeric = columns.filter((col) => {
    let numericCount = 0;
    let sampled = 0;
    for (const row of rows) {
      if (sampled >= 50) break;
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

function buildColumnProfiles(rows) {
  if (!rows.length) return [];
  const columns = Object.keys(rows[0]);
  return columns.map((name) => {
    const values = [];
    let nonEmpty = 0;
    let numericCount = 0;
    for (const row of rows) {
      const value = row[name];
      if (value === "" || value === null || value === undefined) continue;
      nonEmpty += 1;
      if (values.length < 5) values.push(String(value));
      if (!Number.isNaN(toNumber(value))) numericCount += 1;
    }
    const numericRatio = nonEmpty ? numericCount / nonEmpty : 0;
    return {
      name,
      nonEmptyCount: nonEmpty,
      numericRatio: Number(numericRatio.toFixed(3)),
      sampleValues: values
    };
  });
}

function tryParseJson(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizePlan(rawPlan, rows) {
  const { numeric, textual } = detectColumns(rows);
  const plan = rawPlan && typeof rawPlan === "object" ? rawPlan : {};
  const intent = ["top_n", "trend", "highest", "average", "distribution", "insight_only"].includes(plan.intent)
    ? plan.intent
    : "distribution";
  const aggregation = ["sum", "avg", "max"].includes(plan.aggregation) ? plan.aggregation : "sum";
  const candidateGroup = typeof plan.groupBy === "string" ? plan.groupBy : textual[0] || null;
  const candidateMetric = typeof plan.metric === "string" ? plan.metric : numeric[0] || null;
  const groupBy = textual.includes(candidateGroup) ? candidateGroup : textual[0] || null;
  const metric = numeric.includes(candidateMetric) ? candidateMetric : numeric[0] || null;
  const limitValue = Number(plan.limit);
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(Math.floor(limitValue), 50) : 5;
  const chartType =
    plan.chartType === "line" || plan.chartType === "pie" || plan.chartType === "bar" ? plan.chartType : null;

  return {
    intent,
    groupBy,
    metric,
    aggregation,
    limit,
    chartType
  };
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => part?.text || "").join("");
}

async function callGeminiOnce({ baseUrl, model, apiKey, systemPrompt, userPayload, forceTextMode = false }) {
  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(userPayload) }] }],
    generationConfig: {
      temperature: 0.1
    }
  };

  if (!forceTextMode) {
    requestBody.generationConfig.responseMimeType = "application/json";
  }

  const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    data
  };
}

async function callGeminiWithFallback({ baseUrl, apiKey, preferredModel, systemPrompt, userPayload }) {
  const modelCandidates = [preferredModel, "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"].filter(Boolean);
  const uniqueModels = [...new Set(modelCandidates)];
  let lastFailure = null;

  for (const candidateModel of uniqueModels) {
    const firstTry = await callGeminiOnce({
      baseUrl,
      model: candidateModel,
      apiKey,
      systemPrompt,
      userPayload,
      forceTextMode: false
    });

    if (firstTry.ok) {
      return {
        model: candidateModel,
        content: extractGeminiText(firstTry.data)
      };
    }

    const messageBlob = `${firstTry.text || ""}`.toLowerCase();
    const shouldRetryWithoutJsonMode =
      firstTry.status === 400 &&
      (messageBlob.includes("responsemimetype") ||
        messageBlob.includes("response_mime_type") ||
        messageBlob.includes("invalid argument"));

    if (shouldRetryWithoutJsonMode) {
      const secondTry = await callGeminiOnce({
        baseUrl,
        model: candidateModel,
        apiKey,
        systemPrompt,
        userPayload,
        forceTextMode: true
      });

      if (secondTry.ok) {
        return {
          model: candidateModel,
          content: extractGeminiText(secondTry.data)
        };
      }
      lastFailure = secondTry;
      continue;
    }

    lastFailure = firstTry;
  }

  if (lastFailure?.status === 404) {
    try {
      const modelListResponse = await fetch(`${baseUrl}/models?key=${apiKey}`);
      if (modelListResponse.ok) {
        const modelListData = await modelListResponse.json();
        const dynamicModels = (modelListData?.models || [])
          .filter((model) => Array.isArray(model?.supportedGenerationMethods))
          .filter((model) => model.supportedGenerationMethods.includes("generateContent"))
          .map((model) => String(model?.name || "").replace(/^models\//, ""))
          .filter(Boolean)
          .sort((a, b) => {
            const score = (name) => {
              if (name.includes("flash")) return 0;
              if (name.includes("pro")) return 1;
              return 2;
            };
            return score(a) - score(b);
          })
          .slice(0, 8);

        for (const dynamicModel of dynamicModels) {
          const dynamicTry = await callGeminiOnce({
            baseUrl,
            model: dynamicModel,
            apiKey,
            systemPrompt,
            userPayload,
            forceTextMode: false
          });

          if (dynamicTry.ok) {
            return {
              model: dynamicModel,
              content: extractGeminiText(dynamicTry.data)
            };
          }

          lastFailure = dynamicTry;
        }
      }
    } catch (error) {
      lastFailure = {
        status: 500,
        text: `Model discovery failed: ${String(error)}`
      };
    }
  }

  return {
    model: preferredModel,
    error: lastFailure || {
      status: 500,
      text: "Unknown Gemini error."
    }
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/analyze", async (req, res) => {
  const { question, rows } = req.body ?? {};

  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Question is required." });
  }
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: "Rows must be an array." });
  }

  const provider = String(process.env.AI_PROVIDER || "gemini").trim().toLowerCase();
  const sampleRows = rows.slice(0, 80);
  const profiles = buildColumnProfiles(rows);

  const systemPrompt = [
    "You convert natural language analytics requests into a strict JSON query plan.",
    "Never include SQL. Return only valid JSON.",
    "Allowed intents: top_n, trend, highest, average, distribution, insight_only.",
    "Allowed aggregations: sum, avg, max.",
    "Choose groupBy from textual/categorical columns and metric from numeric columns.",
    "If user asks top N, set intent=top_n and limit correctly.",
    "If the question is descriptive and doesn't need a chart, set intent=insight_only and chartType=null."
  ].join(" ");

  const userPayload = {
    question,
    columnProfiles: profiles,
    sampleRows,
    outputFormat: {
      plan: {
        intent: "top_n|trend|highest|average|distribution|insight_only",
        groupBy: "string|null",
        metric: "string|null",
        aggregation: "sum|avg|max",
        limit: "number",
        chartType: "bar|line|pie|null"
      },
      insight: "short user-facing chart insight sentence",
      answer: "concise natural language answer to the user's question"
    }
  };

  try {
    let model = "";
    let content = "";

    if (provider === "openai") {
      const openAiApiKey = process.env.OPENAI_API_KEY;
      if (!openAiApiKey) {
        return res.status(500).json({
          error: "Server is missing OPENAI_API_KEY. Add it to your .env file."
        });
      }

      model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
      const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
      const aiResponse = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiApiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(userPayload) }
          ]
        })
      });

      if (!aiResponse.ok) {
        const text = await aiResponse.text();
        return res.status(502).json({
          error: `OpenAI request failed (${aiResponse.status}).`,
          details: text.slice(0, 400)
        });
      }

      const data = await aiResponse.json();
      content = data?.choices?.[0]?.message?.content || "";
    } else if (provider === "gemini") {
      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        return res.status(500).json({
          error: "Server is missing GEMINI_API_KEY. Add it to your .env file."
        });
      }

      model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
      const baseUrl = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(
        /\/$/,
        ""
      );
      const geminiResult = await callGeminiWithFallback({
        baseUrl,
        apiKey: geminiApiKey,
        preferredModel: model,
        systemPrompt,
        userPayload
      });

      if (geminiResult.error) {
        return res.status(502).json({
          error: `Gemini request failed (${geminiResult.error.status}).`,
          details: String(geminiResult.error.text || "").slice(0, 600)
        });
      }

      model = geminiResult.model;
      content = geminiResult.content || "";
    } else {
      return res.status(500).json({
        error: `Unsupported AI_PROVIDER value: ${provider}. Use 'gemini' or 'openai'.`
      });
    }

    const parsed = tryParseJson(content);
    if (!parsed) {
      return res.status(502).json({
        error: "Could not parse AI response as JSON."
      });
    }

    const normalizedPlan = normalizePlan(parsed.plan ?? parsed, rows);
    const insight =
      typeof parsed.insight === "string" && parsed.insight.trim()
        ? parsed.insight.trim()
        : `Query interpreted as ${normalizedPlan.intent}.`;

    return res.json({
      plan: normalizedPlan,
      insight,
      answer:
        typeof parsed.answer === "string" && parsed.answer.trim()
          ? parsed.answer.trim()
          : insight,
      modelUsed: model,
      provider
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected server error during AI analysis.",
      details: String(error)
    });
  }
});

app.listen(port, () => {
  console.log(`AI API server running on http://localhost:${port}`);
});
