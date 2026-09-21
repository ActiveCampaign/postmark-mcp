# Email attachments: verified constraints and decisions needed before implementation

**Status:** investigation complete, no implementation decision made
**Spike branch:** [`feature/email-attachments`](https://github.com/ActiveCampaign/postmark-mcp/tree/feature/email-attachments) ([compare against main](https://github.com/ActiveCampaign/postmark-mcp/compare/main...feature/email-attachments))

---

## The request

Users want to send an email with an image attached — a logo, a screenshot, a PDF invoice — through this MCP server. Postmark supports this natively (`Attachments: [{Name, Content, ContentType}]`, `Content` being base64), and the server does not currently expose it: none of the four sending tools accept files.

On the surface this is a small addition — map an `attachments` array onto Postmark's field and validate the inputs. We ran a spike to confirm that before scheduling it.

**The spike found that the straightforward implementation does not work for the primary use case.** The reasons are external to this codebase — they come from the MCP specification, from how assistants generate tool calls, and from where the server runs relative to the assistant calling it. This document records what we measured so the team can decide on an approach before committing to implementation.

## Verification summary

We implemented attachment support on the spike branch and drove real sends against a live Postmark account, from two different client environments, using the same source image (a 70 KB PNG).

| Scenario | Result |
|---|---|
| Assistant with local shell access, reads file mechanically, passes base64 | **Sends successfully** |
| Assistant without shell access, generates base64 into the tool call | **Fails**, 4/4 attempts |
| Server reads the file itself from a local path | **Sends successfully** |
| Server reads a path supplied by an assistant running in its own container | **Fails** — path does not exist on the server's filesystem |

The failure is reproducible and is not caused by the file, the validation logic, or Postmark. It is confirmed valid.

## What we measured

### The reported errors

Four consecutive attempts from an assistant generating base64 into the tool call, same source file:

```
content is not valid base64 — length is not a multiple of 4     (×3)
Invalid arguments: attachments[0].contentType — "Required"      (×1)
```

The fourth is the informative one. `contentType` sits immediately **after** `content` in field order, so a call that dies partway through the base64 never emits it. That is an output-length cutoff, not an encoding bug.

### Why: the payload is far larger than it looks

A **70 KB PNG is 93,264 base64 characters** — roughly 25–30k output tokens inside a single tool call. Base64 tokenizes poorly (~3–4 characters per token).

Truncating that string at every possible cut point and validating each one reproduces the reported errors in the observed proportions:

| Result | Share of cut points |
|---|---|
| `length is not a multiple of 4` | **75%** |
| decodes cleanly but fails structural (PNG chunk CRC) validation | **25%** |

Observed: the length error in 3 of 4 attempts. The distribution matches.

Note the 25% case: a truncated file whose length happens to land on a multiple of 4 **decodes without error**. Without a structural check it would be attached and sent — the recipient gets an email with an unopenable image and the API reports success.

### A second, independent limit

Even when the assistant can read the file, its own file-read tooling may cap returned content (~16k characters in the environment we observed). Assembling a 93k-character string then requires ~7 sequential reads spliced together by the model. A single dropped or misordered character corrupts the file, and a careful assistant will decline to attempt it.

## The three constraints

### 1. MCP has no client→server channel for file bytes

- **Tool arguments are JSON only**, validated against `inputSchema`. `ImageContent` and `BlobResourceContents` exist on the **result** side (server→client); there is no argument-side equivalent. ([tools spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools))
- **Roots** flow client→server but carry `file://` URIs, never bytes — and Claude Desktop does not support roots. ([roots spec](https://modelcontextprotocol.io/specification/2025-11-25/client/roots), [client support matrix](https://github.com/modelcontextprotocol/docs/blob/main/clients.mdx))
- **Elicitation** cannot request a file; form mode is restricted to flat primitives. ([elicitation spec](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation))

Anthropic's [MCP File Uploads working group](https://modelcontextprotocol.io/community/working-groups/file-uploads) charter describes this directly: servers needing a file from the user *"resort to prose instructions asking for base64 strings or local paths, which produces inconsistent UX and pushes encoding details onto end users."*

The protocol-level fix, **[SEP-2631](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631)** (file objects + authorized transfer), is an **open draft**. A prior attempt, SEP-2356, was **closed unmerged**.

### 2. Base64 in tool arguments is bounded by model output limits

Measured above. This is a property of how tool calls are generated, not something a server can validate its way out of. It affects any file beyond roughly a few KB.

### 3. The assistant and the server are frequently in different filesystems

The alternative to sending bytes is sending a path and having the server open the file. Whether that works depends on the deployment topology, and the intuitive mental model is often wrong.

In one setup we verified, the server runs as a **local subprocess on the user's own machine**, while the assistant calling it reasons inside a **separate container**, where conversation uploads are mounted at paths like `/mnt/user-data/uploads/`. Those paths are real to the assistant and unreachable to the server. Worth stating precisely: the server was *not* remote — the model was.

## Who this affects: deployment topology

Which approaches are even available depends on two independent variables. This matrix is probably the most useful input to the decision:

| | **Assistant can read local files** (shell/filesystem access) | **Assistant runs in its own container** |
|---|---|---|
| **Server runs locally** (stdio subprocess) | base64 works (mechanical read); path works | base64 truncates; path works **only** for files already on the user's machine, and only if the assistant learns the path |
| **Server runs remotely** (hosted/cloud) | base64 works; **path never works** — no shared filesystem | base64 truncates; **path never works**. No available route |

The bottom-right cell is the one to focus on: **a cloud-hosted server plus a containerized assistant has no working route today.** A file the user drags into the conversation falls here regardless of where the server runs — it has no bytes we can receive and no path we can open.

We verified the top row directly. The bottom row is reasoned from the same constraints rather than measured; we did not stand up a hosted deployment.

## Problem statement

> Provide a way for a user to attach a file to an outbound email that works across the deployment topologies this server actually runs in — given that MCP offers no mechanism to transfer file bytes from client to server, and that embedding the bytes in tool arguments is bounded by model output limits well below common file sizes.

A useful reframing that emerged from the spike: two problems are easily conflated.

1. **Byte transfer** — getting an uploaded file's bytes to the server. Blocked at the protocol level.
2. **Discovery** — the assistant learning *where* a file that already exists on an accessible filesystem lives. Not blocked, but unsolved in our current design.

For many real requests the file already exists somewhere accessible — a logo in `~/Downloads`, a screenshot on the Desktop. Those cases need discovery, not transfer. How much of the problem space that covers is itself an open question (see below).

## Decisions to make

### 1. Which topologies do we commit to supporting?

This scopes everything else. Supporting only local-server deployments makes path-based input viable. Committing to hosted deployments rules it out and forces either byte transfer (bounded) or an out-of-band mechanism.

*Consideration:* the npm package is consumed as a local stdio server today, but hosted MCP is growing. A decision that quietly assumes local may age badly.

### 2. Do we ship a partial solution, or wait for the protocol?

SEP-2631 would make this largely moot, but it is a draft with no ship date.

*Opportunity:* a path-based input solves a real subset immediately and is a small change.
*Challenge:* it works for developers and poorly for the non-technical users this server also targets, and it may become redundant. Shipping an input mode we later deprecate has a migration cost.

### 3. Where should file discovery live, if we do it?

If path-based input is on the table, something has to supply the path. Options include the user typing it, this server offering a discovery tool over standard folders, or composing with a filesystem MCP server.

*Opportunity:* discovery inside this server keeps a marketing user in one tool — *"the logo in my Downloads"* — with no second install.
*Challenge:* it puts a filesystem-listing surface into an email server. Combined with sending, that is an exfiltration path if a filename ever originates from untrusted content, and it argues for a required allowlist rather than an optional one.

### 4. What is the acceptable failure mode?

Some requests will remain impossible. The spike found this matters more than expected: an error reading *"length is not a multiple of 4"* is interpreted as an encoding problem, and assistants retry identically and fail identically. An error that names the real cause and the alternative ends the loop.

*Consideration:* whatever we build, error text is part of the interface, not an afterthought.

### 5. How much do we validate before sending?

The 25% case above — truncated data that decodes cleanly — sends a broken attachment with a success response. A magic-bytes check does not catch it, because the header survives truncation intact. Structural checks (PNG chunk CRCs, JPEG/GIF end markers, WEBP declared size, PDF `%%EOF`) do.

*Consideration:* this cost is worth weighing independently of the input-mode decision, since silent corruption is worse than a rejected send.

### 6. Do we scope attachment types or sizes more tightly than Postmark does?

Postmark allows 10 MB per message and forbids a specific extension list. We could be more conservative.

*Consideration:* a full-resolution phone photo is 3–8 MB before base64 inflation (~33%), so Postmark's ceiling is easier to hit than it appears.

## What we have not determined

- Whether a hosted deployment behaves as reasoned in the matrix (not measured).
- What share of real user requests involve a file already on an accessible filesystem versus one that exists only as a conversation upload. This materially affects whether discovery is sufficient, and we have no data on it.
- Whether other MCP servers facing this problem have converged on a pattern worth adopting.
- Whether Postmark has, or would consider, an asset-hosting endpoint that would sidestep client-side transfer entirely.

---

## Reproducing this yourself

The spike branch is pushed so anyone can verify the findings independently. It is **not proposed for merge** — it exists to produce these measurements.

```bash
git fetch origin
git checkout feature/email-attachments
npm install
```

### Run the test suites (no Postmark account required)

```bash
npm test
```

```bash
npm run test:offline
```

On the branch these report 92 unit tests and 19 offline MCP-wiring tests passing. The unit suite covers base64 validation, the structural-integrity checks, Postmark's size limits, and path handling; the offline suite drives the actual MCP tools over stdio.

### Reproduce the 75/25 truncation distribution

Save as `repro-truncation.mjs` in the repo root on the branch, then run it against any PNG:

```js
import { readFileSync } from 'fs';
import { validateAttachment } from './lib/attachments.js';

const buf = readFileSync(process.argv[2]);
const full = buf.toString('base64');
console.log(`${buf.length} bytes on disk -> ${full.length} base64 characters`);

let lenErr = 0, structErr = 0, other = 0;
for (let cut = 1000; cut < full.length; cut += 7) {
  try {
    validateAttachment({ name: 'x.png', content: full.slice(0, cut), contentType: 'image/png' }, 'a');
    other++;
  } catch (e) {
    if (e.message.includes('multiple of 4')) lenErr++;
    else if (e.message.includes('structural validation')) structErr++;
    else other++;
  }
}
const total = lenErr + structErr + other;
console.log(`not a multiple of 4:    ${(100 * lenErr / total).toFixed(1)}%`);
console.log(`fails structural check: ${(100 * structErr / total).toFixed(1)}%`);
console.log(`passes / other:         ${(100 * other / total).toFixed(1)}%`);
```

```bash
node repro-truncation.mjs /path/to/any-image.png
```

Every cut point simulates a tool call that ran out of output partway through the base64. The output shows how a truncated payload fails — and how often it fails *silently enough to send*.

### Reproduce the end-to-end send

Requires a Postmark account. Copy `smoke-test-mutating.example.mjs` to `smoke-test-mutating.mjs`, set `SENDER` and `RECIPIENT` to two verified sender signatures, then run it. It exercises valid attachments, a deliberately corrupted attachment, and a nonexistent path, and cleans up after itself.

### Try the failing case directly

Point any assistant *without* local shell access at the branch build and ask it to attach a ~70 KB image by generating the base64 itself. Expect the errors in the "What we measured" section. Then ask an assistant *with* shell access to do the same — it will succeed, because the bytes never pass through model output.

## How this was verified

1. Implemented `attachments` on the four sending tools, mapping to Postmark's field.
2. Sent real emails against a live Postmark account from two client environments with the same 70 KB PNG.
3. Compared failures against the file's actual base64, confirming the file and validation logic were correct.
4. Truncated the base64 at every possible cut point and validated each, producing the 75/25 distribution.
5. Read the MCP specification and working-group material for a supported byte-transfer mechanism; found none.
6. Inspected a real client configuration to confirm the server ran locally while the assistant did not.

## References

- MCP File Uploads working group — https://modelcontextprotocol.io/community/working-groups/file-uploads
- SEP-2631, file objects and transfer (open draft) — https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631
- MCP tools specification — https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- MCP roots specification — https://modelcontextprotocol.io/specification/2025-11-25/client/roots
- MCP client feature support matrix — https://github.com/modelcontextprotocol/docs/blob/main/clients.mdx
- Postmark attachment and size limits — https://postmarkapp.com/support/article/1056-what-are-the-attachment-and-email-size-limits
- Postmark send-a-single-email (forbidden extensions) — https://postmarkapp.com/developer/user-guide/send-email-with-api/send-a-single-email
