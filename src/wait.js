export class AsyncTimeoutError extends Error {
    constructor(time) {
        super(`Timed out after ${time}`);
    }
}

export function waitForAsync(timeout, call, ...args) {
    return new Promise((resolve, reject) => {
        let rejected = false;
        const tt = setTimeout(() => {
            if (rejected)
                return;
            rejected = true;
            reject(new AsyncTimeoutError(timeout));
        }, timeout);
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
