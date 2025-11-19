module.exports = {
    secret: process.env.AUTH_SECRET || "mateomi",
    expires: process.env.AUTH_EXPIRES || "24h",
    rounds: process.env.AUTH_ROUNDS || 10,
    expireInvitation: process.env.AUTH_EXPIRES_INVITATION || "24h",
}