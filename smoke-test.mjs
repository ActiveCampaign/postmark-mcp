// Smoke test for the Postmark MCP server.
// Spawns ./index.js over stdio and exercises read-only tools.
// Skips: sendEmail, sendEmailWithTemplate, createTemplate, deleteTemplate,
//        createWebhook (real), deleteWebhook, activateBounce, createSuppressions,
//        deleteSuppressions — these mutate state.

import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["index.js"],
});

const client = new Client({ name: "smoke-test", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// 1. tools/list
const toolList = await client.listTools();
const toolNames = toolList.tools.map(t => t.name).sort();
const expected = 22;
record(`tools/list (${expected} expected)`, toolNames.length === expected, `${toolNames.length} tools: ${toolNames.join(", ")}`);

async function call(name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) {
      const text = r.content?.[0]?.text || "(no message)";
      return { ok: false, detail: `tool returned error: ${text.slice(0, 200)}` };
    }
    const text = r.content?.[0]?.text || "";
    return { ok: true, detail: text.split("\n")[0].slice(0, 120) };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

for (const [label, name, args] of [
  ["getServerInfo (Fix: PostFirstOpenOnly)",                 "getServerInfo", {}],
  ["listTemplates",                                          "listTemplates", {}],
  ["getDeliveryStats (default summary)",                     "getDeliveryStats", {}],
  ["getDeliveryStats stat=overview",                         "getDeliveryStats", { stat: "overview" }],
  ["getDeliveryStats stat=sent",                             "getDeliveryStats", { stat: "sent" }],
  ["getDeliveryStats stat=bounces",                          "getDeliveryStats", { stat: "bounces" }],
  ["getDeliveryStats stat=spam",                             "getDeliveryStats", { stat: "spam" }],
  ["getDeliveryStats stat=tracked",                          "getDeliveryStats", { stat: "tracked" }],
  ["getDeliveryStats stat=opens",                            "getDeliveryStats", { stat: "opens" }],
  ["getDeliveryStats stat=openClients (Fix: renamed)",       "getDeliveryStats", { stat: "openClients" }],
  ["getDeliveryStats stat=openPlatforms (Fix: renamed)",     "getDeliveryStats", { stat: "openPlatforms" }],
  ["getDeliveryStats stat=openReadTimes",                    "getDeliveryStats", { stat: "openReadTimes" }],
  ["getDeliveryStats stat=clicks",                           "getDeliveryStats", { stat: "clicks" }],
  ["getDeliveryStats stat=clickBrowsers",                    "getDeliveryStats", { stat: "clickBrowsers" }],
  ["getDeliveryStats stat=clickPlatforms",                   "getDeliveryStats", { stat: "clickPlatforms" }],
  ["getDeliveryStats stat=clickLocation",                    "getDeliveryStats", { stat: "clickLocation" }],
  ["searchOutboundMessages (count=1, messageStream filter)", "searchOutboundMessages", { count: 1, messageStream: process.env.DEFAULT_MESSAGE_STREAM }],
  ["diagnoseDelivery (known recipient)",                     "diagnoseDelivery", { recipient: "recipient@example.com" }],
  ["diagnoseDelivery (recipient with no recent sends)",      "diagnoseDelivery", { recipient: "no-recent-mail@example.com" }],
  ["searchBounces (count=1)",                                "searchBounces", { count: 1 }],
  ["listSuppressions",                                       "listSuppressions", {}],
  ["listWebhooks",                                           "listWebhooks", {}],
]) {
  const r = await call(name, args);
  record(label, r.ok, r.detail);
}

const noopEdit = await call("editTemplate", { templateIdOrAlias: "nonexistent" });
record("editTemplate refuses no-op (validation)",
  !noopEdit.ok && /at least one field/i.test(noopEdit.detail),
  noopEdit.detail);

const noTrigWebhook = await call("createWebhook", { url: "https://example.com/hook" });
record("createWebhook refuses zero triggers (validation)",
  !noTrigWebhook.ok && /at least one trigger/i.test(noTrigWebhook.detail),
  noTrigWebhook.detail);

await client.close();

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
