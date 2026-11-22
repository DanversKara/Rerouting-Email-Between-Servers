import r2Service from '../service/r2-service';
import app from '../hono/hono';

app.get('/oss/*', async (c) => {
	const key = c.req.path.split('/oss/')[1];
	// Raw mail originals are private: they are only served through the
	// authenticated /api/email/raw endpoint. Never serve them here.
	let decoded = key || '';
	try {
		decoded = decodeURIComponent(decoded);
	} catch (e) {
		// Undecodable key: judge the raw form as-is.
	}
	if (decoded === 'raw' || decoded.startsWith('raw/')) {
		return c.notFound();
	}
	const resp = await r2Service.toObjResp(c, key);
	if (!resp) {
		return c.notFound();
	}
	return resp;
});



