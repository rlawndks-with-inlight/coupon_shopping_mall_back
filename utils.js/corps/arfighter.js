import axios from 'axios';
import FormData from 'form-data';
import { pool } from '../../config/db.js';
import _ from 'lodash';
import { deleteQuery, updateQuery } from '../query-util.js';
import 'dotenv/config';
import when from 'when';
const brand_id = 34;
import { serialize } from 'object-to-formdata';
export const getArfighterItems = async () => {
    // brand_id 설정
    const category_group_id = 86;
    try {
        let dns_data = await pool.query(`SELECT * FROM brands WHERE id=${brand_id}`);
        dns_data = dns_data?.result[0];

        const Z_API_URL = 'http://www.tao-hai.com';
        const API_URL = process.env.BACK_URL;
        const account = {
            user_name: 'masterpurple',
            user_pw: 'qjfwk100djr!',
            is_manager: true
        };

        // Session
        const session = axios.create({
            baseURL: 'http://the-plusmall.co.kr/api/',
            withCredentials: true
        });
        // Sign in
        let domain_settting = await session.get('domain?dns=the-plusmall.co.kr');
        let sign_in_result = await session.post('auth/sign-in/', account);
        let category_list = await pool.query(`SELECT * FROM product_categories WHERE product_category_group_id=${category_group_id}`);
        category_list = category_list?.result;

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
        let max_page = 1;
        let { data: first_goods_data } = await axios.get(`${Z_API_URL}/api/shop.goods/index?page=1&limit=50`);
        first_goods_data = first_goods_data?.data ?? [];
        total_size = first_goods_data?.total;
        max_page = parseInt(total_size / 50) + (total_size % 50 == 0 ? 0 : 1);

        for (var i = max_page; i >= 1; i--) {
            let { data: goods_data } = await axios.get(`${Z_API_URL}/api/shop.goods/index?page=${i}&limit=50`);
            goods_data = goods_data?.data ?? [];
            let {
                total,
                per_page,
                current_page,
                last_page,
                data = [],
            } = goods_data;

            let when_list = [];

            for (var j = data.length - 1; j >= 0; j--) {
                when_list.push(processProduct(data[j], session, category_list));
            }
            for (var j = 0; j < when_list.length; j++) {
                await when_list[j];
            }
            let when_result = (await when(when_list));
            console.log(i);
        }
        console.log('success');
    } catch (err) {
        console.log(err);
    }
}
function convertCNYtoKRW(amountInCNY, exchangeRate) {
    // 중국 위안을 한국 원으로 변환
    return amountInCNY * exchangeRate;
}
const processProduct = async (item, session, category_list = []) => {
    try {
        let is_exist_product = await pool.query(`SELECT id FROM products WHERE another_id=? AND brand_id=?`, [
            item.id,
            brand_id,
        ])
        is_exist_product = is_exist_product?.result[0];
        let exist_images = await pool.query(`SELECT * FROM product_images WHERE product_id=${is_exist_product?.id}`);
        exist_images = exist_images?.result;

        let exchangeRate = 190.77;
        let product_price = convertCNYtoKRW(item.marketprice, exchangeRate);
        product_price = Math.round(product_price / 1000) * 1000;
        let product_sale_price = convertCNYtoKRW(item.price, exchangeRate);
        product_sale_price = Math.round(product_sale_price / 1000) * 1000;

        let process_item = {
            'product_name': item.title,
            'product_comment': item.subtitle,
            'product_price': product_price,
            'product_sale_price': product_sale_price,
            'brand_id': parseInt(brand_id),
            'product_img': item.image.replace('http://fast.arfighter.com', 'http://www.tao-hai.com'),
            'product_description': item.content,
            'another_id': item.id,
            'price_lang': 'ko',
            'status': 0,
            'category_id0': _.find(category_list, { another_id: item.category_id }).id,
            'price_lang_obj': JSON.stringify({
                cn: {
                    product_price: item.marketprice,
                    product_sale_price: item.price,
                }
            })
        }

        if (item?.title == '户外用品露营置物架便携式多功能野餐折叠桌椅多层收纳架') {
            console.log(process_item)
            console.log(item)
        }
        let formData = new FormData();

        if (is_exist_product) {
            let resultSubImg = exist_images;
            for (var i = 0; i < (item?.images ?? []).length; i++) {
                let existImage = _.find(exist_images, { product_sub_img: item?.images[i] });
                if (!existImage) {
                    resultSubImg.push(item?.images[i])
                }
            }
            process_item['sub_images'] = JSON.stringify(resultSubImg);
            for (const key in process_item) {
                formData.append(key, process_item[key]);
            }
            formData.append('id', is_exist_product?.id);
            const { data: response } = await session.put(`products/${is_exist_product?.id}`, formData, {
                headers: formData.getHeaders()
            });
            console.log('update')
            console.log(response)
        } else {
            process_item['sub_images'] = JSON.stringify(item?.images ?? []);
            for (const key in process_item) {
                formData.append(key, process_item[key]);
            }
            console.log('#######################################')
            console.log(process_item)
            const { data: response } = await session.post('products/', formData, {
                headers: formData.getHeaders()
            });
            console.log('insert')
            console.log(response)
        }
        return true;
    } catch (err) {
        console.log(err)
    }
}
//getArfighterItems();
