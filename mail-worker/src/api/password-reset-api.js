import app from '../hono/hono';
import passwordResetService from '../service/password-reset-service';
import result from '../model/result';

// Public: no login required. The request endpoint always answers the
// same way, whether or not the address has an account.
app.post('/forget-password', async (c) => {
	await passwordResetService.requestReset(c, await c.req.json());
	return c.json(result.ok());
});

app.post('/reset-password', async (c) => {
	await passwordResetService.confirmReset(c, await c.req.json());
	return c.json(result.ok());
});
