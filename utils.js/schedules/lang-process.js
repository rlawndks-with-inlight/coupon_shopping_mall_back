import { readPool, writePool } from "../../config/db-pool.js";
import { deleteQuery, updateQuery } from "../query-util.js";
import { settingLangs } from "../util.js";

const table_name = 'lang_processes';

export const lang_obj_columns = {
    post_categories: [
        'post_category_title',
    ],
    posts: [
        'post_title',
        'post_content',
    ],
    product_category_groups: [
        'category_group_name',
    ],
    product_categories: [
        'category_name',
        'category_description',
    ],
    products: [
        'product_name',
        'product_comment',
    ],
    product_options: [
        'option_name',
    ],
    product_option_groups: [
        'group_name'
    ]
}

export const langProcess = async () => {
    let process_items = await readPool.query(`SELECT * FROM ${table_name} WHERE is_confirm=0`);
    process_items = process_items[0];
    if (process_items.length > 0) {
        let brand_ids = process_items.map(itm => {
            return itm?.brand_id
        })
        brand_ids = new Set(brand_ids);
        brand_ids = [...brand_ids];

        let brands = await readPool.query(`SELECT * FROM brands WHERE id IN (${brand_ids.join()})`);
        brands = brands[0];

        let brand_obj = {};

        for (var i = 0; i < brands.length; i++) {
            brands[i].setting_obj = JSON.parse(brands[i]?.setting_obj ?? '{}')
            brand_obj[brands[i]?.id] = brands[i];
        }

        let table_obj = {};
        for (var i = 0; i < process_items.length; i++) {
            if (!table_obj[process_items[i]?.table_name]) {
                table_obj[process_items[i]?.table_name] = [];
            }
            process_items[i].obj = JSON.parse(process_items[i]?.obj ?? '{}');
            table_obj[process_items[i]?.table_name].push(process_items[i]);
        }
        for (var i = 0; i < Object.keys(table_obj).length; i++) {
            let table = Object.keys(table_obj)[i];
            for (var j = 0; j < table_obj[table].length; j++) {

                let langs = await settingLangs(lang_obj_columns[table], table_obj[table][j].obj, brand_obj[table_obj[table][j].brand_id], table, table_obj[table][j]?.item_id, true);

                let update_result = await updateQuery(table, {
                    lang_obj: langs.lang_obj
                }, table_obj[table][j]?.item_id);

                let delete_result = await deleteQuery('lang_processes', {
                    table_name: `'${table}'`,
                    item_id: table_obj[table][j]?.item_id,
                }, true)
            }
        }
    }
}

export const brandSettingLang = async (new_brand_data_ = {}) => {
    let new_brand_data = new_brand_data_;
    new_brand_data.setting_obj = JSON.parse(new_brand_data?.setting_obj ?? '{}');

    let ago_brand = await readPool.query(`SELECT * FROM brands WHERE id=${new_brand_data?.id}`);
    ago_brand = ago_brand[0][0];
    ago_brand.setting_obj = JSON.parse(ago_brand?.setting_obj ?? '{}');
    if (new_brand_data?.setting_obj?.is_use_lang == 1) {
        new_brand_data.shop_obj = JSON.parse(new_brand_data?.shop_obj ?? '[]');
        for (var i = 0; i < new_brand_data.shop_obj.length; i++) {
            if (!new_brand_data.shop_obj[i]?.lang_obj) {
                new_brand_data.shop_obj[i].lang_obj = {};
            }
            if (new_brand_data.shop_obj[i]?.title) {
                let title_lang_obj = await settingLangs(
                    ['title'],
                    { title: new_brand_data.shop_obj[i]?.title },
                    new_brand_data,
                    'brands',
                    new_brand_data?.id,
                    true,
                )

                title_lang_obj.lang_obj = JSON.parse(title_lang_obj?.lang_obj ?? '{}');
                new_brand_data.shop_obj[i].lang_obj = {
                    ...new_brand_data.shop_obj[i].lang_obj,
                    ...title_lang_obj.lang_obj,
                }
            }
            for (var j = 0; j < (new_brand_data.shop_obj[i]?.list ?? []).length; j++) {
                if (new_brand_data.shop_obj[i]?.list[j]?.category_name) {
                    let category_name_obj = await settingLangs(
                        ['category_name'],
                        { category_name: new_brand_data.shop_obj[i]?.list[j]?.category_name },
                        new_brand_data,
                        'brands',
                        new_brand_data?.id,
                        true,
                    )
                    category_name_obj.lang_obj = JSON.parse(category_name_obj?.lang_obj ?? '{}');

                    new_brand_data.shop_obj[i].list[j].lang_obj = {
                        ...category_name_obj.lang_obj,
                    }
                }
            }
        }
        new_brand_data.shop_obj = JSON.stringify(new_brand_data.shop_obj);
    }
    if (ago_brand?.setting_obj?.is_use_lang != 1 && new_brand_data?.setting_obj?.is_use_lang == 1) {
        let insert_lang_process_list = [];
        for (var i = 0; i < Object.keys(lang_obj_columns).length; i++) {
            let table = Object.keys(lang_obj_columns)[i];
            if (table == 'posts') {
                let posts = await readPool.query(`SELECT posts.id, posts.post_title, posts.post_content FROM posts LEFT JOIN post_categories ON posts.category_id=post_categories.id WHERE post_categories.brand_id=${new_brand_data?.id}`);
                posts = posts[0];
                for (var j = 0; j < posts.length; j++) {
                    insert_lang_process_list.push([
                        table,
                        posts[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(posts[j])
                    ])
                }
            } else {
                let items = await readPool.query(`SELECT id,${lang_obj_columns[table].join()} FROM ${table} WHERE brand_id=${new_brand_data?.id}`);
                items = items[0];
                for (var j = 0; j < items.length; j++) {

                    insert_lang_process_list.push([
                        table,
                        items[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(items[j])
                    ])
                }
            }
        }
        for (var i = 0; i < insert_lang_process_list.length / 1000; i++) {
            let result = await writePool.query(`INSERT INTO ${table_name} (table_name, item_id, brand_id, obj) VALUES ?`, [insert_lang_process_list.slice((i * 1000), (i + 1) * 1000)]);
        }
    }

    delete new_brand_data.id;
    return new_brand_data;
}