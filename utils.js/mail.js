'use strict';
import axios from 'axios';
import nodemailer from 'nodemailer';
import 'dotenv/config';
import logger from './winston/index.js';

// 발송 우선순위: HTTPS 이메일 API(포트 443, 절대 안 막힘) → SMTP(아웃바운드 열려 있을 때) → 스킵
// 서버에서 아웃바운드 SMTP(25/465/587)가 막힌 환경에서도 API는 동작한다.
// 사용법: 운영 .env 에 RESEND_API_KEY 또는 SENDGRID_API_KEY 중 하나만 넣으면 그걸로 발송.

const from = () => process.env.MAIL_FROM || process.env.MAIL_USER || 'no-reply@forspay.com';
const toList = (to) =>
    String(to || process.env.MAIL_TO || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

// 1) Resend (https://resend.com) — HTTPS API
const sendViaResend = async ({ to, subject, html, text }) => {
    await axios.post(
        'https://api.resend.com/emails',
        { from: from(), to: toList(to), subject, html, text },
        { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 15000 }
    );
    return true;
};

// 2) SendGrid (https://sendgrid.com) — HTTPS API
const sendViaSendgrid = async ({ to, subject, html, text }) => {
    const content = [];
    if (text) content.push({ type: 'text/plain', value: text });
    content.push({ type: 'text/html', value: html || text || ' ' });
    await axios.post(
        'https://api.sendgrid.com/v3/mail/send',
        {
            personalizations: [{ to: toList(to).map((email) => ({ email })) }],
            from: { email: from() },
            subject,
            content,
        },
        { headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` }, timeout: 15000 }
    );
    return true;
};

// 3) SMTP (nodemailer) — 아웃바운드 SMTP가 열려 있는 환경에서만
let transporter = null;
const isSmtpConfigured = () =>
    !!(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS);
const getTransporter = () => {
    if (transporter) return transporter;
    if (!isSmtpConfigured()) return null;
    transporter = nodemailer.createTransport({
        host: process.env.MAIL_HOST,
        port: Number(process.env.MAIL_PORT || 587),
        secure: Number(process.env.MAIL_PORT) === 465, // 465=SSL, 587=STARTTLS
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
    });
    return transporter;
};
const sendViaSmtp = async ({ to, subject, html, text }) => {
    const t = getTransporter();
    if (!t) return false;
    await t.sendMail({ from: from(), to: to || process.env.MAIL_TO, subject, html, text });
    return true;
};

// 메일 발송 (실패해도 호출측 흐름을 막지 않도록 boolean 반환)
export const sendMail = async ({ to, subject, html, text }) => {
    try {
        if (process.env.RESEND_API_KEY) return await sendViaResend({ to, subject, html, text });
        if (process.env.SENDGRID_API_KEY) return await sendViaSendgrid({ to, subject, html, text });
        if (isSmtpConfigured()) return await sendViaSmtp({ to, subject, html, text });
        logger.warn('MAIL not configured - skip sendMail');
        return false;
    } catch (err) {
        // API 에러면 응답 본문까지 남겨 원인 파악을 쉽게
        const detail = err?.response?.data
            ? JSON.stringify(err.response.data)
            : (err?.message || String(err));
        logger.error('sendMail 실패: ' + detail);
        return false;
    }
};

export default sendMail;
