'use strict';
import { insertQuery } from "./query-util.js";
import { readPool } from "../config/db-pool.js";

// 신규 가맹점에 기본 게시판(공지사항 / 1:1문의)을 심는다.
//
// 1:1문의 = 볼수있는대상 '자신 및 관리자만'(read_type=1) + 회원 글쓰기 허용(is_able_user_add=1)
//   → 고객이 남긴 문의에 관리자가 답변하는 문의함으로 동작하고, 대시보드 '문의관리' 카드에도 잡힌다.
//
// ⚠ 왜 우리가 미리 심어 주는가 —
//   게시판 생성은 레벨50(본사) 전용이다. 가맹점은 스스로 만들 수 없다.
//   그래서 개설 단계에서 안 심어 주면 그 몰은 **문의함이 아예 없는 채로 시작**하고,
//   사장님이 손쓸 방법이 없다. 대시보드 '문의관리' 카드도 빈 채로 남는다.
//
// ⚠ 몰을 만드는 길이 둘이다. 둘 다 이 함수를 불러야 한다.
//   ① 가맹점 신청 승인 (merchant_application.controller)
//   ② 브랜드설정에서 직접 생성 (brand.controller) — 자체 도메인 가맹점이 이 길로 들어온다
//   예전에는 ① 에만 있어서, ② 로 만든 몰은 게시판이 통째로 없었다(2026-08-25 확인).
//   그래서 함수를 여기로 빼 두 곳이 같은 것을 쓰게 한다 — 복사하면 한쪽만 고쳐진다.
//
// 이미 같은 이름의 게시판이 있으면 만들지 않는다(멱등). 두 번 불러도 안전하다.
export const seedDefaultBoards = async (brandId) => {
    if (!brandId) return;
    const boards = [
        { post_category_title: '공지사항', parent_id: -1, is_able_user_add: 0, post_category_type: 0, post_category_read_type: 0 },
        { post_category_title: '1:1문의', parent_id: -1, is_able_user_add: 1, post_category_type: 0, post_category_read_type: 1 },
    ];
    const exist = await readPool.query(
        `SELECT post_category_title FROM post_categories WHERE brand_id=? AND is_delete=0`,
        [brandId]
    );
    const existTitles = (exist[0] || []).map((r) => r.post_category_title);
    for (const b of boards) {
        if (existTitles.includes(b.post_category_title)) continue;
        await insertQuery('post_categories', { ...b, brand_id: brandId });
    }
};

export default seedDefaultBoards;
