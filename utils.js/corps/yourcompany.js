const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

brand_id = 34 //brand_id 설정

// API URL
const goodsListUrl = "http://fast.arfighter.com/api/shop.goods/index";

// Parameters for goods list API
const params = new URLSearchParams({
    page: 1,
    limit: 100
});

// Get goods list
axios.get(goodsListUrl, { params })
    .then(response => {
        if (response.status === 200) {
            const goodsList = response.data.data || [];
            const prods = [];

            // Process goods list
            goodsList.forEach(item => {
                const goodsId = item.id;
                const goodsDetailUrl = "http://fast.arfighter.com/api/shop.goods/detail";
                const params = new URLSearchParams({ id: goodsId });

                // Get goods detail
                axios.get(goodsDetailUrl, { params })
                    .then(detailResponse => {
                        if (detailResponse.status === 200) {
                            const detailData = detailResponse.data.data.goods || {};
                            prods.push({
                                'product_name': detailData.title,
                                'product_price': detailData.marketprice,
                                'product_sale_price': detailData.price,
                                'brand_id': parseInt(brand_id),
                                'product_img': detailData.image,
                                'product_description': detailData.content
                            });
                        } else {
                            console.error(`Error: ${detailResponse.status}`);
                        }
                    })
                    .catch(error => console.error(error));
            });

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

            // Sign in
            session.post('auth/sign-in/', account)
                .then(() => {
                    prods.forEach(prod => {
                        const formData = new FormData();
                        for (const key in prod) {
                            formData.append(key, prod[key]);
                        }

                        // Add product
                        session.post('products/', formData, {
                            headers: formData.getHeaders()
                        })
                            .then(response => console.log(response.data))
                            .catch(error => console.error(error));
                    });
                })
                .catch(error => console.error(error));
        } else {
            console.error(`Error: ${response.status}`);
        }
    })
    .catch(error => console.error(error));
