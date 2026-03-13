/**
 * @file Postmark MCP Server
 * @description Official Postmark MCP server for sending emails via Claude and AI assistants
 * @author Jabal Torres
 * @version 1.0.0
 * @license MIT
 */

import 'dotenv/config';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { version: clientVersion } = require('./package.json');

const POSTMARK_CLIENT_ID = 'postmark-mcp';
const POSTMARK_API_BASE = 'https://api.postmarkapp.com';

const serverToken = process.env.POSTMARK_SERVER_TOKEN;
const defaultSender = process.env.DEFAULT_SENDER_EMAIL;
const defaultMessageStream = process.env.DEFAULT_MESSAGE_STREAM;

/** Headers sent on all requests to Postmark API for client identification and correlation. */
function postmarkRequestHeaders() {
  return {
    'X-Postmark-Client': POSTMARK_CLIENT_ID,
    'X-Postmark-Client-Version': clientVersion,
    'X-Postmark-Correlation-Id': randomUUID()
  };
}

/** Make a request to the Postmark API with auth and client identification headers. */
async function postmarkRequest(path, options = {}) {
  const url = path.startsWith('http') ? path : `${POSTMARK_API_BASE}${path}`;
  const headers = {
    'Accept': 'application/json',
    'X-Postmark-Server-Token': serverToken,
    ...postmarkRequestHeaders(),
    ...options.headers
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, {
    ...options,
    headers
  });
  const text = await response.text();
  if (!response.ok) {
    let message = response.statusText;
    try {
      const data = JSON.parse(text);
      if (data.Message) message = data.Message;
    } catch (_) {}
    throw new Error(`API request failed: ${response.status} ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

// Initialize MCP server and verify Postmark token
async function initializeServices() {
  try {
    if (!serverToken) {
      console.error('[ERROR] POSTMARK_SERVER_TOKEN is not set');
      process.exit(1);
    }

    if (!defaultSender) {
      console.error('[ERROR] DEFAULT_SENDER_EMAIL is not set');
      process.exit(1);
    }

    if (!defaultMessageStream) {
      console.error('[ERROR] DEFAULT_MESSAGE_STREAM is not set');
      process.exit(1);
    }

    console.error('Initializing Postmark MCP server..');
    console.error('Default sender: ', defaultSender);
    console.error('Message stream: ', defaultMessageStream);

    await postmarkRequest('/server');

    const mcpServer = new McpServer({
      name: "postmark-mcp",
      version: "1.0.0"
    });

    return { mcpServer };
  } catch (error) {
    throw new Error(`Initialization failed: ${error.message}`);
  }
}

// Start the server
async function main() {
  try {
    const { mcpServer: server } = await initializeServices();

    registerTools(server);

    console.error('Connecting to MCP transport..');
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('Postmark MCP server is running and ready!');
    console.error(`Available tools: sendEmail, sendEmailWithTemplate, listTemplates, getDeliveryStats`);

    process.on('SIGTERM', () => handleShutdown(server));
    process.on('SIGINT', () => handleShutdown(server));
  } catch (error) {
    console.error('Server initialization failed: ', error.message);
    process.exit(1);
  }
}

// Graceful shutdown handler
async function handleShutdown(server) {
  console.error('Shutting down server..');

  try {
    await server.close();
    console.error('Server shutdown complete. Bye! 👋');
    process.exit(0);
  } catch (error) {
    console.error('[ERROR] Shutdown: ', error.message);
    process.exit(1);
  }
}

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception: ', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection: ', reason instanceof Error ? reason.message : reason);
  process.exit(1);
});

// Move tool registration to a separate function for better organization
function registerTools(server) {
  // Define and register the sendEmail tool
  server.tool(
    "sendEmail",
    {
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      textBody: z.string().describe("Plain text body of the email"),
      htmlBody: z.string().optional().describe("HTML body of the email (optional)"),
      from: z.string().email().optional().describe("Sender email address (optional, uses default if not provided)"),
      tag: z.string().optional().describe("Optional tag for categorization")
    },
    async ({ to, subject, textBody, htmlBody, from, tag }) => {
      const body = {
        From: from || defaultSender,
        To: to,
        Subject: subject,
        TextBody: textBody,
        MessageStream: defaultMessageStream,
        TrackOpens: true,
        TrackLinks: "HtmlAndText"
      };
      if (htmlBody) body.HtmlBody = htmlBody;
      if (tag) body.Tag = tag;

      console.error('Sending email..', { to, subject });
      const result = await postmarkRequest('/email', { method: 'POST', body: JSON.stringify(body) });
      if (result.ErrorCode !== 0) {
        throw new Error(result.Message || 'Failed to send email');
      }
      console.error('Email sent successfully: ', result.MessageID);

      return {
        content: [{
          type: "text",
          text: `Email sent successfully!\nMessageID: ${result.MessageID}\nTo: ${to}\nSubject: ${subject}`
        }]
      };
    }
  );

  // Define and register the sendEmailWithTemplate tool
  server.tool(
    "sendEmailWithTemplate",
    {
      to: z.string().email().describe("Recipient email address"),
      templateId: z.number().optional().describe("Template ID (use either this or templateAlias)"),
      templateAlias: z.string().optional().describe("Template alias (use either this or templateId)"),
      templateModel: z.object({}).passthrough().describe("Data model for template variables"),
      from: z.string().email().optional().describe("Sender email address (optional)"),
      tag: z.string().optional().describe("Optional tag for categorization")
    },
    async ({ to, templateId, templateAlias, templateModel, from, tag }) => {
      if (!templateId && !templateAlias) {
        throw new Error("Either templateId or templateAlias must be provided");
      }

      const body = {
        From: from || defaultSender,
        To: to,
        TemplateModel: templateModel,
        MessageStream: defaultMessageStream,
        TrackOpens: true,
        TrackLinks: "HtmlAndText"
      };
      if (templateId) body.TemplateId = templateId;
      else body.TemplateAlias = templateAlias;
      if (tag) body.Tag = tag;

      console.error('Sending template email..', { to, templateId: templateId || templateAlias });
      const result = await postmarkRequest('/email/withTemplate', { method: 'POST', body: JSON.stringify(body) });
      if (result.ErrorCode !== 0) {
        throw new Error(result.Message || 'Failed to send template email');
      }
      console.error('Template email sent successfully: ', result.MessageID);

      return {
        content: [{
          type: "text",
          text: `Template email sent successfully!\nMessageID: ${result.MessageID}\nTo: ${to}\nTemplate: ${templateId || templateAlias}`
        }]
      };
    }
  );

  // Define and register the listTemplates tool
  server.tool(
    "listTemplates",
    {},
    async () => {
      console.error('Fetching templates..');
      const result = await postmarkRequest('/templates?count=100&offset=0');
      const templates = result.Templates || [];
      console.error(`Found ${templates.length} templates`);

      const templateList = templates.map(t =>
        `• **${t.Name}**\n  - ID: ${t.TemplateId}\n  - Alias: ${t.Alias || 'none'}\n  - Subject: ${t.Subject ?? 'none'}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${templates.length} templates:\n\n${templateList}`
        }]
      };
    }
  );

  // Define and register the getDeliveryStats tool
  server.tool(
    "getDeliveryStats",
    {
      tag: z.string().optional().describe("Filter by tag (optional)"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format (optional)"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format (optional)")
    },
    async ({ tag, fromDate, toDate }) => {
      const query = [];
      if (fromDate) query.push(`fromdate=${encodeURIComponent(fromDate)}`);
      if (toDate) query.push(`todate=${encodeURIComponent(toDate)}`);
      if (tag) query.push(`tag=${encodeURIComponent(tag)}`);

      const url = `${POSTMARK_API_BASE}/stats/outbound${query.length ? '?' + query.join('&') : ''}`;

      console.error('Fetching delivery stats..');

      const data = await postmarkRequest(url);
      console.error('Stats retrieved successfully');

      const sent = data.Sent || 0;
      const tracked = data.Tracked || 0;
      const uniqueOpens = data.UniqueOpens || 0;
      const totalTrackedLinks = data.TotalTrackedLinksSent || 0;
      const uniqueLinksClicked = data.UniqueLinksClicked || 0;
      const openRate = tracked > 0 ? ((uniqueOpens / tracked) * 100).toFixed(1) : '0.0';
      const clickRate = totalTrackedLinks > 0 ? ((uniqueLinksClicked / totalTrackedLinks) * 100).toFixed(1) : '0.0';

      return {
        content: [{
          type: "text",
          text: `Email Statistics Summary\n\n` +
                `Sent: ${sent} emails\n` +
                `Open Rate: ${openRate}% (${uniqueOpens}/${tracked} tracked emails)\n` +
                `Click Rate: ${clickRate}% (${uniqueLinksClicked}/${totalTrackedLinks} tracked links)\n\n` +
                `${fromDate || toDate ? `Period: ${fromDate || 'start'} to ${toDate || 'now'}\n` : ''}` +
                `${tag ? `Tag: ${tag}\n` : ''}`
        }]
      };
    }
  );
}

main().catch((error) => {
  console.error('[ERROR] Failed to start server: ', error.message);
  process.exit(1);
});