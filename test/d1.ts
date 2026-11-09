// Minimal D1 stand-in on node:sqlite, using the real migrations.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1StatementLike } from "../src/db/store";

class Stmt implements D1StatementLike {
	constructor(
		private db: DatabaseSync,
		private sql: string,
		private params: unknown[] = [],
	) {}
	bind(...values: unknown[]) {
		// D1 rejects undefined; so do we, to catch bugs.
		if (values.some((v) => v === undefined)) throw new Error(`D1_TYPE_ERROR: undefined bound in ${this.sql.slice(0, 60)}`);
		return new Stmt(this.db, this.sql, values);
	}
	async all<T>() {
		return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] };
	}
	async first<T>() {
		return (this.db.prepare(this.sql).get(...(this.params as never[])) as T | undefined) ?? null;
	}
	async run() {
		return this.db.prepare(this.sql).run(...(this.params as never[]));
	}
	runSync() {
		return this.db.prepare(this.sql).run(...(this.params as never[]));
	}
}

export class TestD1 implements D1Like {
	db = new DatabaseSync(":memory:");
	queries = 0;
	constructor() {
		const dir = join(__dirname, "..", "migrations");
		for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) this.db.exec(readFileSync(join(dir, f), "utf8"));
	}
	prepare(sql: string) {
		this.queries++;
		return new Stmt(this.db, sql);
	}
	async batch(statements: D1StatementLike[]) {
		this.db.exec("BEGIN");
		try {
			const out = statements.map((s) => (s as Stmt).runSync());
			this.db.exec("COMMIT");
			return out;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}
	count(table: string): number {
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
	}
}
