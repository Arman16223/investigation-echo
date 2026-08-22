import { createFileRoute } from "@tanstack/react-router";

import { runNexus } from "@/lib/nexus.server";

export const Route = createFileRoute("/api/investigate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const raw = (body ?? {}) as Record<string, unknown>;
        const goal = typeof raw["goal"] === "string" ? raw["goal"].trim() : "";
        const target = typeof raw["target"] === "string" ? raw["target"].trim() : "";
        const topic = typeof raw["topic"] === "string" ? raw["topic"].trim() : "";
        const competitors = Array.isArray(raw["competitors"])
          ? raw["competitors"].filter((c): c is string => typeof c === "string")
          : [];

        if (!goal) {
          return new Response(
            JSON.stringify({ error: "An investigation goal is required." }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (payload: unknown) => {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
              );
            };

            try {
              for await (const chunk of runNexus({
                goal,
                target,
                topic,
                competitors,
              })) {
                send(chunk);
              }
            } catch (e) {
              send({
                type: "trace",
                event: {
                  step: 0,
                  type: "error",
                  message: e instanceof Error ? e.message : String(e),
                  status: "error",
                },
              });
            } finally {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});
