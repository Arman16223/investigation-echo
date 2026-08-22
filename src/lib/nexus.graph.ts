import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

type Evidence = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

type AgentState = {
  goal: string;
  target: string;
  topic: string;
  competitors: string[];

  plan: string[];
  subtasks: string[];
  currentStep: number;
  maxSteps: number;

  evidence: Evidence[];

  hypotheses: string[];
  verifiedHypotheses: string[];

  conflicts: string[];

  toolsUsed: string[];
  failedTools: string[];
  agentMessages: string[];
  workingMemory: string;
  previousInvestigationContext: string;
  retryCount: number;
  loopDetection: { signatures: string[]; stalled: boolean };

  failures: string[];
  fallbackCount: number;

  confidence: number;

  nextAction: string;

  iterations: number;
  maxIterations: number;

  finalReport: string;
  selfEvaluation: {
    objectiveAnswered: boolean;
    evidenceSufficient: boolean;
    claimsSupported: boolean;
    unresolvedConflicts: boolean;
    confidenceJustified: boolean;
  };

  status: string;
  adversarial: boolean;

  trace: Array<{
    step: number;
    type: string;
    agent: string;
    message: string;
  }>;
};

const GraphState = Annotation.Root({
  goal: Annotation<string>({
    reducer: (_, value) => value,
    default: () => "",
  }),

  target: Annotation<string>({
    reducer: (_, value) => value,
    default: () => "",
  }),

  topic: Annotation<string>({
    reducer: (_, value) => value,
    default: () => "",
  }),

  competitors: Annotation<string[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  plan: Annotation<string[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  subtasks: Annotation<string[]>({ reducer: (_, value) => value, default: () => [] }),

  currentStep: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  maxSteps: Annotation<number>({ reducer: (_, value) => value, default: () => 8 }),

  evidence: Annotation<Evidence[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  hypotheses: Annotation<string[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  verifiedHypotheses: Annotation<string[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  conflicts: Annotation<string[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  toolsUsed: Annotation<string[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  failedTools: Annotation<string[]>({ reducer: (_, value) => value, default: () => [] }),
  agentMessages: Annotation<string[]>({ reducer: (_, value) => value, default: () => [] }),
  workingMemory: Annotation<string>({ reducer: (_, value) => value, default: () => "" }),
  previousInvestigationContext: Annotation<string>({ reducer: (_, value) => value, default: () => "" }),
  retryCount: Annotation<number>({ reducer: (_, value) => value, default: () => 0 }),
  loopDetection: Annotation<{ signatures: string[]; stalled: boolean }>({
    reducer: (_, value) => value,
    default: () => ({ signatures: [], stalled: false }),
  }),

  failures: Annotation<string[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  fallbackCount: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  confidence: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  nextAction: Annotation<string>({
    reducer: (_, value) => value,
    default: () => "plan",
  }),

  iterations: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  maxIterations: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 8,
  }),

  finalReport: Annotation<string>({
    reducer: (_, value) => value,
    default: () => "",
  }),

  selfEvaluation: Annotation<AgentState["selfEvaluation"]>({
    reducer: (_, value) => value,
    default: () => ({
      objectiveAnswered: false,
      evidenceSufficient: false,
      claimsSupported: false,
      unresolvedConflicts: false,
      confidenceJustified: false,
    }),
  }),

  status: Annotation<string>({
    reducer: (_, value) => value,
    default: () => "starting",
  }),

  adversarial: Annotation<boolean>({ reducer: (_, value) => value, default: () => false }),

  trace: Annotation<
    Array<{
      step: number;
      type: string;
      agent: string;
      message: string;
    }>
  >({
    reducer: (_, value) => value,
    default: () => [],
  }),
});

function addTrace(
  state: AgentState,
  agent: string,
  type: string,
  message: string,
) {
  return [
    ...state.trace,
    {
      step: state.iterations,
      type,
      agent,
      message,
    },
  ];
}

/**
 * Get OpenAI configuration safely.
 *
 * bracket notation is required by the project's TypeScript settings.
 */
function getOpenAIConfig() {
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = process.env["OPENAI_MODEL"] || "gpt-4o-mini";

  return {
    apiKey,
    model,
  };
}

/**
 * Planner
 *
 * Dynamically creates the initial investigation plan.
 */
async function plannerNode(state: AgentState) {
  const { apiKey, model: modelName } = getOpenAIConfig();

  if (!apiKey) {
    return {
      status: "error",
      failures: [...state.failures, "OPENAI_API_KEY is missing."],
      nextAction: "stop",
      trace: addTrace(
        state,
        "orchestrator",
        "error",
        "OpenAI API key is missing.",
      ),
    };
  }

  const model = new ChatOpenAI({
    apiKey,
    model: modelName,
    temperature: 0,
  });

  const prompt = `
You are the planning agent in a multi-agent investigation system.

Goal:
${state.goal}

Target:
${state.target || "Not specified"}

Topic:
${state.topic || "Not specified"}

Competitors:
${state.competitors.join(", ") || "None"}

Previous context:
${state.previousInvestigationContext || "None"}

Current evidence count: ${state.evidence.length}

Create a dynamic investigation plan.

Requirements:
- Produce 3 to 6 concrete investigation steps.
- Include evidence gathering.
- Include hypothesis verification.
- Include conflicting-evidence analysis.
- Include a final synthesis step.
- The plan must be adaptable rather than a fixed workflow.

Return ONLY a numbered list.
`;

  try {
    const response = await model.invoke(prompt);

    const text =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const plan = text
      .split("\n")
      .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
      .filter(Boolean);

    return {
      plan,
      currentStep: 0,
      status: "planning_complete",
      nextAction: "research",
      trace: addTrace(
        state,
        "orchestrator",
        "plan",
        `Created ${plan.length} adaptive investigation steps.`,
      ),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Planner failed.";

    return {
      failures: [...state.failures, message],
      status: "error",
      nextAction: "stop",
      trace: addTrace(
        state,
        "orchestrator",
        "error",
        "Planning failed.",
      ),
    };
  }
}

/**
 * Research agent
 *
 * Temporary research adapter.
 *
 * The existing Task 4 Tavily / Hacker News tools can be connected here
 * without changing the LangGraph routing architecture.
 */
async function researchNode(state: AgentState) {
  const iteration = state.iterations + 1;

  const queryParts = [
    state.goal,
    state.target,
    state.topic,
    state.plan[state.currentStep] || "",
  ].filter(Boolean);

  const query = queryParts.join(" ");

  const selectedTools = ["search_news", "search_hacker_news"] as const;
  const requests = selectedTools.map((tool) => ({ tool, query }));

  try {
    if (!query) {
      throw new Error("Research query is empty.");
    }

    const { executeToolBatch } = await import("@/lib/nexus.server");
    const outcomes = await executeToolBatch(requests);
    if (state.adversarial || process.env["NEXUS_ADVERSARIAL_TEST"] === "true") {
      const primary = outcomes[0];
      if (primary) {
        primary.error = "Injected primary-tool failure for adversarial recovery test.";
        primary.results = [];
      }
      const fallback = outcomes[1];
      if (fallback) {
        fallback.results = [
          { title: "Adversarial positive signal", url: "https://example.invalid/positive", content: "Reported growth and success." },
          { title: "Adversarial negative signal", url: "https://example.invalid/negative", content: "Reported decline and failure." },
        ];
      }
    }
    const evidence: Evidence[] = outcomes.flatMap((outcome) =>
      outcome.results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content.slice(0, 800),
        source: outcome.tool,
      })),
    );
    const failures = outcomes
      .filter((outcome) => outcome.error)
      .map((outcome) => `${outcome.tool}: ${outcome.error}`);
    const hasConflictingSignals = evidence.some((item) => /growth|success/i.test(item.snippet)) && evidence.some((item) => /decline|failure/i.test(item.snippet));
    const nextAction = failures.length && !evidence.length ? "fallback" : "verify";

    return {
      iterations: iteration,
      evidence: [...state.evidence, ...evidence],
      toolsUsed: [...new Set([...state.toolsUsed, ...selectedTools])],
      failures: [...state.failures, ...failures],
      failedTools: [...state.failedTools, ...failures.map((failure) => failure.split(":")[0] ?? failure)],
      conflicts: hasConflictingSignals
        ? [...state.conflicts, "Independent sources contain positive and negative signals; verification required."]
        : state.conflicts,
      currentStep: state.currentStep + 1,
      status: failures.length ? "research_degraded" : "research_complete",
      nextAction,
      trace: addTrace(
        state,
        "research",
        failures.length ? "fallback" : "parallel_research",
        `Parallel research executed for: ${query}; ${evidence.length} sources collected.`,
      ),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Research failed.";

    return {
      iterations: iteration,
      failures: [...state.failures, message],
      fallbackCount: state.fallbackCount + 1,
      status: "research_failed",
      nextAction: "fallback",
      trace: addTrace(
        state,
        "research",
        "failure",
        `Research failed; requesting fallback. ${message}`,
      ),
    };
  }
}

/**
 * Verification agent
 *
 * Checks hypotheses against gathered evidence.
 */
async function verificationNode(state: AgentState) {
  const { apiKey, model: modelName } = getOpenAIConfig();

  if (!apiKey) {
    return {
      nextAction: "stop",
      status: "error",
      failures: [...state.failures, "OPENAI_API_KEY is missing."],
      trace: addTrace(
        state,
        "analyst",
        "error",
        "Verification could not start because the API key is missing.",
      ),
    };
  }

  const model = new ChatOpenAI({
    apiKey,
    model: modelName,
    temperature: 0,
  });

  const evidenceText =
    state.evidence.length > 0
      ? state.evidence
          .map(
            (item, index) =>
              `${index + 1}. ${item.title}\n${item.snippet}\n${item.url}`,
          )
          .join("\n\n")
      : "No evidence gathered yet.";

  const prompt = `
You are the verification agent.

Investigation goal:
${state.goal}

Current plan step:
${state.plan[state.currentStep - 1] || "Unknown"}

Evidence:
${evidenceText}

Determine:
1. What claims can actually be supported?
2. What claims remain uncertain?
3. Are there conflicting pieces of evidence?
4. What should the system investigate next?

Return exactly this structure:

HYPOTHESES:
- ...

VERIFIED:
- ...

CONFLICTS:
- ...

CONFIDENCE:
0-100

NEXT:
research | synthesize | fallback | stop
`;

  try {
    const response = await model.invoke(prompt);

    const text =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const confidenceMatch = text.match(/CONFIDENCE:\s*(\d+)/i);

    const confidence = confidenceMatch
      ? Math.max(0, Math.min(100, Number(confidenceMatch[1])))
      : 0;

    const nextMatch = text.match(
      /NEXT:\s*(research|synthesize|fallback|stop)/i,
    );

    // Avoid unsafe access to nextMatch[1].
    const matchedNextAction = nextMatch?.[1];

    const nextAction = matchedNextAction
      ? matchedNextAction.toLowerCase()
      : state.evidence.length > 0
        ? "synthesize"
        : "research";

    const hypothesesSection =
      text.match(/HYPOTHESES:\s*([\s\S]*?)(?=VERIFIED:|$)/i)?.[1] || "";

    const verifiedSection =
      text.match(/VERIFIED:\s*([\s\S]*?)(?=CONFLICTS:|$)/i)?.[1] || "";

    const conflictsSection =
      text.match(/CONFLICTS:\s*([\s\S]*?)(?=CONFIDENCE:|$)/i)?.[1] || "";

    const parseBullets = (section: string) =>
      section
        .split("\n")
        .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
        .filter(Boolean);

    return {
      hypotheses: parseBullets(hypothesesSection),
      verifiedHypotheses: parseBullets(verifiedSection),
      conflicts: parseBullets(conflictsSection),
      confidence,
      nextAction,
      status: "verification_complete",
      trace: addTrace(
        state,
        "analyst",
        "verification",
        `Verification complete. Confidence: ${confidence}%.`,
      ),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Verification failed.";

    return {
      failures: [...state.failures, message],
      nextAction: "fallback",
      status: "verification_failed",
      trace: addTrace(
        state,
        "analyst",
        "failure",
        "Verification failed; routing to fallback.",
      ),
    };
  }
}

/**
 * Fallback agent
 *
 * Handles tool/provider failures without terminating the investigation.
 */
async function fallbackNode(state: AgentState) {
  if (state.fallbackCount >= 3) {
    return {
      status: "fallback_limit_reached",
      nextAction: "synthesize",
      trace: addTrace(
        state,
        "orchestrator",
        "circuit_breaker",
        "Three fallback attempts reached. Continuing with available evidence.",
      ),
    };
  }

  return {
    fallbackCount: state.fallbackCount + 1,
    currentStep: Math.max(0, state.currentStep - 1),
    status: "fallback_replan",
    nextAction: "research",
    trace: addTrace(
      state,
      "orchestrator",
      "fallback",
      "Replanning after a failed agent/tool execution.",
    ),
  };
}

/**
 * Synthesis agent
 */
async function synthesisNode(state: AgentState) {
  const { apiKey, model: modelName } = getOpenAIConfig();

  if (!apiKey) {
    return {
      status: "error",
      nextAction: "stop",
      finalReport: "Unable to synthesize: OPENAI_API_KEY is missing.",
      trace: addTrace(
        state,
        "analyst",
        "error",
        "Synthesis failed because the API key is missing.",
      ),
    };
  }

  const model = new ChatOpenAI({
    apiKey,
    model: modelName,
    temperature: 0.1,
  });

  const evidenceText =
    state.evidence.length > 0
      ? state.evidence
          .map(
            (item, index) =>
              `[${index + 1}] ${item.title}\n${item.snippet}\n${item.url}`,
          )
          .join("\n\n")
      : "No external evidence was gathered.";

  const prompt = `
You are the final synthesis agent.

Investigation goal:
${state.goal}

Target:
${state.target}

Verified hypotheses:
${state.verifiedHypotheses.join("\n") || "None"}

Conflicting evidence:
${state.conflicts.join("\n") || "None detected"}

Evidence:
${evidenceText}

Confidence:
${state.confidence}%

Write a concise evidence-grounded investigation report.

Rules:
- Never invent evidence.
- Clearly distinguish facts from inference.
- Explicitly discuss conflicting evidence.
- Explicitly state uncertainty.
- Give the final confidence percentage.
- Mention limitations.
`;

  try {
    const response = await model.invoke(prompt);

    const finalReport =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    return {
      finalReport,
      status: "complete",
      nextAction: "stop",
      trace: addTrace(
        state,
        "analyst",
        "synthesis",
        "Final evidence-grounded report generated.",
      ),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Synthesis failed.";

    return {
      failures: [...state.failures, message],
      status: "synthesis_failed",
      nextAction: "stop",
      finalReport:
        "The investigation could not be fully synthesized because the final analysis step failed.",
      trace: addTrace(
        state,
        "analyst",
        "failure",
        "Final synthesis failed.",
      ),
    };
  }
}

/**
 * Conditional routing
 */
function routeAfterPlanner(state: AgentState) {
  if (state.nextAction === "stop") {
    return "end";
  }

  return "research";
}

export const nexusPlanningGraph = new StateGraph(GraphState)
  .addNode("planner", plannerNode)
  .addEdge(START, "planner")
  .addConditionalEdges("planner", routeAfterPlanner, {
    research: END,
    end: END,
  })
  .compile({ checkpointer: new MemorySaver() });

function routeAfterResearch(state: AgentState) {
  if (state.nextAction === "fallback") {
    return "fallback";
  }

  if (state.iterations >= state.maxIterations) {
    return "synthesize";
  }

  return "verify";
}

function routeAfterVerification(state: AgentState) {
  if (state.nextAction === "research") {
    if (state.iterations >= state.maxIterations) {
      return "synthesize";
    }

    return "research";
  }

  if (state.nextAction === "fallback") {
    return "fallback";
  }

  if (state.nextAction === "stop") {
    return "end";
  }

  return "evaluate";
}

function selfEvaluationNode(state: AgentState) {
  const evidenceSufficient = state.evidence.length >= 2;
  const objectiveAnswered = state.verifiedHypotheses.length > 0 || evidenceSufficient;
  const evaluation = {
    objectiveAnswered,
    evidenceSufficient,
    claimsSupported: state.verifiedHypotheses.length > 0,
    unresolvedConflicts: state.conflicts.length > 0,
    confidenceJustified: state.confidence >= 60 && evidenceSufficient,
  };
  const needsMoreWork =
    !evaluation.objectiveAnswered ||
    !evaluation.evidenceSufficient ||
    evaluation.unresolvedConflicts;
  return {
    selfEvaluation: evaluation,
    nextAction: needsMoreWork ? "replan" : "synthesize",
    status: needsMoreWork ? "self_evaluation_needs_research" : "self_evaluation_passed",
    trace: addTrace(
      state,
      "analyst",
      "self_evaluation",
      needsMoreWork
        ? "Self-evaluation found insufficient or conflicting evidence; replanning."
        : "Self-evaluation passed: objective, evidence, claims, and confidence are aligned.",
    ),
  };
}

function replanNode(state: AgentState) {
  const signature = `${state.currentStep}:${state.evidence.length}:${state.conflicts.length}`;
  const signatures = [...state.loopDetection.signatures, signature];
  const stalled = signatures.filter((item) => item === signature).length > 2;
  return {
    plan: [...state.plan, "Replan: independently verify unresolved claims"],
    subtasks: ["Verify unresolved claims", "Seek an independent source"],
    retryCount: state.retryCount + 1,
    loopDetection: { signatures, stalled },
    nextAction: stalled || state.retryCount >= 3 ? "synthesize" : "research",
    status: stalled ? "replan_deadlock" : "replanned",
    trace: addTrace(
      state,
      "orchestrator",
      stalled ? "deadlock" : "replan",
      stalled ? "Repeated graph state detected; terminating safely." : "Adaptive subtasks created from self-evaluation.",
    ),
  };
}

function routeAfterFallback(state: AgentState) {
  if (state.nextAction === "synthesize") {
    return "synthesize";
  }

  if (state.fallbackCount >= 3) {
    return "synthesize";
  }

  return "research";
}

function routeAfterEvaluation(state: AgentState) {
  return state.nextAction === "replan" ? "replan" : "synthesize";
}

function routeAfterReplan(state: AgentState) {
  if (state.nextAction === "synthesize") return "synthesize";
  return "planner";
}

function memoryNode(state: AgentState) {
  return {
    workingMemory: state.previousInvestigationContext,
    agentMessages: [...state.agentMessages, "Memory agent supplied prior investigation context."],
    status: "memory_recalled",
    trace: addTrace(state, "memory", "recall", "Memory agent supplied prior investigation context."),
  };
}

function memoryUpdateNode(state: AgentState) {
  return {
    status: "memory_update_pending",
    trace: addTrace(state, "memory", "store", "Memory agent marked the completed investigation for persistence."),
  };
}

function routeAfterSynthesis() {
  return "end";
}

/**
 * LangGraph investigation graph
 */
export const nexusGraph = new StateGraph(GraphState)
  .addNode("memory", memoryNode)
  .addNode("memory_update", memoryUpdateNode)
  .addNode("planner", plannerNode)
  .addNode("research", researchNode)
  .addNode("verify", verificationNode)
  .addNode("fallback", fallbackNode)
  .addNode("evaluate", selfEvaluationNode)
  .addNode("replan", replanNode)
  .addNode("synthesize", synthesisNode)

  .addEdge(START, "memory")
  .addEdge("memory", "planner")

  .addConditionalEdges("planner", routeAfterPlanner, {
    research: "research",
    end: END,
  })

  .addConditionalEdges("research", routeAfterResearch, {
    verify: "verify",
    fallback: "fallback",
    synthesize: "synthesize",
  })

  .addConditionalEdges("verify", routeAfterVerification, {
    research: "research",
    fallback: "fallback",
    synthesize: "synthesize",
    evaluate: "evaluate",
    end: END,
  })

  .addConditionalEdges("evaluate", routeAfterEvaluation, {
    replan: "replan",
    synthesize: "synthesize",
  })

  .addConditionalEdges("replan", routeAfterReplan, {
    planner: "planner",
    synthesize: "synthesize",
  })

  .addConditionalEdges("fallback", routeAfterFallback, {
    research: "research",
    synthesize: "synthesize",
  })

  .addEdge("synthesize", "memory_update")
  .addConditionalEdges("memory_update", routeAfterSynthesis, { end: END })

  .compile({ checkpointer: new MemorySaver() });

export type NexusGraphState = AgentState;