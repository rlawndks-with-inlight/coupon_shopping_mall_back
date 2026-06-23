-- 메인 사이트(랜딩) — 무료쇼핑몰 가맹점 신청 테이블
-- 신청서가 들어오면 status=pending 으로 저장되고,
-- 매니저 페이지에서 승인(approved) / 반려(rejected) 처리합니다.

CREATE TABLE IF NOT EXISTS merchant_applications (
    id INT AUTO_INCREMENT PRIMARY KEY,

    -- 사업자 정보
    business_name VARCHAR(120) NOT NULL,
    business_number VARCHAR(20) NOT NULL,
    mail_order_number VARCHAR(120) DEFAULT '',

    -- 대표자 정보
    ceo_name VARCHAR(60) NOT NULL,
    ceo_phone VARCHAR(30) NOT NULL,
    ceo_email VARCHAR(120) DEFAULT '',

    -- 담당자 정보
    manager_name VARCHAR(60) NOT NULL,
    manager_phone VARCHAR(30) NOT NULL,
    manager_email VARCHAR(120) DEFAULT '',

    -- 운영 정보
    cs_phone VARCHAR(30) DEFAULT '',
    referrer_name VARCHAR(60) DEFAULT '',

    -- 쇼핑몰 설정
    desired_slug VARCHAR(40) NOT NULL,
    selected_frame VARCHAR(20) DEFAULT '',

    -- 약정서 동의 (감사 추적용)
    agreement_agreed TINYINT(1) DEFAULT 0,
    agreement_agreed_at DATETIME NULL,
    agreement_agreed_ip VARCHAR(64) DEFAULT '',

    -- 처리 상태
    status VARCHAR(20) DEFAULT 'pending',
    brand_id INT DEFAULT 0,
    memo TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_status (status),
    INDEX idx_slug (desired_slug),
    INDEX idx_created (created_at)
);
