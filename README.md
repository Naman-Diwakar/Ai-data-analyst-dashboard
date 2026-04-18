# AI Data Analyst Dashboard

Web dashboard for CSV analytics with AI Q&A, chart exploration, animated UI, and export support.

## Features

- Multi-file CSV upload (`multiple` file picker)
- Dataset scope selection:
  - Analyze all uploaded files combined
  - Analyze a single selected file
- One-click overview analysis after upload (`Analyze Uploaded Data`)
- AI-powered question answering over your CSV data (Gemini/OpenAI, server-side key)
- Automatic summary of what your dataset is about
- Chart rendering with chart-mode switcher:
  - Auto
  - Bar
  - Line
  - Pie
  - Table
- Export:
  - PDF (`jsPDF` + table)
  - Excel (`xlsx` workbook with raw data + analysis + insight)

## Setup (Required for AI)

1. Copy `.env.example` to `.env`
2. Add your key and model.

For Gemini (recommended):

```bash
AI_PROVIDER=gemini
GEMINI_API_KEY=your_real_gemini_key_here
GEMINI_MODEL=gemini-2.5-flash
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
PORT=8787
```

For OpenAI (optional alternative):

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=your_real_openai_key_here
OPENAI_MODEL=gpt-4.1-mini
OPENAI_BASE_URL=https://api.openai.com/v1
PORT=8787
```

## Run Locally

```bash
npm install
npm run dev:full
```

`dev:full` starts:
- API server: `http://localhost:8787`
- Frontend (Vite): default local Vite URL

If AI is unavailable (no key/network issue), app falls back to local rule-based parsing.

## Recommended User Flow

1. Upload one or more CSV files.
2. Click `Analyze Uploaded Data` to generate the first summary + chart.
3. Ask any data question in plain English (for example: top performers, trends, comparisons).
4. Switch chart format using the chart mode buttons.
5. Export the result as PDF or Excel.

