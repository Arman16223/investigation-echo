# NEXUS Intel

Build "NEXUS" — an autonomous competitive intelligence agent that uses a ReAct (Reason-Act-Observe) loop to investigate a company/topic and produce an intelligence report.

What it does

The user fills in a form (Target company, Competitors, Topic, Investigation Goal) and clicks "Run Investigation." An AI agent then runs an autonomous loop:

Look at everything gathered so far.

Decide the next best action: call ONE of four search tools, or finish.

If a tool is chosen, run it, save the results as evidence, and go back to step 1.

Stop when there's enough evidence OR 8 steps have been taken.

Generate a final structured intelligence report from all the evidence collected.

The frontend shows this happening live, step by step, as it runs — not just a spinner and a final answer.

Backend logic (implement as a Supabase Edge Function)

Create an edge function (e.g. investigate) that:

Accepts POST body: { goal: string, target: string, competitors: string[], topic: string }

Maintains an in-memory state object for the run: { goal, target, competitors, topic, step_count (start 0, max 8), actions_taken: [], observations: [], sources: [], task_complete: false, confidence: 0 }

Runs a loop (max 8 iterations) where each iteration:

Builds a compact JSON summary of current state (goal, target, competitors, topic, step number, last 5 actions, last 4 observations, source count) and sends it to an LLM with a system prompt instructing it to act as "NEXUS, an autonomous competitive intelligence agent" running a ReAct loop, and to respond ONLY with strict JSON — no markdown, no code fences — in one of two shapes:

Tool call: {"action":"tool","tool":"search_news"|"search_research"|"search_patents"|"search_competitor_activity","query":"...","decision_summary":"short public explanation"}

Finish: {"action":"final","decision_summary":"short public explanation","confidence": 0-100}

Parse the JSON response (strip accidental ``` fences defensively before parsing). If parsing fails or the action/tool is invalid, log an error trace event and stop the loop gracefully rather than crashing.

If action is final: mark complete, store confidence, break.

If action is tool: execute the corresponding search function (see Tools below) with the LLM's query, append results to sources, append a compact observation (title/url/first 500 chars of content per result) to observations, and continue the loop.

After the loop ends (finished or hit max steps), call the LLM once more with all collected sources to generate a final report as plain text with these exact section headers, each on its own line:

EXECUTIVE SUMMARYKEY FINDINGSCOMPETITIVE IMPACTPRIORITY (LOW, MEDIUM, or HIGH)RECOMMENDED ACTIONSCONFIDENCESOURCES


Instruct the LLM: only use information supported by the evidence, never invent facts, distinguish uncertain findings, keep it concise, no chain-of-thought exposed.

Return the full trace (list of step events: {step, type: "decision"|"observation"|"error", message, tool?, query?, result_count?, status}), the final report text, total steps taken, and final confidence.

Stream progress to the frontend via Server-Sent Events (or return the full result at once if streaming isn't practical in edge functions — frontend should handle both, see below).

Tools (all backed by the Tavily Search API — https://api.tavily.com)

Implement four thin wrapper functions, each calling Tavily's /search endpoint with search_depth: "basic", max_results: 5, and returning cleaned {title, url, content} objects:

search_news(query) — general search, no domain restriction.

search_research(query) — restrict include_domains to ["arxiv.org","nature.com","science.org","research.google","ai.google","openreview.net"].

search_patents(query) — append "patents patent filing intellectual property" to the query, restrict include_domains to ["patents.google.com"].

search_competitor_activity(query) — general search, no domain restriction.

Use TAVILY_API_KEY from Supabase secrets. Use Google Gemini (model gemini-2.5-flash) for the LLM calls via the Gemini API, using GEMINI_API_KEY from Supabase secrets — or use the built-in Lovable AI Gateway with an equivalent Gemini-family model if that's simpler to wire up; either is fine as long as JSON-mode instructions are followed reliably.

Frontend (React)

Dark, dense "command center" aesthetic — dark navy/black background, a bright accent color (e.g. electric blue or violet) for buttons/highlights, monospace or technical-feeling headers for panel titles, small-caps labels. Not generic SaaS-pastel; should feel like a security/intel ops dashboard.

Header: "NEXUS" wordmark + "AUTONOMOUS COMPETITIVE INTELLIGENCE" subtitle, plus a status pill on the right that says "SYSTEM READY" normally and "AGENT ACTIVE" (with a pulsing dot) while a run is in progress.

Left panel — Investigation form:

Text input: Target (placeholder "Target company")

Text input: Competitors (comma-separated, placeholder "AMD, Google, Microsoft")

Text input: Topic (placeholder "Generative AI")

Textarea: Investigation Goal

Button: "RUN INVESTIGATION" (disabled + relabeled "NEXUS INVESTIGATING..." while running)

Right panel — Live Agent Activity:

Header showing a live step counter ("N STEPS")

Empty state: "NEXUS is ready to investigate."

Loading state (before first event arrives): pulsing dot + "Initializing autonomous investigation..."

As trace events arrive, render each as a card showing: step number, event type badge (DECISION / OBSERVATION / ERROR), the message, and if present the tool name and query used, and result count. New cards append in order, most recent at the bottom, auto-scrolling into view.

Bottom panel — Intelligence Report (appears only once the run finishes):

Header with "INTELLIGENCE REPORT" title and a confidence badge ("N% CONFIDENCE")

Render the report text with the section headers (EXECUTIVE SUMMARY, KEY FINDINGS, etc.) styled as bold subheadings and the rest as normal paragraphs/line breaks.

Networking: call the edge function, handle the response whether it streams (SSE, parse data: {...} lines, stop on [DONE]) or returns all at once (render the whole trace immediately then show the report) — code defensively for both. On any fetch failure, show a clear error state in the activity panel instead of failing silently, including the actual error message so it's debuggable.

Non-negotiables / bug-proofing

Never crash the whole run on a single bad LLM response or a single failed search call — log it as an error trace event and either continue (for a failed tool) or stop gracefully (for unparseable decisions), always still attempting to produce whatever report is possible from evidence gathered so far.

Never invent search results or report content not grounded in what the tools actually returned.

Store TAVILY_API_KEY and GEMINI_API_KEY (or Lovable AI Gateway equivalent) as backend secrets — never expose them in frontend code or commit them to the repo.

Make sure the "RUN INVESTIGATION" button is disabled while a run is in progress so users can't fire overlapping requests.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/bf7df4ff-a36d-49ee-a023-7cc12fe6b43e).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
