import axios from 'axios';
import FormData from 'form-data';
import { pool } from '../../config/db.js';
import _ from 'lodash';
import { deleteQuery, updateQuery } from '../query-util.js';
import 'dotenv/config';

const brand_id = 34;

export const getArfighterItems = async () => {
    // brand_id 설정
    const category_group_id = 86;

    try {

        let dns_data = await pool.query(`SELECT * FROM brands WHERE id=${brand_id}`);
        dns_data = dns_data?.result[0];

        const Z_API_URL = 'http://fast.arfighter.com';
        const API_URL = process.env.BACK_URL;
        const account = {
            user_name: 'masterpurple',
            user_pw: 'qjfwk100djr!',
            is_manager: true
        };

        // Session
        const session = axios.create({
            baseURL: 'https://theplusmail.co.kr/api/',
            withCredentials: true
        });
        // Sign in
        let sign_in_result = await session.post('auth/sign-in/', account);

        /*
        let { data: z_category_list } = await axios.get(`${Z_API_URL}/api/shop.category/index`);
        z_category_list = z_category_list?.data?.list ?? [];
        let category_list = await pool.query(`SELECT * FROM product_categories WHERE product_category_group_id=${category_group_id}`);
        category_list = category_list?.result;
        for (var i = 0; i < category_list.length; i++) {
            let category = category_list[i];
            let z_category = _.find(z_category_list, { id: parseInt(category?.another_id) });
            if (!z_category) {
                let delete_result = await deleteQuery(`product_categories`, {
                    id: category?.id
                })
            } else {
                let update_result = await session.put(`product-categories/${category?.id}`, {
                    category_img: z_category?.image,
                    parent_id: category?.parent_id,
                    category_type: 0,
                    category_name: z_category?.name,
                    category_description: '',
                    product_category_group_id: 86,
                    another_id: z_category?.id,
                    id: category?.id
                });
            }
        }
        category_list = await pool.query(`SELECT * FROM product_categories WHERE product_category_group_id=${category_group_id}`);
        category_list = category_list?.result;

        for (var i = 0; i < z_category_list.length; i++) {
            let z_category = z_category_list[i];
            let category = _.find(category_list, { another_id: parseInt(z_category?.id) });
            if (!category) {
                let insert_result = await session.post(`product-categories`, {
                    category_img: z_category?.image,
                    category_type: 0,
                    category_name: z_category?.name,
                    category_description: '',
                    product_category_group_id: 86,
                    another_id: z_category?.id,
                });
                console.log(insert_result)
            }
        }
    */
        // 카테고리 불러옴
        let insert_list = [];
        let update_list = [];
        let total_size = 0;
        for (var i = 0; i < 100; i++) {
            let { data: goods_data } = await axios.get(`${Z_API_URL}/api/shop.goods/index?page=${i + 1}&limit=50`);
            goods_data = goods_data?.data ?? [];
            let {
                total,
                per_page,
                current_page,
                last_page,
                data = [],
            } = goods_data;
            if (i == 0) {
                total_size = total;
            } else {
                if (i > total_size / 50) {
                    break;
                }
            }
            for (var j = 0; j < data.length; j++) {
                let result = await processProduct(data[j], session);
            }
            console.log(i);
        }
    } catch (err) {
        console.log(err);
    }
}
const processProduct = async (item, session) => {
    console.log('@@@@@@@@@@@@@')
    try {
        let is_exist_product = await pool.query(`SELECT id FROM products WHERE another_id=? AND brand_id=?`, [
            item.id,
            brand_id,
        ])
        is_exist_product = is_exist_product?.result[0];
        let process_item = {
            'product_name': item.title,
            'product_price': item.marketprice,
            'product_sale_price': item.price,
            'brand_id': parseInt(brand_id),
            'product_img': item.image,
            'product_description': item.content,
            'another_id': item.id,
            'price_lang': 'cn',
        }
        let formData = new FormData();
        for (const key in process_item) {
            formData.append(key, process_item[key]);
        }
        if (is_exist_product) {
            formData.append('id', is_exist_product?.id);
            const response = await session.put(`products/${is_exist_product?.id}`, formData, {
                headers: formData.getHeaders()
            });
            console.log(response)
        } else {
            const response = await session.post('products/', formData, {
                headers: formData.getHeaders()
            });
            console.log(response)
        }
        return true;
    } catch (err) {
        console.log(err)
    }
}
getArfighterItems();