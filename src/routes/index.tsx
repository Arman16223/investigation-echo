import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

type AgentName = "Orchestrator" | "Research" | "Memory" | "Analyst";

type TracePhase =
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

type TraceEvent = {
  step: number;
  type: "decision" | "observation" | "error" | "memory";
  message: string;
  tool?: string;
  query?: string;
  result_count?: number;
  status?: string;
  agent?: AgentName;
  phase?: TracePhase;
  provider?: string;
  from_agent?: AgentName;
  to_agent?: AgentName;
  handoff?: string;
};

type RunArchitecture = {
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

type NexusResult = {
  report: string;
  trace: TraceEvent[];
  steps: number;
  confidence: number;
  working_memory?: string;
  architecture?: RunArchitecture;
};

const PHASE_LABELS: Record<TracePhase, string> = {
  recall: "Memory recall",
  decide: "Think / decide",
  select: "Tool selection",
  execute: "Tool execution",
  observe: "Observation",
  handoff: "Handoff",
  compress: "Memory compression",
  store: "Memory write",
  synthesize: "Analysis",
  complete: "Completion",
};



export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NEXUS — Autonomous Competitive Intelligence Agent" },
      {
        name: "description",
        content:
          "NEXUS runs an autonomous ReAct research loop across news, research, patents and competitor activity to produce a grounded intelligence report.",
      },
      { property: "og:title", content: "NEXUS — Autonomous Competitive Intelligence" },
      {
        property: "og:description",
        content:
          "Watch an autonomous agent reason, search and report live: news, research, patents and competitor activity in one intelligence brief.",
      },
    ],
  }),
  component: Nexus,
});

const REPORT_SECTIONS = [
  "EXECUTIVE SUMMARY",
  "KEY FINDINGS",
  "COMPETITIVE IMPACT",
  "PRIORITY",
  "RECOMMENDED ACTIONS",
  "CONFIDENCE",
  "SOURCES",
];

const PRESETS = [
  {
    label: "Chip Wars",
    target: "NVIDIA",
    competitors: "AMD, Intel, Google",
    topic: "AI accelerators",
    goal: "Assess how rivals are eroding NVIDIA's AI accelerator lead and what moves matter next quarter.",
  },
  {
    label: "AI Model Race",
    target: "OpenAI",
    competitors: "Anthropic, Google DeepMind, Meta",
    topic: "Frontier models",
    goal: "Map recent frontier model launches and where each lab is differentiating.",
  },
  {
    label: "EV Market",
    target: "Tesla",
    competitors: "BYD, Rivian, Hyundai",
    topic: "Electric vehicles",
    goal: "Identify competitive threats to Tesla's market share and pricing power.",
  },
];

type Filter = "all" | "decision" | "observation" | "memory" | "error";

function Nexus() {
  const [target, setTarget] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState("");

  const [running, setRunning] = useState(false);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [result, setResult] = useState<NexusResult | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [workingMemory, setWorkingMemory] = useState("");


  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [trace.length, autoScroll]);

  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const started = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [running]);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (running) return;
    setTarget(p.target);
    setCompetitors(p.competitors);
    setTopic(p.topic);
    setGoal(p.goal);
  };

  const copyReport = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };


  const handleChunk = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const chunk = payload as Record<string, unknown>;
    if (chunk["type"] === "trace" && chunk["event"]) {
      setTrace((prev) => [...prev, chunk["event"] as TraceEvent]);
    } else if (chunk["type"] === "memory" && typeof chunk["working_memory"] === "string") {
      setWorkingMemory(chunk["working_memory"] as string);
    } else if (chunk["type"] === "result" && chunk["result"]) {
      const res = chunk["result"] as NexusResult;
      setResult(res);
      if (res.working_memory) setWorkingMemory(res.working_memory);
      if (Array.isArray(res.trace) && res.trace.length) {
        setTrace((prev) => (prev.length ? prev : res.trace));
      }
    }
  };


  const run = async () => {
    if (running) return;
    setRunning(true);
    setTrace([]);
    setResult(null);
    setWorkingMemory("");


    try {
      const response = await fetch("/api/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: goal.trim(),
          target: target.trim(),
          topic: topic.trim(),
          competitors: competitors
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Request failed (${response.status}): ${detail.slice(0, 300) || response.statusText}`,
        );
      }

      const contentType = response.headers.get("content-type") ?? "";

      // Non-streaming fallback: whole payload at once.
      if (!contentType.includes("text/event-stream") || !response.body) {
        const text = await response.text();
        try {
          handleChunk({ type: "result", result: JSON.parse(text) });
        } catch {
          parseSseText(text, handleChunk);
        }
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;
        if (value) buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (consumeSseBlock(part, handleChunk)) {
            done = true;
          }
        }
      }
      if (buffer.trim()) consumeSseBlock(buffer, handleChunk);
    } catch (e) {
      setTrace((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          type: "error",
          message: e instanceof Error ? e.message : String(e),
          status: "error",
        },
      ]);
    } finally {
      setRunning(false);
    }
  };

  const canRun = goal.trim().length > 0 && !running;

  const stepCount = new Set(trace.map((t) => t.step)).size;
  const sourceCount = trace.reduce((n, t) => n + (t.result_count ?? 0), 0);
  const errorCount = trace.filter((t) => t.type === "error").length;
  const progress = result ? 100 : Math.min(95, stepCount * 12);
  const visibleTrace = filter === "all" ? trace : trace.filter((t) => t.type === filter);
  const counts: Record<Filter, number> = {
    all: trace.length,
    decision: trace.filter((t) => t.type === "decision").length,
    observation: trace.filter((t) => t.type === "observation").length,
    memory: trace.filter((t) => t.type === "memory").length,
    error: errorCount,
  };
  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  // ---- derived demo views (built only from real backend trace events) ----
  const handoffs = trace.filter((t) => t.from_agent && t.to_agent);
  const agentChain: AgentName[] = [];
  for (const h of handoffs) {
    if (h.from_agent && agentChain[agentChain.length - 1] !== h.from_agent) {
      agentChain.push(h.from_agent);
    }
    if (h.to_agent) agentChain.push(h.to_agent);
  }
  const toolRuns = trace.filter(
    (t) => t.type === "observation" && typeof t.tool === "string",
  );
  const toolSummary = new Map<
    string,
    { provider: string; ok: number; failed: number; results: number }
  >();
  for (const t of toolRuns) {
    const key = t.tool as string;
    const cur = toolSummary.get(key) ?? {
      provider: t.provider ?? "—",
      ok: 0,
      failed: 0,
      results: 0,
    };
    if (t.status === "error") cur.failed += 1;
    else {
      cur.ok += 1;
      cur.results += t.result_count ?? 0;
    }
    toolSummary.set(key, cur);
  }
  const memoryEvents = trace.filter((t) => t.type === "memory");
  const agentsSeen = [...new Set(trace.map((t) => t.agent).filter(Boolean))] as AgentName[];




  return (
    <main className="min-h-screen px-4 pb-10 sm:px-8">
      <header className="sticky top-0 z-20 -mx-4 mb-6 border-b border-border/70 bg-background/80 px-4 py-4 backdrop-blur-xl sm:-mx-8 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="grid size-9 shrink-0 place-items-center rounded-md border border-primary/40 bg-primary/10 font-mono text-sm font-bold text-primary"
              aria-hidden
            >
              N
            </div>
            <div>
              <h1 className="text-gradient-primary font-mono text-xl font-bold tracking-[0.35em] sm:text-2xl">
                NEXUS
              </h1>
              <p className="label-caps mt-0.5 hidden sm:block">
                Autonomous Competitive Intelligence
              </p>
            </div>
          </div>
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 transition-colors ${
              running
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border bg-secondary/60 text-muted-foreground"
            }`}
          >
            <span className="relative flex size-2">
              {running && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
              )}
              <span
                className={`relative inline-flex size-2 rounded-full ${running ? "bg-primary" : "bg-accent"}`}
              />
            </span>
            <span className="font-mono text-[0.6rem] tracking-[0.2em] uppercase sm:text-[0.65rem]">
              {running ? "Agent Active" : "System Ready"}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.6fr)]">
        {/* Form */}
        <section className="panel h-fit p-5 lg:sticky lg:top-24">
          <h2 className="panel-title mb-4 flex items-center gap-2 border-b border-border pb-3">
            <span className="size-1.5 rounded-full bg-primary" />
            Investigation Parameters
          </h2>

          <div className="mb-5">
            <span className="label-caps mb-2 block">Quick Start</span>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  disabled={running}
                  className="rounded-full border border-border bg-secondary/40 px-3 py-1 font-mono text-[0.65rem] tracking-[0.12em] uppercase text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/10 hover:text-primary disabled:opacity-50"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div
            className="space-y-4"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canRun) run();
            }}
          >
            <Field label="Target">
              <input
                className={inputClass}
                placeholder="Target company"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={running}
              />
            </Field>
            <Field label="Competitors (comma-separated)">
              <input
                className={inputClass}
                placeholder="AMD, Google, Microsoft"
                value={competitors}
                onChange={(e) => setCompetitors(e.target.value)}
                disabled={running}
              />
            </Field>
            <Field label="Topic">
              <input
                className={inputClass}
                placeholder="Generative AI"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                disabled={running}
              />
            </Field>
            <Field label="Investigation Goal" hint={`${goal.trim().length} chars`}>
              <textarea
                className={`${inputClass} min-h-28 resize-y leading-relaxed`}
                placeholder="What should NEXUS find out?"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                disabled={running}
              />
            </Field>
            <button
              onClick={run}
              disabled={!canRun}
              className="group relative w-full overflow-hidden rounded-md bg-primary px-4 py-3 font-mono text-xs tracking-[0.2em] text-primary-foreground uppercase transition-all hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
              style={running ? undefined : { boxShadow: "var(--glow)" }}
            >
              {running ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Investigating · {mmss}
                </span>
              ) : (
                "Run Investigation"
              )}
            </button>
            <p className="text-center font-mono text-[0.65rem] tracking-[0.12em] uppercase text-muted-foreground">
              {goal.trim() ? "⌘ / Ctrl + Enter to run" : "Investigation goal required"}
            </p>
          </div>
        </section>

        {/* Activity */}
        <section className="panel flex min-h-96 flex-col p-5 lg:max-h-[calc(100vh-9rem)]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="panel-title flex items-center gap-2">
              <span
                className={`size-1.5 rounded-full ${running ? "animate-pulse bg-accent" : "bg-muted-foreground"}`}
              />
              Live Agent Activity
            </h2>
            <div className="flex items-center gap-2">
              <Stat label="Steps" value={stepCount} />
              <Stat label="Sources" value={sourceCount} />
              {errorCount > 0 && <Stat label="Errors" value={errorCount} tone="destructive" />}
            </div>
          </div>

          <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-secondary/60">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-all duration-700"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
            <div className="flex flex-wrap gap-1.5">
              {(["all", "decision", "observation", "memory", "error"] as Filter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`rounded-sm border px-2 py-1 font-mono text-[0.6rem] tracking-[0.16em] uppercase transition-colors ${
                    filter === f
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f} {counts[f] > 0 && <span className="opacity-70">{counts[f]}</span>}
                </button>
              ))}
            </div>
            <label className="flex cursor-pointer items-center gap-2 font-mono text-[0.6rem] tracking-[0.16em] uppercase text-muted-foreground">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="size-3 accent-[var(--color-primary)]"
              />
              Auto-scroll
            </label>
          </div>

          <div className="flex-1 overflow-y-auto pr-1">
            {trace.length === 0 && !running && (
              <div className="flex flex-col items-center gap-3 py-20 text-center">
                <div className="grid size-12 place-items-center rounded-full border border-border bg-secondary/40 font-mono text-primary">
                  ⌁
                </div>
                <p className="text-sm text-muted-foreground">
                  NEXUS is ready to investigate.
                </p>
                <p className="label-caps">Pick a quick start or define a goal</p>
              </div>
            )}
            {trace.length === 0 && running && (
              <div className="space-y-3 py-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-20 animate-pulse rounded-md border border-border bg-card/40"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))}
              </div>
            )}
            {visibleTrace.length > 0 && (
              <ol className="relative space-y-3 border-l border-border/70 pl-5">
                {visibleTrace.map((event, i) => (
                  <TraceCard key={`${event.step}-${event.type}-${i}`} event={event} />
                ))}
              </ol>
            )}
            {trace.length > 0 && visibleTrace.length === 0 && (
              <p className="py-16 text-center text-sm text-muted-foreground">
                No {filter} events yet.
              </p>
            )}
            <div ref={bottomRef} />
          </div>

          {trace.length > 0 && (
            <details className="mt-4 rounded-md border border-border bg-card/40 p-3">
              <summary className="label-caps cursor-pointer select-none">
                System Trace · Agent Architecture
              </summary>

              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                {/* Agent handoff chain */}
                <div>
                  <p className="label-caps mb-2">Agent Flow (observed)</p>
                  {agentChain.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No handoffs yet.</p>
                  ) : (
                    <ol className="space-y-1">
                      {agentChain.map((a, i) => (
                        <li key={`${a}-${i}`} className="font-mono text-xs text-foreground/90">
                          {i > 0 && <span className="mr-2 text-muted-foreground">↓</span>}
                          {a}
                        </li>
                      ))}
                      {result && (
                        <li className="font-mono text-xs text-accent">
                          <span className="mr-2 text-muted-foreground">↓</span>Final Report
                        </li>
                      )}
                    </ol>
                  )}
                  <ul className="mt-3 space-y-1">
                    {handoffs.map((h, i) => (
                      <li key={i} className="text-[0.7rem] text-muted-foreground">
                        <span className="font-mono text-foreground/80">
                          {h.from_agent} → {h.to_agent}
                        </span>
                        {h.handoff ? ` · ${h.handoff}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Tools actually invoked */}
                <div>
                  <p className="label-caps mb-2">External APIs Used (this run)</p>
                  {toolSummary.size === 0 ? (
                    <p className="text-xs text-muted-foreground">No tool calls yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {[...toolSummary.entries()].map(([tool, s]) => (
                        <li key={tool} className="text-[0.7rem] text-muted-foreground">
                          <span className="font-mono text-foreground/90">{tool}</span>
                          <br />
                          Provider: {s.provider} · Status:{" "}
                          {s.failed && !s.ok ? "Unavailable" : "Success"} · Results:{" "}
                          {s.results}
                          {s.failed > 0 && ` · Failed calls: ${s.failed}`}
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="label-caps mt-4 mb-2">Memory</p>
                  <ul className="space-y-1 text-[0.7rem] text-muted-foreground">
                    <li>
                      Working memory: {workingMemory ? "updated / compressed" : "not compressed this run"}
                    </li>
                    <li>Memory events: {memoryEvents.length}</li>
                    {result?.architecture && (
                      <li>
                        History recalled: {result.architecture.memory.history_recalled} ·
                        Stored: {result.architecture.memory.stored ? "yes" : "no"}
                      </li>
                    )}
                  </ul>

                  <p className="label-caps mt-4 mb-2">Reasoning</p>
                  <p className="text-[0.7rem] text-muted-foreground">
                    ReAct / iterative decision loop · Agents active:{" "}
                    {agentsSeen.length ? agentsSeen.join(", ") : "—"}
                  </p>
                </div>
              </div>

              {workingMemory && (
                <div className="mt-4 border-t border-border pt-3">
                  <p className="label-caps mb-2">Working Memory Snapshot</p>
                  <p className="text-[0.7rem] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {workingMemory}
                  </p>
                </div>
              )}
            </details>
          )}

        </section>
      </div>

      {result && (
        <section className="panel mx-auto mt-5 max-w-7xl p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <h2 className="panel-title flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-accent" />
              Intelligence Report
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-accent/50 bg-accent/10 px-3 py-1 font-mono text-[0.65rem] tracking-[0.18em] text-accent uppercase">
                {result.confidence}% Confidence
              </span>
              <button
                type="button"
                onClick={copyReport}
                className="rounded-sm border border-border px-3 py-1 font-mono text-[0.6rem] tracking-[0.16em] uppercase text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <a
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(result.report)}`}
                download="nexus-report.txt"
                className="rounded-sm border border-border px-3 py-1 font-mono text-[0.6rem] tracking-[0.16em] uppercase text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
              >
                Download
              </a>
            </div>
          </div>

          <div className="space-y-2 text-sm leading-relaxed text-foreground/85 sm:columns-1">
            {result.report.split("\n").map((line, i) => {
              const clean = line.replace(/[*#`]/g, "").trim();
              if (!clean) return <div key={i} className="h-2" />;
              if (REPORT_SECTIONS.includes(clean.toUpperCase())) {
                return (
                  <h3
                    key={i}
                    className="panel-title flex items-center gap-2 pt-6 text-primary first:pt-0"
                  >
                    <span className="h-px w-4 bg-primary/60" />
                    {clean.toUpperCase()}
                  </h3>
                );
              }
              return (
                <p key={i} className="whitespace-pre-wrap break-words">
                  {clean}
                </p>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

const inputClass =
  "w-full rounded-md border border-input bg-background/60 px-3 py-2.5 font-mono text-sm text-foreground transition-colors placeholder:text-muted-foreground/50 hover:border-border focus:border-primary focus:ring-1 focus:ring-ring focus:outline-none disabled:opacity-60";

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "destructive" | "memory";
}) {
  const toneClass =
    tone === "destructive"
      ? "border-destructive/50 bg-destructive/10"
      : tone === "memory"
        ? "border-[oklch(0.66_0.2_300_/_55%)] bg-[oklch(0.66_0.2_300_/_12%)]"
        : "border-border bg-secondary/40";
  return (
    <span
      className={`rounded-sm border px-2 py-1 font-mono text-[0.6rem] tracking-[0.16em] uppercase ${toneClass}`}
    >
      <span className="text-foreground">{value}</span>{" "}
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center justify-between gap-2">
        <span className="label-caps">{label}</span>
        {hint && <span className="label-caps opacity-60">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function MemoryIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <ellipse cx="12" cy="5.5" rx="7" ry="3" />
      <path d="M5 5.5v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
      <path d="M5 11.5v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
    </svg>
  );
}

function TraceCard({ event }: { event: TraceEvent }) {
  const tone =
    event.type === "error"
      ? "border-destructive/50 text-destructive"
      : event.type === "memory"
        ? "border-[oklch(0.66_0.2_300_/_55%)] text-[oklch(0.75_0.17_300)]"
        : event.type === "decision"
          ? "border-primary/50 text-primary"
          : "border-accent/50 text-accent";

  const dot =
    event.type === "error"
      ? "bg-destructive"
      : event.type === "memory"
        ? "bg-[oklch(0.7_0.19_300)]"
        : event.type === "decision"
          ? "bg-primary"
          : "bg-accent";

  const cardTone =
    event.type === "memory"
      ? "border-[oklch(0.66_0.2_300_/_35%)] bg-[oklch(0.66_0.2_300_/_8%)]"
      : "border-border bg-card/60";

  return (
    <li
      className={`animate-trace-in relative rounded-md border p-4 transition-colors hover:border-border/80 hover:bg-card/80 ${cardTone}`}
    >
      <span
        className={`absolute top-6 -left-[1.55rem] size-2 rounded-full ring-4 ring-[var(--color-surface)] ${dot}`}
        aria-hidden
      />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="label-caps">Step {event.step}</span>
        {event.agent && (
          <span className="rounded-sm border border-border bg-secondary/50 px-2 py-0.5 font-mono text-[0.6rem] tracking-[0.16em] uppercase text-foreground/80">
            {event.agent}
          </span>
        )}
        <span
          className={`flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[0.6rem] tracking-[0.18em] uppercase ${tone}`}
        >
          {event.type === "memory" && <MemoryIcon className="size-3" />}
          {event.phase ? PHASE_LABELS[event.phase] : event.type}
        </span>
        {typeof event.result_count === "number" && (
          <span className="label-caps ml-auto">{event.result_count} results</span>
        )}
      </div>
      {event.from_agent && event.to_agent && (
        <p className="mb-2 font-mono text-[0.65rem] text-muted-foreground">
          {event.from_agent} → {event.to_agent}
          {event.handoff ? ` · ${event.handoff}` : ""}
        </p>
      )}
      <p className="text-sm break-words text-foreground/90">{event.message}</p>
      {event.tool && (
        <div className="mt-3 space-y-1 border-t border-border/70 pt-2">
          <p className="font-mono text-xs text-accent">
            Tool: {event.tool}
            {event.provider ? ` · ${event.provider}` : ""}
          </p>
          {event.type === "observation" && (
            <p className="font-mono text-xs text-muted-foreground">
              Status: {event.status === "error" ? "Unavailable" : "Success"}
              {typeof event.result_count === "number"
                ? ` · Results: ${event.result_count}`
                : ""}
            </p>
          )}
          {event.query && (
            <p className="font-mono text-xs break-words text-muted-foreground">
              "{event.query}"
            </p>
          )}
        </div>
      )}

    </li>
  );
}



/** Returns true when the [DONE] sentinel was seen. */
function consumeSseBlock(block: string, onChunk: (payload: unknown) => void) {
  let done = false;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      onChunk(JSON.parse(data));
    } catch {
      /* ignore malformed frame */
    }
  }
  return done;
}

function parseSseText(text: string, onChunk: (payload: unknown) => void) {
  for (const block of text.split("\n\n")) consumeSseBlock(block, onChunk);
}
