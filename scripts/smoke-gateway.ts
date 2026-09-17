/**
 * Dev-only fake OpenAI-compatible gateway (issue #54).
 *
 * Serves same-origin `/v1/chat/completions` + `/v1/models` so the browser
 * smoke page can drive the REAL pipeline with no key and no CORS. Scripted
 * per-model response sequences exercise the honest-degradation lanes:
 * 429→200 (AI-SDK retry), truncated KV (per-record salvage), junk
 * (re-prompt then degrade), and a plain-JSON answer (KV salvage fallback).
 *
 * Buckets are keyed by the request's `model` field — the smoke page sets a
 * per-lane model name (`smoke-translate`, `smoke-fill-a`, …). Keying on the
 * message content does not work: query translation routes `prefix:value`
 * text to deterministic identifier searches, stripping it from the prompt.
 *
 * Fail-closed: any request whose model has no bucket → 400 with a distinct
 * message, so a broken harness can never silently pass.
 *
 * Every raw model response is appended to `.smoke/corpus/` for
 * `pnpm smoke:parse` (a parse-rate diagnostic over real responses).
 */
import type { Connect } from "vite";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

type ScriptedResponse =
  | {
      status: 429;
      body: { error: { message: string; type: string; code: number } };
    }
  | {
      status: 200;
      body: { choices: Array<{ message: { role: string; content: string } }> };
    };

const CORPUS_DIR = join(process.cwd(), ".smoke", "corpus");

const TRANSLATE_OK: ScriptedResponse = {
  status: 200,
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content:
            "kind: tag\nvalue: cve:CVE-2017-15361\n\nkind: text\nvalue: ROCA smartcard RSA",
        },
      },
    ],
  },
};

function fillOk(ids: string[]): ScriptedResponse {
  return {
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content: ids
              .map(
                (id, i) =>
                  `id: ${id}\ntitle: Card ${i} — ROCA-affected smartcard library\nsnippet: Infineon TPM module affected by the ROCA key-generation flaw, covered by the analysis.`,
              )
              .join("\n\n"),
          },
        },
      ],
    },
  };
}

/** Truncated fill: 2 of 3 records complete, the 3rd cut mid-record. */
function fillTruncated(ids: string[]): ScriptedResponse {
  return {
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content:
              ids
                .slice(0, 2)
                .map(
                  (id, i) =>
                    `id: ${id}\ntitle: Card ${i} — ROCA-affected smartcard library\nsnippet: Infineon TPM module affected by the ROCA key-generation flaw.`,
                )
                .join("\n\n") + `\n\nid: ${ids[2]}\ntitle: Card 2 — truncat`,
          },
        },
      ],
    },
  };
}

const RATE_LIMITED: ScriptedResponse = {
  status: 429,
  body: {
    error: {
      message: "Rate limit exceeded for this request.",
      type: "rate_limit_error",
      code: 429,
    },
  },
};

const JUNK: ScriptedResponse = {
  status: 200,
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: "I am sorry, I cannot help with that request.",
        },
      },
    ],
  },
};

/** Scripted sequences, keyed by model name; consumed in order, last repeats. */
const BUCKETS: Record<string, ScriptedResponse[]> = {
  // Translate lane: one 429 first (the AI SDK's retry clears it), then KV.
  "smoke-translate": [RATE_LIMITED, TRANSLATE_OK],
  // Fill lane A: 429 (SDK retry) → junk (re-prompt) → truncated (salvage 2/3).
  "smoke-fill-a": [
    RATE_LIMITED,
    JUNK,
    fillTruncated(["smoke-0", "smoke-1", "smoke-2"]),
  ],
  // Fill lane B: complete.
  "smoke-fill-b": [fillOk(["smoke-3", "smoke-4", "smoke-5"])],
};

/** Append a raw model response to the corpus (one file per model). */
function recordCorpus(model: string, res: ScriptedResponse): void {
  try {
    mkdirSync(CORPUS_DIR, { recursive: true });
    const content =
      res.status === 200
        ? res.body.choices[0].message.content
        : `__HTTP_${res.status}__ ${JSON.stringify(res.body)}`;
    appendFileSync(join(CORPUS_DIR, `${model}.txt`), content + "\n\u241E\n");
  } catch {
    // corpus is best-effort; never break the smoke on fs trouble
  }
}

/**
 * OpenAI-style SSE frames for one assistant message: role chunk, ~5 content
 * deltas, a stop chunk, then [DONE]. The smoke-ui fill lane streams so the
 * browser exercises the app's real streamText path with visible latency.
 */
function sseFrames(content: string): string {
  const frame = (delta: Record<string, string>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion.chunk",
      created: 0,
      model: "smoke",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const chunks: string[] = [];
  const size = Math.max(1, Math.ceil(content.length / 5));
  for (let i = 0; i < content.length; i += size) chunks.push(content.slice(i, i + size));
  if (chunks.length === 0) chunks.push("");
  return (
    frame({ role: "assistant" }, null) +
    chunks.map((chunk) => frame({ content: chunk }, null)).join("") +
    frame({}, "stop") +
    "data: [DONE]\n\n"
  );
}

/**
 * The dev middleware. Falls through to Vite for non-gateway requests.
 */
export function smokeGatewayMiddleware(): Connect.NextHandleFunction {
  const cursors = new Map<string, number>();
  // 429s the gateway served — the runner asserts at least one scripted
  // throttle happened (issue #54: the "429 retried away" lane must be able
  // to fail if the 429 never fired). Resettable via DELETE /smoke/status.
  const served429: Array<{ model: string; at: number }> = [];
  /** smoke-ui lanes: first call = translate, later calls = fill chunks —
   * tracked per model so repeat UI sessions can suffix a nonce. */
  const uiCursors = new Map<string, number>();
  return (req, res, next) => {
    const url =
      (req as { originalUrl?: string; url?: string }).originalUrl ??
      req.url ??
      "";
    if (url === "/smoke/status") {
      res.setHeader("content-type", "application/json");
      if (req.method === "DELETE") {
        served429.length = 0;
        cursors.clear();
      }
      res.end(JSON.stringify({ served429: served429.length, models: served429.map((s) => s.model) }));
      return;
    }
    if (url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          object: "list",
          data: [...Object.keys(BUCKETS), "smoke-ui", "smoke-ui-fail"].map((id) => ({ id })),
        }),
      );
      return;
    }
    if (url !== "/v1/chat/completions" || req.method !== "POST") {
      next();
      return;
    }
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      let body: { model?: string };
      try {
        body = JSON.parse(raw);
      } catch {
        res.statusCode = 400;
        res.end("smoke gateway: unparseable request body");
        return;
      }
      const model = body.model ?? "";
      // UI-visual lanes (issue #82): drive the REAL app UI against this
      // gateway so the fill grammar is browser-verified, not just unit-tested.
      // `smoke-ui`: first call translates (a tag search guaranteed to hit the
      // seeded corpus); later calls are fill chunks answered by ECHOING the
      // requested ids as KV records — delayed ~1.2s so the pending sweep is
      // visible — streamed as SSE when the lane asks for streamText.
      // `smoke-ui-fail`: same translate, then 500 on fills (the amber lane).
      if (model.startsWith("smoke-ui")) {
        const n = uiCursors.get(model) ?? 0;
        uiCursors.set(model, n + 1);
        // The request's last user message (narrowed, never cast at access).
        let lastUser = "";
        if (
          body !== null &&
          typeof body === "object" &&
          "messages" in body &&
          Array.isArray(body.messages)
        ) {
          const last = body.messages.at(-1) as unknown;
          if (last !== null && typeof last === "object" && "content" in last) {
            lastUser = String(last.content);
          }
        }
        if (n === 0) {
          // Translate: one seeded-corpus tag search + the question itself as
          // a NIP-50 free-text search (echo, clipped — the smoke MUST see
          // results even if only one route answers).
          const question =
            lastUser
              .split("\n")
              .filter((line) => line.trim() !== "")
              .at(-1)
              ?.slice(0, 60) ?? "";
          const answer = `kind: tag\nvalue: cc:LENS29-ROCA\n\nkind: text\nvalue: ${question}`;
          recordCorpus(model, {
            status: 200,
            body: { choices: [{ message: { role: "assistant", content: answer } }] },
          });
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: answer } }],
            }),
          );
          return;
        }
        if (model.startsWith("smoke-ui-fail")) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: { message: "smoke-ui-fail: scripted gateway failure", type: "server_error", code: 500 },
            }),
          );
          return;
        }
        let asked: Array<{ id: string }> = [];
        try {
          const parsed = JSON.parse(lastUser) as unknown;
          if (Array.isArray(parsed)) asked = parsed as Array<{ id: string }>;
        } catch {
          // node-fill lanes send a different prompt shape — the echo reads
          // nothing; an empty KV answer is the honest failure for that call.
        }
        const kv = asked
          .map(
            (a, i) =>
              `id: ${a.id}\ntitle: Smoke-interpreted card ${i + 1}\nsnippet: The fake gateway's whole-record interpretation for visual grammar verification — read, summarized, and painted as one record.`,
          )
          .join("\n\n");
        const wantsStream =
          body !== null && typeof body === "object" && "stream" in body && body.stream === true;
        // A beat of latency per fill chunk so the pending sweep reads on screen.
        setTimeout(() => {
          if (wantsStream) {
            res.statusCode = 200;
            res.setHeader("content-type", "text/event-stream");
            res.setHeader("cache-control", "no-cache");
            res.end(sseFrames(kv));
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: kv } }] }));
        }, 1200);
        return;
      }
      // Prefix match: a run may suffix the lane with a nonce (`smoke-translate-abc1`)
      // so bucket cursors stay fresh across reruns (issue #54: the smoke must
      // be rerunnable without IndexedDB interference; keyed-by-model caches
      // are bypassed by the unique model name).
      const lane = Object.keys(BUCKETS).find((k) => model === k || model.startsWith(`${k}-`));
      const scripted = lane ? BUCKETS[lane] : undefined;
      if (!lane || !scripted) {
        // Fail-closed: an unscripted model is a harness bug.
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              message: `smoke gateway: model "${model}" has no scripted bucket`,
              type: "invalid_request_error",
              code: 0,
            },
          }),
        );
        return;
      }
      const i = cursors.get(model) ?? 0;
      const next = scripted[Math.min(i, scripted.length - 1)];
      cursors.set(model, i + 1);
      recordCorpus(model, next);
      if (next.status === 429) served429.push({ model, at: Date.now() });
      res.statusCode = next.status;
      res.setHeader("content-type", "application/json");
      if (next.status === 429) res.setHeader("retry-after", "1");
      res.end(JSON.stringify(next.body));
    });
  };
}
