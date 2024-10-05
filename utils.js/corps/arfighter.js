import axios from 'axios';
import FormData from 'form-data';
import { pool } from '../../config/db.js';
import _ from 'lodash';
import { deleteQuery, updateQuery } from '../query-util.js';
import 'dotenv/config';
import when from 'when';

const brand_id = 64;
const Z_API_URL = 'http://www.tao-hai.com';

const structuredSkuAttrs = (option_group) => {
    let result_option_group = option_group.map(item => {
        const attributes = item.split(',');
        const result = {};
        function translateKeyToEnglish(key) {
            const translations = {
                //'颜色': 'color',
                //'规格': 'size',
                // 필요한 다른 번역들을 여기에 추가
            };
            return translations[key] || key; // 번역이 없으면 원래 키를 사용
        }

        attributes.forEach(attr => {
            const [key, value] = attr.split(':');
            // 키 이름을 영어로 변환 (선택적)
            const englishKey = translateKeyToEnglish(key.trim());
            result[englishKey] = value.trim();
        });

        return result;
    });
    return result_option_group;
}

function extractOptionsAndGroups(data) {
    const groups = [];
    const options = {};

    data.forEach(item => {
        Object.keys(item).forEach(key => {
            if (!options[key]) {
                options[key] = new Set();
            }
            options[key].add(item[key]);
        });
    });

    Object.keys(options).forEach(groupName => {
        groups.push({
            group_name: groupName,
            options: Array.from(options[groupName]).map(option => ({ option_name: option }))
        });
    });

    return { groups };
}
const groupFilter = (product_groups_ = [], groups = []) => {
    let product_groups = product_groups_;
    let delete_groups = [];
    for (var i = 0; i < groups.length; i++) {
        let group = groups[i];
        let is_exist_group = _.find(product_groups, { group_name: group?.group_name });
        let group_idx = _.findIndex(product_groups, { group_name: group?.group_name });
        if (is_exist_group) {
            let options = group?.options ?? [];
            for (var j = 0; j < options.length; j++) {
                let is_exist_option = _.find(is_exist_group?.options, { option_name: options[i]?.option_name });
                if (is_exist_option) {

                } else {
                    product_groups[group_idx].options.push(options[i]);
                }
            }
        } else {
            product_groups.push(group);
        }
    }
    for (var i = 0; i < product_groups.length; i++) {
        let is_exist_group = _.find(groups, { group_name: product_groups[i]?.group_name });
        if (!is_exist_group) {
            product_groups[i].is_delete = 1;
        } else {
            product_groups[i].options = (product_groups[i]?.options ?? []).map(option => {
                let is_exist_option = _.find((is_exist_group?.options ?? []), { option_name: option?.option_name });
                if (!is_exist_option) {
                    return {
                        ...option,
                        is_delete: 1,
                    }
                } else {
                    return option;
                }

            })
        }
    }
    return product_groups;
}
export const getArfighterItems = async () => {
    // brand_id 설정
    const category_group_id = 147;
    try {
        let dns_data = await pool.query(`SELECT * FROM brands WHERE id=${brand_id}`);
        dns_data = dns_data?.result[0];

        const API_URL = process.env.BACK_URL;
        const account = {
            user_name: 'masterpurple',
            user_pw: 'qjfwk100djr!',
            is_manager: true
        };

        // Session
        const session = axios.create({
            baseURL: 'http://the-plusmall.com/api/',
            withCredentials: true
        });
        // Sign in
        let domain_settting = await session.get('domain?dns=the-plusmall.com');
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

        for (var i = 1; i <= max_page; i++) {
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
const processProduct = async (item_, session, category_list = []) => {
    try {
        let item = item_;
        let is_exist_product = await pool.query(`SELECT id FROM products WHERE another_id=? AND brand_id=?`, [
            item.id,
            brand_id,
        ])
        is_exist_product = is_exist_product?.result[0];

        let { data: option_data } = await axios.get(`${Z_API_URL}/api/shop.goods/goods_sku?id=${item.id}`);
        option_data = option_data?.data ?? [];
        option_data = option_data.map(item => item.sku_attr);
        const { groups } = extractOptionsAndGroups(structuredSkuAttrs(option_data));

        let product_groups = [];
        /*
                if (is_exist_product) {
            product_groups = await pool.query(`SELECT * FROM product_option_groups WHERE product_id=${is_exist_product?.id}`);
            product_groups = product_groups?.result ?? [];
            for (var i = 0; i < product_groups.length; i++) {
                let product_group = product_groups[i];
                let options = await pool.query(`SELECT * FROM product_options WHERE group_id=${product_group?.id}`);
                options = options?.result;
                product_groups[i].options = options;
            }
            product_groups = groupFilter(product_groups ?? [], groups);

        } else {
            product_groups = groups;
        }
*/



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




        process_item['groups'] = JSON.stringify(product_groups);

        if (is_exist_product) {
            let exist_images = await pool.query(`SELECT * FROM product_images WHERE product_id=${is_exist_product?.id}`);
            exist_images = exist_images?.result;
            let resultSubImg = exist_images;

            /*let exist_options = await pool.query(`SELECT * FROM product_option_groups WHERE product_id=${is_exist_product?.id}`);
            exist_options = exist_options?.result;*/

            //console.log(exist_options)

            for (var i = 0; i < (item?.images ?? []).length; i++) {
                let existImage = _.find(exist_images, { product_sub_img: item?.images[i] });
                if (!existImage) {
                    resultSubImg.push({ product_sub_img: item?.images[i] })
                }
            }
            process_item['sub_images'] = JSON.stringify(resultSubImg);
            //console.log(process_item)
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
            item.images = (item?.images ?? []).map(url => {
                return {
                    product_sub_img: url
                }
            })
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