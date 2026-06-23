'use strict';
import nodemailer from 'nodemailer';
import 'dotenv/config';
import logger from './winston/index.js';

// SMTP 환경변수가 모두 설정돼 있을 때만 동작
const isMailConfigured = () =>
    !!(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS);

let transporter = null;
const getTransporter = () => {
    if (transporter) return transporter;
    if (!isMailConfigured()) return null;
    transporter = nodemailer.createTransport({
        host: process.env.MAIL_HOST,
        port: Number(process.env.MAIL_PORT || 587),
        secure: Number(process.env.MAIL_PORT) === 465, // 465=SSL, 587=STARTTLS
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASS,
        },
    });
    return transporter;
};

// 메일 발송 (실패해도 호출측 흐름을 막지 않도록 boolean 반환)
export const sendMail = async ({ to, subject, html, text }) => {
    try {
        const t = getTransporter();
        if (!t) {
            logger.warn('MAIL not configured - skip sendMail');
            return false;
        }
        await t.sendMail({
            from: process.env.MAIL_FROM || process.env.MAIL_USER,
            to: to || process.env.MAIL_TO,
            subject,
            html,
            text,
        });
        return true;
    } catch (err) {
        logger.error('sendMail 실패: ' + (err?.message || err));
        return false;
    }
};

export default sendMail;
