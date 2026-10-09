/** SMTP 发信（只在 Node 版用；Workers 没有原生 TCP 的 SMTP 客户端） */
import nodemailer from 'nodemailer';
import type { MailSettings, Mail } from './mail.ts';

export async function sendSmtp(m: MailSettings, mail: Mail) {
  const t = nodemailer.createTransport({
    host: m.smtp.host, port: m.smtp.port,
    secure: m.smtp.port === 465, // 465 一上来就是 TLS；587 / 25 先明文再 STARTTLS
    auth: { user: m.smtp.user, pass: m.smtp.pass },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  await t.sendMail({ from: m.fromName ? { name: m.fromName, address: m.fromEmail } : m.fromEmail, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
}
