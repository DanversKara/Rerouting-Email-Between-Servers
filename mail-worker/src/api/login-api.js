import app from '../hono/hono';
import loginService from '../service/login-service';
import result from '../model/result';
import userContext from '../security/user-context';

app.post('/login', async (c) => {
	const data = await loginService.login(c, await c.req.json());
	// TOTP on: no JWT yet — the frontend shows the code step instead.
	if (data && data.totpRequired) {
		return c.json(result.ok({ totpRequired: true, challenge: data.challenge }));
	}
	return c.json(result.ok({ token: data }));
});

// Second step of a TOTP login. '/login' is in the auth middleware's
// exclude list, so this route is public like /login itself.
app.post('/login/totp', async (c) => {
	const token = await loginService.verifyTotpChallenge(c, await c.req.json());
	return c.json(result.ok({ token: token }));
});

app.post('/register', async (c) => {
	const jwt = await loginService.register(c, await c.req.json());
	return c.json(result.ok(jwt));
});

app.delete('/logout', async (c) => {
	await loginService.logout(c, userContext.getUserId(c));
	return c.json(result.ok());
});

