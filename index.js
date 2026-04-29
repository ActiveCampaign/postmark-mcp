/**
 * @file Postmark MCP Server
 * @description Official Postmark MCP server for sending emails via Claude and AI assistants
 * @author Jabal Torres
 * @version 1.0.0
 * @license MIT
 */

import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import postmark from "postmark";

const serverToken = process.env.POSTMARK_SERVER_TOKEN;
const defaultSender = process.env.DEFAULT_SENDER_EMAIL;
const defaultMessageStream = process.env.DEFAULT_MESSAGE_STREAM;

// Initialize Postmark client and MCP server
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

    const client = new postmark.ServerClient(serverToken);

    // Verify Postmark client by making a test API call
    await client.getServer();

    const mcpServer = new McpServer({
      name: "postmark-mcp",
      version: "1.0.0"
    });

    return { postmarkClient: client, mcpServer };
  } catch (error) {
    if (error.code || error.message) {
      throw new Error(`Initialization failed: ${error.code ? `${error.code} - ` : ''}${error.message}`);
    }

    throw new Error('Initialization failed: An unexpected error occurred');
  }
}

// Start the server
async function main() {
  try {
    const { postmarkClient, mcpServer: server } = await initializeServices();

    registerTools(server, postmarkClient);

    console.error('Connecting to MCP transport..');
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('Postmark MCP server is running and ready!');
    console.error('Available tools (24): sendEmail, sendEmailWithTemplate, sendBatch, sendBatchWithTemplate, ' +
      'listTemplates, getTemplate, createTemplate, editTemplate, deleteTemplate, validateTemplate, ' +
      'searchOutboundMessages, getMessageDetails, diagnoseDelivery, ' +
      'searchBounces, getBounceDump, activateBounce, ' +
      'listSuppressions, createSuppressions, deleteSuppressions, ' +
      'getDeliveryStats, getServerInfo, ' +
      'listWebhooks, createWebhook, deleteWebhook');

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

// ───── Formatting helpers ─────

const fmtInt = n => (n ?? 0).toLocaleString('en-US');

const fmtPct = (numerator, denominator) => {
  if (!denominator) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
};

// Render { Desktop, Mobile, WebMail, Unknown } breakdown with percentages
const fmtPlatformUsage = (data) => {
  const buckets = ['Desktop', 'Mobile', 'WebMail', 'Unknown'];
  const total = buckets.reduce((sum, k) => sum + (data[k] || 0), 0);
  if (total === 0) return '  (no data in range)';
  return buckets
    .map(k => `  ${k.padEnd(8)} ${fmtInt(data[k] || 0).padStart(8)}  (${fmtPct(data[k] || 0, total)})`)
    .join('\n');
};

// Render top-N { name: count } breakdown sorted descending. Skips `Days`.
const fmtTopBreakdown = (data, limit = 10) => {
  const entries = Object.entries(data)
    .filter(([k, v]) => k !== 'Days' && typeof v === 'number')
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '  (no data in range)';
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  const shown = entries.slice(0, limit);
  const lines = shown.map(([k, v]) =>
    `  ${k.padEnd(20)} ${fmtInt(v).padStart(8)}  (${fmtPct(v, total)})`
  );
  if (entries.length > limit) {
    lines.push(`  ${`… and ${entries.length - limit} more`}`);
  }
  return lines.join('\n');
};

// Render delivery summary (default behavior of getDeliveryStats — v1 compatible)
const fmtDeliverySummary = (d, { fromDate, toDate, tag, messageStream } = {}) => {
  const sent = d.Sent || 0;
  const tracked = d.Tracked || 0;
  const bounced = d.Bounced || 0;
  const spam = d.SpamComplaints || 0;
  const uniqueOpens = d.UniqueOpens || 0;
  const totalLinks = d.TotalTrackedLinksSent || 0;
  const uniqueClicks = d.UniqueLinksClicked || 0;

  const lines = [
    'Email Delivery Summary',
    '',
    `Sent:        ${fmtInt(sent)}`,
    `Tracked:     ${fmtInt(tracked)}  (${fmtPct(tracked, sent)} of sent)`,
    `Open rate:   ${fmtPct(uniqueOpens, tracked)}  (${fmtInt(uniqueOpens)}/${fmtInt(tracked)} unique opens)`,
    `Click rate:  ${fmtPct(uniqueClicks, totalLinks)}  (${fmtInt(uniqueClicks)}/${fmtInt(totalLinks)} unique links clicked)`,
    `Bounced:     ${fmtInt(bounced)}  (${fmtPct(bounced, sent)})`,
    `Spam:        ${fmtInt(spam)}  (${fmtPct(spam, sent)})`,
  ];

  const filters = [];
  if (fromDate || toDate) filters.push(`Period: ${fromDate || 'start'} → ${toDate || 'now'}`);
  if (tag) filters.push(`Tag: ${tag}`);
  if (messageStream) filters.push(`Stream: ${messageStream}`);
  if (filters.length) {
    lines.push('');
    lines.push(...filters);
  }

  return lines.join('\n');
};

// Format any of the per-stat responses returned by getDeliveryStats
const fmtStatResponse = (stat, d) => {
  switch (stat) {
    case 'overview':
      return [
        'Outbound Overview',
        '',
        `Sent:                ${fmtInt(d.Sent)}`,
        `Bounced:             ${fmtInt(d.Bounced)}  (${(d.BounceRate ?? 0).toFixed(2)}%)`,
        `SMTP API errors:     ${fmtInt(d.SMTPApiErrors)}`,
        `Spam complaints:     ${fmtInt(d.SpamComplaints)}  (${(d.SpamComplaintsRate ?? 0).toFixed(2)}%)`,
        `Tracked:             ${fmtInt(d.Tracked)}`,
        `Opens (total):       ${fmtInt(d.Opens)}`,
        `Opens (unique):      ${fmtInt(d.UniqueOpens)}`,
        `Tracked links sent:  ${fmtInt(d.TotalTrackedLinksSent)}`,
        `Total clicks:        ${fmtInt(d.TotalClicks)}`,
        `Unique link clicks:  ${fmtInt(d.UniqueLinksClicked)}`,
        `With open tracking:  ${fmtInt(d.WithOpenTracking)}`,
        `With link tracking:  ${fmtInt(d.WithLinkTracking)}`,
      ].join('\n');

    case 'sent':
      return `Sent\n\n  Total: ${fmtInt(d.Sent)}`;

    case 'bounces': {
      const typeEntries = Object.entries(d)
        .filter(([k, v]) => k !== 'Days' && k !== 'Total' && typeof v === 'number' && v > 0)
        .sort((a, b) => b[1] - a[1]);
      const total = typeEntries.reduce((sum, [, v]) => sum + v, 0);
      if (total === 0) return 'Bounces\n\n  (no bounces in range)';
      const types = typeEntries
        .map(([k, v]) => `  ${k.padEnd(24)} ${fmtInt(v).padStart(8)}  (${fmtPct(v, total)})`)
        .join('\n');
      return `Bounces\n\n  Total: ${fmtInt(total)}\n\n${types}`;
    }

    case 'spam':
      return `Spam Complaints\n\n  Total: ${fmtInt(d.SpamComplaint)}`;

    case 'tracked':
      return `Tracked Emails\n\n  Total: ${fmtInt(d.Tracked)}`;

    case 'opens':
      return [
        'Email Opens',
        '',
        `  Total opens:    ${fmtInt(d.Opens)}`,
        `  Unique opens:   ${fmtInt(d.Unique)}`,
      ].join('\n');

    case 'openPlatforms':
      return `Open Platform Usage\n\n${fmtPlatformUsage(d)}`;

    case 'openClients':
      return `Email Client Usage (top 10)\n\n${fmtTopBreakdown(d)}`;

    case 'openReadTimes':
      return `Open Read Times\n\n${fmtTopBreakdown(d)}`;

    case 'clicks':
      return [
        'Link Clicks',
        '',
        `  Total clicks:   ${fmtInt(d.Clicks)}`,
        `  Unique clicks:  ${fmtInt(d.Unique)}`,
      ].join('\n');

    case 'clickBrowsers':
      return `Click Browser Usage (top 10)\n\n${fmtTopBreakdown(d)}`;

    case 'clickPlatforms':
      return `Click Platform Usage\n\n${fmtPlatformUsage(d)}`;

    case 'clickLocation': {
      const html = d.HTML || 0;
      const text = d.Text || 0;
      const total = html + text;
      return [
        'Click Location',
        '',
        `  HTML:  ${fmtInt(html).padStart(8)}  (${fmtPct(html, total)})`,
        `  Text:  ${fmtInt(text).padStart(8)}  (${fmtPct(text, total)})`,
      ].join('\n');
    }

    default:
      return JSON.stringify(d, null, 2);
  }
};

// Tool registration
function registerTools(server, postmarkClient) {
  // ─────────────── Email ───────────────

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
      const emailData = {
        From: from || defaultSender,
        To: to,
        Subject: subject,
        TextBody: textBody,
        MessageStream: defaultMessageStream,
        TrackOpens: true,
        TrackLinks: "HtmlAndText"
      };

      if (htmlBody) emailData.HtmlBody = htmlBody;
      if (tag) emailData.Tag = tag;

      console.error('Sending email..', { to, subject });
      const result = await postmarkClient.sendEmail(emailData);
      console.error('Email sent successfully: ', result.MessageID);

      return {
        content: [{
          type: "text",
          text: `Email sent successfully!\nMessageID: ${result.MessageID}\nTo: ${to}\nSubject: ${subject}`
        }]
      };
    }
  );

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

      const emailData = {
        From: from || defaultSender,
        To: to,
        TemplateModel: templateModel,
        MessageStream: defaultMessageStream,
        TrackOpens: true,
        TrackLinks: "HtmlAndText"
      };

      if (templateId) {
        emailData.TemplateId = templateId;
      } else {
        emailData.TemplateAlias = templateAlias;
      }

      if (tag) emailData.Tag = tag;

      console.error('Sending template email..', { to, templateId: templateId || templateAlias });
      const result = await postmarkClient.sendEmailWithTemplate(emailData);
      console.error('Template email sent successfully: ', result.MessageID);

      return {
        content: [{
          type: "text",
          text: `Template email sent successfully!\nMessageID: ${result.MessageID}\nTo: ${to}\nTemplate: ${templateId || templateAlias}`
        }]
      };
    }
  );

  // ─────────────── Batch send ───────────────

  // Format batch send results into successes / failures summary.
  // Postmark returns one MessageSendingResponse per input message; ErrorCode
  // 0 indicates success. Failed sends still come back with `To` and a
  // `Message` describing why.
  const formatBatchResults = (results) => {
    const successes = results.filter(r => r.ErrorCode === 0);
    const failures = results.filter(r => r.ErrorCode !== 0);
    const lines = [`Sent ${successes.length}/${results.length} successfully` +
      (failures.length ? ` (${failures.length} failed)` : '')];

    if (failures.length) {
      lines.push('', 'Failures:');
      failures.slice(0, 20).forEach(f => {
        lines.push(`  - ${f.To || '(unknown)'} — ${f.ErrorCode}: ${f.Message}`);
      });
      if (failures.length > 20) lines.push(`  - ... and ${failures.length - 20} more`);
    }

    if (successes.length) {
      lines.push('', `Successes${successes.length > 10 ? ' (first 10 shown)' : ''}:`);
      successes.slice(0, 10).forEach(s => {
        lines.push(`  - ${s.To} — ${s.MessageID}`);
      });
      if (successes.length > 10) lines.push(`  - ... and ${successes.length - 10} more successful sends`);
    }

    return lines.join('\n');
  };

  server.tool(
    "sendBatch",
    {
      messages: z.array(z.object({
        to: z.string().email().describe("Recipient email address"),
        subject: z.string().describe("Email subject"),
        textBody: z.string().describe("Plain text body"),
        htmlBody: z.string().optional().describe("HTML body"),
        from: z.string().email().optional().describe("Sender (defaults to DEFAULT_SENDER_EMAIL)"),
        cc: z.string().optional().describe("CC recipient(s), comma-separated"),
        bcc: z.string().optional().describe("BCC recipient(s), comma-separated"),
        replyTo: z.string().email().optional().describe("Reply-To address"),
        tag: z.string().optional().describe("Tag for categorization")
      })).min(1).max(500).describe("Up to 500 messages to send in a single request")
    },
    async ({ messages }) => {
      const payload = messages.map(m => {
        const msg = {
          From: m.from || defaultSender,
          To: m.to,
          Subject: m.subject,
          TextBody: m.textBody,
          MessageStream: defaultMessageStream,
          TrackOpens: true,
          TrackLinks: "HtmlAndText"
        };
        if (m.htmlBody) msg.HtmlBody = m.htmlBody;
        if (m.cc) msg.Cc = m.cc;
        if (m.bcc) msg.Bcc = m.bcc;
        if (m.replyTo) msg.ReplyTo = m.replyTo;
        if (m.tag) msg.Tag = m.tag;
        return msg;
      });

      console.error('Sending batch..', { count: payload.length });
      const results = await postmarkClient.sendEmailBatch(payload);
      const failures = results.filter(r => r.ErrorCode !== 0).length;
      console.error(`Batch sent: ${results.length - failures}/${results.length} succeeded`);

      return { content: [{ type: "text", text: formatBatchResults(results) }] };
    }
  );

  server.tool(
    "sendBatchWithTemplate",
    {
      templateId: z.number().int().optional().describe("Template ID (use either this or templateAlias)"),
      templateAlias: z.string().optional().describe("Template alias (use either this or templateId)"),
      from: z.string().email().optional().describe("Default sender for all messages (defaults to DEFAULT_SENDER_EMAIL)"),
      tag: z.string().optional().describe("Default tag applied to all messages (overridable per-recipient)"),
      recipients: z.array(z.object({
        to: z.string().email().describe("Recipient email address"),
        templateModel: z.object({}).passthrough().describe("Per-recipient template variables"),
        from: z.string().email().optional().describe("Override sender for this recipient"),
        cc: z.string().optional().describe("CC recipient(s), comma-separated"),
        bcc: z.string().optional().describe("BCC recipient(s), comma-separated"),
        replyTo: z.string().email().optional().describe("Reply-To address"),
        tag: z.string().optional().describe("Override tag for this recipient")
      })).min(1).max(500).describe("Up to 500 recipients, each with their own template model")
    },
    async ({ templateId, templateAlias, from, tag, recipients }) => {
      if (!templateId && !templateAlias) {
        throw new Error("Either templateId or templateAlias must be provided");
      }
      if (templateId && templateAlias) {
        throw new Error("Provide only one of templateId or templateAlias, not both");
      }

      const payload = recipients.map(r => {
        const msg = {
          From: r.from || from || defaultSender,
          To: r.to,
          TemplateModel: r.templateModel,
          MessageStream: defaultMessageStream,
          TrackOpens: true,
          TrackLinks: "HtmlAndText"
        };
        if (templateId) msg.TemplateId = templateId;
        else msg.TemplateAlias = templateAlias;
        if (r.cc) msg.Cc = r.cc;
        if (r.bcc) msg.Bcc = r.bcc;
        if (r.replyTo) msg.ReplyTo = r.replyTo;
        const effectiveTag = r.tag ?? tag;
        if (effectiveTag) msg.Tag = effectiveTag;
        return msg;
      });

      console.error('Sending template batch..', { count: payload.length, template: templateId || templateAlias });
      const results = await postmarkClient.sendEmailBatchWithTemplates(payload);
      const failures = results.filter(r => r.ErrorCode !== 0).length;
      console.error(`Template batch sent: ${results.length - failures}/${results.length} succeeded`);

      return { content: [{ type: "text", text: formatBatchResults(results) }] };
    }
  );

  // ─────────────── Templates ───────────────

  server.tool(
    "listTemplates",
    {},
    async () => {
      console.error('Fetching templates..');
      const result = await postmarkClient.getTemplates();
      console.error(`Found ${result.Templates.length} templates`);

      const templateList = result.Templates.map(t => {
        const lines = [
          `• **${t.Name}**`,
          `  - ID: ${t.TemplateId}`,
          `  - Alias: ${t.Alias || 'none'}`,
          `  - Subject: ${t.Subject || 'none'}`,
        ];
        if (t.TemplateType) lines.push(`  - Type: ${t.TemplateType}`);
        if (t.LayoutTemplate) lines.push(`  - Layout: ${t.LayoutTemplate}`);
        return lines.join('\n');
      }).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.Templates.length} templates:\n\n${templateList}`
        }]
      };
    }
  );

  server.tool(
    "getTemplate",
    {
      templateIdOrAlias: z.union([z.number(), z.string()]).describe("Template ID (number) or alias (string)")
    },
    async ({ templateIdOrAlias }) => {
      console.error('Fetching template..', { templateIdOrAlias });
      const result = await postmarkClient.getTemplate(templateIdOrAlias);
      console.error('Template retrieved');

      return {
        content: [{
          type: "text",
          text: `Template: ${result.Name}\n\n` +
            `ID: ${result.TemplateId}\n` +
            `Alias: ${result.Alias || 'none'}\n` +
            `Subject: ${result.Subject}\n` +
            `Type: ${result.TemplateType}\n` +
            `Layout: ${result.LayoutTemplate || 'none'}\n` +
            `Active: ${result.Active}\n` +
            `Associated Server: ${result.AssociatedServerId}\n\n` +
            `--- HTML Body ---\n${result.HtmlBody || '(empty)'}\n\n` +
            `--- Text Body ---\n${result.TextBody || '(empty)'}`
        }]
      };
    }
  );

  server.tool(
    "createTemplate",
    {
      name: z.string().describe("Template name"),
      subject: z.string().optional().describe("Template subject line. Required for Standard templates; must be omitted for Layout templates (Postmark rejects Subject on Layouts)."),
      htmlBody: z.string().optional().describe("HTML content of the template"),
      textBody: z.string().optional().describe("Plain text content of the template"),
      alias: z.string().optional().describe("A unique alias for the template (letters, numbers, dots, hyphens, underscores)"),
      templateType: z.enum(["Standard", "Layout"]).optional().describe("Template type (default: Standard)"),
      layoutTemplate: z.string().optional().describe("Alias of an existing Layout template to wrap this template's content. Only valid when templateType is 'Standard' (the default).")
    },
    async ({ name, subject, htmlBody, textBody, alias, templateType, layoutTemplate }) => {
      if (!htmlBody && !textBody) {
        throw new Error("At least one of htmlBody or textBody must be provided");
      }
      const isLayout = templateType === "Layout";
      if (!isLayout && !subject) {
        throw new Error("Subject is required for Standard templates");
      }
      if (isLayout && subject) {
        throw new Error("Subject must not be provided for Layout templates — Postmark rejects this field on Layouts");
      }
      if (layoutTemplate && isLayout) {
        throw new Error("layoutTemplate cannot be set on a Layout template — only Standard templates wrap a layout");
      }

      const options = { Name: name };
      if (subject) options.Subject = subject;
      if (htmlBody) options.HtmlBody = htmlBody;
      if (textBody) options.TextBody = textBody;
      if (alias) options.Alias = alias;
      if (templateType) options.TemplateType = templateType;
      if (layoutTemplate) options.LayoutTemplate = layoutTemplate;

      console.error('Creating template..', { name });
      const result = await postmarkClient.createTemplate(options);
      console.error('Template created: ', result.TemplateId);

      return {
        content: [{
          type: "text",
          text: `Template created successfully!\n\n` +
            `ID: ${result.TemplateId}\n` +
            `Name: ${result.Name}\n` +
            `Alias: ${result.Alias || 'none'}\n` +
            `Layout: ${result.LayoutTemplate || 'none'}\n` +
            `Active: ${result.Active}`
        }]
      };
    }
  );

  server.tool(
    "editTemplate",
    {
      templateIdOrAlias: z.union([z.number(), z.string()]).describe("Template ID (number) or alias (string)"),
      name: z.string().optional().describe("Updated template name"),
      subject: z.string().optional().describe("Updated subject line"),
      htmlBody: z.string().optional().describe("Updated HTML content"),
      textBody: z.string().optional().describe("Updated plain text content"),
      alias: z.string().optional().describe("Updated alias"),
      layoutTemplate: z.string().nullable().optional().describe("Alias of a Layout template to bind this Standard template to. Pass null to unbind (remove the layout association).")
    },
    async ({ templateIdOrAlias, name, subject, htmlBody, textBody, alias, layoutTemplate }) => {
      const options = {};
      if (name) options.Name = name;
      if (subject) options.Subject = subject;
      if (htmlBody) options.HtmlBody = htmlBody;
      if (textBody) options.TextBody = textBody;
      if (alias) options.Alias = alias;
      // Postmark's edit endpoint treats JSON null as "no change". Sending an
      // empty string is the documented way to unbind a layout association.
      if (layoutTemplate !== undefined) {
        options.LayoutTemplate = layoutTemplate === null ? "" : layoutTemplate;
      }

      if (Object.keys(options).length === 0) {
        throw new Error("Provide at least one field to update (name, subject, htmlBody, textBody, alias, or layoutTemplate)");
      }

      console.error('Editing template..', { templateIdOrAlias });
      const result = await postmarkClient.editTemplate(templateIdOrAlias, options);
      console.error('Template updated: ', result.TemplateId);

      return {
        content: [{
          type: "text",
          text: `Template updated successfully!\n\n` +
            `ID: ${result.TemplateId}\n` +
            `Name: ${result.Name}\n` +
            `Alias: ${result.Alias || 'none'}\n` +
            `Layout: ${result.LayoutTemplate || 'none'}\n` +
            `Active: ${result.Active}`
        }]
      };
    }
  );

  server.tool(
    "deleteTemplate",
    {
      templateIdOrAlias: z.union([z.number(), z.string()]).describe("Template ID (number) or alias (string) to delete")
    },
    async ({ templateIdOrAlias }) => {
      console.error('Deleting template..', { templateIdOrAlias });
      await postmarkClient.deleteTemplate(templateIdOrAlias);
      console.error('Template deleted');

      return {
        content: [{
          type: "text",
          text: `Template "${templateIdOrAlias}" deleted successfully.`
        }]
      };
    }
  );

  server.tool(
    "validateTemplate",
    {
      subject: z.string().optional().describe("Template subject to validate"),
      htmlBody: z.string().optional().describe("HTML body to validate"),
      textBody: z.string().optional().describe("Text body to validate"),
      testRenderModel: z.object({}).passthrough().optional().describe("Test data model to render the template with"),
      templateType: z.enum(["Standard", "Layout"]).optional().describe("Template type (default: Standard)"),
      layoutTemplate: z.string().optional().describe("Layout template alias to validate against")
    },
    async ({ subject, htmlBody, textBody, testRenderModel, templateType, layoutTemplate }) => {
      if (!subject && !htmlBody && !textBody) {
        throw new Error("At least one of subject, htmlBody, or textBody must be provided");
      }

      const options = {};
      if (subject) options.Subject = subject;
      if (htmlBody) options.HtmlBody = htmlBody;
      if (textBody) options.TextBody = textBody;
      if (testRenderModel) options.TestRenderModel = testRenderModel;
      if (templateType) options.TemplateType = templateType;
      if (layoutTemplate) options.LayoutTemplate = layoutTemplate;

      console.error('Validating template..');
      const result = await postmarkClient.validateTemplate(options);
      console.error('Template validation complete');

      const sections = [];

      if (result.Subject) {
        sections.push(`Subject: ${result.Subject.ContentIsValid ? 'Valid' : 'INVALID'}` +
          (result.Subject.ValidationErrors?.length ? `\n  Errors: ${result.Subject.ValidationErrors.map(e => e.Message).join(', ')}` : '') +
          (result.Subject.RenderedContent ? `\n  Rendered: ${result.Subject.RenderedContent}` : ''));
      }
      if (result.HtmlBody) {
        sections.push(`HTML Body: ${result.HtmlBody.ContentIsValid ? 'Valid' : 'INVALID'}` +
          (result.HtmlBody.ValidationErrors?.length ? `\n  Errors: ${result.HtmlBody.ValidationErrors.map(e => e.Message).join(', ')}` : ''));
      }
      if (result.TextBody) {
        sections.push(`Text Body: ${result.TextBody.ContentIsValid ? 'Valid' : 'INVALID'}` +
          (result.TextBody.ValidationErrors?.length ? `\n  Errors: ${result.TextBody.ValidationErrors.map(e => e.Message).join(', ')}` : ''));
      }

      const allValid = result.AllContentIsValid;

      return {
        content: [{
          type: "text",
          text: `Template Validation: ${allValid ? 'ALL VALID' : 'HAS ERRORS'}\n\n${sections.join('\n\n')}`
        }]
      };
    }
  );

  // ─────────────── Messages ───────────────

  server.tool(
    "searchOutboundMessages",
    {
      recipient: z.string().optional().describe("Filter by recipient email address"),
      fromEmail: z.string().optional().describe("Filter by sender email address"),
      tag: z.string().optional().describe("Filter by tag"),
      subject: z.string().optional().describe("Filter by subject line"),
      status: z.enum(["queued", "sent", "processed"]).optional().describe("Filter by message status"),
      messageStream: z.string().optional().describe("Filter by message stream ID (e.g. 'outbound')"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format"),
      count: z.number().int().min(1).max(500).optional().describe("Number of results to return (default 50, max 500)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)")
    },
    async ({ recipient, fromEmail, tag, subject, status, messageStream, fromDate, toDate, count, offset }) => {
      const filter = {};
      if (recipient) filter.recipient = recipient;
      if (fromEmail) filter.fromemail = fromEmail;
      if (tag) filter.tag = tag;
      if (subject) filter.subject = subject;
      if (status) filter.status = status;
      if (messageStream) filter.messagestream = messageStream;
      if (fromDate) filter.fromdate = fromDate;
      if (toDate) filter.todate = toDate;
      filter.count = count || 50;
      filter.offset = offset || 0;

      console.error('Searching outbound messages..', filter);
      const result = await postmarkClient.getOutboundMessages(filter);
      console.error(`Found ${result.TotalCount} messages`);

      if (result.Messages.length === 0) {
        return { content: [{ type: "text", text: "No messages found matching your criteria." }] };
      }

      const messageList = result.Messages.map(m =>
        `• **${m.Subject}**\n  - MessageID: ${m.MessageID}\n  - To: ${m.Recipients.join(', ')}\n  - From: ${m.From}\n  - Status: ${m.Status}\n  - Date: ${m.ReceivedAt}\n  - Tag: ${m.Tag || 'none'}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.TotalCount} messages (showing ${result.Messages.length}):\n\n${messageList}`
        }]
      };
    }
  );

  server.tool(
    "getMessageDetails",
    {
      messageId: z.string().describe("The MessageID of the email to retrieve details for")
    },
    async ({ messageId }) => {
      console.error('Fetching message details..', { messageId });
      const result = await postmarkClient.getOutboundMessageDetails(messageId);
      console.error('Message details retrieved');

      const events = (result.MessageEvents || []).map(e =>
        `  - ${e.Type} at ${e.ReceivedAt}${e.Details?.Summary ? ` (${e.Details.Summary})` : ''}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Message Details\n\n` +
            `MessageID: ${result.MessageID}\n` +
            `Subject: ${result.Subject}\n` +
            `From: ${result.From}\n` +
            `To: ${(result.Recipients || []).join(', ')}\n` +
            `Status: ${result.Status}\n` +
            `Date: ${result.ReceivedAt}\n` +
            `Tag: ${result.Tag || 'none'}\n` +
            `${events ? `\nEvents:\n${events}` : '\nNo events recorded.'}`
        }]
      };
    }
  );

  // ─────────────── Diagnostics ───────────────

  // Composite triage tool: answers "did my email reach X, and if not, why?"
  // by running searches/lookups in parallel and synthesizing a recommendation.
  server.tool(
    "diagnoseDelivery",
    {
      recipient: z.string().email().describe("The recipient address to investigate"),
      messageId: z.string().optional().describe("Optional specific MessageID to investigate. If omitted, the most recent message to recipient is used"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Search window start, YYYY-MM-DD (default: 7 days ago)"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Search window end, YYYY-MM-DD (default: today)"),
      messageStream: z.string().optional().describe("Message stream for suppression check (default: DEFAULT_MESSAGE_STREAM)")
    },
    async ({ recipient, messageId, fromDate, toDate, messageStream }) => {
      const stream = messageStream || defaultMessageStream;
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const windowFrom = fromDate || weekAgo;
      const windowTo = toDate || today;

      console.error('Diagnosing delivery..', { recipient, messageId, stream });

      // Independent lookups in parallel — each tolerant of failure so a
      // single 404 (e.g., bad messageId) doesn't sink the whole diagnosis.
      const [messages, suppressions, bounces] = await Promise.all([
        messageId
          ? postmarkClient.getOutboundMessageDetails(messageId)
              .then(r => [r]).catch(() => [])
          : postmarkClient.getOutboundMessages({
              recipient,
              fromdate: windowFrom,
              todate: windowTo,
              count: 5,
            }).then(r => r.Messages || []).catch(() => []),
        postmarkClient.getSuppressions(stream, { EmailAddress: recipient })
          .then(r => r.Suppressions || []).catch(() => []),
        postmarkClient.getBounces({ emailFilter: recipient, count: 10 })
          .then(r => r.Bounces || []).catch(() => []),
      ]);

      // Promote the most recent search hit to full details so we have events
      let latest = null;
      if (messages.length > 0) {
        latest = messages[0].MessageEvents
          ? messages[0]
          : await postmarkClient.getOutboundMessageDetails(messages[0].MessageID).catch(() => messages[0]);
      }

      const lines = [`Delivery Diagnosis: ${recipient}`, '─'.repeat(48), ''];

      // 1. Suppression status (most decisive single signal)
      if (suppressions.length > 0) {
        const s = suppressions[0];
        lines.push(`Suppression: SUPPRESSED on stream "${stream}"`);
        lines.push(`  Reason: ${s.SuppressionReason}`);
        lines.push(`  Origin: ${s.Origin}`);
        lines.push(`  Since:  ${s.CreatedAt}`);
      } else {
        lines.push(`Suppression: not suppressed on stream "${stream}"`);
      }
      lines.push('');

      // 2. Most recent message + its events
      if (latest) {
        const events = (latest.MessageEvents || []).map(e => e.Type);
        const counts = events.reduce((acc, t) => ({ ...acc, [t]: (acc[t] || 0) + 1 }), {});
        lines.push('Most recent message:');
        lines.push(`  MessageID: ${latest.MessageID}`);
        lines.push(`  Subject:   ${latest.Subject || '(none)'}`);
        lines.push(`  Sent:      ${latest.ReceivedAt}`);
        lines.push(`  Status:    ${latest.Status}`);
        if (events.length) {
          const summary = Object.entries(counts)
            .map(([t, n]) => n > 1 ? `${t}×${n}` : t).join(', ');
          lines.push(`  Events:    ${summary}`);
        }
      } else {
        lines.push(`No messages found for ${recipient} between ${windowFrom} and ${windowTo}.`);
      }
      lines.push('');

      // 3. Bounce history
      if (bounces.length > 0) {
        lines.push(`Bounce history (${bounces.length} recent):`);
        bounces.slice(0, 3).forEach(b => {
          const reactivatable = b.CanActivate ? ' [can reactivate]' : '';
          lines.push(`  - ${b.BouncedAt} ${b.Type}: ${b.Description}${reactivatable}`);
        });
        if (bounces.length > 3) lines.push(`  - ... and ${bounces.length - 3} more`);
      } else {
        lines.push('Bounce history: none');
      }
      lines.push('');

      // 4. Synthesized recommendation
      lines.push('Recommended action:');
      if (suppressions.length > 0) {
        const s = suppressions[0];
        if (s.SuppressionReason === 'SpamComplaint') {
          lines.push('  Recipient marked previous mail as spam — suppression is permanent and');
          lines.push('  cannot be lifted via API. Do not retry.');
        } else if (s.SuppressionReason === 'HardBounce') {
          const reactivatable = bounces.find(b => b.CanActivate);
          if (reactivatable) {
            lines.push(`  Run activateBounce with bounceId ${reactivatable.ID}, then resend.`);
          } else {
            lines.push('  Address hard-bounced. Verify the address is valid before retrying;');
            lines.push('  if confirmed valid, run deleteSuppressions then resend.');
          }
        } else {
          lines.push('  Run deleteSuppressions with this address to lift the suppression, then resend.');
        }
      } else if (latest && (latest.MessageEvents || []).some(e => e.Type === 'Delivered')) {
        lines.push('  Email was delivered. If recipient says they didn\'t see it, check their');
        lines.push('  spam folder or ask them to whitelist the sender domain.');
      } else if (latest?.Status === 'Queued') {
        lines.push('  Most recent message is still queued. Re-run in a few minutes.');
      } else if (!latest) {
        lines.push(`  No recent send to this address. Use sendEmail to send, or expand the date range.`);
      } else {
        lines.push(`  Message status is "${latest.Status}". Review events above to identify the failure.`);
      }

      return { content: [{ type: "text", text: lines.join('\n') }] };
    }
  );

  // ─────────────── Bounces ───────────────

  server.tool(
    "searchBounces",
    {
      type: z.enum([
        "AddressChange", "AutoResponder", "BadEmailAddress", "Blocked",
        "ChallengeVerification", "DMARCPolicy", "DnsError", "HardBounce",
        "InboundError", "ManuallyDeactivated", "OpenRelayTest", "SMTPApiError",
        "SoftBounce", "SpamComplaint", "SpamNotification", "Subscribe",
        "TemplateRenderingFailed", "Transient", "Unconfirmed", "Unknown",
        "Unsubscribe", "VirusNotification"
      ]).optional().describe("Filter by bounce type (matches Postmark's BounceType enum — 22 values)"),
      inactive: z.boolean().optional().describe("Filter by deactivated status"),
      emailFilter: z.string().optional().describe("Filter by full or partial email address"),
      tag: z.string().optional().describe("Filter by tag"),
      messageID: z.string().optional().describe("Filter by original message ID"),
      messageStream: z.string().optional().describe("Filter by message stream ID (e.g. 'outbound')"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format"),
      count: z.number().int().min(1).max(500).optional().describe("Number of results (default 50, max 500)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)")
    },
    async ({ type, inactive, emailFilter, tag, messageID, messageStream, fromDate, toDate, count, offset }) => {
      const filter = {};
      if (type) filter.type = type;
      if (inactive !== undefined) filter.inactive = inactive;
      if (emailFilter) filter.emailFilter = emailFilter;
      if (tag) filter.tag = tag;
      if (messageID) filter.messageID = messageID;
      if (messageStream) filter.messagestream = messageStream;
      if (fromDate) filter.fromdate = fromDate;
      if (toDate) filter.todate = toDate;
      filter.count = count || 50;
      filter.offset = offset || 0;

      console.error('Searching bounces..', filter);
      const result = await postmarkClient.getBounces(filter);
      console.error(`Found ${result.TotalCount} bounces`);

      if (result.Bounces.length === 0) {
        return { content: [{ type: "text", text: "No bounces found matching your criteria." }] };
      }

      const bounceList = result.Bounces.map(b =>
        `• **${b.Email}**\n  - BounceID: ${b.ID}\n  - Type: ${b.Type} (${b.TypeCode})\n  - Description: ${b.Description}\n  - Date: ${b.BouncedAt}\n  - Inactive: ${b.Inactive}\n  - Can Activate: ${b.CanActivate}\n  - Subject: ${b.Subject || 'N/A'}\n  - Tag: ${b.Tag || 'none'}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.TotalCount} bounces (showing ${result.Bounces.length}):\n\n${bounceList}`
        }]
      };
    }
  );

  server.tool(
    "getBounceDump",
    {
      bounceId: z.number().int().describe("The ID of the bounce to retrieve the SMTP dump for")
    },
    async ({ bounceId }) => {
      console.error('Fetching bounce dump..', { bounceId });
      const result = await postmarkClient.getBounceDump(bounceId);
      console.error('Bounce dump retrieved');

      return {
        content: [{
          type: "text",
          text: result.Body
            ? `SMTP Bounce Dump (Bounce ID: ${bounceId}):\n\n${result.Body}`
            : `No SMTP dump available for bounce ${bounceId}. Dumps are retained for 30 days.`
        }]
      };
    }
  );

  server.tool(
    "activateBounce",
    {
      bounceId: z.number().int().describe("The ID of the bounce to reactivate")
    },
    async ({ bounceId }) => {
      console.error('Activating bounce..', { bounceId });
      const result = await postmarkClient.activateBounce(bounceId);
      console.error('Bounce activated');

      return {
        content: [{
          type: "text",
          text: `Bounce reactivated successfully!\n\n` +
            `Bounce ID: ${result.Bounce.ID}\n` +
            `Email: ${result.Bounce.Email}\n` +
            `Message: ${result.Message}`
        }]
      };
    }
  );

  // ─────────────── Suppressions ───────────────

  server.tool(
    "listSuppressions",
    {
      messageStream: z.string().optional().describe("Message stream ID (default: DEFAULT_MESSAGE_STREAM)"),
      suppressionReason: z.enum(["HardBounce", "SpamComplaint", "ManualSuppression"]).optional().describe("Filter by suppression reason"),
      origin: z.enum(["Recipient", "Customer", "Admin"]).optional().describe("Filter by suppression origin"),
      emailAddress: z.string().optional().describe("Filter by full or partial email address"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format")
    },
    async ({ messageStream, suppressionReason, origin, emailAddress, fromDate, toDate }) => {
      const stream = messageStream || defaultMessageStream;
      const filter = {};
      if (suppressionReason) filter.SuppressionReason = suppressionReason;
      if (origin) filter.Origin = origin;
      if (emailAddress) filter.EmailAddress = emailAddress;
      if (fromDate) filter.fromdate = fromDate;
      if (toDate) filter.todate = toDate;

      console.error('Fetching suppressions..', { stream, filter });
      const result = await postmarkClient.getSuppressions(stream, filter);
      console.error(`Found ${result.Suppressions.length} suppressions`);

      if (result.Suppressions.length === 0) {
        return { content: [{ type: "text", text: `No suppressions found on stream "${stream}" matching your criteria.` }] };
      }

      const list = result.Suppressions.map(s =>
        `• **${s.EmailAddress}**\n  - Reason: ${s.SuppressionReason}\n  - Origin: ${s.Origin}\n  - Created: ${s.CreatedAt}`
      ).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.Suppressions.length} suppressions (stream: ${stream}):\n\n${list}`
        }]
      };
    }
  );

  server.tool(
    "createSuppressions",
    {
      emailAddresses: z.array(z.string().email()).min(1).max(50).describe("Email addresses to suppress (max 50)"),
      messageStream: z.string().optional().describe("Message stream ID (default: DEFAULT_MESSAGE_STREAM)")
    },
    async ({ emailAddresses, messageStream }) => {
      const stream = messageStream || defaultMessageStream;
      const options = {
        Suppressions: emailAddresses.map(email => ({ EmailAddress: email }))
      };

      console.error('Creating suppressions..', { count: emailAddresses.length, stream });
      const result = await postmarkClient.createSuppressions(stream, options);
      console.error('Suppressions created');

      const list = result.Suppressions.map(s =>
        `• ${s.EmailAddress}: ${s.Status}${s.Message ? ` — ${s.Message}` : ''}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Suppression results (stream: ${stream}):\n\n${list}`
        }]
      };
    }
  );

  server.tool(
    "deleteSuppressions",
    {
      emailAddresses: z.array(z.string().email()).min(1).max(50).describe("Email addresses to unsuppress (max 50). Note: SpamComplaint suppressions cannot be deleted."),
      messageStream: z.string().optional().describe("Message stream ID (default: DEFAULT_MESSAGE_STREAM)")
    },
    async ({ emailAddresses, messageStream }) => {
      const stream = messageStream || defaultMessageStream;
      const options = {
        Suppressions: emailAddresses.map(email => ({ EmailAddress: email }))
      };

      console.error('Deleting suppressions..', { count: emailAddresses.length, stream });
      const result = await postmarkClient.deleteSuppressions(stream, options);
      console.error('Suppressions deleted');

      const list = result.Suppressions.map(s =>
        `• ${s.EmailAddress}: ${s.Status}${s.Message ? ` — ${s.Message}` : ''}`
      ).join('\n');

      return {
        content: [{
          type: "text",
          text: `Suppression deletion results (stream: ${stream}):\n\n${list}`
        }]
      };
    }
  );

  // ─────────────── Stats & Server ───────────────

  server.tool(
    "getDeliveryStats",
    {
      stat: z.enum([
        "summary", "overview", "sent", "bounces", "spam", "tracked",
        "opens", "openPlatforms", "openClients", "openReadTimes",
        "clicks", "clickBrowsers", "clickPlatforms", "clickLocation"
      ]).optional().describe("Which stat to retrieve. Default 'summary' returns headline open/click/bounce rates."),
      tag: z.string().optional().describe("Filter by tag"),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date in YYYY-MM-DD format"),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date in YYYY-MM-DD format"),
      messageStream: z.string().optional().describe("Filter by message stream ID")
    },
    async ({ stat, tag, fromDate, toDate, messageStream }) => {
      const filter = {};
      if (tag) filter.tag = tag;
      if (fromDate) filter.fromdate = fromDate;
      if (toDate) filter.todate = toDate;
      if (messageStream) filter.messagestream = messageStream;

      const requested = stat || "summary";
      console.error('Fetching stats..', { stat: requested, filter });

      const fetchers = {
        summary:        () => postmarkClient.getOutboundOverview(filter),
        overview:       () => postmarkClient.getOutboundOverview(filter),
        sent:           () => postmarkClient.getSentCounts(filter),
        bounces:        () => postmarkClient.getBounceCounts(filter),
        spam:           () => postmarkClient.getSpamComplaintsCounts(filter),
        tracked:        () => postmarkClient.getTrackedEmailCounts(filter),
        opens:          () => postmarkClient.getEmailOpenCounts(filter),
        openPlatforms:  () => postmarkClient.getEmailOpenPlatformUsage(filter),
        openClients:    () => postmarkClient.getEmailOpenClientUsage(filter),
        openReadTimes:  () => postmarkClient.getEmailOpenReadTimes(filter),
        clicks:         () => postmarkClient.getClickCounts(filter),
        clickBrowsers:  () => postmarkClient.getClickBrowserUsage(filter),
        clickPlatforms: () => postmarkClient.getClickPlatformUsage(filter),
        clickLocation:  () => postmarkClient.getClickLocation(filter),
      };

      const data = await fetchers[requested]();
      console.error('Stats retrieved');

      const text = requested === "summary"
        ? fmtDeliverySummary(data, { fromDate, toDate, tag, messageStream })
        : fmtStatResponse(requested, data);

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "getServerInfo",
    {},
    async () => {
      console.error('Fetching server info..');
      const result = await postmarkClient.getServer();
      console.error('Server info retrieved');

      return {
        content: [{
          type: "text",
          text: `Server: ${result.Name}\n\n` +
            `ID: ${result.ID}\n` +
            `Color: ${result.Color}\n` +
            `SMTP Activated: ${result.SmtpApiActivated}\n` +
            `Inbound Address: ${result.InboundAddress || 'none'}\n` +
            `Inbound Domain: ${result.InboundDomain || 'none'}\n\n` +
            `Tracking:\n` +
            `  Open Tracking: ${result.TrackOpens}\n` +
            `  Link Tracking: ${result.TrackLinks}\n` +
            `  First Open Only: ${result.PostFirstOpenOnly}\n\n` +
            `Webhooks:\n` +
            `  Bounce: ${result.BounceHookUrl || 'none'}\n` +
            `  Open: ${result.OpenHookUrl || 'none'}\n` +
            `  Delivery: ${result.DeliveryHookUrl || 'none'}\n` +
            `  Click: ${result.ClickHookUrl || 'none'}\n` +
            `  Inbound: ${result.InboundHookUrl || 'none'}`
        }]
      };
    }
  );

  // ─────────────── Webhooks ───────────────

  server.tool(
    "listWebhooks",
    {
      messageStream: z.string().optional().describe("Filter by message stream ID (e.g. 'outbound')")
    },
    async ({ messageStream }) => {
      const filter = {};
      if (messageStream) filter.MessageStream = messageStream;

      console.error('Fetching webhooks..', filter);
      const result = await postmarkClient.getWebhooks(filter);
      console.error(`Found ${result.Webhooks.length} webhooks`);

      if (result.Webhooks.length === 0) {
        return { content: [{ type: "text", text: "No webhooks configured." }] };
      }

      const list = result.Webhooks.map(w => {
        const triggers = [];
        if (w.Triggers?.Open?.Enabled) triggers.push('Open');
        if (w.Triggers?.Click?.Enabled) triggers.push('Click');
        if (w.Triggers?.Delivery?.Enabled) triggers.push('Delivery');
        if (w.Triggers?.Bounce?.Enabled) triggers.push('Bounce');
        if (w.Triggers?.SpamComplaint?.Enabled) triggers.push('SpamComplaint');
        if (w.Triggers?.SubscriptionChange?.Enabled) triggers.push('SubscriptionChange');

        return `• **${w.Url}**\n  - ID: ${w.ID}\n  - Stream: ${w.MessageStream || 'all'}\n  - Triggers: ${triggers.join(', ') || 'none'}`;
      }).join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Found ${result.Webhooks.length} webhooks:\n\n${list}`
        }]
      };
    }
  );

  server.tool(
    "createWebhook",
    {
      url: z.string().url().describe("The webhook URL to receive POST requests"),
      messageStream: z.string().optional().describe("Message stream ID (e.g. 'outbound')"),
      openEnabled: z.boolean().optional().describe("Trigger on email opens"),
      clickEnabled: z.boolean().optional().describe("Trigger on link clicks"),
      deliveryEnabled: z.boolean().optional().describe("Trigger on email delivery"),
      bounceEnabled: z.boolean().optional().describe("Trigger on bounces"),
      spamComplaintEnabled: z.boolean().optional().describe("Trigger on spam complaints"),
      subscriptionChangeEnabled: z.boolean().optional().describe("Trigger on subscription changes")
    },
    async ({ url, messageStream, openEnabled, clickEnabled, deliveryEnabled, bounceEnabled, spamComplaintEnabled, subscriptionChangeEnabled }) => {
      const anyTrigger = openEnabled || clickEnabled || deliveryEnabled ||
        bounceEnabled || spamComplaintEnabled || subscriptionChangeEnabled;
      if (!anyTrigger) {
        throw new Error("At least one trigger must be enabled (openEnabled, clickEnabled, deliveryEnabled, bounceEnabled, spamComplaintEnabled, or subscriptionChangeEnabled)");
      }

      const options = {
        Url: url,
        Triggers: {
          Open: { Enabled: openEnabled || false },
          Click: { Enabled: clickEnabled || false },
          Delivery: { Enabled: deliveryEnabled || false },
          Bounce: { Enabled: bounceEnabled || false },
          SpamComplaint: { Enabled: spamComplaintEnabled || false },
          SubscriptionChange: { Enabled: subscriptionChangeEnabled || false }
        }
      };

      if (messageStream) options.MessageStream = messageStream;

      console.error('Creating webhook..', { url });
      const result = await postmarkClient.createWebhook(options);
      console.error('Webhook created: ', result.ID);

      const triggers = [];
      if (result.Triggers?.Open?.Enabled) triggers.push('Open');
      if (result.Triggers?.Click?.Enabled) triggers.push('Click');
      if (result.Triggers?.Delivery?.Enabled) triggers.push('Delivery');
      if (result.Triggers?.Bounce?.Enabled) triggers.push('Bounce');
      if (result.Triggers?.SpamComplaint?.Enabled) triggers.push('SpamComplaint');
      if (result.Triggers?.SubscriptionChange?.Enabled) triggers.push('SubscriptionChange');

      return {
        content: [{
          type: "text",
          text: `Webhook created successfully!\n\n` +
            `ID: ${result.ID}\n` +
            `URL: ${result.Url}\n` +
            `Stream: ${result.MessageStream || 'all'}\n` +
            `Triggers: ${triggers.join(', ') || 'none'}`
        }]
      };
    }
  );

  server.tool(
    "deleteWebhook",
    {
      webhookId: z.number().int().describe("The ID of the webhook to delete")
    },
    async ({ webhookId }) => {
      console.error('Deleting webhook..', { webhookId });
      await postmarkClient.deleteWebhook(webhookId);
      console.error('Webhook deleted');

      return {
        content: [{
          type: "text",
          text: `Webhook ${webhookId} deleted successfully.`
        }]
      };
    }
  );
}

main().catch((error) => {
  console.error('[ERROR] Failed to start server: ', error.message);
  process.exit(1);
});
