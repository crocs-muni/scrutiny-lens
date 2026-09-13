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
 * The dev middleware. Falls through to Vite for non-gateway requests.
 */
export function smokeGatewayMiddleware(): Connect.NextHandleFunction {
  const cursors = new Map<string, number>();
  // 429s the gateway served — the runner asserts at least one scripted
  // throttle happened (issue #54: the "429 retried away" lane must be able
  // to fail if the 429 never fired). Resettable via DELETE /smoke/status.
  const served429: Array<{ model: string; at: number }> = [];
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
          data: Object.keys(BUCKETS).map((id) => ({ id })),
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
