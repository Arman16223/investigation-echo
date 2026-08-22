/**
 * NEXUS — autonomous competitive intelligence agent (ReAct loop).
 * Server-only module: reads TAVILY_API_KEY / LOVABLE_API_KEY inside functions.
 */

export type SourceResult = { title: string; url: string; content: string };

/** Agents participating in an investigation run. */
export type AgentName = "Orchestrator" | "Research" | "Memory" | "Analyst";

/**
 * Phase of the ReAct loop an event belongs to. Used by the UI to render the
 * THINK/DECIDE -> TOOL SELECTION -> EXECUTION -> OBSERVATION -> NEXT DECISION
 * -> COMPLETION sequence. These are action-level labels only: no private
 * chain-of-thought, prompts or provider payloads are ever emitted.
 */
export type TracePhase =
  | "recall"
  | "decide"
  | "select"
  | "execute"
  | "observe"
  | "handoff"
  | "compress"
  | "store"
  | "synthesize"
  | "complete";

export type TraceEvent = {
  step: number;
  type: "decision" | "observation" | "error" | "memory";
  message: string;
  tool?: string;
  query?: string;
  result_count?: number;
  status?: string;
  /** Additive demo/trace metadata (existing fields above are unchanged). */
  agent?: AgentName;
  phase?: TracePhase;
  provider?: string;
  from_agent?: AgentName;
  to_agent?: AgentName;
  handoff?: string;
};


export type PriorInvestigation = {
  target: string;
  topic: string | null;
  summary: string;
  confidence: number | null;
  created_at: string;
};


export type NexusInput = {
  goal: string;
  target: string;
  competitors: string[];
  topic: string;
};

const MAX_STEPS = 8;
const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

const TOOL_NAMES = [
  "search_news",
  "search_research",
  "search_patents",
  "search_competitor_activity",
  "search_hacker_news",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

/** Human-readable tool + provider labels shown in the UI trace. */
export const TOOL_LABELS: Record<ToolName, { label: string; provider: string }> = {
  search_news: { label: "Tavily Web Search (news)", provider: "Tavily" },
  search_research: { label: "Tavily Web Search (research)", provider: "Tavily" },
  search_patents: { label: "Tavily Web Search (patents)", provider: "Tavily" },
  search_competitor_activity: {
    label: "Tavily Web Search (competitor activity)",
    provider: "Tavily",
  },
  search_hacker_news: {
    label: "Hacker News Search",
    provider: "Hacker News Algolia",
  },
};

// ============================================================
// TAVILY TOOLS
// ============================================================

async function tavilySearch(
  query: string,
  domains?: string[],
): Promise<SourceResult[]> {
  const apiKey = process.env["TAVILY_API_KEY"];
  if (!apiKey) throw new Error("Tavily is not configured for this deployment.");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 5,
      ...(domains ? { include_domains: domains } : {}),
    }),
  });

  if (!res.ok) {
    // Never surface the raw provider body — status only.
    throw new Error(`Tavily search failed (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as { results?: unknown };
  const results = Array.isArray(data.results) ? data.results : [];

  return results.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      title: typeof r["title"] === "string" ? r["title"] : "",
      url: typeof r["url"] === "string" ? r["url"] : "",
      content: typeof r["content"] === "string" ? r["content"] : "",
    };
  });
}

// ============================================================
// HACKER NEWS (Algolia) TOOL — public API, no credentials
// ============================================================

async function hackerNewsSearch(query: string): Promise<SourceResult[]> {
  const url = `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=5&query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Hacker News search failed (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as { hits?: unknown };
  const hits = Array.isArray(data.hits) ? data.hits : [];

  return hits.map((item) => {
    const h = item as Record<string, unknown>;
    const title = typeof h["title"] === "string" ? h["title"] : "";
    const objectId = typeof h["objectID"] === "string" ? h["objectID"] : "";
    const points = typeof h["points"] === "number" ? h["points"] : 0;
    const comments = typeof h["num_comments"] === "number" ? h["num_comments"] : 0;
    const storyText = typeof h["story_text"] === "string" ? h["story_text"] : "";
    return {
      title,
      url:
        typeof h["url"] === "string" && h["url"]
          ? h["url"]
          : `https://news.ycombinator.com/item?id=${objectId}`,
      content:
        `Hacker News discussion: ${points} points, ${comments} comments. ${storyText}`
          .trim()
          .slice(0, 800),
    };
  });
}

const TOOLS: Record<ToolName, (query: string) => Promise<SourceResult[]>> = {
  search_news: (q) => tavilySearch(q),
  search_research: (q) =>
    tavilySearch(q, [
      "arxiv.org",
      "nature.com",
      "science.org",
      "research.google",
      "ai.google",
      "openreview.net",
    ]),
  search_patents: (q) =>
    tavilySearch(`${q} patents patent filing intellectual property`, [
      "patents.google.com",
    ]),
  search_competitor_activity: (q) => tavilySearch(q),
  search_hacker_news: (q) => hackerNewsSearch(q),
};


// ============================================================
// LLM
// ============================================================

async function callLLM(prompt: string): Promise<string> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured.");

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 429)
      throw new Error("AI rate limit reached. Please retry in a moment.");
    if (res.status === 402)
      throw new Error(
        "AI credits exhausted for this workspace. Add credits to continue.",
      );
    throw new Error(`AI request failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error("The model returned an empty response.");
  return text;
}

function cleanJsonResponse(text: string): string {
  let out = text.trim();
  if (out.startsWith("```")) {
    const lines = out.split("\n");
    if (lines[0]?.startsWith("```")) lines.shift();
    if (lines[lines.length - 1]?.trim() === "```") lines.pop();
    out = lines.join("\n").trim();
  }
  return out;
}

const SYSTEM_PROMPT = `You are NEXUS, an autonomous competitive intelligence agent.

Your job is to investigate a user's question by gathering evidence from multiple
information sources and producing actionable intelligence.

You operate using a ReAct-style loop:
1. Examine the current investigation state.
2. Decide the best NEXT ACTION.
3. Select exactly ONE available tool OR finish.
4. Observe the tool result.
5. Re-evaluate the evidence.
6. Continue if more evidence is needed, finish when sufficient evidence exists.

AVAILABLE TOOLS:
- search_news: recent news and industry developments.
- search_research: scientific and technical research.
- search_patents: patent-related information.
- search_competitor_activity: competitor announcements and strategic activity.
- search_hacker_news: practitioner and developer-community signal from Hacker News.

IMPORTANT RULES:
- Do NOT blindly call every tool. Choose tools based on the current evidence.
- If evidence conflicts, perform another search to verify it.
- Never invent sources or facts.
- Do not expose private chain-of-thought; return only a concise public summary.
- You MUST respond with valid JSON only. No markdown. No code fences.

For a tool action return:
{"action":"tool","tool":"search_news","query":"specific search query","decision_summary":"Short public explanation of why this action is needed."}

For finishing return:
{"action":"final","decision_summary":"Short public explanation of why the evidence is sufficient.","confidence":85}

The "tool" field must be exactly one of: search_news, search_research, search_patents, search_competitor_activity, search_hacker_news.`;

// ============================================================
// LONG-TERM MEMORY (persistent store)
// ============================================================

async function loadPriorInvestigations(target: string): Promise<PriorInvestigation[]> {
  if (!target) return [];
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("investigation_history")
    .select("target, topic, summary, confidence, created_at")
    .ilike("target", target)
    .order("created_at", { ascending: false })
    .limit(3);
  if (error) throw new Error(error.message);
  return (data ?? []) as PriorInvestigation[];
}

async function savePriorInvestigation(row: {
  target: string;
  topic: string;
  summary: string;
  confidence: number;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("investigation_history").insert({
    target: row.target || "Unspecified",
    topic: row.topic,
    summary: row.summary,
    confidence: row.confidence,
  });
  if (error) throw new Error(error.message);
}

function formatPriorInvestigations(history: PriorInvestigation[]): string {
  if (!history.length) return "";
  const lines = history.map((h) => {
    const date = new Date(h.created_at).toISOString().slice(0, 10);
    return `- [${date}] (confidence ${h.confidence ?? "n/a"}%) ${h.summary}`;
  });
  return `PRIOR INVESTIGATIONS ON THIS TARGET:\n${lines.join("\n")}\n\nUse these as background. Note in the final report whether anything has changed since then.`;
}

// ============================================================
// SHORT-TERM MEMORY (context window management)
// ============================================================

const FULL_DETAIL_STEPS = 3;
const FULL_DETAIL_STEPS_COMPRESSED = 2;
const COMPRESS_AFTER_STEP = 5;

type AgentAction = { step: number; tool: string; query: string };
type AgentObservation = {
  step: number;
  tool: string;
  observation: string;
  result_count: number;
};

function condenseStep(action: AgentAction, obs?: AgentObservation): string {
  const count = obs ? obs.result_count : 0;
  return `Step ${action.step}: used ${action.tool} for "${action.query}", found ${count} results`;
}

async function compressWorkingMemory(state: {
  goal: string;
  target: string;
  topic: string;
  working_memory: string;
  observations: AgentObservation[];
}): Promise<string> {
  const evidence = state.observations
    .map((o) => `Step ${o.step} (${o.tool}):\n${o.observation.slice(0, 1200)}`)
    .join("\n\n");

  const prompt = `Compress the state of an ongoing intelligence investigation into a short
"working memory" note of 3-5 sentences.

GOAL: ${state.goal}
TARGET: ${state.target}
TOPIC: ${state.topic}

${state.working_memory ? `PREVIOUS WORKING MEMORY:\n${state.working_memory}\n` : ""}
EVIDENCE GATHERED SO FAR:
${evidence || "(none)"}

Cover: what has been established, what is still uncertain, and what has not been
checked yet. Plain text only, no markdown, no headers, no invented facts.`;

  return (await callLLM(prompt)).trim();
}

// ============================================================
// AGENT LOOP
// ============================================================

/** Machine-readable summary of what this run actually used. */
export type RunArchitecture = {
  agents: AgentName[];
  tools_used: Array<{
    tool: string;
    label: string;
    provider: string;
    calls: number;
    successes: number;
    failures: number;
    results: number;
  }>;
  providers: string[];
  memory: { working_memory_used: boolean; history_recalled: number; stored: boolean };
  reasoning: string;
};

export type NexusResult = {
  report: string;
  trace: TraceEvent[];
  steps: number;
  confidence: number;
  working_memory: string;
  architecture?: RunArchitecture;
};

export async function* runNexus(
  input: NexusInput,
): AsyncGenerator<
  | { type: "trace"; event: TraceEvent }
  | { type: "memory"; working_memory: string }
  | { type: "result"; result: NexusResult },
  void,
  unknown
> {
  const state = {
    goal: input.goal,
    target: input.target,
    competitors: input.competitors,
    topic: input.topic,
    step_count: 0,
    actions_taken: [] as AgentAction[],
    observations: [] as AgentObservation[],
    sources: [] as SourceResult[],
    task_complete: false,
    confidence: 0,
    working_memory: "",
  };

  const toolStats = new Map<
    string,
    { calls: number; successes: number; failures: number; results: number }
  >();
  const bumpTool = (
    tool: ToolName,
    patch: Partial<{ calls: number; successes: number; failures: number; results: number }>,
  ) => {
    const cur =
      toolStats.get(tool) ?? { calls: 0, successes: 0, failures: 0, results: 0 };
    toolStats.set(tool, {
      calls: cur.calls + (patch.calls ?? 0),
      successes: cur.successes + (patch.successes ?? 0),
      failures: cur.failures + (patch.failures ?? 0),
      results: cur.results + (patch.results ?? 0),
    });
  };
  let historyRecalled = 0;
  let memoryStored = false;

  const trace: TraceEvent[] = [];
  const emit = (event: TraceEvent) => {
    trace.push(event);
    return { type: "trace" as const, event };
  };

  yield emit({
    step: 0,
    type: "decision",
    agent: "Orchestrator",
    phase: "handoff",
    from_agent: "Orchestrator",
    to_agent: "Memory",
    handoff: `Investigation target "${state.target || "unspecified"}" for memory lookup`,
    message: "Orchestrator asked the Memory agent for prior investigation context.",
    status: "running",
  });

  // ---- long-term memory: recall ----
  let priorContext = "";
  try {
    const history = await loadPriorInvestigations(state.target);
    historyRecalled = history.length;
    if (history.length) {
      priorContext = formatPriorInvestigations(history);
      const latest = history[0];
      yield emit({
        step: 0,
        type: "memory",
        agent: "Memory",
        phase: "recall",
        message: `Recalled previous investigation context — ${history.length} prior investigation${history.length > 1 ? "s" : ""} on ${state.target}. Most recent (${new Date(latest!.created_at).toISOString().slice(0, 10)}): ${latest!.summary.slice(0, 220)}`,
        status: "recalled",
        from_agent: "Memory",
        to_agent: "Orchestrator",
        handoff: "Prior investigation summaries passed back as background context",
      });
    } else {
      yield emit({
        step: 0,
        type: "memory",
        agent: "Memory",
        phase: "recall",
        message: "No prior investigation history found for this target — starting fresh.",
        status: "empty",
        from_agent: "Memory",
        to_agent: "Orchestrator",
        handoff: "Empty memory result",
      });
    }
  } catch {
    yield emit({
      step: 0,
      type: "error",
      agent: "Memory",
      phase: "recall",
      message: "Long-term memory unavailable — continuing without prior context.",
      status: "error",
    });
  }


  while (!state.task_complete && state.step_count < MAX_STEPS) {
    state.step_count += 1;

    // ---- short-term memory: compress history once past COMPRESS_AFTER_STEP ----
    if (state.step_count > COMPRESS_AFTER_STEP && state.observations.length) {
      try {
        state.working_memory = await compressWorkingMemory(state);
        yield emit({
          step: state.step_count,
          type: "memory",
          agent: "Memory",
          phase: "compress",
          message: `Working context compressed — ${state.observations.length} steps of evidence condensed into a short working memory note.`,
          status: "compressed",
          from_agent: "Memory",
          to_agent: "Orchestrator",
          handoff: "Compressed working memory passed back to the reasoning loop",
        });
        yield { type: "memory", working_memory: state.working_memory };
      } catch {
        yield emit({
          step: state.step_count,
          type: "error",
          agent: "Memory",
          phase: "compress",
          message: "Memory compression unavailable — continuing with full recent history.",
          status: "error",
        });
      }
    }


    const detailCount = state.working_memory
      ? FULL_DETAIL_STEPS_COMPRESSED
      : FULL_DETAIL_STEPS;
    const recentActions = state.actions_taken.slice(-detailCount);
    const recentSteps = new Set(recentActions.map((a) => a.step));
    const olderSummary = state.actions_taken
      .filter((a) => !recentSteps.has(a.step))
      .map((a) => condenseStep(a, state.observations.find((o) => o.step === a.step)));

    const context = JSON.stringify(
      {
        goal: state.goal,
        target: state.target,
        competitors: state.competitors,
        topic: state.topic,
        step: state.step_count,
        max_steps: MAX_STEPS,
        working_memory: state.working_memory || undefined,
        earlier_steps_summary: olderSummary,
        recent_actions: recentActions,
        recent_observations: state.observations.filter((o) => recentSteps.has(o.step)),
        sources_found: state.sources.length,
      },
      null,
      2,
    );


    yield emit({
      step: state.step_count,
      type: "decision",
      agent: "Orchestrator",
      phase: "decide",
      message:
        state.step_count === 1
          ? "Reviewing the goal and available sources to decide the first action."
          : `Reviewing ${state.sources.length} gathered source${state.sources.length === 1 ? "" : "s"} to decide whether more research is needed.`,
      status: "running",
    });

    let decision: Record<string, unknown>;
    try {
      const raw = await callLLM(
        `${SYSTEM_PROMPT}\n\n${priorContext ? `${priorContext}\n\n` : ""}CURRENT INVESTIGATION STATE:\n\n${context}\n\nDecide the next best action.\n\nRemember:\n- Select ONE tool OR finish.\n- Do not repeat an identical search unless verification is necessary.\n- Prefer information that increases confidence in the final answer.`,
      );

      const parsed: unknown = JSON.parse(cleanJsonResponse(raw));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Model response was not a JSON object.");
      }
      decision = parsed as Record<string, unknown>;
    } catch (e) {
      yield emit({
        step: state.step_count,
        type: "error",
        agent: "Orchestrator",
        phase: "decide",
        message: e instanceof Error ? e.message : String(e),
        status: "error",
      });
      break;
    }

    const rawAction = decision["action"];
    // Tolerate models that put the tool name directly in "action".
    const action =
      typeof rawAction === "string" && TOOL_NAMES.includes(rawAction as ToolName)
        ? ((decision["tool"] = decision["tool"] ?? rawAction), "tool")
        : rawAction;

    const decisionSummary =
      typeof decision["decision_summary"] === "string"
        ? decision["decision_summary"]
        : "Agent selected the next action.";

    if (action === "final") {
      state.task_complete = true;
      const conf = Number(decision["confidence"]);
      state.confidence = Number.isFinite(conf) ? Math.round(conf) : 75;
      yield emit({
        step: state.step_count,
        type: "decision",
        agent: "Orchestrator",
        phase: "handoff",
        from_agent: "Research",
        to_agent: "Analyst",
        handoff: `${state.sources.length} collected source${state.sources.length === 1 ? "" : "s"} across ${state.actions_taken.length} tool call${state.actions_taken.length === 1 ? "" : "s"}`,
        message: `Evidence judged sufficient — passing research results to the Analyst agent. ${decisionSummary}`,
        status: "complete",
      });
      break;
    }

    if (action !== "tool") {
      yield emit({
        step: state.step_count,
        type: "error",
        agent: "Orchestrator",
        phase: "decide",
        message: `Invalid action selected: ${String(action)}`,
        status: "error",
      });
      break;
    }

    const toolName = decision["tool"];
    const query = typeof decision["query"] === "string" ? decision["query"] : "";

    if (typeof toolName !== "string" || !TOOL_NAMES.includes(toolName as ToolName)) {
      yield emit({
        step: state.step_count,
        type: "error",
        agent: "Orchestrator",
        phase: "select",
        message: `Invalid tool selected: ${String(toolName)}`,
        status: "error",
      });
      break;
    }

    if (!query) {
      yield emit({
        step: state.step_count,
        type: "error",
        agent: "Orchestrator",
        phase: "select",
        message: "Agent selected a tool without a query.",
        status: "error",
      });
      break;
    }

    const meta = TOOL_LABELS[toolName as ToolName];

    state.actions_taken.push({ step: state.step_count, tool: toolName, query });
    yield emit({
      step: state.step_count,
      type: "decision",
      agent: "Orchestrator",
      phase: "select",
      tool: toolName,
      provider: meta.provider,
      query,
      from_agent: "Orchestrator",
      to_agent: "Research",
      handoff: `Search query: "${query}"`,
      message: `Selected ${meta.label}. ${decisionSummary}`,
      status: "running",
    });

    bumpTool(toolName as ToolName, { calls: 1 });

    yield emit({
      step: state.step_count,
      type: "decision",
      agent: "Research",
      phase: "execute",
      tool: toolName,
      provider: meta.provider,
      query,
      message: `Executing ${meta.label}…`,
      status: "running",
    });

    let results: SourceResult[];
    try {
      results = (await TOOLS[toolName as ToolName](query)) ?? [];
    } catch (e) {
      // Safe, sanitized failure: never surface raw provider responses or keys.
      const safeReason = e instanceof Error ? e.message : "Unknown provider error.";
      state.observations.push({
        step: state.step_count,
        tool: toolName,
        observation: `Tool failed: ${safeReason}`,
        result_count: 0,
      });
      bumpTool(toolName as ToolName, { failures: 1 });

      yield emit({
        step: state.step_count,
        type: "observation",
        agent: "Research",
        phase: "observe",
        tool: toolName,
        provider: meta.provider,
        result_count: 0,
        message: `Tool unavailable — continuing with remaining tools. (${meta.label})`,
        status: "error",
      });
      continue;
    }

    const observation = results.length
      ? JSON.stringify(
          results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content.slice(0, 500),
          })),
          null,
          2,
        )
      : "No useful results were found.";

    state.observations.push({
      step: state.step_count,
      tool: toolName,
      observation,
      result_count: results.length,
    });

    state.sources.push(...results);
    bumpTool(toolName as ToolName, { successes: 1, results: results.length });

    yield emit({
      step: state.step_count,
      type: "observation",
      agent: "Research",
      phase: "observe",
      tool: toolName,
      provider: meta.provider,
      result_count: results.length,
      from_agent: "Research",
      to_agent: "Orchestrator",
      handoff: `${results.length} source${results.length === 1 ? "" : "s"} added to the evidence pool`,
      message: `Received ${results.length} result${results.length === 1 ? "" : "s"} from ${meta.provider}.`,
      status: "completed",
    });
  }


  yield emit({
    step: state.step_count,
    type: "decision",
    agent: "Analyst",
    phase: "synthesize",
    message: `Analyst agent synthesising the final report from ${state.sources.length} source${state.sources.length === 1 ? "" : "s"}.`,
    status: "running",
  });

  let report: string;
  let reportOk = true;
  try {
    report = await generateFinalReport({ ...state, prior_context: priorContext });
    yield emit({
      step: state.step_count,
      type: "decision",
      agent: "Analyst",
      phase: "complete",
      from_agent: "Analyst",
      to_agent: "Orchestrator",
      handoff: "Final intelligence report",
      message: "Generated final report.",
      status: "complete",
    });
  } catch (e) {
    reportOk = false;
    const message = e instanceof Error ? e.message : String(e);
    report = `NEXUS investigation completed, but the final report could not be generated.\n\nError: ${message}`;
    yield emit({
      step: state.step_count,
      type: "error",
      agent: "Analyst",
      phase: "synthesize",
      message,
      status: "error",
    });
  }

  // ---- long-term memory: persist this run ----
  if (reportOk) {
    try {
      const summary = (
        await callLLM(
          `Summarise the key findings of this competitive intelligence report in 2-3 plain-text sentences. No markdown, no headers.\n\nREPORT:\n${report.slice(0, 6000)}`,
        )
      ).trim();
      await savePriorInvestigation({
        target: state.target,
        topic: state.topic,
        summary,
        confidence: state.confidence,
      });
      memoryStored = true;
      yield emit({
        step: state.step_count,
        type: "memory",
        agent: "Memory",
        phase: "store",
        from_agent: "Analyst",
        to_agent: "Memory",
        handoff: "Report summary stored for future investigations",
        message: `Working context updated — investigation saved to long-term memory for ${state.target || "future runs"}.`,
        status: "stored",
      });
    } catch {
      yield emit({
        step: state.step_count,
        type: "error",
        agent: "Memory",
        phase: "store",
        message: "Could not save this investigation to long-term memory.",
        status: "error",
      });
    }
  }

  const architecture: RunArchitecture = {
    agents: ["Orchestrator", "Research", "Analyst", "Memory"],
    tools_used: [...toolStats.entries()].map(([tool, s]) => ({
      tool,
      label: TOOL_LABELS[tool as ToolName].label,
      provider: TOOL_LABELS[tool as ToolName].provider,
      ...s,
    })),
    providers: [
      ...new Set(
        [...toolStats.keys()].map((t) => TOOL_LABELS[t as ToolName].provider),
      ),
    ],
    memory: {
      working_memory_used: Boolean(state.working_memory),
      history_recalled: historyRecalled,
      stored: memoryStored,
    },
    reasoning: "ReAct / iterative decision loop",
  };

  yield {
    type: "result",
    result: {
      report,
      trace,
      steps: state.step_count,
      confidence: state.confidence,
      working_memory: state.working_memory,
      architecture,
    },
  };
}



async function generateFinalReport(state: {
  goal: string;
  target: string;
  competitors: string[];
  topic: string;
  sources: SourceResult[];
  working_memory?: string;
  prior_context?: string;
}): Promise<string> {
  const sourceText = JSON.stringify(state.sources.slice(-20), null, 2);

  const prompt = `You are preparing the final report for an autonomous competitive
intelligence investigation.

USER GOAL:
${state.goal}

TARGET:
${state.target}

COMPETITORS:
${state.competitors.join(", ")}

TOPIC:
${state.topic}
${state.prior_context ? `\n${state.prior_context}\n` : ""}${state.working_memory ? `\nWORKING MEMORY:\n${state.working_memory}\n` : ""}
EVIDENCE:

${sourceText}

Write a concise actionable intelligence report as PLAIN TEXT (no markdown, no
asterisks, no code fences). Use exactly these section headers, each alone on its
own line, in this order:

EXECUTIVE SUMMARY
KEY FINDINGS
COMPETITIVE IMPACT
PRIORITY
RECOMMENDED ACTIONS
CONFIDENCE
SOURCES

Under PRIORITY, output exactly one of LOW, MEDIUM, or HIGH.

Rules:
- Only use information supported by the evidence above.
- Do not invent facts or sources.
- Clearly distinguish uncertain findings.
- Focus on what the organization should do next.
- Do not expose private chain-of-thought.
- Keep the report concise.`;

  return (await callLLM(prompt)).trim();
}
