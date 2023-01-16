export class AsyncTimeoutError extends Error {
    constructor(time: number) {
        super(`Timed out after ${time}`);
    }
}

export function waitForAsync<T>(timeout: number, call: (...args: unknown[]) => Promise<T>, ...args: unknown[]) {
    return new Promise<T>((resolve, reject) => {
        let rejected = false;
        const tt = setTimeout(() => {
            if (rejected)
                return;
            rejected = true;
            reject(new AsyncTimeoutError(timeout));
        }, timeout);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        call(...args).then(data => {
            if (rejected)
                return;
            clearTimeout(tt);
            resolve(data);
        }).catch(e => {
            if (rejected)
                return;
            clearTimeout(tt);
            rejected = true;
            reject(e);
        });
    });
}

export function sleep(timeout: number) {
    return new Promise<void>(resolve => {
        setTimeout(() => {
            resolve();
        }, timeout);
    });
}

type MatchType = {
    [ key: string ]: unknown;
};

interface RetryType {
    maxRetries: number;
    retryIntervalMs: number;
}

export function match(needle: MatchType, haystack: MatchType) {
    for (const k of Object.keys(needle)) {
        if (haystack[k] !== needle[k])
            return false;
    }
    return true;
}

export async function retryOnError<T>(needle: MatchType, retry: RetryType, call: (...args: unknown[]) => Promise<T | undefined>, ...args: unknown[]) {
    let n = 0;

    for (; n < retry.maxRetries; ++n) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            return await call(...args);
        } catch (e) {
            if (match(needle, e as MatchType)) {
                await sleep(retry.retryIntervalMs);
                continue;
            }
            throw e;
        }
    }

    return undefined;
}
