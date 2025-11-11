const async_hooks = require('async_hooks');

const asyncLocalStorage = new async_hooks.AsyncLocalStorage();

function runWithUser(userId, callback) {
    asyncLocalStorage.run({ userId }, callback);
}

function getUserId() {
    const store = asyncLocalStorage.getStore();
    return store ? store.userId : null;
}

module.exports = { runWithUser, getUserId };
