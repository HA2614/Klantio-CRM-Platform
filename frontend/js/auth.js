// Initialize Auth0 Client
async function initAuth0() {
    return await auth0.createAuth0Client({
        domain: AUTH0_CONFIG.domain,
        clientId: AUTH0_CONFIG.clientId,
        authorizationParams: {
            audience: AUTH0_CONFIG.audience,
            redirect_uri: AUTH0_CONFIG.redirectUri,
            scope: "openid profile email offline_access read:dashboard admin:access"
        },
        cacheLocation: "localstorage",
        useRefreshTokens: true
    });
}




// Get Access Token
async function getAccessToken(auth0Client) {
    try {
        const token = await auth0Client.getTokenSilently();
        return token;
    } catch (error) {
        console.error('Error getting token:', error);
        // If can't get token, redirect to login
        window.location.href = 'index.html';
        return null;
    }
}

// Logout
async function logout(auth0Client) {
    await auth0Client.logout({
        logoutParams: {
            returnTo: window.location.origin
        }
    });
}

