// 신규 가맹점 개설 시 메인페이지에 심어줄 기본 섹션 구성.
//
// 프론트 src/data/default-banners.js 와 이미지 목록이 일치해야 한다.
// (프론트는 '섹션 0개일 때 렌더 시점 폴백'용, 여기는 '개설 시 실제 저장'용 — 둘 다 같은 이미지를 쓴다)
// 이미지 실체: 프론트 public/assets/images/banners/*.jpg (무료·상업적 이용 가능, self-host)
//
// 배너만 심는다. 상품 섹션은 상품 id를 직접 지정하는 구조라 브랜드 공통 기본값이 성립하지 않음.

const BANNERS_235 = [
    '/assets/images/banners/banner-1.jpg',
    '/assets/images/banners/banner-2.jpg',
    '/assets/images/banners/banner-3.jpg',
    '/assets/images/banners/banner-4.jpg',
    '/assets/images/banners/banner-5.jpg',
    '/assets/images/banners/banner-6.jpg',
];

const BANNERS_2X1 = [
    '/assets/images/banners/banner-2x1-1.jpg',
    '/assets/images/banners/banner-2x1-2.jpg',
    '/assets/images/banners/banner-2x1-3.jpg',
    '/assets/images/banners/banner-2x1-4.jpg',
    '/assets/images/banners/banner-2x1-5.jpg',
    '/assets/images/banners/banner-2x1-6.jpg',
];

// contain(2:1) 배너 컨테이너를 쓰는 스토어 데모. 나머지는 cover(2.35:1).
const RATIO_2X1_DEMOS = [4, 5, 6, 9];

// 홈을 shop_obj 섹션 배열로 그리는 스토어 데모.
// 4·5·6·9는 자체 파일이 demo-1 홈을 감싸는 구조라 동일하게 shop_obj를 쓴다.
// 7·8은 자체 고정 레이아웃, 10은 빈 컴포넌트 → 섹션을 심어도 화면에 안 나온다.
const SECTION_BUILDER_SHOP_DEMOS = [1, 2, 3, 4, 5, 6, 9];
// 블로그는 1·2·3만 섹션 빌더. 4~9는 고정 레이아웃(대표상품 + 홈 문구).
const SECTION_BUILDER_BLOG_DEMOS = [1, 2, 3];

// 항목 shape은 관리자 편집기(front src/views/manager/main_obj/setting.js addDefaultBanner)와 동일하게 맞춘다.
// title_color 등이 빠지면 편집기 컬러 입력이 uncontrolled로 시작해 React 경고가 난다.
const bannerSection = (srcList) => ({
    type: 'banner',
    list: srcList.map((src) => ({
        src,
        title: '',
        title_color: '#ffffff',
        sub_title: '',
        sub_title_color: '#ffffff',
        link: '',
    })),
    style: { min_height: 200 },
});

// 스토어 데모의 기본 shop_obj (JSON 문자열). 섹션 빌더가 아니면 '[]'.
const defaultShopObj = (shopDemoNum) => {
    const n = Number(shopDemoNum) || 0;
    if (!SECTION_BUILDER_SHOP_DEMOS.includes(n)) return '[]';
    return JSON.stringify([bannerSection(RATIO_2X1_DEMOS.includes(n) ? BANNERS_2X1 : BANNERS_235)]);
};

// 블로그 데모의 기본 blog_obj (JSON 문자열). 블로그 배너는 cover라 2.35:1 세트로 통일.
const defaultBlogObj = (blogDemoNum) => {
    const n = Number(blogDemoNum) || 0;
    if (!SECTION_BUILDER_BLOG_DEMOS.includes(n)) return '[]';
    return JSON.stringify([bannerSection(BANNERS_235)]);
};

export {
    BANNERS_235,
    BANNERS_2X1,
    RATIO_2X1_DEMOS,
    SECTION_BUILDER_SHOP_DEMOS,
    SECTION_BUILDER_BLOG_DEMOS,
    defaultShopObj,
    defaultBlogObj,
};
