# Security Test Details

## What Phase 7 Tests

The security phase validates that the MCP server correctly rejects various attack vectors.

### Authentication (4 tests)
| Test | Request | Expected |
|------|---------|----------|
| No auth header | `POST /tools/X/call` without Authorization | 401 |
| Invalid API key | `Authorization: Bearer invalid_key` | 401 |
| Empty X-Payment | `X-Payment: ""` | 400 |
| Garbage X-Payment | `X-Payment: GARBAGE` | 400 |

### MPP Credential Forgery (3 tests)
| Test | Request | Expected |
|------|---------|----------|
| Empty Payment | `Authorization: Payment ` | 401 |
| Garbage credential | `Authorization: Payment garbage` | 400 |
| Wrong method | `method="stripe"` instead of `method="tempo"` | 400 |

### Cross-Protocol (1 test)
| Test | Request | Expected |
|------|---------|----------|
| x402 in MPP header | Base64 x402 payload in `Authorization: Payment` | 400 |

### Amount Manipulation (2 tests)
| Test | Request | Expected |
|------|---------|----------|
| Zero amount (x402) | `amount: "0"` in forged X-Payment | !200 |
| Zero amount (MPP) | `amount: "0"` in forged Payment | !200 |

### Session Security (1 test)
| Test | Request | Expected |
|------|---------|----------|
| Fake MCP session | `Mcp-Session-Id: fake-session` | !200 |

### Endpoint Discovery (1 test)
| Test | Request | Expected |
|------|---------|----------|
| Hidden endpoints | GET /api/v1/admin, /debug, /internal | 404 |

### Injection (1 test)
| Test | Request | Expected |
|------|---------|----------|
| SQL injection | `query: "'; DROP TABLE users; --"` | !500 |

## Replay (final 403)

A settled MPP credential sent a second time must never be served (P5, RED) and
is answered with a final `403` whose body carries
`error_code: credential_replayed` and `charged: false` (P5, rec). `400` stays acceptable only for forged or garbled
credentials (P8 `8.1b`). A `200` on a replayed credential is a CRITICAL error.
x402 replay keeps its cache-aware rule (200 is allowed only with `X-Cache: HIT`).

## Path-encoding bypass vectors (9)

P17 sends nine mangled paths with `curl --path-as-is` (undici normalizes most of
them away) and requires that none serves a paid tool without payment. Budget: $0.

| Vector | Path |
|--------|------|
| encoded slash | `/api/v1/tools/<id>%2Fcall` |
| encoded backslash | `/api/v1/tools/<id>%5Ccall` |
| raw backslash | `/api/v1/tools/<id>\call` |
| dot-dot after call | `/api/v1/tools/<id>/call/..%2F` |
| double slash | `/api/v1//tools/<id>/call` |
| upper-case prefix | `/API/v1/tools/<id>/call` |
| newline | `/api/v1/tools/<id>%0A/call` |
| MCP encoded slash | `/mcp%2F` |
| MCP dot-dot | `/mcp/..` |

## Payment transport in MCP _meta

A paid tool called over MCP without payment returns `isError: true` and
`result._meta["x402/payment-required"]`, whose `accepts[]` must equal the HTTP 402
body of the same tool (P4). The x402 payment travels back in
`params._meta["x402/payment"]` and the result carries
`_meta["x402/payment-response"]` (P4, one payment of about $0.001, counted in
`spentX402`). An MPP credential may travel in `Payment-Authorization` beside a
Bearer API key (200); credentials in both headers are refused with 400 (P5).

## What Passes

A test **passes** if the server returns the expected error code and does NOT:
- Return 200 with data (credential bypassed)
- Return 500 (server crash = vulnerability)
- Leak stack traces or internal state

## Adding Security Tests

Add new tests to `src/phases/07-security.js`. Follow the pattern:
```javascript
const r = await sf(`${config.apiUrl}/tools/X/call`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...attackHeaders },
  body: JSON.stringify(attackBody),
});
scorer.rec('P7', '7.X Test name', '!200', r.status, r.status !== 200);
```
