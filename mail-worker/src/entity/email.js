import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const email = sqliteTable('email', {
	emailId: integer('email_id').primaryKey({ autoIncrement: true }),
	sendEmail: text('send_email'),
	name: text('name'),
	senderEmail: text('sender_email').default('').notNull(),
	accountId: integer('account_id').notNull(),
	userId: integer('user_id').notNull(),
	subject: text('subject'),
	code: text('code').default('').notNull(),
	text: text('text'),
	content: text('content'),
	cc: text('cc').default('[]'),
	bcc: text('bcc').default('[]'),
	recipient: text('recipient'),
	toEmail: text('to_email').default('').notNull(),
	toName: text('to_name').default('').notNull(),
	inReplyTo: text('in_reply_to').default(''),
	relation: text('relation').default(''),
	messageId: text('message_id').default(''),
	type: integer('type').default(0).notNull(),
	status: integer('status').default(0).notNull(),
	resendEmailId: text('resend_email_id'),
	message: text('message'),
	unread: integer('unread').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	// Two-way state sync: when this row's read/delete state last changed.
	// New mail starts at its arrival time (DB default); mark-read,
	// delete, restore and reportSpam stamp it on every change, and the
	// sync worker's state pass lists rows by (update_time, email_id).
	updateTime: text('update_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	// Two-way state sync: when the user last restored this row from
	// Trash in the backup ('' = never). The sync worker's state pass
	// only moves the home copy out of Trash when this is newer than its
	// cursor, so an old "not deleted" state can never undo a delete
	// made at home.
	restoreTime: text('restore_time').default('').notNull(),
	isDel: integer('is_del').default(0).notNull()
});
export default email
