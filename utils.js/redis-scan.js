'use strict';
// Redis 키를 패턴으로 찾아 지우는 공용 도구.
//
// ⚠ 여기 있는 이유 — redis 라이브러리를 v4 에서 v5 로 올리면서 scanIterator 의 계약이 바뀌었다.
//     v4 : 키를 **하나씩** 내놓았다        → for await (const key of ...) 에서 key 는 문자열
//     v5 : 키를 **묶음(배열)으로** 내놓는다 → key 는 배열. key.endsWith 는 함수가 아니다.
//   (@redis/client v5 소스: `yield reply.keys`)
//
//   그래서 운영 서버 로그에 이 에러가 계속 찍히고 있었다:
//     Redis cache invalidation error (changeStatus): TypeError: key.endsWith is not a function
//   캐시 삭제가 통째로 실패했다는 뜻이다. 상품을 품절·비공개로 내려도 고객 화면에는
//   TTL(300초)이 끝날 때까지 그대로 보이고, 그동안 장바구니에 담겨 결제까지 갈 수 있었다.
//
//   더 고약한 건 조용히 넘어간 자리들이다. del(배열) 은 v5 에서 정상 동작해서
//   문자열 검사 없이 바로 지우던 코드는 에러 없이 '되는 것처럼' 보였다. 그런데
//   SCAN 은 커서가 남아 있어도 **빈 묶음**을 내놓을 수 있고, del([]) 은 터진다:
//     ERR wrong number of arguments for 'del' command
//   (2026-08-24 운영 서버에서 직접 확인)
//
// 그래서 이 파일 하나만 쓰게 하고, 아래 두 가지를 여기서 책임진다.
//   ① v4·v5 어느 쪽 모양이 와도 키를 하나씩 다룬다 (다시 올려도 안 깨진다)
//   ② 빈 묶음은 건너뛰고, 지울 것은 묶어서 한 번에 지운다

// scanIterator 가 내놓는 것을 '키 문자열 배열'로 통일한다.
const 묶음으로 = (내놓은것) => {
    if (내놓은것 == null) return [];
    // v5: 배열로 온다
    if (Array.isArray(내놓은것)) return 내놓은것.map((k) => String(k));
    // v4: 키 하나가 문자열(또는 Buffer)로 온다
    return [String(내놓은것)];
};

// 패턴에 맞는 키를 훑으면서 하나씩 넘겨준다.
// 호출측은 v4/v5 를 신경 쓰지 않고 언제나 '문자열 키'를 받는다.
export async function* scanKeys(client, pattern, { count = 100 } = {}) {
    if (!client?.isOpen) return;
    for await (const 내놓은것 of client.scanIterator({ MATCH: pattern, COUNT: count })) {
        for (const key of 묶음으로(내놓은것)) yield key;
    }
}

// 패턴에 맞는 키를 지운다. 지울 키를 고르는 조건을 줄 수 있다.
//   deleteKeys(redisClient, 'product:detail:3:*', (key) => key.endsWith(':17'))
// 반환값은 실제로 지운 키 개수.
//
// 캐시 삭제가 실패해도 요청 자체는 성공으로 둔다 — TTL 로 자연 만료되므로,
// 여기서 에러를 올리면 멀쩡한 상태변경까지 실패로 보이게 된다. 그래서 호출측의
// try/catch 는 그대로 두되, 여기서도 빈 배열 같은 뻔한 사고는 만들지 않는다.
export const deleteKeys = async (client, pattern, 고르기 = null, { count = 100 } = {}) => {
    if (!client?.isOpen) return 0;
    let 지운수 = 0;
    let 모은것 = [];
    const 비우기 = async () => {
        if (!모은것.length) return;          // del([]) 은 ERR 를 낸다. 빈 채로 부르지 않는다.
        await client.del(모은것);
        지운수 += 모은것.length;
        모은것 = [];
    };
    for await (const key of scanKeys(client, pattern, { count })) {
        if (고르기 && !고르기(key)) continue;
        모은것.push(key);
        if (모은것.length >= 100) await 비우기();   // 한 번에 너무 많이 보내지 않는다
    }
    await 비우기();
    return 지운수;
};

export default { scanKeys, deleteKeys };
