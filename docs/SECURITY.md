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
