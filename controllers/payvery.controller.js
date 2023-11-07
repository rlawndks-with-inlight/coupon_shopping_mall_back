'use strict';
import axios from 'axios';
import 'dotenv/config';

const PAYVERY_URL = process.env.PAYVERY_URL
const payveryCtrl = {
    login: async () => {
        try {
            let obj = {
                brand_id: 16,
                user_name: 'masterpurple',
                user_pw: 'qjfwk100djr!',
            }
            let result = await axios.post(`${PAYVERY_URL}/api/v1/auth/sign-in`,obj);

        } catch (err) {
            return false;
        }
    },
    mcht: {
        get: async () => {
            try {

            } catch (err) {
                return false;
            }
        },
        create: async () => {
            try {

            } catch (err) {
                return false;
            }
        },
        delete: async () => {
            try {

            } catch (err) {
                return false;
            }
        },
    },
    pay: {
        gateways: async () => {
            try {

            } catch (err) {
                return false;
            }
        },
    }
};

export default payveryCtrl;
