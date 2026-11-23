import app from '../hono/hono';
import userService from '../service/user-service';
import result from '../model/result';
import userContext from '../security/user-context';

app.get('/my/loginUserInfo', async (c) => {
	const user = await userService.loginUserInfo(c, userContext.getUserId(c));
	return c.json(result.ok(user));
});

app.put('/my/resetPassword', async (c) => {
	await userService.resetPassword(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

// Per-user email security prefs (blockImages / disableLinks).
// Session-authenticated like /my/resetPassword (not in requirePerms).
app.put('/my/emailSecurity', async (c) => {
	await userService.setEmailSecurity(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

// Per-user two-factor authentication (TOTP). Session-authenticated
// like /my/resetPassword (not in requirePerms).
app.post('/my/totp/setup', async (c) => {
	const data = await userService.setupTotp(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/my/totp/enable', async (c) => {
	const data = await userService.enableTotp(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/my/totp/disable', async (c) => {
	await userService.disableTotp(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.post('/my/totp/regenerateBackupCodes', async (c) => {
	const data = await userService.regenerateBackupCodes(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.delete('/my/delete', async (c) => {
	await userService.delete(c, userContext.getUserId(c));
	return c.json(result.ok());
});


