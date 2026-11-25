# n8n estate graph report

Date: 2026-11-02

Sources: acme-dental (dir), bali-villas (dir)

## Summary

| Metric | Count |
| --- | --- |
| Workflows | 10 (9 active) |
| Credentials referenced | 10 |
| External hosts | 9 |
| Webhooks | 3 |
| Sheets / docs / bases | 4 |
| Env vars | 3 |
| Schedules | 3 |

## Single points of failure (threshold 3)

### Credentials used by many active workflows

| Instance | Credential | Active workflows | Workflows |
| --- | --- | --- | --- |
| acme-dental | Google Sheets account | 4 | Appointment Reminders, Lead Enrich, Lead Intake, Stripe Payment Sync |

### Hosts used by many active workflows

| Host | Active workflows | Workflows |
| --- | --- | --- |
| sheets.googleapis.com | 6 | [acme-dental] Appointment Reminders, [acme-dental] Lead Enrich, [acme-dental] Lead Intake, [acme-dental] Stripe Payment Sync, [bali-villas] Booking Confirmation, [bali-villas] Villa Enquiry Webhook |

### Active workflows with no error workflow

| Instance | Workflow |
| --- | --- |
| acme-dental | Lead Intake |
| bali-villas | Booking Confirmation |
| bali-villas | Villa Enquiry Webhook |

### Webhooks with authentication none

| Instance | Webhook | Workflow | Active |
| --- | --- | --- | --- |
| acme-dental | POST /acme***#3d12dd83 | Lead Intake | yes |
| bali-villas | POST /vill***#3ea28d56 | Booking Confirmation | yes |

### Sub-workflows called by many

None.

Orphan credentials: Skipped: the n8n public API does not list unused credentials, so only credentials referenced by a workflow are known.

## Credentials

| Instance | Credential | Type | Direct | Affected (incl. via sub-workflows) | Workflows |
| --- | --- | --- | --- | --- | --- |
| acme-dental | Google Sheets account | googleSheetsOAuth2Api | 5 | 5 | [acme-dental] Appointment Reminders, [acme-dental] Lead Enrich, [acme-dental] Lead Intake, [acme-dental] Old Review Request (disabled) (inactive), [acme-dental] Stripe Payment Sync |
| acme-dental | Slack account | slackApi | 2 | 4 | [acme-dental] Error Alerts, [acme-dental] Notify Front Desk, [acme-dental] Lead Enrich, [acme-dental] Lead Intake |
| acme-dental | Gmail account | gmailOAuth2 | 2 | 2 | [acme-dental] Appointment Reminders, [acme-dental] Old Review Request (disabled) (inactive) |
| bali-villas | Google Sheets account | googleSheetsOAuth2Api | 2 | 2 | [bali-villas] Booking Confirmation, [bali-villas] Villa Enquiry Webhook |
| acme-dental | OpenAI account | openAiApi | 1 | 2 | [acme-dental] Lead Enrich, [acme-dental] Lead Intake |
| bali-villas | Enquiry header key | httpHeaderAuth | 1 | 1 | [bali-villas] Villa Enquiry Webhook |
| bali-villas | Gmail account | gmailOAuth2 | 1 | 1 | [bali-villas] Booking Confirmation |
| bali-villas | OpenAI account | openAiApi | 1 | 1 | [bali-villas] Villa Enquiry Webhook |
| acme-dental | Stripe account | stripeApi | 1 | 1 | [acme-dental] Stripe Payment Sync |
| bali-villas | Stripe account | stripeApi | 1 | 1 | [bali-villas] Booking Confirmation |

## External hosts

| Host | Direct | Affected | Workflows |
| --- | --- | --- | --- |
| sheets.googleapis.com | 7 | 7 | [acme-dental] Appointment Reminders, [acme-dental] Lead Enrich, [acme-dental] Lead Intake, [acme-dental] Old Review Request (disabled) (inactive), [acme-dental] Stripe Payment Sync, [bali-villas] Booking Confirmation, [bali-villas] Villa Enquiry Webhook |
| slack.com | 2 | 4 | [acme-dental] Error Alerts, [acme-dental] Notify Front Desk, [acme-dental] Lead Enrich, [acme-dental] Lead Intake |
| api.openai.com | 2 | 3 | [acme-dental] Lead Enrich, [bali-villas] Villa Enquiry Webhook, [acme-dental] Lead Intake |
| gmail.googleapis.com | 3 | 3 | [acme-dental] Appointment Reminders, [acme-dental] Old Review Request (disabled) (inactive), [bali-villas] Booking Confirmation |
| api.stripe.com | 2 | 2 | [acme-dental] Stripe Payment Sync, [bali-villas] Booking Confirmation |
| assets.example-villas.com | 1 | 2 | [bali-villas] Receipt Builder, [bali-villas] Booking Confirmation |
| enrich.example-data.com | 1 | 2 | [acme-dental] Lead Enrich, [acme-dental] Lead Intake |
| hooks.example-status.io | 1 | 1 | [acme-dental] Stripe Payment Sync |

## Sheets, docs and bases

| Name | Kind | Tabs | Affected | Workflows |
| --- | --- | --- | --- | --- |
| Acme Appointments | sheet | Past visits, Tomorrow | 2 | [acme-dental] Appointment Reminders, [acme-dental] Old Review Request (disabled) (inactive) |
| Acme Leads | sheet | Leads | 2 | [acme-dental] Lead Enrich, [acme-dental] Lead Intake |
| Bali Bookings | sheet | Bookings, Enquiries | 2 | [bali-villas] Booking Confirmation, [bali-villas] Villa Enquiry Webhook |
| Acme Payments Ledger | sheet | Ledger | 1 | [acme-dental] Stripe Payment Sync |

## Env vars

| Instance | Name | Affected | Workflows |
| --- | --- | --- | --- |
| acme-dental | SLACK_FRONTDESK_CHANNEL | 3 | [acme-dental] Notify Front Desk, [acme-dental] Lead Enrich, [acme-dental] Lead Intake |
| bali-villas | RECEIPT_URL | 2 | [bali-villas] Receipt Builder, [bali-villas] Booking Confirmation |
| bali-villas | OPENAI_MODEL | 1 | [bali-villas] Villa Enquiry Webhook |

## Webhooks

| Instance | Webhook | Authentication |
| --- | --- | --- |
| acme-dental | POST /acme***#3d12dd83 | none |
| bali-villas | POST /vill***#2ba6bbd3 | headerAuth |
| bali-villas | POST /vill***#3ea28d56 | none |

## Workflows

| Instance | Workflow | Active | Triggers | Error workflow |
| --- | --- | --- | --- | --- |
| acme-dental | Lead Intake | yes | webhook | none |
| acme-dental | Lead Enrich | yes | executeWorkflow | none |
| acme-dental | Notify Front Desk | yes | executeWorkflow | none |
| acme-dental | Appointment Reminders | yes | scheduleTrigger | set |
| acme-dental | Stripe Payment Sync | yes | scheduleTrigger | set |
| acme-dental | Error Alerts | yes | errorTrigger | is one |
| acme-dental | Old Review Request (disabled) | no | scheduleTrigger | none |
| bali-villas | Villa Enquiry Webhook | yes | webhook | none |
| bali-villas | Booking Confirmation | yes | webhook | none |
| bali-villas | Receipt Builder | yes | executeWorkflow | none |

## Limits

Static analysis of exported workflow JSON. Dynamic expressions show as `dynamic-expression`. No runtime tracing. Only credentials referenced by a workflow are listed.
