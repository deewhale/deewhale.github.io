# Pi 1.3.0 MCP + Code Mode integration example

Requirements: Node.js >= 22.19 and npm. Download `package.json`, `package-lock.json`, `mock-docs.mjs`, `upgrade.js`, and `verify-mcp.mjs` into one empty directory, then:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

The runner creates isolated configuration and in-memory sessions, launches a real read-only stdio MCP child server, loads the official MCP/tool-search/Code Mode extensions, and closes the server after each run. No user account, model API or OAuth token is used. Node has filesystem access to create temporary fixtures; the Code Mode script runs inside the official QuickJS worker.

Model messages are **hand-authored** fixtures. To skip provider authentication, the runner enters `session.agent.prompt()` after `bindExtensions()` and replaces `prepareRequest` with an identity fixture. It waits for the mock tool registry before each run. This tests MCP JSON-RPC → tool registration → direct calls/tool_search/QuickJS → shared tool hooks → model-visible result transformation, not `session.prompt()` authentication, first-prompt startup waiting, model planning, remote networking or OAuth.

`mock-docs.mjs` deliberately repeats a short filler string in each release's evidence field to trigger the official model-facing text truncation. That content is artificial. `upgrade.js` is a Code Mode script: it discovers the tools, inspects a declaration, reads releases in parallel, checks `isError`, and returns only the selected evidence prefix. It is not a Node program and is consumed by the runner.

The four requested release IDs are `1.0`, `1.1`, `1.2`, `missing`; the last returns an MCP `isError` result. Code Mode's `Promise.allSettled` sees that response as fulfilled and the script explicitly marks it `tool_error`.

Expected summary:

| Route | Prescribed provider requests including final fixture answer | Model result text characters | Tool hook events | Nested hook events |
|---|---:|---:|---:|---:|
| direct | 3 | 62155 | 10 | 0 |
| deferred | 4 | 62325 | 12 | 0 |
| codemode | 2 | 884 | 12 | 10 |

These counts are observations of this deterministic fixture, **not token counts, latency benchmarks, model quality, universal round counts or business cost savings**. Direct mode batches the independent reads in one assistant message; it does not call one model per file. The Code Mode output includes its discovery and schema text on purpose. The runner asserts paths/errors and prints only sanitized summaries; it does not print raw long results or temporary output paths.

The runner also checks the task's actual data. Code Mode's final script return must exactly equal:

```json
[
  {"version":"1.0","breaking":[],"evidence":"Release 1.0: verified fixture line\n"},
  {"version":"1.1","breaking":["rename retryLimit to retries"],"evidence":"Release 1.1: verified fixture line\n"},
  {"version":"1.2","breaking":[],"evidence":"Release 1.2: verified fixture line\n"},
  {"version":"missing","status":"tool_error"}
]
```

`contentCheck.scope` is `exact_script_return` for Code Mode. Its final array is parsed from the known fixture renderer's last text line, not with a general MCP parser. The direct and deferred routes receive truncated model-facing text. For those routes, the runner checks only known retained version/breaking/evidence fields and the missing-version error; their scope is `known_retained_text_fields_only`. It does not assert that the entire truncated documents are equivalent to the complete script results, or that the evidence is sufficient for a real upgrade decision.

The fixture therefore yields one concrete migration check, renaming `retryLimit` to `retries` for version 1.1, and one unresolved input, `missing`. A final answer must preserve that incomplete coverage. The prescribed final model message does not perform or validate this substantive judgment.
