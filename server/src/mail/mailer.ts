// Outgoing email. With SMTP configured, mail is delivered through nodemailer. Without it:
//   - development/test: the message is written to the outbox folder (a local mail sink), so
//     invitation and reset links can be followed without a mail server;
//   - production: nothing is sent and the caller is told so.
// The outcome is always reported truthfully; nothing claims an email was sent when it was not.

import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { toAppError } from '../errors/AppError.js';
import { log } from '../logging/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  template: string;
}

export type DeliveryStatus = 'SENT' | 'FAILED' | 'DEV_OUTBOX' | 'NOT_CONFIGURED';

let transporter: Transporter | null = null;

function transport(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transporter;
}

export async function sendMail(msg: MailMessage): Promise<DeliveryStatus> {
  const text = `${msg.text}\n\n—\nWorkPilot AI · Workforce management for modern teams.\nYou received this email because of activity on WorkPilot AI.`;
  if (config.smtpConfigured) {
    try {
      await transport().sendMail({ from: config.MAIL_FROM, to: msg.to, subject: msg.subject, text });
      return 'SENT';
    } catch (e) {
      const err = toAppError(e, { service: 'Email delivery', operation: 'mail.send' });
      log.error('mail.send_failed', { category: err.code, internalCode: err.internalCode, template: msg.template });
      return 'FAILED';
    }
  }
  if (config.isProd) {
    log.warn('mail.not_configured', { category: 'CONFIGURATION_ERROR', template: msg.template });
    return 'NOT_CONFIGURED';
  }
  // Development mail sink. The file name is not derived from user input.
  try {
    await fs.mkdir(config.outboxDir, { recursive: true });
    const file = path.join(config.outboxDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${msg.template}-${Math.random().toString(36).slice(2, 8)}.txt`);
    await fs.writeFile(file, `DEVELOPMENT OUTBOX — this email was NOT sent.\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${text}\n`, 'utf8');
    log.info('mail.dev_outbox', { template: msg.template, file: path.basename(file) });
    return 'DEV_OUTBOX';
  } catch (e) {
    log.error('mail.outbox_failed', { category: 'STORAGE_ERROR', message: (e as Error).message });
    return 'FAILED';
  }
}

export const appUrl = (p: string) => `${config.APP_ORIGIN.replace(/\/$/, '')}${p}`;
