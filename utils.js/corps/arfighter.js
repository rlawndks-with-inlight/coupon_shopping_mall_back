import axios from 'axios';
import FormData from 'form-data';
import { pool } from '../../config/db.js';

export default async function getArfighterItems(req, res) {
    const brand_id = 34; // brand_id 설정

    // API URL
    const goodsListUrl = "http://fast.arfighter.com/api/shop.goods/index";

    // Parameters for goods list API
    const params = new URLSearchParams({
        page: 1,
        limit: 100
    });

    try {
        // Get goods list
        const response = await axios.get(goodsListUrl, { params });
        if (response.status === 200) {
            const goodsList = response.data.data || [];
            let prods = [];

            // Process goods list
            for (const item of goodsList) {
                const goodsId = item.id;
                const goodsDetailUrl = "http://fast.arfighter.com/api/shop.goods/detail";
                const params = new URLSearchParams({ id: goodsId });

                // Get goods detail
                const detailResponse = await axios.get(goodsDetailUrl, { params });
                if (detailResponse.status === 200) {
                    const detailData = detailResponse.data.data.goods || {};
                    prods.push({
                        'product_name': detailData.title,
                        'product_price': detailData.marketprice,
                        'product_sale_price': detailData.price,
                        'brand_id': parseInt(brand_id),
                        'product_img': detailData.image,
                        'product_description': detailData.content,
                        'another_id': detailData.id,
                    });
                } else {
                    console.error(`Error: ${detailResponse.status}`);
                }
            }
            // Login credentials
            const account = {
                user_name: 'masterpurple',
                user_pw: 'qjfwk100djr!',
                is_manager: true
            };

            // Session
            const session = axios.create({
                baseURL: 'https://theplusmall.co.kr/api/',
                withCredentials: true
            });
            console.log('@@@')
            // Sign in
            let sign_in_result = await session.post('auth/sign-in/', account);
            console.log(sign_in_result)
            // Add products
            for (const prod of prods) {
                let formData = new FormData();
                for (const key in prod) {
                    formData.append(key, prod[key]);
                }
                let is_exist_product = await pool.query(`SELECT * FROM products WHERE another_id=? AND brand_id=?`, [
                    prod['another_id'],
                    brand_id,
                ])
                is_exist_product = is_exist_product?.result[0];
                console.log(is_exist_product)
                if (is_exist_product) {
                    const response = await session.put(`products/${is_exist_product?.id}`, formData, {
                        headers: formData.getHeaders()
                    });
                } else {
                    const response = await session.post('products/', formData, {
                        headers: formData.getHeaders()
                    });
                }
                // Add product
                console.log(response.data);
            }
            console.log('success')
            res.status(200).json({ message: 'Products imported successfully.' });
        } else {
            console.error(`Error: ${response.status}`);
            res.status(response.status).json({ error: `Error: ${response.status}` });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
}