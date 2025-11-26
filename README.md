# Official Postmark MCP Server&nbsp;&nbsp;&nbsp;[![NPM Version](https://img.shields.io/npm/v/@activecampaign/postmark-mcp.svg)](https://www.npmjs.com/package/@activecampaign/postmark-mcp)&nbsp;&nbsp;![MIT licensed](https://img.shields.io/npm/l/%40modelcontextprotocol%2Fsdk)

Send emails with Postmark using Claude and other MCP-compatible AI assistants.

## Features
- Exposes a Model Context Protocol (MCP) server for sending emails via your [Postmark account](https://account.postmarkapp.com/sign_up)
- Simple configuration via environment variables
- Comprehensive error handling and graceful shutdown
- Secure logging practices (no sensitive data exposure)
- Automatic email tracking configuration

## Feedback
We'd love to hear from you! Please share your feedback and suggestions using our [feedback form](https://forms.gle/zVdZLAJPM81Vo2Wh8).

## Requirements
- Node.js (v16 or higher recommended)
- A Postmark account and server token

## Installation (Local Development)
**Clone the repository:**
```sh
git clone https://github.com/ActiveCampaign/postmark-mcp
cd postmark-mcp
```

**Install dependencies:**
```sh
npm install
# or
yarn
# or
bun install
```

## Configuration (Local Development)

Create your own environment file from the example

```sh
cp .env.example .env
```

Edit your `.env` to contain your Postmark credentials and settings.

**Important:** This is intended for local development purposes only. Secrets should never be stored in version control.

| Variable                  | Description                                      | Required   |
|---------------------------|--------------------------------------------------|------------|
| POSTMARK_SERVER_TOKEN     | Your Postmark server API token                   | Yes        |
| DEFAULT_SENDER_EMAIL      | Default sender email address                     | Yes        |
| DEFAULT_MESSAGE_STREAM    | Postmark message stream (e.g., 'outbound')       | Yes        |

**Run the server:**

```sh
npm start
# or
yarn start
# or
bun start
```

## Cursor Quick Install
<div>
  <a href="cursor://anysphere.cursor-deeplink/mcp/install?name=Postmark&config=eyJjb21tYW5kIjoibm9kZSIsImFyZ3MiOlsiaW5kZXguanMiXSwiZW52Ijp7IlBPU1RNQVJLX1NFUlZFUl9UT0tFTiI6IiIsIkRFRkFVTFRfU0VOREVSX0VNQUlMIjoiIiwiREVGQVVMVF9NRVNTQUdFX1NUUkVBTSI6Im91dGJvdW5kIn19">
    <img src="https://img.shields.io/badge/Add_Postmark_MCP_Server-to_Cursor-00A4DB?style=for-the-badge&logo=cursor&logoColor=white" alt="Add Postmark MCP Server to Cursor" />
  </a>
</div>
<br />

After installing the MCP, update your configuration to set:
- `POSTMARK_SERVER_TOKEN`
- `DEFAULT_SENDER_EMAIL`
- `DEFAULT_MESSAGE_STREAM` (default: `outbound`)

## Claude and Cursor MCP Configuration Example
```json
{
  "mcpServers": {
    "postmark": {
      "command": "node",
      "args": ["path/to/postmark-mcp/index.js"],
      "env": {
        "POSTMARK_SERVER_TOKEN": "your-postmark-server-token",
        "DEFAULT_SENDER_EMAIL": "your-sender-email@example.com",
        "DEFAULT_MESSAGE_STREAM": "your-message-stream"
      }
    }
  }
}
```

## Tools
This section provides a complete reference for the Postmark MCP server tools including example prompts and payloads.

### Table of Contents
- [Email Management Tools](#email-management-tools)
  - [sendEmail](#1-sendemail)
  - [sendEmailWithTemplate](#2-sendemailwithtemplate)
- [Template Management Tools](#template-management-tools)
  - [listTemplates](#3-listtemplates)
- [Statistics & Tracking Tools](#statistics--tracking-tools)
  - [getDeliveryStats](#4-getdeliverystats)

## Email Management Tools
### 1. sendEmail
Sends a single text email.

**Example Prompt:**
```
Send an email using Postmark to recipient@example.com with the subject "Meeting Reminder" and the message "Don't forget our team meeting tomorrow at 2 PM. Please bring your quarterly statistics report (and maybe some snacks).""
```

**Expected Payload:**
```json
{
  "to": "recipient@example.com",
  "subject": "Meeting Reminder",
  "textBody": "Don't forget our team meeting tomorrow at 2 PM. Please bring your quarterly statistics report (and maybe some snacks).",
  "htmlBody": "HTML version of the email body", // Optional
  "from": "sender@example.com", // Optional, uses DEFAULT_SENDER_EMAIL if not provided
  "tag": "meetings" // Optional
}
```

**Response Format:**
```
Email sent successfully!
MessageID: message-id-here
To: recipient@example.com
Subject: Meeting Reminder
```

### 2. sendEmailWithTemplate
Sends an email using a pre-defined template.

**Example Prompt:**
```
Send an email with Postmark template alias "welcome" to customer@example.com with the following template variables:
{
  "name": "John Doe",
  "product_name": "MyApp",
  "login_url": "https://myapp.com/login"
}
```

**Expected Payload:**
```json
{
  "to": "customer@example.com",
  "templateId": 12345, // Either templateId or templateAlias must be provided, but not both
  "templateAlias": "welcome", // Either templateId or templateAlias must be provided, but not both
  "templateModel": {
    "name": "John Doe",
    "product_name": "MyApp",
    "login_url": "https://myapp.com/login"
  },
  "from": "sender@example.com", // Optional, uses DEFAULT_SENDER_EMAIL if not provided
  "tag": "onboarding" // Optional
}
```

**Response Format:**
```
Template email sent successfully!
MessageID: message-id-here
To: recipient@example.com
Template: template-id-or-alias-here
```

## Template Management Tools
### 3. listTemplates

Lists all available templates.

**Example Prompt:**
```
Show me a list of all the email templates available in our Postmark account.
```

**Response Format:**
```
📋 Found 2 templates:

• Basic
  - ID: 12345678
  - Alias: basic
  - Subject: none

• Welcome
  - ID: 02345679
  - Alias: welcome
  - Subject: none
```

## Statistics & Tracking Tools
### 4. getDeliveryStats

Retrieves email delivery statistics.

**Example Prompt:**
```
Show me our Postmark email delivery statistics from 2025-05-01 to 2025-05-15 for the "marketing" tag.
```

**Expected Payload:**
```json
{
  "tag": "marketing", // Optional
  "fromDate": "2025-05-01", // Optional, YYYY-MM-DD format
  "toDate": "2025-05-15" // Optional, YYYY-MM-DD format
}
```

**Response Format:**
```
Email Statistics Summary

Sent: 100 emails
Open Rate: 45.5% (45/99 tracked emails)
Click Rate: 15.2% (15/99 tracked links)

Period: 2025-05-01 to 2025-05-15
Tag: marketing
```

## Implementation Details
### Automatic Configuration
All emails are automatically configured with:
- `TrackOpens: true`
- `TrackLinks: "HtmlAndText"`
- Message stream from `DEFAULT_MESSAGE_STREAM` environment variable

### Error Handling
The server implements comprehensive error handling:
- Validation of all required environment variables
- Graceful shutdown on SIGTERM and SIGINT
- Proper error handling for API calls
- No exposure of sensitive information in logs
- Consistent error message formatting

### Logging
- Uses appropriate log levels (`info` for normal operations, `error` for errors)
- Excludes sensitive information from logs
- Provides clear operation status and results

---

*For more information about the Postmark API, visit [Postmark's Developer Documentation](https://postmarkapp.com/developer).* 

## License
[MIT](LICENSE) © ActiveCampaign