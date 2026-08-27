// src/config/redis-client.js
import { createClient } from 'redis';

const redisUrl = 'redis://127.0.0.1:6379'

export const redisClient = createClient({
    url: redisUrl,
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 3) {
                console.warn('Redis 재연결 중단 - Redis 없이 동작합니다.');
                return false;
            }
            return Math.min(retries * 500, 3000);
        }
    }
});

let redisErrorLogged = false;
redisClient.on('error', (err) => {
    if (!redisErrorLogged) {
        console.error('Redis Client Error:', err.message);
        redisErrorLogged = true;
    }
});

export async function initRedis() {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
            console.log('Redis connected');
        }
    } catch (err) {
        console.warn('Redis 연결 실패 - Redis 없이 서버를 시작합니다:', err.message);
    }
}
